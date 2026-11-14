/**
 * The room lease without a database. Covers the timing constants, the statements, and the registry's
 * reaction to each lease verdict. `room-ownership-database.test.ts` proves the cross-process refusal.
 * A fake is the only way to make a heartbeat throw on demand, and a throw is not a fencing.
 * A registry with no ownership must behave exactly as it did before the lease existed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TableConfig } from '@prl/poker-engine';
import { createSecureRandom } from '@prl/poker-engine';
import type { Sql } from '../src/db.ts';
import { isAppError } from '../src/errors.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import type { ProblemDetail } from '../src/observability/telemetry.ts';
import * as ownershipRepository from '../src/repositories/room-ownership.ts';
import {
  LEASE_HEARTBEAT_INTERVAL_MS,
  LEASE_SELF_EVICT_AFTER_MS,
  LEASE_TTL_MS,
  mintOwnerId,
  type RoomLease,
  type RoomOwnership,
} from '../src/rooms/ownership.ts';
import { type RoomRecord, RoomRegistry } from '../src/rooms/registry.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';

const CONFIG: TableConfig = {
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxSeats: 6,
  actionTimeoutSeconds: 30,
};

function record(id: string): RoomRecord {
  return {
    id,
    name: 'Lease probe',
    ownerUserId: 'usr_owner',
    config: CONFIG,
    startingStack: 1_000,
    createdAt: '2026-08-25T12:00:00.000Z',
    closed: false,
  };
}

/** Answers from a script the case sets. The default is "the lease is ours". */
interface FakeOwnership extends RoomOwnership {
  readonly refuse: Set<string>;
  readonly fenced: Set<string>;
  throwOnHeartbeat: Error | null;
  readonly released: string[];
  readonly acquired: string[];
  heartbeats: number;
}

function fakeOwnership(ownerId = 'api_test_1_aaaaaaaa'): FakeOwnership {
  let fence = 0;
  const fake: FakeOwnership = {
    ownerId,
    refuse: new Set<string>(),
    fenced: new Set<string>(),
    throwOnHeartbeat: null,
    released: [],
    acquired: [],
    heartbeats: 0,
    acquire: (roomId): Promise<RoomLease | null> => {
      fake.acquired.push(roomId);
      if (fake.refuse.has(roomId)) return Promise.resolve(null);
      fence += 1;
      return Promise.resolve({ roomId, fence, acquiredAt: new Date() });
    },
    heartbeat: (roomIds): Promise<readonly string[]> => {
      fake.heartbeats += 1;
      if (fake.throwOnHeartbeat !== null) return Promise.reject(fake.throwOnHeartbeat);
      return Promise.resolve(roomIds.filter((roomId) => !fake.fenced.has(roomId)));
    },
    release: (roomId): Promise<boolean> => {
      fake.released.push(roomId);
      return Promise.resolve(true);
    },
    holderOf: (_roomId) =>
      Promise.resolve({ ownerId: 'api_other_2_bbbbbbbb', fence: 7, heartbeatAgeMs: 1_200 }),
  };
  return fake;
}

/**
 * Holds a beat open until the case answers it, so a case can act on the registry while a renewal
 * is in flight.
 */
function heldHeartbeat(ownerId = 'api_test_1_aaaaaaaa'): {
  readonly ownership: RoomOwnership;
  readonly asked: string[][];
  readonly answer: (renewed: readonly string[]) => void;
} {
  let fence = 0;
  let pending: ((renewed: readonly string[]) => void) | null = null;
  const asked: string[][] = [];
  return {
    asked,
    answer: (renewed) => {
      const resolve = pending;
      assert.ok(resolve !== null, 'no beat was in flight to answer');
      pending = null;
      resolve(renewed);
    },
    ownership: {
      ownerId,
      acquire: (roomId): Promise<RoomLease | null> => {
        fence += 1;
        return Promise.resolve({ roomId, fence, acquiredAt: new Date() });
      },
      heartbeat: (roomIds): Promise<readonly string[]> => {
        asked.push([...roomIds]);
        return new Promise((resolve) => {
          pending = resolve;
        });
      },
      release: () => Promise.resolve(true),
      holderOf: () => Promise.resolve(null),
    },
  };
}

