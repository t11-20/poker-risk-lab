/**
 * One list of session behaviours run against a `Map` and against Postgres, so the fake cannot
 * drift from the SQL it stands in for. It runs at the port (`SessionStore`'s five operations) and
 * through the real `sessionPlugin`, whose two transcripts must be equal. The fake is written here
 * because importing `auth.test.ts` would run its suite. `createAuthStore` takes the pool, so cases
 * delete the accounts they create and `ON DELETE CASCADE` takes the sessions.
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

interface StoreHarness {
  readonly store: SessionStore;
  readonly createUser: (displayName: string) => Promise<SessionAccount>;
  /** Both timestamps move together, as `sessions_expires_after_creation` requires. */
  readonly backdate: (sessionId: string, ms: number) => Promise<void>;
}

interface Implementation {
  readonly name: string;
  /** A reason when this implementation cannot run. */
  readonly skip: string | false;
  readonly with: (run: (harness: StoreHarness) => Promise<void>) => Promise<void>;
}

interface MemorySession {
  readonly sessionId: string;
  readonly userId: string;
  readonly token: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

/** Synchronous bodies wrapped at the port, because `async` with no `await` is a lint error. */
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
      // `least(now() + ttl, created_at + ceiling)`, and a session at its ceiling matches nothing.
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

/** `createAuthStore(sql).sessions` is exactly what `src/routes/auth.ts` hands to `sessionPlugin`. */
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

const NO_FINGERPRINTS = { ipHash: null, userAgentHash: null };

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
      await backdate(issued.sessionId, SESSION_TTL_SECONDS * 1_000 + 60_000);
      assert.equal(await store.findValidByToken(issued.token), null, 'expiry is in the lookup');
    },
  },
  {
    name: 'slides an expiry forward, and never past the absolute ceiling',
    run: async ({ store, createUser, backdate }) => {
      const user = await createUser('Ada');
      const issued = await store.create(user.id, NO_FINGERPRINTS);

      await backdate(issued.sessionId, SESSION_IDLE_TTL_MS * 0.75);
      const slid = await store.extendExpiry(issued.sessionId);
      assert.ok(slid !== null, 'a session past halfway must be extendable');
      assert.ok(
        slid.getTime() > issued.expiresAt.getTime() - SESSION_IDLE_TTL_MS * 0.75,
        'the new expiry is later than the one it replaced',
      );

      // The ceiling is measured from `created_at`, not from now.
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

const config = testConfig();

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
 * Normalised lines, because ids, tokens and timestamps differ by construction. Status, resolution,
 * rejection and cookie behaviour must match.
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

    // Not signed by this server, so refused before any lookup and the cookie is cleared.
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

    // `session_expired`, not `not_authenticated`, so a client opens a fresh guest session.
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
      // Short of halfway, so the cookie must not be re-sent.
      cookieTouched: touchedCookie(authorised.headers),
    });

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

    // An empty or never-signed-in transcript would make the comparison below true and meaningless.
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

      // No text column anywhere holds the plaintext.
      const leaked = await sql<{ found: number }[]>`
        select count(*)::int as found from prl.sessions
         where id = ${issued.sessionId} and token_hash = ${Buffer.from(issued.token, 'utf8')}
      `;
      assert.equal(leaked[0]?.found, 0, 'the token itself is nowhere in the row');
    });
  });
});
