/**
 * Security-layer tests, run against a real Fastify instance with `app.inject()`.
 *
 * `inject()` drives the whole request lifecycle — hooks, validation, serialization, the error
 * handler — without opening a socket, so these are real end-to-end assertions with no port,
 * no fixture server and no timing flakiness.
 *
 * No database is involved: `buildApp` takes a `DatabaseHandle`, and the stubs below are all
 * these tests need. That seam is deliberate; if it ever stops working, this file stops
 * compiling, which is the right way to find out.
 *
 * The test routes registered here (`/api/v1/test-*`) exist only in this file. Routes are
 * added after `buildApp` returns and before the first `inject()`, which is exactly the seam
 * other agents will use.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_MESSAGES } from '@prl/contracts';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle, DbCheck } from '../src/db.ts';
import { CENSOR, isSensitiveKey, pathOf, queryKeysOf, scrubLogObject } from '../src/logging.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const FOREIGN_ORIGIN = 'https://evil.example.test';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so the header assertions below are never the thing that trips the limiter.
    // The 429 shape gets its own app with a limit of one.
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

/** A stub that answers without a database. `ok: false` exercises the degraded path. */
function stubDatabase(check: DbCheck = { ok: true }): DatabaseHandle {
  return {
    ping: async () => check,
    close: async () => undefined,
  };
}

/**
 * Builds an app with the handful of routes these tests need.
 *
 * `/api/v1/test-boom` throws an error whose message looks exactly like the kind of internal
 * detail that must never reach a client.
 */
async function appWithTestRoutes(options: { config?: AppConfig; database?: DatabaseHandle } = {}) {
  const app = await buildApp({
    config: options.config ?? testConfig(),
    database: options.database ?? stubDatabase(),
  });

  app.get('/api/v1/test-csrf', async (_request, reply) => ({ token: reply.generateCsrf() }));
  app.post('/api/v1/test-mutate', async () => ({ mutated: true }));
  app.post('/api/v1/test-guest', { schema: { body: { $ref: 'prl:createGuestBody#' } } }, async () => ({
    accepted: true,
  }));
  // A rejected promise rather than an `async` throw, only because an async function with no
  // `await` is a lint error. Fastify sees the same thing either way.
  app.get('/api/v1/test-boom', () =>
    Promise.reject(new Error('SELECT session_token FROM sessions WHERE id = 42 -- internal detail')),
  );

  return app;
}

function header(headers: Record<string, unknown>, name: string): string {
  const value = headers[name];
  assert.ok(
    value !== undefined,
    `expected a ${name} header; headers were ${Object.keys(headers).join(', ')}`,
  );
  return Array.isArray(value) ? value.join(', ') : String(value);
}

interface ApiErrorShape {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly fields?: Readonly<Record<string, string>>;
    readonly retryAfterSeconds?: number;
  };
}

/** Asserts the body is the contract's error shape and returns it. */
function asApiError(body: unknown): ApiErrorShape {
  assert.ok(typeof body === 'object' && body !== null, 'error body must be an object');
  assert.ok('error' in body, 'error body must have an `error` member');
  const outer: { readonly error?: unknown } = body;
  const error = outer.error;
  assert.ok(typeof error === 'object' && error !== null, '`error` must be an object');
  const shape: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly requestId?: unknown;
    readonly fields?: unknown;
    readonly retryAfterSeconds?: unknown;
  } = error;
  assert.equal(typeof shape.code, 'string');
  assert.equal(typeof shape.message, 'string');
  assert.equal(typeof shape.requestId, 'string');
  assert.notEqual(shape.requestId, '');
  const fields =
    typeof shape.fields === 'object' && shape.fields !== null
      ? (Object.fromEntries(
          Object.entries(shape.fields).map(([key, value]) => [key, String(value)]),
        ) as Record<string, string>)
      : undefined;
  const retryAfterSeconds = typeof shape.retryAfterSeconds === 'number' ? shape.retryAfterSeconds : undefined;
  return {
    error: {
      code: String(shape.code),
      message: String(shape.message),
      requestId: String(shape.requestId),
      ...(fields === undefined ? {} : { fields }),
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

/** Mints a CSRF secret cookie and its matching token. */
async function csrfPair(app: FastifyInstance): Promise<{ token: string; cookie: string }> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/test-csrf' });
  assert.equal(response.statusCode, 200);
  const body: unknown = response.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body);
  const payload: { readonly token?: unknown } = body;
  assert.equal(typeof payload.token, 'string');
  const secret = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'generateCsrf should set the prl_csrf cookie');
  return { token: String(payload.token), cookie: secret.value };
}

