/**
 * The room lease, without a database: the numbers, the statements, and the registry's reactions.
 *
 * ## What this file is for, and what it deliberately is not
 *
 * `room-ownership-database.test.ts` is the one that matters most — it runs two registries with two
 * owner ids against one Postgres and asserts that the second one is refused, which is the whole
 * point of the mechanism and cannot be proved by anything smaller. This file is everything around
 * that which a fake can prove and a database run cannot prove *cheaply*: that the three timing
 * constants stand in the relation their comments claim, that the statements carry the owner scope,
 * and — the part with the most surface area — that the registry does the right thing with each of
 * the four answers a lease can give it.
 *
 * The fourth of those is worth naming because it is the one an integration test cannot reach on
 * demand: a heartbeat that THROWS says nothing about ownership, and treating it as a fencing would
 * close every live table in the process on a network blip. A fake is how you produce a heartbeat
 * that throws exactly three times and then succeeds.
 *
 * ## The property every case here is guarding
 *
 * A registry built with no ownership must behave exactly as this codebase did before the lease
 * existed. Every other test file in this package builds one that way — `test/rooms.test.ts` and
 * `test/ws-router.test.ts` drive the whole of rooms, seating, the socket protocol and the bots
 * against a `Map` — so a lease that quietly changed the no-ownership path would break the suite in
 * fifty places and, worse, would mean the single-replica deployment had changed behaviour. The
 * first describe block asserts it directly rather than leaving it to be inferred from the others
 * passing.
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

/**
 * A `RoomOwnership` a test drives by hand.
 *
 * Every method records what it was asked and answers from a script the case sets. It refuses
 * nothing implicitly: the default is "the lease is ours", because the overwhelming majority of the
 * assertions below are about what happens AFTER a successful acquisition.
 */
interface FakeOwnership extends RoomOwnership {
  /** Room ids this fake will refuse to lease. */
  readonly refuse: Set<string>;
  /** Room ids a renewal will report as no longer ours. */
  readonly fenced: Set<string>;
  /** Set to make the next `heartbeat` reject rather than answer. */
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
 * A `RoomOwnership` whose beat does not come back until the case says so.
 *
 * Separate from `fakeOwnership` because it is for the opposite question. That one answers
 * immediately, which is what every case about the four verdicts wants; this one holds the beat OPEN
 * so a case can do something to the registry while a renewal is in flight — which is the state the
 * request path is in for one round trip out of every heartbeat interval, and which no test that
 * resolves synchronously can reach at all.
 */
function heldHeartbeat(ownerId = 'api_test_1_aaaaaaaa'): {
  readonly ownership: RoomOwnership;
  /** Room id sets the beats were given, in order. */
  readonly asked: string[][];
  /** Answers the beat that is currently in flight. */
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

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

describe('the lease timings', () => {
  /**
   * The ordering the whole scheme rests on, asserted rather than left to two comments agreeing.
   *
   * `LEASE_SELF_EVICT_AFTER_MS < LEASE_TTL_MS` is the one that is not a safety margin: the takeover
   * test runs in Postgres against `heartbeat_at` and the self-eviction test runs here against local
   * wall time, so if the two thresholds were equal the moment another process became entitled to
   * the room would be the moment this one decided to stop — the same instant, on two clocks, which
   * is a coin toss. Stepping down strictly first means the overlap can only ever be a window in
   * which NOBODY serves the room, never one in which two processes do.
   *
   * This is the assertion that fails if somebody "tidies" the three constants to two.
   */
  it('steps down strictly before anybody else may take over', () => {
    assert.ok(
      LEASE_SELF_EVICT_AFTER_MS < LEASE_TTL_MS,
      `self-eviction at ${LEASE_SELF_EVICT_AFTER_MS} ms is not before takeover at ${LEASE_TTL_MS} ms, ` +
        'so two processes can believe they own one room at the same instant',
    );
  });

  /**
   * The ratio the design asks for in as many words: the heartbeat has to fit several times inside
   * the TTL, so that one failed beat — an ordinary event — never costs a live table.
   *
   * Four is the floor asserted rather than the six the constants actually give, so that tuning
   * within the argued range does not fail a test while abandoning the argument does.
   */
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
   * The TTL must exceed the longest pause that leaves a process alive and mid-hand, and the binding
   * one in this repository is not GC — it is `db.ts`'s request-path deadline, which is what bounds a
   * renewal issued into a frozen database (`--only postgres-outage` in the reliability drills
   * freezes exactly that). At the default `DATABASE_STATEMENT_TIMEOUT_MS` of 5,000 that deadline is
   * 7,000 ms, and the TTL has to leave room for more than one of them.
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
    // `room_ownership_owner_id_shape`: 8..128 characters, no surrounding whitespace.
    for (const id of [first, second]) {
      assert.ok(id.length >= 8 && id.length <= 128, `${id} is ${id.length} characters`);
      assert.equal(id, id.trim());
    }
    // Two processes on one host, or one process restarted, must not compare equal — an owner id a
    // restarted process could collide with would let it inherit the dead one's leases without
    // waiting out the TTL, which is the exact overlap the lease exists to refuse.
    assert.notEqual(first, second);
  });
});

