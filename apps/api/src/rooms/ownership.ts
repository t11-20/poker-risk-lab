/**
 * The room lease: which API process is allowed to be authoritative for a room, and for how long.
 *
 * ## The incident this prevents
 *
 * `rooms/registry.ts` holds the deck, the commitment salts, the pot and the turn of a hand in
 * progress in this process's memory, because none of those has a column and never will
 * (`db/migrations/0001_initial.sql` is emphatic about it). So the authoritative copy of a live room
 * is one heap. Two processes serving one room therefore deal two different hands from two different
 * decks, settle two different pots, and both write `room_members.stack` — whichever settlement
 * lands second overwrites the other, and the chips it paid out are gone. No error is raised
 * anywhere, by anything, and the learner sees a hand they did not play.
 *
 * The registry's header and `docker-compose.staging.yml` both call `deploy.replicas: 1` a
 * CORRECTNESS constraint for exactly that reason. Until this module existed it was documented and
 * unenforced: nothing refused a second process, and three ordinary events produced the state —
 *
 *   * an operator scaling to two replicas, because `replicas` is a sizing knob everywhere else;
 *   * ANY rolling deploy, where the new container passes its health check and starts serving
 *     before the old one has finished draining — a few seconds of overlap, every single deploy;
 *   * a supervisor restarting a process that has not exited yet.
 *
 * ## The mechanism, in one paragraph
 *
 * Each process mints one `ownerId` at boot. Opening a room takes a lease on it — an upsert that
 * succeeds only if we already hold it or the current holder has stopped renewing for longer than
 * the TTL — and refuses the open outright if a live process holds it. A timer renews every lease
 * this process holds. A renewal that updates no row means we have been FENCED: another process took
 * the room, and this one must stop serving it that instant. Closing a room, and shutting down,
 * release the lease so the next process gets it immediately instead of waiting out a TTL.
 *
 * ## What the fence does, and what it honestly does not
 *
 * `fence` is a per-room counter incremented on every acquisition, so a holder can always tell
 * whether the room has changed hands since it last looked, and so any write that later wants to
 * carry "the ownership generation that produced it" has a number to carry.
 *
 * It is NOT monotonic for the life of the room, and `db/migrations/0005_room_ownership.sql`'s
 * header says it is. The header is wrong and cannot be corrected in place (migrations are
 * roll-forward only; editing an applied file stops migrations everywhere), so the correction lives
 * here. `release` DELETES the row, so the next `acquire` is an INSERT and starts again at 1 —
 * `test/room-ownership-database.test.ts` asserts exactly that. The counter is monotonic across
 * TAKEOVERS, which is what the fencing argument actually needs, and it restarts across a
 * release-and-reacquire. Anything comparing fences across a gap in which the row may have been
 * deleted is comparing two different things; `RoomRegistry.releaseLeaseSoon` says what it does
 * about that.
 *
 * Nothing carries it today. No row in `prl.hands`, `prl.hand_actions` or `prl.room_members` has a
 * fence column, so **the database will not refuse a write from a fenced process** — a stale write
 * already in flight when the fencing happens lands normally. What stops those writes is the
 * eviction path in the registry, which closes the table and drops the room the moment a renewal
 * comes back empty. That is a bound measured in one heartbeat interval rather than an absolute
 * guarantee, and it is stated here rather than implied: making it absolute means a fence column on
 * every table a live room writes to, and a `WHERE fence = $n` on every one of those statements.
 *
 * ## Why this is not a distributed lock library
 *
 * ADR 0007 is deliberately hostile to new runtime dependencies, and what a lock library would add
 * over the four statements in `repositories/room-ownership.ts` is a second consensus system to
 * operate. The lease shape below is the ordinary one — it is what `coordination.k8s.io/Lease` is,
 * and what an etcd or Consul session is — and its correctness rests on Postgres serialising two
 * concurrent upserts against one row, which is a property this project already depends on for
 * seating.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import * as ownershipRepository from '../repositories/room-ownership.ts';
import type { Db } from '../repositories/sql.ts';

// ---------------------------------------------------------------------------
// The three numbers, and the ratios between them
// ---------------------------------------------------------------------------

/**
 * How long a lease survives without a renewal before anybody else may take it.
 *
 * ## Why it must be large
 *
 * The TTL is the answer to "how long can this process be unable to renew and still be trusted to
 * be dealing?", so it has to exceed every pause that leaves a process alive and mid-hand:
 *
 *   * **Garbage collection.** A V8 major GC on a heap this size is single-digit to low-tens of
 *     milliseconds. It is not the binding constraint and never was.
 *   * **CPU starvation.** A container that exhausts its cgroup quota is descheduled for the rest
 *     of the period, repeatedly. That is the realistic multi-hundred-millisecond stall.
 *   * **The database being slow or frozen rather than down.** This is the binding one, and this
 *     repository has already measured it: `db.ts` bounds every query at
 *     `DATABASE_STATEMENT_TIMEOUT_MS + 2,000` ms (7,000 ms at the default), and
 *     `scripts/reliability-drills.mjs --only postgres-outage` freezes Postgres to produce exactly
 *     that. A renewal issued into a frozen database is abandoned after that deadline, and the beat
 *     is simply lost.
 *
 * At 30 seconds, two consecutive renewals can be abandoned at the 7,000 ms request deadline and a
 * third still has sixteen seconds of TTL left to succeed in.
 *
 * ## Why it must not be larger
 *
 * The TTL is also how long a room is unopenable after a process dies without releasing — SIGKILL,
 * OOM, a host that vanished. Nobody can serve the room until the lease expires, so every second
 * here is a second of "that table will not open" after a crash. A graceful shutdown releases, so
 * the ordinary deploy pays none of this; only a hard kill does.
 *
 * ## The one configuration that breaks the argument, stated
 *
 * `DATABASE_STATEMENT_TIMEOUT_MS` accepts up to 60,000, which puts the query deadline at 62,000 ms
 * — more than this TTL. A deployment that sets it above roughly 23,000 has made a single hung
 * renewal able to outlast the lease. The failure direction is the safe one: this process
 * self-evicts (see `LEASE_SELF_EVICT_AFTER_MS`) rather than carrying on serving a room it can no
 * longer prove it owns. It is a real cost of that setting and belongs in the same paragraph as it.
 */
