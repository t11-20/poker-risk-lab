/**
 * Thirty learners behind one address signing in at once. These routes are keyed on the hashed client
 * address because a route that issues a session cannot be limited by that session. This asserts that a
 * cohort gets through, a script that cannot complete is refused sooner, guests stay at 10 and forced
 * token exchanges at 15 per window, and boot refuses limits that cannot serve a declared cohort. No
 * database or network, so this runs under `test:without-database`.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { describe, it } from 'node:test';
import type { UserKind } from '@prl/contracts';
import type { FastifyInstance } from 'fastify';
import { buildApp, registerRoutes } from '../src/app.ts';
import type { OidcRelyingParty } from '../src/auth/oidc.ts';
import type {
  IssuedSession,
  SessionAccount,
  SessionFingerprints,
  StoredSession,
} from '../src/auth/session.ts';
import { SESSION_IDLE_TTL_MS } from '../src/auth/session.ts';
import { type AppConfig, ConfigError, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { OutcomeBudget } from '../src/plugins/outcome-budget.ts';
import { hashOidcSecret } from '../src/repositories/hashing.ts';
import { DEFAULT_UNIT_ALLOWANCE } from '../src/repositories/users.ts';
import type { AuthStore, OidcAttemptStore, UserStore } from '../src/routes/auth.ts';
import { createAuthRoutes } from '../src/routes/auth.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const ISSUER = 'https://idp.example.test';
const CLIENT_ID = 'poker-risk-lab-test';
const REDIRECT_URI = 'https://api.example.test/api/v1/auth/oidc/callback';

const COHORT_SIZE = 30;

const stubDatabase: DatabaseHandle = { ping: async () => ({ ok: true }), close: async () => undefined };

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so every 429 here comes from a route-level limit and never the global one.
    RATE_LIMIT_MAX: '100000',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'a-client-secret-that-lives-only-in-a-header',
    OIDC_REDIRECT_URI: REDIRECT_URI,
    ...overrides,
  });
}

interface FakeUser {
  readonly id: string;
  readonly kind: UserKind;
  readonly displayName: string;
  readonly createdAt: Date;
  readonly oidcIdentity: string | null;
}

interface FakeSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

interface FakeAttempt {
  readonly nonceHash: Buffer;
  readonly pkceVerifierHash: Buffer;
  readonly redirectAfter: string | null;
  consumed: boolean;
}

interface FakeStore {
  readonly store: AuthStore;
  readonly users: Map<string, FakeUser>;
  readonly attempts: Map<string, FakeAttempt>;
}

/** Attempts are single-use, or a script could replay one attempt into many sign-ins. */
function createFakeStore(): FakeStore {
  const users = new Map<string, FakeUser>();
  const sessions = new Map<string, FakeSession>();
  const attempts = new Map<string, FakeAttempt>();
  let counter = 0;

  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}_${String(counter).padStart(8, '0')}aaaaaaaaaaaaaaaaaa`;
  }

  function addUser(kind: UserKind, displayName: string, oidcIdentity: string | null): SessionAccount {
    const user: FakeUser = {
      id: nextId('usr'),
      kind,
      displayName,
      createdAt: new Date(),
      oidcIdentity,
    };
    users.set(user.id, user);
    return { id: user.id, kind, displayName, createdAt: user.createdAt.toISOString() };
  }

  function findOrCreateOidc(issuer: string, subject: string, displayName: string): SessionAccount {
    const identity = `${issuer}|${subject}`;
    for (const user of users.values()) {
      if (user.oidcIdentity !== identity) continue;
      return {
        id: user.id,
        kind: user.kind,
        displayName: user.displayName,
        createdAt: user.createdAt.toISOString(),
      };
    }
    return addUser('oidc', displayName, identity);
  }

  function openSession(userId: string): IssuedSession {
    const session: FakeSession = {
      sessionId: nextId('ses'),
      userId,
      token: randomBytes(32).toString('base64url'),
      expiresAt: new Date(Date.now() + SESSION_IDLE_TTL_MS),
    };
    sessions.set(session.token, session);
    return { sessionId: session.sessionId, token: session.token, expiresAt: session.expiresAt };
  }

  function findValid(token: string): StoredSession | null {
    const session = sessions.get(token);
    if (session === undefined) return null;
    const user = users.get(session.userId);
    if (user === undefined) return null;
    return {
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      user: {
        id: user.id,
        kind: user.kind,
        displayName: user.displayName,
        createdAt: user.createdAt.toISOString(),
      },
    };
  }

  const userStore: UserStore = {
    createGuest: (displayName) =>
      Promise.resolve(addUser('guest', displayName ?? `Guest ${randomBytes(3).toString('hex')}`, null)),
    findOrCreateOidc: (issuer, subject, displayName) =>
      Promise.resolve(findOrCreateOidc(issuer, subject, displayName)),
    readUnits: () => Promise.resolve(DEFAULT_UNIT_ALLOWANCE),
    resetUnits: () => Promise.resolve(DEFAULT_UNIT_ALLOWANCE),
    deleteAccount: () => Promise.resolve(null),
  };

  const attemptStore: OidcAttemptStore = {
    create: (input) =>
      Promise.resolve(
        void attempts.set(input.state, {
          nonceHash: hashOidcSecret(input.nonce),
          pkceVerifierHash: hashOidcSecret(input.pkceVerifier),
          redirectAfter: input.redirectAfter,
          consumed: false,
        }),
      ),
    consume: (state) => {
      const attempt = attempts.get(state);
      if (attempt === undefined || attempt.consumed) return Promise.resolve(null);
      attempt.consumed = true;
      return Promise.resolve({
        nonceHash: attempt.nonceHash,
        pkceVerifierHash: attempt.pkceVerifierHash,
        redirectAfter: attempt.redirectAfter,
      });
    },
  };

  const store: AuthStore = {
    users: userStore,
    oidcAttempts: attemptStore,
    sessions: {
      findValidByToken: (token) => Promise.resolve(findValid(token)),
      create: (userId, _prints: SessionFingerprints) => Promise.resolve(openSession(userId)),
      extendExpiry: () => Promise.resolve(null),
      revoke: () => Promise.resolve(true),
      touchLastSeen: () => Promise.resolve(true),
    },
  };

  return { store, users, attempts };
}

/** Succeeds for everyone with a fresh subject per call, so thirty sign-ins make thirty accounts. */
function cohortRelyingParty(): OidcRelyingParty {
  let student = 0;
  return {
    discovery: () => Promise.reject(new Error('the cohort relying party does not fetch discovery')),
    authorizationUrl: (request) =>
      Promise.resolve(
        `${ISSUER}/authorize?state=${encodeURIComponent(request.state)}` +
          `&nonce=${encodeURIComponent(request.nonce)}`,
      ),
    exchangeCode: () => Promise.resolve('header.claims.signature'),
    verifyIdToken: () => {
      student += 1;
      return Promise.resolve({
        issuer: ISSUER,
        subject: `student-${String(student).padStart(4, '0')}`,
        nameHint: `Student ${student}`,
      });
    },
  };
}

/**
 * The script. A start hands it a real state and attempt cookie, so it reaches the token endpoint and
 * fails there. Each callback costs an outbound request and issues no session.
 */
function refusingRelyingParty(): OidcRelyingParty {
  return {
    discovery: () => Promise.reject(new Error('the refusing relying party does not fetch discovery')),
    authorizationUrl: (request) =>
      Promise.resolve(
        `${ISSUER}/authorize?state=${encodeURIComponent(request.state)}` +
          `&nonce=${encodeURIComponent(request.nonce)}`,
      ),
    exchangeCode: () => Promise.reject(new Error('the provider refused this code')),
    verifyIdToken: () => Promise.reject(new Error('no token was ever obtained')),
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly store: FakeStore;
}

async function harness(config: AppConfig, relyingParty: OidcRelyingParty): Promise<Harness> {
  const store = createFakeStore();
  const app = await buildApp({ config, database: stubDatabase });
  await registerRoutes(app, [createAuthRoutes({ store: store.store, relyingParty })]);
  return { app, store };
}

function cookieValue(response: { cookies: { name: string; value: string }[] }, name: string): string | null {
  const found = response.cookies.find((entry) => entry.name === name);
  return found === undefined ? null : found.value;
}

interface CsrfPair {
  readonly token: string;
  readonly cookie: string;
}

async function csrfPair(app: FastifyInstance): Promise<CsrfPair> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
  assert.equal(response.statusCode, 200, response.payload);
  const body: { readonly csrfToken?: unknown } = response.json();
  const secret = cookieValue(response, 'prl_csrf');
  assert.ok(secret !== null, 'the session read must set the paired CSRF cookie');
  return { token: String(body.csrfToken), cookie: secret };
}

interface SignInOutcome {
  readonly startStatus: number;
  readonly callbackStatus: number | null;
  readonly sessionIssued: boolean;
}

async function signIn(app: FastifyInstance): Promise<SignInOutcome> {
  const start = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/oidc/start?redirectAfter=%2Fplay',
  });
  if (start.statusCode !== 303) {
    return { startStatus: start.statusCode, callbackStatus: null, sessionIssued: false };
  }
  const location = String(start.headers['location']);
  const state = new URL(location).searchParams.get('state');
  const attemptCookie = cookieValue(start, 'prl_oidc');
  assert.ok(state !== null && attemptCookie !== null, 'a 303 start must carry a state and a cookie');

  const callback = await app.inject({
    method: 'GET',
    url: `/api/v1/auth/oidc/callback?code=code-for-${encodeURIComponent(state)}&state=${encodeURIComponent(state)}`,
    cookies: { prl_oidc: attemptCookie },
  });
  const session = cookieValue(callback, 'prl_session');
  return {
    startStatus: start.statusCode,
    callbackStatus: callback.statusCode,
    sessionIssued: session !== null && session !== '',
  };
}

function retryAfterSeconds(payload: string): number {
  const parsed: { readonly error?: { readonly retryAfterSeconds?: unknown } } = JSON.parse(payload);
  const value = parsed.error?.retryAfterSeconds;
  assert.equal(typeof value, 'number', `a rate_limited body must say how long to wait: ${payload}`);
  return Number(value);
}

interface CohortResult {
  readonly completed: number;
  readonly refused: number;
  readonly firstRefusalAt: number | null;
}

async function driveCohort(app: FastifyInstance, size: number): Promise<CohortResult> {
  let completed = 0;
  let refused = 0;
  let firstRefusalAt: number | null = null;
  for (let learner = 1; learner <= size; learner += 1) {
    const outcome = await signIn(app);
    if (outcome.sessionIssued) {
      completed += 1;
      continue;
    }
    if (outcome.startStatus === 429 || outcome.callbackStatus === 429) {
      refused += 1;
      firstRefusalAt ??= learner;
    }
  }
  return { completed, refused, firstRefusalAt };
}

describe('a cohort of learners behind one address', () => {
  it('signs in completely, with no refusals, against the shipped defaults', async () => {
    const { app, store } = await harness(testConfig(), cohortRelyingParty());
    const result = await driveCohort(app, COHORT_SIZE);

    assert.equal(
      result.completed,
      COHORT_SIZE,
      `only ${result.completed} of ${COHORT_SIZE} learners completed a sign-in; the first refusal ` +
        `was learner ${String(result.firstRefusalAt)}. A paying cohort's first interaction with ` +
        'this product must not be a 429.',
    );
    assert.equal(result.refused, 0, 'no learner in a cohort of this size may be told to wait');
    // Thirty accounts proves the harness drove distinct people, not one identity reused.
    assert.equal(store.users.size, COHORT_SIZE);
    await app.close();
  });

  it('does not need a cookie or a session to do it, so the bucket key cannot rotate', async () => {
    // The cohort above sent no session cookie. If the key preferred the session, each learner would
    // get a bucket of their own and the cohort test would pass for the wrong reason.
    const { app } = await harness(testConfig(), refusingRelyingParty());
    let refusedAt: number | null = null;
    for (let attempt = 1; attempt <= 200 && refusedAt === null; attempt += 1) {
      const outcome = await signIn(app);
      if (outcome.startStatus === 429 || outcome.callbackStatus === 429) refusedAt = attempt;
    }
    assert.ok(
      refusedAt !== null,
      'two hundred failed sign-in attempts from one address were never refused; the address key ' +
        'is not accumulating, which is the exact defect clientKeyedRateLimit was written for',
    );
    await app.close();
  });
});

