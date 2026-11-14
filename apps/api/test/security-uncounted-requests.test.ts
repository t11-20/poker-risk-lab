/**
 * Fastify runs every instance hook before any route-level hook, so a refusal answered from an instance
 * hook is not counted by the limiter unless the hook counts it. `onBanReach` must fire once per ban,
 * not per refused request, because each call writes an un-awaited audit INSERT. The database is a stub,
 * so ban assertions read the metric.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import { forgetRateLimitStoresForTests } from '../src/plugins/rate-limit-store.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const HOSTILE_ORIGIN = 'https://evil.test';
const GOOD_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

const GLOBAL_MAX = 3;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: GOOD_SECRET,
    RATE_LIMIT_MAX: String(GLOBAL_MAX),
    RATE_LIMIT_WINDOW_MS: '60000',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: async () => ({ ok: true }),
  close: async () => undefined,
};

interface Built {
  readonly app: FastifyInstance;
  readonly metrics: AppMetrics;
  readonly csrf: { readonly token: string; readonly cookie: string };
}

/** The store registry is process-wide, so earlier counters are forgotten first. */
async function buildIsolated(overrides: EnvRecord = {}): Promise<Built> {
  forgetRateLimitStoresForTests();
  const metrics = new AppMetrics();
  const app = await buildApp({ config: testConfig(overrides), database: stubDatabase, metrics });
  app.get('/api/v1/test-csrf', (_request, reply) => ({ token: reply.generateCsrf() }));
  app.post('/api/v1/test-echo', async () => ({ ok: true }));
  // The same decorator `routes/calc.ts` spreads onto `POST /math/equity`.
  app.post('/api/v1/test-expensive', { config: app.expensiveRateLimit }, async () => ({ ok: true }));
  await app.ready();

  const minted = await app.inject({ method: 'GET', url: '/api/v1/test-csrf' });
  assert.equal(minted.statusCode, 200, minted.body);
  const body: { readonly token?: unknown } = minted.json();
  const secret = minted.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'the CSRF plugin issued no secret cookie');
  return { app, metrics, csrf: { token: String(body.token), cookie: `prl_csrf=${secret.value}` } };
}

/**
 * Gives each case its own bucket. Under `app.inject` every request shares one address, and an
 * unsigned session cookie is keyed on the address.
 */
function bucket(app: FastifyInstance, name: string): string {
  return `prl_session=${app.signCookie(name)}`;
}

function errorCode(body: string): string {
  try {
    const parsed: { readonly error?: { readonly code?: unknown } } = JSON.parse(body);
    return String(parsed.error?.code);
  } catch {
    return `<not json: ${body.slice(0, 80)}>`;
  }
}

async function repeat(
  app: FastifyInstance,
  count: number,
  make: (index: number) => InjectOptions,
): Promise<{ readonly statuses: number[]; readonly bodies: string[] }> {
  const statuses: number[] = [];
  const bodies: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await app.inject(make(index));
    statuses.push(response.statusCode);
    bodies.push(response.body);
  }
  return { statuses, bodies };
}

function assertCountedAfter(
  result: { readonly statuses: number[]; readonly bodies: string[] },
  expectedBefore: number,
  limit: number,
): void {
  const before = result.statuses.slice(0, limit);
  assert.deepEqual(
    before,
    new Array(limit).fill(expectedBefore),
    `the first ${limit} requests should each be ${expectedBefore}: ${result.statuses}`,
  );
  const after = result.statuses.slice(limit);
  assert.ok(after.length > 0, 'the loop must go past the limit or it proves nothing');
  // The uncounted behaviour, written out as a negative control.
  const uncounted = new Array(after.length).fill(expectedBefore);
  assert.notDeepEqual(after, uncounted, 'these requests were refused without ever being counted');
  assert.deepEqual(
    after,
    new Array(after.length).fill(429),
    `past the limit every request must be 429: ${result.statuses}`,
  );
  for (const body of result.bodies.slice(limit)) {
    assert.equal(errorCode(body), 'rate_limited', body);
  }
}

