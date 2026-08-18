/**
 * One suite of session behaviours, run twice: against a `Map`, and against Postgres.
 *
 * ## The hole this closes
 *
 * `src/auth/session.ts` and `src/routes/auth.ts` are line-covered to the last branch, and every one
 * of those lines is exercised against an in-memory fake — `test/auth.test.ts` says so itself: "That
 * indirection is what lets every test in `test/auth.test.ts` run with no database at all — the fake
 * store is a `Map`." The fake is careful and its comments track the SQL faithfully. It is still a
 * fake, and nothing anywhere asserted that the SQL implementation behaves the way it does. A
 * hundred per cent of the coverage was over the wrong object.
 *
 * The structural fix is not "add some SQL tests". It is a single list of behaviours that BOTH
 * implementations have to satisfy, so the fake cannot drift from the thing it stands in for
 * without one of them failing. That list is `BEHAVIOURS` below, and it is run once per
 * implementation.
 *
 * Two levels, because a store can conform and the middleware still behave differently:
 *
 *   1. **The port.** `SessionStore`'s five operations, asserted identically against both.
 *   2. **The middleware over the port.** The real `sessionPlugin`, on a real `buildApp()`, driven
 *      through the same script of HTTP requests against each implementation. The two transcripts
 *      are compared for equality — that is what "identical results" means here, and it is checked
 *      rather than argued.
 *
 * ## Why the in-memory implementation is written here rather than imported
 *
 * `test/auth.test.ts`'s fake lives inside a `.test.ts` file; importing it would run that file's
 * suite as a side effect. So this one is written to the same contract, using the *production* id
 * and token generators so the two implementations produce the same shapes. If they ever disagree
 * about a behaviour, one of these two runs fails and the diff names the operation.
 *
 * ## Cleanup
 *
 * `createAuthStore` takes the pool (`Sql`), not a transaction handle, so the SQL half cannot hide
 * inside a rollback the way the other coverage files do — and should not, because a pool with
 * autocommit is how this code runs in production. Every case therefore records the accounts it
 * creates and deletes them afterwards; `prl.sessions.user_id` is `ON DELETE CASCADE`, so the
 * sessions go with them.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import {
  requireSession,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_MS,
  type SessionAccount,
  type SessionStore,
  sessionPlugin,
} from '../src/auth/session.ts';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import { sessionCookieName } from '../src/plugins/security.ts';
import { hashToken } from '../src/repositories/hashing.ts';
import { generateSessionToken, newSessionId } from '../src/repositories/ids.ts';
import { SESSION_TTL_SECONDS } from '../src/repositories/sessions.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { createAuthStore } from '../src/routes/auth.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';
import { stubDatabase, testConfig } from './helpers/hands-app.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

const databaseUrl = TEST_DATABASE_URL;
let client: Sql | null = null;
let skipReason: string | false = databaseSkip('the SQL session store');

if (databaseUrl !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
        DATABASE_POOL_MAX: '2',
      }),
    );
    await probe`select 1 from prl.users limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `prl schema is not reachable (${error instanceof Error ? error.name : 'error'}): run pnpm db:migrate`;
  }
}

if (skipReason !== false) {
  console.info(`[coverage-session-conformance.test.ts] skipping the SQL half: ${skipReason}`);
}

after(async () => {
  if (client !== null) await client.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// What every implementation has to provide in order to be tested
// ---------------------------------------------------------------------------

interface StoreHarness {
  readonly store: SessionStore;
  /** An account the store can open a session for. */
  readonly createUser: (displayName: string) => Promise<SessionAccount>;
  /**
   * Moves a session's whole lifetime back by `ms`.
   *
   * Both timestamps move together because `sessions_expires_after_creation` requires it, and
   * because "an older session" is what the sliding-expiry and ceiling rules are about — not "a
   * session that expired before it was created".
   */
  readonly backdate: (sessionId: string, ms: number) => Promise<void>;
}