describe('a script that starts sign-ins it cannot complete', () => {
  it('is refused sooner than a cohort of the same size is', async () => {
    const { app } = await harness(testConfig(), refusingRelyingParty());
    let attempts = 0;
    let refusedAt: number | null = null;
    while (attempts < COHORT_SIZE && refusedAt === null) {
      attempts += 1;
      const outcome = await signIn(app);
      assert.equal(outcome.sessionIssued, false, 'the refusing provider must never issue a session');
      if (outcome.startStatus === 429 || outcome.callbackStatus === 429) refusedAt = attempts;
    }
    // "Refused eventually" would pass against a limiter with no split. The script must meet its
    // ceiling strictly sooner than a cohort meets theirs.
    assert.ok(
      refusedAt !== null && refusedAt < COHORT_SIZE,
      `a script got ${String(attempts)} failed sign-in attempts from one address without being ` +
        'refused. Failed outcomes must be charged to a tighter budget than completed ones, or ' +
        'the cohort allowance is simply handed to the script.',
    );
    await app.close();
  });

  it('still forces no more outbound token exchanges than the shipped limit permitted', async () => {
    // `RATE_LIMIT_OIDC_FAILURE_MAX` defaults to 15 forced token-endpoint exchanges per address per window.
    // Exact equality, because fewer breaks a learner who cancels consent twice and more is the regression.
    const config = testConfig();
    const { app } = await harness(config, refusingRelyingParty());
    let forcedExchanges = 0;
    // 200 attempts against a 15-per-window budget, so the budget stops this and not the loop bound.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const outcome = await signIn(app);
      if (outcome.startStatus === 429 || outcome.callbackStatus === 429) continue;
      if (outcome.callbackStatus !== null) forcedExchanges += 1;
    }
    assert.equal(
      forcedExchanges,
      config.rateLimit.oidcFailureMax,
      `a script forced ${forcedExchanges} token-endpoint exchanges from one address in one ` +
        `window; the shipped configuration permitted ${config.rateLimit.oidcFailureMax} and this ` +
        'number is not allowed to grow because the sign-in ceiling did',
    );
    await app.close();
  });

  it('is not locked out for longer than the window by its own refusals', async () => {
    // A 429 charged to the failure budget would push the window forward on every retry and never
    // readmit the caller (`continueExceeding` in `@fastify/rate-limit`, enabled nowhere here). The
    // retry-after must only count down.
    const config = testConfig();
    const { app } = await harness(config, refusingRelyingParty());
    // Enough to exhaust the failure budget, and well under the cohort ceiling.
    for (let attempt = 0; attempt <= config.rateLimit.oidcFailureMax; attempt += 1) {
      await signIn(app);
    }

    const first = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(first.statusCode, 429, `the failed-outcome budget never refused: ${first.payload}`);
    const firstWait = retryAfterSeconds(first.payload);

    let latestWait = firstWait;
    for (let retry = 0; retry < 20; retry += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
      assert.equal(response.statusCode, 429, response.payload);
      latestWait = retryAfterSeconds(response.payload);
    }
    assert.ok(
      latestWait <= firstWait,
      `retrying pushed the wait from ${firstWait}s to ${latestWait}s. A refusal must not charge ` +
        'the budget it was issued from, or a caller who keeps trying is never let back in',
    );
    await app.close();
  });
});

