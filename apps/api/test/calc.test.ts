/**
 * The calculation endpoints, the planner, and the worker pool.
 *
 * Three layers, tested where each one actually lives:
 *
 * 1. **`calc/parse.ts`** is a pure function from a request body to a costed plan, so it is
 *    called directly. That is the only way to assert that an over-budget request is refused
 *    *before* anything is queued — through HTTP you can only observe that nothing ran.
 * 2. **`workers/pool.ts`** is exercised with real threads. Sharding, the pooled confidence
 *    interval, the deadline and the queue bound are all properties of the pool rather than of a
 *    route, and a pool test can assert the thing that matters most about a timeout: that the
 *    thread is gone afterwards.
 * 3. **The routes** go through `app.inject()`, which runs the whole lifecycle — rate limit, CSRF,
 *    schema validation, handler, error handler — with no socket and no port.
 *
 * No database anywhere: `buildApp` takes a `DatabaseHandle` and these tests pass a stub. Nothing
 * here needs one, because nothing in `POST /math/equity` or `POST /math/coach` touches a table.
 *
 * Every app is closed, and closing an app closes the shared pool, so no test leaves a worker
 * thread behind for the next one to inherit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import { potOdds } from '@prl/poker-math';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import {
  boardsPerMatchup,
  DEFAULT_WORK_LIMITS,
  parseCoachRequest,
  parseEquityRequest,
  STRENGTH_TABLE_ALLOWANCE_MS,
} from '../src/calc/parse.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError, isAppError } from '../src/errors.ts';
import calcRoutes from '../src/routes/calc.ts';
import type { WireSpec } from '../src/workers/equity-worker.ts';
import { getSharedPool, shardTasks, WorkerPool } from '../src/workers/pool.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so the limiter is never the reason an assertion fails. The one test that is
    // about the limit sets its own.
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
    ...overrides,
  });
}

function stubDatabase(): DatabaseHandle {
  return { ping: async () => ({ ok: true }), close: async () => undefined };
}

/** An app with the calculation routes and one helper route that mints a CSRF token. */
async function calcApp(overrides: EnvRecord = {}): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(overrides), database: stubDatabase() });
  app.get('/api/v1/test-csrf', async (_request, reply) => ({ token: reply.generateCsrf() }));
  await registerRoutes(app, [calcRoutes]);
  return app;
}

interface Csrf {
  readonly token: string;
  readonly cookie: string;
}

/**
 * A CSRF token and its cookie.
 *
 * Both endpoints are POSTs, so the security layer requires the double-submit pair. Minting it
 * here rather than reaching around the check keeps these tests honest about what a real client
 * has to do.
 */
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

interface Posted {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function post(
  app: FastifyInstance,
  url: string,
  payload: Record<string, unknown>,
  csrf: Csrf,
): Promise<Posted> {
  const response = await app.inject({
    method: 'POST',
    url,
    payload,
    headers: { 'x-csrf-token': csrf.token, cookie: csrf.cookie },
  });
  const body: unknown = response.body === '' ? {} : response.json();
  assert.ok(typeof body === 'object' && body !== null, 'a response body must be an object');
  return { status: response.statusCode, body: { ...body } };
}

/** The `equity` member of an `EquityResponse`, checked rather than cast. */
function equityOf(body: Record<string, unknown>): Record<string, unknown> {
  const summary = body['equity'];
  assert.ok(typeof summary === 'object' && summary !== null, `no equity summary in ${JSON.stringify(body)}`);
  return { ...summary };
}

function errorOf(body: Record<string, unknown>): { code: string; fields: Record<string, string> } {
  const error = body['error'];
  assert.ok(typeof error === 'object' && error !== null, `no error in ${JSON.stringify(body)}`);
  const shape: { readonly code?: unknown; readonly fields?: unknown } = error;
  const fields: Record<string, string> = {};
  if (typeof shape.fields === 'object' && shape.fields !== null) {
    for (const [key, value] of Object.entries(shape.fields)) fields[key] = String(value);
  }
  return { code: String(shape.code), fields };
}

function numberAt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  assert.equal(typeof value, 'number', `${key} should be a number, got ${JSON.stringify(value)}`);
  return Number(value);
}

/** A nested object member, asserted rather than cast. */
function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  assert.ok(
    typeof value === 'object' && value !== null,
    `${key} should be an object in ${JSON.stringify(record)}`,
  );
  return { ...value };
}

