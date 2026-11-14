/**
 * The rate-limit reset control, which exists only when `RATE_LIMIT_RESET_TOKEN` is set and which
 * `loadConfig` refuses in production. `scripts/smoke-test.mjs` drains the address-keyed guest
 * limiter, and the fixed window would refuse its next run. This file also guards address keying
 * against the real route.
 * No database is needed. The limiter runs at `onRequest` and CSRF at `preValidation`, both before
 * the session plugin resolves a cookie.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, ConfigError, type EnvRecord, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, type DatabaseHandle } from '../src/db.ts';
import { forgetRateLimitStoresForTests, resettableStoreInstalled } from '../src/plugins/rate-limit-store.ts';
import { RATE_LIMIT_RESET_PATH, rateLimitKeyFor } from '../src/plugins/security.ts';
import { registerApiRoutes } from '../src/routes/index.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { TEST_DATABASE_URL } from './helpers/database.ts';

const GOOD_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

/** 32 characters, so a same-length wrong token reaches `timingSafeEqual`, not the length guard. */
const RESET_TOKEN = 'r8Kq2ZvN6tB4xM1jL7sD3gH9wC5yA0pE';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: GOOD_SECRET,
    // Generous, so a global 429 never stands in for the route-level limit under test.
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

function stubDatabase(): DatabaseHandle {
  return {
    ping: async () => ({ ok: true }),
    close: async () => undefined,
  };
}

interface Csrf {
  readonly token: string;
  readonly cookie: string;
}

/** The store registry is process-wide, so it is cleared before each app is built. */
async function buildIsolatedApp(config: AppConfig): Promise<{ app: FastifyInstance; csrf: Csrf }> {
  forgetRateLimitStoresForTests();
  const app = await buildApp({ config, database: stubDatabase() });
  // Without a CSRF token a POST is refused before routing, so a bare "not 404" proves nothing.
  app.get('/api/v1/test-csrf', (_request, reply) => ({ token: reply.generateCsrf() }));
  await app.ready();

  const minted = await app.inject({ method: 'GET', url: '/api/v1/test-csrf' });
  assert.equal(minted.statusCode, 200, minted.body);
  const body: { readonly token?: unknown } = minted.json();
  const secret = minted.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'the CSRF plugin issued no secret cookie');
  return { app, csrf: { token: String(body.token), cookie: `prl_csrf=${secret.value}` } };
}

function postReset(
  app: FastifyInstance,
  csrf: Csrf,
  authorization: string | undefined,
  sessionCookie: string,
) {
  return app.inject({
    method: 'POST',
    url: RATE_LIMIT_RESET_PATH,
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrf.token,
      cookie: `${csrf.cookie}; ${sessionCookie}`,
      ...(authorization === undefined ? {} : { authorization }),
    },
    payload: {},
  });
}

/** An unsigned cookie keys on the address, so a test that wants two buckets needs two signed cookies. */
function sessionCookie(app: FastifyInstance, value: string): string {
  return `prl_session=${app.signCookie(value)}`;
}

function errorCode(body: string): string {
  const parsed: { readonly error?: { readonly code?: unknown } } = JSON.parse(body);
  return String(parsed.error?.code);
}

