/**
 * The rate-limit reset control, and the property that made it necessary.
 *
 * ## What this file is for
 *
 * `scripts/smoke-test.mjs` ends by deliberately exhausting the guest-creation limiter, because
 * proving a limiter exists means making it fire. That limiter is keyed on the caller's ADDRESS —
 * it has to be, since `POST /auth/guest` issues the very session a session-keyed limiter would let
 * the caller rotate — and `@fastify/rate-limit`'s window is fixed rather than sliding. So one run
 * ends with the bucket drained and most of a window still to go, and the next run is refused at its
 * second section. Four later sections then fail for a reason that has nothing to do with rooms,
 * hand history or progress.
 *
 * Two mechanisms close that, and both are asserted here:
 *
 *   1. `POST /api/v1/_test/rate-limit/reset`, which exists ONLY when `RATE_LIMIT_RESET_TOKEN` is
 *      configured, and which `loadConfig` makes impossible in production.
 *   2. Nothing — the harness waits out the window instead. That path is pure and is tested in
 *      `scripts/smoke-test.test.mjs`; what this file owes it is the proof that the control it
 *      prefers is genuinely absent where it must be, so the fallback is not decoration.
 *
 * ## Why the address-keying assertion lives here rather than only in the smoke script
 *
 * The regression `clientKeyedRateLimit` exists for — a session-minting route whose limit never
 * accumulates, because the client presents a new cookie on every request and therefore a new
 * bucket — was found by the smoke script and, until this file, was guarded ONLY by the smoke
 * script. That is a guard whose own last section breaks the next run of the guard. Circular, and
 * one flaky release-gate run away from being deleted. It is asserted here against the real route,
 * with `app.inject`, in a second.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Checked by breaking each one on purpose while writing them:
 *
 *  * **Token check.** Both halves of `secretsMatch` are driven: a wrong token of the SAME LENGTH
 *    reaches `timingSafeEqual`, a wrong token of a DIFFERENT length is stopped by the length
 *    guard, and a missing header takes neither path. Replacing the whole check with `return true`
 *    makes three assertions fail; replacing it with `return false` makes the positive control
 *    ("the right token clears the counters") fail. Both directions are present, which is what
 *    stops this being a file that would pass against a function that refuses everything.
 *  * **The reset actually resetting.** The 429 that precedes it is the negative control: it proves
 *    the counter was genuinely over the limit, so the 200 afterwards cannot be explained by the
 *    limiter having been inert all along.
 *  * **Absence without a token.** Asserted through a POST that carries a valid CSRF token, so a
 *    404 means "no such route" rather than "refused before routing" — the exact ambiguity that hid
 *    three wrong path constants in `load-test.mjs` for the whole of its existence.
 *  * **Address keying.** The negative control is a second route on the SAME app with the SAME
 *    limit and the DEFAULT key generator: rotating the session cookie is asserted to reset that
 *    one's counter. Without it, "the guest route still 429s" would also pass on a server where the
 *    limiter counted every request in one global bucket.
 *
 * No database is required. Every request here is answered before `preHandler`, which is where the
 * session plugin resolves a cookie — the rate limiter runs at `onRequest` and the CSRF check at
 * `preValidation` — so nothing reaches SQL. That is asserted implicitly by the file passing
 * against `test:without-database` as well as with a database, and stated here so nobody adds a
 * request that quietly needs one.
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

/** A long, high-entropy value that passes the production secret rules. */
const GOOD_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

/**
 * The reset token these tests configure.
 *
 * 32 characters, so that a "wrong token of the same length" is a real 32-character string and the
 * `timingSafeEqual` branch is genuinely reached rather than being skipped by the length guard.
 */
const RESET_TOKEN = 'r8Kq2ZvN6tB4xM1jL7sD3gH9wC5yA0pE';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: GOOD_SECRET,
    // Generous, so the GLOBAL bucket is never the thing that answers. Every limit under test here
    // is a route-level one, and a global 429 would look identical while proving something else.
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

/** A stub that answers without a database. Nothing in this file reaches SQL; see the header. */
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

