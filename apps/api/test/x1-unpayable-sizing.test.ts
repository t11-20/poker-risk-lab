/**
 * What the Scenario Lab does with a size the learner could not have paid, or that it never priced.
 *
 * ## The defect this file exists for
 *
 * The release remediation fixed the half of the legality guard that governs what the Coach
 * *publishes*: across all 36 shipped scenarios, no candidate and no suggestion sits outside the
 * legal set. Nothing governed what the product *accepts*. Measured against the running server,
 * hero holding 500 behind and facing a bet of 25:
 *
 *     POST /api/v1/content/scenarios/eq-flush-draw-turn-small-bet/attempt
 *          {"action":"raise","to":26000}
 *       -> 200  {"consistentWithAnalysis": true, ...}
 *
 * `to: 100000`, `to: 1` and `to: 0` behaved identically. The cause was one line in
 * `@prl/poker-math`: `candidateFor` fell back to the highest-EV row for the action name when the
 * submitted `to` matched nothing, so a 26,000-chip raise was scored against the 67-chip raise the
 * Coach liked and the learner was told their impossible action agreed with an analysis that had
 * never considered it.
 *
 * It is a P0 and not a rough edge because the product's stated guardrail is that it never teaches
 * something false, and this told a learner something false about both the maths and the rules of
 * poker in one reply. It is also pre-existing rather than a regression — it is present at the
 * baseline commit — and it stayed invisible because nothing in the suite ever submitted a size
 * nobody could pay. That is the gap this file closes.
 *
 * ## The three outcomes, which are deliberately not two
 *
 *  1. **Unpayable** — above hero's whole stack, at or below zero, or below the smallest legal
 *     raise. Refused with a 400 before anything is graded. It is not a decision that could have
 *     been made at the table, so there is no verdict to give it.
 *  2. **Payable but unpriced** — a legal size the analysis did not put on its ladder. Answered,
 *     with `consistentWithAnalysis: false` meaning *not established*: the reply says the analysis
 *     did not price that size, names the sizes it did price, and says in as many words that this
 *     is not a claim the size is wrong. Nothing is recorded against the learner.
 *  3. **Priced** — graded exactly as before. Asserted here too, because a fix that made every
 *     sizing unanswerable would satisfy the first two and destroy the feature.
 *
 * ## No database needed for most of it
 *
 * Everything an anonymous reader can do runs unconditionally. The one claim that needs a database
 * is the one about what gets *recorded* — that an unpriced decision writes `matched_expected` as
 * NULL rather than as a wrong answer — and it is skipped with a printed reason when `DATABASE_URL`
 * is absent, like every other database-backed suite here.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { scenarioById, scenarios } from '@prl/content';
import { maximumTo, minimumAggressiveTo } from '@prl/poker-math';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, type DatabaseHandle, getSql } from '../src/db.ts';
import { newUserId } from '../src/repositories/ids.ts';
import contentRoutes, { coachTaskFor } from '../src/routes/content.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

/** The spot the defect was reported against: hero has 500 behind and faces a bet of 25. */
const SCENARIO_ID = 'eq-flush-draw-turn-small-bet';

const databaseTest = { skip: databaseSkip('what an unpriced scenario decision records') };

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

function stubDatabase(): DatabaseHandle {
  return { ping: async () => ({ ok: true }), close: async () => undefined };
}

/** Fills the seam `sessionPlugin` normally fills, so the write path can be exercised. */
function withSignedInCaller(app: FastifyInstance, userId: string): void {
  app.decorateRequest('session', null);
  app.decorateRequest('sessionRejection', null);
  app.addHook('preHandler', (request, _reply, done) => {
    request.session = {
      sessionId: 'ses_x1sizingtest0000000000000',
      user: { id: userId, kind: 'guest', displayName: 'Test Learner', createdAt: new Date().toISOString() },
    };
    done();
  });
}