/**
 * The callback is a GET, so any site can make a visitor's browser send it as an `<img>`, with no CSRF
 * token and no session. A callback failure is charged only after `acceptAttempt` succeeds, which needs
 * the signed `__Host-` attempt cookie no other site can produce.
 */
describe('a hostile page pointing a victim’s browser at the callback', () => {
  /** What a browser attaches to a no-cors subresource load from another site. */
  const CROSS_SITE_SUBRESOURCE: Readonly<Record<string, string>> = {
    origin: 'https://evil.test',
    referer: 'https://evil.test/',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'image',
  };

  it('cannot spend the victim address’s failure budget', async () => {
    const config = testConfig();
    const { app } = await harness(config, cohortRelyingParty());
    const statuses: number[] = [];
    // Past the budget, so any charge would show as a 429 at the end.
    for (let attempt = 0; attempt < config.rateLimit.oidcFailureMax + 5; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/oidc/callback?state=aaaaaaaa${attempt}`,
        headers: CROSS_SITE_SUBRESOURCE,
      });
      statuses.push(response.statusCode);
    }
    assert.equal(
      statuses.filter((status) => status === 429).length,
      0,
      `a cross-site caller exhausted the budget for an address that is not theirs: ${statuses.join(',')}`,
    );

    const victim = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(
      victim.statusCode,
      303,
      `a learner behind the same address was refused a sign-in by somebody else's traffic: ${victim.payload}`,
    );
    await app.close();
  });

  /** A cross-site start refused with 400 by `refuseNonNavigationOidc` must not be charged either. */
  it('cannot spend it through the START route either (REGRESSION)', async () => {
    const config = testConfig();
    const { app } = await harness(config, cohortRelyingParty());
    const statuses: number[] = [];
    for (let attempt = 0; attempt < config.rateLimit.oidcFailureMax + 5; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/oidc/start',
        headers: CROSS_SITE_SUBRESOURCE,
      });
      statuses.push(response.statusCode);
    }

    const victim = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(
      victim.statusCode,
      303,
      `a learner behind the same address was refused a sign-in by somebody else's traffic to ` +
        `the start route: ${victim.payload} (attacker saw ${statuses.join(',')})`,
    );
    await app.close();
  });

  /**
   * Positive control for the cross-site tests. A start that fails inside the handler spent an
   * outbound request and must still be charged, or never charging would pass them.
   */
  it('still charges a start that fails inside the handler — the positive control', async () => {
    const config = testConfig();
    const unreachable: OidcRelyingParty = {
      discovery: () => Promise.reject(new Error('the provider is unreachable')),
      authorizationUrl: () => Promise.reject(new Error('the provider is unreachable')),
      exchangeCode: () => Promise.reject(new Error('the provider is unreachable')),
      verifyIdToken: () => Promise.reject(new Error('the provider is unreachable')),
    };
    const { app } = await harness(config, unreachable);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < config.rateLimit.oidcFailureMax + 2; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
      statuses.push(response.statusCode);
    }
    assert.ok(
      statuses.includes(429),
      `a caller forcing ${String(config.rateLimit.oidcFailureMax + 2)} failed starts was never ` +
        `refused; the failed-outcome budget is not being charged at all: ${statuses.join(',')}`,
    );
    await app.close();
  });

  // Fastify validates the query before `preHandler`, so a schema refusal runs no guard of ours.
  it('cannot spend it with a start the SCHEMA refuses, above every guard (REGRESSION)', async () => {
    const config = testConfig();
    const { app } = await harness(config, cohortRelyingParty());
    const statuses: number[] = [];
    for (let attempt = 0; attempt < config.rateLimit.oidcFailureMax + 2; attempt += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/oidc/start?redirectAfter=https%3A%2F%2Fevil.test%2Fx',
        headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
      });
      statuses.push(response.statusCode);
    }
    // If these stopped being 400s, the victim assertion would pass without testing the schema path.
    assert.ok(
      statuses.every((status) => status === 400),
      `the malformed starts must be refused by the schema, not answered: ${statuses.join(',')}`,
    );

    const victim = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(
      victim.statusCode,
      303,
      `a learner behind the same address was refused a sign-in by somebody else's malformed ` +
        `traffic: ${victim.payload}`,
    );
    await app.close();
  });
});

