# Two API processes, one room

A room being played lives in **one process's memory**. `prl.room_ownership` leases each room to
exactly one API process so that a second one cannot serve it. This runbook is for the two alerts
that fire when the lease has something to say: a process was refused a room (`RoomOwnershipRefused`)
or a process **lost** one it was serving (`RoomOwnershipFenced`).

The two are very different sizes of incident and the containment step is different for each. Read
[Which one is it](#which-one-is-it) before doing anything.

---

## Symptoms

- Learners report a table that will not open — `503`, "that table is being looked after by another
  server right now" — while other learners are playing at it perfectly happily.
- A table goes quiet mid-hand and every socket at it reconnects (close code `4503`).
- A learner reports chips that do not match the hand they just played, or a hand in their history
  they did not play.
- `prl_room_ownership_refusals_total` or `prl_room_fencings_total` is above zero.
- `prl_hands_failed_total{reason="room_closed"}` rises with no deploy to explain it.

## Detection

| Alert | Rule | Tier |
| --- | --- | --- |
| `RoomOwnershipFenced` | `sum(increase(prl_room_fencings_total[10m])) > 0` | page |
| `RoomOwnershipRefused` | `sum(increase(prl_room_ownership_refusals_total[5m])) > 0` for 10m | page |

Both counters are primed at zero from boot, so the first occurrence is a rise from zero rather than
a series appearing — see `primeLabels` in `apps/api/src/observability/registry.ts`. That matters
here more than almost anywhere: the first fencing is the one that corrupts a table, and there is no
background rate to distinguish it from.

## The architectural fact this rests on

`apps/api/src/rooms/registry.ts` holds the deck, the commitment salts, the pot and the turn of a
hand in progress in process memory, because none of those has a column and never will. So the
authoritative copy of a live room is one heap, and **two processes serving one room deal two
different hands**: two decks, two pots, two settlements. Both write `room_members.stack`, and
whichever lands second destroys the chips the other paid out. No error is raised anywhere.

`deploy.replicas: 1` in `docker-compose.staging.yml` is that constraint, and until the lease existed
it was a comment. It is now enforced: opening a room takes a lease, a renewal that updates no row
means the room has been taken, and a process that has been taken from stops serving it at once.

## Which one is it

```bash
curl -sS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'prl_room_ownership_refusals_total|prl_room_fencings_total'
```

**`prl_room_ownership_refusals_total` rising, fencings at zero.** The guard held. A second process
asked for rooms it must not have and was refused every time, so **nothing has been corrupted**. What
is broken is availability: every learner routed to that process is refused every table it does not
hold. Go to [A second process is running](#a-second-process-is-running).

**`prl_room_fencings_total{reason="fenced"}` above zero.** A process was serving a room and another
one took it. There was a window — bounded by the five-second heartbeat — in which both were
authoritative. Go to [A room changed hands mid-play](#a-room-changed-hands-mid-play). This is the
one that can have cost somebody chips.

**`prl_room_fencings_total{reason="lease_expired"}` above zero.** No second process is implied. This
process could not renew its leases for twenty seconds and stepped down of its own accord, which is
the designed behaviour: past that point another process becomes entitled to the rooms and this one
can no longer prove it holds them. Expect `ApiNotReady` or `DbPoolSaturated` alongside it. The
incident is the database, not the deployment — go to [db-unavailable.md](db-unavailable.md) or
[db-saturation.md](db-saturation.md) and treat the evicted rooms as collateral.

---

## Immediate containment

### A second process is running

**Get back to one API process.** That is the containment step and there is no other one.

```bash
# How many API processes are there, and which is which?
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml ps api

# Who holds what, and how fresh is each lease?
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml \
  exec postgres psql -U "$PRL_STAGING_DB_SUPERUSER" -d "$PRL_STAGING_DB_NAME" -c "
    select room_id, owner_id, fence,
           round(extract(epoch from (now() - heartbeat_at))::numeric, 1) as heartbeat_age_s
      from prl.room_ownership
     order by heartbeat_at;"
```

`owner_id` is `api_<hostname>_<pid>_<random>`, so the hostname column tells you which container is
holding each room. **More than one distinct `owner_id` with a fresh heartbeat is the incident**, and
the count of distinct owners is the number of processes that think they are the API.

Scale back to one. Do NOT stop the process that holds the rooms if you can avoid it — it is the one
serving live tables, and stopping it drops every hand in progress:

```bash
# Stop the process that holds NOTHING. Its owner_id does not appear in the query above.
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml \
  up -d --scale api=1 api
```

Then fix the thing that started it — a `--scale`, a `deploy.replicas` above 1, an orchestrator
rescheduling without waiting for the old task to exit, or a second stack pointed at the same
database. A restart with the same configuration puts it straight back.

### A room changed hands mid-play

The eviction has already happened; the process that lost the room closed its table and disconnected
its sockets before it logged anything, which is the point. So containment is the same as above — get
back to one process — and then the question is **what it cost**.

---

## Diagnosis: what did the overlap cost

Find the fencings in the log. Every one carries the room, the reason and the fence generation:

```bash
docker compose --env-file deploy/staging/.env.staging -f docker-compose.staging.yml \
  logs api --since 1h | grep -E '"event":"room-fenced"|"event":"room-lease-refused"'
```

For each room named there, ask whether a hand was in flight when it changed hands:

```bash
... -c "select h.id, h.room_id, h.hand_number, h.status, h.started_at, h.completed_at
          from prl.hands h
         where h.room_id = '<room-id>'
         order by h.hand_number desc
         limit 5;"
```

Three outcomes, and they need different answers:

- **No hand in flight.** Nothing was lost. The learners at that table saw a reconnect. Record it and
  move on.
- **A hand in flight, abandoned.** It is closed by the next process that opens the room, and counted
  as `prl_hands_failed_total{reason="interrupted_by_restart"}`. Chips return to their pre-hand
  values because a hand that never settled never wrote a stack. This is the *good* outcome of a bad
  situation and it is what the eviction buys.
- **A hand in flight that COMPLETED in the other process.** This is the one that costs money-shaped
  state. Two settlements for one hand number cannot both be right, and `room_members.stack` holds
  whichever landed last. Treat it as a correctness incident: this is
  [hidden-card-incident.md](hidden-card-incident.md)'s sibling and the same rule applies — write
  down the room, the hand ids and the affected `user_id`s before anything else touches them.

## Recovery

1. One API process, confirmed by the lease query returning a single distinct `owner_id`.
2. Nothing to repair in `prl.room_ownership` itself. A lease whose holder is gone expires within
   thirty seconds and the next open takes it; a graceful shutdown releases immediately. **Do not
   delete rows from that table by hand** — a lease deleted underneath a live process hands its room
   to the next arrival while it is mid-hand, which is the incident you are trying to end.
3. Affected learners: their tables reopen on the next request, rebuilt from the durable roster.
   Nothing needs to be restarted for that.
4. If a hand settled twice, the stacks are a judgement call and not a script. Do not "fix" them
   without the hand rows in front of you and a decision recorded.

## Verification

- The lease query returns exactly one distinct `owner_id`.
- `prl_room_ownership_refusals_total` and `prl_room_fencings_total` stop rising. They are counters,
  so they do not go back down; the alerts clear when their windows empty.
- `prl_rooms_live` is non-zero on the surviving process and there is no second process to compare it
  with.
- A learner can open a table that was refused.

## Escalation

Escalate immediately, and before recovery, if a hand settled in two processes — that is chips
changing hands on a hand nobody played, and it is the only outcome here that cannot be undone by
waiting.

Escalate if refusals continue after the process count is one. That means the surviving process is
being refused rooms leased to an owner id that no longer exists, which should be impossible for
longer than the thirty-second TTL; check the clock on the database host, because the takeover test
is `heartbeat_at < now() - 30s` evaluated there.

## If it keeps happening

A recurring fencing is not an incident to keep handling — it is a deployment that produces two
processes, and the fix is in the deployment. The three that actually do it:

- `deploy.replicas` or `--scale api=` above 1. It reads like a sizing knob and is not one.
- An orchestrator that starts the replacement before the old task has exited. The lease makes that
  overlap *safe* — the new process is refused until the old one releases — but only if the old one
  actually shuts down gracefully; a SIGKILL leaves its leases to expire, which is the thirty-second
  window in which the new process cannot serve those rooms.
- Two stacks pointed at one database — a developer's local API with the staging `DATABASE_URL`, most
  often.

`docs/adr/0001-modular-monolith.md` records why one process per room is the design rather than a
limitation, and what moving off it would take.
