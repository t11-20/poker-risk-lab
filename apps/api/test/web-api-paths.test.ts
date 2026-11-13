/**
 * Every path the web client can emit, injected into a real `buildApp()`. Route tests drive the
 * API's own paths, so only a test driven from the client's constants can see the client asking for
 * different ones. `API_PATH_PROBES` is typed over every `ApiPathName`, and a source scan catches
 * inline paths. POST probes carry a CSRF token, because the CSRF hook answers 403 before the
 * not-found handler. The WebSocket upgrade uses `hasRoute`, because `light-my-request` has no socket.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { quizzes } from '@prl/content';
import { API_PATH_PROBES, API_PATHS, API_PREFIX, type ApiPathExamples } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import { buildApp, API_PREFIX as SERVER_API_PREFIX } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase } from '../src/db.ts';
import { registerApiRoutes } from '../src/routes/index.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { TEST_DATABASE_URL } from './helpers/database.ts';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Only `POST /auth/guest` reaches the database, and without one it answers 500, not 404.
    // `postgres` builds a lazy client, so nothing else opens a socket.
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    RATE_LIMIT_EXPENSIVE_MAX: '5000',
    ...overrides,
  });
}

let app: FastifyInstance;
let examples: ApiPathExamples;
let csrf: { readonly token: string; readonly cookie: string };

const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');

/** Read from live responses, so a retired lesson or profile cannot fail this file. */
async function readExamples(instance: FastifyInstance): Promise<ApiPathExamples> {
  async function firstId(url: string, key: 'lessons' | 'scenarios' | 'profiles'): Promise<string> {
    const response = await instance.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 200, `${url} should serve a list: ${response.body.slice(0, 200)}`);
    const body: unknown = response.json();
    assert.ok(typeof body === 'object' && body !== null && key in body, `${url} has no ${key}`);
    const list = (body as Record<string, unknown>)[key];
    assert.ok(Array.isArray(list) && list.length > 0, `${url} published an empty ${key}`);
    const first: unknown = list[0];
    assert.ok(typeof first === 'object' && first !== null && 'id' in first, `${key}[0] has no id`);
    const id = (first as { readonly id: unknown }).id;
    assert.equal(typeof id, 'string');
    return String(id);
  }

  const quiz = quizzes()[0];
  assert.ok(quiz !== undefined, 'the content bundle ships no quizzes, so no quiz path can be probed');

  return {
    lessonId: await firstId(API_PATHS.lessons(), 'lessons'),
    scenarioId: await firstId(API_PATHS.scenarios(), 'scenarios'),
    profileId: await firstId(API_PATHS.legendProfiles(), 'profiles'),
    quizId: quiz.id,
    // `/hands/:handId` refuses an anonymous caller before the lookup, so it only has to satisfy the schema.
    handId: 'hand-0042',
    // Exactly what `apps/web/src/app/review/page.tsx` sends. `prl:handListQuery` is closed, so this
    // proves it accepts `sort`.
    handsQuery: 'limit=6&sort=net-high',
  };
}

before(async () => {
  configureDatabase(testConfig());
  app = await buildApp({ config: testConfig() });
  // Registered before the route modules so it cannot shadow one of theirs.
  app.get(`${API_PREFIX}/test-csrf`, (_request, reply) => ({ token: reply.generateCsrf() }));
  // The production wiring, so the registered set matches a deployed server.
  await registerApiRoutes(app);
  await app.ready();

  const minted = await app.inject({ method: 'GET', url: `${API_PREFIX}/test-csrf` });
  assert.equal(minted.statusCode, 200, minted.body);
  const token: unknown = minted.json();
  assert.ok(typeof token === 'object' && token !== null && 'token' in token);
  const secret = minted.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'the CSRF plugin issued no secret cookie');
  csrf = { token: String((token as { readonly token: unknown }).token), cookie: `prl_csrf=${secret.value}` };

  examples = await readExamples(app);
});

after(async () => {
  await app?.close();
  await closeSharedPool();
  await closeDatabase(0);
});