/**
 * A start that succeeds is not a failed outcome, so starts that never call back are bounded only by
 * the route ceiling. The global limiter does not stack with a route's own `rateLimit`, and the
 * six-hourly retention sweep removes at most 100,000 rows per table. `oidcUnredeemedStarts` bounds
 * unredeemed starts over the attempt row's 10-minute TTL. Within one window it and the ceiling both
 * refuse at 60, so only the multi-window test tells them apart.
 */
describe('a script that floods /auth/oidc/start and never calls back', () => {
  it('is bounded by nothing but the route ceiling in a single window — the baseline', async () => {
    const config = testConfig();
    const { app, store } = await harness(config, cohortRelyingParty());
    let written = 0;
    for (let attempt = 0; attempt < config.rateLimit.oidcMax * 4; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
      if (response.statusCode === 303) written += 1;
    }
    // Exactly the ceiling, which is why the multi-window test below is needed.
    assert.equal(written, config.rateLimit.oidcMax);
    assert.equal(store.attempts.size, written, 'every allowed start must have written its row');
    await app.close();
  });

  it('costs the flooder nothing from the global bucket, so that is not the bound either', async () => {
    // A route-level `rateLimit` config replaces the global bucket for that route, so the global
    // limit is not a second bound.
    const config = testConfig({ RATE_LIMIT_MAX: '300' });
    const { app } = await harness(config, cohortRelyingParty());
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    }
    const ordinary = await app.inject({ method: 'GET', url: '/api/v1/ready' });
    assert.equal(
      ordinary.statusCode,
      200,
      'if this is a 429 then the global bucket DOES bound a start flood, and the sizing comment ' +
        'in routes/auth.ts should say so',
    );
    await app.close();
  });

  it('cannot keep writing rows window after window, because unredeemed starts do not roll', async () => {
    // The ceiling's window is at its 1-second floor and rolls each round. The unredeemed-start window,
    // the 10-minute TTL, does not. Without that budget this writes `ceiling x rounds` rows.
    const ceiling = 12;
    const rounds = 3;
    const config = testConfig({
      RATE_LIMIT_OIDC_MAX: String(ceiling),
      RATE_LIMIT_OIDC_WINDOW_MS: '1000',
      RATE_LIMIT_OIDC_FAILURE_MAX: String(ceiling - 1),
    });
    const { app, store } = await harness(config, cohortRelyingParty());

    for (let round = 0; round < rounds; round += 1) {
      for (let attempt = 0; attempt < ceiling * 2; attempt += 1) {
        await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
      }
      // Wait out the ceiling's window so only the unredeemed-start budget can refuse.
      if (round < rounds - 1) await new Promise((resolve) => setTimeout(resolve, 1_100));
    }

    assert.equal(
      store.attempts.size,
      ceiling,
      `a flooder wrote ${store.attempts.size} attempt rows across ${rounds} ceiling windows. ` +
        `Without the unredeemed-start budget it writes ${ceiling * rounds}; with it, ${ceiling}. ` +
        'Attempt rows are removed by a six-hourly sweep and not by their TTL, so an unbounded ' +
        'per-window allowance here is a table that grows for as long as the flood lasts',
    );
    await app.close();
  });

  it('does not charge a cohort for starts they redeem, however many windows they span', async () => {
    // Positive control. A redeemed start must be credited back, or learner `ceiling + 1` is refused.
    const ceiling = 4;
    const learners = 10;
    const config = testConfig({
      RATE_LIMIT_OIDC_MAX: String(ceiling),
      RATE_LIMIT_OIDC_WINDOW_MS: '1000',
      // A failure budget at or above the ceiling is refused at boot.
      RATE_LIMIT_OIDC_FAILURE_MAX: String(ceiling - 1),
    });
    const { app, store } = await harness(config, cohortRelyingParty());

    let completed = 0;
    for (let learner = 0; learner < learners; learner += 1) {
      // Paced so the ceiling never refuses. The unredeemed-start window does not roll in this test.
      if (learner > 0 && learner % ceiling === 0) {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
      const outcome = await signIn(app);
      if (outcome.sessionIssued) completed += 1;
    }

    assert.equal(
      completed,
      learners,
      `only ${completed} of ${learners} learners completed. A redeemed start must be credited ` +
        'back, or the unredeemed-start budget becomes a cap on how many people can ever sign in ' +
        'from one address inside the attempt TTL — which is the cohort defect again, wearing a ' +
        'different hat',
    );
    assert.equal(store.users.size, learners);
    await app.close();
  });
});

