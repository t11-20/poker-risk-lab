# ADR 0013 — Room affinity, and why horizontal scale is a protocol change

**Status:** Accepted · **Date:** 2026-08-25

## Context

ADR 0001 chose a modular monolith and put the authoritative live table in process memory.
`apps/api/src/rooms/registry.ts` says so in its header, and `docker-compose.staging.yml`
repeats it beside the setting it constrains: `deploy.replicas: 1` is a **correctness**
requirement, not a sizing choice. Two API processes serving one room deal two different
hands, and the losing copy's chips are simply gone.

That was written as a note to a future reader. This ADR exists because the product now has
a reason to care: the lab is about to onboard paying students, and "how many students fit"
is a question somebody will ask with money attached.

Two things had to be established before answering it, and both were.

### The constraint was documented and unenforced

Nothing in the code stopped a second process from opening a room. An operator who scaled
to two, or any deployment where an old and a new container overlapped for a few seconds,
would have got silent corruption — no error, no alert, two truths. A correctness
constraint that lives only in a comment is a correctness constraint that is one `--scale`
away from being violated by someone who never read the comment.

That is closed independently of this ADR: a room is now held under an ownership lease in
Postgres, a second process is refused rather than tolerated, and a process that loses its
lease evicts the room instead of continuing to serve it. See the room-ownership runbook.
**This ADR assumes that mechanism exists.** It is what makes every option below fail
loudly instead of quietly, and it is worth having even at one replica.

### Edge routing by room cannot work today

The obvious way to run N replicas without moving the live table is affinity: hash the room
id at the proxy so every request for a room reaches the one process that owns it. nginx
does this in one line (`hash $room_id consistent`).

It cannot be done here, and the reason is specific. The REST surface is fine —
`/api/rooms/:roomId/…` names the room in the path. **The WebSocket does not.**
`apps/api/src/ws/hub.ts` mounts the upgrade at a bare `/ws`, and its querystring schema is
closed and empty *on purpose* (`hub.ts:39-41`): the upgrade takes no parameters. The room
is chosen afterwards, in-band, by the `hello` frame — `roomId` is a required property of
`wsClientMessageSchema`'s `hello` variant (`packages/contracts/src/schemas.ts:401-405`).

So at the moment nginx must choose an upstream, the room id does not exist yet. And the
WebSocket is not a side channel here: under ADR 0009 it carries whole state frames, which
is to say it carries the actual play. Routing the REST calls correctly and the hands
arbitrarily would be worse than not routing at all.

## Decision

**One replica for this release. Horizontal scale is a scoped protocol change, not a proxy
setting, and it is not in this release.**

Concretely, when it is done:

1. **Name the room in the upgrade.** Move the upgrade to `/ws/:roomId` and keep the
   `hello` frame's `roomId` as a cross-check that must agree with the path — disagreement
   is a protocol violation and closes the socket. This is a versioned protocol change:
   `protocolVersion` exists for exactly this, and old clients must keep working through
   one release.
2. **Then, and only then, affinity at the edge.** `hash $room_id consistent` over the room
   locations and `/ws/:roomId`; everything else round-robins. Room creation and listing are
   not room-scoped and do not need affinity.
3. **The lease is the safety net, not the mechanism.** Consistent hashing moves keys
   whenever the replica set changes, so a scale-out will occasionally point a client at a
   process that does not own its room. With the lease, that is a refusal an operator can
   see and a client can retry. Without it, it is two decks.

### The cost, stated plainly

Adding or removing a replica migrates rooms, and a migrated room's **in-flight hand is
lost** — the deck and the commitment salts have no column and never will (ADR 0004,
`db/migrations/0001_initial.sql`). That is the same loss a restart already causes, and it
is acceptable for the same reason, but it means scaling out is a quiet-hours operation and
not an autoscaler. Anyone who wants elastic scale is asking for the live table to leave
process memory, which is a different and much larger decision than this one.

## Options considered

**A. Ship `replicas: N` with round-robin routing.** Rejected, and it is worth being blunt
about why: this is the option that looks like it works. Every request succeeds, the
dashboards are green, and the corruption is only visible to the two players who were dealt
different cards. With the lease in place it is no longer silent — it is a storm of
ownership refusals — but a system that refuses most of its own traffic is not scaled, it is
broken with good telemetry.

**B. Sticky sessions by cookie or address.** Rejected. It pins a *client*, and the unit
that must be pinned is a *room*. Six players in one room arrive from six addresses with six
cookies; nothing about client stickiness puts them on the same process. It would also
re-break the NAT case the sign-in limits were just fixed for.

**C. Move the live table out of process memory (Redis, or a shared log).** Rejected for
now, not on principle. It is the real answer for elastic scale, and it is a redesign of the
one part of the system ADR 0001 deliberately kept simple — plus a new durable store holding
exactly the material ADR 0003 and ADR 0004 work to keep unwritable: hole cards, deck order,
commitment salts. If it is ever done, it is its own ADR with its own threat model.

**D. Room affinity behind a protocol change (chosen, deferred).** As above.

**E. Nothing at all.** Rejected. Not because one replica is wrong — for a cohort it is
right — but because leaving the constraint documented-and-unenforced was the actual defect,
and that part is not deferred.

## Consequences

- One API process serves all rooms. Capacity is a single-process question; see
  `docs/production/load-test.md` for what was measured and, more importantly, for which
  resource runs out (CPU and the Monte Carlo worker queue, with the event loop still quiet).
- A cohort-sized deployment is comfortably served. Hundreds of *concurrent seated* players
  are not, and no amount of configuration changes that — it is this ADR's item 1 that
  changes it.
- `deploy.replicas: 1` stays, and now has a mechanism behind it rather than a comment. An
  operator who overrides it gets refusals and an alert, not corruption.
- Vertical scale is available and unblocked in the meantime: the bottleneck is CPU and the
  worker pool, both of which a larger instance buys directly.