interface Probe {
  readonly registry: RoomRegistry;
  readonly ownership: FakeOwnership;
  readonly metrics: AppMetrics;
  readonly clock: ManualClock;
  readonly problems: { message: string; detail: ProblemDetail }[];
  readonly evictions: { roomId: string; reason: string }[];
}

function probe(options: { readonly ownership?: RoomOwnership | null } = {}): Probe {
  const ownership = fakeOwnership();
  const metrics = new AppMetrics();
  const clock = createManualClock();
  const problems: { message: string; detail: ProblemDetail }[] = [];
  const evictions: { roomId: string; reason: string }[] = [];
  const registry = new RoomRegistry({
    clock,
    metrics,
    random: createSecureRandom(),
    ownership: options.ownership === undefined ? ownership : options.ownership,
    onProblem: (message, detail) => problems.push({ message, detail }),
  });
  registry.onEviction((roomId, reason) => evictions.push({ roomId, reason }));
  return { registry, ownership, metrics, clock, problems, evictions };
}

describe('the lease timings', () => {
  /**
   * Self-eviction runs on local wall time and takeover on Postgres `heartbeat_at`, so equal
   * thresholds would race. Stepping down strictly first means the gap only ever has no server.
   */
  it('steps down strictly before anybody else may take over', () => {
    assert.ok(
      LEASE_SELF_EVICT_AFTER_MS < LEASE_TTL_MS,
      `self-eviction at ${LEASE_SELF_EVICT_AFTER_MS} ms is not before takeover at ${LEASE_TTL_MS} ms, ` +
        'so two processes can believe they own one room at the same instant',
    );
  });

  /** Four is the floor, not the six the constants give, so tuning inside the range still passes. */
  it('fits several heartbeats inside both thresholds', () => {
    const beatsPerTtl = LEASE_TTL_MS / LEASE_HEARTBEAT_INTERVAL_MS;
    assert.ok(beatsPerTtl >= 4, `only ${beatsPerTtl} beats fit inside the TTL; one failure would be fatal`);
    const beatsBeforeStepDown = LEASE_SELF_EVICT_AFTER_MS / LEASE_HEARTBEAT_INTERVAL_MS;
    assert.ok(
      beatsBeforeStepDown >= 3,
      `only ${beatsBeforeStepDown} beats fit before this process gives up its own rooms`,
    );
  });

  /**
   * The binding pause is `db.ts`'s request-path deadline (7,000 ms at the default 5,000 ms statement
   * timeout), and the TTL must fit more than one.
   */
  it('leaves room for more than one abandoned query inside the TTL', () => {
    const defaultQueryDeadlineMs = 5_000 + 2_000;
    assert.ok(
      LEASE_TTL_MS > defaultQueryDeadlineMs * 2,
      `a TTL of ${LEASE_TTL_MS} ms does not survive two abandoned ${defaultQueryDeadlineMs} ms queries`,
    );
  });
});

describe('the owner id', () => {
  it('fits the column and is different every time', () => {
    const first = mintOwnerId();
    const second = mintOwnerId();
    for (const id of [first, second]) {
      assert.ok(id.length >= 8 && id.length <= 128, `${id} is ${id.length} characters`);
      assert.equal(id, id.trim());
    }
    // A colliding owner id would let a restarted process inherit leases without waiting out the TTL.
    assert.notEqual(first, second);
  });
});

/**
 * Records statement text and bound values. It does not parse SQL. It proves the owner id is in the
 * statement, because an unscoped delete lets a fenced process delete the new holder's lease.
 */
function recordingSql(rows: unknown[] = []): { sql: Sql; calls: { text: string; values: unknown[] }[] } {
  const calls: { text: string; values: unknown[] }[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve(rows);
  }) as unknown as Sql;
  return { sql, calls };
}

