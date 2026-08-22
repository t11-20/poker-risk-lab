/**
 * The wiring: that the assembled app actually serves every route module, and that the shared
 * state the modules expect somebody else to have registered really is registered.
 *
 * Every other test file in this package builds an app out of one or two modules and its own
 * stand-in for the rest. That is the right way to test a module, and it is precisely why it cannot
 * catch a wiring bug: each harness supplies the seam the real server has to supply for itself. So
 * this file assembles the whole thing the way `src/server.ts` does — `buildApp`, then
 * `registerApiRoutes` — and asks it questions no single module could answer.
 *
 * ## The three failures this is here to catch
 *
 * 1. **A module that is listed but not registered.** `EXPECTED_ROUTE_MODULES` in `app.ts` is the
 *    contract; a module missing from `API_ROUTE_MODULES` is a 404 for a whole feature, and nothing
 *    else fails.
 * 2. **The session decorator not reaching a module's scope.** Fastify's `decorateRequest` is
 *    scoped to the instance it is called on, and `registerRoutes` gives each module its own child.
 *    With `sessionPlugin` registered only inside `routes/auth.ts`, `GET /hands` answers 500 for
 *    everybody and `GET /me/progress` answers 401 even to a signed-in learner. Both are asserted
 *    below as the 401 they should be — a 500 from `/hands` is the exact signature of that bug.
 * 3. **The two probes not answering.** `/health` and `/ready` are registered by `buildApp` before
 *    any route module exists, so a module that throws during registration takes them with it.
 *
 * No database: `buildApp` takes a `DatabaseHandle` and this passes a stub, so `/ready` answers from
 * the stub. `configureDatabase` is still called, because `registerApiRoutes` binds a session store
 * over the pool — postgres.js opens no connection until a query runs, and none of the requests
 * below reaches one.
 */

import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildApp, EXPECTED_ROUTE_MODULES, registerRoutes } from '../src/app.ts';
import { type AppConfig, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, type DatabaseHandle } from '../src/db.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import { API_ROUTE_MODULES, registerApiRoutes } from '../src/routes/index.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { createWsHub } from '../src/ws/hub.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Syntactically valid and never dialled. `loadConfig` insists on a URL, and nothing here
    // issues a query.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
  });
}

/** Answers the readiness probe without a server. `/ready` reports whatever this says. */
const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(undefined),
};

/**
 * Every path the assembled API is expected to serve, with the module that owns it.
 *
 * Written out rather than derived from the router, because a list derived from the thing it is
 * checking cannot detect a missing route. `:param` segments are the router's own patterns, which is
 * what `hasRoute` matches on.
 */
const EXPECTED_ROUTES: readonly { readonly method: 'GET' | 'POST'; readonly url: string }[] = [
  { method: 'POST', url: '/api/v1/auth/guest' },
  { method: 'GET', url: '/api/v1/auth/session' },
  { method: 'POST', url: '/api/v1/auth/logout' },
  { method: 'GET', url: '/api/v1/auth/oidc/start' },
  { method: 'GET', url: '/api/v1/auth/oidc/callback' },
  { method: 'POST', url: '/api/v1/me/units/reset' },
  { method: 'POST', url: '/api/v1/me/delete' },

  { method: 'GET', url: '/api/v1/content/lessons' },
  { method: 'GET', url: '/api/v1/content/lessons/:id' },
  { method: 'GET', url: '/api/v1/content/scenarios' },
  { method: 'GET', url: '/api/v1/content/scenarios/:id' },
  { method: 'GET', url: '/api/v1/content/glossary' },
  { method: 'POST', url: '/api/v1/content/quizzes/:id/attempt' },
  { method: 'POST', url: '/api/v1/content/scenarios/:id/attempt' },

  { method: 'POST', url: '/api/v1/math/equity' },
  { method: 'POST', url: '/api/v1/math/coach' },

  { method: 'POST', url: '/api/v1/rooms' },
  { method: 'POST', url: '/api/v1/rooms/join' },
  { method: 'GET', url: '/api/v1/rooms' },
  { method: 'GET', url: '/api/v1/rooms/:roomId' },
  { method: 'POST', url: '/api/v1/rooms/:roomId/sit' },
  { method: 'POST', url: '/api/v1/rooms/:roomId/leave' },
  { method: 'GET', url: '/api/v1/legends/profiles' },
  { method: 'GET', url: '/api/v1/legends/profiles/:profileId' },
  { method: 'POST', url: '/api/v1/legends/matches' },
  { method: 'POST', url: '/api/v1/legends/compare' },

  { method: 'GET', url: '/api/v1/hands' },
  { method: 'GET', url: '/api/v1/hands/:handId' },

  { method: 'GET', url: '/api/v1/me/progress' },

  { method: 'GET', url: '/api/v1/ws' },
];

let app: FastifyInstance;
let metrics: AppMetrics;

before(async () => {
  const config = testConfig();
  configureDatabase(config);
  metrics = new AppMetrics();
  app = await buildApp({ config, database: stubDatabase, metrics });
  await registerApiRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  await closeSharedPool();
  await closeDatabase(1_000);
});

function errorCodeOf(payload: string): string {
  const parsed: unknown = JSON.parse(payload);
  assert.ok(typeof parsed === 'object' && parsed !== null, `not an object: ${payload.slice(0, 120)}`);
  const error: unknown = Reflect.get(parsed, 'error');
  assert.ok(typeof error === 'object' && error !== null, `no error member in ${payload.slice(0, 120)}`);
  return String(Reflect.get(error, 'code'));
}

