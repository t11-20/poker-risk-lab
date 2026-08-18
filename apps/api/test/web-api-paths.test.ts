/**
 * Every path the web client can emit, driven against a real `buildApp()`.
 *
 * ## The defect this exists for
 *
 * `apps/web` addressed `/api/…` for an entire build-out while this API served `/api/v1/…`. Two of its
 * paths were wrong in *shape* as well — `/api/scenarios` where the route is `/api/v1/content/scenarios`,
 * `/api/legends/:id/learn` where the route is `/api/v1/legends/profiles/:id` — and one named a route
 * that has never existed. Every request 404'd, the client counted a 404 as "the API is not deployed",
 * and every screen silently rendered a bundled fixture. The product shipped six fixture scenarios
 * against the API's thirty-six, and nine of seventeen lessons rendered "not available in this build".
 *
 * Nothing caught it, and no test the API had *could* have: `test:smoke` and every route test drive the
 * API's own paths, so they are structurally incapable of noticing that the client asks for different
 * ones. The only test that can is one driven from the client's constants, which is this one.
 *
 * ## Why it can't drift from the call sites
 *
 * `API_PATHS` in `@prl/contracts` is the only place `apps/web` may build a request path, and
 * `API_PATH_PROBES` is annotated `Readonly<Record<ApiPathName, ApiPathProbe>>` — so a path added to the
 * table without a probe does not compile, and a probe for a path that no longer exists does not
 * either. The last hole, a path written inline at a call site where no enumeration can see it, is
 * closed by the source scan at the bottom of this file.
 *
 * ## Why `app.inject` and not `hasRoute`
 *
 * A pattern lookup would prove a route is registered under some spelling; injecting proves the
 * concrete path a browser would send is routed. It also catches the failures a pattern lookup cannot:
 * a parameter that fails its schema, a closed query schema rejecting a field the client sends.
 *
 * `POST` probes are sent WITH a CSRF token, and that is load-bearing rather than incidental: the CSRF
 * hook runs before the not-found handler, so an unauthenticated POST to a route that does not exist
 * answers 403 and would sail past a bare "not 404" assertion. The negative control at the end proves
 * the assertion can still fail.
 *
 * The one exception is the WebSocket upgrade, and it is an exception for a reason rather than for
 * convenience: `light-my-request` has no socket, so it can neither perform a handshake nor receive a
 * `101`, and a status code injected at that path would be an assertion about nothing. It is checked
 * with `hasRoute` — sound here because the path is static, so the pattern IS the concrete path — with
 * a negative control beside it, and the handshake itself is driven from the same published constant
 * over a real socket in `ws-socket.test.ts`. The rule is that the path never goes unasserted, not
 * that every path is asserted the same way.
 *
 * ## The four paths that used to be outside this guarantee
 *
 * `POST /auth/guest`, `GET /rooms`, `POST /rooms` and the upgrade path were built by the live-table
 * client itself, in two local tables with comments explaining that they belonged in `@prl/contracts`
 * and were written locally only because that package was out of that change's scope. So the whole
 * live table — the screen with the most moving parts — sat outside the one test that proves the
 * client and the server agree about where anything is. They are published now, and covered here.
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
    // The real test database when there is one, and a syntactically valid URL when there is not.
    // One probe does reach the database — `POST /auth/guest` creates an account, which is the whole
    // of what that route does — and with no database it answers 500 rather than 404, which is still
    // the answer of a route that exists. Every other path here either needs no database or is
    // refused before it would reach one, and `configureDatabase` builds `postgres`' lazy client, so
    // nothing opens a socket by construction.
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

/** The web app's source tree, found from this file so the test does not depend on a working directory. */
const WEB_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');

/**
 * The first id the API itself publishes for each parameterised path.
 *
 * Read back from the live responses rather than hard-coded, so a retired lesson or profile cannot make
 * this file fail for a reason that has nothing to do with paths.
 */
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
    // No hand list to read from without a session, and none is needed: `/hands/:handId` refuses an
    // anonymous caller long before it looks the id up. It only has to satisfy the params schema.
    handId: 'hand-0042',
    // Exactly what `apps/web/src/app/review/page.tsx` sends. `prl:handListQuery` is a closed schema,
    // so a field the client adds and the server does not accept is a 400 — which this catches.
    // `sort` is in here so the closed query schema is proven to ACCEPT it, not merely to exist. The
    // hand-history screen sent this parameter into a schema that had no such field, got
    // `invalid_request`, and responded by dropping the parameter and keeping the control.
    handsQuery: 'limit=6&sort=net-high',
  };
}