/**
 * An entry can only refuse, so evicting one can only permit, and filling the map flushes only the
 * caller's own counters. Every call passes one fixed `now`: `refusalFor` depends on the clock, and an
 * exact `60000` reads `59999` when the clock ticks between charge and read.
 */
describe('the outcome budgets bound their own memory', () => {
  const NOW = 1_700_000_000_000;

  it('evicts the least recently used key at capacity and never grows past it', () => {
    const budget = new OutcomeBudget({ max: 1, windowMs: 60_000, cache: 4 });
    for (let key = 0; key < 100; key += 1) budget.charge(`addr-${key}`, NOW);
    assert.equal(budget.size(), 4, 'the map grew past its cache bound');
    // The four most recent keys survive.
    assert.equal(budget.refusalFor('addr-99', NOW), 60_000);
    assert.equal(budget.refusalFor('addr-0', NOW), null, 'the oldest key should have been evicted');
  });

  it('eviction can only ever PERMIT, which is why flushing it is not an attack', () => {
    const budget = new OutcomeBudget({ max: 1, windowMs: 60_000, cache: 4 });
    budget.charge('victim', NOW);
    assert.equal(budget.refusalFor('victim', NOW), 60_000, 'the victim must be refused to begin with');
    // An attacker cycles addresses to push the victim out.
    for (let key = 0; key < 50; key += 1) budget.charge(`attacker-${key}`, NOW);
    // If this ever refuses, something now refuses by its absence, and filling a cache an anonymous
    // caller controls becomes a denial of service.
    assert.equal(
      budget.refusalFor('victim', NOW),
      null,
      'eviction produced a REFUSAL. An evicted entry must only ever loosen a budget, never ' +
        'tighten one, or filling this map becomes a way to lock other callers out',
    );
  });

  it('never lets a credit bank below zero, so completions cannot pay for a later flood', () => {
    const budget = new OutcomeBudget({ max: 2, windowMs: 60_000 });
    for (let credit = 0; credit < 50; credit += 1) budget.credit('addr', NOW);
    assert.equal(budget.chargedFor('addr', NOW), 0);
    budget.charge('addr', NOW);
    budget.charge('addr', NOW);
    assert.equal(budget.refusalFor('addr', NOW), 60_000, 'banked credit paid for a flood');
  });
});