/**
 * Headers that must be on **every** response, not just the ones a handler produced.
 *
 * This list is the reason the security layer registers helmet in `onRequest` rather than
 * `onSend`: a 404, a 429, a refused preflight and a 500 are all answered before (or instead
 * of) a handler, and a header set that only appears on the happy path protects nothing on the
 * responses an attacker is actually provoking. The failure is easy to introduce — moving one
 * hook, or answering a request from an earlier hook — and invisible to a suite that only ever
 * asserts against `/health`.
 *
 * `strict-transport-security` is checked separately, because it is production-only.
 */
const ALWAYS_PRESENT_HEADERS = [
  'content-security-policy',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'x-permitted-cross-domain-policies',
  'x-request-id',
  'cache-control',
] as const;

/** One non-handler path: what to send, and the status that proves it took that path. */
interface HeaderCase {
  readonly label: string;
  readonly options: InjectOptions;
  readonly status: number;
}

const NON_HANDLER_CASES: readonly HeaderCase[] = [
  { label: '404 for an unknown route', options: { method: 'GET', url: '/api/v1/nope' }, status: 404 },
  // Answered by the error handler, not the route.
  { label: '500 from a throwing handler', options: { method: 'GET', url: '/api/v1/test-boom' }, status: 500 },
  // Answered by the CSRF hook, before validation.
  {
    label: '403 from the CSRF check',
    options: { method: 'POST', url: '/api/v1/test-mutate', payload: {} },
    status: 403,
  },
  // Answered inside the CORS onRequest hook — the case most likely to lose headers, because
  // it replies from a hook rather than returning a value.
  {
    label: '403 from a refused preflight',
    options: {
      method: 'OPTIONS',
      url: '/api/v1/test-mutate',
      headers: { origin: FOREIGN_ORIGIN, 'access-control-request-method': 'POST' },
    },
    status: 403,
  },
  {
    label: '204 from an accepted preflight',
    options: {
      method: 'OPTIONS',
      url: '/api/v1/test-mutate',
      headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'POST' },
    },
    status: 204,
  },
  {
    label: '403 from a cross-origin mutation',
    options: { method: 'POST', url: '/api/v1/test-mutate', payload: {}, headers: { origin: FOREIGN_ORIGIN } },
    status: 403,
  },
];

