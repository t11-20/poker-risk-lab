/**
 * `prl.room_ownership` — the four statements that make "one API process per room" enforceable.
 *
 * ## What this is defending
 *
 * `rooms/registry.ts` holds the deck, the commitment salts and the pot of a hand in progress in
 * process memory, because they have no column and never will. So the authoritative copy of a live
 * room is one process's heap, and two processes serving one room deal two different hands: two
 * decks, two pots, two settlements, and whichever `stacksSettled` lands second silently destroys
 * the chips the other one paid out. `docker-compose.staging.yml` and the registry's own header both
 * call `deploy.replicas: 1` a correctness constraint. Until this table existed, nothing enforced
 * it — an operator scaling for capacity, or any rolling deploy where the new container is healthy
 * before the old one has drained, produced exactly that state with no error anywhere.
 *
 * ## Why the predicate is in the statement rather than around it
 *
 * `acquire` is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, and that shape is the whole
 * guarantee. A read-then-write — "is anybody holding this? no? take it" — is two statements with a
 * window between them, and the window opens on exactly the sequence this exists to refuse: two
 * processes starting at the same instant, both reading "free", both writing. Postgres evaluates
 * the conflict target and the `WHERE` against the row it is actually about to update, under a row
 * lock it took to do so, so two concurrent acquisitions are serialised by the database and exactly
 * one of them gets a row back. That is the same reasoning `repositories/rooms.ts` gives for letting
 * `room_members_live_seat_key` decide who got the chair, and it is the only version of this that is
 * correct under concurrency.
 *
 * ## Why liveness is measured with the database's clock
 *
 * Every timestamp written here is read from Postgres, and the takeover predicate compares
 * `heartbeat_at` against `now()` in the same statement. Two API processes have two clocks, and if
 * either of them supplied the timestamps then "has the holder stopped renewing?" would be answered
 * by comparing one machine's idea of the time with another's — which, with a few seconds of skew,
 * either strands rooms forever or hands them over while the holder is still dealing. One clock,
 * and it is the clock both processes are already talking to.
 *
 * WHICH of Postgres' two clock functions is not a detail. `now()` is `transaction_timestamp()`,
 * fixed before a statement waits for anything, so a renewal that queued behind a row lock recorded
 * a liveness claim from before the wait — which `room_ownership_heartbeat_after_acquire` refused
 * outright, taking every other room's renewal in the same statement with it. `heartbeat` therefore
 * writes `clock_timestamp()`; the paragraph on it has the reproduction.
 *
 * ## What is NOT here
 *
 * No `SELECT ... FOR UPDATE`, no advisory lock, no transaction. Each function is a single
 * statement whose atomicity is the statement's own. An advisory lock would be held by a session
 * rather than by a row, so it would evaporate when the pool recycled the connection
 * (`max_lifetime: 1_800` in `db.ts`) and would tell a reader nothing about who holds what.
 */

import type { Db } from './sql.ts';

/** One lease row, as this module reads it back. */
export interface RoomLeaseRow {
  readonly room_id: string;
  readonly owner_id: string;
  /** `bigint`, which postgres.js hands back as a string. Parsed by the callers that compare it. */
  readonly fence: string;
  readonly acquired_at: Date;
  readonly heartbeat_at: Date;
}

/** What a successful acquisition returns: the room is ours, at this generation. */
export interface AcquiredLease {
  readonly roomId: string;
  readonly ownerId: string;
  /**
   * The fencing token for this acquisition, as a number.
   *
   * `bigint` in the column so it cannot wrap, and a JavaScript `number` here because
   * `Number.MAX_SAFE_INTEGER` is 9,007,199,254,740,991 takeovers of one room and the alternative
   * is threading a `bigint` through every caller for a value that is logged and compared.
   */
  readonly fence: number;
  readonly acquiredAt: Date;
}