describe('a refusal from an instance hook is still counted', () => {
  let built: Built;

  before(async () => {
    built = await buildIsolated();
  });
  after(async () => {
    await built?.app.close();
  });

  it('counts a cross-origin POST refused by the origin check', async () => {
    const cookie = bucket(built.app, 'cors-refuse');
    const result = await repeat(built.app, GLOBAL_MAX + 2, () => ({
      method: 'POST',
      url: '/api/v1/ready',
      headers: { origin: HOSTILE_ORIGIN, cookie, 'content-type': 'application/json' },
      payload: {},
    }));
    assertCountedAfter(result, 403, GLOBAL_MAX);
    assert.equal(errorCode(result.bodies[0] ?? ''), 'forbidden', 'the refusal itself is unchanged');
  });

  it('counts a preflight it rejects', async () => {
    const cookie = bucket(built.app, 'preflight-refused');
    const result = await repeat(built.app, GLOBAL_MAX + 2, () => ({
      method: 'OPTIONS',
      url: '/api/v1/ready',
      headers: { origin: HOSTILE_ORIGIN, 'access-control-request-method': 'POST', cookie },
    }));
    assertCountedAfter(result, 403, GLOBAL_MAX);
  });

  it('counts a preflight it accepts, which is answered from the same hook', async () => {
    const cookie = bucket(built.app, 'preflight-allowed');
    const result = await repeat(built.app, GLOBAL_MAX + 2, () => ({
      method: 'OPTIONS',
      url: '/api/v1/ready',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST', cookie },
    }));
    assertCountedAfter(result, 204, GLOBAL_MAX);
    assert.equal(
      (
        await built.app.inject({
          method: 'OPTIONS',
          url: '/api/v1/ready',
          headers: {
            origin: ALLOWED_ORIGIN,
            'access-control-request-method': 'POST',
            cookie: bucket(built.app, 'preflight-headers'),
          },
        })
      ).headers['access-control-allow-origin'],
      ALLOWED_ORIGIN,
    );
  });

  it('counts a CSRF-failing POST to a path that does not exist', async () => {
    // The 404 limiter is a `preHandler`, a stage after the CSRF `preValidation`. A new path each time.
    const cookie = bucket(built.app, 'csrf-404');
    const result = await repeat(built.app, GLOBAL_MAX + 2, (index) => ({
      method: 'POST',
      url: `/api/v1/does-not-exist-${index}`,
      headers: { cookie, 'content-type': 'application/json' },
      payload: {},
    }));
    assertCountedAfter(result, 403, GLOBAL_MAX);
  });

  it('still limits a GET to an unknown path, which was never the broken case', async () => {
    // Positive control. This path reaches a counting stage on its own and must stay counted.
    const cookie = bucket(built.app, 'get-404');
    const result = await repeat(built.app, GLOBAL_MAX + 2, (index) => ({
      method: 'GET',
      url: `/api/v1/nothing-here-${index}`,
      headers: { cookie },
    }));
    assertCountedAfter(result, 404, GLOBAL_MAX);
  });
});

describe('counting by hand does not count anything twice', () => {
  let built: Built;

  before(async () => {
    built = await buildIsolated();
  });
  after(async () => {
    await built?.app.close();
  });

  it('spends exactly one unit of budget per valid POST to a real route', async () => {
    // The route limiter already counted at `onRequest`, so the manual call in the CSRF hook must be a no-op.
    const cookie = bucket(built.app, 'double-count');
    const result = await repeat(built.app, GLOBAL_MAX + 1, () => ({
      method: 'POST',
      url: '/api/v1/test-echo',
      headers: {
        cookie: `${built.csrf.cookie}; ${cookie}`,
        'x-csrf-token': built.csrf.token,
        'content-type': 'application/json',
      },
      payload: {},
    }));
    assert.deepEqual(
      result.statuses,
      [...new Array(GLOBAL_MAX).fill(200), 429],
      `a valid POST must cost one unit, not two: ${result.statuses}`,
    );
  });

  it('leaves a stricter per-route limit in force', async () => {
    // `@fastify/rate-limit` counts a request once, so a manual call made too early would spend it on
    // the global bucket and disable `expensiveRateLimit` (500,000 Monte Carlo samples per call).
    const strict = await buildIsolated({ RATE_LIMIT_MAX: '100', RATE_LIMIT_EXPENSIVE_MAX: '1' });
    try {
      const cookie = bucket(strict.app, 'expensive');
      const result = await repeat(strict.app, 2, () => ({
        method: 'POST',
        url: '/api/v1/test-expensive',
        headers: {
          cookie: `${strict.csrf.cookie}; ${cookie}`,
          'x-csrf-token': strict.csrf.token,
          'content-type': 'application/json',
        },
        payload: {},
      }));
      assert.deepEqual(
        result.statuses,
        [200, 429],
        `the expensive limit must still fire: ${result.statuses}`,
      );
    } finally {
      await strict.app.close();
    }
  });
});