describe('security headers', () => {
  it('sets a strict Content-Security-Policy with no unsafe-inline', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);

    const csp = header(response.headers, 'content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.match(csp, /script-src 'none'/);
    // The two that make a CSP decorative rather than protective.
    assert.ok(!csp.includes('unsafe-inline'), `CSP must not allow unsafe-inline: ${csp}`);
    assert.ok(!csp.includes('unsafe-eval'), `CSP must not allow unsafe-eval: ${csp}`);
    assert.ok(!csp.includes('*'), `CSP must not contain a wildcard source: ${csp}`);

    await app.close();
  });

  it('sets the rest of the header set', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    assert.equal(header(response.headers, 'x-content-type-options'), 'nosniff');
    assert.equal(header(response.headers, 'x-frame-options'), 'DENY');
    assert.equal(header(response.headers, 'referrer-policy'), 'no-referrer');
    assert.equal(header(response.headers, 'cross-origin-opener-policy'), 'same-origin');
    assert.equal(header(response.headers, 'cross-origin-embedder-policy'), 'require-corp');
    assert.equal(header(response.headers, 'cross-origin-resource-policy'), 'same-origin');
    assert.equal(header(response.headers, 'x-permitted-cross-domain-policies'), 'none');
    assert.equal(header(response.headers, 'cache-control'), 'no-store');
    assert.match(header(response.headers, 'vary'), /Origin/);

    await app.close();
  });

  it('echoes a generated request id and ignores one the caller supplies', async () => {
    const app = await appWithTestRoutes();
    const forged = 'forged-request-id-from-the-client';
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'request-id': forged, 'x-request-id': forged },
    });

    const echoed = header(response.headers, 'x-request-id');
    assert.notEqual(echoed, forged, 'a caller must not be able to choose the request id');
    assert.match(echoed, /^[0-9a-f-]{36}$/);

    await app.close();
  });

  it('keeps the whole header set on responses that never reach a handler', async () => {
    const app = await appWithTestRoutes();

    for (const testCase of NON_HANDLER_CASES) {
      const response = await app.inject(testCase.options);
      assert.equal(response.statusCode, testCase.status, `${testCase.label}: wrong status`);
      for (const name of ALWAYS_PRESENT_HEADERS) {
        assert.ok(
          response.headers[name] !== undefined,
          `${testCase.label} lost the ${name} header; present were ` +
            Object.keys(response.headers).join(', '),
        );
      }
    }

    await app.close();
  });

  it('keeps the header set on a 429, which is answered before any route logic', async () => {
    // Its own app, because proving this needs a limit of one and the cases above need headroom.
    const app = await appWithTestRoutes({ config: testConfig({ RATE_LIMIT_MAX: '1' }) });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 200);

    const limited = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(limited.statusCode, 429);
    for (const name of ALWAYS_PRESENT_HEADERS) {
      assert.ok(limited.headers[name] !== undefined, `a 429 lost the ${name} header`);
    }

    await app.close();
  });

  it('sends HSTS on an error response too, not only on a healthy one', async () => {
    // A transport-security header that appears only on 200s leaves every error response
    // downgradeable, which is precisely the request an attacker gets to choose.
    const app = await appWithTestRoutes({
      config: testConfig({
        NODE_ENV: 'production',
        PUBLIC_WEB_ORIGIN: 'https://app.example.test',
        LOG_LEVEL: 'silent',
      }),
    });

    const notFound = await app.inject({ method: 'GET', url: '/api/v1/nope' });
    assert.equal(notFound.statusCode, 404);
    assert.match(header(notFound.headers, 'strict-transport-security'), /max-age=31536000/);

    const thrown = await app.inject({ method: 'GET', url: '/api/v1/test-boom' });
    assert.equal(thrown.statusCode, 500);
    assert.match(header(thrown.headers, 'strict-transport-security'), /max-age=31536000/);

    await app.close();
  });

  it('omits HSTS outside production and sends it in production', async () => {
    const dev = await appWithTestRoutes();
    const devResponse = await dev.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(devResponse.headers['strict-transport-security'], undefined);
    await dev.close();

    const production = await appWithTestRoutes({
      config: testConfig({
        NODE_ENV: 'production',
        PUBLIC_WEB_ORIGIN: 'https://app.example.test',
        // Only so this test does not print request logs. NODE_ENV=production would otherwise
        // switch the logger on, which is exactly what it should do.
        LOG_LEVEL: 'silent',
      }),
    });
    const prodResponse = await production.inject({ method: 'GET', url: '/api/v1/health' });
    assert.match(header(prodResponse.headers, 'strict-transport-security'), /max-age=31536000/);
    await production.close();
  });
});

describe('CSRF', () => {
  it('rejects a mutating request with no token, in the ApiError shape', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: 'POST', url: '/api/v1/test-mutate', payload: {} });

    assert.equal(response.statusCode, 403);
    const body = asApiError(response.json());
    assert.equal(body.error.code, 'csrf_failed');
    assert.equal(body.error.message, ERROR_MESSAGES.csrf_failed);
    assert.equal(body.error.requestId, header(response.headers, 'x-request-id'));

    await app.close();
  });

  it('rejects a token that does not match the cookie', async () => {
    const app = await appWithTestRoutes();
    const { cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test-mutate',
      payload: {},
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': 'not-the-right-token' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(asApiError(response.json()).error.code, 'csrf_failed');

    await app.close();
  });

  it('accepts a matching cookie and header', async () => {
    const app = await appWithTestRoutes();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test-mutate',
      payload: {},
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });

    assert.equal(response.statusCode, 200);
    await app.close();
  });

  it('does not require a token on GET', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    await app.close();
  });
});

describe('CORS', () => {
  it('reflects an allowlisted origin with credentials, and never a wildcard', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: ALLOWED_ORIGIN },
    });

    assert.equal(header(response.headers, 'access-control-allow-origin'), ALLOWED_ORIGIN);
    assert.equal(header(response.headers, 'access-control-allow-credentials'), 'true');
    assert.notEqual(header(response.headers, 'access-control-allow-origin'), '*');
    assert.match(header(response.headers, 'access-control-expose-headers'), /x-request-id/);
    assert.match(header(response.headers, 'vary'), /Origin/);

    await app.close();
  });

  it('sends no CORS headers for an origin that is not allowlisted', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: FOREIGN_ORIGIN },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    await app.close();
  });

  it('refuses a state-changing request from an origin that is not allowlisted', async () => {
    const app = await appWithTestRoutes();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test-mutate',
      payload: {},
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token, origin: FOREIGN_ORIGIN },
    });

    // Blocking only the *reading* of the response would still let the side effect happen.
    assert.equal(response.statusCode, 403);
    assert.equal(asApiError(response.json()).error.code, 'forbidden');
    await app.close();
  });

  it('answers a preflight from an allowlisted origin', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/test-mutate',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-csrf-token',
      },
    });

    assert.equal(response.statusCode, 204);
    assert.match(header(response.headers, 'access-control-allow-methods'), /POST/);
    assert.match(header(response.headers, 'access-control-allow-headers'), /x-csrf-token/);
    assert.equal(header(response.headers, 'access-control-allow-origin'), ALLOWED_ORIGIN);
    await app.close();
  });

  it('refuses a preflight from an origin that is not allowlisted', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v1/test-mutate',
      headers: { origin: FOREIGN_ORIGIN, 'access-control-request-method': 'POST' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(asApiError(response.json()).error.code, 'forbidden');
    await app.close();
  });
});

