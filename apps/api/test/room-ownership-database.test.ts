/**
 * Two API processes, one database, one room — the test the whole lease exists to make pass.
 *
 * ## Why this cannot be done with a fake
 *
 * `room-ownership.test.ts` proves the registry reacts correctly to each answer a lease can give it,
 * and it proves that with a fake because a fake is the only way to produce a heartbeat that throws
 * three times and then succeeds. What a fake cannot prove is the thing that actually protects a
 * table: that when TWO processes with two owner ids ask Postgres for the same room, exactly one of
 * them gets it. That is a property of an `INSERT ... ON CONFLICT DO UPDATE ... WHERE` evaluated
 * against a real row under a real row lock, and a fake asserting it would be asserting its own
 * implementation.
 *
 * So each case below runs two `RoomRegistry` instances with different owner ids against ONE
 * database, which is exactly what `deploy.replicas: 2` is.
 *
 * ## What was true before this file
 *
 * Every case here passes trivially against the old code by doing the wrong thing. There was no
 * lease table, no refusal and no eviction: the second registry opened the room, both processes held
 * their own deck and pot, and whichever settlement landed second overwrote `room_members.stack` and
 * destroyed the chips the other had paid out. The four cases are written as the four properties
 * that were missing —
 *
 *   (a) a live holder's room cannot be taken;
 *   (b) a holder that has BEEN taken from stops serving, rather than carrying on;
 *   (c) a holder that crashed does not strand the room forever;
 *   (d) a release cannot free somebody else's lease.
 *
 * ## Why time is moved by writing `heartbeat_at`, not by waiting
 *
 * The TTL is thirty seconds. A test that waited it out would not be a test, and one that shortened
 * it would be testing a different constant from the one that ships. Backdating `heartbeat_at` is
 * how the state under test arises in production too: a process stops renewing, and time passes.
 * `retention-sweep-database.test.ts` backdates `created_at` for exactly the same reason.
 *
 * Skips, loudly, when there is no test database — `databaseSkip` is the repository suite's own
 * mechanism and this uses it rather than inventing a quieter one.
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
    // `prl.rooms`, NOT `prl.room_ownership`, and the difference is deliberate. This probe decides
    // whether the database-backed cases run at all, so it must only ever answer "there is no
    // database here". A database that exists and has not had migration 0005 applied is not a
    // missing database — it is a broken one, and probing for the lease table would turn that into a
    // silent skip of every case in this file. `helpers/database.ts` states the policy in one
    // sentence: a test that cannot run must fail loudly or be excluded by an explicitly named
    // script, never silently pass.
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

  /**
   * A room row to hang leases off, because `room_ownership.room_id` really references `prl.rooms`.
   *
   * Written as raw SQL rather than through `rooms.create`, for the reason
   * `retention-sweep-database.test.ts` gives about sessions: the repository is written so it cannot
   * produce the state under test — it would mint an invite code and a member and a user — and none
   * of that is what this file is about. `owner_user_id` is NULL, which migration 0004 made legal
   * precisely so a room can outlive its creator, and it keeps this fixture from needing a user at
   * all.
   */
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

  /**
   * Removes the room, and its lease with it (`ON DELETE CASCADE`).
   *
   * Through the schema-owning identity, because `prl_app` holds no DELETE on `prl.rooms` and must
   * not — the runtime genuinely cannot retract a room. That split is the whole point of
   * `withAdminSql`, and borrowing the application's own connection here would quietly hide a
   * missing grant.
   */
  async function dropRoom(roomId: string): Promise<void> {
    await withAdminSql(async (admin) => {
      await admin`delete from prl.rooms where id = ${roomId}`;
    });
  }

  /**
   * Backdates the lease, which is how a holder that stopped renewing looks.
   *
   * BOTH timestamps move, and that is not a workaround for the CHECK — it is what the state
   * actually looks like. `room_ownership_heartbeat_after_acquire` refuses a heartbeat older than
   * the acquisition because there is no way for the acquire/renew pair to produce one: both are the
   * database's `now()`, and a renewal only ever moves forward. A process that crashed took the room
   * at some point in the past and stopped renewing it at some point after that, so the row is old
   * in both columns. The constraint earned its place by refusing the first version of this helper,
   * which backdated one of them and would have been testing a row production cannot contain.
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

  /** One API process, as far as the lease is concerned: its own owner id and its own registry. */
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

  // -------------------------------------------------------------------------
  // (a) Two processes, one room
  // -------------------------------------------------------------------------

  /**
   * NEGATIVE CONTROL (a). Against the code before the lease, the second `open` SUCCEEDED, and this
   * assertion is the whole difference between "documented" and "enforced": two live tables for one
   * room in two processes, two decks, two pots, and the chips of whoever won in the losing process
   * destroyed by the other's settlement.
   */
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

      // The row still names the FIRST process, at the generation it took it. A refusal that quietly
      // moved the lease would be the same defect with an error message on it.
      const row = await ownershipRepository.read(sql(), roomId);
      assert.equal(row?.owner_id, first.ownerId);
      assert.equal(row?.fence, '1');
    } finally {
      await first.registry.shutdown();
      await second.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  /**
   * The other half of (a): renewing keeps it refused.
   *
   * Without this, a lease that was never renewed would pass the case above purely because the test
   * is fast. This one moves the clock past the TTL, renews, and asserts the second process is still
   * refused — which is what the heartbeat is actually for.
   */
  it('keeps refusing while the holder goes on renewing', async () => {
    const roomId = await makeRoom();
    const holder = apiProcess('holder');
    const other = apiProcess('other');
    try {
      await holder.registry.open({ record: record(roomId) });
      // Older than the TTL, so this room is takeable — and then renewed, so it is not.
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

  // -------------------------------------------------------------------------
  // (b) A fenced owner stops serving
  // -------------------------------------------------------------------------

  /**
   * NEGATIVE CONTROL (b). The case that matters most, because it is the one where corruption has
   * already started: this process was serving the room, something took it, and the only correct
   * response is to stop — immediately, at the next beat.
   *
   * Against the old code there was nothing to take and nothing to notice, so a process served a
   * room for its whole life whatever any other process did.
   */
  it('evicts a room it has been fenced from instead of going on serving it', async () => {
    const roomId = await makeRoom();
    const loser = apiProcess('loser');
    const winner = apiProcess('winner');
    try {
      const room = await loser.registry.open({ record: record(roomId) });
      assert.equal(loser.registry.size, 1);

      // The loser stops renewing — a GC pause it never came back from, a frozen database, a
      // partition — and the winner legitimately takes the room once the lease has expired.
      await stopRenewing(roomId, LEASE_TTL_MS * 2);
      await winner.registry.open({ record: record(roomId) });
      const row = await ownershipRepository.read(sql(), roomId);
      assert.equal(row?.owner_id, winner.ownerId);
      // The fence is the evidence that the room changed hands, and it only ever goes up.
      assert.equal(row?.fence, '2');
      assert.equal(winner.registry.leaseFor(roomId)?.fence, 2);

      // The loser comes back and beats. This is the moment it learns.
      await loser.registry.heartbeatLeases();

      assert.equal(loser.registry.size, 0, 'the fenced process must stop serving the room at once');
      assert.equal(loser.registry.get(roomId), null);
      assert.equal(room.record.closed, true, 'the live table must be closed, not merely dropped');
      assert.deepEqual(loser.evictions, [{ roomId, reason: 'fenced' }]);
      assert.equal(loser.metrics.roomFencings.get({ reason: 'fenced' }), 1);

      // And the winner is untouched by the loser noticing: an eviction in one process must not be
      // able to release the lease of the process that legitimately holds it.
      const after = await ownershipRepository.read(sql(), roomId);
      assert.equal(after?.owner_id, winner.ownerId);
      assert.equal(winner.registry.size, 1);
    } finally {
      await loser.registry.shutdown();
      await winner.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  // -------------------------------------------------------------------------
  // (c) A crashed holder does not strand the room
  // -------------------------------------------------------------------------

  /**
   * NEGATIVE CONTROL (c). The reason the lease has a TTL at all.
   *
   * A process that is SIGKILLed, OOM-killed, or whose host disappears cannot release anything. If
   * an unrenewed lease were held forever, the first crash would make that room unopenable by
   * anybody, permanently — a guard against a rare misconfiguration that causes a common outage,
   * which is worse than the problem it solves.
   *
   * The pair of assertions is the point: a lease one millisecond inside the TTL is NOT takeable and
   * one past it is. A test that only asserted the second would pass against a lease with no
   * expiry check at all.
   */
  it('lets a crashed process’s room be taken once the lease has expired, and not before', async () => {
    const roomId = await makeRoom();
    const crashed = apiProcess('crashed');
    const successor = apiProcess('successor');
    try {
      await crashed.registry.open({ record: record(roomId) });

      // Still inside the TTL: the room belongs to a process that might simply be busy.
      await stopRenewing(roomId, LEASE_TTL_MS / 2);
      await assert.rejects(successor.registry.open({ record: record(roomId) }), (error: unknown) => {
        assert.ok(isAppError(error) && error.code === 'room_owned_elsewhere');
        return true;
      });

      // Past it: the holder has been silent for longer than any pause it could survive.
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

  /**
   * The graceful half of the same story, and the reason `shutdown()` waits.
   *
   * A deploy that released nothing would leave every room this process was serving unopenable by
   * its own replacement for a whole TTL — the exact overlap window the lease exists to make safe,
   * turned into an outage. Releasing makes the hand-over immediate.
   */
  it('hands the room over immediately when the holder shuts down gracefully', async () => {
    const roomId = await makeRoom();
    const leaving = apiProcess('leaving');
    const arriving = apiProcess('arriving');
    try {
      await leaving.registry.open({ record: record(roomId) });
      await leaving.registry.shutdown();

      assert.equal(await ownershipRepository.read(sql(), roomId), null, 'the lease must be gone');
      // No waiting out a TTL: the replacement gets it now.
      await arriving.registry.open({ record: record(roomId) });
      const row = await ownershipRepository.read(sql(), roomId);
      assert.equal(row?.owner_id, arriving.ownerId);
      assert.equal(row?.fence, '1', 'a released lease leaves no row, so the next holder starts again');
    } finally {
      await arriving.registry.shutdown();
      await dropRoom(roomId);
    }
  });

  // -------------------------------------------------------------------------
  // (d) Release is owner-scoped
  // -------------------------------------------------------------------------

  /**
   * NEGATIVE CONTROL (d). An unscoped `delete from prl.room_ownership where room_id = $1` passes
   * every other test in this file and reintroduces the whole defect through the cleanup path: a
   * process that has already been fenced tidies up on its way out, deletes the lease of the process
   * that legitimately took the room, and the next arrival takes a room somebody is mid-hand in.
   *
   * That is not hypothetical shape-matching — it is precisely what happens during the overlap of a
   * rolling deploy, which is the most common way two processes exist at once.
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

      // The other half of the scope, and it is not the same statement. A release is queued by
      // `releaseLeaseSoon` and runs an unbounded time later, so the holder's OWN release for a
      // generation it has since given up and taken again must also match nothing — otherwise it
      // deletes a lease this process is currently dealing under. See `release` in
      // `repositories/room-ownership.ts` for the reproduction.
      const staleGeneration = await ownershipRepository.release(sql(), {
        roomId,
        ownerId: holder.ownerId,
        fence: Number(row.fence) + 1,
      });
      assert.equal(staleGeneration, false, 'a release naming another generation must match no row');
      assert.ok(await ownershipRepository.read(sql(), roomId), 'the wrong generation deleted the row');

      // The positive control: the real holder at the real generation can, so the assertions above
      // are about the SCOPE rather than about release being broken.
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

  /**
   * The same scoping, on the renewal.
   *
   * A renewal that was not owner-scoped would let a fenced process keep the winner's lease alive
   * indefinitely — so the winner would look healthy, the loser would never learn it had been
   * fenced, and both would go on serving. The renewal reporting the room as NOT renewed is exactly
   * how the loser finds out.
   */
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

  // -------------------------------------------------------------------------
  // Concurrency: the property the single statement is for
  // -------------------------------------------------------------------------

  /**
   * Two processes asking at the same instant. Exactly one wins.
   *
   * This is the case a read-then-write cannot pass: "is anybody holding this? no? take it" is two
   * statements with a window between them, and the window opens on exactly this sequence — two
   * processes starting together, both reading "free", both writing. `ON CONFLICT DO UPDATE`
   * serialises them on the row, so one of them gets no row back and refuses.
   */
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

  /**
   * Re-opening our own room is legal, and moves the fence.
   *
   * A process that closes a room and opens it again is not a second process, and refusing it would
   * make every ordinary close/reopen cycle fail. The fence still moves, because it counts
   * ACQUISITIONS rather than owners — which is what lets "has this room changed hands since I last
   * looked?" be answered by comparing one number.
   */
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

  // -------------------------------------------------------------------------
  // (e) A beat that had to wait
  // -------------------------------------------------------------------------

  /**
   * NEGATIVE CONTROL (e). Against `set heartbeat_at = now()` this case FAILED with
   * `23514 room_ownership_heartbeat_after_acquire` — reproduced against PostgreSQL 16, on pool
   * handles, exactly as `rooms/ownership.ts` issues them.
   *
   * `now()` is the TRANSACTION's start, and one beat is one statement over every room this process
   * holds, so it takes one row lock after another and any one of them can wait. A beat that
   * blocked on the first room wrote the second room's heartbeat with a timestamp from BEFORE the
   * wait — earlier than an `acquire` that had committed in the meantime — and 0005's
   * `heartbeat_at >= acquired_at` refused the write. The migration says of that constraint that
   * "both are written with the database's `now()`, so on a healthy path this cannot fire".
   *
   * What made it expensive is that the beat is ONE statement: the renewals for every OTHER room
   * were rolled back with it. `heartbeatLeases` catches the failure, so the process then has one
   * beat's worth of nothing, on precisely the path `releaseLeaseSoon` documents as the one that
   * produces the most of these — a database slow enough that beats block while rooms are evicted
   * and re-opened underneath.
   *
   * The contention is produced with a real row lock on the FIRST room rather than a sleep, and the
   * case refuses to proceed until a backend is genuinely blocked: a run in which nothing waited
   * would prove nothing and must not be able to look like a pass.
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

      // The same process re-takes the SECOND room while the beat is still queued behind the first:
      // an eviction and a re-open, which is what `releaseLeaseSoon` says happens most on this path.
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
