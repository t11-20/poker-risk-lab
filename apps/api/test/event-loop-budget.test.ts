/**
 * Hand Review and Coach-over-socket must keep returning to the event loop while they run. They may
 * be slow, but not uninterruptible. Inline they stalled the loop 156 ms per review and 3,034 ms for
 * a cold socket Coach. Each budget test has a negative control that runs the same work in process
 * and asserts the probe fires. The primary detector is a `setInterval` gap, because
 * `monitorEventLoopDelay` read 0.0 ms for a 180 ms stall. No database, and no throughput claims.
 */

import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { after, describe, it } from 'node:test';
import { setImmediate as yieldToTheLoop } from 'node:timers/promises';
import type { CoachReport } from '@prl/contracts';
import { createSecureRandom, type PlayerView } from '@prl/poker-engine';
import { buildCoachReport, coachInputFor, coachSpotForView, LIVE_COACH_POLICY } from '@prl/poker-math';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { buildHandReview, buildHandReviewOn } from '../src/review/build-review.ts';
import { RoomRegistry } from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { WorkerPool } from '../src/workers/pool.ts';
import { compileFrameValidator } from '../src/ws/hub.ts';
import { type CoachAnalyser, type SocketSink, WsRouter } from '../src/ws/router.ts';
import { persistHand } from './helpers/hand-rows.ts';
import { seatingOnlyStore } from './helpers/live-room.ts';

/**
 * The pooled paths stall 1.2 ms (review) and 1.5 ms (socket Coach), and the smallest real violation
 * is 133 ms. It matches `scripts/load-test.mjs --event-loop-p99-ms`.
 */
const LOOP_BUDGET_MS = 50;

/** At 5 ms a 200 ms idle window gives 39 ticks and a worst gap of 0.3 ms. */
const TICK_MS = 5;

interface LoopProbe {
  /** Worst gap between consecutive ticks, less the interval that was asked for. */
  readonly worstStallMs: number;
  /** Zero means it measured nothing. */
  readonly ticks: number;
  readonly histogramMaxMs: number;
}

/**
 * The window closes with a yield, because a stall is only observable once the loop turns again.
 * Disabling the probe in the same tick reports `0.0 ms` for a 180 ms block.
 */
async function whileWatchingTheLoop<T>(work: () => Promise<T> | T): Promise<{
  readonly result: T;
  readonly probe: LoopProbe;
}> {
  const gaps: number[] = [];
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  histogram.enable();
  let previous = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    gaps.push(now - previous);
    previous = now;
  }, TICK_MS);
  try {
    await yieldToTheLoop();
    const result = await work();
    await yieldToTheLoop();
    return {
      result,
      probe: {
        worstStallMs: gaps.length === 0 ? 0 : Math.max(...gaps) - TICK_MS,
        ticks: gaps.length,
        histogramMaxMs: histogram.max / 1e6,
      },
    };
  } finally {
    clearInterval(ticker);
    histogram.disable();
  }
}

function assertLoopStayedFree(what: string, probe: LoopProbe): void {
  // A window with no ticks measured nothing and must not pass.
  assert.ok(
    probe.ticks > 0,
    `${what}: the loop probe never ran, so this measured nothing (ticks=${probe.ticks})`,
  );
  assert.ok(
    probe.worstStallMs <= LOOP_BUDGET_MS,
    `${what}: the event loop stalled ${probe.worstStallMs.toFixed(1)}ms, over the ${LOOP_BUDGET_MS}ms ` +
      `budget (${probe.ticks} ticks, histogram max ${probe.histogramMaxMs.toFixed(1)}ms)`,
  );
  assert.ok(
    probe.histogramMaxMs <= LOOP_BUDGET_MS,
    `${what}: monitorEventLoopDelay reported ${probe.histogramMaxMs.toFixed(1)}ms, over the ` +
      `${LOOP_BUDGET_MS}ms budget`,
  );
}

function assertProbeFires(what: string, probe: LoopProbe): void {
  assert.ok(probe.ticks > 0, `${what}: the loop probe never ran, so it proves nothing`);
  assert.ok(
    probe.worstStallMs > LOOP_BUDGET_MS,
    `${what}: the in-process analysis stalled the loop only ${probe.worstStallMs.toFixed(1)}ms, ` +
      `which is inside the ${LOOP_BUDGET_MS}ms budget — this control no longer feeds the detector a ` +
      'real violation, so the budget tests above prove nothing',
  );
}

