# A chair nobody can sit in

A player left a table and their chair was never released in the database. The live table shows it
free; the database still records them in it. Every attempt to take it is refused.

This is **not** a hand-history incident, and the fix has nothing to do with backups. Read the
distinction below before doing anything, because the metric next door
(`prl_archive_failures_total`) means something completely different and used to carry this failure
under its own name.

---

## Symptoms

- A learner reports that a seat looks empty and will not let them sit.
- `prl_seat_release_failures_total` is above zero.
- The API answers `seat_taken` on `POST /rooms/:id/seat` for a chair the room summary shows as
  free. `prl_api_errors_total{code="seat_taken"}` rises without a matching rise in play.
- Nothing else is wrong: hands deal, chips settle, `/ready` is 200, no hand is lost.

## Detection

| Alert | Rule |
| --- | --- |
| `SeatReleaseFailing` | `sum(increase(prl_seat_release_failures_total[15m])) > 0` |

Zero tolerance, and a **ticket rather than a page**. Nothing is broken right now — the table plays,
the other seats work, and no chips or history are at risk. What is true is that one chair is
unusable for the remaining life of the process and *nothing retries*, so it will not heal on its
own and it will not get worse either. That is a working-hours problem.

The counter is primed at zero from boot. It has to be: a counter series is created by its first
increment, and `increase()` cannot see a rise from a value that was never scraped, so without
priming the first stuck chair — the one occurrence this alert exists for — would be invisible to
it. See `primeLabels` in `apps/api/src/observability/registry.ts`.

## Why this is its own signal

Until recently this failure incremented `prl_archive_failures_total`, because `seat-release` was
not in the `ProblemEvent` union and `archive-write` was the nearest available kind. That told an
operator that **hand history was being lost** — a data-integrity incident with a completely
different runbook — when what had actually failed was freeing a chair. The alert paged for the
wrong subsystem and the first ten minutes of the response would have gone to the wrong place.

`prl_api_errors_total{code="seat_taken"}` cannot substitute either. That is what this looks like
from outside, and it is indistinguishable from two learners legitimately racing for the same chair,
which is ordinary and must never page anyone.

## What actually happened

A seat is released when a hand **settles**, not when the player asks to leave. A player who stands
up mid-hand keeps their chair until the hand finishes; settlement then publishes who departed and
the room reacts once, writing `room_members.seat = NULL`.

If that write fails — a database blip, a pool timeout, a statement deadline — nothing is waiting
for it. Play has already continued. The in-memory table has freed the seat, so the room summary a
client renders shows it free, and the durable row still holds it. The two disagree until the room
is reopened.

The release is per chair, so one refusal no longer strands the chairs behind it; the counter moves
by the number of **chairs** stuck, not the number of failed passes. Three is a different size of
incident from one.

## Fix

Reopening the room re-reads the roster from the database and rebuilds the live table from it,
which resolves the disagreement in the direction of the database.

```bash
# 1. Confirm the disagreement, and get the room and the seat.
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml \
  exec postgres psql -U "$PRL_STAGING_DB_SUPERUSER" -d "$PRL_STAGING_DB_NAME" -c "
    select room_id, user_id, seat, left_at
      from prl.room_members
     where left_at is not null and seat is not null;"
```

Any row returned is a stuck chair: the member has left and still holds a seat.

```bash
# 2. Release it. This is the write that failed.
#    Scope it to the rows above — never run it unqualified.
... -c "update prl.room_members set seat = null
         where left_at is not null and seat is not null and room_id = '<room-id>';"
```

```bash
# 3. Reopen the room so the live table stops disagreeing with the row you just fixed.
#    A restart of the API does this for every room; there is no per-room control on the API today.
docker compose ... restart api
```

Step 3 is safe with hands in flight only in the sense that `docs/production/runbooks/api-unhealthy.md`
describes: in-flight hands are reconciled on the next open, sockets get a `4503` close and
reconnect. If a table is mid-hand and the chair is not urgent, this can wait for a quiet moment —
the chair is unusable either way and nothing degrades further.

## What to check afterwards

- `prl_seat_release_failures_total` stops rising. It is a counter, so it does not go back down; the
  alert clears when the 15-minute window empties.
- The query in step 1 returns nothing.
- The learner can take the seat.

## If it keeps happening

One stuck chair is a blip. A rising count is the database refusing that write repeatedly, which
means this is a symptom and not the incident — go to
[db-saturation.md](db-saturation.md) and look at the pool, or
[db-unavailable.md](db-unavailable.md) if `/ready` is also unhappy. Fixing chairs one at a time
while the pool is exhausted is treating the wrong thing.