describe('the ownership statements', () => {
  it('scopes the release to the owner, so it can never release somebody else’s lease', async () => {
    const { sql, calls } = recordingSql([]);
    const released = await ownershipRepository.release(sql, {
      roomId: 'room_abcdefgh',
      ownerId: 'api_host_1_deadbeef',
      fence: 4,
    });
    assert.equal(released, false, 'no row came back, so we did not hold it');
    const statement = calls[0];
    assert.ok(statement !== undefined);
    assert.match(statement.text, /delete\s+from\s+prl\.room_ownership/i);
    assert.match(statement.text, /owner_id\s*=/i, 'an unscoped delete steals the lease it should respect');
    // The owner scope cannot tell a release from a later re-acquisition by this same process.
    assert.match(statement.text, /fence\s*=/i, 'a release with no generation can delete a later one');
    assert.deepEqual(statement.values, ['room_abcdefgh', 'api_host_1_deadbeef', 4]);
  });

  it('offers the lease to a holder that has stopped renewing, and to nobody else', async () => {
    const { sql, calls } = recordingSql([{ fence: '3', acquired_at: new Date() }]);
    const lease = await ownershipRepository.acquire(sql, {
      roomId: 'room_abcdefgh',
      ownerId: 'api_host_1_deadbeef',
      ttlSeconds: 30,
    });
    assert.equal(lease?.fence, 3, 'the fence comes back as a number, from a bigint column');
    const statement = calls[0];
    assert.ok(statement !== undefined);
    assert.match(statement.text, /on conflict/i);
    assert.match(statement.text, /lease\.owner_id\s*=/i);
    assert.match(statement.text, /lease\.heartbeat_at\s*<\s*now\(\)\s*-\s*make_interval/i);
    assert.match(statement.text, /fence\s*=\s*lease\.fence\s*\+\s*1/i);
    assert.deepEqual(statement.values, ['room_abcdefgh', 'api_host_1_deadbeef', 'api_host_1_deadbeef', 30]);
  });

  it('renews every room in one statement and reports only the ones it kept', async () => {
    const { sql, calls } = recordingSql([{ room_id: 'room_aaaaaaaa' }]);
    const renewed = await ownershipRepository.heartbeat(sql, {
      ownerId: 'api_host_1_deadbeef',
      roomIds: ['room_aaaaaaaa', 'room_bbbbbbbb'],
    });
    assert.deepEqual(renewed, ['room_aaaaaaaa'], 'the room that is missing has been fenced');
    assert.equal(calls.length, 1, 'a beat must cost one round trip however many rooms this process holds');
    assert.match(calls[0]?.text ?? '', /owner_id\s*=/i);
  });

  it('does not issue a statement at all when this process holds nothing', async () => {
    const { sql, calls } = recordingSql([]);
    assert.deepEqual(await ownershipRepository.heartbeat(sql, { ownerId: 'api_x', roomIds: [] }), []);
    assert.equal(calls.length, 0, 'an idle process must not poll the database every few seconds');
  });
});

describe('a registry with no ownership behaves exactly as it did before the lease existed', () => {
  it('opens a room, and two concurrent first-touches still share one build', async () => {
    const { registry } = probe({ ownership: null });
    const [first, second] = await Promise.all([
      registry.open({ record: record('room_single01') }),
      registry.open({ record: record('room_single01') }),
    ]);
    assert.equal(first, second, 'the in-flight dedupe in `open` must survive the lease being added');
    assert.equal(registry.size, 1);
    assert.equal(registry.enforcesOwnership, false);
    assert.equal(registry.leaseFor('room_single01'), null);
    registry.closeAll();
  });

  it('arms no timer at all, so an ownership-free process schedules nothing', async () => {
    const { registry, clock } = probe({ ownership: null });
    await registry.open({ record: record('room_single02') });
    assert.equal(clock.pending, 0, 'a registry with no lease to renew must not hold a timer');
    await registry.shutdown();
  });
});

