/**
 * The Coach's action-legality guard, exercised through the production path rather than around it.
 *
 * ## Why this file exists, given that `packages/poker-math/test/coach-legality.test.ts` exists
 *
 * That file is a good test of the *library*. It builds a `CoachInput` by hand, puts
 * `legalActions` on it, and checks that nothing outside the set is published. It passed
 * throughout the period in which four of the five Coach surfaces published actions the table
 * refuses — because the defect was never in the library's filter. It was in the wiring:
 *
 *   - `CoachInput.legalActions` was optional, and the filter read
 *     `input.legalActions === undefined || input.legalActions.includes(action)`, so an absent
 *     list meant "everything is permitted";
 *   - `CoachTask`, the wire type between this API and the calculator thread, had **no field for
 *     it at all**, so the Scenario Lab, the hand review, the profile comparison and
 *     `POST /math/coach` could not have supplied one if they had tried;
 *   - only `ws/router.ts`, which calls `buildCoachReport` directly and never crosses that wire,
 *     passed one.
 *
 * A test that hands the library its own input can no more detect that than a test that calls a
 * validator directly can detect a route which forgot to call it. So every case below goes
 * through the real task builders — `coachTaskFor` for the Scenario Lab, `parseCoachRequest` for
 * `POST /math/coach`, `buildHandReview` for the hand review — and through a real `WorkerPool`
 * with real threads, which is the boundary the field used to be lost at.
 *
 * ## What each case would have caught
 *
 * 1. **Threading.** A task that permits only `fold` and `call` on a spot that plainly affords a
 *    raise. Before the fix the field did not exist on `CoachTask`, so the worker never saw it
 *    and the report contained raises. This fails if anybody stops passing it on.
 * 2. **Derivation.** A spot whose every opponent is all-in. Nothing in the pot, the price or
 *    hero's stack says so; only `opponentStacks` does. Before the fix the Scenario Lab and the
 *    ad-hoc calculator offered a bet or raise here, priced with 35% fold equity against players
 *    with no chips to fold.
 * 3. **The shipped bundle.** Every scenario in the Scenario Lab, end to end, with the count
 *    asserted so a data move cannot turn this into a test of nothing.
 *
 * No database: `buildApp` takes a stub handle, and nothing here reads a table.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { scenarios } from '@prl/content';
import type { CoachReport } from '@prl/contracts';
import { parseCards } from '@prl/poker-engine';
import { deriveLegalActions } from '@prl/poker-math';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import { parseCoachRequest } from '../src/calc/parse.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { buildHandReview } from '../src/review/build-review.ts';
import calcRoutes from '../src/routes/calc.ts';
import { coachTaskFor } from '../src/routes/content.ts';
import type { CoachTask } from '../src/workers/equity-worker.ts';
import { assertReportStaysInsideItsLegalSet, WorkerPool } from '../src/workers/pool.ts';
import { persistHand } from './helpers/hand-rows.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';

/**
 * One pool for the whole file, closed once at the end.
 *
 * Threads are expensive to start and the shipped-bundle case submits three dozen tasks, so a
 * pool per case would spend more time on isolates than on arithmetic. The budget is generous
 * because a wide preflop range on a fresh thread pays for its strength table.
 */
const pool = new WorkerPool({ size: 4, timeoutMs: 120_000 });
after(async () => {
  await pool.close();
});

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
    ...overrides,
  });
}

function stubDatabase(): DatabaseHandle {
  return { ping: async () => ({ ok: true }), close: async () => undefined };
}

/** Every action name the report puts in front of a learner: the rows and the headline. */
function actionsNamedBy(report: CoachReport): readonly string[] {
  return [...new Set([...report.candidates.map((candidate) => candidate.action), report.suggestion.action])];
}

function outsideTheSet(report: CoachReport, legal: readonly string[]): readonly string[] {
  const permitted = new Set(legal);
  return actionsNamedBy(report).filter((action) => !permitted.has(action));
}

/**
 * The shipped bundle, or a failure that says where to look.
 *
 * `@prl/content` validates on load and throws for the whole bundle, so one bad seat row takes
 * every content-reading test in the repo down with it and the stack lands in `validate.ts` with
 * no hint of which side of the boundary owns the problem. The rethrow adds that hint and nothing
 * else — the case still fails, which is correct: a Scenario Lab that cannot load is not a Scenario
 * Lab whose legality can be vouched for.
 */