/**
 * Takes the lease on a room, or refuses.
 *
 * Succeeds in exactly two cases, and the `WHERE` on the conflict is the whole statement of what
 * they are:
 *
 *   1. **We already hold it.** Re-acquiring our own room is legal and increments the fence: it
 *      happens when a room this process closed is opened again, and treating it as a fresh
 *      acquisition is correct — it IS one.
 *   2. **The holder has stopped renewing for longer than `ttlSeconds`.** That is the crash case,
 *      and it is why the lease has a TTL at all: a process that was SIGKILLed, OOM-killed or had
 *      its host disappear cannot release anything, and without an expiry its rooms would be
 *      unopenable by anybody, forever.
 *
 * Anything else returns null — a live process holds this room — and the caller must refuse to
 * serve it. Not throw: "somebody else owns this" is an answer, not a fault, and the caller turns
 * it into a typed refusal with a counter behind it.
 *
 * `make_interval(secs => ...)` rather than string-concatenating an interval literal, because the
 * TTL travels as a bind parameter like every other value in this codebase (`db.ts` opens with why),
 * and `${n} * interval '1 second'` leaves the parameter's type to inference.
 */
export async function acquire(
  handle: Db,
  input: { readonly roomId: string; readonly ownerId: string; readonly ttlSeconds: number },
): Promise<AcquiredLease | null> {
  const rows = await handle<{ fence: string; acquired_at: Date }[]>`
    insert into prl.room_ownership as lease (room_id, owner_id, fence, acquired_at, heartbeat_at)
    values (${input.roomId}, ${input.ownerId}, 1, now(), now())
    on conflict (room_id) do update
       set owner_id = excluded.owner_id,
           fence = lease.fence + 1,
           acquired_at = now(),
           heartbeat_at = now()
     where lease.owner_id = ${input.ownerId}
        or lease.heartbeat_at < now() - make_interval(secs => ${input.ttlSeconds}::double precision)
    returning lease.fence, lease.acquired_at
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    roomId: input.roomId,
    ownerId: input.ownerId,
    fence: Number(row.fence),
    acquiredAt: row.acquired_at,
  };
}

/**
 * Renews every lease this owner believes it holds, in one statement, and says which ones it got.
 *
 * The return is the set of rooms whose row was actually updated. **A room that was asked for and
 * is not in the answer has been fenced** — somebody else's `acquire` won it while this process was
 * not renewing — and the caller must stop serving it immediately. That direction is the point of
 * the whole mechanism: continuing to serve a room we no longer own is the exact corruption the
 * lease exists to prevent, and it is worse than not serving it at all.
 *
 * ## Why one statement for every room rather than one per room
 *
 * A beat costs one round trip whatever the room count, which is what makes the interval safe to
 * keep short. Per-room statements would make the cost of the heartbeat scale with the thing it is
 * protecting, so the busiest process — the one that can least afford it — would pay the most, and
 * a slow beat is not a cosmetic problem here: a beat that does not complete inside the TTL loses
 * the lease.
 *
 * ## Why `owner_id` and not also the fence
 *
 * Scoping to `owner_id` is the ownership statement in full. A fence check would additionally
 * refuse a renewal of a room we lost and then re-acquired at a higher generation — but a
 * re-acquisition goes through `acquire`, which returns the new fence to the caller, so the caller's
 * fence is never behind the row's for a room it holds. The extra term would be a stricter test of
 * something that cannot happen, at the cost of a per-room parameter that is what forces this back
 * into one statement per room.
 *
 * ## Why `clock_timestamp()` and not `now()`
 *
 * ############################################################################
 * ## `now()` IS THE TRANSACTION'S START, NOT THE MOMENT THE ROW WAS WRITTEN ##
 * ############################################################################
 *
 * This beat is one statement over every room, so it takes one row lock after another and any one
 * of them can wait. `now()` is frozen before the wait starts, so a beat that blocked wrote a
 * heartbeat timestamped BEFORE the acquisition it had queued behind — and
 * `room_ownership_heartbeat_after_acquire` then refused the whole statement. 0005 says of that
 * constraint that "both are written with the database's `now()`, so on a healthy path this cannot
 * fire", and that is the sentence this paragraph exists to correct.
 *
 * Reproduced against a real PostgreSQL 16, on pool handles, exactly as `rooms/ownership.ts` issues
 * them: two rooms held by one owner, the beat blocked on the first room's lock while an `acquire`
 * by the SAME owner re-took the second, and the beat came back
 * `23514 room_ownership_heartbeat_after_acquire`. A beat is ONE statement, so the renewals for
 * every other room were rolled back with it — the whole beat lost, on the exact path
 * `RoomRegistry.releaseLeaseSoon` already documents as the one that produces the most of these
 * (a database slow enough that beats block, rooms are evicted, and rooms are re-opened underneath).
 *
 * `clock_timestamp()` is read when the row is written, so it is after every commit this statement
 * waited for. It is also the truer of the two for what the column MEANS: a heartbeat is a claim
 * that the holder was alive at an instant, and dating that claim from before a wait makes a live
 * lease look staler than it is — the direction that hands a room to a second process.
 */
export async function heartbeat(
  handle: Db,
  input: { readonly ownerId: string; readonly roomIds: readonly string[] },
): Promise<readonly string[]> {
  if (input.roomIds.length === 0) return [];
  const rows = await handle<{ room_id: string }[]>`
    update prl.room_ownership
       set heartbeat_at = clock_timestamp()
     where owner_id = ${input.ownerId}
       and room_id = any(${[...input.roomIds]}::text[])
    returning room_id
  `;
  return rows.map((row) => row.room_id);
}

/**
 * Gives the lease back, scoped to the owner AND to the generation being given back.
 *
 * `and owner_id = ...` is not defensive tidiness, it is the correctness of the statement. Without
 * it, a process that had already been fenced would delete the lease of the process that legitimately
 * took the room over — handing the room to the next arrival while its real owner is mid-hand, which
 * is the same two-processes-one-room state this table exists to make impossible, reached through
 * the cleanup path instead of the open path.
 *
 * ## Why `and fence = ...`, which is not the same statement
 *
 * ############################################################################
 * ## THE OWNER SCOPE DOES NOT PROTECT US FROM OURSELVES. THE FENCE DOES.    ##
 * ############################################################################
 *
 * A release is QUEUED by `RoomRegistry.releaseLeaseSoon` and runs on a serial chain, so the gap
 * between "this room was given up" and "the row was actually deleted" is unbounded — it is however
 * long every release ahead of it takes, and on the path that produces the most of them at once
 * (a database slow enough that every beat is abandoned at its deadline, so every room is evicted
 * `lease_expired` and every release is queued) each one of those is a query that runs to its own
 * 7,000 ms deadline before it fails. The database then recovers, the learners reconnect, and the
 * rooms are RE-ACQUIRED by this same process at a new fence long before the chain has drained.
 *
 * The stale release that arrives after that is owner-scoped and this process IS the owner, so
 * without the fence it deletes the row the re-open had just taken. Reproduced against
 * `RoomRegistry` with the release chain held open across an eviction and a re-open: the row was
 * deleted, the very next beat found no row for a room this process was serving and evicted it as
 * `fenced` — closing a table under a learner and raising `prl_api_room_fencings_total{reason=
 * "fenced"}`, a zero-tolerance series, for an incident that had not happened. And between the
 * delete and that beat the room had NO lease row at all while this process was dealing at it,
 * which is the two-processes-one-room state the table exists to refuse, reached through the
 * cleanup path.
 *
 * `fence` is exactly the fencing token for this: it increments on every acquisition, so "the
 * generation that asked to be released" and "the generation in the row" are comparable, and a
 * release for a generation that has been superseded matches nothing. This is the first caller to
 * use the column for what the migration header says it is for.
 *
 * Returns true when a row went. False means we did not hold that generation of it, which is not an
 * error: it is what a fenced process sees on its way out, and what a superseded release sees, and
 * there is nothing for either to do about it.
 */
export async function release(
  handle: Db,
  input: { readonly roomId: string; readonly ownerId: string; readonly fence: number },
): Promise<boolean> {
  const rows = await handle<{ room_id: string }[]>`
    delete from prl.room_ownership
     where room_id = ${input.roomId}
       and owner_id = ${input.ownerId}
       and fence = ${input.fence}
    returning room_id
  `;
  return rows.length > 0;
}

/**
 * The whole row, for the runbook and for the tests.
 *
 * Nothing on the request path reads this: an acquisition already knows whether it won, and a
 * heartbeat already knows whether it was fenced. It exists so that "who holds this room, and how
 * stale is their heartbeat" is one call rather than a query typed into `psql` under pressure, and
 * so that a test can assert on the row the statements above actually wrote rather than on what they
 * returned.
 */
export async function read(handle: Db, roomId: string): Promise<RoomLeaseRow | null> {
  const rows = await handle<RoomLeaseRow[]>`
    select room_id, owner_id, fence, acquired_at, heartbeat_at
      from prl.room_ownership
     where room_id = ${roomId}
  `;
  return rows[0] ?? null;
}