async function contentApp(options: { readonly userId?: string } = {}): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database: stubDatabase() });
  app.get('/api/v1/test-csrf', async (_request, reply) => ({ token: reply.generateCsrf() }));
  if (options.userId !== undefined) withSignedInCaller(app, options.userId);
  await registerRoutes(app, [contentRoutes]);
  return app;
}

interface Attempt {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function attempt(
  app: FastifyInstance,
  scenarioId: string,
  payload: Record<string, unknown>,
): Promise<Attempt> {
  const csrf = await app.inject({ method: 'GET', url: '/api/v1/test-csrf' });
  const parsedCsrf: unknown = csrf.json();
  assert.ok(typeof parsedCsrf === 'object' && parsedCsrf !== null && 'token' in parsedCsrf);
  const secret = csrf.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined);
  const token = String((parsedCsrf as { readonly token: unknown }).token);

  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/content/scenarios/${scenarioId}/attempt`,
    payload,
    headers: { 'x-csrf-token': token, cookie: `prl_csrf=${secret.value}` },
  });
  const parsed: unknown = response.body === '' ? {} : JSON.parse(response.body);
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return { status: response.statusCode, body: { ...parsed } };
}

function errorOf(body: Record<string, unknown>): Record<string, unknown> {
  const error = body['error'];
  assert.ok(
    typeof error === 'object' && error !== null,
    `expected an error body, got ${JSON.stringify(body)}`,
  );
  return { ...error };
}

/** The bounds this spot's own numbers fix, read from the same functions the route holds a size to. */
function boundsFor(scenarioId: string): { readonly floorTo: number; readonly maxTo: number } {
  const scenario = scenarioById(scenarioId);
  assert.ok(scenario !== null, `no scenario ${scenarioId}`);
  const task = coachTaskFor(scenario);
  return { floorTo: minimumAggressiveTo(task), maxTo: maximumTo(task) };
}

describe('a scenario sizing nobody could have paid', () => {
  after(async () => {
    await closeSharedPool();
  });

  /**
   * The reported payload, verbatim, and the three variants that behaved the same way.
   *
   * The load-bearing assertion is the second one in each iteration, not the status: whatever the
   * endpoint decides to do with an impossible size, it must never come back saying that size
   * agreed with the analysis. The status is asserted too, because "refused" is the answer this
   * fix chose and a silent downgrade to a 200 with a soft sentence would be a different product
   * decision that should have to change a test.
   */
  it('refuses it instead of reporting it as consistent with the analysis', async () => {
    const app = await contentApp();
    try {
      for (const to of [26_000, 100_000, 1, 0]) {
        const response = await attempt(app, SCENARIO_ID, { action: 'raise', to });
        assert.notEqual(
          response.body['consistentWithAnalysis'],
          true,
          `a raise to ${to} with 500 behind must never be reported as consistent with the analysis`,
        );
        assert.equal(response.status, 400, `raise to ${to}`);
        const error = errorOf(response.body);
        assert.equal(error['code'], 'invalid_request');
        const fields = error['fields'];
        assert.ok(typeof fields === 'object' && fields !== null);
        assert.ok(
          String((fields as { readonly to?: unknown }).to).length > 0,
          'the refusal has to name the field it is about',
        );
      }
    } finally {
      await app.close();
    }
  });

  it('says which bound the size missed, so the learner can see what they were held to', async () => {
    const { floorTo, maxTo } = boundsFor(SCENARIO_ID);
    const app = await contentApp();
    try {
      const tooBig = errorOf((await attempt(app, SCENARIO_ID, { action: 'raise', to: maxTo + 1 })).body);
      assert.match(
        String((tooBig['fields'] as Record<string, unknown>)['to']),
        new RegExp(`${maxTo}`),
        'the ceiling has to appear in the message, in chips',
      );

      const tooSmall = errorOf((await attempt(app, SCENARIO_ID, { action: 'raise', to: floorTo - 1 })).body);
      assert.match(
        String((tooSmall['fields'] as Record<string, unknown>)['to']),
        new RegExp(`${floorTo}`),
        'the floor has to appear in the message, in chips',
      );

      const zero = errorOf((await attempt(app, SCENARIO_ID, { action: 'raise', to: 0 })).body);
      assert.match(String((zero['fields'] as Record<string, unknown>)['to']), /above zero/);
    } finally {
      await app.close();
    }
  });

  /**
   * The whole shipped bundle, not one scenario.
   *
   * A fix pinned to one scenario's numbers is a fix that holds until content changes. Every
   * scenario that offers aggression at all is asked to grade a raise to one chip above hero's
   * whole stack, and none of them may answer that it was consistent.
   */
  it('holds for every scenario in the bundle, not just the one it was found in', async () => {
    const app = await contentApp();
    try {
      let checked = 0;
      for (const scenario of scenarios()) {
        const task = coachTaskFor(scenario);
        if (!task.legalActions.includes('bet') && !task.legalActions.includes('raise')) continue;
        const action = task.legalActions.includes('bet') ? 'bet' : 'raise';
        const response = await attempt(app, scenario.id, { action, to: maximumTo(task) + 1 });
        assert.notEqual(
          response.body['consistentWithAnalysis'],
          true,
          `${scenario.id}: a ${action} beyond hero's whole stack was reported as consistent`,
        );
        assert.equal(response.status, 400, scenario.id);
        checked += 1;
      }
      assert.ok(checked >= 20, `only ${checked} scenarios offered aggression; expected most of the bundle`);
    } finally {
      await app.close();
    }
  });
});

