/**
 * Shared-pool lifecycle: close/restart, crash, warmup, and `/ready` gating.
 *
 * `calc.test.ts` already covers sharding, the queue bound, the deadline, and `app.close()`
 * terminating threads. This file is the rest of the contract the production boot path
 * depends on — especially the one that used to be missing: `/ready` staying 503 until the
 * calculation threads have built their strength table, so the first live Coach is warm.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { isAppError } from '../src/errors.ts';
import calcRoutes from '../src/routes/calc.ts';
import type { CoachTask, WireSpec } from '../src/workers/equity-worker.ts';
import {
  beginSharedPoolWarmup,
  closeSharedPool,
  getSharedPool,
  peekSharedPool,
  sharedPoolReadiness,
  WorkerPool,
} from '../src/workers/pool.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
    MONTE_CARLO_WORKERS: '2',
    ...overrides,
  });
}

function stubDatabase(): DatabaseHandle {
  return { ping: async () => ({ ok: true }), close: async () => undefined };
}

function flopSpec(): WireSpec {
  return {
    heroLabel: 'you',
    heroCards: parseCards('AhKh'),
    board: parseCards('Qh7h2c'),
    opponents: [{ kind: 'notation', label: 'them', notation: 'QQ+' }],
  };
}

function topPercentCoach(): CoachTask {
  return {
    kind: 'coach',
    spec: {
      heroLabel: 'you',
      heroCards: parseCards('AhKh'),
      board: [],
      opponents: [{ kind: 'topPercent', label: 'the field', percent: 40 }],
    },
    street: 'preflop',
    pot: 30,
    toCall: 20,
    heroCommittedThisStreet: 10,
    heroStack: 1_000,
    opponentStacks: [1_000],
    bigBlind: 10,
    legalActions: ['fold', 'call', 'raise'],
    samples: 2_000,
    seed: 7,
  };
}

async function calcApp(): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database: stubDatabase() });
  app.get('/api/v1/test-csrf', async (_request, reply) => ({ token: reply.generateCsrf() }));
  await registerRoutes(app, [calcRoutes]);
  return app;
}

after(async () => {
  await closeSharedPool();
});

describe('the shared pool is replaced after close, never reused closed', () => {
  it('getSharedPool after closeSharedPool is a new, usable pool', async () => {
    const config = testConfig();
    const first = getSharedPool(config);
    const before = await first.runEquity({
      spec: flopSpec(),
      method: 'exact',
      samples: 0,
      shards: 1,
      seed: 1,
    });
    assert.equal(before.method, 'exact-enumeration');

    await closeSharedPool();
    assert.equal(first.stats().closed, true);
    assert.equal(first.stats().workers, 0);
    assert.equal(peekSharedPool(), null);

    const second = getSharedPool(config);
    assert.notEqual(second, first, 'the memo must not return the closed leftover');
    assert.equal(second.stats().closed, false);
    const afterClose = await second.runEquity({
      spec: flopSpec(),
      method: 'exact',
      samples: 0,
      shards: 1,
      seed: 1,
    });
    assert.equal(afterClose.method, 'exact-enumeration');
    await closeSharedPool();
  });

  it('getSharedPool drops a leftover that was closed without closeSharedPool', async () => {
    const config = testConfig();
    const leaked = getSharedPool(config);
    await leaked.close();
    assert.equal(leaked.stats().closed, true);

    const replacement = getSharedPool(config);
    assert.notEqual(replacement, leaked);
    assert.equal(replacement.stats().closed, false);
    const result = await replacement.runEquity({
      spec: flopSpec(),
      method: 'exact',
      samples: 0,
      shards: 1,
      seed: 1,
    });
    assert.equal(result.method, 'exact-enumeration');
    await closeSharedPool();
  });
});

describe('a worker that dies mid-task', () => {
  it('surfaces a typed error and does not hang', async () => {
    const pool = new WorkerPool({
      size: 1,
      timeoutMs: 5_000,
      workerUrl: new URL('./helpers/crashing-worker.mjs', import.meta.url),
    });
    const started = performance.now();
    try {
      await assert.rejects(
        () =>
          pool.runEquity({
            spec: flopSpec(),
            method: 'monte-carlo',
            samples: 1_000,
            shards: 1,
            seed: 1,
          }),
        (error: unknown) => {
          assert.ok(isAppError(error), `expected an AppError, got ${String(error)}`);
          assert.equal(error.code, 'internal_error');
          return true;
        },
      );
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 4_000, `a crash must not sit on the deadline; took ${Math.round(elapsed)} ms`);
      assert.equal(pool.stats().workers, 0, 'the dead thread must be dropped');
      assert.ok(pool.stats().failed >= 1);
    } finally {
      await pool.close();
      assert.equal(pool.stats().workers, 0);
    }
  });
});

describe('pre-warm gates /ready and makes the first Coach warm', () => {
  it('keeps /ready 503 until workers are usable, then a top:40 Coach is not the cold path', async () => {
    await closeSharedPool();
    const app = await calcApp();
    try {
      assert.deepEqual(sharedPoolReadiness(), { required: false, ok: true });
      const before = await app.inject({ method: 'GET', url: '/api/v1/ready' });
      assert.equal(before.statusCode, 200);
      assert.deepEqual(before.json(), { status: 'ready', checks: { database: { ok: true } } });

      const warming = beginSharedPoolWarmup(app.appConfig);
      const during = sharedPoolReadiness();
      assert.equal(during.required, true);
      assert.equal(during.ok, false);

      const probing = await app.inject({ method: 'GET', url: '/api/v1/ready' });
      // Warmup is ~3s; inject is milliseconds. If a machine ever finishes first this still
      // asserts the body shape rather than hanging the suite.
      if (probing.statusCode === 503) {
        const body = probing.json() as {
          status: string;
          checks: { workers?: { ok: boolean; detail?: string } };
        };
        assert.equal(body.status, 'degraded');
        assert.equal(body.checks.workers?.ok, false);
        assert.match(body.checks.workers?.detail ?? '', /still starting/);
      }

      await warming;
      assert.deepEqual(sharedPoolReadiness(), { required: true, ok: true });
      const ready = await app.inject({ method: 'GET', url: '/api/v1/ready' });
      assert.equal(ready.statusCode, 200);
      assert.deepEqual(ready.json(), {
        status: 'ready',
        checks: { database: { ok: true }, workers: { ok: true } },
      });

      const pool = getSharedPool(app.appConfig);
      assert.ok(pool.stats().workers >= 1, 'warmup must have spawned threads');

      const started = performance.now();
      const report = await pool.runCoach(topPercentCoach(), 8_000);
      const elapsed = performance.now() - started;
      assert.ok(report.candidates.length > 0, 'the first Coach after ready must actually analyse');
      // Historical cold path on this machine: ~3.0–3.4s to build the strength table. A warm
      // first request is tens to hundreds of milliseconds. 2.5s is still well under cold and
      // leaves room for a loaded CI box; a regression that skipped warmup fails this.
      assert.ok(
        elapsed < 2_500,
        `first Coach after /ready took ${elapsed.toFixed(0)}ms; warmup did not keep the cold ~3s path off the first request`,
      );
    } finally {
      await app.close();
      await closeSharedPool();
    }
  });
});