/**
 * A pool of this file's own because `getSharedPool` needs an `AppConfig`, which is absent in
 * `test:without-database`. 30 s because the first live Coach task builds the preflop strength
 * ordering in the thread, about three seconds.
 */
const pool = new WorkerPool({ size: 2, timeoutMs: 30_000 });

after(async () => {
  await pool.close();
});

const HERO = 'usr_hero00000000000000000';
const VILLAIN = 'usr_villain00000000000000';
const FOLDER = 'usr_folder0000000000000aa';

/** Hero acts on all four streets. The flop report is the expensive one (133 ms in process). */
function reviewableHand(): ReturnType<typeof persistHand> {
  return persistHand({
    handId: 'hand_loopbudget000000000a',
    roomId: 'room_loopbudget000000000a',
    seats: [
      { seat: 0, userId: FOLDER, displayName: 'Folder', stack: 200 },
      { seat: 1, userId: HERO, displayName: 'Hero', stack: 200 },
      { seat: 2, userId: VILLAIN, displayName: 'Villain', stack: 200, isBot: true },
    ],
    holeCards: { 0: '7c2d', 1: 'AhKs', 2: 'QdQc' },
    board: 'Qh 7h 2c 4d 9s',
    steps: [
      { seat: 0, action: { type: 'fold' } },
      { seat: 1, action: { type: 'call' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
      { seat: 1, action: { type: 'check' } },
      { seat: 2, action: { type: 'check' } },
    ],
  });
}

function reviewInput(fixture: ReturnType<typeof persistHand>): Parameters<typeof buildHandReview>[0] {
  return {
    hand: fixture.hand,
    seats: fixture.seats,
    actions: fixture.actions,
    viewerUserId: HERO,
    maxPotAfter: fixture.hand.max_pot_after,
  };
}

/**
 * Computed on this thread as the in-process reference. Without `names` it labels opponents
 * `seat N` and differs from the socket's report.
 */
function coachHere(view: PlayerView, names?: ReadonlyMap<number, string>): CoachReport {
  const reading = coachSpotForView(
    view,
    LIVE_COACH_POLICY,
    names === undefined ? undefined : (seat) => names.get(seat),
  );
  assert.ok(reading.kind === 'spot', `no decision in this view: ${JSON.stringify(reading)}`);
  return buildCoachReport(coachInputFor(reading.spot));
}

function analysedCount(review: { readonly decisions: readonly { readonly analysis: unknown }[] }): number {
  return review.decisions.filter((decision) => decision.analysis !== null).length;
}

describe('a hand review does not block the event loop', () => {
  it('builds every analysis on a calculator thread', async () => {
    const fixture = reviewableHand();
    const { result, probe } = await whileWatchingTheLoop(() =>
      buildHandReviewOn(reviewInput(fixture), {}, (task) => pool.runCoach(task, 30_000)),
    );

    // A review that analysed nothing would also stall nothing.
    assert.equal(analysedCount(result), 4, 'the viewer had four analysable decisions');
    assertLoopStayedFree('a pooled hand review', probe);
  });

  it('NEGATIVE CONTROL: the same review computed in this process blows the budget', async () => {
    const fixture = reviewableHand();
    const { result, probe } = await whileWatchingTheLoop(() => buildHandReview(reviewInput(fixture), {}));

    assert.equal(analysedCount(result), 4, 'the control has to do the same work to be a control');
    assertProbeFires('an in-process hand review', probe);
  });

  it('produces exactly the report the in-process reference produces', async () => {
    const fixture = reviewableHand();
    // `analyse` and `equity-worker.ts` expand the range separately, so any drift in a seed, sample
    // count, label or blockers changes a number a learner sees.
    const pooled = await buildHandReviewOn(reviewInput(fixture), {}, (task) => pool.runCoach(task, 30_000));
    const local = buildHandReview(reviewInput(fixture), {});
    assert.deepEqual(pooled, local);
  });
});

const ALLOWED_ORIGIN = 'http://localhost:3000';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

interface Recorder {
  readonly sink: SocketSink;
  readonly frames: string[];
}

function recorder(): Recorder {
  const frames: string[] = [];
  return {
    frames,
    sink: {
      send: (text) => frames.push(text),
      close: () => undefined,
    },
  };
}

function framesOf(recorded: Recorder, type: string): Record<string, unknown>[] {
  const matching: Record<string, unknown>[] = [];
  for (const text of recorded.frames) {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && Reflect.get(value, 'type') === type) {
      matching.push(value as Record<string, unknown>);
    }
  }
  return matching;
}

/** Polls rather than sleeps, and names what did arrive on timeout. */
async function waitForFrame(
  recorded: Recorder,
  type: string,
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const found = framesOf(recorded, type).at(-1);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const seen = [...new Set(recorded.frames.map((text) => String(JSON.parse(text).type)))];
  throw new Error(`no "${type}" frame arrived within ${timeoutMs}ms; saw ${seen.join(', ')}`);
}

interface SocketHarness {
  readonly app: FastifyInstance;
  readonly router: WsRouter;
  readonly registry: RoomRegistry;
  readonly roomId: string;
}

async function socketHarness(options: { readonly analyseCoach?: CoachAnalyser }): Promise<SocketHarness> {
  const app = await buildApp({ config: testConfig(), database: stubDatabase });
  app.get(
    '/api/v1/test-frame-schema',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async () => ({ ok: true }),
  );
  await app.ready();

  const clock = createManualClock();
  const registry = new RoomRegistry({
    clock,
    random: createSecureRandom(),
    store: seatingOnlyStore(),
    nextHandId: () => 'hand_loopbudgetws0000000a',
  });
  const roomId = 'room_loopbudgetws000000aa';
  const room = await registry.open({
    record: {
      id: roomId,
      name: 'Budget table',
      ownerUserId: 'usr_a',
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
      startingStack: 1_000,
      createdAt: '2026-08-17T12:00:00.000Z',
      closed: false,
    },
    members: [
      { userId: 'usr_a', displayName: 'Ada', isBot: false, botProfile: null },
      { userId: 'usr_b', displayName: 'Bo', isBot: false, botProfile: null },
    ],
  });
  await room.table.sit({ userId: 'usr_a', displayName: 'Ada', seat: 0, stack: 1_000 });
  await room.table.sit({ userId: 'usr_b', displayName: 'Bo', seat: 1, stack: 1_000 });

  const router = new WsRouter({
    registry,
    clock,
    validate: compileFrameValidator(app),
    config: app.appConfig,
    nextRequestId: () => 'req-fixed',
    ...(options.analyseCoach === undefined ? {} : { analyseCoach: options.analyseCoach }),
  });
  return { app, router, registry, roomId };
}

function connect(
  harness: SocketHarness,
  userId: string,
): { readonly recorded: Recorder; readonly connection: ReturnType<WsRouter['open']> } {
  const recorded = recorder();
  const connection = harness.router.open(recorded.sink, {
    userId,
    displayName: userId,
    sessionId: `ses_${userId}`,
  });
  harness.router.handleFrame(
    connection,
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      roomId: harness.roomId,
      clientNonce: `nonce-${userId}`,
    }),
  );
  return { recorded, connection };
}

