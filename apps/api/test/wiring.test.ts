/**
 * Assembles the whole app as `src/server.ts` does (`buildApp`, then `registerApiRoutes`) to catch
 * wiring bugs no per-module harness can see. Examples are a listed module that is not registered, the session
 * decorator not reaching a module's child scope (`/hands` then answers 500), and the probes dying
 * with a module that throws during registration.
 * No database: a stub handle answers `/ready`, and postgres.js opens no connection until a query.
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
import { roomRegistry } from '../src/rooms/registry.ts';
import { API_ROUTE_MODULES, registerApiRoutes } from '../src/routes/index.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { createWsHub } from '../src/ws/hub.ts';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Never dialled.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(undefined),
};

// Written out, because a list derived from the router cannot detect a missing route.
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
  // `/hands` answers `internal_error` when the session decorator did not reach its child scope.
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
  // CSRF is a root `preValidation` hook reached by inheritance, so a module can be silently exempt.
  // Concrete ids make the reply come from the hook rather than the router.
  const mutating: readonly string[] = EXPECTED_ROUTES.filter((route) => route.method === 'POST').map(
    (route) =>
      route.url
        .replace('/:roomId', '/room_aaaaaaaaaaaaaaaaaaaaaaaaaa')
        .replace('/:id', '/quiz-pot-odds')
        .replace('/:handId', '/hand_aaaaaaaaaaaaaaaaaaaaaaaaaa')
        .replace('/:profileId', '/patient-technician'),
  );

  it('refuses every mutating route with no CSRF token', async () => {
    // The floor stops a sweep of nothing. 14 includes `POST /me/delete`.
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
    // The router must get buildApp's metrics decoration, not the process-global fallback.
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

  // `RoomRegistry` defaults to `ownership: null` for database-free tests, so dropping
  // `postgresRoomOwnership(getSql)` from `registerApiRoutes` would leave every other test green.
  // `roomRegistry()` returns the singleton built in `before`; its first caller decides its deps.
  it('gives the assembled registry a room lease, so a second process cannot serve a live room', () => {
    assert.equal(
      roomRegistry().enforcesOwnership,
      true,
      'the assembled app built a registry that enforces no room ownership: two API processes could ' +
        'each hold their own deck and pot for one room, and the second settlement to land would ' +
        'destroy the chips the first paid out',
    );
  });
});