export const LEASE_TTL_MS = 30_000;

/**
 * How often every held lease is renewed.
 *
 * Six beats per TTL. The ratio is what buys tolerance: five consecutive renewals can fail — a
 * connection blip, a pool that was momentarily full, a statement deadline — and the sixth still
 * lands inside the TTL. One failed beat must never cost a live table, because one failed query is
 * an ordinary event and losing a room is not.
 *
 * It is also the resolution of the self-eviction check below, which only runs on a beat: this
 * process cannot notice it has been fenced any sooner than the next tick.
 *
 * Cheaper than it looks, and deliberately: one beat is ONE statement for every room this process
 * holds (`repositories/room-ownership.ts` explains why it is batched), so the cost of the guard
 * does not scale with the thing it is guarding.
 */
export const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * How stale our own last CONFIRMED renewal may get before this process evicts its own rooms.
 *
 * Strictly less than `LEASE_TTL_MS`, and that ordering is the correctness of the whole scheme
 * rather than a safety margin. The takeover test is evaluated by Postgres against `heartbeat_at`;
 * this test is evaluated here against local wall time. If they were equal, the instant another
 * process became eligible to take the room would be the same instant this one decided to stop —
 * and "the same instant" measured on two clocks is a coin toss. Stepping down first means the
 * overlap can only be in the safe direction: a window where nobody is serving the room, never one
 * where two processes are.
 *
 * The ten-second gap covers three separate things, and it is the sum of them rather than a round
 * number:
 *
 *   * **Clock skew** between this host and the database host. NTP-disciplined hosts are within
 *     milliseconds; an undisciplined VM can be seconds out.
 *   * **The round trip.** `heartbeat_at` is stamped when Postgres executes the statement, and this
 *     process learns it succeeded up to one round trip later — so local "time since confirmation"
 *     always OVERSTATES how stale the row is, which makes this check fire early rather than late.
 *   * **The check granularity.** It runs on a beat, so it can be up to one
 *     `LEASE_HEARTBEAT_INTERVAL_MS` late in noticing.
 *
 * The honest limit: this check runs on the event loop, so a process stalled hard enough not to run
 * a timer cannot evict itself. Nothing inside a process can fix that — but such a process is also
 * not dealing cards, answering sockets or writing rows, so it is not the process that corrupts a
 * hand. The one that does is the one that is running fine and has simply lost the argument.
 */
export const LEASE_SELF_EVICT_AFTER_MS = 20_000;

// ---------------------------------------------------------------------------
// The owner id
// ---------------------------------------------------------------------------

/** Longest slice of a hostname that reaches the column, so a long pod name cannot fill it. */
const HOSTNAME_SLUG_MAX = 32;

/**
 * Turns whatever `os.hostname()` returned into something a lease row can hold and a human can read.
 *
 * The column's CHECK bounds the whole owner id at 128 characters and refuses surrounding
 * whitespace; a Kubernetes pod name is comfortably long enough to matter, and a hostname is not
 * guaranteed to be anything in particular. Everything outside `[a-z0-9-]` becomes a dash, and an
 * empty result becomes `unknown` rather than nothing — an owner id that is mostly missing still has
 * to be a distinct, comparable string, because comparing owner ids is the entire mechanism.
 */
function hostSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, HOSTNAME_SLUG_MAX);
  return slug === '' ? 'unknown' : slug;
}