interface Implementation {
  readonly name: string;
  /** False when this implementation can run; a reason when it cannot. */
  readonly skip: string | false;
  readonly with: (run: (harness: StoreHarness) => Promise<void>) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Implementation A: a Map
// ---------------------------------------------------------------------------

interface MemorySession {
  readonly sessionId: string;
  readonly userId: string;
  readonly token: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

/**
 * The in-memory store, written to the documented contract of each operation.
 *
 * Every body is synchronous and wrapped at the port boundary, for the reason `test/auth.test.ts`
 * gives: an `async` function with no `await` is a lint error here, and a fake whose bodies are
 * plain functions reads as a statement of the invariants it stands in for.
 */
function memoryHarness(): StoreHarness {
  const users = new Map<string, SessionAccount>();
  const byToken = new Map<string, MemorySession>();
  const byId = new Map<string, MemorySession>();

  const findValid = (token: string) => {
    if (token === '') return null;
    const session = byToken.get(token);
    if (session === undefined || session.revokedAt !== null) return null;
    if (session.expiresAt <= Date.now()) return null;
    const user = users.get(session.userId);
    if (user === undefined) return null;
    return { sessionId: session.sessionId, expiresAt: new Date(session.expiresAt), user };
  };

  const store: SessionStore = {
    findValidByToken: (token) => Promise.resolve(findValid(token)),
    create: (userId) => {
      const session: MemorySession = {
        sessionId: newSessionId(),
        userId,
        token: generateSessionToken(),
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_SECONDS * 1_000,
        revokedAt: null,
      };
      byToken.set(session.token, session);
      byId.set(session.sessionId, session);
      return Promise.resolve({
        sessionId: session.sessionId,
        token: session.token,
        expiresAt: new Date(session.expiresAt),
      });
    },
    extendExpiry: (sessionId) => {
      const session = byId.get(sessionId);
      if (session === undefined || session.revokedAt !== null) return Promise.resolve(null);
      // `least(now() + ttl, created_at + ceiling)`, and the same expression in the WHERE clause:
      // a session already at its ceiling matches nothing and no row is written.
      const next = Math.min(
        Date.now() + SESSION_IDLE_TTL_MS,
        session.createdAt + SESSION_ABSOLUTE_TTL_SECONDS * 1_000,
      );
      if (next <= session.expiresAt) return Promise.resolve(null);
      session.expiresAt = next;
      return Promise.resolve(new Date(next));
    },
    revoke: (sessionId) => {
      const session = byId.get(sessionId);
      if (session === undefined || session.revokedAt !== null) return Promise.resolve(false);
      session.revokedAt = Date.now();
      return Promise.resolve(true);
    },
    touchLastSeen: (userId) => Promise.resolve(users.has(userId)),
  };

  let counter = 0;
  return {
    store,
    createUser: (displayName) => {
      counter += 1;
      const user: SessionAccount = {
        id: `usr_memory${String(counter).padStart(8, '0')}`,
        kind: 'guest',
        displayName,
        createdAt: new Date().toISOString(),
      };
      users.set(user.id, user);
      return Promise.resolve(user);
    },
    backdate: (sessionId, ms) => {
      const session = byId.get(sessionId);
      assert.ok(session !== undefined, `no in-memory session ${sessionId}`);
      session.createdAt -= ms;
      session.expiresAt -= ms;
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Implementation B: `createAuthStore` over Postgres
// ---------------------------------------------------------------------------

/**
 * The production binding, on the pool, with the accounts it created removed afterwards.
 *
 * `createAuthStore(sql).sessions` is exactly what `src/routes/auth.ts` hands to `sessionPlugin` in
 * a running server, so this is the object the release depends on rather than a re-implementation
 * of it.
 */
async function withSqlHarness(run: (harness: StoreHarness) => Promise<void>): Promise<void> {
  const sql = client;
  assert.ok(sql !== null, 'the SQL implementation needs a database');
  const created: string[] = [];
  const harness: StoreHarness = {
    store: createAuthStore(sql).sessions,
    createUser: async (displayName) => {
      const row = await usersRepository.createGuest(sql, { displayName });
      created.push(row.id);
      return {
        id: row.id,
        kind: row.kind,
        displayName: row.display_name,
        createdAt: row.created_at.toISOString(),
      };
    },
    backdate: async (sessionId, ms) => {
      const shifted = await sql<{ id: string }[]>`
        update prl.sessions
           set created_at = created_at - (${Math.round(ms / 1_000)}::int * interval '1 second'),
               expires_at = expires_at - (${Math.round(ms / 1_000)}::int * interval '1 second')
         where id = ${sessionId}
        returning id
      `;
      assert.equal(shifted.length, 1, `no session row ${sessionId} to backdate`);
    },
  };
  try {
    await run(harness);
  } finally {
    // The accounts take their sessions with them: `sessions.user_id` is ON DELETE CASCADE.
    if (created.length > 0) await sql`delete from prl.users where id = any(${created}::text[])`;
  }
}

const implementations: readonly Implementation[] = [
  {
    name: 'in-memory Map',
    skip: false,
    with: (run) => run(memoryHarness()),
  },
  {
    name: 'createAuthStore over Postgres',
    skip: skipReason,
    with: withSqlHarness,
  },
];

// ---------------------------------------------------------------------------
// The behaviours both implementations must satisfy
// ---------------------------------------------------------------------------

const NO_FINGERPRINTS = { ipHash: null, userAgentHash: null };

/** Wall-clock slack for a timestamp the database computed and this process is checking. */
const CLOCK_SLACK_MS = 5 * 60 * 1_000;

const BEHAVIOURS: readonly {
  readonly name: string;
  readonly run: (harness: StoreHarness) => Promise<void>;
}[] = [
  {
    name: 'opens a session, hands back the token once, and resolves it to the account',
    run: async ({ store, createUser }) => {
      const user = await createUser('Ada');
      const issued = await store.create(user.id, NO_FINGERPRINTS);

      assert.ok(issued.sessionId.startsWith('ses_'), `session id shape: ${issued.sessionId}`);
      assert.ok(issued.token.length >= 40, 'the token is a 256-bit opaque secret');
      const lifetime = issued.expiresAt.getTime() - Date.now();
      assert.ok(
        Math.abs(lifetime - SESSION_TTL_SECONDS * 1_000) < CLOCK_SLACK_MS,
        `a new session lasts the documented idle window, got ${lifetime} ms`,
      );

      const found = await store.findValidByToken(issued.token);
      assert.ok(found !== null, 'a fresh token must resolve');
      assert.equal(found.sessionId, issued.sessionId);
      assert.equal(found.user.id, user.id);
      assert.equal(found.user.kind, 'guest');
      assert.equal(found.user.displayName, 'Ada');
      assert.match(found.user.createdAt, /^\d{4}-\d{2}-\d{2}T/, 'createdAt crosses the wire as ISO');
    },
  },
  {
    name: 'answers null for an unknown token and for an empty one',
    run: async ({ store, createUser }) => {
      const user = await createUser('Ada');
      await store.create(user.id, NO_FINGERPRINTS);
      assert.equal(await store.findValidByToken(generateSessionToken()), null);
      assert.equal(await store.findValidByToken(''), null, 'an empty token is never a lookup');
    },
  },
  {
    name: 'revokes once, idempotently, and leaves the learner’s other sessions alone',
    run: async ({ store, createUser }) => {
      const user = await createUser('Ada');
      const first = await store.create(user.id, NO_FINGERPRINTS);
      const second = await store.create(user.id, NO_FINGERPRINTS);

      assert.equal(await store.revoke(first.sessionId), true);
      assert.equal(await store.revoke(first.sessionId), false, 'revocation is idempotent');
      assert.equal(await store.findValidByToken(first.token), null, 'a revoked session is gone');
      assert.notEqual(
        await store.findValidByToken(second.token),
        null,
        'signing out one browser must not sign out the other',
      );
      assert.equal(await store.revoke(newSessionId()), false, 'an unknown session id is false');
    },
  },
  {
    name: 'expires on its own, with no revocation needed',
    run: async ({ store, createUser, backdate }) => {
      const user = await createUser('Ada');
      const issued = await store.create(user.id, NO_FINGERPRINTS);
      // Past the whole idle window: the session is now expired without anybody touching it.
      await backdate(issued.sessionId, SESSION_TTL_SECONDS * 1_000 + 60_000);
      assert.equal(await store.findValidByToken(issued.token), null, 'expiry is in the lookup');
    },
  },
  {
    name: 'slides an expiry forward, and never past the absolute ceiling',
    run: async ({ store, createUser, backdate }) => {
      const user = await createUser('Ada');
      const issued = await store.create(user.id, NO_FINGERPRINTS);

      // Halfway through the idle window: the middleware's refresh point.
      await backdate(issued.sessionId, SESSION_IDLE_TTL_MS * 0.75);
      const slid = await store.extendExpiry(issued.sessionId);
      assert.ok(slid !== null, 'a session past halfway must be extendable');
      assert.ok(
        slid.getTime() > issued.expiresAt.getTime() - SESSION_IDLE_TTL_MS * 0.75,
        'the new expiry is later than the one it replaced',
      );

      // Now an old session: created beyond the absolute ceiling's reach. The idle window would put
      // its expiry two months out; the ceiling is what stops it, and the ceiling is measured from
      // `created_at` rather than from now.
      const ancient = await store.create(user.id, NO_FINGERPRINTS);
      const age = (SESSION_ABSOLUTE_TTL_SECONDS - 60) * 1_000;
      await backdate(ancient.sessionId, age);
      const capped = await store.extendExpiry(ancient.sessionId);
      assert.ok(capped !== null, 'a session below its ceiling can still move');
      assert.ok(
        capped.getTime() - (Date.now() - age) <= SESSION_ABSOLUTE_TTL_SECONDS * 1_000 + CLOCK_SLACK_MS,
        'a slide may never carry a session past created_at + the absolute lifetime',
      );
      assert.ok(
        capped.getTime() < Date.now() + SESSION_IDLE_TTL_MS,
        'the ceiling, not the idle window, is what decided this expiry',
      );
      assert.equal(
        await store.extendExpiry(ancient.sessionId),
        null,
        'a session sitting at its ceiling stops moving, and writes no row',
      );

      assert.equal(await store.extendExpiry(newSessionId()), null, 'an unknown session cannot slide');
      const revoked = await store.create(user.id, NO_FINGERPRINTS);
      await store.revoke(revoked.sessionId);
      await backdate(revoked.sessionId, SESSION_IDLE_TTL_MS * 0.75);
      assert.equal(
        await store.extendExpiry(revoked.sessionId),
        null,
        'a session revoked mid-request is not brought back to life by its own refresh',
      );
    },
  },
  {
    name: 'reports whether the account it was asked to touch exists',
    run: async ({ store, createUser }) => {
      const user = await createUser('Ada');
      assert.equal(await store.touchLastSeen(user.id), true);
      assert.equal(await store.touchLastSeen('usr_nobodyhomeatall'), false);
    },
  },
  {
    name: 'keeps two learners’ sessions apart',
    run: async ({ store, createUser }) => {
      const ada = await createUser('Ada');
      const bo = await createUser('Bo');
      const adaSession = await store.create(ada.id, NO_FINGERPRINTS);
      const boSession = await store.create(bo.id, NO_FINGERPRINTS);

      assert.equal((await store.findValidByToken(adaSession.token))?.user.id, ada.id);
      assert.equal((await store.findValidByToken(boSession.token))?.user.id, bo.id);
      await store.revoke(adaSession.sessionId);
      assert.equal(await store.findValidByToken(adaSession.token), null);
      assert.equal(
        (await store.findValidByToken(boSession.token))?.user.id,
        bo.id,
        "one learner's sign-out must not reach another's session",
      );
    },
  },
];

for (const implementation of implementations) {
  describe(`SessionStore conformance — ${implementation.name}`, { skip: implementation.skip }, () => {
    for (const behaviour of BEHAVIOURS) {
      it(behaviour.name, async () => {
        await implementation.with(behaviour.run);
      });
    }
  });
}

// ---------------------------------------------------------------------------
// The same script through the real middleware, against both stores
// ---------------------------------------------------------------------------

const config = testConfig();

/** An app carrying the real security layer and the real `sessionPlugin` over `store`. */
async function appWith(store: SessionStore): Promise<FastifyInstance> {
  const app = await buildApp({ config, database: stubDatabase });
  await app.register(sessionPlugin, { store });
  app.get('/whoami', (request) => ({
    signedIn: request.session !== null,
    rejection: request.sessionRejection,
  }));
  app.get('/private', (request) => ({ userId: requireSession(request).user.id }));
  await app.ready();
  return app;
}

function cookieHeader(value: string): string {
  return `${sessionCookieName(config)}=${value}`;
}

/** Whether a reply set (or cleared) the session cookie. Presence, not contents. */
function touchedCookie(headers: Record<string, unknown>): boolean {
  const raw = headers['set-cookie'];
  const values = Array.isArray(raw) ? raw : raw === undefined ? [] : [String(raw)];
  return values.some((value) => String(value).startsWith(`${sessionCookieName(config)}=`));
}

function errorCodeOf(payload: string): string {
  const parsed: unknown = JSON.parse(payload);
  const error: unknown = parsed !== null && typeof parsed === 'object' ? Reflect.get(parsed, 'error') : null;
  const code: unknown = error !== null && typeof error === 'object' ? Reflect.get(error, 'code') : null;
  return typeof code === 'string' ? code : `no-code:${payload.slice(0, 60)}`;
}

/**
 * One fixed script of requests, run against whichever store it is given.
 *
 * Returns normalised lines rather than raw responses: ids, tokens and expiry timestamps differ
 * between the two implementations by construction, and comparing them would only prove that a
 * `Map` is not Postgres. What has to match is the *behaviour* — status, whether a session
 * resolved, which rejection was recorded, and whether the cookie was re-sent or cleared.
 */
async function runScript(harness: StoreHarness): Promise<readonly string[]> {
  const app = await appWith(harness.store);
  const lines: string[] = [];
  const record = (label: string, parts: Readonly<Record<string, string | number | boolean>>): void => {
    const rendered = Object.entries(parts)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    lines.push(`${label} ${rendered}`);
  };

  try {
    const anonymous = await app.inject({ method: 'GET', url: '/whoami' });
    record('anonymous', {
      status: anonymous.statusCode,
      body: anonymous.body,
      cookieTouched: touchedCookie(anonymous.headers),
    });

    // Not signed by this server: refused before any lookup, and the cookie is cleared so the
    // browser stops resending it.
    const forged = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { cookie: cookieHeader('not-a-signed-value') },
    });
    record('forged-cookie', {
      status: forged.statusCode,
      body: forged.body,
      cookieTouched: touchedCookie(forged.headers),
    });

    // Signed by this server, but resolving to no session: `session_expired`, not
    // `not_authenticated`, so a client knows to open a fresh guest session.
    const unknown = app.signCookie(generateSessionToken());
    const unknownWhoami = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { cookie: cookieHeader(unknown) },
    });
    record('unknown-token', {
      status: unknownWhoami.statusCode,
      body: unknownWhoami.body,
      cookieTouched: touchedCookie(unknownWhoami.headers),
    });

    const noCookiePrivate = await app.inject({ method: 'GET', url: '/private' });
    record('private-anonymous', {
      status: noCookiePrivate.statusCode,
      code: errorCodeOf(noCookiePrivate.body),
    });

    const unknownPrivate = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { cookie: cookieHeader(unknown) },
    });
    record('private-unknown-token', {
      status: unknownPrivate.statusCode,
      code: errorCodeOf(unknownPrivate.body),
    });