/**
 * Builds an app, mints a CSRF pair against it, and hands both back.
 *
 * `forgetRateLimitStoresForTests()` first, because the store registry is process-wide: without it,
 * a reset issued against this app would also empty the counters of an app an earlier test built,
 * and `cleared` would count keys that belong to nobody.
 */
async function buildIsolatedApp(config: AppConfig): Promise<{ app: FastifyInstance; csrf: Csrf }> {
  forgetRateLimitStoresForTests();
  const app = await buildApp({ config, database: stubDatabase() });
  // A test-only route purely to mint a CSRF pair. Same device as `harness-paths.test.ts`, and for
  // the same reason: without a token a POST is refused before routing, so a bare "not 404" check
  // would prove nothing at all.
  app.get('/api/v1/test-csrf', (_request, reply) => ({ token: reply.generateCsrf() }));
  await app.ready();

  const minted = await app.inject({ method: 'GET', url: '/api/v1/test-csrf' });
  assert.equal(minted.statusCode, 200, minted.body);
  const body: { readonly token?: unknown } = minted.json();
  const secret = minted.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'the CSRF plugin issued no secret cookie');
  return { app, csrf: { token: String(body.token), cookie: `prl_csrf=${secret.value}` } };
}

/** POSTs the reset control with whatever `Authorization` header the caller wants tested. */
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

/**
 * A session cookie whose signature this app will accept.
 *
 * Tests used to write `prl_session=whatever` and rely on two different strings landing in two
 * different rate-limit buckets. That worked, and it worked for the wrong reason: the limiter
 * hashed the RAW cookie without checking its signature, so any invented value was a fresh
 * bucket — which is precisely the defect `rateLimitKeyFor` was fixed for. Now an unsigned cookie
 * is not a session at all and keys on the address, so a test that wants two buckets has to
 * present two real ones. `app.signCookie` is the same signer the server uses to issue them.
 */
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
    // Same length, so `secretsMatch` gets past the length guard and actually compares bytes. A
    // check that only ever rejected on length would pass every other test in this describe block.
    const wrong = `${RESET_TOKEN.slice(0, -1)}X`;
    assert.equal(wrong.length, RESET_TOKEN.length, 'this control is worthless unless the lengths match');
    assert.notEqual(wrong, RESET_TOKEN);
    const response = await postReset(app, csrf, `Bearer ${wrong}`, 'prl_session=same-length');
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(errorCode(response.body), 'not_authenticated');
  });

  it('refuses a wrong token of a DIFFERENT length, which is the length guard', async () => {
    // `timingSafeEqual` throws on unequal buffer lengths. If the length guard were removed, this
    // would be an unhandled error and a 500 rather than a 401 — a control that crashes instead of
    // refusing is a control an attacker can distinguish.
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
    // The body is `@fastify/csrf-protection`'s own shape here and the contract's `csrf_failed`
    // shape on every other route, and that difference is not a defect in this test. Fastify binds
    // a route's error handler when the route is ADDED, and `registerRateLimitResetRoute` runs
    // inside `securityPlugin` — before `buildApp` calls `registerErrorHandlers`. So the assertion
    // is on the status and the reason, not on a shape that would make this test a hostage to
    // registration order.
    assert.match(response.body, /csrf/i, `expected a CSRF refusal, got ${response.body}`);
  });
});

describe('the rate-limit reset control actually clears counters', () => {
  let app: FastifyInstance;
  let csrf: Csrf;

  before(async () => {
    // A limit of two on ordinary routes, so a handful of injections drives one bucket over it
    // without a loop. The reset call itself uses a different session cookie and therefore a
    // different bucket, because the control is deliberately NOT exempt from the limiter.
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
    // The negative control for everything below: without this 429 the later 200 would prove only
    // that the limiter had never been counting.
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
    // The production posture, asserted directly: `securityPlugin` substitutes the resettable store
    // only when a token is configured, so a process without one keeps `@fastify/rate-limit`'s own
    // `LocalStore` byte for byte.
    assert.equal(resettableStoreInstalled(), false);
  });

  it('answers 404 rather than 401, so the route is absent and not merely closed', async () => {
    const response = await postReset(app, csrf, `Bearer ${RESET_TOKEN}`, 'prl_session=absent');
    // 403 would mean the request never reached the router and this would prove nothing. Asserted
    // rather than assumed, because that is precisely how three wrong path constants survived in
    // `scripts/load-test.mjs` for its entire existence.
    assert.notEqual(response.statusCode, 403, `refused before routing: ${response.body}`);
    assert.equal(response.statusCode, 404, response.body);
  });
});

