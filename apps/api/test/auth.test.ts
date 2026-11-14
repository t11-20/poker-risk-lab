/**
 * The auth routes through `app.inject()` with no database and no network. The store and relying
 * party are ports, so this runs on `Map`s. The OIDC round trip uses the real relying party, because
 * a fake one would agree with a broken route. The fake store enforces what the routes rely on.
 * A token resolves only while live, and a login attempt is consumed exactly once.
 */

import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import type { DeleteAccountResponse, UserKind } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import type { Jwk, OidcRelyingParty, VerifiedIdToken } from '../src/auth/oidc.ts';
import { createOidcRelyingParty, discoveryUrlFor } from '../src/auth/oidc.ts';
import type {
  IssuedSession,
  SessionAccount,
  SessionFingerprints,
  StoredSession,
} from '../src/auth/session.ts';
import {
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_MS,
  SESSION_REFRESH_AFTER,
} from '../src/auth/session.ts';
import { type AppConfig, type EnvRecord, loadConfig, type OidcConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { hashOidcSecret } from '../src/repositories/hashing.ts';
import { DEFAULT_UNIT_ALLOWANCE } from '../src/repositories/users.ts';
import type { AuthStore, OidcAttemptStore, UserStore } from '../src/routes/auth.ts';
import { createAuthRoutes, sanitiseDisplayName } from '../src/routes/auth.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const ISSUER = 'https://idp.example.test';
const CLIENT_ID = 'poker-risk-lab-test';
const REDIRECT_URI = 'https://api.example.test/api/v1/auth/oidc/callback';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

function oidcConfig(overrides: EnvRecord = {}): AppConfig {
  return testConfig({
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'a-client-secret-that-lives-only-in-a-header',
    OIDC_REDIRECT_URI: REDIRECT_URI,
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = { ping: async () => ({ ok: true }), close: async () => undefined };

interface FakeUser {
  readonly id: string;
  readonly kind: UserKind;
  displayName: string;
  readonly createdAt: Date;
  units: number;
  readonly oidcIdentity: string | null;
}

interface FakeSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly token: string;
  readonly createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface FakeAttempt {
  readonly nonceHash: Buffer;
  readonly pkceVerifierHash: Buffer;
  readonly redirectAfter: string | null;
  readonly expiresAt: Date;
  consumed: boolean;
}

interface FakeStore {
  readonly store: AuthStore;
  readonly users: Map<string, FakeUser>;
  readonly sessions: Map<string, FakeSession>;
  readonly attempts: Map<string, FakeAttempt>;
  readonly fingerprints: SessionFingerprints[];
  readonly lastSeen: string[];
  seedUser: (overrides?: Partial<FakeUser>) => FakeUser;
  seedSession: (userId: string, overrides?: Partial<FakeSession>) => FakeSession;
}

function accountOf(user: FakeUser): SessionAccount {
  return {
    id: user.id,
    kind: user.kind,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}

function createFakeStore(): FakeStore {
  const users = new Map<string, FakeUser>();
  const sessions = new Map<string, FakeSession>();
  const attempts = new Map<string, FakeAttempt>();
  const fingerprints: SessionFingerprints[] = [];
  const lastSeen: string[] = [];
  let counter = 0;

  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}_${String(counter).padStart(8, '0')}aaaaaaaaaaaaaaaaaa`;
  }

  function seedUser(overrides: Partial<FakeUser> = {}): FakeUser {
    const user: FakeUser = {
      id: overrides.id ?? nextId('usr'),
      kind: overrides.kind ?? 'guest',
      displayName: overrides.displayName ?? 'Seeded Learner',
      createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
      units: overrides.units ?? DEFAULT_UNIT_ALLOWANCE,
      oidcIdentity: overrides.oidcIdentity ?? null,
    };
    users.set(user.id, user);
    return user;
  }

  function seedSession(userId: string, overrides: Partial<FakeSession> = {}): FakeSession {
    const session: FakeSession = {
      sessionId: overrides.sessionId ?? nextId('ses'),
      userId,
      token: overrides.token ?? randomBytes(32).toString('base64url'),
      createdAt: overrides.createdAt ?? new Date(),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + SESSION_IDLE_TTL_MS),
      revokedAt: overrides.revokedAt ?? null,
    };
    sessions.set(session.token, session);
    return session;
  }

  /** Synchronous bodies wrapped in `Promise.resolve`, because `async` with no `await` is a lint error. */
  function findOrCreateOidc(issuer: string, subject: string, displayName: string): SessionAccount {
    const identity = `${issuer}|${subject}`;
    for (const user of users.values()) {
      if (user.oidcIdentity === identity) return accountOf(user);
    }
    return accountOf(seedUser({ kind: 'oidc', displayName, oidcIdentity: identity }));
  }

  function resetUnits(userId: string): number {
    const user = users.get(userId);
    if (user === undefined) return DEFAULT_UNIT_ALLOWANCE;
    user.units = DEFAULT_UNIT_ALLOWANCE;
    return user.units;
  }

  /**
   * Removes the user and their sessions, so "the session no longer resolves" means something.
   * Hand seats, audit rows and rooms are not modelled. `account-deletion.test.ts` covers those.
   */
  function deleteAccount(userId: string): DeleteAccountResponse | null {
    if (!users.has(userId)) return null;
    let revoked = 0;
    for (const [token, session] of sessions) {
      if (session.userId !== userId) continue;
      sessions.delete(token);
      revoked += 1;
    }
    users.delete(userId);
    return {
      deleted: {
        sessions: revoked,
        lessonsCompleted: 0,
        quizAttempts: 0,
        scenarioAttempts: 0,
        roomMemberships: 0,
      },
      anonymised: { handSeats: 0, auditEvents: 0, roomsCreated: 0 },
    };
  }

  /** Mirrors `findValidByToken`. Revoked and expired sessions resolve to nothing. */
  function findValid(token: string): StoredSession | null {
    const session = sessions.get(token);
    if (session === undefined || session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= Date.now()) return null;
    const user = users.get(session.userId);
    if (user === undefined) return null;
    return { sessionId: session.sessionId, expiresAt: session.expiresAt, user: accountOf(user) };
  }

  function openSession(userId: string, prints: SessionFingerprints): IssuedSession {
    fingerprints.push(prints);
    const session = seedSession(userId);
    return { sessionId: session.sessionId, token: session.token, expiresAt: session.expiresAt };
  }

  /** Mirrors the sliding-expiry UPDATE, ceiling included. */
  function extendExpiry(sessionId: string): Date | null {
    for (const session of sessions.values()) {
      if (session.sessionId !== sessionId || session.revokedAt !== null) continue;
      const next = Math.min(
        Date.now() + SESSION_IDLE_TTL_MS,
        session.createdAt.getTime() + SESSION_ABSOLUTE_TTL_SECONDS * 1_000,
      );
      if (next <= session.expiresAt.getTime()) return null;
      session.expiresAt = new Date(next);
      return session.expiresAt;
    }
    return null;
  }

  function revoke(sessionId: string): boolean {
    for (const session of sessions.values()) {
      if (session.sessionId === sessionId && session.revokedAt === null) {
        session.revokedAt = new Date();
        return true;
      }
    }
    return false;
  }

  function createAttempt(input: {
    readonly state: string;
    readonly nonce: string;
    readonly pkceVerifier: string;
    readonly redirectAfter: string | null;
  }): void {
    attempts.set(input.state, {
      // Digests, as the table stores them.
      nonceHash: hashOidcSecret(input.nonce),
      pkceVerifierHash: hashOidcSecret(input.pkceVerifier),
      redirectAfter: input.redirectAfter,
      expiresAt: new Date(Date.now() + 10 * 60 * 1_000),
      consumed: false,
    });
  }

  /** Single use, like `UPDATE ... WHERE consumed_at IS NULL RETURNING`. */
  function consumeAttempt(state: string): {
    readonly nonceHash: Buffer;
    readonly pkceVerifierHash: Buffer;
    readonly redirectAfter: string | null;
  } | null {
    const attempt = attempts.get(state);
    if (attempt === undefined || attempt.consumed || attempt.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    attempt.consumed = true;
    return {
      nonceHash: attempt.nonceHash,
      pkceVerifierHash: attempt.pkceVerifierHash,
      redirectAfter: attempt.redirectAfter,
    };
  }

  function touchLastSeen(userId: string): boolean {
    lastSeen.push(userId);
    return users.has(userId);
  }

  const userStore: UserStore = {
    createGuest: (displayName) =>
      Promise.resolve(
        accountOf(seedUser({ displayName: displayName ?? `Guest ${randomBytes(3).toString('hex')}` })),
      ),
    findOrCreateOidc: (issuer, subject, displayName) =>
      Promise.resolve(findOrCreateOidc(issuer, subject, displayName)),
    readUnits: (userId) => Promise.resolve(users.get(userId)?.units ?? DEFAULT_UNIT_ALLOWANCE),
    resetUnits: (userId) => Promise.resolve(resetUnits(userId)),
    deleteAccount: (userId) => Promise.resolve(deleteAccount(userId)),
  };

  const attemptStore: OidcAttemptStore = {
    create: (input) => Promise.resolve(createAttempt(input)),
    consume: (state) => Promise.resolve(consumeAttempt(state)),
  };

  const store: AuthStore = {
    users: userStore,
    oidcAttempts: attemptStore,
    sessions: {
      findValidByToken: (token) => Promise.resolve(findValid(token)),
      create: (userId, prints) => Promise.resolve(openSession(userId, prints)),
      extendExpiry: (sessionId) => Promise.resolve(extendExpiry(sessionId)),
      revoke: (sessionId) => Promise.resolve(revoke(sessionId)),
      touchLastSeen: (userId) => Promise.resolve(touchLastSeen(userId)),
    },
  };

  return { store, users, sessions, attempts, fingerprints, lastSeen, seedUser, seedSession };
}

const KEY_PAIR = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_JWK: Jwk = (() => {
  const exported = KEY_PAIR.publicKey.export({ format: 'jwk' });
  return { ...exported, kty: typeof exported.kty === 'string' ? exported.kty : '', kid: 'k1', use: 'sig' };
})();

interface FakeProvider {
  readonly fetchImpl: typeof globalThis.fetch;
  /** Set from the authorization URL. */
  lastNonce: string | null;
  subject: string;
  tokenStatus: number;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFakeProvider(): FakeProvider {
  let lastNonce: string | null = null;
  let subject = 'subject-0001';
  let tokenStatus = 200;

  const b64 = (value: string): string => Buffer.from(value).toString('base64url');

  const mintIdToken = (nonce: string): string => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const claims = b64(
      JSON.stringify({
        iss: ISSUER,
        sub: subject,
        aud: CLIENT_ID,
        exp: nowSeconds + 300,
        iat: nowSeconds,
        nonce,
        name: 'Ada Lovelace',
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = sign('sha256', Buffer.from(signingInput, 'ascii'), KEY_PAIR.privateKey);
    return `${signingInput}.${signature.toString('base64url')}`;
  };

  const fetchImpl: typeof globalThis.fetch = (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === discoveryUrlFor(ISSUER)) {
      return Promise.resolve(
        jsonResponse({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    }
    if (url === `${ISSUER}/jwks`) return Promise.resolve(jsonResponse({ keys: [PUBLIC_JWK] }));
    if (url === `${ISSUER}/token`) {
      if (tokenStatus !== 200) {
        return Promise.resolve(jsonResponse({ error: 'invalid_grant' }, tokenStatus));
      }
      const nonce = lastNonce ?? 'no-nonce-was-seen';
      return Promise.resolve(
        jsonResponse({ token_type: 'Bearer', access_token: 'unused', id_token: mintIdToken(nonce) }),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };

  return {
    fetchImpl,
    get lastNonce() {
      return lastNonce;
    },
    set lastNonce(value: string | null) {
      lastNonce = value;
    },
    get subject() {
      return subject;
    },
    set subject(value: string) {
      subject = value;
    },
    get tokenStatus() {
      return tokenStatus;
    },
    set tokenStatus(value: number) {
      tokenStatus = value;
    },
  };
}

/** For tests where the protocol is not the subject. The state, cookie and PKCE checks run first. */
function stubRelyingParty(verified: VerifiedIdToken): OidcRelyingParty {
  return {
    discovery: () => Promise.reject(new Error('the stub relying party does not fetch discovery')),
    authorizationUrl: (request) =>
      Promise.resolve(
        `${ISSUER}/authorize?state=${encodeURIComponent(request.state)}` +
          `&nonce=${encodeURIComponent(request.nonce)}`,
      ),
    exchangeCode: () => Promise.resolve('header.claims.signature'),
    verifyIdToken: () => Promise.resolve(verified),
  };
}

function requiredOidcConfig(config: AppConfig): OidcConfig {
  assert.ok(config.oidc !== null, 'this test needs OIDC configured');
  return config.oidc;
}

interface HarnessOptions {
  readonly config?: AppConfig;
  readonly store?: FakeStore;
  readonly relyingParty?: OidcRelyingParty;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly store: FakeStore;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const store = options.store ?? createFakeStore();
  const app = await buildApp({ config: options.config ?? testConfig(), database: stubDatabase });
  const routeOptions =
    options.relyingParty === undefined
      ? { store: store.store }
      : { store: store.store, relyingParty: options.relyingParty };
  await registerRoutes(app, [createAuthRoutes(routeOptions)]);
  return { app, store };
}

interface CsrfPair {
  readonly token: string;
  readonly cookie: string;
}

async function csrfPair(app: FastifyInstance): Promise<CsrfPair> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
  assert.equal(response.statusCode, 200);
  const body = sessionBody(response.json());
  assert.ok(body.csrfToken !== null, 'the session read must always mint a CSRF token');
  const secret = response.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(secret !== undefined, 'the session read must set the paired CSRF cookie');
  return { token: body.csrfToken, cookie: secret.value };
}

interface SessionBody {
  readonly user: {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
    readonly units: number;
  } | null;
  readonly csrfToken: string | null;
  readonly protocolVersion: number;
  readonly oidcEnabled: boolean;
}

function sessionBody(value: unknown): SessionBody {
  assert.ok(typeof value === 'object' && value !== null, 'expected a session body');
  const shape: {
    readonly user?: unknown;
    readonly csrfToken?: unknown;
    readonly protocolVersion?: unknown;
    readonly oidcEnabled?: unknown;
  } = value;
  const rawUser = shape.user;
  let user: SessionBody['user'] = null;
  if (typeof rawUser === 'object' && rawUser !== null) {
    const inner: {
      readonly id?: unknown;
      readonly kind?: unknown;
      readonly displayName?: unknown;
      readonly units?: unknown;
    } = rawUser;
    user = {
      id: String(inner.id),
      kind: String(inner.kind),
      displayName: String(inner.displayName),
      units: Number(inner.units),
    };
  }
  return {
    user,
    csrfToken: typeof shape.csrfToken === 'string' ? shape.csrfToken : null,
    protocolVersion: Number(shape.protocolVersion),
    oidcEnabled: shape.oidcEnabled === true,
  };
}

function errorCode(value: unknown): string {
  assert.ok(typeof value === 'object' && value !== null && 'error' in value, 'expected an ApiError body');
  const outer: { readonly error?: unknown } = value;
  assert.ok(typeof outer.error === 'object' && outer.error !== null);
  const inner: { readonly code?: unknown } = outer.error;
  return String(inner.code);
}

function cookieValue(response: { cookies: { name: string; value: string }[] }, name: string): string | null {
  const found = response.cookies.find((entry) => entry.name === name);
  return found === undefined ? null : found.value;
}

async function signInAsGuest(app: FastifyInstance, displayName?: string): Promise<string> {
  const { token, cookie } = await csrfPair(app);
  const payload = displayName === undefined ? {} : { displayName };
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/guest',
    payload,
    cookies: { prl_csrf: cookie },
    headers: { 'x-csrf-token': token },
  });
  assert.equal(response.statusCode, 201, response.payload);
  const session = cookieValue(response, 'prl_session');
  assert.ok(session !== null, 'guest creation must set the session cookie');
  return session;
}

describe('GET /auth/session', () => {
  it('answers 200 with user: null for a reader who has never signed in', async () => {
    const { app } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });

    // Never 401. An anonymous reader is the normal case.
    assert.equal(response.statusCode, 200);
    const body = sessionBody(response.json());
    assert.equal(body.user, null);
    assert.equal(body.protocolVersion, 1);
    assert.equal(body.oidcEnabled, false);
    assert.ok(body.csrfToken !== null);
    await app.close();
  });

  it('reports oidcEnabled honestly', async () => {
    const { app } = await harness({ config: oidcConfig(), relyingParty: makeStubbedParty() });
    const body = sessionBody((await app.inject({ method: 'GET', url: '/api/v1/auth/session' })).json());
    assert.equal(body.oidcEnabled, true);
    await app.close();
  });

  it('resolves a session cookie into the signed-in user', async () => {
    const { app } = await harness();
    const session = await signInAsGuest(app, 'Ada Lovelace');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: session },
    });
    const body = sessionBody(response.json());
    assert.ok(body.user !== null);
    assert.equal(body.user.displayName, 'Ada Lovelace');
    assert.equal(body.user.kind, 'guest');
    assert.equal(body.user.units, DEFAULT_UNIT_ALLOWANCE);
    await app.close();
  });

  it('does not 401 on a tampered cookie, and clears it', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: 'not-a-signed-value.forged' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(sessionBody(response.json()).user, null);
    const cleared = response.cookies.find((entry) => entry.name === 'prl_session');
    assert.ok(cleared !== undefined, 'a refused cookie should be cleared');
    assert.equal(cleared.value, '');
    await app.close();
  });

  it('treats a revoked session as signed out', async () => {
    const { app, store } = await harness();
    const user = store.seedUser();
    const session = store.seedSession(user.id, { revokedAt: new Date() });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: app.signCookie(session.token) },
    });
    assert.equal(sessionBody(response.json()).user, null);
    await app.close();
  });

  it('treats an expired session as signed out', async () => {
    const { app, store } = await harness();
    const user = store.seedUser();
    const session = store.seedSession(user.id, { expiresAt: new Date(Date.now() - 1_000) });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: app.signCookie(session.token) },
    });
    assert.equal(sessionBody(response.json()).user, null);
    await app.close();
  });
});

describe('POST /auth/guest', () => {
  it('rejects a mutating request with no CSRF token', async () => {
    const { app, store } = await harness();
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/guest', payload: {} });

    assert.equal(response.statusCode, 403);
    assert.equal(errorCode(response.json()), 'csrf_failed');
    // Blocking only the response would still leave a row behind on every cross-site attempt.
    assert.equal(store.users.size, 0);
    await app.close();
  });

  it('creates an account, issues a session, and returns the contract shape', async () => {
    const { app, store } = await harness();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      payload: { displayName: 'Ada Lovelace' },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });

    assert.equal(response.statusCode, 201);
    const body = sessionBody(response.json());
    assert.ok(body.user !== null);
    assert.equal(body.user.displayName, 'Ada Lovelace');
    assert.equal(body.user.units, DEFAULT_UNIT_ALLOWANCE);
    assert.equal(store.users.size, 1);
    assert.equal(store.sessions.size, 1);
    await app.close();
  });

  it('puts the token in the cookie and nowhere else', async () => {
    const { app, store } = await harness();
    await signInAsGuest(app);
    const stored = [...store.sessions.values()][0];
    assert.ok(stored !== undefined);

    const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
    assert.equal(response.payload.includes(stored.token), false);
    await app.close();
  });

  it('sets the cookie with the attributes the security plugin defines, not its own', async () => {
    const { app } = await harness();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      payload: {},
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });

    const raw = response.headers['set-cookie'];
    const headers = Array.isArray(raw) ? raw : [String(raw)];
    const sessionCookie = headers.find((entry) => entry.startsWith('prl_session='));
    assert.ok(sessionCookie !== undefined);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Lax/i);
    assert.match(sessionCookie, /Path=\//);
    assert.match(sessionCookie, /Max-Age=\d+/);
    // Secure and `__Host-` belong to the security layer's own tests.
    await app.close();
  });

  it('hashes the address and user agent rather than storing them', async () => {
    const { app, store } = await harness();
    await signInAsGuest(app);
    const prints = store.fingerprints[0];
    assert.ok(prints !== undefined);
    assert.ok(prints.ipHash === null || prints.ipHash.length === 32);
    assert.ok(prints.userAgentHash === null || prints.userAgentHash.length === 32);
    await app.close();
  });

  it('rejects a display name the contract does not allow, rather than silently trimming it', async () => {
    const { app } = await harness();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      payload: { displayName: 'x' },
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.json()), 'invalid_request');
    await app.close();
  });

  it('generates a name when none is given', async () => {
    const { app } = await harness();
    const session = await signInAsGuest(app);
    const body = sessionBody(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/session',
          cookies: { prl_session: session },
        })
      ).json(),
    );
    assert.ok(body.user !== null);
    assert.match(body.user.displayName, /^Guest /);
    await app.close();
  });

  it('revokes the previous session when a second one is issued', async () => {
    const { app, store } = await harness();
    const first = await signInAsGuest(app);
    const { token, cookie } = await csrfPair(app);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/guest',
      payload: {},
      cookies: { prl_csrf: cookie, prl_session: first },
      headers: { 'x-csrf-token': token },
    });

    // Session fixation.
    const reused = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: first },
    });
    assert.equal(sessionBody(reused.json()).user, null);
    assert.equal(store.sessions.size, 2);
    await app.close();
  });
});

describe('sanitiseDisplayName', () => {
  /** Escaped because `security:hygiene` rejects bidi, zero-width and control characters in source. */
  const RTL_OVERRIDE = '\u202e';
  const ZERO_WIDTH_JOINER = '\u200d';
  const ZERO_WIDTH_SPACE = '\u200b';
  const BELL = '\u0007';

  it("keeps a name the contract's pattern accepts", () => {
    assert.equal(sanitiseDisplayName('Ada Lovelace'), 'Ada Lovelace');
    assert.equal(sanitiseDisplayName("O'Brien"), "O'Brien");
    assert.equal(sanitiseDisplayName('player_1'), 'player_1');
  });

  it('strips what a log viewer or a room list could be fooled by', () => {
    assert.equal(sanitiseDisplayName(`Ada${RTL_OVERRIDE}Lovelace`), 'Ada Lovelace');
    assert.equal(sanitiseDisplayName(`Ada${ZERO_WIDTH_JOINER}Lovelace`), 'Ada Lovelace');
    assert.equal(sanitiseDisplayName(`Ada${BELL}Lovelace`), 'Ada Lovelace');
    assert.equal(sanitiseDisplayName('  Ada   Lovelace  '), 'Ada Lovelace');
  });

  it('returns undefined when nothing usable survives, so the caller picks the fallback', () => {
    for (const raw of ['', ' ', RTL_OVERRIDE, 'x', '!!', `${ZERO_WIDTH_SPACE}${ZERO_WIDTH_SPACE}`]) {
      assert.equal(sanitiseDisplayName(raw), undefined, `${raw.length} characters should not survive`);
    }
    assert.equal(sanitiseDisplayName(undefined), undefined);
  });

  it('clips an over-long name to something the database will accept', () => {
    const clipped = sanitiseDisplayName('A'.repeat(200));
    assert.ok(clipped !== undefined);
    assert.equal(clipped.length, 24);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the session, clears the cookie, and is idempotent', async () => {
    const { app, store } = await harness();
    const session = await signInAsGuest(app);
    const { token, cookie } = await csrfPair(app);

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { prl_csrf: cookie, prl_session: session },
      headers: { 'x-csrf-token': token },
    });
    assert.equal(first.statusCode, 204);
    assert.equal(first.payload, '');
    assert.equal(cookieValue(first, 'prl_session'), '');
    assert.ok([...store.sessions.values()].every((entry) => entry.revokedAt !== null));

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { prl_csrf: cookie, prl_session: session },
      headers: { 'x-csrf-token': token },
    });
    assert.equal(second.statusCode, 204);

    const third = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });
    assert.equal(third.statusCode, 204);
    await app.close();
  });

  it('still requires a CSRF token', async () => {
    const { app } = await harness();
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    assert.equal(response.statusCode, 403);
    assert.equal(errorCode(response.json()), 'csrf_failed');
    await app.close();
  });
});

describe('sliding expiry', () => {
  it('extends a session that is past halfway and re-sends the cookie', async () => {
    const { app, store } = await harness();
    const user = store.seedUser();
    const before = new Date(Date.now() + SESSION_IDLE_TTL_MS * 0.25);
    const session = store.seedSession(user.id, {
      createdAt: new Date(Date.now() - SESSION_IDLE_TTL_MS * 0.75),
      expiresAt: before,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: app.signCookie(session.token) },
    });

    assert.ok(sessionBody(response.json()).user !== null, 'the session should still be usable');
    assert.ok(session.expiresAt.getTime() > before.getTime(), 'expires_at should have moved out');
    assert.ok(cookieValue(response, 'prl_session') !== null, 'the cookie should be re-sent');
    // Marking the account as seen keeps an active learner out of the guest sweep.
    assert.deepEqual(store.lastSeen, [user.id]);
    await app.close();
  });

  it('leaves a fresh session alone, so a read is not a write on every request', async () => {
    const { app, store } = await harness();
    const user = store.seedUser();
    const expiresAt = new Date(Date.now() + SESSION_IDLE_TTL_MS * (1 - SESSION_REFRESH_AFTER / 2));
    const session = store.seedSession(user.id, { expiresAt });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: app.signCookie(session.token) },
    });

    assert.ok(sessionBody(response.json()).user !== null);
    assert.equal(session.expiresAt.getTime(), expiresAt.getTime());
    assert.equal(cookieValue(response, 'prl_session'), null);
    assert.deepEqual(store.lastSeen, []);
    await app.close();
  });

  it('never slides past the absolute ceiling', async () => {
    const { app, store } = await harness();
    const user = store.seedUser();
    // One minute of absolute life left, and past the idle halfway mark.
    const createdAt = new Date(Date.now() - (SESSION_ABSOLUTE_TTL_SECONDS * 1_000 - 60_000));
    const ceiling = createdAt.getTime() + SESSION_ABSOLUTE_TTL_SECONDS * 1_000;
    const before = new Date(Date.now() + 30_000);
    const session = store.seedSession(user.id, { createdAt, expiresAt: before });

    await app.inject({
      method: 'GET',
      url: '/api/v1/auth/session',
      cookies: { prl_session: app.signCookie(session.token) },
    });

    assert.ok(session.expiresAt.getTime() > before.getTime(), 'the slide should have happened');
    assert.equal(session.expiresAt.getTime(), ceiling);
    assert.ok(session.expiresAt.getTime() < Date.now() + SESSION_IDLE_TTL_MS);
    await app.close();
  });
});

describe('POST /me/units/reset', () => {
  it('needs a session', async () => {
    const { app } = await harness();
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/units/reset',
      cookies: { prl_csrf: cookie },
      headers: { 'x-csrf-token': token },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(errorCode(response.json()), 'not_authenticated');
    await app.close();
  });

  it('answers session_expired when a cookie we signed no longer resolves', async () => {
    const { app, store } = await harness();
    const user = store.seedUser();
    const dead = store.seedSession(user.id, { expiresAt: new Date(Date.now() - 1_000) });
    const { token, cookie } = await csrfPair(app);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/me/units/reset',
      cookies: { prl_csrf: cookie, prl_session: app.signCookie(dead.token) },
      headers: { 'x-csrf-token': token },
    });
    // `session_expired` tells a client to start over rather than give up.
    assert.equal(response.statusCode, 401);
    assert.equal(errorCode(response.json()), 'session_expired');
    await app.close();
  });

  it('resets to the standing allowance, repeatedly and without complaint', async () => {
    const { app, store } = await harness();
    const session = await signInAsGuest(app);
    const user = [...store.users.values()][0];
    assert.ok(user !== undefined);
    user.units = 3;

    const { token, cookie } = await csrfPair(app);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/me/units/reset',
        cookies: { prl_csrf: cookie, prl_session: session },
        headers: { 'x-csrf-token': token },
      });
      assert.equal(response.statusCode, 200, response.payload);
      assert.deepEqual(response.json(), { units: DEFAULT_UNIT_ALLOWANCE });
    }
    await app.close();
  });
});

describe('OIDC when it is not configured', () => {
  it('answers 501 oidc_not_configured on both endpoints', async () => {
    const { app } = await harness();
    const start = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(start.statusCode, 501);
    assert.equal(errorCode(start.json()), 'oidc_not_configured');

    const callback = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/callback?state=abcdefgh&code=xyz',
    });
    assert.equal(callback.statusCode, 501);
    assert.equal(errorCode(callback.json()), 'oidc_not_configured');
    await app.close();
  });
});

function makeStubbedParty(): OidcRelyingParty {
  return stubRelyingParty({ issuer: ISSUER, subject: 'subject-0001', nameHint: 'Ada Lovelace' });
}

describe('redirectAfter on /auth/oidc/start', () => {
  it('rejects anything that could leave our origin, and accepts a path', async () => {
    const { app } = await harness({ config: oidcConfig(), relyingParty: makeStubbedParty() });

    for (const value of ['https://evil.com', '//evil.com', '/\\evil.com', 'evil.com', '/a b']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/oidc/start?redirectAfter=${encodeURIComponent(value)}`,
      });
      assert.equal(response.statusCode, 400, `${value} should have been refused`);
      assert.equal(errorCode(response.json()), 'invalid_request');
    }

    const accepted = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/oidc/start?redirectAfter=%2Fplay',
    });
    assert.equal(accepted.statusCode, 303);
    await app.close();
  });
});