describe('a scenario sizing that is legal but was never priced', () => {
  after(async () => {
    await closeSharedPool();
  });

  /**
   * The honest middle case, and the reason the fix is not simply "refuse harder".
   *
   * The Coach prices three representative sizes, not the whole ladder. A learner who raises to a
   * total between them has made a decision the table would accept and the analysis has nothing to
   * say about. That is neither consistent nor inconsistent, and the reply has to say so — the
   * `ScenarioAttemptResponse` contract has one boolean, so the distinction lives in the prose and
   * in what does *not* get written to the database.
   */
  it('answers it, and says plainly that the analysis has nothing to compare it with', async () => {
    const { floorTo, maxTo } = boundsFor(SCENARIO_ID);
    const app = await contentApp();
    try {
      // Every priced raise, from the analysis itself rather than from a number written here.
      const priced = await app.inject({ method: 'GET', url: `/api/v1/content/scenarios/${SCENARIO_ID}` });
      const analysis: unknown = JSON.parse(priced.body);
      assert.ok(typeof analysis === 'object' && analysis !== null && 'analysis' in analysis);
      const candidates = (
        analysis as { readonly analysis: { readonly candidates: readonly Record<string, unknown>[] } }
      ).analysis.candidates;
      const pricedRaises = candidates
        .filter((candidate) => candidate['action'] === 'raise')
        .map((candidate) => Number(candidate['to']));
      assert.ok(pricedRaises.length >= 2, 'the spot should price more than one raise');

      // A legal total the ladder skipped: at or above the floor, at or below the stack, unpriced.
      let unpriced: number | null = null;
      for (let to = floorTo; to <= maxTo; to += 1) {
        if (!pricedRaises.includes(to)) {
          unpriced = to;
          break;
        }
      }
      assert.ok(unpriced !== null, 'the ladder cannot possibly have priced every total in the range');

      const response = await attempt(app, SCENARIO_ID, { action: 'raise', to: unpriced });
      assert.equal(response.status, 200, 'a legal size is a real decision, so it gets an answer');
      assert.equal(response.body['consistentWithAnalysis'], false);
      const reasoning = String(response.body['reasoning']);
      assert.match(reasoning, new RegExp(`did not price raise to ${unpriced}`));
      assert.match(reasoning, /not a statement that your size is wrong/);
      // The sizes it did price are named, so the reply is useful rather than merely correct.
      for (const size of pricedRaises) assert.match(reasoning, new RegExp(`\\b${size}\\b`));
    } finally {
      await app.close();
    }
  });

  it('does not turn an unpriced decision into a wrong answer in the database', databaseTest, async () => {
    configureDatabase(testConfig());
    const sql = getSql();
    const userId = newUserId();
    await sql`insert into prl.users (id, kind, display_name) values (${userId}, 'guest', 'X1 Learner')`;
    const app = await contentApp({ userId });
    try {
      const { floorTo } = boundsFor(SCENARIO_ID);
      // `floorTo` is the smallest legal raise; the Coach's ladder starts above it, so this total
      // is payable and unpriced — see the previous test, which derives the same thing the long way.
      const response = await attempt(app, SCENARIO_ID, { action: 'raise', to: floorTo });
      assert.equal(response.status, 200);
      assert.equal(response.body['consistentWithAnalysis'], false);

      const rows = await sql<{ matched_expected: boolean | null }[]>`
        select matched_expected from prl.scenario_attempts where user_id = ${userId}
      `;
      assert.equal(rows.length, 1, 'the attempt is still recorded — the learner did make a decision');
      assert.equal(
        rows[0]?.matched_expected,
        null,
        'with no row to compare against there is no claim to record, so it must not go in as false',
      );
    } finally {
      await app.close();
      await sql`delete from prl.users where id = ${userId}`;
      await closeDatabase(1_000);
    }
  });
});