// ---------------------------------------------------------------------------
// The statements, against a fake sql
// ---------------------------------------------------------------------------

/**
 * A `Sql` stand-in that records the statement text and its bound values.
 *
 * Same shape as `retention-sweep.test.ts`: repositories are tagged-template calls, so this is a
 * function with the template signature. It does not parse SQL. What it is for is the one property
 * that cannot be read off a passing integration test — that the owner id is IN the statement — and
 * the difference between a `delete ... where room_id = $1` and a
 * `delete ... where room_id = $1 and owner_id = $2` is a fenced process deleting the lease of the
 * process that legitimately took the room from it.
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
    // The generation, too. A release is queued and can arrive after the room has been given up and
    // taken again by this same process, and the owner scope cannot tell those two apart.
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
    // The two disjuncts ARE the policy: we may take it if it is already ours, or if the holder has
    // gone quiet for longer than the TTL. Anything else must not match a row.
    assert.match(statement.text, /on conflict/i);
    assert.match(statement.text, /lease\.owner_id\s*=/i);
    assert.match(statement.text, /lease\.heartbeat_at\s*<\s*now\(\)\s*-\s*make_interval/i);
    // The fence increments on the row rather than being supplied, so two acquisitions cannot
    // produce the same generation.
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

// ---------------------------------------------------------------------------
// The single-replica path is untouched
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Acquisition and refusal
// ---------------------------------------------------------------------------

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
    // Not `seat_taken` — that is two learners racing for a chair, which is ordinary and must never
    // page anybody — and not `internal_error`, because nothing broke: the guard worked.
    assert.equal(failure.code, 'room_owned_elsewhere');
    assert.equal(registry.size, 0, 'a refused room must not be left half-built in the registry');
    assert.equal(metrics.roomOwnershipRefusals.get(), 1);

    const problem = problems.find((entry) => entry.detail.event === 'room-lease-refused');
    assert.ok(problem !== undefined, 'a refusal that is not reported is a refusal nobody can diagnose');
    // The holder is in the LOG, never in the answer: an operator's first question is "which process,
    // and how stale", and the client is told a code and a request id like every other failure.
    assert.equal(problem.detail['holderId'], 'api_other_2_bbbbbbbb');
    assert.equal(problem.detail['holderHeartbeatAgeMs'], 1_200);
  });

  /**
   * A build that throws after the lease is taken must give the lease back.
   *
   * Otherwise the room is unopenable — by anybody, including this process on the very next request
   * — for a whole TTL, because a transient failure during one open would have left a lease behind
   * with nothing holding it.
   *
   * ## Honestly, about how this failure is provoked
   *
   * Everything in the build between the acquisition and `this.rooms.set` is either fail-soft by
   * design (both durable reads are wrapped, on the stated grounds that "a room that will not open
   * is worse than one that opens with a fresh rotation") or a constructor that does not throw. So
   * the reachable throw today is a problem HOOK that throws while the fail-soft path is reporting —
   * which is a real hazard, not a contrived one: the production hook calls `app.log.warn`, and a
   * logger with a serialiser that throws is how it happens. The registry guards against exactly the
   * same shape on the eviction path, where a listener that throws must not stop the eviction.
   *
   * The guard's larger job is the next `await` somebody adds to the build. This is the test that
   * makes that guard something other than decoration.
   */
  it('gives the lease back when the build fails after taking it', async () => {
    const ownership = fakeOwnership();
    const registry = new RoomRegistry({
      ownership,
      metrics: new AppMetrics(),
      clock: createManualClock(),
      random: createSecureRandom(),
      archive: {
        // The read is fail-soft, so this alone opens the room. What makes the build fail is the
        // hook it calls to report the failure.
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

// ---------------------------------------------------------------------------
// Fencing
// ---------------------------------------------------------------------------

describe('a renewal that comes back without our room', () => {
  /**
   * The negative control this whole mechanism exists for, in its cheapest form.
   *
   * Against the code before the lease, a registry went on serving a room for the life of the
   * process whatever any other process did. Here the renewal says the room is no longer ours and
   * the room has to be gone — from the map, from the table, and from the sockets — by the time the
   * beat resolves.
   */
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
    // `release` is owner-scoped so the delete would match nothing, but issuing it at all says this
    // process thinks it might still own the row — and a future unscoped release would then be a
    // fenced process deleting the winner's lease.
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
   * ##########################################################################
   * ## A BEAT IS A ROUND TRIP, AND `acquireLease` RUNS THROUGHOUT IT.       ##
   * ##########################################################################
   *
   * `heartbeatLeases` reads the rooms it holds, goes to the database, and then applies the answer.
   * The request path does not stop while it is out there: `open` → `buildRoom` → `acquireLease`
   * adds rooms to `this.leases` during the round trip, and those rooms were never in the ids the
   * statement carried, so they cannot be in its answer either. Applying the verdict to the CURRENT
   * map therefore read every one of them as fenced.
   *
   * Reproduced by holding a beat open across an `open()`, which is what these two cases do. It is
   * not an exotic interleaving — the window is one database round trip, every five seconds, on
   * every process that is opening rooms, and the two ways it lands are both bad:
   *
   *   * this case: a table a learner has just opened is closed under them, their sockets are
   *     closed, and `prl_api_room_fencings_total{reason="fenced"}` — zero-tolerance, with a runbook
   *     about two replicas — rises for an incident that did not happen;
   *   * the next case: it lands mid-build instead, and the room is published with no lease entry.
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
   * The half that corrupts a hand rather than merely ending one.
   *
   * `buildRoom` is several awaits long between `acquireLease` and `this.rooms.set`, so the eviction
   * can land while the room is still being built. It then deletes a lease entry for a room that is
   * not in `this.rooms` yet — closing nothing, notifying nobody — and the build publishes the room
   * a moment later with NO entry in `this.leases`.
   *
   * Nothing renews a room that is not in that map. Its `heartbeat_at` stops moving, this process
   * never self-evicts because it holds no lease to time out, and `LEASE_TTL_MS` later another
   * process is entitled to take a room this one is still dealing at — two decks, two pots, and
   * whichever `stacksSettled` lands second destroys the chips the other paid out. That is the
   * corruption the whole file exists to make impossible, reached through the guard.
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
        // The first open finishes; the second stops mid-build, between the lease and the publish.
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
    // Let the build get as far as its blocked read, which is past `acquireLease`.
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();

    gate.answer(['room_beat0003']);
    await beat;

    (releaseRead as unknown as ((handNumber: number) => void) | null)?.(1);
    const room = await opening;
    assert.equal(room.record.closed, false, 'the room was published and is being served');

    // The property that matters, asserted on the NEXT beat rather than on the map: a room this
    // process is serving must be in every renewal, or its lease is a row nobody is keeping alive.
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
   * The distinction the heartbeat turns on, and the reason a fake is the only way to test it.
   *
   * A renewal that comes back WITHOUT a room is a statement about ownership. A renewal that THROWS
   * is not: the database was unreachable, or the query was abandoned by `db.ts`'s deadline, and
   * nothing whatever is known about who owns what. Treating the second as a fencing would close
   * every live table in the process on one dropped connection — during a database blip, which is
   * exactly when a table full of people can least afford it.
   */
  it('keeps serving the room while the failure is younger than the step-down threshold', async () => {
    const { registry, ownership, metrics } = probe();
    await registry.open({ record: record('room_blip0001') });
    ownership.throwOnHeartbeat = new Error('connection terminated unexpectedly');

    // Three consecutive failures, well inside the threshold. The room is still ours.
    for (let beat = 0; beat < 3; beat += 1) {
      await registry.heartbeatLeases();
    }
    assert.ok(registry.get('room_blip0001') !== null, 'a transient database failure must not cost a table');
    assert.equal(metrics.roomFencings.get({ reason: 'lease_expired' }), 0);

    // And a beat that succeeds afterwards confirms it, rather than leaving it in limbo.
    ownership.throwOnHeartbeat = null;
    await registry.heartbeatLeases();
    assert.ok(registry.get('room_blip0001') !== null);
    await registry.shutdown();
  });

  /**
   * The other half, which is the safety property: past the step-down threshold this process stops
   * serving the room whatever the reason, because another process is about to become entitled to it
   * and this one can no longer prove anything.
   */
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
    // The error that cost the lease is carried on the eviction rather than logged on every failed
    // beat: a line per beat would fill the log during the incident somebody is trying to read.
    assert.match(String(problem?.detail['error']), /did not answer/);
    // The row may still be ours — we simply could not reach it — so the release is attempted, which
    // makes the room openable again at once rather than after the TTL if it lands.
    assert.deepEqual(ownership.released, ['room_stale001']);
  });
});

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------

describe('giving the lease back', () => {
  it('releases when a room is closed', async () => {
    const { registry, ownership } = probe();
    await registry.open({ record: record('room_close001') });
    registry.close('room_close001');
    await registry.shutdown();
    assert.deepEqual(ownership.released, ['room_close001']);
  });

  it('waits for every release before a shutdown resolves', async () => {
    // The difference between a seamless deploy and every live table refusing to open for a whole
    // lease TTL: a process that exits without releasing leaves its rooms leased to a process that
    // no longer exists.
    const { registry, ownership } = probe();
    await registry.open({ record: record('room_shut0001') });
    await registry.open({ record: record('room_shut0002') });
    await registry.shutdown();
    assert.deepEqual([...ownership.released].sort(), ['room_shut0001', 'room_shut0002']);
    assert.equal(registry.size, 0);
  });

  /**
   * The room that was still being OPENED when the SIGTERM arrived.
   *
   * `closeAll` can only close what is in `this.rooms`, and a build in flight is not: the lease is
   * taken first — a hard rule, because reconciling before acquiring would settle another process's
   * live hand — and the room is published several awaits later. A shutdown that landed in that gap
   * dropped the entry on the floor. Two things came of it, both reproduced against this class:
   *
   *   * the lease row was never deleted, so the replacement process was refused THAT room for a
   *     full `LEASE_TTL_MS` — thirty seconds of "that table will not open" on a deploy whose whole
   *     point was to hand the rooms over at once;
   *   * the build then published a `LiveRoom` — its table, its bots, its turn timer — into a
   *     registry that had already shut down, where nothing could reach it to close it. That is
   *     consequence 3 of the orphaned-room list in `open()`, reached from the other end.
   *
   * The window is one room open wide, which is exactly what a deploy interrupts: a rolling deploy
   * sends SIGTERM while requests are in flight, and opening a room is one of them.
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
        // The build stops here, past `acquireLease` and before `this.rooms.set`.
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

    // SIGTERM. The database answers the outstanding read a moment later, as it would.
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
   * The same hazard `buildRoom`'s test provokes — "the log serialiser threw" — on the two paths
   * where the report comes AFTER the thing that mattered has already happened.
   *
   * `shutdown()` documents "never rejects", and `releaseLeaseSoon`'s catch IS `releaseQueue`, the
   * chain `shutdown()` awaits. A hook that threw inside that catch put the rejection straight back
   * into the chain, so a failing release plus a failing logger made the Fastify `onClose` hook
   * reject — a deploy that fails on its way out, which is precisely what the swallow exists to
   * prevent. `assert.doesNotReject` against BOTH failures at once is the only shape that catches
   * it; either alone passes.
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
        // Only after the open, so the build itself is unaffected and this case is about the exit.
        if (opened) throw new Error('the log serialiser threw');
      },
    });
    await registry.open({ record: record('room_logrej001') });
    opened = true;
    await assert.doesNotReject(() => registry.shutdown());
  });

  /**
   * The worse half of the same omission.
   *
   * `evict` guards its eviction LISTENERS against throwing and did not guard `onProblem`, which is
   * called from the same method for the same reason. Production arms the heartbeat as
   * `void this.heartbeatLeases().finally(...)`, so a rejection out of it is an UNHANDLED rejection
   * — a dead API process under Node's default handling, caused by a logger fault, in the middle of
   * the incident the fencing was reporting. It also skipped the `lease_expired` release that
   * follows the report.
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

// ---------------------------------------------------------------------------
// A release that arrives after the room has been taken again
// ---------------------------------------------------------------------------

/**
 * A `RoomOwnership` that models the ROW rather than the answer.
 *
 * `fakeOwnership` above answers `release: true` unconditionally and keeps no state, which is right
 * for the cases it serves — they are about what the registry does with each verdict — and is
 * exactly why it cannot see the defect below: a fake whose release deletes nothing cannot delete
 * the wrong thing. This one keeps one row per room and applies the same scoping the four
 * statements in `repositories/room-ownership.ts` apply, and it can hold a release OPEN, which is
 * what a serial release chain draining behind a slow database looks like from in here.
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
        // Asserted rather than tolerated: the whole property under test is that the registry says
        // WHICH generation it is giving back, so a caller that stopped passing one has to fail here
        // rather than quietly satisfy a comparison against `undefined`.
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
 * The release is QUEUED, so it can land in a world that has moved on.
 *
 * `releaseLeaseSoon` puts every release on one serial chain and returns; the delete runs however
 * long every release ahead of it takes. The path that queues the most of them at once is also the
 * path that makes each one slowest: a database slow enough that every beat is abandoned at its
 * deadline evicts every room `lease_expired` and queues a release for each, and each of those runs
 * to its own 7,000 ms deadline before it fails. The database then recovers and the learners
 * reconnect long before the chain has drained.
 *
 * The stale release that arrives after that is owner-scoped and this process IS the owner, so
 * before the fence was added to the statement it deleted the row the re-open had just taken.
 * Measured on the sequence below, against the release with no `and fence = ...`:
 *
 *     rows after the chain drained   {}                      (the fresh lease was deleted)
 *     evictions                      lease_expired, FENCED   (a table closed under a learner)
 *
 * The second one is the damage. `prl_api_room_fencings_total{reason="fenced"}` is a zero-tolerance
 * series and it rose for an incident that had not happened — and between the delete and that beat
 * the room had no lease row at all while this process was dealing at it, so any other process was
 * entitled to take it. That is the two-processes-one-room state the whole table exists to refuse,
 * reached through the cleanup path.
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

    // The database goes slow. Every beat is abandoned, and once the last confirmed renewal is
    // older than the step-down threshold this process gives the room up and QUEUES the release.
    fake.hold();
    fake.setThrow(new Error('the database is unreachable'));
    await registry.heartbeatLeases();
    clock.advance(LEASE_SELF_EVICT_AFTER_MS);
    await registry.heartbeatLeases();
    assert.deepEqual(evictions, [{ roomId: 'room_reopen01', reason: 'lease_expired' }]);

    // It recovers, and the learner reconnects. The room is taken again, at a new generation.
    fake.setThrow(null);
    await registry.open({ record: record('room_reopen01') });
    assert.equal(registry.leaseFor('room_reopen01')?.fence, 2, 'the re-open must be a new generation');

    // Only NOW does the queued release reach the database.
    fake.drain();
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      fake.rows.has('room_reopen01'),
      'a release from the previous generation deleted the lease the re-open had just taken',
    );

    // The consequence, asserted separately because it is the one a learner sees: with the row
    // gone, the next beat finds nothing for a room this process is serving and evicts it.
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

// ---------------------------------------------------------------------------
// The renewal timer
// ---------------------------------------------------------------------------

describe('the renewal timer', () => {
  it('beats on the interval and stops when the last room goes', async () => {
    const { registry, ownership, clock } = probe();
    await registry.open({ record: record('room_timer001') });
    assert.equal(ownership.heartbeats, 0, 'nothing is renewed before the first interval elapses');

    clock.advance(LEASE_HEARTBEAT_INTERVAL_MS);
    // The tick starts an async beat; letting the microtask queue drain is what completes it and
    // re-arms the timer.
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ownership.heartbeats, 1);

    await registry.shutdown();
    assert.equal(clock.pending, 0, 'a shut-down registry must not leave a timer behind');
  });
});