describe('guest creation from one address', () => {
  it('is still refused past the shipped default, because every guest attempt succeeds', async () => {
    const { app, store } = await harness(testConfig(), cohortRelyingParty());
    const { token, cookie } = await csrfPair(app);
    let created = 0;
    let refused = 0;
    for (let attempt = 0; attempt < COHORT_SIZE * 2; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/guest',
        payload: {},
        cookies: { prl_csrf: cookie },
        headers: { 'x-csrf-token': token },
      });
      if (response.statusCode === 201) created += 1;
      if (response.statusCode === 429) refused += 1;
    }
    assert.equal(
      created,
      10,
      `guest creation let ${String(created)} accounts through from one address in one window. ` +
        'The shipped default is ten and it must stay ten: on this endpoint every attempt ' +
        'succeeds, so there is no failed outcome to charge and the successful creations ARE ' +
        'the abuse.',
    );
    assert.ok(refused > 0, 'unbounded guest creation from one address is not refused at all');
    assert.equal(store.users.size, created);
    await app.close();
  });
});

/**
 * The operator declares `COHORT_SIZE` because the process cannot discover how many learners share an
 * address. `checkCohortSizing` refuses to boot when the limits cannot serve it.
 */
function cohortEnv(overrides: EnvRecord, withOidc = true): EnvRecord {
  const oidc: EnvRecord = withOidc
    ? {
        OIDC_ISSUER: ISSUER,
        OIDC_CLIENT_ID: CLIENT_ID,
        OIDC_CLIENT_SECRET: 'a-client-secret-that-lives-only-in-a-header',
        OIDC_REDIRECT_URI: REDIRECT_URI,
      }
    : {};
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://poker:poker@db.internal:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    ...oidc,
    ...overrides,
  };
}

function bootProblems(env: EnvRecord): readonly string[] | null {
  try {
    loadConfig(env);
    return null;
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.problems;
  }
}

