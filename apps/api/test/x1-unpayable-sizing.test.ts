/**
 * The Scenario Lab once graded a raise to 26,000 with 500 behind as consistent with the analysis,
 * because `candidateFor` fell back to the best row for the action name. Three outcomes, not two.
 * An unpayable size (over the stack, at or below zero, under the minimum raise) is refused with a 400.
 * A legal size off the analysis ladder is answered as not established and records NULL.
 * A size on the ladder is graded as before, which stops a fix that refuses everything.
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

/** Hero has 500 behind and faces a bet of 25. */
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

function withSignedInCaller(app: FastifyInstance, userId: string): void {
  app.decorateRequest('session', null);
  app.decorateRequest('sessionRejection', null);
  app.addHook('preHandler', (request, _reply, done) => {
    request.session = {
      sessionId: 'ses_x1sizingtest0000000000000',
      expiresAt: new Date(Date.now() + 3_600_000),
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

/** Read from the same functions the route holds a size to. */
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
   * The reported payload and three variants. The load-bearing check is that an impossible size never
   * agrees with the analysis. The 400 is pinned too, so a softer 200 has to change a test.
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

/**
 * A legal total the analysis left off its ladder, derived from the analysis itself. A hardcoded floor
 * stopped being unladdered once the Coach began grading the minimum raise (CI run 43047978449).
 */
async function unpricedRaise(
  app: FastifyInstance,
): Promise<{ readonly to: number; readonly pricedRaises: readonly number[] }> {
  const { floorTo, maxTo } = boundsFor(SCENARIO_ID);
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

  for (let to = floorTo; to <= maxTo; to += 1) {
    if (!pricedRaises.includes(to)) return { to, pricedRaises };
  }
  assert.fail('the ladder cannot possibly have priced every total in the range');
}

describe('a scenario sizing that is legal but was never priced', () => {
  after(async () => {
    await closeSharedPool();
  });

  /**
   * The Coach grades the sizes the sizing buttons offer, not every legal total. The contract has one
   * boolean, so "not established" lives in the prose and in what is not written to the database.
   */
  it('answers it, and says plainly that the analysis has nothing to compare it with', async () => {
    const app = await contentApp();
    try {
      const { to: unpriced, pricedRaises } = await unpricedRaise(app);

      const response = await attempt(app, SCENARIO_ID, { action: 'raise', to: unpriced });
      assert.equal(response.status, 200, 'a legal size is a real decision, so it gets an answer');
      assert.equal(response.body['consistentWithAnalysis'], false);
      const reasoning = String(response.body['reasoning']);
      assert.match(reasoning, new RegExp(`did not price raise to ${unpriced}`));
      assert.match(reasoning, /not a statement that your size is wrong/);
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
      const { to: unpriced } = await unpricedRaise(app);
      const response = await attempt(app, SCENARIO_ID, { action: 'raise', to: unpriced });
      assert.equal(response.status, 200);
      assert.equal(response.body['consistentWithAnalysis'], false);
      // Without the unladdered reply, the NULL below proves nothing about that path.
      assert.match(String(response.body['reasoning']), new RegExp(`did not price raise to ${unpriced}`));

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
    // Pins the earlier fix that stopped judging a fold against an assumed fold frequency.
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
