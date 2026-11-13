/**
 * `prl.room_ownership`, the lease that enforces one API process per room. A live hand lives in one
 * process's memory, so two processes serving one room deal two hands and lose chips on settlement.
 * Each function is one statement whose atomicity is its own. No advisory lock, because it belongs to a
 * session and evaporates when the pool recycles the connection. Every timestamp comes from the
 * database clock, so two API processes with skewed clocks agree on liveness.
 */

import type { Db } from './sql.ts';

export interface RoomLeaseRow {
  readonly room_id: string;
  readonly owner_id: string;
  /** `bigint`, which postgres.js hands back as a string. Parsed by the callers that compare it. */
  readonly fence: string;
  readonly acquired_at: Date;
  readonly heartbeat_at: Date;
}

export interface AcquiredLease {
  readonly roomId: string;
  readonly ownerId: string;
  /** `bigint` in the column so it cannot wrap. A `number` here is safe up to 2^53 takeovers. */
  readonly fence: number;
  readonly acquiredAt: Date;
}

/**
 * Takes the lease, or returns null when a live process holds it. The predicate is in the one
 * `INSERT ... ON CONFLICT DO UPDATE ... WHERE`, so Postgres serialises concurrent acquisitions under
 * the row lock; a read-then-write would let two processes both see the room free.
 *
 * Succeeds when we already hold it (the fence still increments), or when the holder has not renewed
 * for `ttlSeconds`, because a killed process cannot release. `make_interval` keeps the TTL a typed
 * bind parameter.
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
 * Renews every lease this owner holds, in one round trip whatever the room count, and returns the
 * rooms it renewed. A requested room missing from the answer has been fenced, and the caller must
 * stop serving it at once. No fence term, because a re-acquisition already hands the caller the new
 * fence, and a per-room parameter would force one statement per room.
 *
 * `clock_timestamp()`, NOT `now()`. `now()` is fixed at transaction start, so a beat that waited on a
 * row lock wrote a heartbeat older than the acquisition it queued behind, and
 * `room_ownership_heartbeat_after_acquire` (23514) rolled back the whole beat. Reproduced on
 * PostgreSQL 16 with one owner re-acquiring a room while its beat was blocked.
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
 * Gives the lease back, scoped to the owner AND the generation. Returns false when we did not hold
 * that generation, which is not an error.
 *
 * Without the owner scope, a fenced process would delete its successor's lease. Without the fence,
 * this process's own stale release would delete the lease it had since re-acquired. Releases are
 * queued by `RoomRegistry.releaseLeaseSoon` and can run long after a re-open. Reproduced against
 * `RoomRegistry` with the release chain held open across an eviction and a re-open. The row was
 * deleted, the next beat evicted the room as `fenced`, and the zero-tolerance fencing counter rose.
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

/** For the runbook and the tests. Nothing on the request path reads it. */
export async function read(handle: Db, roomId: string): Promise<RoomLeaseRow | null> {
  const rows = await handle<RoomLeaseRow[]>`
    select room_id, owner_id, fence, acquired_at, heartbeat_at
      from prl.room_ownership
     where room_id = ${roomId}
  `;
  return rows[0] ?? null;
}
