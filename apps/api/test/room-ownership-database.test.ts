/**
 * Two API processes, one database, one room. Each case runs two `RoomRegistry` instances with
 * different owner ids against ONE database, which is what `deploy.replicas: 2` is. A fake cannot
 * prove exactly one of them wins, because that is a property of `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE` under a real row lock. Time is moved by backdating `heartbeat_at`, never by waiting out or
 * shortening the 30s TTL.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import type { TableConfig } from '@prl/poker-engine';
import { createSecureRandom } from '@prl/poker-engine';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import { isAppError } from '../src/errors.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import * as ownershipRepository from '../src/repositories/room-ownership.ts';
import { LEASE_TTL_MS, postgresRoomOwnership } from '../src/rooms/ownership.ts';
import { type RoomRecord, RoomRegistry } from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { databaseSkip, TEST_DATABASE_URL, withAdminSql } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

let client: Sql | undefined;
let skipReason: string | false = databaseSkip('the room lease against a real database');

if (TEST_DATABASE_URL !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
        DATABASE_POOL_MAX: '4',
      }),
    );
    // Probe `prl.rooms`, not `prl.room_ownership`. A database without migration 0005 is broken, not
    // missing, and must fail loudly instead of skipping every case.
    await probe`select 1 from prl.rooms limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `the database is configured but the prl schema is not reachable: ${String(error)}`;
  }
}

after(async () => {
  await client?.end({ timeout: 5 });
});

const CONFIG: TableConfig = {
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxSeats: 6,
  actionTimeoutSeconds: 30,
};

describe('the room lease, against a real database', { skip: skipReason }, () => {
  const sql = (): Sql => client as Sql;

  /** Raw SQL rather than `rooms.create`, which would also mint an invite code, a member and a user. */
  async function makeRoom(): Promise<string> {
    const id = `room_lease${randomBytes(6).toString('hex')}`;
    await withAdminSql(async (admin) => {
      await admin`
        insert into prl.rooms
          (id, name, owner_user_id, invite_code_hash, max_seats, small_blind, big_blind,
           starting_stack, action_timeout_seconds)
        values
          (${id}, ${'Lease probe'}, ${null}, ${randomBytes(32)}, ${6}, ${5}, ${10}, ${1_000}, ${30})
      `;
    });
    return id;
  }

  /** Through the admin identity, because `prl_app` holds no DELETE on `prl.rooms` and must not. */
  async function dropRoom(roomId: string): Promise<void> {
    await withAdminSql(async (admin) => {
      await admin`delete from prl.rooms where id = ${roomId}`;
    });
  }

  /**
   * Backdates the lease, which is how a holder that stopped renewing looks. Both timestamps move,
   * because `room_ownership_heartbeat_after_acquire` refuses a heartbeat older than the acquisition.
   */
  async function stopRenewing(roomId: string, agoMs: number): Promise<void> {
    const seconds = agoMs / 1_000;
    await sql()`
      update prl.room_ownership
         set acquired_at = now() - make_interval(secs => ${seconds + 1}::double precision),
             heartbeat_at = now() - make_interval(secs => ${seconds}::double precision)
       where room_id = ${roomId}
    `;
  }

  function record(roomId: string): RoomRecord {
    return {
      id: roomId,
      name: 'Lease probe',
      ownerUserId: null,
      config: CONFIG,
      startingStack: 1_000,
      createdAt: '2026-08-25T12:00:00.000Z',
      closed: false,
    };
  }

  interface Process {
    readonly registry: RoomRegistry;
    readonly ownerId: string;
    readonly metrics: AppMetrics;
    readonly evictions: { roomId: string; reason: string }[];
  }

  function apiProcess(label: string): Process {
    const ownerId = `api_${label}_${randomBytes(8).toString('hex')}`;
    const metrics = new AppMetrics();
    const evictions: { roomId: string; reason: string }[] = [];
    const registry = new RoomRegistry({
      clock: createManualClock(),
      metrics,
      random: createSecureRandom(),
      ownership: postgresRoomOwnership(sql, ownerId),
    });
    registry.onEviction((roomId, reason) => evictions.push({ roomId, reason }));
    return { registry, ownerId, metrics, evictions };
  }

  /** NEGATIVE CONTROL (a). Without the lease, the second `open` succeeds and both processes deal. */
  it('refuses a second process the room a live process is already serving', async () => {
    const roomId = await makeRoom();
    const first = apiProcess('one');
    const second = apiProcess('two');
    try {
      const room = await first.registry.open({ record: record(roomId) });
      assert.equal(room.record.id, roomId);
      assert.equal(first.registry.leaseFor(roomId)?.fence, 1);

      const failure = await second.registry.open({ record: record(roomId) }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(
        isAppError(failure),
        'the second process opened a room the first one is serving; two processes are now dealing ' +
          'two different hands at one table',
      );
      assert.equal(failure.code, 'room_owned_elsewhere');
      assert.equal(second.registry.size, 0, 'a refused room must not be half-built');
      assert.equal(second.metrics.roomOwnershipRefusals.get(), 1);

      // A refusal must not move the lease.
      const row = await ownershipRepository.read(sql(), roomId);
      assert.equal(row?.owner_id, first.ownerId);
      assert.equal(row?.fence, '1');
    } finally {
      await first.registry.shutdown();
      await second.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /** Without this, an unrenewed lease would pass the case above only because the test is fast. */
  it('keeps refusing while the holder goes on renewing', async () => {
    const roomId = await makeRoom();
    const holder = apiProcess('holder');
    const other = apiProcess('other');
    try {
      await holder.registry.open({ record: record(roomId) });
      // Older than the TTL, so this room is takeable, and then renewed, so it is not.
      await stopRenewing(roomId, LEASE_TTL_MS * 2);
      await holder.registry.heartbeatLeases();
      assert.equal(holder.registry.size, 1, 'a successful renewal must not evict anything');

      await assert.rejects(other.registry.open({ record: record(roomId) }), (error: unknown) => {
        assert.ok(isAppError(error) && error.code === 'room_owned_elsewhere');
        return true;
      });
    } finally {
      await holder.registry.shutdown();
      await other.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /** NEGATIVE CONTROL (b). Without the lease, a process serves a room whatever other processes do. */
  it('evicts a room it has been fenced from instead of going on serving it', async () => {
    const roomId = await makeRoom();
    const loser = apiProcess('loser');
    const winner = apiProcess('winner');
    try {
      const room = await loser.registry.open({ record: record(roomId) });
      assert.equal(loser.registry.size, 1);

      await stopRenewing(roomId, LEASE_TTL_MS * 2);
      await winner.registry.open({ record: record(roomId) });
      const row = await ownershipRepository.read(sql(), roomId);
      assert.equal(row?.owner_id, winner.ownerId);
      assert.equal(row?.fence, '2');
      assert.equal(winner.registry.leaseFor(roomId)?.fence, 2);

      await loser.registry.heartbeatLeases();

      assert.equal(loser.registry.size, 0, 'the fenced process must stop serving the room at once');
      assert.equal(loser.registry.get(roomId), null);
      assert.equal(room.record.closed, true, 'the live table must be closed, not merely dropped');
      assert.deepEqual(loser.evictions, [{ roomId, reason: 'fenced' }]);
      assert.equal(loser.metrics.roomFencings.get({ reason: 'fenced' }), 1);

      // An eviction in one process must not release the lease of the legitimate holder.
      const after = await ownershipRepository.read(sql(), roomId);
      assert.equal(after?.owner_id, winner.ownerId);
      assert.equal(winner.registry.size, 1);
    } finally {
      await loser.registry.shutdown();
      await winner.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /**
   * NEGATIVE CONTROL (c). A crashed process cannot release, so an unrenewed lease must expire. Both
   * sides of the TTL are asserted, because the expired side alone passes with no expiry check at all.
   */
  it('lets a crashed process’s room be taken once the lease has expired, and not before', async () => {
    const roomId = await makeRoom();
    const crashed = apiProcess('crashed');
    const successor = apiProcess('successor');
    try {
      await crashed.registry.open({ record: record(roomId) });

      await stopRenewing(roomId, LEASE_TTL_MS / 2);
      await assert.rejects(successor.registry.open({ record: record(roomId) }), (error: unknown) => {
        assert.ok(isAppError(error) && error.code === 'room_owned_elsewhere');
        return true;
      });

      await stopRenewing(roomId, LEASE_TTL_MS * 2);
      const room = await successor.registry.open({ record: record(roomId) });
      assert.equal(room.record.id, roomId);
      const row = await ownershipRepository.read(sql(), roomId);
      assert.equal(row?.owner_id, successor.ownerId);
      assert.equal(row?.fence, '2', 'a takeover is an acquisition and must move the fence');
    } finally {
      await crashed.registry.shutdown();
      await successor.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /** Without a release on shutdown, a deploy's replacement could not open these rooms for a TTL. */
  it('hands the room over immediately when the holder shuts down gracefully', async () => {
    const roomId = await makeRoom();
    const leaving = apiProcess('leaving');
    const arriving = apiProcess('arriving');
    try {
      await leaving.registry.open({ record: record(roomId) });
      await leaving.registry.shutdown();

      assert.equal(await ownershipRepository.read(sql(), roomId), null, 'the lease must be gone');
      await arriving.registry.open({ record: record(roomId) });
      const row = await ownershipRepository.read(sql(), roomId);
      assert.equal(row?.owner_id, arriving.ownerId);
      assert.equal(row?.fence, '1', 'a released lease leaves no row, so the next holder starts again');
    } finally {
      await arriving.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /**
   * NEGATIVE CONTROL (d). An unscoped release passes every other case here, and lets a fenced process
   * delete the lease of the process that took the room over, as happens during a rolling deploy.
   */
  it('refuses to release a lease this process does not hold', async () => {
    const roomId = await makeRoom();
    const holder = apiProcess('holder');
    const stranger = apiProcess('stranger');
    try {
      await holder.registry.open({ record: record(roomId) });

      const strangerReleased = await ownershipRepository.release(sql(), {
        roomId,
        ownerId: stranger.ownerId,
        fence: 1,
      });
      assert.equal(strangerReleased, false, 'a release that is not ours must match no row');

      const row = await ownershipRepository.read(sql(), roomId);
      assert.ok(row !== null, 'the lease was deleted by a process that never held it');
      assert.equal(row.owner_id, holder.ownerId);

      // A queued `releaseLeaseSoon` for a generation since given up must also match nothing.
      const staleGeneration = await ownershipRepository.release(sql(), {
        roomId,
        ownerId: holder.ownerId,
        fence: Number(row.fence) + 1,
      });
      assert.equal(staleGeneration, false, 'a release naming another generation must match no row');
      assert.ok(await ownershipRepository.read(sql(), roomId), 'the wrong generation deleted the row');

      // Positive control. The real holder at the real generation can release.
      assert.equal(
        await ownershipRepository.release(sql(), {
          roomId,
          ownerId: holder.ownerId,
          fence: Number(row.fence),
        }),
        true,
      );
      assert.equal(await ownershipRepository.read(sql(), roomId), null);
    } finally {
      await holder.registry.shutdown();
      await stranger.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /** An unscoped renewal would keep the winner's lease alive, so the fenced loser would never learn. */
  it('renews nothing for a process that does not hold the room', async () => {
    const roomId = await makeRoom();
    const holder = apiProcess('holder');
    const stranger = apiProcess('stranger');
    try {
      await holder.registry.open({ record: record(roomId) });
      const before = await ownershipRepository.read(sql(), roomId);

      const renewed = await ownershipRepository.heartbeat(sql(), {
        ownerId: stranger.ownerId,
        roomIds: [roomId],
      });
      assert.deepEqual(renewed, [], 'the stranger renewed a lease it does not hold');

      const after = await ownershipRepository.read(sql(), roomId);
      assert.equal(after?.heartbeat_at.getTime(), before?.heartbeat_at.getTime());
      assert.equal(after?.owner_id, holder.ownerId);
    } finally {
      await holder.registry.shutdown();
      await stranger.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /** A read-then-write cannot pass this. `ON CONFLICT DO UPDATE` serialises the two on the row. */
  it('gives one room to exactly one of two simultaneous processes', async () => {
    const roomId = await makeRoom();
    const left = apiProcess('left');
    const right = apiProcess('right');
    try {
      const results = await Promise.allSettled([
        left.registry.open({ record: record(roomId) }),
        right.registry.open({ record: record(roomId) }),
      ]);
      const won = results.filter((result) => result.status === 'fulfilled');
      const lost = results.filter((result) => result.status === 'rejected');
      assert.equal(
        won.length,
        1,
        `both processes took the room: ${JSON.stringify(results.map((r) => r.status))}`,
      );
      assert.equal(lost.length, 1);
      const refusal = lost[0]?.status === 'rejected' ? lost[0].reason : null;
      assert.ok(isAppError(refusal) && refusal.code === 'room_owned_elsewhere');
      assert.equal(left.registry.size + right.registry.size, 1);
    } finally {
      await left.registry.shutdown();
      await right.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /** The fence counts acquisitions, not owners, so the same process re-acquiring still moves it. */
  it('lets the same process take its own room again, at a higher fence', async () => {
    const roomId = await makeRoom();
    const holder = apiProcess('holder');
    try {
      await holder.registry.open({ record: record(roomId) });
      assert.equal(holder.registry.leaseFor(roomId)?.fence, 1);
      holder.registry.close(roomId);
      // The close queues the release; waiting for it is what makes the next open a fresh insert.
      await holder.registry.shutdown();

      await holder.registry.open({ record: record(roomId) });
      assert.equal(holder.registry.leaseFor(roomId)?.fence, 1, 'a released lease leaves no row behind');

      // And without a release in between, the re-acquire increments instead.
      const reacquired = await ownershipRepository.acquire(sql(), {
        roomId,
        ownerId: holder.ownerId,
        ttlSeconds: LEASE_TTL_MS / 1_000,
      });
      assert.equal(reacquired?.fence, 2, 'a fence that does not move cannot detect a takeover');
    } finally {
      await holder.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /**
   * NEGATIVE CONTROL (e). `now()` is the transaction start, so with `set heartbeat_at = now()` a beat
   * that waited on one row lock writes a heartbeat older than an `acquire` that committed meanwhile:
   * `23514 room_ownership_heartbeat_after_acquire` on PostgreSQL 16, and the single-statement beat
   * rolls back every other room's renewal with it.
   * The contention is a real row lock, and the case refuses to proceed until a backend is blocked.
   */
  it('renews every room even when the beat has to wait for one of them', async () => {
    const first = await makeRoom();
    const second = await makeRoom();
    const ownerId = `api_beat_${randomBytes(8).toString('hex')}`;
    const ttlSeconds = LEASE_TTL_MS / 1_000;
    try {
      await ownershipRepository.acquire(sql(), { roomId: first, ownerId, ttlSeconds });
      await ownershipRepository.acquire(sql(), { roomId: second, ownerId, ttlSeconds });

      let lockTaken!: () => void;
      const held = new Promise<void>((wake) => {
        lockTaken = wake;
      });
      let releaseTheLock!: () => void;
      const untilReleased = new Promise<void>((wake) => {
        releaseTheLock = wake;
      });

      const blocker = withAdminSql((admin) =>
        admin.begin(async (tx) => {
          await tx`select room_id from prl.room_ownership where room_id = ${first} for update`;
          lockTaken();
          await untilReleased;
        }),
      );
      await held;

      // Dispatched now, so its transaction timestamp is taken now, and then it waits on `first`.
      const beat = ownershipRepository.heartbeat(sql(), { ownerId, roomIds: [first, second] });
      await withAdminSql(async (watcher) => {
        for (let attempt = 0; attempt < 250; attempt += 1) {
          const rows = await watcher<{ waiting: number }[]>`
            select count(*)::int as waiting
              from pg_locks
             where not granted and pid <> pg_backend_pid()
          `;
          if ((rows[0]?.waiting ?? 0) > 0) return;
          await new Promise((wake) => setTimeout(wake, 20));
        }
        assert.fail('the beat never blocked, so this case did not produce the state it is about');
      });

      // Re-take the second room while the beat is queued behind the first, which moves acquired_at.
      const retaken = await ownershipRepository.acquire(sql(), { roomId: second, ownerId, ttlSeconds });
      assert.equal(retaken?.fence, 2, 'the re-acquire did not happen, so nothing moved acquired_at');

      releaseTheLock();
      const renewed = await beat;
      await blocker;

      assert.deepEqual(
        [...renewed].sort(),
        [first, second].sort(),
        'a beat that had to wait lost the renewals of the rooms it was not waiting for',
      );
      const rows = await withAdminSql(
        (admin) => admin<{ room_id: string; ok: boolean }[]>`
          select room_id, heartbeat_at >= acquired_at as ok
            from prl.room_ownership where room_id in (${first}, ${second})
        `,
      );
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.ok, true, `${row.room_id} kept a heartbeat older than its acquisition`);
      }
    } finally {
      await dropRoom(first);
      await dropRoom(second);
    }
  });
});
