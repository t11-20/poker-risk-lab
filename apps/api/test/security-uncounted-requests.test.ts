/**
 * The four request classes the security layer refused for free, and the ban it recorded per
 * request instead of per caller.
 *
 * ## The invariant this file guards
 *
 * `plugins/security.ts` opens by explaining that its hook order was chosen so that a caller
 * "could not send unlimited requests that fail CSRF without ever being counted", and that the
 * route-level limiter is "the first thing that can cost a caller anything". It was not true.
 * Fastify runs every INSTANCE hook before every route-level hook, so anything answered from an
 * instance hook is answered before the limiter has run at all; and the not-found route's limiter
 * is a `preHandler`, which is a stage LATER than the instance `preValidation` CSRF check.
 *
 * Four classes fell through, and all four were measured against the shipped code before the fix,
 * each with 50 requests at `RATE_LIMIT_MAX=3`, each returning 403 every time with the caller's
 * bucket still empty afterwards:
 *
 *  1. a cross-origin `POST` from an origin that is not allowlisted;
 *  2. a rejected `OPTIONS` preflight;
 *  3. an ACCEPTED `OPTIONS` preflight (204, and equally uncounted);
 *  4. a `POST` to a nonexistent path with a bad or missing CSRF token — the exact hole the header
 *     names, and the one that blunts `errors.ts`'s own reason for limiting the 404 route ("a
 *     caller can hammer nonexistent paths for free — exactly what a path scanner does").
 *
 * None is a knockout: every one of those responses is cheap, with no database and (for three of
 * the four) no body parse. They are amplification, they are unbounded, and they are the property
 * the file claimed to have.
 *
 * ## The controls, and why each is here
 *
 * A test that only asserts "the fourth request is a 429" would also pass against a server that
 * had started refusing everything, or one that counted each request twice and hit the limit
 * early. So each case asserts the whole sequence — how many got the refusal they should, and
 * exactly when the limiter takes over — and two further cases assert the two ways the fix could
 * have gone wrong:
 *
 *  * **Counted once, not twice.** A CSRF-VALID `POST` to a real route is counted by the route's
 *    own limiter at `onRequest`; the manual call in the CSRF hook must be the no-op there. If it
 *    were not, every mutating request would consume two of the caller's budget.
 *  * **A stricter route limit is not displaced.** `@fastify/rate-limit` counts a request once, so
 *    a manual call made too early would consume the request's one count against the GLOBAL bucket
 *    and silently disable `expensiveRateLimit` on the routes that carry it. That route's limit is
 *    set to 1 here and asserted to still fire.
 *
 * ## And the ban, which is a separate defect on the same path
 *
 * `onBanReach` fires on every request while `current - max > ban`, not once when the threshold is
 * crossed. Each call wrote a `warn` line, a metric increment, and an un-awaited `INSERT` into
 * `prl.audit_log`. Under a flood — which is the only condition it fires under — the refusal path
 * became a database write amplifier with no backpressure and an unbounded pending-promise queue.
 * The last block measures the metric, which is the observable half of the same call.
 *
 * ## No database
 *
 * `buildApp` takes a `DatabaseHandle` and this file passes a stub. Every request here is answered
 * at or before `preValidation`, or by a route that touches nothing, and `recordSecurityAudit`
 * returns immediately when no database is configured — which is why the ban assertions are made
 * against the metric rather than against `prl.audit_log`.
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

/** The global limit every case below is measured against. Small enough to reach in a loop. */
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

/**
 * An app with its own metrics, its own limiter counters, and a CSRF pair minted against it.
 *
 * `forgetRateLimitStoresForTests()` first for the same reason `rate-limit-isolation.test.ts` does
 * it: the store registry is process-wide, and counters left by an earlier app would be attributed
 * to this one.
 */
