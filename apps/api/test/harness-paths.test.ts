/**
 * Every path `scripts/load-test.mjs` and `scripts/smoke-test.mjs` can call, driven against a real
 * `buildApp()` + `registerApiRoutes()`.
 *
 * ## The defect this exists for
 *
 * `pnpm run test:load` had never once worked. Three of its route constants named endpoints that do
 * not exist — `/api/v1/session/guest` for `POST /api/v1/auth/guest`, `/api/v1/session` for
 * `GET /api/v1/auth/session`, and `POST /api/v1/rooms/:roomId/join` for a `POST /api/v1/rooms/join`
 * that takes the invite code in the body. It died on request one, every time, and had done since it
 * was written. The wrong path never surfaced as a 404 because every unrouted path answers
 * `content_not_found`, and because the first call was a POST the CSRF hook refused it *before*
 * routing, so the error read `csrf_failed` — which reads like a client problem.
 *
 * The harness is also the repository's only real-WebSocket client outside the test suite, so its
 * silence cost the live-table path all of its end-to-end coverage.
 *
 * `apps/api/test/wiring.test.ts` already proved the server serves its routes, and
 * `apps/api/test/web-api-paths.test.ts` now proves the web client calls routes that exist. Nothing
 * proved it for the harnesses, which is this file. Same defect class, same shape of guard.
 *
 * ## Why the paths are read out of the scripts rather than restated
 *
 * A copy of the list here would be a third place to get it wrong. These are extracted from the
 * script sources as text, so a rename that misses one is caught by the scan rather than by the
 * next person to run a load test.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes: restoring any one of the three original constants in `load-test.mjs` makes this fail, and
 * that was checked. The negative control at the bottom proves the assertion is capable of failing
 * at all, by probing the exact three paths the harness used to use.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { scenarios } from '@prl/content';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase } from '../src/db.ts';
import { registerApiRoutes } from '../src/routes/index.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { TEST_DATABASE_URL } from './helpers/database.ts';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..', '..');
const SCRIPTS = ['scripts/load-test.mjs', 'scripts/smoke-test.mjs'];

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

/**
 * Removes comments, so a path quoted in prose is not read as a path the script calls.
 *
 * Taken from `test/server-randomness.test.ts` unchanged, including the `[^:]` guard that stops the
 * line-comment rule eating the rest of a line after `https://`. Needed here because this file's own
 * fix documents the three wrong constants by name, and without stripping, the extractor below would
 * dutifully report the documentation as a defect.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * The upgrade path is not an HTTP route and cannot be probed with `inject`.
 *
 * `@fastify/websocket` answers a GET that carries no `Upgrade` header with a 404, so probing it here
 * would report a route that demonstrably works as missing. It is covered properly, by a real
 * handshake over a real socket, in `test/ws-socket.test.ts`.
 */
const NOT_AN_HTTP_ROUTE = new Set([`${API_PREFIX}/ws`]);

/**
 * Every `/api/v1/...` literal a harness calls, with template holes filled.
 *
 * A parameterised path needs an id that EXISTS where the endpoint looks one up, because an unknown
 * content id answers the same `content_not_found` as an unrouted path — which is the exact ambiguity
 * that hid the broken constants. So content ids come from `@prl/content`, and the id-guarded routes
 * (`/hands/:id`, `/rooms/:id`) get a syntactically valid id, since both refuse an anonymous caller
 * before they ever look it up.
 */