describe('error handling', () => {
  it('returns the ApiError shape for an unknown route', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: 'GET', url: '/api/v1/there-is-no-such-thing' });

    assert.equal(response.statusCode, 404);
    const body = asApiError(response.json());
    assert.equal(body.error.code, 'content_not_found');
    assert.equal(body.error.message, ERROR_MESSAGES.content_not_found);
    assert.equal(header(response.headers, 'cache-control'), 'no-store');
    await app.close();
  });

  it('does not leak an internal error message, a stack or a SQL fragment', async () => {
    const app = await appWithTestRoutes();
    const response = await app.inject({ method: 'GET', url: '/api/v1/test-boom' });

    assert.equal(response.statusCode, 500);
    const body = asApiError(response.json());
    assert.equal(body.error.code, 'internal_error');
    assert.equal(body.error.message, ERROR_MESSAGES.internal_error);

    const raw = response.payload;
    for (const leak of ['SELECT', 'session_token', 'internal detail', 'sessions', 'at ', '.ts:']) {
      assert.ok(!raw.includes(leak), `response leaked "${leak}": ${raw}`);
    }
    // The request id is the only bridge between the client and the log line.
    assert.equal(body.error.requestId, header(response.headers, 'x-request-id'));
    await app.close();
  });

  it('maps an oversized body to payload_too_large', async () => {
    const app = await appWithTestRoutes({ config: testConfig({ BODY_LIMIT_BYTES: '1024' }) });
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test-mutate',
      payload: { blob: 'x'.repeat(4096) },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    });

    assert.equal(response.statusCode, 413);
    assert.equal(asApiError(response.json()).error.code, 'payload_too_large');
    await app.close();
  });

  it('maps an unparseable JSON body to invalid_request', async () => {
    const app = await appWithTestRoutes();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test-mutate',
      payload: '{not json',
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token, 'content-type': 'application/json' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(asApiError(response.json()).error.code, 'invalid_request');
    await app.close();
  });

  it('maps a schema failure to invalid_request with per-field messages', async () => {
    const app = await appWithTestRoutes();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test-guest',
      payload: { displayName: 'x' },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });

    assert.equal(response.statusCode, 400);
    const body = asApiError(response.json());
    assert.equal(body.error.code, 'invalid_request');
    assert.ok(body.error.fields !== undefined, 'invalid_request should carry field detail');
    assert.ok('displayName' in body.error.fields, `expected a displayName field: ${response.payload}`);
    await app.close();
  });

  it('rejects an unknown field rather than silently dropping it', async () => {
    const app = await appWithTestRoutes();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/test-guest',
      payload: { displayName: 'Ada', smuggled: 999 },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });

    assert.equal(response.statusCode, 400);
    const body = asApiError(response.json());
    assert.equal(body.error.code, 'invalid_request');
    assert.ok(body.error.fields !== undefined);
    assert.ok('smuggled' in body.error.fields, `expected the rejected key to be named: ${response.payload}`);
    await app.close();
  });
});