async function buildIsolated(overrides: EnvRecord = {}): Promise<Built> {
  forgetRateLimitStoresForTests();
  const metrics = new AppMetrics();
  const app = await buildApp({ config: testConfig(overrides), database: stubDatabase, metrics });
  // A GET route purely to mint a CSRF pair, and a POST route that exists so that "a real route"
  // can be tested without a database. Same device as `rate-limit-isolation.test.ts`.
  app.get('/api/v1/test-csrf', (_request, reply) => ({ token: reply.generateCsrf() }));
  app.post('/api/v1/test-echo', async () => ({ ok: true }));
  // The stricter per-route limit, on a route of its own. `expensiveRateLimit` is a decorator, so
  // this is exactly what `routes/calc.ts` spreads onto `POST /math/equity`.
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
 * A session cookie this app will accept the signature of.
 *
 * Every case needs its OWN rate-limit bucket, and `rateLimitKeyFor` prefers a signed session over
 * the address — under `app.inject` every request comes from the same address, so without this
 * they would all share one counter and the cases would drain each other. An unsigned value would
 * not do: the limiter checks the signature and keys an unsigned cookie on the address, which is
 * the defect `rateLimitKeyFor` was fixed for.
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

/** The status codes of `count` identical requests, in order. */
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

/**
 * The shape every case asserts: `refused` answers of the expected kind, then 429 for ever.
 *
 * Written as one helper because the four classes differ only in what the pre-limit answer is, and
 * four copies of this sequence would be four chances to assert something slightly weaker in one
 * of them.
 */
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
  // MEASURED BEFORE THE FIX: every entry here was `expectedBefore` too — the refusal was answered
  // from a hook the limiter had not run in, so the bucket was still empty after 50 of them. The
  // old expectation, written out:
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
    // `POST /api/v1/ready` is a mutating method on a real path with a hostile Origin, so
    // `applyCors` returns `refuse` and the request never reaches the router.
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
    // The one that reads like it should be free and is not. A 204 from an instance hook is a
    // response this server produced for a caller who has presented nothing at all.
    const cookie = bucket(built.app, 'preflight-allowed');
    const result = await repeat(built.app, GLOBAL_MAX + 2, () => ({
      method: 'OPTIONS',
      url: '/api/v1/ready',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST', cookie },
    }));
    assertCountedAfter(result, 204, GLOBAL_MAX);
    // The preflight it accepts must still be a usable answer, not merely a counted one.
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
    // The hole the file header names. The not-found route's limiter is a `preHandler` and the
    // CSRF check is a `preValidation` hook, so the 403 came one whole stage before the counting.
    // A different path each time, because a path scanner does not ask twice.
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
    // The positive control from the other direction: this one was already counted before the fix
    // (`errors.ts` gives the not-found route a rate-limit `preHandler`), and it must stay counted.
    // Without it, "the 404 path is limited" could be true only because of the new call.
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
    // The route's own limiter runs at `onRequest`, so the manual call in the CSRF `preValidation`
    // hook must find the request already counted and do nothing. If it double-counted, the limit
    // would be reached after GLOBAL_MAX / 2 requests instead of GLOBAL_MAX — which is the failure
    // this asserts against by pinning the exact index at which 429 first appears.
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
    // `@fastify/rate-limit` counts a request once, whichever handler counts it. So a manual call
    // made in an instance `onRequest` hook — on every request rather than only on the ones the
    // hook answers — would consume that one count against the GLOBAL bucket and silently disable
    // `expensiveRateLimit` everywhere it is used. `routes/calc.ts` spreads that same decorator
    // onto an endpoint that accepts 500,000 Monte Carlo samples per call.
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

/** The value of `prl_rate_limit_events_total{kind="banned"}` in a rendered exposition. */
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
    // `RATE_LIMIT_BAN_AFTER=0` is the most aggressive setting the library has, not "off":
    // `isBanned = ban !== -1 && current - max > ban`, and `config.ts` bounds the variable at
    // `min: 0` so a negative value cannot be configured at all. `.env.example` says the same.
    // Every request past the limit is therefore a ban, which is what makes this measurable in a
    // handful of injections instead of 501 of them.
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
    // The negative control for the count below: without these refusals the ban path was never
    // reached and "one ban" would be indistinguishable from "no bans".
    assert.deepEqual(
      result.statuses.slice(GLOBAL_MAX),
      new Array(overLimit).fill(429),
      `the flood must actually be refused: ${result.statuses}`,
    );

    // MEASURED BEFORE: `onBanReach` fired on every refused request, so this was `overLimit` — one
    // `warn` line, one metric increment and one un-awaited INSERT into `prl.audit_log` each. The
    // old expression, written out:
    const oncePerRefusedRequest = overLimit;
    const banned = bannedCount(built.metrics);
    assert.notEqual(
      banned,
      oncePerRefusedRequest,
      'the ban is still being recorded per request, which is the write amplifier',
    );
    // MEASURED AFTER: 1.
    assert.equal(banned, 1, `one caller, one window, one ban: got ${banned}`);
  });

  it('records the second caller separately, so the deduplication is per key', async () => {
    // The control for the assertion above. A `return` that suppressed every ban after the first
    // one in the process would satisfy "exactly 1" and would hide every subsequent attacker.
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