function pathsIn(source: string, scenarioId: string): string[] {
  const found = new Set<string>();
  for (const match of stripComments(source).matchAll(/['"`](\/api\/v1\/[^'"`\s]*)['"`]/g)) {
    const raw = match[1] ?? '';
    const filled = raw.replace(/\$\{[^}]*\}/g, () =>
      raw.startsWith(`${API_PREFIX}/content/`) ? scenarioId : 'probe-id',
    );
    if (filled.includes('${') || NOT_AN_HTTP_ROUTE.has(filled)) continue;
    found.add(filled);
  }
  return [...found];
}

let app: FastifyInstance;
let csrf: { readonly token: string; readonly cookie: string };

before(async () => {
  configureDatabase(testConfig());
  app = await buildApp({ config: testConfig() });
  // A test-only route purely to mint a CSRF pair, registered before the route modules so it cannot
  // shadow one of theirs. Same device as `web-api-paths.test.ts`, and for the same reason: without
  // a token a POST is refused before routing and a bare "not 404" check would prove nothing.
  app.get(`${API_PREFIX}/test-harness-csrf`, (_request, reply) => ({ token: reply.generateCsrf() }));
  await registerApiRoutes(app);
  await app.ready();

  const minted = await app.inject({ method: 'GET', url: `${API_PREFIX}/test-harness-csrf` });
  assert.equal(minted.statusCode, 200, minted.body);
  const body: unknown = minted.json();
  assert.ok(typeof body === 'object' && body !== null && 'token' in body);
  const secret = minted.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'the CSRF plugin issued no secret cookie');
  csrf = {
    token: String((body as { readonly token: unknown }).token),
    cookie: `prl_csrf=${secret.value}`,
  };
});

after(async () => {
  await app?.close();
  await closeSharedPool();
  await closeDatabase(0);
});

/** Probes a path with both verbs, because the scripts use both and this file cannot tell which. */
async function routesSomewhere(path: string): Promise<{ readonly routed: boolean; readonly detail: string }> {
  const get = await app.inject({ method: 'GET', url: path, headers: { origin: 'http://localhost:3000' } });
  if (get.statusCode !== 404) return { routed: true, detail: `GET ${get.statusCode}` };
  const post = await app.inject({
    method: 'POST',
    url: path,
    headers: {
      origin: 'http://localhost:3000',
      'content-type': 'application/json',
      'x-csrf-token': csrf.token,
      cookie: csrf.cookie,
    },
    payload: {},
  });
  // 403 would mean the request never reached the router, so it can never count as "routed".
  assert.notEqual(
    post.statusCode,
    403,
    `POST ${path} was refused before routing, so this probe proved nothing: ${post.body.slice(0, 160)}`,
  );
  return { routed: post.statusCode !== 404, detail: `GET 404, POST ${post.statusCode}` };
}

describe('every path the shell harnesses call is a registered route', () => {
  for (const script of SCRIPTS) {
    it(`${script} calls only routes this server serves`, async () => {
      const source = readFileSync(join(REPO_ROOT, script), 'utf8');
      const scenarioId = scenarios()[0]?.id;
      assert.ok(typeof scenarioId === 'string', 'the content package must ship at least one scenario');
      const paths = pathsIn(source, scenarioId);
      assert.ok(
        paths.length >= 4,
        `expected several /api/v1 paths in ${script}, found ${paths.length}; the extractor is broken`,
      );

      const missing: string[] = [];
      for (const path of paths) {
        const outcome = await routesSomewhere(path);
        if (!outcome.routed) missing.push(`${path} (${outcome.detail})`);
      }
      assert.deepEqual(
        missing,
        [],
        `${script} calls paths that are not routed. Every unrouted path answers content_not_found ` +
          `rather than an obvious 404, which is why this went unnoticed:\n${missing.join('\n')}`,
      );
    });
  }

  it('would notice a wrong path: the three the load harness used to use all 404', async () => {
    // The negative control. These are verbatim the constants that made `pnpm run test:load` fail on
    // request one for its entire existence. If any of them ever routes, the assertions above have
    // stopped meaning anything.
    for (const path of ['/api/v1/session/guest', '/api/v1/session', '/api/v1/rooms/room_x/join']) {
      const outcome = await routesSomewhere(path);
      assert.equal(outcome.routed, false, `${path} is routed, so the checks above prove nothing`);
    }
  });
});