describe('rate limiting', () => {
  it('answers rate_limited with retryAfterSeconds and a Retry-After header', async () => {
    const app = await appWithTestRoutes({
      config: testConfig({ RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '60000' }),
    });

    const first = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(first.statusCode, 200);

    const second = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(second.statusCode, 429);
    const body = asApiError(second.json());
    assert.equal(body.error.code, 'rate_limited');
    assert.ok((body.error.retryAfterSeconds ?? 0) > 0, 'the body must say when to retry');
    assert.ok(Number(header(second.headers, 'retry-after')) > 0);

    await app.close();
  });

  it('counts a request before the CSRF check does, so a flood cannot be free', async () => {
    // The ordering claim in plugins/security.ts, asserted. If the CSRF hook ever moves back to
    // `onRequest`, this returns 403 and a caller can hammer the server without being counted.
    const app = await appWithTestRoutes({ config: testConfig({ RATE_LIMIT_MAX: '1' }) });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 200);

    const overLimit = await app.inject({ method: 'POST', url: '/api/v1/test-mutate', payload: {} });
    assert.equal(overLimit.statusCode, 429);
    assert.equal(asApiError(overLimit.json()).error.code, 'rate_limited');
    await app.close();
  });

  it('does not let a forged X-Forwarded-For move the caller to a fresh bucket', async () => {
    const app = await appWithTestRoutes({ config: testConfig({ RATE_LIMIT_MAX: '1' }) });
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/ready' })).statusCode, 200);

    const spoofed = await app.inject({
      method: 'GET',
      url: '/api/v1/ready',
      headers: { 'x-forwarded-for': '9.9.9.9' },
    });
    // TRUST_PROXY is false, so the header is ignored and the bucket is unchanged.
    assert.equal(spoofed.statusCode, 429);
    await app.close();
  });

  it('leaves liveness exempt so a probe cannot be limited into failing', async () => {
    const app = await appWithTestRoutes({ config: testConfig({ RATE_LIMIT_MAX: '1' }) });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
      assert.equal(response.statusCode, 200, `attempt ${attempt} should not be rate limited`);
    }
    await app.close();
  });
});

describe('log redaction', () => {
  it('censors anything whose key name looks sensitive, at any depth', () => {
    const scrubbed = scrubLogObject({
      sessionToken: 'SESSION-VALUE',
      nested: {
        inviteCode: 'JOIN-1234',
        deep: { refreshToken: 'REFRESH-VALUE', clientSecret: 'CLIENT-VALUE' },
      },
      list: [{ password: 'PASSWORD-VALUE' }, { authorization: 'Bearer BEARER-VALUE' }],
      keep: 'this is fine',
    });

    const asText = JSON.stringify(scrubbed);
    const secrets = [
      'SESSION-VALUE',
      'JOIN-1234',
      'REFRESH-VALUE',
      'CLIENT-VALUE',
      'PASSWORD-VALUE',
      'BEARER-VALUE',
    ];
    for (const secret of secrets) {
      assert.ok(!asText.includes(secret), `"${secret}" survived redaction: ${asText}`);
    }
    assert.match(asText, /this is fine/);
    assert.equal(scrubbed['sessionToken'], CENSOR);
  });

  it('censors user-supplied text and hidden game state, which no key name hints at', () => {
    for (const key of ['displayName', 'holeCards', 'deck', 'salt', 'commitmentSalt']) {
      assert.ok(isSensitiveKey(key), `${key} must be treated as sensitive`);
    }
    // Fields we rely on in log lines must NOT be censored, or the logs stop being useful.
    for (const key of ['clientKey', 'routePattern', 'statusCode', 'method', 'reqId', 'apiErrorCode']) {
      assert.ok(!isSensitiveKey(key), `${key} must stay readable`);
    }
  });

  it('survives a cyclic object instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    const scrubbed = scrubLogObject({ cyclic });
    assert.match(JSON.stringify(scrubbed), /circular/);
  });

  it('keeps query parameter names and drops their values', () => {
    const url = '/api/v1/auth/oidc/callback?code=super-secret-authorization-code&state=xyz';
    assert.deepEqual(queryKeysOf(url), ['code', 'state']);
    assert.equal(pathOf(url), '/api/v1/auth/oidc/callback');
  });
});

describe('health and readiness', () => {
  it('reports ok from liveness without touching the database', async () => {
    let pinged = false;
    const app = await appWithTestRoutes({
      database: {
        ping: () => {
          pinged = true;
          return Promise.resolve({ ok: true });
        },
        close: async () => undefined,
      },
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', version: '0.1.0', protocolVersion: 1 });
    assert.equal(pinged, false, 'liveness must not query the database');
    await app.close();
  });

  it('reports ready when the database answers', async () => {
    const app = await appWithTestRoutes({ database: stubDatabase({ ok: true }) });
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ready', checks: { database: { ok: true } } });
    await app.close();
  });

  it('reports degraded with a 503, and no driver detail, when it does not', async () => {
    const app = await appWithTestRoutes({
      database: stubDatabase({ ok: false, detail: 'database did not answer' }),
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      status: 'degraded',
      checks: { database: { ok: false, detail: 'database did not answer' } },
    });
    await app.close();
  });
});