async function dealAndFindTheActor(harness: SocketHarness): Promise<{
  readonly actor: ReturnType<typeof connect>;
  readonly other: ReturnType<typeof connect>;
}> {
  const alpha = connect(harness, 'usr_a');
  const beta = connect(harness, 'usr_b');
  harness.router.handleFrame(alpha.connection, JSON.stringify({ type: 'startHand', requestId: 'req-deal' }));
  await waitForFrame(alpha.recorded, 'state');
  const state = framesOf(alpha.recorded, 'state').at(-1);
  assert.ok(state !== undefined, 'the table must have dealt a hand');
  const view = state['view'] as { toAct: number | null; viewerSeat: number | null };
  const alphaActs = view.toAct === view.viewerSeat;
  return alphaActs ? { actor: alpha, other: beta } : { actor: beta, other: alpha };
}

function requestCoach(
  harness: SocketHarness,
  who: ReturnType<typeof connect>,
  requestId: string,
  opponentRange?: string,
): void {
  harness.router.handleFrame(
    who.connection,
    JSON.stringify({
      type: 'requestCoach',
      requestId,
      ...(opponentRange === undefined ? {} : { opponentRange }),
    }),
  );
}

describe('the Coach over a socket does not block the event loop', () => {
  it('answers from a calculator thread, cold strength table and all', async () => {
    const harness = await socketHarness({ analyseCoach: (task) => pool.runCoach(task, 30_000) });
    try {
      const { actor } = await dealAndFindTheActor(harness);
      const { result, probe } = await whileWatchingTheLoop(async () => {
        requestCoach(harness, actor, 'req-coach-pooled');
        return await waitForFrame(actor.recorded, 'coach');
      });

      const report = result['report'] as CoachReport;
      assert.equal(result['requestId'], 'req-coach-pooled');
      assert.ok(report.assumptions.length > 0, 'a number without its assumptions is a guess');
      assert.ok(report.candidates.length > 0, 'the analysis has to have produced something');
      assertLoopStayedFree('a pooled socket Coach', probe);
    } finally {
      await harness.app.close();
    }
  });

  it('NEGATIVE CONTROL: the same analysis computed in this process blows the budget', async () => {
    const harness = await socketHarness({});
    try {
      const { actor } = await dealAndFindTheActor(harness);
      const room = harness.registry.get(harness.roomId);
      assert.ok(room !== null);
      const view = room.table.viewFor(actor.connection.principal.userId);
      assert.ok(view !== null, 'the seat that is to act must have a view');

      // Most of the stall is the cold preflop strength table `top:40` needs (3,269 ms first call,
      // 2.2 ms after). This is only a control while it is the first main-thread expansion in the
      // file. If an edit warms it first, move this test above that edit.
      const { result, probe } = await whileWatchingTheLoop(() => coachHere(view));
      assert.ok(result.candidates.length > 0, 'the control has to do the same work to be a control');
      assertProbeFires('an in-process socket Coach', probe);
    } finally {
      await harness.app.close();
    }
  });

  it('gives the same report the in-process reference gives', async () => {
    const harness = await socketHarness({ analyseCoach: (task) => pool.runCoach(task, 30_000) });
    try {
      const { actor } = await dealAndFindTheActor(harness);
      const room = harness.registry.get(harness.roomId);
      assert.ok(room !== null);
      const view = room.table.viewFor(actor.connection.principal.userId);
      assert.ok(view !== null);

      requestCoach(harness, actor, 'req-coach-parity');
      const frame = await waitForFrame(actor.recorded, 'coach');
      const fromThread = frame['report'] as CoachReport;
      const local = coachHere(view, room.table.dealtNames());
      assert.deepEqual(fromThread, local);
      // Equal to a named reference is not enough, because both could have dropped the names.
      const labels = fromThread.equity.perPlayer.map((player) => player.label);
      assert.ok(labels.length >= 2, `a sweep of nothing is not a pass: ${JSON.stringify(labels)}`);
      assert.equal(labels[0], 'you');
      for (const label of labels.slice(1)) assert.match(label, /^(Ada|Bo)$/u, 'an opponent is named');
    } finally {
      await harness.app.close();
    }
  });

  it('never publishes an action the seat could not take', async () => {
    const harness = await socketHarness({ analyseCoach: (task) => pool.runCoach(task, 30_000) });
    try {
      const { actor } = await dealAndFindTheActor(harness);
      const room = harness.registry.get(harness.roomId);
      assert.ok(room !== null);
      const view = room.table.viewFor(actor.connection.principal.userId);
      assert.ok(view !== null);
      const offered = new Set(view.legalActions.map((entry) => entry.type));
      assert.ok(offered.size > 0, 'the seat to act is offered something');

      requestCoach(harness, actor, 'req-coach-legal', '22+');
      const frame = await waitForFrame(actor.recorded, 'coach');
      const report = frame['report'] as CoachReport;
      // `WorkerPool.runCoach` applies `assertReportStaysInsideItsLegalSet` to every reply.
      for (const candidate of report.candidates) {
        assert.ok(offered.has(candidate.action), `the Coach published ${candidate.action}`);
      }
      assert.ok(offered.has(report.suggestion.action));
    } finally {
      await harness.app.close();
    }
  });
});