describe('opening a room takes the lease', () => {
  it('records the fence and arms the renewal timer', async () => {
    const { registry, ownership, clock } = probe();
    await registry.open({ record: record('room_lease001') });
    assert.deepEqual(ownership.acquired, ['room_lease001']);
    assert.equal(registry.leaseFor('room_lease001')?.fence, 1);
    assert.equal(clock.pending, 1, 'a held lease must be renewed on a timer');
    await registry.shutdown();
  });

  it('refuses the room when a live process holds it, and says so in its own terms', async () => {
    const { registry, ownership, metrics, problems } = probe();
    ownership.refuse.add('room_lease002');

    const failure = await registry.open({ record: record('room_lease002') }).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(isAppError(failure), 'a refused open must be a typed refusal, not a bare Error');
    // Not `seat_taken` (ordinary, must never page) and not `internal_error` (the guard worked).
    assert.equal(failure.code, 'room_owned_elsewhere');
    assert.equal(registry.size, 0, 'a refused room must not be left half-built in the registry');
    assert.equal(metrics.roomOwnershipRefusals.get(), 1);

    const problem = problems.find((entry) => entry.detail.event === 'room-lease-refused');
    assert.ok(problem !== undefined, 'a refusal that is not reported is a refusal nobody can diagnose');
    // The holder goes to the log, never to the client.
    assert.equal(problem.detail['holderId'], 'api_other_2_bbbbbbbb');
    assert.equal(problem.detail['holderHeartbeatAgeMs'], 1_200);
  });

  /**
   * A leftover lease would make the room unopenable for a whole TTL. The reachable throw today is a
   * problem hook that throws while reporting a fail-soft read, as a throwing log serialiser would.
   */
  it('gives the lease back when the build fails after taking it', async () => {
    const ownership = fakeOwnership();
    const registry = new RoomRegistry({
      ownership,
      metrics: new AppMetrics(),
      clock: createManualClock(),
      random: createSecureRandom(),
      archive: {
        // The read is fail-soft. The hook that reports it is what throws.
        nextHandNumber: () => Promise.resolve(1),
        lastDealtHand: () => Promise.resolve(null),
        abandonInterruptedHands: () => Promise.reject(new Error('pool exhausted')),
        handStarted: () => Promise.resolve(),
        actionsApplied: () => Promise.resolve(),
        streetAdvanced: () => Promise.resolve(),
        handCompleted: () => Promise.resolve(),
        stacksSettled: () => Promise.resolve(),
        roomStatusChanged: () => Promise.resolve(),
      },
      onProblem: () => {
        throw new Error('the log serialiser threw');
      },
    });
    await assert.rejects(registry.open({ record: record('room_lease003') }));
    assert.deepEqual(ownership.released, ['room_lease003'], 'a failed build must not strand the lease');
    assert.equal(registry.size, 0);
    assert.equal(registry.leaseFor('room_lease003'), null);
  });
});

describe('a renewal that comes back without our room', () => {
  it('closes the table, notifies the sockets and drops the room', async () => {
    const { registry, ownership, metrics, problems, evictions } = probe();
    const room = await registry.open({ record: record('room_fence001') });
    ownership.fenced.add('room_fence001');

    await registry.heartbeatLeases();

    assert.equal(registry.size, 0, 'the room must be gone: serving it now is the corruption itself');
    assert.equal(registry.get('room_fence001'), null);
    assert.equal(room.record.closed, true, 'the live table must be closed, not merely forgotten');
    assert.equal(registry.leaseFor('room_fence001'), null);
    assert.deepEqual(evictions, [{ roomId: 'room_fence001', reason: 'fenced' }]);
    assert.equal(metrics.roomFencings.get({ reason: 'fenced' }), 1);
    assert.equal(metrics.roomFencings.get({ reason: 'lease_expired' }), 0);
    const problem = problems.find((entry) => entry.detail.event === 'room-fenced');
    assert.equal(problem?.detail['reason'], 'fenced');
    assert.equal(problem?.detail['fence'], 1);
  });

  it('does not try to release a lease somebody else now holds', async () => {
    const { registry, ownership } = probe();
    await registry.open({ record: record('room_fence002') });
    ownership.fenced.add('room_fence002');
    await registry.heartbeatLeases();
    // Releasing at all would mean this process thinks it might still own the row.
    assert.deepEqual(ownership.released, []);
  });

  it('leaves the rooms it still holds alone', async () => {
    const { registry, ownership, metrics } = probe();
    await registry.open({ record: record('room_fence003') });
    await registry.open({ record: record('room_keep0001') });
    ownership.fenced.add('room_fence003');

    await registry.heartbeatLeases();

    assert.equal(registry.get('room_fence003'), null);
    assert.ok(registry.get('room_keep0001') !== null, 'one fenced room must not take the others with it');
    assert.equal(metrics.roomFencings.get({ reason: 'fenced' }), 1);
    await registry.shutdown();
  });
});