    const user = await harness.createUser('Ada');
    const issued = await harness.store.create(user.id, { ipHash: null, userAgentHash: null });
    const signed = app.signCookie(issued.token);
    const authorised = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { cookie: cookieHeader(signed) },
    });
    record('private-signed-in', {
      status: authorised.statusCode,
      isTheUser: authorised.body.includes(user.id),
      // Well short of halfway, so the sliding refresh must NOT fire and the cookie is not re-sent.
      cookieTouched: touchedCookie(authorised.headers),
    });

    // Past halfway: the request slides the expiry and re-sends the cookie with a new Max-Age.
    await harness.backdate(issued.sessionId, SESSION_IDLE_TTL_MS * 0.75);
    const before = await harness.store.findValidByToken(issued.token);
    const refreshed = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { cookie: cookieHeader(signed) },
    });
    const afterwards = await harness.store.findValidByToken(issued.token);
    record('slides-past-halfway', {
      status: refreshed.statusCode,
      cookieTouched: touchedCookie(refreshed.headers),
      expiryMoved:
        before !== null && afterwards !== null && afterwards.expiresAt.getTime() > before.expiresAt.getTime(),
    });

    await harness.store.revoke(issued.sessionId);
    const afterRevocation = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { cookie: cookieHeader(signed) },
    });
    record('after-revocation', {
      status: afterRevocation.statusCode,
      code: errorCodeOf(afterRevocation.body),
      cookieTouched: touchedCookie(afterRevocation.headers),
    });
  } finally {
    await app.close();
  }
  return lines;
}