/**
 * Mints this process's owner id.
 *
 * Three parts, each earning its place. The **hostname** is what an operator reading a refused open
 * needs first — "which container is holding this room?" — and is the difference between a
 * two-minute diagnosis and a long one. The **pid** distinguishes two processes on one host, which
 * is the local-development case and the "supervisor started the replacement early" case. The
 * **random suffix** is what makes it unique across restarts: a host/pid pair is reused, and an owner
 * id that a restarted process could collide with would let the new process silently inherit the
 * dead one's leases without waiting out the TTL — which is precisely the overlap this exists to
 * refuse.
 *
 * Not an id from `repositories/ids.ts`, deliberately. Those prefixes are enumerated in `ID_PREFIXES`
 * with the comment that each is checked by a CHECK constraint on the table it names, and a process
 * is not a table. Nothing here is a secret: an owner id is an operational label, it is written to a
 * column an operator reads and to log lines, and it grants nothing to whoever knows it.
 *
 * `randomBytes` and not `Math.random`, which `test/server-randomness.test.ts` refuses across the
 * whole of `src/`. The rule is about cards and credentials rather than about this label, and it is
 * an absolute rule precisely so that nobody has to relitigate which of the two a given call is.
 */
export function mintOwnerId(): string {
  return `api_${hostSlug(hostname())}_${process.pid}_${randomBytes(8).toString('hex')}`;
}

/**
 * This process's owner id, minted once.
 *
 * Lazily, and cached, for the reason `db.ts` has no eager `sql` export: importing this module from
 * a test that only wants `LEASE_TTL_MS` must not read the hostname as a side effect. Once minted it
 * never changes — an owner id that changed under a running process would orphan every lease it
 * held until the TTL expired, and would make the release path silently no-op.
 */
let processOwnerId: string | null = null;

export function instanceOwnerId(): string {
  processOwnerId ??= mintOwnerId();
  return processOwnerId;
}

// ---------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------

/** A lease this process holds, as the registry carries it. */
export interface RoomLease {
  readonly roomId: string;
  /** The acquisition generation. Monotonic per room; see the module header for what it is not. */
  readonly fence: number;
  readonly acquiredAt: Date;
}

/** Who holds a room we were refused, for the log line and the runbook. Never sent to a client. */
export interface LeaseHolder {
  readonly ownerId: string;
  readonly fence: number;
  /** How long ago the holder last renewed, in milliseconds, by the database's clock. */
  readonly heartbeatAgeMs: number;
}

/**
 * Everything the registry needs in order to be sure it is the only process serving a room.
 *
 * A port rather than a direct dependency, for the reason `RoomStore` and `HandArchive` are ports:
 * every existing test in `test/rooms.test.ts` and `test/ws-router.test.ts` drives the whole of
 * rooms, seating, the socket protocol and the bots with no database anywhere, and this must not be
 * the thing that changes that.
 */
export interface RoomOwnership {
  /** Stable for the life of the process. The value written to, and compared against, `owner_id`. */
  readonly ownerId: string;
  /** Takes the lease, or answers null because a live process holds it. */
  readonly acquire: (roomId: string) => Promise<RoomLease | null>;
  /**
   * Renews every named lease and answers with the ones that were actually renewed.
   *
   * A room asked for and missing from the answer has been fenced. The caller must stop serving it.
   */
  readonly heartbeat: (roomIds: readonly string[]) => Promise<readonly string[]>;
  /**
   * Gives one lease back.
   *
   * Scoped to `ownerId`, so it can never release somebody else's, and to `fence`, so it can never
   * release a LATER generation of our own — a release is queued and can arrive after the room has
   * been given up and taken again. `repositories/room-ownership.ts` has the measurement.
   */
  readonly release: (roomId: string, fence: number) => Promise<boolean>;
  /** Who holds a room, for the refusal's log line. Null when nobody does any more. */
  readonly holderOf: (roomId: string) => Promise<LeaseHolder | null>;
}

/**
 * Binds the port to `repositories/room-ownership.ts`.
 *
 * `sql` is a getter rather than a handle for the reason `postgresArchive` gives: building the
 * registry must not touch the pool, so a missing database surfaces as a refused room open — which
 * is the correct answer for this particular dependency — rather than as a crash at boot in a
 * process that was only ever going to serve content.
 */
export function postgresRoomOwnership(sql: () => Db, ownerId: string = instanceOwnerId()): RoomOwnership {
  return {
    ownerId,
    acquire: async (roomId) => {
      const lease = await ownershipRepository.acquire(sql(), {
        roomId,
        ownerId,
        ttlSeconds: LEASE_TTL_MS / 1_000,
      });
      if (lease === null) return null;
      return { roomId, fence: lease.fence, acquiredAt: lease.acquiredAt };
    },
    heartbeat: (roomIds) => ownershipRepository.heartbeat(sql(), { ownerId, roomIds }),
    release: (roomId, fence) => ownershipRepository.release(sql(), { roomId, ownerId, fence }),
    holderOf: async (roomId) => {
      const row = await ownershipRepository.read(sql(), roomId);
      if (row === null) return null;
      return {
        ownerId: row.owner_id,
        fence: Number(row.fence),
        heartbeatAgeMs: Math.max(0, Date.now() - row.heartbeat_at.getTime()),
      };
    },
  };
}