describe('a room opened while a beat is in flight', () => {
  /**
   * `acquireLease` keeps adding rooms while a beat is out at the database. Those rooms are not in
   * the beat's answer, so a verdict applied to the current map would read them as fenced.
   */
  it('is not evicted as fenced (NEGATIVE CONTROL)', async () => {
    const gate = heldHeartbeat();
    const metrics = new AppMetrics();
    const evictions: { roomId: string; reason: string }[] = [];
    const registry = new RoomRegistry({
      clock: createManualClock(),
      metrics,
      random: createSecureRandom(),
      ownership: gate.ownership,
      onProblem: () => undefined,
    });
    registry.onEviction((roomId, reason) => evictions.push({ roomId, reason }));

    await registry.open({ record: record('room_beat0001') });
    const beat = registry.heartbeatLeases();
    await registry.open({ record: record('room_beat0002') });
    assert.equal(registry.leaseFor('room_beat0002')?.fence, 2, 'the second room was leased to us');

    assert.deepEqual(gate.asked, [['room_beat0001']], 'the statement never carried the second room');
    gate.answer(['room_beat0001']);
    await beat;

    assert.deepEqual(evictions, [], 'a room the beat never asked about cannot have been fenced');
    assert.equal(metrics.roomFencings.get({ reason: 'fenced' }), 0);
    assert.ok(registry.get('room_beat0002') !== null, 'a freshly opened table was closed under it');
    await registry.shutdown();
  });

  /**
   * An eviction that lands mid-build deletes a lease entry for an unpublished room. The room is then
   * published with no entry, nothing renews it, and after `LEASE_TTL_MS` another process may take a
   * room this one is still dealing at.
   */
  it('is not left serving a room with no lease at all (NEGATIVE CONTROL)', async () => {
    const gate = heldHeartbeat();
    let reads = 0;
    let releaseRead: ((handNumber: number) => void) | null = null;
    const registry = new RoomRegistry({
      clock: createManualClock(),
      metrics: new AppMetrics(),
      random: createSecureRandom(),
      ownership: gate.ownership,
      archive: {
        // The first open finishes. The second stops between the lease and the publish.
        nextHandNumber: () => {
          reads += 1;
          if (reads === 1) return Promise.resolve(1);
          return new Promise<number>((resolve) => {
            releaseRead = resolve;
          });
        },
        lastDealtHand: () => Promise.resolve(null),
        abandonInterruptedHands: () => Promise.resolve([]),
        handStarted: () => Promise.resolve(),
        actionsApplied: () => Promise.resolve(),
        streetAdvanced: () => Promise.resolve(),
        handCompleted: () => Promise.resolve(),
        stacksSettled: () => Promise.resolve(),
        roomStatusChanged: () => Promise.resolve(),
      },
      onProblem: () => undefined,
    });

    await registry.open({ record: record('room_beat0003') });
    const beat = registry.heartbeatLeases();
    const opening = registry.open({ record: record('room_beat0004') });
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();

    gate.answer(['room_beat0003']);
    await beat;

    (releaseRead as unknown as ((handNumber: number) => void) | null)?.(1);
    const room = await opening;
    assert.equal(room.record.closed, false, 'the room was published and is being served');

    // A room this process serves must be in every renewal, or nobody keeps its lease row alive.
    gate.asked.length = 0;
    const next = registry.heartbeatLeases();
    gate.answer(gate.asked[0] ?? []);
    await next;
    assert.deepEqual(
      gate.asked[0],
      ['room_beat0003', 'room_beat0004'],
      'a room being served was left out of the renewal, so another process may take it mid-hand',
    );
    await registry.shutdown();
  });
});