function assertNames(problems: readonly string[] | null, variable: string): void {
  assert.ok(problems !== null, `the process booted; it should have refused and named ${variable}`);
  assert.ok(
    problems.some((problem) => problem.includes(variable)),
    `no problem named ${variable}. Problems were:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  );
}

describe('a declared cohort that the configured limits cannot serve', () => {
  it('boots when the limits are sized for it — the positive control', () => {
    // Without this, every refusal below would pass against a check that refused everything.
    const problems = bootProblems(
      cohortEnv({ COHORT_SIZE: '30', COHORT_ENTRY: 'oidc', RATE_LIMIT_OIDC_MAX: '60' }),
    );
    assert.equal(
      problems,
      null,
      `a correctly sized cohort was refused:\n${(problems ?? []).map((p) => `  - ${p}`).join('\n')}`,
    );
  });

  it('refuses to start when the OIDC ceiling is below two requests per learner', () => {
    // 30 learners x 2 requests is 60, so one short must refuse.
    const problems = bootProblems(
      cohortEnv({ COHORT_SIZE: '30', COHORT_ENTRY: 'oidc', RATE_LIMIT_OIDC_MAX: '59' }),
    );
    assertNames(problems, 'RATE_LIMIT_OIDC_MAX');
    assert.ok(
      (problems ?? []).some((problem) => problem.includes('60')),
      'the refusal must state the arithmetic, not just that something is wrong',
    );
  });

  it('refuses to start when a guest cohort is larger than the guest budget', () => {
    const problems = bootProblems(cohortEnv({ COHORT_SIZE: '30', COHORT_ENTRY: 'guest' }));
    assertNames(problems, 'RATE_LIMIT_GUEST_MAX');
    // The refusal must say what raising the budget costs, or operators raise it reflexively.
    assert.ok(
      (problems ?? []).some((problem) => problem.includes('COHORT_ENTRY=oidc')),
      'the refusal must offer the alternative that does not loosen guest creation',
    );
  });

  it('checks both doors when the entry is not narrowed, because that is the safe default', () => {
    // No COHORT_ENTRY means `both`, so the guest budget is checked too.
    const problems = bootProblems(cohortEnv({ COHORT_SIZE: '30', RATE_LIMIT_OIDC_MAX: '60' }));
    assertNames(problems, 'RATE_LIMIT_GUEST_MAX');
  });

  it('refuses a cohort declared to use an identity provider that is not configured', () => {
    const env = cohortEnv(
      { COHORT_SIZE: '30', COHORT_ENTRY: 'oidc', RATE_LIMIT_OIDC_MAX: '60' },
      // No OIDC variables at all. A partial set is refused by `readOidc` for a different reason.
      false,
    );
    assertNames(bootProblems(env), 'COHORT_ENTRY');
  });

  it('refuses a failure budget raised to meet the ceiling, which throws the split away', () => {
    // Raising the failure budget to the ceiling turns two budgets back into one.
    const problems = bootProblems(
      cohortEnv({
        COHORT_SIZE: '30',
        COHORT_ENTRY: 'oidc',
        RATE_LIMIT_OIDC_MAX: '60',
        RATE_LIMIT_OIDC_FAILURE_MAX: '60',
      }),
    );
    assertNames(problems, 'RATE_LIMIT_OIDC_FAILURE_MAX');
  });

  it('refuses that same failure budget with NO cohort declared (REGRESSION)', () => {
    // `checkCohortSizing` returns early when COHORT_SIZE is 0, the shipped default, so this check lives
    // outside it. Equal to and above the ceiling are both tested.
    for (const failureMax of ['60', '10000']) {
      const problems = bootProblems(
        cohortEnv({ RATE_LIMIT_OIDC_MAX: '60', RATE_LIMIT_OIDC_FAILURE_MAX: failureMax }),
      );
      assertNames(problems, 'RATE_LIMIT_OIDC_FAILURE_MAX');
    }
  });

  it('checks nothing when no cohort is declared, so a public instance is unaffected', () => {
    // A public instance declares no cohort, and this check must not stop it booting.
    assert.equal(bootProblems(cohortEnv({})), null);
  });
});

/**
 * A cross-site page can send these GETs from a learner's browser, and an address-keyed budget cannot
 * tell attacker from victim: sixty `<img>` loads exhaust the address's unredeemed-start budget. The
 * routes refuse a subresource `sec-fetch-dest`. These drive the real routes through
 * `app.inject`, so an unwired guard fails.
 */
describe('the OIDC GET routes and Fetch Metadata', () => {
  const SUBRESOURCE_DESTS = ['image', 'script', 'style', 'iframe', 'empty', 'font'];
  // The callback carries a schema-valid query, because Fastify validates before `preHandler` and an
  // invalid query is refused before the guard runs. `state` need not name a real attempt.
  const ROUTES = ['/api/v1/auth/oidc/start', '/api/v1/auth/oidc/callback?state=probestate123&code=probecode'];

  it('refuses every subresource destination a cross-site page could use (REGRESSION)', async () => {
    const { app } = await harness(testConfig(), cohortRelyingParty());
    try {
      for (const url of ROUTES) {
        for (const dest of SUBRESOURCE_DESTS) {
          const response = await app.inject({ method: 'GET', url, headers: { 'sec-fetch-dest': dest } });
          assert.equal(
            response.statusCode,
            400,
            `${url} with sec-fetch-dest: ${dest} answered ${response.statusCode}`,
          );
        }
      }
    } finally {
      await app.close();
    }
  });

  it('treats a top-level navigation exactly as it treats a caller with no header', async () => {
    // Differential, because both routes answer 400 on their own merits without a query. A navigation
    // must match no header at all, and both must differ from a subresource load.
    const { app } = await harness(testConfig(), cohortRelyingParty());
    try {
      for (const url of ROUTES) {
        const navigation = await app.inject({
          method: 'GET',
          url,
          headers: { 'sec-fetch-dest': 'document' },
        });
        const absent = await app.inject({ method: 'GET', url });
        const subresource = await app.inject({
          method: 'GET',
          url,
          headers: { 'sec-fetch-dest': 'image' },
        });

        // `requestId` differs on every call.
        const shape = (payload: string): string => payload.replace(/"requestId":"[^"]*",?/u, '');

        assert.equal(
          shape(navigation.payload),
          shape(absent.payload),
          `${url}: a navigation was treated differently from a caller sending no header`,
        );
        assert.notEqual(
          shape(subresource.payload),
          shape(navigation.payload),
          `${url}: an image load was treated the same as a navigation — the guard is not wired`,
        );
      }
    } finally {
      await app.close();
    }
  });
});

/**
 * The charge runs in `onResponse`, which Fastify fires on the raw response's `finish` or `error`. A
 * client that destroys the socket fires neither, while the handler still makes the token exchange, so
 * an uncharged hang-up is an unbounded exchange. `app.inject` always finishes, so this needs a real
 * socket on 127.0.0.1.
 */
describe('a script that hangs up on its own callback', () => {
  /** A refusing provider that counts what it was made to do. */
  function countingRefusingRelyingParty(): { party: OidcRelyingParty; exchanges: () => number } {
    let exchanges = 0;
    return {
      exchanges: () => exchanges,
      party: {
        discovery: () => Promise.reject(new Error('the counting relying party does not fetch discovery')),
        authorizationUrl: (request) =>
          Promise.resolve(
            `${ISSUER}/authorize?state=${encodeURIComponent(request.state)}` +
              `&nonce=${encodeURIComponent(request.nonce)}`,
          ),
        exchangeCode: async () => {
          exchanges += 1;
          // Long enough that the socket is gone before this settles, which is the case under test.
          await new Promise((resolve) => setTimeout(resolve, 40));
          throw new Error('the provider refused this code');
        },
        verifyIdToken: () => Promise.reject(new Error('no token was ever obtained')),
      },
    };
  }

  /** Writes one GET and destroys the socket without ever reading the answer. */
  function sendAndHangUp(port: number, path: string, cookie: string | null): Promise<void> {
    return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        const cookieLine = cookie === null ? '' : `Cookie: ${cookie}\r\n`;
        socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${cookieLine}Connection: close\r\n\r\n`);
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 15);
      });
      socket.on('error', () => resolve());
    });
  }

  async function listening(
    config: AppConfig,
    relyingParty: OidcRelyingParty,
  ): Promise<{ app: FastifyInstance; port: number }> {
    const { app } = await harness(config, relyingParty);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    assert.ok(address !== null && typeof address !== 'string', 'the probe needs a bound port');
    return { app, port: address.port };
  }

  it('is still refused at the shipped fifteen forced exchanges (REGRESSION)', async () => {
    // Ceiling raised to 400 so only the failed-outcome budget can refuse.
    const config = testConfig({ RATE_LIMIT_OIDC_MAX: '400' });
    const counting = countingRefusingRelyingParty();
    const { app, port } = await listening(config, counting.party);
    try {
      const base = `http://127.0.0.1:${String(port)}`;
      for (let round = 0; round < config.rateLimit.oidcFailureMax * 3; round += 1) {
        const start = await fetch(`${base}/api/v1/auth/oidc/start`, { redirect: 'manual' });
        if (start.status !== 303) break;
        const state = new URL(String(start.headers.get('location'))).searchParams.get('state');
        const attemptCookie = start.headers
          .getSetCookie()
          .find((entry) => entry.startsWith('prl_oidc=') || entry.startsWith('__Host-prl_oidc='));
        assert.ok(state !== null && attemptCookie !== undefined, 'a 303 start carries a state and a cookie');
        await sendAndHangUp(
          port,
          `/api/v1/auth/oidc/callback?code=c-${String(round)}&state=${encodeURIComponent(state)}`,
          attemptCookie.split(';')[0] ?? null,
        );
      }
      // The aborted requests are still in flight. The charge lands when the socket closes.
      await new Promise((resolve) => setTimeout(resolve, 300));

      assert.equal(
        counting.exchanges(),
        config.rateLimit.oidcFailureMax,
        `a script that hangs up forced ${String(counting.exchanges())} token-endpoint exchanges ` +
          `from one address; the shipped configuration permits ${String(config.rateLimit.oidcFailureMax)}. ` +
          'An outcome the caller declines to wait for is still an outcome',
      );
    } finally {
      await app.close();
    }
  });

  // No separate positive control. The exact equality above is two-sided, and "still charges a start
  // that fails inside the handler" catches a fix that never charges.
});