interface StartedFlow {
  readonly state: string;
  readonly nonce: string;
  readonly attemptCookie: string;
}

async function startFlow(app: FastifyInstance, redirectAfter = '/play'): Promise<StartedFlow> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/oidc/start?redirectAfter=${encodeURIComponent(redirectAfter)}`,
  });
  assert.equal(response.statusCode, 303, response.payload);
  const location = response.headers['location'];
  assert.equal(typeof location, 'string');
  const url = new URL(String(location));
  const state = url.searchParams.get('state');
  const nonce = url.searchParams.get('nonce');
  const attemptCookie = cookieValue(response, 'prl_oidc');
  assert.ok(state !== null && nonce !== null && attemptCookie !== null);
  return { state, nonce, attemptCookie };
}

describe('the OIDC round trip', () => {
  it('completes, creates the account, issues a session, and returns to the stored path', async () => {
    const provider = makeFakeProvider();
    const store = createFakeStore();
    const config = oidcConfig();
    const app = await buildApp({ config, database: stubDatabase });
    await registerRoutes(app, [
      createAuthRoutes({
        store: store.store,
        relyingParty: createOidcRelyingParty({
          config: requiredOidcConfig(config),
          fetchImpl: provider.fetchImpl,
        }),
      }),
    ]);

    const flow = await startFlow(app);
    assert.equal(store.attempts.size, 1);
    provider.lastNonce = flow.nonce;

    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(flow.state)}`,
      cookies: { prl_oidc: flow.attemptCookie },
    });

    assert.equal(callback.statusCode, 303, callback.payload);
    assert.equal(callback.headers['location'], 'http://localhost:3000/play');
    const session = cookieValue(callback, 'prl_session');
    assert.ok(session !== null, 'a successful callback must issue a session');
    // The PKCE verifier must not linger in the browser.
    assert.equal(cookieValue(callback, 'prl_oidc'), '');

    const read = sessionBody(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/auth/session',
          cookies: { prl_session: session },
        })
      ).json(),
    );
    assert.ok(read.user !== null);
    assert.equal(read.user.kind, 'oidc');
    assert.equal(read.user.displayName, 'Ada Lovelace');

    const replay = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(flow.state)}`,
      cookies: { prl_oidc: flow.attemptCookie },
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(errorCode(replay.json()), 'oidc_state_mismatch');
    await app.close();
  });

  it('completes when the provider adds its own query parameters, as every real one does', async () => {
    /**
     * `app.ts` sets `removeAdditional: false`, so a strict callback schema would refuse real providers.
     * Google, Keycloak and Microsoft append extra parameters and RFC 9207 requires `iss`. This
     * sends the union of them in one callback.
     */
    const provider = makeFakeProvider();
    const store = createFakeStore();
    const config = oidcConfig();
    const app = await buildApp({ config, database: stubDatabase });
    await registerRoutes(app, [
      createAuthRoutes({
        store: store.store,
        relyingParty: createOidcRelyingParty({
          config: requiredOidcConfig(config),
          fetchImpl: provider.fetchImpl,
        }),
      }),
    ]);

    const flow = await startFlow(app);
    provider.lastNonce = flow.nonce;
    const extras = new URLSearchParams({
      code: 'the-code',
      state: flow.state,
      iss: ISSUER,
      scope: 'openid email profile',
      authuser: '0',
      prompt: 'consent',
      hd: 'school.example',
      session_state: 'a1b2c3d4',
      client_info: 'eyJ1aWQiOiIwMDAwIn0',
    });
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?${extras.toString()}`,
      cookies: { prl_oidc: flow.attemptCookie },
    });

    assert.equal(callback.statusCode, 303, callback.payload);
    assert.ok(cookieValue(callback, 'prl_session') !== null, 'the sign-in must complete');
    await app.close();
  });

  it('refuses a callback whose RFC 9207 issuer is not the one this deployment asked for', async () => {
    /**
     * RFC 9207 mix-up. An attacker can obtain a genuine `state`, so this callback carries a valid
     * one and must still be refused. The check runs before the attempt is consumed.
     */
    const provider = makeFakeProvider();
    const store = createFakeStore();
    const config = oidcConfig();
    const app = await buildApp({ config, database: stubDatabase });
    await registerRoutes(app, [
      createAuthRoutes({
        store: store.store,
        relyingParty: createOidcRelyingParty({
          config: requiredOidcConfig(config),
          fetchImpl: provider.fetchImpl,
        }),
      }),
    ]);

    const flow = await startFlow(app);
    provider.lastNonce = flow.nonce;
    const callback = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(flow.state)}&iss=${encodeURIComponent('https://attacker.example.test')}`,
      cookies: { prl_oidc: flow.attemptCookie },
    });

    assert.equal(errorCode(callback.json()), 'oidc_exchange_failed');
    assert.equal(cookieValue(callback, 'prl_session'), null, 'no session may be issued');
    assert.equal(store.attempts.size, 1, 'the legitimate attempt must survive a rejected callback');

    // Positive control. The right issuer completes, so the refusal above is the issuer check.
    const good = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=the-code&state=${encodeURIComponent(flow.state)}&iss=${encodeURIComponent(ISSUER)}`,
      cookies: { prl_oidc: flow.attemptCookie },
    });
    assert.equal(good.statusCode, 303, good.payload);
    await app.close();
  });

  it('reuses the account on a second sign-in rather than creating a duplicate', async () => {
    const provider = makeFakeProvider();
    const store = createFakeStore();
    const config = oidcConfig();
    const app = await buildApp({ config, database: stubDatabase });
    const party = createOidcRelyingParty({
      config: requiredOidcConfig(config),
      fetchImpl: provider.fetchImpl,
    });
    await registerRoutes(app, [createAuthRoutes({ store: store.store, relyingParty: party })]);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const flow = await startFlow(app, '/');
      provider.lastNonce = flow.nonce;
      const callback = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(flow.state)}`,
        cookies: { prl_oidc: flow.attemptCookie },
      });
      assert.equal(callback.statusCode, 303, callback.payload);
    }

    // Identity is (iss, sub).
    assert.equal(store.users.size, 1);
    await app.close();
  });
});

describe('the OIDC callback refuses', () => {
  async function callbackHarness(): Promise<{ app: FastifyInstance; store: FakeStore }> {
    const store = createFakeStore();
    const app = await buildApp({ config: oidcConfig(), database: stubDatabase });
    await registerRoutes(app, [createAuthRoutes({ store: store.store, relyingParty: makeStubbedParty() })]);
    return { app, store };
  }

  it('a callback with no attempt cookie', async () => {
    const { app } = await callbackHarness();
    const flow = await startFlow(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(flow.state)}`,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.json()), 'oidc_state_mismatch');
    await app.close();
  });

  it('a state that does not match the cookie, which is the login-CSRF case', async () => {
    const { app } = await callbackHarness();
    const mine = await startFlow(app);
    const theirs = await startFlow(app);

    // The attacker's state, the victim's cookie. Only the cookie comparison stands in the way.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(theirs.state)}`,
      cookies: { prl_oidc: mine.attemptCookie },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.json()), 'oidc_state_mismatch');
    await app.close();
  });

  it('a PKCE verifier that does not match the attempt', async () => {
    const { app } = await callbackHarness();
    const flow = await startFlow(app);
    // What an attacker with a stolen code but not the victim's cookie would produce.
    const tampered = app.signCookie(`${flow.state}.${randomBytes(32).toString('base64url')}`);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(flow.state)}`,
      cookies: { prl_oidc: tampered },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.json()), 'oidc_state_mismatch');
    await app.close();
  });

  it('an unsigned or malformed attempt cookie', async () => {
    const { app } = await callbackHarness();
    const flow = await startFlow(app);
    for (const cookie of [`${flow.state}.plaintext-not-signed`, 'garbage', app.signCookie('only-one-half')]) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(flow.state)}`,
        cookies: { prl_oidc: cookie },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(errorCode(response.json()), 'oidc_state_mismatch');
    }
    await app.close();
  });

  it('a state that was never issued', async () => {
    const { app } = await callbackHarness();
    const state = randomBytes(32).toString('base64url');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}`,
      cookies: { prl_oidc: app.signCookie(`${state}.${randomBytes(32).toString('base64url')}`) },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.json()), 'oidc_state_mismatch');
    await app.close();
  });

  it('a provider error response, without echoing what it said', async () => {
    const { app } = await callbackHarness();
    const flow = await startFlow(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?state=${encodeURIComponent(flow.state)}&error=access_denied&error_description=nope`,
      cookies: { prl_oidc: flow.attemptCookie },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(errorCode(response.json()), 'oidc_exchange_failed');
    assert.equal(response.payload.includes('access_denied'), false);
    await app.close();
  });

  it('a callback carrying neither a code nor an error', async () => {
    const { app } = await callbackHarness();
    const flow = await startFlow(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?state=${encodeURIComponent(flow.state)}`,
      cookies: { prl_oidc: flow.attemptCookie },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(errorCode(response.json()), 'oidc_exchange_failed');
    await app.close();
  });

  it('a failed token exchange', async () => {
    const provider = makeFakeProvider();
    provider.tokenStatus = 400;
    const store = createFakeStore();
    const config = oidcConfig();
    const app = await buildApp({ config, database: stubDatabase });
    await registerRoutes(app, [
      createAuthRoutes({
        store: store.store,
        relyingParty: createOidcRelyingParty({
          config: requiredOidcConfig(config),
          fetchImpl: provider.fetchImpl,
        }),
      }),
    ]);

    const flow = await startFlow(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(flow.state)}`,
      cookies: { prl_oidc: flow.attemptCookie },
    });
    assert.equal(response.statusCode, 502);
    assert.equal(errorCode(response.json()), 'oidc_exchange_failed');
    assert.equal(cookieValue(response, 'prl_session'), null);
    await app.close();
  });

  it('an ID token minted for a different attempt (a replayed nonce)', async () => {
    const provider = makeFakeProvider();
    const store = createFakeStore();
    const config = oidcConfig();
    const app = await buildApp({ config, database: stubDatabase });
    await registerRoutes(app, [
      createAuthRoutes({
        store: store.store,
        relyingParty: createOidcRelyingParty({
          config: requiredOidcConfig(config),
          fetchImpl: provider.fetchImpl,
        }),
      }),
    ]);

    const first = await startFlow(app);
    const second = await startFlow(app);
    // A token for the first attempt's nonce, replayed into the second attempt's callback.
    provider.lastNonce = first.nonce;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=c&state=${encodeURIComponent(second.state)}`,
      cookies: { prl_oidc: second.attemptCookie },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(errorCode(response.json()), 'oidc_state_mismatch');
    assert.equal(cookieValue(response, 'prl_session'), null);
    await app.close();
  });

  it('and never leaves the attempt cookie behind after a failure', async () => {
    const { app } = await callbackHarness();
    const flow = await startFlow(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?state=${encodeURIComponent(flow.state)}&error=access_denied`,
      cookies: { prl_oidc: flow.attemptCookie },
    });
    assert.equal(cookieValue(response, 'prl_oidc'), '');
    await app.close();
  });
});