describe('a renewal that fails outright', () => {
  /**
   * A renewal without a room is a statement about ownership. A renewal that throws is not, and
   * treating it as a fencing would close every live table on one dropped connection.
   */
  it('keeps serving the room while the failure is younger than the step-down threshold', async () => {
    const { registry, ownership, metrics } = probe();
    await registry.open({ record: record('room_blip0001') });
    ownership.throwOnHeartbeat = new Error('connection terminated unexpectedly');

    for (let beat = 0; beat < 3; beat += 1) {
      await registry.heartbeatLeases();
    }
    assert.ok(registry.get('room_blip0001') !== null, 'a transient database failure must not cost a table');
    assert.equal(metrics.roomFencings.get({ reason: 'lease_expired' }), 0);

    ownership.throwOnHeartbeat = null;
    await registry.heartbeatLeases();
    assert.ok(registry.get('room_blip0001') !== null);
    await registry.shutdown();
  });

  it('gives the room up once the last confirmed renewal is older than the threshold', async () => {
    const { registry, ownership, metrics, problems, evictions, clock } = probe();
    await registry.open({ record: record('room_stale001') });
    ownership.throwOnHeartbeat = new Error('the database did not answer within 7000 ms');

    clock.advance(LEASE_SELF_EVICT_AFTER_MS - 1);
    await registry.heartbeatLeases();
    assert.ok(
      registry.get('room_stale001') !== null,
      'one millisecond short of the threshold is not past it',
    );

    clock.advance(1);
    await registry.heartbeatLeases();

    assert.equal(registry.size, 0);
    assert.deepEqual(evictions, [{ roomId: 'room_stale001', reason: 'lease_expired' }]);
    assert.equal(metrics.roomFencings.get({ reason: 'lease_expired' }), 1);
    assert.equal(
      metrics.roomFencings.get({ reason: 'fenced' }),
      0,
      'the two reasons are different incidents',
    );
    const problem = problems.find((entry) => entry.detail.event === 'room-fenced');
    // Carried on the eviction, not logged per beat, so an incident does not flood the log.
    assert.match(String(problem?.detail['error']), /did not answer/);
    // The row may still be ours, so the release makes the room openable at once rather than after the TTL.
    assert.deepEqual(ownership.released, ['room_stale001']);
  });
});