describe('loadConfig and RATE_LIMIT_RESET_TOKEN', () => {
  it('refuses to start a production process that carries the variable', () => {
    // Not a warning. The token is equivalent to turning rate limiting off for whoever holds it,
    // and the realistic failure is a .env copied from staging with one variable nobody re-read.
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
    // The positive control. Without it, a `loadConfig` that rejected the variable everywhere would
    // pass the test above while making the control unusable in the one place it belongs.
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
    // One guest creation per window, so two injections settle the question. The number is the
    // subject of the test, not a shortcut: what is being asserted is which BUCKET the second
    // request lands in, and any limit greater than zero shows that.
    app = await buildApp({ config: testConfig({ RATE_LIMIT_GUEST_MAX: '1' }), database: stubDatabase() });
    // The negative control lives on the same app, with the same limit and the DEFAULT key
    // generator — the one that prefers the session cookie. It is a GET so that no CSRF token is
    // needed to reach it, and it never touches the database.
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
   * A guest creation with no CSRF token.
   *
   * Deliberately token-less: the rate limiter runs at `onRequest` and the CSRF check at
   * `preValidation`, so the request is COUNTED and then refused without ever reaching the handler,
   * the session plugin or the database. A 403 therefore means "the limiter allowed this one" and a
   * 429 means "the limiter refused it" — exactly the two outcomes under test, with no third.
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
    // The positive control: this one got past the limiter. Without it, a 429 below could mean the
    // route was limited from the very first request and nothing about key rotation.
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
   * The negative control, asserted against the key generator itself rather than over HTTP.
   *
   * It has to be. The property under test is "an ordinary route prefers the session", and
   * demonstrating it needs a rate-limited route that does NOT resolve a session — which does not
   * exist and should not: a cookie whose signature is valid reaches the session store, because
   * that is what a session cookie is for. The HTTP probe this replaced presented a validly signed
   * cookie to a stub database and got a 500, which is the harness talking rather than the limiter.
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

    // The other half, and the regression: invented values are not sessions, so they all land in
    // the caller's address bucket — the same one a caller with no cookie at all gets.
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
   * The regression that made every limiter in this API optional.
   *
   * `rateLimitKeyFor` hashed the raw `prl_session` cookie without checking its signature.
   * `@fastify/cookie` parses cookies; it does not verify them — unsigning is a separate call that
   * happens much later, at session resolution. So the bucket was chosen by a string the caller
   * invents, and any caller who sent a different value each time was never counted at all.
   * Measured against the unfixed code: 60 requests with a rotating garbage cookie, ZERO 429s,
   * against a configured limit of 3. The same trick emptied the expensive limiter in front of
   * `POST /math/equity`, which accepts up to 500,000 Monte Carlo samples per call.
   *
   * The test above is the positive control for the same mechanism: a rotated cookie that IS
   * signed still gets its own bucket, because that is the design. What must not be free is
   * inventing them.
   */
  it('a rotated UNSIGNED cookie does not start a fresh bucket, because it is not a session', async () => {
    const forged = (value: string) =>
      app.inject({
        method: 'GET',
        url: '/api/v1/test-session-keyed',
        headers: { cookie: `prl_session=${value}` },
      });

    // The first forged value is allowed through: the limit is one, and this is that one. It also
    // proves the route is reachable, so the 429s below are the limiter and not a 404.
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
    // A cookie whose signature is present but wrong is the same case, and is worth its own
    // assertion: it is what a caller who has seen a real cookie's SHAPE would send.
    const tampered = await forged(`${app.signCookie('forged-6').split('.')[0]}.not-a-signature`);
    assert.equal(tampered.statusCode, 429, `a tampered signature reached a fresh bucket: ${tampered.body}`);
  });
});