describe('a socket Coach request that cannot be served says so', () => {
  it('turns a full queue into a service_unavailable frame, not a dropped message', async () => {
    // One thread, one queue slot. A refusal must reach the socket, not be dropped.
    const tinyPool = new WorkerPool({ size: 1, timeoutMs: 30_000, queueLimit: 1 });
    const harness = await socketHarness({ analyseCoach: (task) => tinyPool.runCoach(task, 30_000) });
    try {
      const { actor } = await dealAndFindTheActor(harness);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        requestCoach(harness, actor, `req-coach-flood-${attempt}`, '22+');
      }
      const error = await waitForFrame(actor.recorded, 'error');
      const body = error['error'] as { code: string; message: string };
      assert.equal(body.code, 'service_unavailable');
      assert.ok(body.message.length > 0, 'the client is told the contract wording, never a detail');
    } finally {
      await harness.app.close();
      await tinyPool.close();
    }
  });

  it('turns a missed deadline into a computation_timeout frame', async () => {
    // The deadline is armed at submission, so it expires before any thread can answer.
    const impatientPool = new WorkerPool({ size: 1, timeoutMs: 1 });
    const harness = await socketHarness({ analyseCoach: (task) => impatientPool.runCoach(task) });
    try {
      const { actor } = await dealAndFindTheActor(harness);
      requestCoach(harness, actor, 'req-coach-slow', '22+');
      const error = await waitForFrame(actor.recorded, 'error');
      const body = error['error'] as { code: string };
      assert.equal(body.code, 'computation_timeout');
      assert.equal(framesOf(actor.recorded, 'coach').length, 0, 'no report may follow a timeout');
    } finally {
      await harness.app.close();
      await impatientPool.close();
    }
  });

  it('drops the report when the socket closed while the analysis was in flight', async () => {
    let release: (report: CoachReport) => void = () => undefined;
    const held = new Promise<CoachReport>((resolve) => {
      release = resolve;
    });
    const harness = await socketHarness({ analyseCoach: () => held });
    try {
      const { actor } = await dealAndFindTheActor(harness);
      requestCoach(harness, actor, 'req-coach-abandoned', '22+');
      // An answer for a closed socket must be discarded.
      harness.router.handleClose(actor.connection);
      const framesAtClose = actor.recorded.frames.length;
      release({
        street: 'preflop',
        assumptions: ['a stand-in report, never sent'],
      } as unknown as CoachReport);
      await yieldToTheLoop();
      await yieldToTheLoop();

      assert.equal(framesOf(actor.recorded, 'coach').length, 0, 'no report may reach a closed socket');
      assert.equal(actor.recorded.frames.length, framesAtClose, 'nothing at all is written after close');
    } finally {
      await harness.app.close();
    }
  });

  it('refuses an Expert table before it queues anything', async () => {
    // The refusal must happen before a task exists. `analyseCoach` throws if it is ever reached.
    const harness = await socketHarness({
      analyseCoach: () => {
        throw new Error('an Expert table must not reach the calculator at all');
      },
    });
    try {
      const room = harness.registry.get(harness.roomId);
      assert.ok(room !== null);
      await room.table.stand('usr_b');
      await harness.registry.seatBot(
        harness.roomId,
        {
          userId: 'usr_bot',
          displayName: 'Legend',
          seat: 1,
          profileId: 'adaptive-exploiter',
          difficulty: 'expert',
          seed: 1,
        },
        'mem_usr_bot',
      );
      assert.equal(room.bots.coachDuringHand(), false);

      const alpha = connect(harness, 'usr_a');
      harness.router.handleFrame(
        alpha.connection,
        JSON.stringify({ type: 'startHand', requestId: 'req-deal-expert' }),
      );
      await waitForFrame(alpha.recorded, 'state');
      requestCoach(harness, alpha, 'req-coach-expert');
      const error = await waitForFrame(alpha.recorded, 'error');
      const body = error['error'] as { code: string };
      assert.equal(body.code, 'coach_not_available');
      assert.equal(framesOf(alpha.recorded, 'coach').length, 0);
    } finally {
      await harness.app.close();
    }
  });
});
