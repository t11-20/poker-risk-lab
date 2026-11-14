/**
 * Every path `scripts/load-test.mjs` and `scripts/smoke-test.mjs` can call routes on a real
 * `buildApp()`. A missing endpoint reads as `csrf_failed`, because the CSRF hook refuses a POST
 * before routing. Paths are extracted from the script sources as text. The negative control probes
 * three paths that do not exist.
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
import { stripComments } from './helpers/source-scan.ts';

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

/** `@fastify/websocket` answers a GET without `Upgrade` with 404. `test/ws-socket.test.ts` covers it. */
const NOT_AN_HTTP_ROUTE = new Set([`${API_PREFIX}/ws`]);

/**
 * An unknown content id answers `content_not_found` like an unrouted path, so content ids come from
 * `@prl/content`. `/hands/:id` and `/rooms/:id` refuse an anonymous caller before any lookup.
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
  // Without a CSRF token a POST is refused before routing, so a bare "not 404" proves nothing.
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
    // Verbatim the old constants. If any routes, the assertions above mean nothing.
    for (const path of ['/api/v1/session/guest', '/api/v1/session', '/api/v1/rooms/room_x/join']) {
      const outcome = await routesSomewhere(path);
      assert.equal(outcome.routed, false, `${path} is routed, so the checks above prove nothing`);
    }
  });
});