/** The `assumptions` list, asserted to exist and to be non-empty. */
function assumptionsOf(record: Record<string, unknown>): readonly string[] {
  const assumptions = record['assumptions'];
  assert.ok(Array.isArray(assumptions), 'a response must carry its assumptions');
  assert.ok(assumptions.length > 0, 'a figure never travels without its assumptions');
  return assumptions.map((note: unknown) => String(note));
}

/** A spec the worker can run without any HTTP involved. */
function flopSpec(notation: string): WireSpec {
  return {
    heroLabel: 'you',
    heroCards: parseCards('AhKh'),
    board: parseCards('Qh7h2c'),
    opponents: [{ kind: 'notation', label: 'them', notation }],
  };
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

describe('calc/parse.ts — costing a request before running it', () => {
  it('counts the boards still to come', () => {
    // Two players preflop: 52 - 4 = 48 cards, five to come.
    assert.equal(boardsPerMatchup(0, 2), 1_712_304);
    // A flop with two players: 45 unseen, two to come.
    assert.equal(boardsPerMatchup(3, 2), 990);
    assert.equal(boardsPerMatchup(4, 2), 46 - 2);
    assert.equal(boardsPerMatchup(5, 2), 1);
  });

  it('enumerates two known hands exactly and samples a range preflop', () => {
    const known = parseEquityRequest({ heroCards: 'AhAs', opponents: ['KdKc'] });
    assert.equal(known.request.method, 'exact');
    assert.equal(known.request.shards, 1);
    // 1,712,304 boards for two players is 3.42M evaluations, inside the four-million ceiling.
    assert.equal(known.plannedEvaluations, 1_712_304 * 2);

    const ranged = parseEquityRequest({ heroCards: 'AhAs', opponents: ['QQ+'] });
    assert.equal(ranged.request.method, 'monte-carlo');
    assert.ok(ranged.request.shards > 1, 'a big sampled run should be sharded');
    assert.ok(ranged.request.samples > 0);
  });

  it('shrinks the default sample count as players are added, and shards from it', () => {
    const heads = parseEquityRequest({ heroCards: 'AhKh', opponents: ['QQ+'] });
    const sixWay = parseEquityRequest({
      heroCards: 'AhKh',
      opponents: ['QQ+', 'JJ+', 'TT+', '99+', '88+'],
    });
    assert.ok(
      sixWay.request.samples < heads.request.samples,
      'six players cost three times as much per sample as two, so the default must fall',
    );
    for (const plan of [heads, sixWay]) {
      assert.ok(
        plan.plannedEvaluations <= DEFAULT_WORK_LIMITS.maxSampledEvaluations,
        `${plan.plannedEvaluations} evaluations is over the ceiling`,
      );
      assert.equal(plan.request.shards, Math.max(1, Math.round(plan.request.samples / 50_000)));
    }
  });

  it('refuses an over-budget request outright rather than quietly shrinking it', () => {
    // The schema's own maximum, against five opponents: 500,000 x 6 = 3,000,000 evaluations.
    const overBudget = (): unknown =>
      parseEquityRequest({
        heroCards: 'AhKh',
        opponents: ['100%', '100%', '100%', '100%', '100%'],
        samples: 500_000,
      });
    assert.throws(overBudget, (error: unknown) => {
      assert.ok(isAppError(error), `expected an AppError, got ${String(error)}`);
      assert.equal(error.code, 'computation_rejected');
      assert.equal(error.statusCode, 422);
      // No field detail: this is a statement about our limits, not about their payload.
      assert.equal(error.fields, undefined);
      return true;
    });
  });

  it('allows the same multiway question at a sample count it can afford', () => {
    const plan = parseEquityRequest({
      heroCards: 'AhAs',
      opponents: ['100%', '100%', '100%', '100%', '100%'],
    });
    assert.equal(plan.request.method, 'monte-carlo');
    assert.ok(plan.request.samples >= 20_000, 'a six-way question is still worth answering');
  });

  it('gives a top-percentage range the strength-table allowance and nothing else one', () => {
    const top = parseEquityRequest({ heroCards: 'AhKh', opponents: ['top:15'] });
    assert.equal(top.timeoutAllowanceMs, STRENGTH_TABLE_ALLOWANCE_MS);
    const notation = parseEquityRequest({ heroCards: 'AhKh', opponents: ['QQ+'] });
    assert.equal(notation.timeoutAllowanceMs, 0);
  });

  it('names the field when the situation is impossible', () => {
    const cases: readonly {
      readonly body: Parameters<typeof parseEquityRequest>[0];
      readonly field: string;
    }[] = [
      { body: { heroCards: 'AhKhQd', opponents: ['QQ+'] }, field: 'heroCards' },
      { body: { heroCards: 'AhKh', board: 'Qh7h', opponents: ['QQ+'] }, field: 'board' },
      { body: { heroCards: 'AhKh', board: 'AhQd7c', opponents: ['QQ+'] }, field: 'board' },
      { body: { heroCards: 'AhKh', opponents: ['AhQd'] }, field: 'opponents.0' },
      { body: { heroCards: 'AhKh', opponents: ['T9s+'] }, field: 'opponents.0' },
      { body: { heroCards: 'AhKh', opponents: ['AA', 'AA', 'AA', 'AA', 'AA'] }, field: 'opponents' },
    ];
    for (const testCase of cases) {
      assert.throws(
        () => parseEquityRequest(testCase.body),
        (error: unknown) => {
          assert.ok(isAppError(error), `expected an AppError for ${JSON.stringify(testCase.body)}`);
          assert.equal(error.code, 'invalid_request');
          assert.ok(
            error.fields?.[testCase.field] !== undefined,
            `expected a message on "${testCase.field}", got ${JSON.stringify(error.fields)}`,
          );
          return true;
        },
      );
    }
  });

  it('explains why T9s+ is refused instead of guessing which reading was meant', () => {
    assert.throws(
      () => parseEquityRequest({ heroCards: 'AhKh', opponents: ['T9s+'] }),
      (error: unknown) => {
        assert.ok(isAppError(error));
        const message = error.fields?.['opponents.0'] ?? '';
        assert.match(message, /ambiguous/i);
        assert.match(message, /connector/i, 'the message should name the reading it rejected');
        assert.match(message, /explicit/i, 'and say what to do instead');
        return true;
      },
    );
  });

  it('requires the Coach street and the board to describe the same hand', () => {
    assert.throws(
      () =>
        parseCoachRequest({
          heroCards: 'Th9h',
          board: 'Ah7h2c',
          opponents: ['AsKs'],
          pot: 100,
          toCall: 50,
          heroStack: 500,
          opponentStacks: [500],
          bigBlind: 10,
          street: 'turn',
        }),
      (error: unknown) => {
        assert.ok(isAppError(error));
        assert.equal(error.code, 'invalid_request');
        assert.ok(error.fields?.['board'] !== undefined);
        assert.ok(error.fields?.['street'] !== undefined);
        return true;
      },
    );
  });

  it('assumes an unstated opponent stack matches hero, and refuses a mismatched list', () => {
    const plan = parseCoachRequest({
      heroCards: 'Th9h',
      board: 'Ah7h2c',
      opponents: ['AsKs', 'QQ+'],
      pot: 100,
      toCall: 50,
      heroStack: 500,
      opponentStacks: [],
      bigBlind: 10,
      street: 'flop',
    });
    assert.deepEqual(plan.task.opponentStacks, [500, 500]);

    assert.throws(
      () =>
        parseCoachRequest({
          heroCards: 'Th9h',
          board: 'Ah7h2c',
          opponents: ['AsKs', 'QQ+'],
          pot: 100,
          toCall: 50,
          heroStack: 500,
          opponentStacks: [500],
          bigBlind: 10,
          street: 'flop',
        }),
      (error: unknown) => {
        assert.ok(isAppError(error));
        assert.ok(error.fields?.['opponentStacks'] !== undefined);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

describe('workers/pool.ts — sharding, deadlines and the queue', () => {
  it('splits samples exactly and gives every shard its own seed', () => {
    const spec = flopSpec('QQ+');
    const tasks = shardTasks({ spec, method: 'monte-carlo', samples: 100_003, shards: 4, seed: 11 });
    assert.equal(tasks.length, 4);
    assert.equal(
      tasks.reduce((sum, task) => sum + task.samples, 0),
      100_003,
      'the shards must sum to the requested sample count, remainder included',
    );
    assert.deepEqual(
      tasks.map((task) => task.seed),
      [11, 12, 13, 14],
    );

    const exact = shardTasks({ spec, method: 'exact', samples: 0, shards: 4, seed: 11 });
    assert.equal(exact.length, 1, 'there is nothing to shard about an exhaustive enumeration');
    assert.equal(exact[0]?.method, 'exact');
  });

  it('is reproducible, and pools the interval rather than averaging it', async () => {
    const pool = new WorkerPool({ size: 4, timeoutMs: 30_000 });
    try {
      const spec = flopSpec('QQ+, AKs');
      // 20,000 samples over four shards is 5,000 per shard, and shard 0 uses the same seed as
      // the single-shard run below — so `single` is literally one shard of `sharded`.
      const sharded = await pool.runEquity({
        spec,
        method: 'monte-carlo',
        samples: 20_000,
        shards: 4,
        seed: 7,
      });
      const again = await pool.runEquity({
        spec,
        method: 'monte-carlo',
        samples: 20_000,
        shards: 4,
        seed: 7,
      });
      const single = await pool.runEquity({
        spec,
        method: 'monte-carlo',
        samples: 5_000,
        shards: 1,
        seed: 7,
      });

      assert.equal(sharded.trials, 20_000);
      assert.equal(single.trials, 5_000);
      assert.equal(
        sharded.players[0]?.equity,
        again.players[0]?.equity,
        'a seeded, sharded run must give the same figure every time',
      );

      const combined = sharded.confidence?.halfWidthPoints ?? 0;
      const oneShard = single.confidence?.halfWidthPoints ?? 0;
      assert.ok(combined > 0 && oneShard > 0, 'a sampled result always carries an interval');
      assert.ok(combined < oneShard, 'four times the data must tighten the interval');
      // The honest part. Sampling error falls with the square root of the sample size, so four
      // shards buy a factor of two and not a factor of four — the combined interval is WIDER
      // than the naive reading of "four times as much data" suggests. Recomputing from the
      // pooled sample size is what preserves that; averaging the shards' own intervals would
      // have reported `oneShard` for a run of 20,000.
      assert.ok(
        combined > oneShard / 4,
        `combined ${combined} should be wider than a linear improvement (${oneShard / 4})`,
      );
      assert.ok(
        Math.abs(combined - oneShard / 2) < oneShard / 4,
        `combined ${combined} should be near one shard's ${oneShard} divided by the square root of 4`,
      );
    } finally {
      await pool.close();
    }
  });

  it('kills a thread that overruns its deadline, and carries on without it', async () => {
    const pool = new WorkerPool({ size: 1, timeoutMs: 1 });
    try {
      await assert.rejects(
        () =>
          pool.runEquity({
            spec: flopSpec('QQ+'),
            method: 'monte-carlo',
            samples: 200_000,
            shards: 1,
            seed: 3,
          }),
        (error: unknown) => {
          assert.ok(isAppError(error), `expected an AppError, got ${String(error)}`);
          assert.equal(error.code, 'computation_timeout');
          assert.equal(error.statusCode, 504);
          return true;
        },
      );

      const afterTimeout = pool.stats();
      assert.equal(afterTimeout.timedOut, 1);
      assert.equal(afterTimeout.workers, 0, 'the overrunning thread must be terminated, not left running');
      assert.equal(afterTimeout.busy, 0);

      // The pool is still usable: the next submission creates a replacement thread.
      const result = await pool.runEquity(
        { spec: flopSpec('QQ+'), method: 'monte-carlo', samples: 2_000, shards: 1, seed: 3 },
        30_000,
      );
      assert.equal(result.trials, 2_000);
      assert.equal(pool.stats().workers, 1);
    } finally {
      await pool.close();
    }
  });

  it('answers service_unavailable when the queue is full instead of growing it', async () => {
    const pool = new WorkerPool({ size: 1, timeoutMs: 30_000, queueLimit: 1 });
    try {
      const spec = flopSpec('QQ+');
      const request = { spec, method: 'monte-carlo' as const, samples: 40_000, shards: 1, seed: 5 };
      const first = pool.runEquity(request);
      const second = pool.runEquity(request);
      // The first is running on the only thread, the second is the only queue slot, so a third
      // has nowhere to go.
      await assert.rejects(
        () => pool.runEquity(request),
        (error: unknown) => {
          assert.ok(isAppError(error));
          assert.equal(error.code, 'service_unavailable');
          assert.equal(error.statusCode, 503);
          return true;
        },
      );
      assert.equal((await first).trials, 40_000);
      assert.equal((await second).trials, 40_000);
      assert.equal(pool.stats().rejected, 1);
    } finally {
      await pool.close();
    }
  });

  it('refuses work once closed', async () => {
    const pool = new WorkerPool({ size: 1, timeoutMs: 1_000 });
    await pool.close();
    await assert.rejects(
      () => pool.runEquity({ spec: flopSpec('QQ+'), method: 'exact', samples: 0, shards: 1, seed: 1 }),
      (error: unknown) => isAppError(error) && error.code === 'service_unavailable',
    );
    assert.equal(pool.stats().workers, 0);
  });

  /**
   * A jointly-undealable set of ranges is refused on the thread, not sampled at for the budget.
   *
   * `calc/parse.ts :: assertDealable` states the rule — `k` opponents need `2k` distinct cards
   * between them — and applies it to the ranges IT expanded. It expands no `top:NN` range,
   * because that needs the three-second preflop strength table this whole file exists to keep
   * off the event loop, so a `topPercent` opponent arrives there with an empty support set and
   * is skipped. The check is then vacuous for a request whose opponents are all `top:NN`.
   *
   * The two spellings below are the SAME range: `topPercentRange(1).notation` is exactly
   * `"AA, KK, QQ"`. Hero's `AhKh` and a board of `As Ks Qs` leave seven cards between them, and
   * five opponents need ten. Measured on the reference machine before this guard existed:
   *
   *     opponents = ["AA, KK, QQ"] x5 -> refused by assertDealable in 0 ms, with a field message
   *     opponents = ["top:1"]      x5 -> accepted, granted the 15,000 ms top:NN budget, and held
   *                                      a WARM calculator thread for 9,431 ms before
   *                                      `monteCarloEquity` gave up — then the same 422
   *
   * Nine seconds of the pool's scarcest resource for an answer of "no", on a bucket a session
   * may hit twenty times a minute, against a pool that is one thread on a one- or two-vCPU host
   * and that also serves hand review, the Legends comparison and the Scenario Lab. With the
   * guard in `equity-worker.ts` the same request is refused in 1 ms and the warm thread lives.
   */
  it('refuses jointly-undealable ranges on the thread instead of sampling for the whole budget', async () => {
    const undealable: WireSpec = {
      heroLabel: 'you',
      heroCards: parseCards('AhKh'),
      board: parseCards('AsKsQs'),
      opponents: Array.from({ length: 5 }, (_unused, index) => ({
        kind: 'topPercent' as const,
        label: `opponent ${index + 1}`,
        percent: 1,
      })),
    };
    const pool = new WorkerPool({ size: 1, timeoutMs: 20_000 });
    try {
      // Warmed first, so what is measured is the calculation and not the strength table.
      await pool.warm(60_000);
      const started = performance.now();
      await assert.rejects(
        () =>
          pool.runEquity(
            { spec: undealable, method: 'monte-carlo', samples: 20_000, shards: 1, seed: 1 },
            20_000,
          ),
        (error: unknown) => {
          assert.ok(isAppError(error), `expected an AppError, got ${String(error)}`);
          // `EquityError` is a statement about the request, so 422 rather than 500.
          assert.equal(error.code, 'computation_rejected');
          assert.equal(error.statusCode, 422);
          assert.match(String(error.logDetail), /cannot all be dealt at once/);
          return true;
        },
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 1_000, `expected a near-instant refusal, it took ${Math.round(elapsed)} ms`);
      assert.equal(pool.stats().workers, 1, 'refusing must not cost the warm thread');
    } finally {
      await pool.close();
    }
  });

  /**
   * The other half of the guard: it must refuse only what genuinely cannot be dealt.
   *
   * The same five `top:1` opponents with a hero who blocks none of them have twelve cards
   * between them, which is more than the ten five opponents need, so the request is answered.
   * Without this the guard could be made to pass by refusing everything.
   */
  it('leaves a wide top:NN request that CAN be dealt alone', async () => {
    const dealable: WireSpec = {
      heroLabel: 'you',
      heroCards: parseCards('2c3d'),
      board: [],
      opponents: Array.from({ length: 5 }, (_unused, index) => ({
        kind: 'topPercent' as const,
        label: `opponent ${index + 1}`,
        percent: 5,
      })),
    };
    const pool = new WorkerPool({ size: 1, timeoutMs: 60_000 });
    try {
      const result = await pool.runEquity(
        { spec: dealable, method: 'monte-carlo', samples: 2_000, shards: 1, seed: 1 },
        60_000,
      );
      assert.equal(result.trials, 2_000);
      assert.equal(result.players.length, 6);
    } finally {
      await pool.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /math/equity
// ---------------------------------------------------------------------------

describe('POST /math/equity', () => {
  it('enumerates two known hands exactly and reports no interval', async () => {
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      const response = await post(
        app,
        '/api/v1/math/equity',
        { heroCards: 'AhAs', opponents: ['KdKc'] },
        csrf,
      );
      assert.equal(response.status, 200);

      const summary = equityOf(response.body);
      assert.equal(summary['method'], 'exact-enumeration');
      // ADR 0005 records 81.26%–82.64% across the 36 suit configurations, averaging 81.946%.
      // AhAs against KdKc is one of them.
      const heroEquity = numberAt(summary, 'heroEquity');
      assert.ok(heroEquity > 0.8 && heroEquity < 0.84, `AA vs KK should be about 82%, got ${heroEquity}`);
      assert.equal(numberAt(summary, 'trials'), 1_712_304);
      assert.equal(
        summary['confidenceHalfWidthPoints'],
        null,
        'an exhaustive enumeration has no sampling error, and null is not the same claim as zero',
      );
      assert.equal(summary['ruleOfThumb'], null);

      const perPlayer = summary['perPlayer'];
      assert.ok(Array.isArray(perPlayer) && perPlayer.length === 2);
      assumptionsOf(response.body);
      assert.equal(typeof response.body['elapsedMs'], 'number');
    } finally {
      await app.close();
    }
  });

  it('samples a range, reports a positive interval, and repeats itself exactly', async () => {
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      // Preflop against a range: twelve combinations times 1,712,304 boards is far past the
      // exact ceiling, so the planner samples it. The same spot on a flop is only 23,760 boards
      // and is enumerated exactly — which is the behaviour the previous test checks.
      const body = { heroCards: 'AhKh', opponents: ['QQ+, AKs'], samples: 20_000 };
      const first = await post(app, '/api/v1/math/equity', body, csrf);
      assert.equal(first.status, 200);

      const summary = equityOf(first.body);
      assert.equal(summary['method'], 'monte-carlo');
      assert.equal(numberAt(summary, 'trials'), 20_000);
      assert.ok(numberAt(summary, 'confidenceHalfWidthPoints') > 0, 'a sampled figure carries its error bar');
      const assumptions = assumptionsOf(first.body);
      assert.ok(
        assumptions.some((note) => note.includes('Sampling here is seeded')),
        `the assumptions should say the figure is reproducible: ${assumptions.join(' | ')}`,
      );

      const second = await post(app, '/api/v1/math/equity', body, csrf);
      assert.equal(
        numberAt(equityOf(second.body), 'heroEquity'),
        numberAt(summary, 'heroEquity'),
        'the same question must give the same answer',
      );
    } finally {
      await app.close();
    }
  });

  it('rejects an over-budget request without queueing any work', async () => {
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      // The same instance the route uses: the pool is process-wide by design.
      const pool = getSharedPool(app.appConfig);
      const before = pool.stats().submitted;
      const response = await post(
        app,
        '/api/v1/math/equity',
        {
          heroCards: 'AhKh',
          opponents: ['100%', '100%', '100%', '100%', '100%'],
          samples: 500_000,
        },
        csrf,
      );
      assert.equal(response.status, 422);
      assert.equal(errorOf(response.body).code, 'computation_rejected');
      assert.equal(pool.stats().submitted, before, 'nothing should have been handed to a thread');
    } finally {
      await app.close();
    }
  });

  it('returns a field-level message for a malformed range', async () => {
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      const response = await post(
        app,
        '/api/v1/math/equity',
        { heroCards: 'AhKh', opponents: ['T9s+'] },
        csrf,
      );
      assert.equal(response.status, 400);
      const error = errorOf(response.body);
      assert.equal(error.code, 'invalid_request');
      assert.match(error.fields['opponents.0'] ?? '', /ambiguous/i);
    } finally {
      await app.close();
    }
  });

  it('is refused by the schema before the planner sees a nonsensical card', async () => {
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      const response = await post(app, '/api/v1/math/equity', { heroCards: 'Zz', opponents: ['QQ+'] }, csrf);
      assert.equal(response.status, 400);
      assert.equal(errorOf(response.body).code, 'invalid_request');
    } finally {
      await app.close();
    }
  });

  it('answers computation_timeout when the budget runs out', async () => {
    // The smallest budget configuration allows. Spawning a thread alone costs more than this, so
    // the deadline is certain to fire — which is the point: the caller gets 504, not a hang.
    const app = await calcApp({ COACH_TIMEOUT_MS: '100' });
    try {
      const csrf = await csrfPair(app);
      const response = await post(
        app,
        '/api/v1/math/equity',
        { heroCards: 'AhKh', opponents: ['100%', '100%'], samples: 150_000 },
        csrf,
      );
      assert.equal(response.status, 504);
      assert.equal(errorOf(response.body).code, 'computation_timeout');
    } finally {
      await app.close();
    }
  });

  it('carries the stricter rate limit, not the global one', async () => {
    const app = await calcApp({ RATE_LIMIT_MAX: '5000', RATE_LIMIT_EXPENSIVE_MAX: '1' });
    try {
      const csrf = await csrfPair(app);
      const body = { heroCards: 'AhAs', opponents: ['KdKc'] };
      assert.equal((await post(app, '/api/v1/math/equity', body, csrf)).status, 200);
      const limited = await post(app, '/api/v1/math/equity', body, csrf);
      assert.equal(limited.status, 429, 'the second expensive call should be limited, not the 5000th');
      assert.equal(errorOf(limited.body).code, 'rate_limited');
    } finally {
      await app.close();
    }
  });

  it('requires the CSRF header, like every other mutating route', async () => {
    const app = await calcApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/math/equity',
        payload: { heroCards: 'AhAs', opponents: ['KdKc'] },
      });
      assert.equal(response.statusCode, 403);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /math/coach
// ---------------------------------------------------------------------------

describe('POST /math/coach', () => {
  /** A flop spot against one known hand: small enough to be enumerated exactly. */
  const flopSpot: Record<string, unknown> = {
    heroCards: 'Th9h',
    board: 'Ah7h2c',
    opponents: ['AsKs'],
    pot: 100,
    toCall: 50,
    heroStack: 500,
    opponentStacks: [500],
    bigBlind: 10,
    street: 'flop',
  };

  /** A preflop spot against a range: far too large to enumerate, so it is sampled. */
  const preflopSpot: Record<string, unknown> = {
    heroCards: 'AhKh',
    opponents: ['QQ+, AKs, AQo+'],
    pot: 30,
    toCall: 20,
    heroStack: 1_000,
    opponentStacks: [1_000],
    bigBlind: 10,
    street: 'preflop',
  };

  const spots: readonly { readonly label: string; readonly body: Record<string, unknown> }[] = [
    { label: 'a flush draw against one known hand (enumerated exactly)', body: flopSpot },
    { label: 'top pair against a range preflop (sampled)', body: preflopSpot },
  ];

  it('always returns a report with its assumptions and its uncertainty', async () => {
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      for (const spot of spots) {
        const result = await post(app, '/api/v1/math/coach', spot.body, csrf);
        assert.equal(result.status, 200, `${spot.label}: ${JSON.stringify(result.body)}`);
        const shape = objectAt(result.body, 'report');
        assumptionsOf(shape);

        const note = objectAt(shape, 'uncertainty');
        assert.ok(note['method'] === 'exact-enumeration' || note['method'] === 'monte-carlo');
        const limitations = note['limitations'];
        assert.ok(Array.isArray(limitations) && limitations.length > 0, `${spot.label}: no limitations`);
        if (note['method'] === 'monte-carlo') {
          assert.notEqual(
            note['confidenceInterval'],
            null,
            `${spot.label}: a sampled report needs an interval`,
          );
        } else {
          assert.equal(note['confidenceInterval'], null, `${spot.label}: exact means no interval, not zero`);
        }

        const advice = objectAt(shape, 'suggestion');
        assert.ok(['low', 'moderate', 'reasonable'].includes(String(advice['confidence'])));
        const changes = advice['whatWouldChangeIt'];
        assert.ok(Array.isArray(changes) && changes.length > 0, `${spot.label}: no "what would change it"`);
        // There is no field capable of saying "correct", and there must not be one.
        assert.equal(advice['correct'], undefined);
      }
    } finally {
      await app.close();
    }
  });

  it('refuses a street that disagrees with the board', async () => {
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      const result = await post(app, '/api/v1/math/coach', { ...flopSpot, street: 'turn' }, csrf);
      assert.equal(result.status, 400);
      const error = errorOf(result.body);
      assert.equal(error.code, 'invalid_request');
      assert.match(error.fields['board'] ?? '', /turn has 4 community cards/);
    } finally {
      await app.close();
    }
  });

  it('is the same maths a learner can check by hand', async () => {
    // The Coach's pot-odds figure is not its own arithmetic: it is `potOdds` from the maths
    // package, and this test recomputes it independently rather than trusting the response.
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      const result = await post(app, '/api/v1/math/coach', flopSpot, csrf);
      const odds = objectAt(objectAt(result.body, 'report'), 'potOdds');
      const expected = potOdds(100, 50);
      assert.equal(numberAt(odds, 'breakEvenEquity'), expected.breakEvenEquity);
      assert.equal(numberAt(odds, 'oddsRatio'), expected.oddsRatio);
    } finally {
      await app.close();
    }
  });

  it('sends a check spot over the wire as a null price, not as a number', async () => {
    // The defect this route shipped with, asserted where it actually happened: on the WIRE.
    //
    // `potOdds` reported `Infinity` for a free call and the contract declared the member `number`.
    // `JSON.stringify(Infinity)` is `null`, so this response carried `"oddsRatio": null` against a
    // contract that said it could not — and the client's formatter threw on it, taking the whole
    // `/play` route down through its error boundary on every check spot. In-process tests could not
    // see it, because in process the value really was `Infinity`.
    //
    // So this reads the serialised body rather than a returned object, and asserts both halves: the
    // member is JSON `null`, and it is NOT the number 0 — a free call has no price, which is a
    // different claim from the worst possible price.
    const app = await calcApp();
    try {
      const csrf = await csrfPair(app);
      const result = await post(app, '/api/v1/math/coach', { ...flopSpot, toCall: 0 }, csrf);
      assert.equal(result.status, 200);
      const odds = objectAt(objectAt(result.body, 'report'), 'potOdds');
      assert.equal(odds['oddsRatio'], null, 'a free call must cross the wire as null');
      assert.notEqual(odds['oddsRatio'], 0, '0 is a real price, and the worst one — not the absence of one');
      assert.equal(numberAt(odds, 'toCall'), 0);
      assert.equal(numberAt(odds, 'breakEvenEquity'), 0);
      assert.equal(potOdds(100, 0).oddsRatio, null, 'and the maths package agrees with what it serialised');

      // The whole report survives a round trip unchanged, which is the property that was false
      // before: re-serialising and re-parsing what the client received must be a fixed point.
      const body: unknown = result.body;
      assert.deepEqual(JSON.parse(JSON.stringify(body)), body);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The wiring itself
// ---------------------------------------------------------------------------

describe('the calculation module wiring', () => {
  it('terminates every thread when the instance closes', async () => {
    const app = await calcApp();
    const csrf = await csrfPair(app);
    const pool = getSharedPool(app.appConfig);
    assert.equal(
      (await post(app, '/api/v1/math/equity', { heroCards: 'AhAs', opponents: ['KdKc'] }, csrf)).status,
      200,
    );
    assert.ok(pool.stats().workers >= 1, 'a request should have created a thread');

    await app.close();
    assert.equal(pool.stats().workers, 0, 'closing the app must terminate the pool');
    assert.equal(pool.stats().closed, true);
  });

  it('throws rather than pretend when a worker task is misused', async () => {
    // `runCoach` on a pool whose worker script does not exist: the failure surfaces as an
    // AppError with a code, never as a hang or a raw Node error reaching a client.
    const pool = new WorkerPool({
      size: 1,
      timeoutMs: 2_000,
      workerUrl: new URL('./does-not-exist.ts', import.meta.url),
    });
    try {
      await assert.rejects(
        () =>
          pool.runEquity({
            spec: flopSpec('QQ+'),
            method: 'monte-carlo',
            samples: 1_000,
            shards: 1,
            seed: 1,
          }),
        (error: unknown) => {
          assert.ok(error instanceof AppError, `expected an AppError, got ${String(error)}`);
          assert.ok(['internal_error', 'computation_timeout'].includes(error.code));
          return true;
        },
      );
    } finally {
      await pool.close();
    }
  });
});