/**
 * `@fastify/rate-limit` counts at `onRequest`, above the schema and `preHandler`, so a guard at
 * `preHandler` lets 60 cross-site `<img>` loads spend the address's ceiling. The guard runs at
 * `onRequest`, and the limiter's hook is appended after it.
 */
describe('a hostile page spending the victim address’s SIGN-IN CEILING', () => {
  const CROSS_SITE_SUBRESOURCE: Readonly<Record<string, string>> = {
    origin: 'https://evil.test',
    referer: 'https://evil.test/',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-dest': 'image',
  };

  it('cannot spend the start route’s ceiling with subresource loads (REGRESSION)', async () => {
    const config = testConfig();
    const { app } = await harness(config, cohortRelyingParty());
    try {
      const statuses: number[] = [];
      // A full ceiling. The earlier cross-site tests loop only 20 times, under 60.
      for (let attempt = 0; attempt < config.rateLimit.oidcMax; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/oidc/start',
          headers: CROSS_SITE_SUBRESOURCE,
        });
        statuses.push(response.statusCode);
      }
      assert.ok(
        statuses.every((status) => status === 400),
        `the subresource loads must all be refused, or this asserts nothing: ${statuses.join(',')}`,
      );
      const victim = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
      assert.equal(
        victim.statusCode,
        303,
        `${String(config.rateLimit.oidcMax)} cross-site image loads spent the victim address's ` +
          `sign-in ceiling: ${victim.payload}`,
      );
    } finally {
      await app.close();
    }
  });

  it('cannot spend the callback route’s ceiling either, above the schema (REGRESSION)', async () => {
    const config = testConfig();
    const { app } = await harness(config, cohortRelyingParty());
    try {
      // No query string, as an `<img>` sends. Only a guard at `onRequest` runs above the schema.
      for (let attempt = 0; attempt < config.rateLimit.oidcMax; attempt += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/api/v1/auth/oidc/callback',
          headers: CROSS_SITE_SUBRESOURCE,
        });
        assert.equal(response.statusCode, 400, response.payload);
      }
      // The callback is the half this attack denies.
      const outcome = await signIn(app);
      assert.equal(
        outcome.callbackStatus,
        303,
        `${String(config.rateLimit.oidcMax)} cross-site image loads of the callback denied a real ` +
          `learner the second half of their sign-in (start ${String(outcome.startStatus)}, ` +
          `callback ${String(outcome.callbackStatus)})`,
      );
      assert.ok(outcome.sessionIssued, 'the learner must end up with a session');
    } finally {
      await app.close();
    }
  });

  /**
   * Positive control. Asserted on the limiter's own headers and retry-after, not on the 61st request
   * being refused, because `oidcUnredeemedStarts` also refuses at `oidcMax`. The ceiling's wait is
   * 60 s and the unredeemed budget's is the 10-minute TTL.
   */
  it('still counts an ordinary caller against that ceiling — the positive control', async () => {
    const config = testConfig();
    const { app } = await harness(config, cohortRelyingParty());
    try {
      const first = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
      assert.equal(
        first.headers['x-ratelimit-limit'],
        String(config.rateLimit.oidcMax),
        'the route limiter did not run for an ordinary caller: the ceiling is gone',
      );
      assert.equal(
        first.headers['x-ratelimit-remaining'],
        String(config.rateLimit.oidcMax - 1),
        'the route limiter ran without counting',
      );

      const statuses: number[] = [first.statusCode];
      let last = first;
      for (let attempt = 1; attempt <= config.rateLimit.oidcMax; attempt += 1) {
        last = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
        statuses.push(last.statusCode);
      }
      assert.equal(
        statuses.filter((status) => status === 303).length,
        config.rateLimit.oidcMax,
        `the ceiling stopped counting ordinary callers: ${statuses.join(',')}`,
      );
      assert.equal(
        last.statusCode,
        429,
        `the caller past the ceiling must be refused: ${statuses.join(',')}`,
      );
      assert.equal(
        retryAfterSeconds(last.payload),
        config.rateLimit.oidcWindowMs / 1_000,
        'the refusal came from a budget other than the ceiling, so the ceiling is not what stopped ' +
          'this caller — see the note above this test',
      );
    } finally {
      await app.close();
    }
  });
});
