/**
 * The room lease decides which API process is authoritative for a room. A live hand exists only in one
 * heap, so two processes serving a room deal two hands and overwrite each other's `room_members.stack`.
 * Opening a room takes the lease or is refused. A heartbeat renews every held lease, and a renewal
 * that updates no row means this process was fenced and must drop the room at once.
 * `fence` restarts at 1 after a release, because `release` deletes the row (contrary to 0005's
 * header). No table has a fence column, so the database does not refuse a write already in flight
 * from a fenced process. Eviction bounds that to one heartbeat.
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import * as ownershipRepository from '../repositories/room-ownership.ts';
import type { Db } from '../repositories/sql.ts';

/**
 * How long a lease survives without a renewal. It must outlast the slowest query: `db.ts` bounds each at
 * `DATABASE_STATEMENT_TIMEOUT_MS + 2,000` (7,000 ms by default), so two renewals can be abandoned and a
 * third still has 16 s. It is also how long a room stays unopenable after a hard kill.
 * A statement timeout above about 23,000 lets one hung renewal outlast the lease. This process then
 * self-evicts, which is the safe direction.
 */
export const LEASE_TTL_MS = 30_000;

/**
 * Six beats per TTL, so five consecutive renewals can fail before the room is lost. It is also the
 * resolution of the self-eviction check. One beat is one statement for all held rooms.
 */
export const LEASE_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * How stale our last confirmed renewal may get before this process evicts its own rooms.
 * Strictly less than `LEASE_TTL_MS`, so this process steps down before anyone may take over, and any
 * gap is one where nobody serves the room. The 10 s margin covers clock skew to the database host,
 * the round trip, and one heartbeat of check granularity.
 * A process stalled too hard to run timers cannot evict itself, but it is also not writing.
 */
export const LEASE_SELF_EVICT_AFTER_MS = 20_000;

/** Longest slice of a hostname that reaches the column, so a long pod name cannot fill it. */
const HOSTNAME_SLUG_MAX = 32;

/**
 * The column CHECK bounds an owner id at 128 characters with no surrounding whitespace. An empty slug
 * becomes `unknown`, because owner ids must stay distinct, comparable strings.
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
 * Hostname tells an operator which container holds a room, pid separates processes on one host, and the
 * random suffix stops a restarted process reusing a dead one's id and inheriting its leases early.
 * Not a secret, and not an `ids.ts` id (those are CHECKed per table).
 * `randomBytes` because `test/server-randomness.test.ts` bans `Math.random` across `src/`.
 */
export function mintOwnerId(): string {
  return `api_${hostSlug(hostname())}_${process.pid}_${randomBytes(8).toString('hex')}`;
}

/** Minted lazily so importing a constant does not read the hostname. It must never change once minted. */
let processOwnerId: string | null = null;

export function instanceOwnerId(): string {
  processOwnerId ??= mintOwnerId();
  return processOwnerId;
}

/** A lease this process holds, as the registry carries it. */
export interface RoomLease {
  readonly roomId: string;
  /** The acquisition generation. Restarts after a release; see the module header. */
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

/** A port so the rooms and socket tests run with no database. */
export interface RoomOwnership {
  /** Stable for the life of the process. The value written to, and compared against, `owner_id`. */
  readonly ownerId: string;
  /** Takes the lease, or answers null because a live process holds it. */
  readonly acquire: (roomId: string) => Promise<RoomLease | null>;
  /** Renews every named lease and answers with those renewed. A missing room was fenced. */
  readonly heartbeat: (roomIds: readonly string[]) => Promise<readonly string[]>;
  /** Scoped to `ownerId` and `fence`, so a queued release cannot free a later generation of our own. */
  readonly release: (roomId: string, fence: number) => Promise<boolean>;
  /** Who holds a room, for the refusal's log line. Null when nobody does any more. */
  readonly holderOf: (roomId: string) => Promise<LeaseHolder | null>;
}

/** `sql` is a getter so building the registry does not touch the pool. A missing database refuses opens. */
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