describe('the route manifest', () => {
  it('registers a module for every path app.ts expects', async () => {
    assert.ok(EXPECTED_ROUTE_MODULES.length > 0, 'the expectation list itself must not be empty');
    assert.equal(
      API_ROUTE_MODULES.length,
      EXPECTED_ROUTE_MODULES.length,
      'every module app.ts lists must appear in API_ROUTE_MODULES exactly once',
    );
    for (const relative of EXPECTED_ROUTE_MODULES) {
      // The file existing is not the same claim as it being registered — that is what the route
      // assertions below are for — but a listed module with no file is worth its own message.
      await access(path.join(PACKAGE_ROOT, relative));
    }
  });

  it('serves every expected route under the API prefix', () => {
    const missing = EXPECTED_ROUTES.filter((route) => !app.hasRoute(route)).map(
      (route) => `${route.method} ${route.url}`,
    );
    assert.deepEqual(missing, [], 'these routes are not registered on the assembled app');
  });

  it('answers an unknown path with the contract error shape, not a framework 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/no-such-thing' });
    assert.equal(response.statusCode, 404);
    assert.equal(errorCodeOf(response.payload), 'content_not_found');
  });
});

describe('liveness and readiness on the assembled app', () => {
  it('answers /health from memory', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', version: '0.1.0', protocolVersion: 1 });
  });

  it('answers /ready from the database handle', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ready', checks: { database: { ok: true } } });
  });
});

describe('the session layer reaches every module, not only the auth module', () => {
  /**
   * `/hands` checks `hasRequestDecorator('session')` itself and answers `internal_error` when the
   * plugin is missing. So a 500 here means the decorator did not reach this module's child scope,
   * and 401 means it did.
   */
  it('answers /hands with not_authenticated rather than internal_error', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/hands' });
    assert.equal(response.statusCode, 401, 'a 500 here means sessionPlugin is not on the root instance');
    assert.equal(errorCodeOf(response.payload), 'not_authenticated');
  });

  it('answers /me/progress with not_authenticated for an anonymous caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/me/progress' });
    assert.equal(response.statusCode, 401);
    assert.equal(errorCodeOf(response.payload), 'not_authenticated');
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('answers /rooms with not_authenticated for an anonymous caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/rooms' });
    assert.equal(response.statusCode, 401);
    assert.equal(errorCodeOf(response.payload), 'not_authenticated');
  });

  /** The one identity endpoint that must never fail for an anonymous reader. */
  it('answers /auth/session with a null user and a CSRF token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    assert.equal(response.statusCode, 200);
    const body: unknown = response.json();
    assert.ok(typeof body === 'object' && body !== null);
    assert.equal(Reflect.get(body, 'user'), null);
    assert.equal(typeof Reflect.get(body, 'csrfToken'), 'string');
    assert.equal(Reflect.get(body, 'protocolVersion'), 1);
  });
});

describe('the security layer still applies to the registered modules', () => {
  /**
   * Every mutating route, swept in one test.
   *
   * The CSRF check is a `preValidation` hook on the root instance, added by `securityPlugin` before
   * any route module is registered — so it reaches a module by inheritance, and a module registered
   * the wrong way round (or one that replaced the hook in its own scope) would be silently exempt.
   * Asserting one endpoint would not notice that; asserting all of them does. Concrete ids are used
   * where a route takes one, so the reply comes from the hook rather than from the router.
   */
  const mutating: readonly string[] = EXPECTED_ROUTES.filter((route) => route.method === 'POST').map(
    (route) =>
      route.url
        .replace('/:roomId', '/room_aaaaaaaaaaaaaaaaaaaaaaaaaa')
        .replace('/:id', '/quiz-pot-odds')
        .replace('/:handId', '/hand_aaaaaaaaaaaaaaaaaaaaaaaaaa')
        .replace('/:profileId', '/patient-technician'),
  );

  it('refuses every mutating route with no CSRF token', async () => {
    // Raised from 13 with `POST /me/delete`. The floor is what stops this sweep from quietly
    // becoming a sweep of nothing: a filter that matched no route would still report zero
    // mismatches, and the one destructive endpoint in the product is the last one that should be
    // allowed to fall out of the CSRF assertion without anybody noticing.
    assert.ok(mutating.length >= 14, `expected the whole mutating surface, got ${mutating.length}`);
    const wrong: string[] = [];
    for (const url of mutating) {
      const response = await app.inject({ method: 'POST', url, payload: {} });
      if (response.statusCode !== 403 || errorCodeOf(response.payload) !== 'csrf_failed') {
        wrong.push(`POST ${url} -> ${response.statusCode} ${response.payload.slice(0, 60)}`);
      }
    }
    assert.deepEqual(wrong, [], 'these mutating routes are not behind the CSRF check');
  });

  it('refuses a mutating request from an origin that is not allowlisted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/rooms/join',
      payload: { inviteCode: 'PRL-DEV-ROOM-1' },
      headers: { origin: 'https://evil.test' },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCodeOf(response.payload), 'forbidden');
  });
});

describe('assembled observability wiring', () => {
  it('uses the app-owned metrics registry for the default WebSocket hub', async () => {
    // The default route factory has no options object to carry metrics through. Capture the
    // router's private dependency at the factory seam: it must be the exact decoration installed
    // by buildApp rather than the process-global fallback. The assembled app above exercises the
    // same default factory through API_ROUTE_MODULES; this small probe makes the identity visible.
    const probeMetrics = new AppMetrics();
    const probe = await buildApp({ config: testConfig(), database: stubDatabase, metrics: probeMetrics });
    let routerMetrics: unknown;
    await registerRoutes(probe, [
      createWsHub({ onRouterReady: (router) => (routerMetrics = Reflect.get(router, 'metrics')) }),
    ]);
    await probe.ready();
    assert.equal(routerMetrics, probeMetrics);
    await probe.close();
  });
});