describe('the rate-limit reset control refuses anything but the configured token', () => {
  let app: FastifyInstance;
  let csrf: Csrf;

  before(async () => {
    ({ app, csrf } = await buildIsolatedApp(testConfig({ RATE_LIMIT_RESET_TOKEN: RESET_TOKEN })));
  });
  after(async () => {
    await app?.close();
  });

  it('refuses a request with no Authorization header at all', async () => {
    const response = await postReset(app, csrf, undefined, 'prl_session=no-auth');
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(errorCode(response.body), 'not_authenticated');
  });

  it('refuses a wrong token of the SAME LENGTH, which is the timingSafeEqual path', async () => {
    const wrong = `${RESET_TOKEN.slice(0, -1)}X`;
    assert.equal(wrong.length, RESET_TOKEN.length, 'this control is worthless unless the lengths match');
    assert.notEqual(wrong, RESET_TOKEN);
    const response = await postReset(app, csrf, `Bearer ${wrong}`, 'prl_session=same-length');
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(errorCode(response.body), 'not_authenticated');
  });

  it('refuses a wrong token of a DIFFERENT length, which is the length guard', async () => {
    // `timingSafeEqual` throws on unequal lengths, which would be a 500, not a 401.
    const short = RESET_TOKEN.slice(0, 8);
    const response = await postReset(app, csrf, `Bearer ${short}`, 'prl_session=short');
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(errorCode(response.body), 'not_authenticated');
  });

  it('refuses a bearer prefix with an empty token, and a token with no bearer prefix', async () => {
    const empty = await postReset(app, csrf, 'Bearer    ', 'prl_session=empty');
    assert.equal(empty.statusCode, 401, empty.body);
    const bare = await postReset(app, csrf, RESET_TOKEN, 'prl_session=bare');
    assert.equal(bare.statusCode, 401, bare.body);
  });

  it('is not exempt from CSRF, because a mutating route that empties a limiter must not be', async () => {
    const response = await app.inject({
      method: 'POST',
      url: RATE_LIMIT_RESET_PATH,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${RESET_TOKEN}` },
      payload: {},
    });
    assert.equal(response.statusCode, 403, response.body);
    // The body is the plugin's own shape, because this route is added before `registerErrorHandlers`
    // binds the contract handler. Only status and reason are asserted.
    assert.match(response.body, /csrf/i, `expected a CSRF refusal, got ${response.body}`);
  });
});

describe('the rate-limit reset control actually clears counters', () => {
  let app: FastifyInstance;
  let csrf: Csrf;

  before(async () => {
    // The reset uses a different cookie, and so a different bucket, because it is not exempt.
    ({ app, csrf } = await buildIsolatedApp(
      testConfig({ RATE_LIMIT_RESET_TOKEN: RESET_TOKEN, RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' }),
    ));
  });
  after(async () => {
    await app?.close();
  });

  it('installs the resettable store only because a token is configured', () => {
    assert.equal(resettableStoreInstalled(), true);
  });

  it('turns a 429 back into a 200 without waiting out the window', async () => {
    const probe = (session: string) =>
      app.inject({ method: 'GET', url: '/api/v1/ready', headers: { cookie: sessionCookie(app, session) } });

    assert.equal((await probe('drained')).statusCode, 200);
    assert.equal((await probe('drained')).statusCode, 200);
    const overLimit = await probe('drained');
    // The negative control. Without this 429 the later 200 would prove nothing.
    assert.equal(overLimit.statusCode, 429, overLimit.body);
    assert.equal(errorCode(overLimit.body), 'rate_limited');

    const reset = await postReset(app, csrf, `Bearer ${RESET_TOKEN}`, sessionCookie(app, 'resetter'));
    assert.equal(reset.statusCode, 200, reset.body);
    const cleared: { readonly cleared?: unknown } = reset.json();
    assert.ok(
      typeof cleared.cleared === 'number' && cleared.cleared >= 1,
      `the reset reported ${String(cleared.cleared)} counters cleared; a reset that clears nothing ` +
        'is indistinguishable from one that worked, which is the confusion this control must not create',
    );

    const afterReset = await probe('drained');
    assert.equal(afterReset.statusCode, 200, afterReset.body);
  });
});

describe('the rate-limit reset control does not exist without a token', () => {
  let app: FastifyInstance;
  let csrf: Csrf;

  before(async () => {
    ({ app, csrf } = await buildIsolatedApp(testConfig()));
  });
  after(async () => {
    await app?.close();
  });

  it('leaves the library store in place, so nothing in the process can empty a counter', () => {
    assert.equal(resettableStoreInstalled(), false);
  });

  it('answers 404 rather than 401, so the route is absent and not merely closed', async () => {
    const response = await postReset(app, csrf, `Bearer ${RESET_TOKEN}`, 'prl_session=absent');
    // 403 would mean refused before routing, which hides a wrong path.
    assert.notEqual(response.statusCode, 403, `refused before routing: ${response.body}`);
    assert.equal(response.statusCode, 404, response.body);
  });
});

describe('loadConfig and RATE_LIMIT_RESET_TOKEN', () => {
  it('refuses to start a production process that carries the variable', () => {
    // The token disables rate limiting for its holder, and a staging .env copied to production carries it.
    try {
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://poker:poker@db.internal:5432/poker_risk_lab',
        PUBLIC_WEB_ORIGIN: 'https://app.example.test',
        SESSION_COOKIE_SECRET: GOOD_SECRET,
        RATE_LIMIT_RESET_TOKEN: RESET_TOKEN,
      });
    } catch (error) {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
      const named = error.problems.some((problem) => problem.includes('RATE_LIMIT_RESET_TOKEN'));
      assert.ok(
        named,
        `no problem named the variable. Problems were:\n${error.problems.map((p) => `  - ${p}`).join('\n')}`,
      );
      return;
    }
    assert.fail('production accepted RATE_LIMIT_RESET_TOKEN; the reset control is reachable in production');
  });

  it('accepts the same environment when it is not production, and says so out loud', () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: GOOD_SECRET,
      RATE_LIMIT_RESET_TOKEN: RESET_TOKEN,
    });
    assert.equal(config.rateLimitResetToken, RESET_TOKEN);
    assert.ok(
      config.warnings.some((warning) => warning.includes('RATE_LIMIT_RESET_TOKEN')),
      'enabling a control that empties the rate limiter must leave a trace at boot',
    );
  });

  it('leaves the token null when the variable is absent', () => {
    assert.equal(testConfig().rateLimitResetToken, null);
  });
});

describe('POST /auth/guest is keyed on the address, not on the session it issues', () => {
  let app: FastifyInstance;

  before(async () => {
    configureDatabase(testConfig());
    forgetRateLimitStoresForTests();
    app = await buildApp({ config: testConfig({ RATE_LIMIT_GUEST_MAX: '1' }), database: stubDatabase() });
    // The negative control uses the default key generator, which prefers the session cookie.
    app.get('/api/v1/test-session-keyed', { config: { rateLimit: { max: 1, timeWindow: 60_000 } } }, () => ({
      ok: true,
    }));
    await registerApiRoutes(app);
    await app.ready();
  });

  after(async () => {
    await app?.close();
    await closeSharedPool();
    await closeDatabase(0);
  });

  /**
   * Token-less, so the limiter counts the request and CSRF refuses it before the handler. 403 means
   * allowed by the limiter, 429 means refused.
   */
  const createGuest = (session: string) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      headers: { 'content-type': 'application/json', cookie: `prl_session=${session}` },
      payload: { displayName: 'Probe' },
    });

  it('counts a second creation from the same address even though the cookie changed', async () => {
    const first = await createGuest('cookie-issued-by-the-first-call');
    assert.equal(first.statusCode, 403, `expected the CSRF refusal, got ${first.body}`);
    assert.equal(errorCode(first.body), 'csrf_failed');

    const second = await createGuest('a-completely-different-session-cookie');
    assert.equal(
      second.statusCode,
      429,
      'the guest limiter let a caller reset its budget by presenting the new cookie the route just ' +
        `issued it. That is the defect clientKeyedRateLimit exists for. Got: ${second.body}`,
    );
    assert.equal(errorCode(second.body), 'rate_limited');
  });

  /**
   * Asserted against the key generator directly, because no rate-limited route skips session
   * resolution, and a signed cookie against the stub database answers 500.
   */
  it('would notice: the key generator DOES give a rotated SIGNED cookie a fresh bucket', () => {
    const keyOf = (cookie: string | undefined) =>
      rateLimitKeyFor(
        {
          cookies: cookie === undefined ? {} : { prl_session: cookie },
          unsignCookie: (value: string) => app.unsignCookie(value),
          clientKey: 'a-fixed-address-key',
          ip: '203.0.113.7',
        } as unknown as Parameters<typeof rateLimitKeyFor>[0],
        app.appConfig,
      );

    const a = keyOf(app.signCookie('session-a'));
    const b = keyOf(app.signCookie('session-b'));
    assert.notEqual(a, b, 'two genuine sessions must not share a bucket');
    assert.ok(
      a.startsWith('s:') && b.startsWith('s:'),
      `signed cookies must key on the session: ${a} / ${b}`,
    );

    // Invented values are not sessions, so they share the caller's address bucket.
    const anonymous = keyOf(undefined);
    for (const forged of [
      'forged-1',
      'forged-2',
      'x'.repeat(64),
      `${app.signCookie('real').split('.')[0]}.bad`,
    ]) {
      assert.equal(
        keyOf(forged),
        anonymous,
        `an unverified cookie (${forged.slice(0, 12)}…) reached a bucket of its own`,
      );
    }
    assert.ok(anonymous.startsWith('c:'));
  });

  /**
   * `@fastify/cookie` parses but does not verify, so a key over the raw cookie gives a rotating
   * garbage cookie a fresh bucket per request (60 requests, zero 429s against a limit of 3).
   */
  it('a rotated UNSIGNED cookie does not start a fresh bucket, because it is not a session', async () => {
    const forged = (value: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/test-session-keyed',
        headers: { cookie: `prl_session=${value}` },
      });

    // The limit is one. This also proves the route is reachable.
    assert.equal((await forged('forged-1')).statusCode, 200);
    for (const value of ['forged-2', 'forged-3', 'forged-4', 'forged-5']) {
      const refused = await forged(value);
      assert.equal(
        refused.statusCode,
        429,
        `an invented session cookie reached a fresh rate-limit bucket (${value}): ${refused.body}`,
      );
      assert.equal(errorCode(refused.body), 'rate_limited');
    }
    const tampered = await forged(`${app.signCookie('forged-6').split('.')[0]}.not-a-signature`);
    assert.equal(tampered.statusCode, 429, `a tampered signature reached a fresh bucket: ${tampered.body}`);
  });
});