describe('giving the lease back', () => {
  it('releases when a room is closed', async () => {
    const { registry, ownership } = probe();
    await registry.open({ record: record('room_close001') });
    registry.close('room_close001');
    await registry.shutdown();
    assert.deepEqual(ownership.released, ['room_close001']);
  });

  it('waits for every release before a shutdown resolves', async () => {
    // Without a release on exit, every room stays leased to a dead process for a whole TTL.
    const { registry, ownership } = probe();
    await registry.open({ record: record('room_shut0001') });
    await registry.open({ record: record('room_shut0002') });
    await registry.shutdown();
    assert.deepEqual([...ownership.released].sort(), ['room_shut0001', 'room_shut0002']);
    assert.equal(registry.size, 0);
  });

  /**
   * The lease is taken before the room is published, so `closeAll` cannot see a build in flight.
   * A shutdown in that gap must still release the lease row, or the replacement is refused the room
   * for `LEASE_TTL_MS`, and must not publish into a registry that has shut down.
   */
  it('waits for a room still being opened, and gives its lease back too (NEGATIVE CONTROL)', async () => {
    const ownership = fakeOwnership();
    let reads = 0;
    let answerRead: ((handNumber: number) => void) | null = null;
    const registry = new RoomRegistry({
      ownership,
      metrics: new AppMetrics(),
      clock: createManualClock(),
      random: createSecureRandom(),
      archive: {
        // The build stops past `acquireLease` and before `this.rooms.set`.
        nextHandNumber: () => {
          reads += 1;
          return new Promise<number>((resolve) => {
            answerRead = resolve;
          });
        },
        lastDealtHand: () => Promise.resolve(null),
        abandonInterruptedHands: () => Promise.resolve([]),
        handStarted: () => Promise.resolve(),
        actionsApplied: () => Promise.resolve(),
        streetAdvanced: () => Promise.resolve(),
        handCompleted: () => Promise.resolve(),
        stacksSettled: () => Promise.resolve(),
        roomStatusChanged: () => Promise.resolve(),
      },
      onProblem: () => undefined,
    });

    const opening = registry.open({ record: record('room_drain001') });
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
    assert.equal(reads, 1, 'the build is past the lease and blocked on a durable read');
    assert.equal(registry.leaseFor('room_drain001')?.fence, 1, 'and it is holding the lease');
    assert.equal(registry.size, 0, 'while the room itself is not published yet');

    const answered = new Promise<void>((resolve) => {
      setTimeout(() => {
        (answerRead as unknown as ((handNumber: number) => void) | null)?.(1);
        resolve();
      }, 10);
    });
    await registry.shutdown();
    await answered;
    const room = await opening;

    assert.deepEqual(
      ownership.released,
      ['room_drain001'],
      'the process exited still holding the lease, so the replacement refuses that room for a TTL',
    );
    assert.equal(room.record.closed, true, 'a table published after the shutdown is one nobody can close');
    assert.equal(registry.size, 0);
  });

  /**
   * `shutdown()` must never reject, even when a hook throws inside `releaseLeaseSoon`'s catch. Only a
   * failing release and a failing logger together exercise it.
   */
  it('does not let a throwing logger reject a shutdown (NEGATIVE CONTROL)', async () => {
    const ownership = fakeOwnership();
    let opened = false;
    const registry = new RoomRegistry({
      ownership: { ...ownership, release: () => Promise.reject(new Error('connection terminated')) },
      metrics: new AppMetrics(),
      clock: createManualClock(),
      random: createSecureRandom(),
      onProblem: () => {
        if (opened) throw new Error('the log serialiser threw');
      },
    });
    await registry.open({ record: record('room_logrej001') });
    opened = true;
    await assert.doesNotReject(() => registry.shutdown());
  });

  /**
   * `evict` must guard `onProblem`: the heartbeat is fire-and-forget, so a throw there is an
   * unhandled rejection that kills the process, and it would skip the `lease_expired` release.
   */
  it('does not let a throwing logger escape a fencing (NEGATIVE CONTROL)', async () => {
    const ownership = fakeOwnership();
    let opened = false;
    const registry = new RoomRegistry({
      ownership,
      metrics: new AppMetrics(),
      clock: createManualClock(),
      random: createSecureRandom(),
      onProblem: () => {
        if (opened) throw new Error('the log serialiser threw');
      },
    });
    await registry.open({ record: record('room_logrej002') });
    opened = true;
    ownership.fenced.add('room_logrej002');
    await assert.doesNotReject(() => registry.heartbeatLeases());
    assert.equal(registry.get('room_logrej002'), null, 'and the eviction still happened');
  });

  it('does not fail a shutdown when a release cannot be written', async () => {
    const { registry, ownership, problems } = probe();
    await registry.open({ record: record('room_shut0003') });
    const failing: RoomOwnership = {
      ...ownership,
      release: () => Promise.reject(new Error('connection terminated unexpectedly')),
    };
    const stubborn = new RoomRegistry({
      ownership: failing,
      metrics: new AppMetrics(),
      clock: createManualClock(),
      random: createSecureRandom(),
      onProblem: (message, detail) => problems.push({ message, detail }),
    });
    await stubborn.open({ record: record('room_shut0004') });
    await stubborn.shutdown();
    const problem = problems.find((entry) => entry.detail.event === 'room-lease-release');
    assert.ok(problem !== undefined, 'a lease that could not be given back must reach the log');
    await registry.shutdown();
  });
});

/**
 * Models one lease row per room with the same scoping as `repositories/room-ownership.ts`, and can
 * hold a release open. `fakeOwnership` deletes nothing, so it cannot delete the wrong thing.
 */