function bannedCount(metrics: AppMetrics): number {
  const line = metrics
    .render()
    .split('\n')
    .find((entry) => entry.startsWith('prl_rate_limit_events_total{kind="banned"}'));
  if (line === undefined) return 0;
  return Number(line.split(' ').at(-1));
}

describe('a ban is recorded once per caller per window, not once per refused request', () => {
  let built: Built;

  before(async () => {
    // 0 is the most aggressive setting, not "off", so every request past the limit is a ban.
    built = await buildIsolated({ RATE_LIMIT_BAN_AFTER: '0' });
  });
  after(async () => {
    await built?.app.close();
  });

  it('records one ban for a flood, however many requests the flood refuses', async () => {
    const cookie = bucket(built.app, 'flood');
    const overLimit = 6;
    const result = await repeat(built.app, GLOBAL_MAX + overLimit, () => ({
      method: 'GET',
      url: '/api/v1/ready',
      headers: { cookie },
    }));
    // Without these refusals, "one ban" would be indistinguishable from "no bans".
    assert.deepEqual(
      result.statuses.slice(GLOBAL_MAX),
      new Array(overLimit).fill(429),
      `the flood must actually be refused: ${result.statuses}`,
    );

    // The wrong count, one ban per refused request.
    const oncePerRefusedRequest = overLimit;
    const banned = bannedCount(built.metrics);
    assert.notEqual(
      banned,
      oncePerRefusedRequest,
      'the ban is still being recorded per request, which is the write amplifier',
    );
    assert.equal(banned, 1, `one caller, one window, one ban: got ${banned}`);
  });

  it('records the second caller separately, so the deduplication is per key', async () => {
    // Control. Suppressing every ban after the first in the process would also satisfy "exactly 1".
    const before = bannedCount(built.metrics);
    const cookie = bucket(built.app, 'second-flood');
    await repeat(built.app, GLOBAL_MAX + 4, () => ({
      method: 'GET',
      url: '/api/v1/ready',
      headers: { cookie },
    }));
    assert.equal(
      bannedCount(built.metrics) - before,
      1,
      'a different caller crossing the threshold is a different security event',
    );
  });
});

/**
 * The expiry arm of `bansRecordedUntil`. An infinite expiry would silence a persistent attacker and the
 * `RateLimitBans` rule. One second is the floor `config.ts` allows.
 */
describe('a caller who is still flooding in the next window is recorded again', () => {
  const WINDOW_MS = 1_000;
  let built: Built;

  before(async () => {
    built = await buildIsolated({ RATE_LIMIT_BAN_AFTER: '0', RATE_LIMIT_WINDOW_MS: String(WINDOW_MS) });
  });
  after(async () => {
    await built?.app.close();
  });

  it('records a second ban for the same key once the window has rolled', async () => {
    const cookie = bucket(built.app, 'persistent-flood');
    const flood = async (): Promise<number[]> =>
      (
        await repeat(built.app, GLOBAL_MAX + 3, () => ({
          method: 'GET',
          url: '/api/v1/ready',
          headers: { cookie },
        }))
      ).statuses;

    const before = bannedCount(built.metrics);
    const first = await flood();
    assert.ok(first.includes(429), `the first flood must actually be refused: ${first}`);
    assert.equal(bannedCount(built.metrics) - before, 1, 'the first window did not record exactly one ban');

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, WINDOW_MS + 150);
      timer.unref();
    });

    const second = await flood();
    assert.ok(second.includes(429), `the second flood must actually be refused: ${second}`);
    assert.equal(
      bannedCount(built.metrics) - before,
      2,
      'the same caller flooding in a later window was never recorded again: the deduplication ' +
        'entry is permanent rather than per-window, so a persistent attacker goes quiet in the ' +
        'log, the audit table and the metric that RateLimitBans reads',
    );
  });
});