function loadBundleOrExplain(): ReturnType<typeof scenarios> {
  try {
    return scenarios();
  } catch (error) {
    throw new Error(
      'the content bundle would not load, so no scenario could be analysed. This is a @prl/content ' +
        'problem, not a legality one — most likely a seat row the schema in packages/content/src/' +
        `validate.ts refuses. Original: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

// ---------------------------------------------------------------------------
// 1. The field survives the wire
// ---------------------------------------------------------------------------

/**
 * A spot with money behind on both sides, so every arithmetic test the Coach can do says a raise
 * is affordable. The only thing that can withhold one is the legal-action set.
 */
function affordableRaiseTask(overrides: Partial<CoachTask> = {}): CoachTask {
  return {
    kind: 'coach',
    spec: {
      heroLabel: 'you',
      heroCards: parseCards('AhKh'),
      board: parseCards('Qh 7d 2c 5s'),
      opponents: [{ kind: 'notation', label: 'the opponent', notation: '22+, A2s+, KTo+' }],
    },
    street: 'turn',
    pot: 120,
    toCall: 40,
    heroCommittedThisStreet: 0,
    heroStack: 800,
    opponentStacks: [800],
    bigBlind: 10,
    legalActions: ['fold', 'call', 'raise'],
    samples: 4_000,
    seed: 20_260_818,
    ...overrides,
  };
}

describe('the legal-action set crosses the worker boundary', () => {
  it('withholds a raise the task did not permit, on a spot that plainly affords one', async () => {
    // The regression this whole fix is about, in one case. `CoachTask` had no `legalActions`
    // field, so this narrowing could not be expressed and the worker priced a raise anyway.
    const base = affordableRaiseTask();

    const permissive = await pool.runCoach({ ...base, legalActions: ['fold', 'call', 'raise'] });
    assert.ok(
      permissive.candidates.some((candidate) => candidate.action === 'raise'),
      'the control case must offer a raise, or the restricted case proves nothing',
    );

    const restricted = await pool.runCoach({ ...base, legalActions: ['fold', 'call'] });
    assert.deepEqual(
      restricted.candidates
        .filter((candidate) => candidate.action === 'raise' || candidate.action === 'bet')
        .map((candidate) => `${candidate.action} to ${String(candidate.to)}`),
      [],
      'the worker published aggression the task did not permit — the field is not being threaded',
    );
    assert.deepEqual(outsideTheSet(restricted, ['fold', 'call']), []);
  });

  it('refuses to serve a report that names an action the task did not permit', () => {
    // The pool's own guard. It cannot be reached with a healthy worker, which is exactly why it
    // is asserted directly rather than left as a comment.
    const task = affordableRaiseTask({ legalActions: ['fold', 'call'] });
    const fabricated = {
      candidates: [{ action: 'raise' as const, to: 120, cost: 120, ev: 40, derivation: 'fabricated' }],
      suggestion: {
        action: 'raise' as const,
        confidence: 'reasonable' as const,
        reason: 'fabricated',
        whatWouldChangeIt: ['fabricated'],
      },
    } as unknown as CoachReport;
    assert.throws(
      () => {
        assertReportStaysInsideItsLegalSet(task, fabricated);
      },
      /legal actions/,
      'a report outside its own task’s legal set must not reach a learner',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. A described spot with nobody left to call
// ---------------------------------------------------------------------------

describe('a spot where every opponent is all-in', () => {
  it('offers no aggression through the ad-hoc calculator, and says so end to end', async () => {
    const body = {
      heroCards: 'AhKh',
      board: 'Qh 7d 2c 5s',
      street: 'turn' as const,
      opponents: ['22+, A2s+, KTo+'],
      pot: 400,
      toCall: 120,
      heroStack: 900,
      opponentStacks: [0],
      bigBlind: 10,
    };

    // The planner is where the set is derived for this surface, so assert the plan first: a
    // failure here says the derivation is wrong, a failure below says it is not being applied.
    const plan = parseCoachRequest(body);
    assert.deepEqual([...plan.task.legalActions].sort(), ['call', 'fold']);

    const app = await coachApp();
    try {
      const csrf = await csrfPair(app);
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/math/coach',
        payload: body,
        headers: { 'x-csrf-token': csrf.token, cookie: csrf.cookie },
      });
      assert.equal(response.statusCode, 200, response.body);
      const report = reportOf(response.json());
      assert.deepEqual(
        outsideTheSet(report, ['fold', 'call']),
        [],
        'the served report named an action nobody at that table could have taken',
      );
      // And the reason the old code offered one anyway: it is affordable, and affordability was
      // the only thing it checked.
      assert.ok(body.heroStack - body.toCall > body.bigBlind * 10, 'hero can plainly afford a raise');
    } finally {
      await app.close();
    }
  });

  it('offers no aggression in a hand review, where the opponent is all-in for real', () => {
    // Three-handed so a seat can be all-in while a live decision remains for somebody else:
    // seat 0 folds, the 40-chip small blind shoves, and the big blind faces 30 to call with 990
    // behind. The engine offers that seat `fold, call` and nothing more.
    const fixture = persistHand({
      handId: 'coach-legality-allin',
      roomId: 'coach-legality',
      buttonSeat: 0,
      smallBlind: 5,
      bigBlind: 10,
      seats: [
        { seat: 0, userId: 'user-button', displayName: 'Button', stack: 1_000 },
        { seat: 1, userId: 'user-short', displayName: 'Short', stack: 40 },
        { seat: 2, userId: 'user-hero', displayName: 'Hero', stack: 1_000 },
      ],
      holeCards: { 0: 'Jc9c', 1: '7h7s', 2: 'AhKh' },
      board: 'Qh 7d 2c 5s Td',
      steps: [
        { seat: 0, action: { type: 'fold' } },
        { seat: 1, action: { type: 'raise', to: 40 } },
        { seat: 2, action: { type: 'call' } },
      ],
    });

    const review = buildHandReview({
      hand: fixture.hand,
      seats: fixture.seats,
      actions: fixture.actions,
      viewerUserId: 'user-hero',
      maxPotAfter: fixture.hand.max_pot_after,
    });

    const analysed = review.decisions.filter((decision) => decision.analysis !== null);
    assert.ok(analysed.length > 0, 'the review must analyse at least one decision, or it proves nothing');
    for (const decision of analysed) {
      const analysis = decision.analysis;
      assert.ok(analysis !== null);
      assert.deepEqual(
        outsideTheSet(analysis, ['fold', 'call']),
        [],
        'a review offered a line the table would have rejected on the night',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The shipped Scenario Lab, through its own task builder
// ---------------------------------------------------------------------------

describe('every shipped scenario', () => {
  it('publishes nothing outside the legal set its own task carries', async () => {
    // `scenarios()` and not a hand-rolled JSON read, deliberately: this case is about the
    // production path, and the production path loads a *validated* bundle. A version of this
    // that parsed the data files itself would keep passing while the bundle the server actually
    // serves was unloadable, which is the shape of gate this whole fix exists to remove. So a
    // bundle that fails validation fails this case too — with the reason attached, because the
    // reason is not in this file.
    const bundle = loadBundleOrExplain();
    // A guard on the guard: if the bundle moves or shrinks this would pass by checking nothing.
    assert.ok(bundle.length >= 30, `expected the shipped Scenario Lab, found ${bundle.length}`);

    const failures: string[] = [];
    let withAggression = 0;
    let namedActions = 0;

    // One at a time. The pool's queue is bounded (`size * QUEUE_SLOTS_PER_WORKER`) and refuses
    // rather than growing, which is correct behaviour and would make a `Promise.all` over three
    // dozen scenarios fail for a reason that has nothing to do with legality.
    for (const scenario of bundle) {
      const task = coachTaskFor(scenario);
      const report = await pool.runCoach(task);

      // The task's own set has to agree with the spot it describes, or the filter below would be
      // checking a report against the wrong decision point.
      const legal = [...task.legalActions];
      assert.deepEqual(
        legal,
        [...deriveLegalActions(task)],
        `${scenario.id}: the task's legal set is not the one its own figures derive`,
      );
      assert.equal(legal.includes('check'), task.toCall === 0, `${scenario.id}: check/toCall disagree`);
      assert.equal(legal.includes('call'), task.toCall > 0, `${scenario.id}: call/toCall disagree`);

      if (legal.includes('bet') || legal.includes('raise')) withAggression += 1;
      namedActions += actionsNamedBy(report).length;

      const outside = outsideTheSet(report, legal);
      if (outside.length > 0) {
        failures.push(
          `${scenario.id}: named ${outside.join(', ')} against a legal set of ${legal.join(', ')}`,
        );
      }
      // The invariant the audit found violated in the other direction: no row may cost more than
      // hero has behind. `heroStack` is chips BEHIND, so this is the right ceiling for `cost`.
      for (const candidate of report.candidates) {
        if (candidate.cost > task.heroStack) {
          failures.push(
            `${scenario.id}: the ${candidate.action} row costs ${candidate.cost} with ${task.heroStack} behind`,
          );
        }
      }
    }

    assert.ok(withAggression >= 25, `only ${withAggression} scenarios permitted aggression at all`);
    assert.ok(namedActions >= 100, `only ${namedActions} actions were checked`);
    assert.deepEqual(failures, [], `${failures.length} of ${bundle.length} scenarios name an illegal action`);
  });
});

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

async function coachApp(): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database: stubDatabase() });
  app.get('/api/v1/test-csrf', async (_request, reply) => ({ token: reply.generateCsrf() }));
  await registerRoutes(app, [calcRoutes]);
  return app;
}

interface Csrf {
  readonly token: string;
  readonly cookie: string;
}

async function csrfPair(app: FastifyInstance): Promise<Csrf> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/test-csrf' });
  assert.equal(response.statusCode, 200);
  const body: unknown = response.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body);
  const payload: { readonly token?: unknown } = body;
  const secret = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'generateCsrf should set the prl_csrf cookie');
  return { token: String(payload.token), cookie: `prl_csrf=${secret.value}` };
}

/** The `report` member of a `CoachResponse`, checked rather than cast. */
function reportOf(body: unknown): CoachReport {
  assert.ok(typeof body === 'object' && body !== null && 'report' in body, JSON.stringify(body));
  const report = (body as { readonly report: unknown }).report;
  assert.ok(typeof report === 'object' && report !== null, 'a CoachResponse carries a report');
  return report as CoachReport;
}
