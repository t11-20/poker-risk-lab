/**
 * The Coach's legal-action guard through the production path. The library test passed while four
 * Coach surfaces published refused actions, because `CoachTask` had no `legalActions` field and an
 * absent list permitted everything. So every case goes through the real task builders and a real
 * `WorkerPool`, the boundary where the field was lost. No database.
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

/** One pool for the file, because the shipped-bundle case submits three dozen tasks. */
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

/** The rows and the headline. */
function actionsNamedBy(report: CoachReport): readonly string[] {
  return [...new Set([...report.candidates.map((candidate) => candidate.action), report.suggestion.action])];
}

function outsideTheSet(report: CoachReport, legal: readonly string[]): readonly string[] {
  const permitted = new Set(legal);
  return actionsNamedBy(report).filter((action) => !permitted.has(action));
}

/** `@prl/content` throws for the whole bundle on load, so the rethrow names which side owns the problem. */
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

/** Every stack check says a raise is affordable, so only the legal-action set can withhold one. */
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
    contestablePot: 120,
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
    // Unreachable with a healthy worker, so asserted directly.
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

    // A failure here means the derivation is wrong. A failure below means it is not applied.
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
      // Affordability was the only thing the old code checked.
      assert.ok(body.heroStack - body.toCall > body.bigBlind * 10, 'hero can plainly afford a raise');
    } finally {
      await app.close();
    }
  });

  it('offers no aggression in a hand review, where the opponent is all-in for real', () => {
    // Seat 0 folds, the 40-chip small blind shoves, and the big blind faces 30 with 990 behind.
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

describe('every shipped scenario', () => {
  it('publishes nothing outside the legal set its own task carries', async () => {
    // `scenarios()` rather than reading JSON, so an unloadable bundle fails this case too.
    const bundle = loadBundleOrExplain();
    // A sweep of nothing is not a pass.
    assert.ok(bundle.length >= 30, `expected the shipped Scenario Lab, found ${bundle.length}`);

    const failures: string[] = [];
    let withAggression = 0;
    let namedActions = 0;

    // One at a time. The bounded queue refuses rather than grows, so `Promise.all` would fail.
    for (const scenario of bundle) {
      const task = coachTaskFor(scenario);
      const report = await pool.runCoach(task);

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
      // `heroStack` is chips behind, so it is the ceiling for `cost`.
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

function reportOf(body: unknown): CoachReport {
  assert.ok(typeof body === 'object' && body !== null && 'report' in body, JSON.stringify(body));
  const report = (body as { readonly report: unknown }).report;
  assert.ok(typeof report === 'object' && report !== null, 'a CoachResponse carries a report');
  return report as CoachReport;
}
