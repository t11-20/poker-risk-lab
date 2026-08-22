/**
 * The two heaviest paths in this API are not allowed to stop the event loop.
 *
 * ## What this file is
 *
 * A budget, in milliseconds, applied to the real Hand Review path and the real Coach-over-socket
 * path: while either is running, the process must keep getting back to its own event loop. Not
 * "should be fast" — a review is genuinely hundreds of milliseconds of Monte Carlo and this file
 * does not ask it to be less — but "must not be uninterruptible", which is a different property
 * and the only one that decides whether everybody else's turn clock keeps ticking.
 *
 * ## Why it exists, and what it would have caught
 *
 * Two measured P1 defects, both closed by routing the work through `workers/pool.ts`:
 *
 * 1. `GET /hands/:handId` built every Coach report inline. Measured on the reference machine
 *    (darwin arm64, 10 logical CPUs, Node 24): one three-handed showdown hand cost 156 ms of
 *    uninterruptible arithmetic, of which the flop report alone was 133 ms. `pnpm run test:load`
 *    at six concurrent players reported action p99 947.6 ms with Hand Review in the journey and
 *    29.2 ms with `--no-review` on the same warm process, and named the event loop as the
 *    saturated resource at every level.
 * 2. `requestCoach` over a socket called `coachForView` inline — a 2,000-sample Monte Carlo plus
 *    the preflop strength table its default `top:40` range needs. The same load run measured the
 *    first analysis in a fresh process at 3,033.9 ms with an event-loop p99 of 3,028.8 ms for
 *    that window: one socket asking for advice froze every table in the process for three
 *    seconds.
 *
 * Without this file both are one refactor away from coming back, and neither shows up as a
 * failing assertion anywhere else: every existing test of these paths asserts what the answer
 * says, and the answer was always correct. What was wrong was where it was computed.
 *
 * ## Would this fail if the behaviour broke? Yes, and that was checked by breaking it
 *
 * Each budget test is paired with a NEGATIVE CONTROL that runs the same analysis in this process
 * — through `buildHandReview` and `coachForView`, which are still the reference implementations —
 * and asserts the probe fires. So the detector is proved to detect on every run, on whatever
 * machine is running it, rather than on the author's machine once.
 *
 * It was also checked the harder way, by reverting the fix. `runAnalysisOn` was pointed back at the
 * in-process `analyse`, and `onCoach` back at `coachForView`, with this file left untouched. Real
 * numbers from that run, against the 50 ms budget:
 *
 *   - "builds every analysis on a calculator thread": stalled 180.8 ms (histogram max 184.9 ms);
 *   - "answers from a calculator thread": stalled 2,824.5 ms (histogram max 2,831.2 ms);
 *   - and four more failures, because the reverted path ignores the analyser altogether: the
 *     full-queue, deadline and closed-socket cases had nothing left to refuse or discard.
 *
 * Six of eleven tests failed. With the fix restored, the same two probes report 1.2 ms over 49
 * ticks and 1.5 ms over 577 ticks.
 *
 * ## HOW THE LOOP IS MEASURED, AND WHY IT IS NOT ONLY `monitorEventLoopDelay`
 *
 * `monitorEventLoopDelay` is enabled across every window and its histogram is asserted too, but it
 * is NOT the primary detector, because it cannot be relied on to record the very thing this file
 * is about. Measured directly, with a deliberate `while` loop and nothing else running:
 *
 *   | blocking stretch      | histogram max | timer-gap probe |
 *   | 20 ms                 | 20.1 ms       | 15.1 ms         |
 *   | 180 ms                |  0.0 ms       | 175.1 ms        |
 *   | 180 ms, resolution 10 |  0.0 ms       | 175.1 ms        |
 *
 * It does sometimes record — in the reverted run above it reported 184.9 ms and 2,831.2 ms — but a
 * detector that reads 0.0 ms for a 180 ms stall in a standalone probe cannot be the assertion: it
 * under-reports, and an under-reporting detector is a test that passes while the defect is present.
 * So the primary measure is a `setInterval` ticker and the worst gap between consecutive ticks,
 * which states the property under test directly — "how long did this process go without running a
 * callback it had asked for" — and which fired in every case above. The histogram is asserted as
 * well because it can only ever under-report, so it can add a failure and never a false one, and it
 * is the figure an operator sees in `prl_event_loop_delay_p99_seconds`.
 *
 * ## What this file does NOT do
 *
 * It does not measure throughput, latency or capacity — `pnpm run test:load` does that, against a
 * running server, and says so in its own header. It does not use a database: the review is built
 * from fixture rows and the socket from a fake room store, so it runs in `test:without-database`
 * as well. It does not assert that the analyses are FAST, only that they are interruptible. And
 * it says nothing about a machine with fewer cores than threads, where a busy pool would compete
 * with the main thread for CPU rather than running beside it.
 */