describe('the real session middleware behaves identically over both stores', () => {
  it('produces the same transcript from a Map and from Postgres', { skip: skipReason }, async () => {
    const memory = await runScript(memoryHarness());
    let sql: readonly string[] = [];
    await withSqlHarness(async (harness) => {
      sql = await runScript(harness);
    });

    // A positive control first: a transcript that recorded nothing, or that never got anybody
    // signed in, would make the comparison below true and meaningless.
    assert.equal(memory.length, 8, 'the script has eight steps');
    assert.ok(
      memory.some((line) => line.startsWith('private-signed-in status=200 isTheUser=true')),
      `the script never authenticated anybody:\n${memory.join('\n')}`,
    );
    assert.ok(
      memory.some((line) => line.startsWith('slides-past-halfway') && line.includes('expiryMoved=true')),
      `the sliding-expiry step did not slide:\n${memory.join('\n')}`,
    );

    assert.deepEqual(
      sql,
      memory,
      'the SQL store and the in-memory store must be indistinguishable through the middleware',
    );
  });
});

// ---------------------------------------------------------------------------
// Properties only the SQL implementation can have
// ---------------------------------------------------------------------------

describe('the SQL session store keeps no credential it could hand back', { skip: skipReason }, () => {
  it('stores the digest of the token and has no column for the token itself', async () => {
    await withSqlHarness(async ({ store, createUser }) => {
      const sql = client;
      assert.ok(sql !== null);
      const user = await createUser('Ada');
      const issued = await store.create(user.id, { ipHash: null, userAgentHash: null });

      const row = await sql<{ token_hash: Buffer }[]>`
        select token_hash from prl.sessions where id = ${issued.sessionId}
      `;
      assert.deepEqual(row[0]?.token_hash, hashToken(issued.token), 'the digest, not the token');

      const columns = await sql<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'prl' and table_name = 'sessions'
      `;
      const names = columns.map((column) => column.column_name);
      assert.ok(names.includes('token_hash'), `expected a digest column, found ${names.join(', ')}`);
      for (const forbidden of ['token', 'session_token', 'ip', 'ip_address', 'user_agent']) {
        assert.equal(
          names.includes(forbidden),
          false,
          `prl.sessions.${forbidden} would store a credential or an identifier in the clear`,
        );
      }

      // The plaintext genuinely cannot be recovered: a search of every text column for it finds
      // nothing. This is the sentence `prl.sessions` exists to make true.
      const leaked = await sql<{ found: number }[]>`
        select count(*)::int as found from prl.sessions
         where id = ${issued.sessionId} and token_hash = ${Buffer.from(issued.token, 'utf8')}
      `;
      assert.equal(leaked[0]?.found, 0, 'the token itself is nowhere in the row');
    });
  });
});