describe('the sizings that were always answered correctly', () => {
  after(async () => {
    await closeSharedPool();
  });

  /**
   * The regression half of the fix.
   *
   * Refusing everything would satisfy every assertion above and would break the feature, so the
   * cases that worked before have to be pinned: a size the analysis did price is graded on its own
   * row, an unsized call is graded as before, and the fold the remediation corrected still reads
   * as consistent in the scenario that asks whether to fold.
   */
  it('grades a size the analysis did price, exactly as before', async () => {
    const app = await contentApp();
    try {
      const priced = await app.inject({ method: 'GET', url: `/api/v1/content/scenarios/${SCENARIO_ID}` });
      const parsed: unknown = JSON.parse(priced.body);
      assert.ok(typeof parsed === 'object' && parsed !== null && 'analysis' in parsed);
      const candidates = (
        parsed as { readonly analysis: { readonly candidates: readonly Record<string, unknown>[] } }
      ).analysis.candidates;
      const best = candidates
        .filter((candidate) => candidate['action'] === 'raise')
        .sort((left, right) => Number(right['ev']) - Number(left['ev']))[0];
      assert.ok(best !== undefined);

      const response = await attempt(app, SCENARIO_ID, { action: 'raise', to: Number(best['to']) });
      assert.equal(response.status, 200);
      assert.equal(
        response.body['consistentWithAnalysis'],
        true,
        'the highest-value raise the analysis priced is consistent with the analysis',
      );
      assert.match(String(response.body['reasoning']), /is consistent with this analysis/);
    } finally {
      await app.close();
    }
  });

  it('still reads a profitable unsized call as consistent', async () => {
    const app = await contentApp();
    try {
      const response = await attempt(app, SCENARIO_ID, { action: 'call' });
      assert.equal(response.status, 200);
      assert.equal(response.body['consistentWithAnalysis'], true);
    } finally {
      await app.close();
    }
  });

  it('still reads a fold as consistent in the scenario that asks whether to fold', async () => {
    // The case the remediation fixed by not judging a fold against an assumed fold frequency.
    // Nothing here may undo it.
    const app = await contentApp();
    try {
      for (const id of ['rk-the-fold-that-feels-wrong', 'eq-implied-odds-deep-stacks-turn']) {
        assert.ok(scenarioById(id) !== null, `the bundle should still contain ${id}`);
        const response = await attempt(app, id, { action: 'fold' });
        assert.equal(response.status, 200, id);
        assert.equal(response.body['consistentWithAnalysis'], true, `${id}: folding here is defensible`);
      }
    } finally {
      await app.close();
    }
  });
});