function rowBackedOwnership(ownerId = 'api_test_1_aaaaaaaa'): {
  readonly ownership: RoomOwnership;
  readonly rows: Map<string, { ownerId: string; fence: number }>;
  readonly hold: () => void;
  readonly drain: () => void;
  readonly setThrow: (error: Error | null) => void;
} {
  const rows = new Map<string, { ownerId: string; fence: number }>();
  let throwOnHeartbeat: Error | null = null;
  let held = false;
  const pending: (() => void)[] = [];
  const ownership: RoomOwnership = {
    ownerId,
    acquire: (roomId): Promise<RoomLease | null> => {
      const row = rows.get(roomId);
      if (row === undefined) {
        rows.set(roomId, { ownerId, fence: 1 });
        return Promise.resolve({ roomId, fence: 1, acquiredAt: new Date() });
      }
      if (row.ownerId !== ownerId) return Promise.resolve(null);
      row.fence += 1;
      return Promise.resolve({ roomId, fence: row.fence, acquiredAt: new Date() });
    },
    heartbeat: (roomIds): Promise<readonly string[]> =>
      throwOnHeartbeat !== null
        ? Promise.reject(throwOnHeartbeat)
        : Promise.resolve(roomIds.filter((id) => rows.get(id)?.ownerId === ownerId)),
    release: (roomId, fence): Promise<boolean> =>
      new Promise((resolve) => {
        // A caller that stopped passing a generation must fail here, not compare against `undefined`.
        assert.equal(typeof fence, 'number', 'a release must name the generation it gives back');
        const run = (): void => {
          const row = rows.get(roomId);
          if (row !== undefined && row.ownerId === ownerId && row.fence === fence) {
            rows.delete(roomId);
            resolve(true);
            return;
          }
          resolve(false);
        };
        if (held) pending.push(run);
        else run();
      }),
    holderOf: () => Promise.resolve(null),
  };
  return {
    ownership,
    rows,
    hold: () => {
      held = true;
    },
    drain: () => {
      held = false;
      for (const run of pending.splice(0)) run();
    },
    setThrow: (error) => {
      throwOnHeartbeat = error;
    },
  };
}

/**
 * Releases run on one serial chain, so a stale release can land after the room was taken again.
 * Without `and fence = ...` it deletes the fresh lease row and the next beat evicts the room as
 * fenced, a false zero-tolerance `prl_api_room_fencings_total{reason="fenced"}`.
 */
describe('a release queued before the room was given up and taken again', () => {
  it('does not delete the lease the re-open just took (NEGATIVE CONTROL)', async () => {
    const fake = rowBackedOwnership();
    const metrics = new AppMetrics();
    const clock = createManualClock();
    const evictions: { roomId: string; reason: string }[] = [];
    const registry = new RoomRegistry({
      clock,
      metrics,
      random: createSecureRandom(),
      ownership: fake.ownership,
    });
    registry.onEviction((roomId, reason) => evictions.push({ roomId, reason }));

    await registry.open({ record: record('room_reopen01') });
    assert.equal(registry.leaseFor('room_reopen01')?.fence, 1);

    // Every beat is abandoned, and past the step-down threshold the room is given up and its release queued.
    fake.hold();
    fake.setThrow(new Error('the database is unreachable'));
    await registry.heartbeatLeases();
    clock.advance(LEASE_SELF_EVICT_AFTER_MS);
    await registry.heartbeatLeases();
    assert.deepEqual(evictions, [{ roomId: 'room_reopen01', reason: 'lease_expired' }]);

    fake.setThrow(null);
    await registry.open({ record: record('room_reopen01') });
    assert.equal(registry.leaseFor('room_reopen01')?.fence, 2, 'the re-open must be a new generation');

    fake.drain();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      fake.rows.has('room_reopen01'),
      'a release from the previous generation deleted the lease the re-open had just taken',
    );

    await registry.heartbeatLeases();
    assert.equal(
      evictions.filter((entry) => entry.reason === 'fenced').length,
      0,
      `the room was fenced by this process's own stale release: ${JSON.stringify(evictions)}`,
    );
    assert.ok(registry.get('room_reopen01') !== null, 'the table was closed under the learner');
    await registry.shutdown();
  });
});

describe('the renewal timer', () => {
  it('beats on the interval and stops when the last room goes', async () => {
    const { registry, ownership, clock } = probe();
    await registry.open({ record: record('room_timer001') });
    assert.equal(ownership.heartbeats, 0, 'nothing is renewed before the first interval elapses');

    clock.advance(LEASE_HEARTBEAT_INTERVAL_MS);
    // Draining microtasks completes the beat and re-arms the timer.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ownership.heartbeats, 1);

    await registry.shutdown();
    assert.equal(clock.pending, 0, 'a shut-down registry must not leave a timer behind');
  });
});