import assert from 'node:assert/strict';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { after, describe, it } from 'node:test';
import { setImmediate as yieldToTheLoop } from 'node:timers/promises';
import type { CoachReport } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { buildHandReview, buildHandReviewOn } from '../src/review/build-review.ts';
import { RoomRegistry } from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { WorkerPool } from '../src/workers/pool.ts';
import { compileFrameValidator } from '../src/ws/hub.ts';
import { type CoachAnalyser, coachForView, type SocketSink, WsRouter } from '../src/ws/router.ts';
import { persistHand } from './helpers/hand-rows.ts';
import { seatingOnlyStore } from './helpers/live-room.ts';

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

/**
 * How long the process may go without reaching its own event loop, in milliseconds.
 *
 * 50 ms, chosen from measurement rather than taste, and it has to sit inside a gap with a floor
 * and a ceiling:
 *
 *  - the FLOOR is what the fixed paths actually produce, measured by setting this constant to
 *    0.0001 and reading the failure messages: a pooled review stalls the loop 1.2 ms (histogram
 *    max 1.7 ms) and a pooled socket Coach 1.5 ms (histogram max 5.3 ms). The walk itself is
 *    0.2 ms; the rest is serialising a task and a report across the thread boundary. 50 ms is
 *    roughly thirty times the worst of those, which is the headroom a CI box shared with a
 *    compiler, a database and a garbage collector needs before this test starts failing for
 *    reasons that have nothing to do with poker.
 *  - the CEILING is the cheapest real violation. The smallest single stall either defect
 *    produced was one flop Coach report at 133 ms, and the largest was the 3,034 ms cold start of
 *    the socket Coach. 50 ms is comfortably under both, so a regression cannot hide beneath it.
 *
 * It is also the number `scripts/load-test.mjs` uses as its own event-loop saturation threshold
 * (`--event-loop-p99-ms`), so a run that passes here and a load run that blames the event loop are
 * measured against the same line.
 */
const LOOP_BUDGET_MS = 50;

/**
 * How often the probe asks to be run.
 *
 * 5 ms. Small enough that a stall of the size being hunted is caught by an order of magnitude,
 * large enough that the ticker itself is not the load: at 5 ms a 200 ms idle window produced 39
 * ticks and a worst gap of 0.3 ms, so the probe measures the process rather than itself.
 */
const TICK_MS = 5;

/** What one measured window saw. */
interface LoopProbe {
  /** Worst gap between consecutive ticks, less the interval that was asked for. */
  readonly worstStallMs: number;
  /** How many times the probe ran. Zero means it measured nothing and proves nothing. */
  readonly ticks: number;
  /** `monitorEventLoopDelay`'s own worst figure, for corroboration. See the header. */
  readonly histogramMaxMs: number;
}