before(async () => {
  configureDatabase(testConfig());
  app = await buildApp({ config: testConfig() });
  // A test-only route, mounted like the client's own paths, purely to mint a CSRF pair. Registered
  // before the route modules so it cannot shadow one of theirs.
  app.get(`${API_PREFIX}/test-csrf`, (_request, reply) => ({ token: reply.generateCsrf() }));
  // The real production wiring, so the set of registered routes is exactly the set a deployed server
  // has — not a subset assembled by this test.
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
  // Zero grace: nothing here ever opened a connection, so there is nothing in flight to drain.
  await closeDatabase(0);
});

/** One request, shaped the way the browser shapes it. */
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
    // `apps/api/src/app.ts` owns the mount; `@prl/contracts` publishes it to the client. If these two
    // ever disagree, every client request 404s — which is precisely the defect this file exists for.
    assert.equal(API_PREFIX, SERVER_API_PREFIX);
  });

  for (const [name, spec] of Object.entries(API_PATH_PROBES)) {
    for (const method of spec.methods) {
      if (method === 'UPGRADE') {
        it(`UPGRADE ${name} is a registered route at exactly that path`, () => {
          // The one path here that is not a request/response, asserted the way an upgrade can be
          // asserted rather than by pretending it is one.
          //
          // `app.inject` cannot establish this: `light-my-request` has no socket, so it can neither
          // send `Connection: Upgrade` meaningfully nor receive a `101`. Injecting anyway would
          // assert a status code that says nothing about whether the handshake works, which is
          // exactly the kind of assertion this file exists to not have.
          //
          // `hasRoute` is the honest instrument for it: the path is static, so the pattern it looks
          // up IS the concrete path a browser opens, and a rename on the API side changes it. The
          // negative control below proves the lookup can fail.
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
          // And the handshake itself, over a real socket, is driven from this same constant in
          // `apps/api/test/ws-socket.test.ts` — which is where a listening server already exists.
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
          // For a GET the URL *is* the whole request, so a 400 means the path routed and then the
          // endpoint rejected what it carried — a closed query schema turning away a field the client
          // sends, a path parameter that fails its pattern. Just as fatal to the screen as a 404 and
          // just as invisible without this assertion; it is what catches `?sort=` being appended to a
          // `GET /hands` whose query schema has no such property.
          assert.notEqual(status, 400, `${url} routed but was rejected as malformed: ${body.slice(0, 300)}`);
        } else {
          // A POST carries a body this file does not own — it is built at the call site from the
          // contract's request type — so an empty payload legitimately answers 400 and asserting
          // otherwise would be asserting something about the caller's payload rather than the path.
          // What must not happen is 403: the CSRF hook runs BEFORE the not-found handler, so an
          // untokened POST to a route that does not exist answers 403 and would slip past the check
          // above. Seeing anything other than 403 here is what proves the token worked and that the
          // 404 assertion was a real one.
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
    // The negative control. Without it a change that made every assertion above vacuous — a probe
    // table that silently built nothing, a 404 that became a 403 — would still pass.
    const wrongGets = [
      '/api/session',
      '/api/content/lessons',
      '/api/content/glossary',
      '/api/scenarios',
      '/api/legends/profiles',
      '/api/hands',
      // The live-table paths, unprefixed. These are the shape the client would have emitted if the
      // four constants it used to keep locally had been written the way its first three were.
      '/api/rooms',
      '/rooms',
      '/api/v1/room',
      // The shape errors, with the prefix corrected: these are what the client used to ask for.
      `${API_PREFIX}/scenarios`,
      `${API_PREFIX}/legends/${examples.profileId}/learn`,
      `${API_PREFIX}/legends/hands/${examples.handId}/comparison`,
    ];
    for (const url of wrongGets) {
      const { status } = await probe('GET', url);
      assert.equal(status, 404, `${url} answered ${status}, so this test cannot detect a wrong path`);
    }

    // And the same for a POST, which is the case that needs the token to be a real check at all.
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

/** Every `.ts`/`.tsx` file under a directory, recursively. */
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
    // The hole the probe table alone cannot close. Seven of the wrong paths lived in template literals
    // at their call sites, where no enumeration of constants could see them, so this asserts the
    // absence of that shape rather than the correctness of a list.
    //
    // Matched only where a quote or backtick opens immediately before `/api`, and only on lines that
    // are not comments — these files document the wire in prose, and a sentence explaining why the
    // paths moved is not a path being built. A path built from `API_PATHS` never has the literal in
    // the source at all.
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