async function probe(method: 'GET' | 'POST', url: string): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { origin: 'http://localhost:3000' };
  if (method === 'POST') {
    headers['content-type'] = 'application/json';
    headers['x-csrf-token'] = csrf.token;
    headers.cookie = csrf.cookie;
  }
  const response = await app.inject({
    method,
    url,
    headers,
    ...(method === 'POST' ? { payload: {} } : {}),
  });
  return { status: response.statusCode, body: response.body };
}

describe('every path the web client can emit is a registered route', () => {
  it('agrees with the API about the version prefix', () => {
    assert.equal(API_PREFIX, SERVER_API_PREFIX);
  });

  for (const [name, spec] of Object.entries(API_PATH_PROBES)) {
    for (const method of spec.methods) {
      if (method === 'UPGRADE') {
        it(`UPGRADE ${name} is a registered route at exactly that path`, () => {
          // `hasRoute` is sound here because the path is static, so the pattern is the concrete path.
          const url = spec.build(examples);
          assert.ok(
            url.startsWith(`${API_PREFIX}/`),
            `${name} builds "${url}", which is not under the prefix`,
          );
          assert.equal(
            app.hasRoute({ method: 'GET', url }),
            true,
            `${url} is not registered as an upgrade route. Either API_PATHS.ws is wrong or WS_PATH ` +
              'in apps/api/src/ws/hub.ts was renamed.',
          );
          assert.equal(
            app.hasRoute({ method: 'GET', url: `${url}/nope` }),
            false,
            'hasRoute matched a path that does not exist, so the assertion above proved nothing',
          );
          // The handshake is driven from this constant in `ws-socket.test.ts`.
        });
        continue;
      }

      it(`${method} ${name} does not 404`, async () => {
        const url = spec.build(examples);
        assert.ok(url.startsWith(`${API_PREFIX}/`), `${name} builds "${url}", which is not under the prefix`);
        const { status, body } = await probe(method, url);
        assert.notEqual(
          status,
          404,
          `${method} ${url} is not routed anywhere. Either API_PATHS is wrong or the route was ` +
            `renamed: ${body.slice(0, 200)}`,
        );
        if (method === 'GET') {
          // A GET 400 means the path routed and its query or params were rejected, as fatal as a 404.
          assert.notEqual(status, 400, `${url} routed but was rejected as malformed: ${body.slice(0, 300)}`);
        } else {
          // A POST body belongs to the call site, so 400 is fine here. A 403 would mean the CSRF hook
          // answered before the not-found handler and the 404 check proved nothing.
          assert.notEqual(
            status,
            403,
            `${url} was refused before routing, so the 404 check above proved nothing: ${body.slice(0, 200)}`,
          );
        }
      });
    }
  }

  it('would notice a wrong path: the pre-fix client paths all 404', async () => {
    const wrongGets = [
      '/api/session',
      '/api/content/lessons',
      '/api/content/glossary',
      '/api/scenarios',
      '/api/legends/profiles',
      '/api/hands',
      '/api/rooms',
      '/rooms',
      '/api/v1/room',
      // The shape errors, prefix corrected.
      `${API_PREFIX}/scenarios`,
      `${API_PREFIX}/legends/${examples.profileId}/learn`,
    ];
    for (const url of wrongGets) {
      const { status } = await probe('GET', url);
      assert.equal(status, 404, `${url} answered ${status}, so this test cannot detect a wrong path`);
    }

    for (const url of [
      '/api/legends/compare',
      `${API_PREFIX}/legends/compare/nope`,
      '/api/auth/guest',
      '/auth/guest',
      '/api/rooms',
    ]) {
      const { status } = await probe('POST', url);
      assert.equal(status, 404, `POST ${url} answered ${status}; a wrong POST path must still 404`);
    }
  });
});

function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('the web client builds no request path outside the shared table', () => {
  it('has no literal /api path anywhere in apps/web/src', () => {
    // Wrong paths lived in template literals at call sites, where no enumeration sees them. Matched
    // only where a quote or backtick opens just before `/api`, and only on non-comment lines.
    const offenders: string[] = [];
    for (const file of sourceFiles(WEB_SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
        if (/['"`]\/api(\/|['"`])/.test(line)) offenders.push(`${file}:${index + 1}: ${trimmed}`);
      });
    }
    assert.deepEqual(
      offenders,
      [],
      'these lines build an API path by hand; use API_PATHS from @prl/contracts instead',
    );
  });
});