/**
 * Runs `work` while watching the event loop.
 *
 * The ticker is started before the work and cleared after it, and the window is deliberately
 * closed with a yield: a stall is only observable once the loop turns again, so disabling the
 * probe in the same tick the work finished in would throw away the measurement of a stall that
 * had just happened. That is exactly the mistake that makes a naive version of this test report
 * `0.0 ms` for a 180 ms block.
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

/** The assertion both budget tests make, written once so the two cannot drift. */
function assertLoopStayedFree(what: string, probe: LoopProbe): void {
  // A window with no ticks measured nothing at all, and a detector that measured nothing must
  // never be allowed to read as a pass. This is the "did it actually scan anything" check.
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

/** The negative control's assertion: the detector fires when it is given a real stall. */
function assertProbeFires(what: string, probe: LoopProbe): void {
  assert.ok(probe.ticks > 0, `${what}: the loop probe never ran, so it proves nothing`);
  assert.ok(
    probe.worstStallMs > LOOP_BUDGET_MS,
    `${what}: the in-process analysis stalled the loop only ${probe.worstStallMs.toFixed(1)}ms, ` +
      `which is inside the ${LOOP_BUDGET_MS}ms budget — this control no longer feeds the detector a ` +
      'real violation, so the budget tests above prove nothing',
  );
}

// ---------------------------------------------------------------------------
// The calculator pool these tests use
// ---------------------------------------------------------------------------

/**
 * A pool of this file's own, rather than the process-wide one.
 *
 * `getSharedPool` needs an `AppConfig` and the router's default analyser reads the process-wide
 * configuration, which is absent in `test:without-database`. Constructing the pool directly keeps
 * this file runnable in both modes while exercising the identical call the production default
 * makes — `pool.runCoach(task, budget)` — against a real worker thread, a real bounded queue and
 * the real `assertReportStaysInsideItsLegalSet` on the way back.
 *
 * `timeoutMs` is 30 s rather than the configured 3 s because the first live Coach task in a
 * process builds the preflop strength ordering (about three seconds) inside the thread. That is
 * the same allowance `routes/calc.ts` and `ws/router.ts` make for a `top:NN` range, and it is the
 * cost this whole file exists to keep OFF the event loop rather than to eliminate.
 */
const pool = new WorkerPool({ size: 2, timeoutMs: 30_000 });

after(async () => {
  await pool.close();
});

// ---------------------------------------------------------------------------
// Hand review
// ---------------------------------------------------------------------------

const HERO = 'usr_hero00000000000000000';
const VILLAIN = 'usr_villain00000000000000';
const FOLDER = 'usr_folder0000000000000aa';

/**
 * Three seats, a fold, and hero acting on all four streets.
 *
 * Four analysable decisions for one viewer — preflop, flop, turn and river — which is what makes
 * this hand worth measuring: the flop report is the expensive one (133 ms in process, because the
 * outs breakdown re-runs an equity calculation per candidate card) and a hand with only a preflop
 * decision would not produce a stall large enough to be interesting.
 */
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

function analysedCount(review: { readonly decisions: readonly { readonly analysis: unknown }[] }): number {
  return review.decisions.filter((decision) => decision.analysis !== null).length;
}

describe('a hand review does not block the event loop', () => {
  it('builds every analysis on a calculator thread', async () => {
    const fixture = reviewableHand();
    const { result, probe } = await whileWatchingTheLoop(() =>
      buildHandReviewOn(reviewInput(fixture), {}, (task) => pool.runCoach(task, 30_000)),
    );

    // The review has to have actually done the work. A review that analysed nothing would stall
    // nothing either, and would pass the budget while proving the opposite of what is claimed.
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
    // Deep equality, not "looks similar". The whole argument for moving this work is that it
    // changes WHERE a figure is computed and nothing else, and the two constructions are genuinely
    // separate code — `analyse` expands the range here, `equity-worker.ts` expands it there. A
    // difference in a seed, a sample count, an opponent label or the blockers passed to
    // `parseRange` would change a number a learner is shown, and this is the assertion that would
    // notice.
    const pooled = await buildHandReviewOn(reviewInput(fixture), {}, (task) => pool.runCoach(task, 30_000));
    const local = buildHandReview(reviewInput(fixture), {});
    assert.deepEqual(pooled, local);
  });
});

// ---------------------------------------------------------------------------
// The Coach over a socket
// ---------------------------------------------------------------------------

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

/** Never queried: this file builds no rows and reads none. */
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

/**
 * Waits for a frame of a given type, or gives up.
 *
 * A socket Coach answer is asynchronous now — that is the fix — so a test cannot assert on it in
 * the same tick it asked for it. This polls the recorder rather than sleeping for a fixed period,
 * so the test takes as long as the analysis takes and no longer, and it fails with a message
 * naming what did arrive rather than an anonymous timeout.
 */
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

/**
 * A two-seat table with a hand in progress, and a router pointed at it.
 *
 * The same shape `test/ws-router.test.ts` uses — a fake room store, a manual clock, the app's own
 * compiled frame validator — because the point of this file is the real protocol on the real
 * router, with only the calculator swapped for one whose lifetime a test can control.
 */
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

/** Opens a socket, completes the handshake, and returns the recorder for it. */
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

/** Deals a hand and answers with whichever socket is to act. */
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

      // `coachForView` is what `requestCoach` used to call, with the production sample count and
      // the production default range. It is still exported, still correct, and still exactly as
      // blocking as it was — which is what makes it the honest control rather than a synthetic one.
      //
      // Its size comes from the COLD preflop strength table that `top:40` needs, which is the
      // larger half of the defect this file guards: measured on this machine, the first such call
      // in a process is 3,269 ms and every later one is 2.2 ms. So this test is only a control
      // while it is the first main-thread expansion in the file — which it is, because the pooled
      // tests above build that table inside a worker and the review tests use written-out notation.
      // If a future edit warms it first, this assertion fails with a message saying so rather than
      // passing quietly, and the fix is to move this test above whatever warmed it.
      const { result, probe } = await whileWatchingTheLoop(() => coachForView(view, { samples: 2_000 }));
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
      const local = coachForView(view, { samples: 2_000 });
      // Same view, same samples, same seed: the thread's answer must be the reference answer to
      // the digit. See the note on `coachForView`.
      assert.deepEqual(fromThread, local);
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
      // `WorkerPool.runCoach` applies `assertReportStaysInsideItsLegalSet` to every reply. Before
      // the socket used the pool, this path had no such check at all — the guard existed and the
      // one surface a player uses mid-hand never went through it.
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
    // One thread, one queue slot: the second and later requests cannot be admitted at all. A
    // refusal has to reach the socket — a client waiting forever for a frame that was silently
    // dropped is the failure mode a bounded queue is supposed to prevent, not cause.
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
    // A one-millisecond budget: the deadline is armed at submission, so it expires before any
    // thread can answer and the pool terminates the thread rather than waiting for it.
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
      // The socket goes while the analysis is still running, which is the ordinary case for a
      // player who closes the tab: the answer must be discarded rather than written to a dead sink.
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
    // The refusal has to happen on this thread, before a task exists: an analysis that was
    // computed and then thrown away would have cost a thread for a request the product does not
    // offer. `analyseCoach` throwing if it is ever reached is how that is proved rather than
    // assumed.
    const harness = await socketHarness({
      analyseCoach: () => {
        throw new Error('an Expert table must not reach the calculator at all');
      },
    });
    try {
      const room = harness.registry.get(harness.roomId);
      assert.ok(room !== null);
      await room.table.stand('usr_b');
      await harness.registry.seatBot(harness.roomId, {
        userId: 'usr_bot',
        displayName: 'Legend',
        seat: 1,
        profileId: 'adaptive-exploiter',
        difficulty: 'expert',
        seed: 1,
      });
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
