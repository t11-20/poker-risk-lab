/**
 * A classroom behind one address, signing in at the start of a session.
 *
 * ## The incident this file exists to prevent
 *
 * A paying cohort's first five minutes. Thirty students on one campus, office or VPN egress
 * address open the app together and sign in. Every one of those requests carries the SAME
 * rate-limit key, because `POST /auth/guest` and both OIDC endpoints are keyed on the hashed
 * client address rather than on the session cookie — deliberately, and correctly: a route that
 * ISSUES a session cannot be limited by that session, since the client presents a fresh cookie
 * on its next request and the counter never accumulates (measured; see the long note above
 * `clientKeyedRateLimit` in `plugins/security.ts`).
 *
 * The key was right. The SIZE and the SHAPE were not. This file was written BEFORE the fix and
 * failed against it, which is the only way its numbers mean anything. Measured, thirty learners,
 * one address, one window:
 *
 *                      before                                   after
 *     OIDC sign-in     15 of 30 completed, 15 refused,          30 of 30 completed, 0 refused
 *                      first refusal at learner 16
 *     guest creation   10 of 30 created,   20 refused,          unchanged, deliberately
 *                      first refusal at learner 11
 *
 * And the numbers that must NOT have moved, driving a script from the same address:
 *
 *     forced token-endpoint exchanges   15 per window before, 15 per window after
 *     guest accounts created            10 per window before, 10 per window after
 *
 * ## What this file asserts, and why each part is load-bearing
 *
 * Three properties, and none of them is meaningful without the other two:
 *
 *   1. **A cohort gets through.** `COHORT_SIZE` legitimate, completed sign-ins from one address
 *      inside one window, all 303, none refused. This is the property the fix exists for.
 *   2. **A script does not.** A caller that starts sign-ins and never completes them — which is
 *      what a script can do, because it cannot produce a valid authorization code from the
 *      identity provider — is still refused, and refused SOONER than a cohort is, because failed
 *      outcomes are charged to a budget a completed sign-in never touches. Without this, (1)
 *      would be satisfied by deleting the limiter.
 *   3. **Guest creation is still bounded.** Its limit is deliberately NOT cohort-sized by
 *      default, because on that endpoint every attempt succeeds and the successful creations ARE
 *      the abuse. See the reasoning in the guest-limit note in `routes/auth.ts`.
 *
 * A fourth section covers the boot refusal that keeps the sizing an operator decision rather than
 * a discovery, and a fifth covers the one way a two-budget design goes wrong on its own: a
 * refusal that charges itself, so a caller who retries is locked out for longer than the window
 * they were told to wait for.
 *
 * ## Negative controls
 *
 * Each assertion was broken on purpose while writing it:
 *
 *  * Property (1) failed against the pre-fix code with `15/30 completed`, recorded above. It is
 *    asserted as an exact count rather than as "no refusals" so that a future change which
 *    quietly re-shrinks the ceiling fails here rather than in front of a class.
 *  * Property (2) fails if the failed-outcome budget is removed, or if it is charged on a
 *    completed sign-in: the script then gets as far as the cohort ceiling. It is asserted as
 *    "refused strictly sooner than a cohort of the same size", which is the actual property —
 *    "refused eventually" would also pass against a limiter with no split at all.
 *  * Property (3) fails if `RATE_LIMIT_GUEST_MAX` is quietly raised along with the OIDC limits,
 *    which is the tempting and wrong fix.
 *  * The boot refusals fail if `checkCohortSizing` returns early, and the accompanying positive
 *    control (a correctly sized cohort BOOTS) fails if it refuses everything — without that, a
 *    check that rejected all configuration would pass every refusal assertion.
 *
 * No database and no network. Both dependencies of `createAuthRoutes` are ports; the store is
 * three `Map`s and the relying party is an in-process stub, exactly as in `test/auth.test.ts`.
 * Every request here is answered without reaching SQL, which is why this file passes under
 * `test:without-database` too.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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

/**
 * The class. Thirty is the number the shipped guest-limit comment used as its example of an
 * acceptable inconvenience, so it is the number this file holds it to.
 */
const COHORT_SIZE = 30;

const stubDatabase: DatabaseHandle = { ping: async () => ({ ok: true }), close: async () => undefined };

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    // Generous, so the GLOBAL bucket never answers. Every limit under test here is a route-level
    // one, and a global 429 would look identical while proving something else entirely.
    RATE_LIMIT_MAX: '100000',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    OIDC_CLIENT_SECRET: 'a-client-secret-that-lives-only-in-a-header',
    OIDC_REDIRECT_URI: REDIRECT_URI,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// The in-memory store
// ---------------------------------------------------------------------------

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

/**
 * A store that enforces the invariants the routes depend on, not a lenient one.
 *
 * The single-use attempt is the one that matters here: property (2) above is only meaningful if
 * a script genuinely cannot replay one attempt into many sign-ins, and a fake that let a state be
 * consumed twice would make that assertion vacuous.
 */
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

// ---------------------------------------------------------------------------
// The identity provider
// ---------------------------------------------------------------------------

/**
 * A relying party that succeeds for every student and fails for nobody.
 *
 * The protocol itself is not the subject of this file — `test/auth.test.ts` drives the real
 * relying party against a signing fake provider for that. What matters here is that each
 * student is a DIFFERENT person: `verifyIdToken` hands back a fresh subject each time, so
 * thirty completed sign-ins are thirty accounts and not one account signing in thirty times.
 * A stub with a fixed subject would let a broken `findOrCreateOidc` pass unnoticed.
 */
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
 * A relying party whose token exchange always fails.
 *
 * This is the script in property (2): it can reach the token endpoint — a start hands it a real
 * `state` and a real attempt cookie, so the state, cookie and PKCE checks all pass — and it
 * cannot get past the provider, because it has no authorization code any provider ever minted.
 * Every callback costs an outbound request and produces no session, which is precisely the
 * traffic the failed-outcome budget exists to bound.
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

/** One learner's whole sign-in: the start, then the callback carrying the attempt cookie back. */
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

/** The `retryAfterSeconds` the contract's `rate_limited` body carries. */
function retryAfterSeconds(payload: string): number {
  const parsed: { readonly error?: { readonly retryAfterSeconds?: unknown } } = JSON.parse(payload);
  const value = parsed.error?.retryAfterSeconds;
  assert.equal(typeof value, 'number', `a rate_limited body must say how long to wait: ${payload}`);
  return Number(value);
}

/** How many of `attempts` sign-ins completed, and how many were refused with a 429. */
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

// ---------------------------------------------------------------------------
// Property 1 — a cohort gets through
// ---------------------------------------------------------------------------

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
    // Thirty accounts, not one account thirty times: proves the harness drove distinct people and
    // that the limiter was not merely bypassed by everybody reusing one identity.
    assert.equal(store.users.size, COHORT_SIZE);
    await app.close();
  });

  it('does not need a cookie or a session to do it, so the bucket key cannot rotate', async () => {
    // The property the pre-existing measurement proved and that the fix must not lose: these
    // routes are keyed on the address precisely because they issue sessions. Every request the
    // cohort above made carried no session cookie at all, so if the key were session-preferring
    // each learner would have landed in a bucket of their own and the cohort assertion would pass
    // for the wrong reason. Asserted directly: a script gets refused from the same address.
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

// ---------------------------------------------------------------------------
// Property 2 — a script does not
// ---------------------------------------------------------------------------

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
    // "Refused eventually" would also pass against a limiter with no split in it at all. The
    // property is that a script meets its ceiling STRICTLY SOONER than a whole cohort meets
    // theirs, which is the only thing that makes the cohort allowance safe to grant.
    assert.ok(
      refusedAt !== null && refusedAt < COHORT_SIZE,
      `a script got ${String(attempts)} failed sign-in attempts from one address without being ` +
        'refused. Failed outcomes must be charged to a tighter budget than completed ones, or ' +
        'the cohort allowance is simply handed to the script.',
    );
    await app.close();
  });

  it('still forces no more outbound token exchanges than the shipped limit permitted', async () => {
    /*
     * The security non-regression, as a number.
     *
     * An outbound request to the identity provider is the one thing in this flow that costs
     * money and standing with the provider, and it only happens on a callback that gets past the
     * state, cookie and PKCE checks and then fails at the token endpoint — a FAILED outcome. The
     * shipped configuration permitted fifteen of those per address per window (measured against
     * the pre-fix code with exactly this loop). Raising the ceiling to cohort size must not have
     * raised this, and `RATE_LIMIT_OIDC_FAILURE_MAX` defaults to 15 precisely so that it does not.
     *
     * Asserted as an exact equality rather than an upper bound: a change that made this SMALLER
     * would break a legitimate learner who cancels at the consent screen twice, and a change that
     * made it larger is the regression. Both directions matter, so both are pinned.
     */
    const config = testConfig();
    const { app } = await harness(config, refusingRelyingParty());
    let forcedExchanges = 0;
    // Far more attempts than any budget here permits, so the count is the budget's and not the
    // loop's. 200 requests against a 15-per-window budget leaves no doubt which one stopped it.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const outcome = await signIn(app);
      if (outcome.startStatus === 429 || outcome.callbackStatus === 429) continue;
      // Reached the handler, consumed a real attempt row, and failed at the provider. That is one
      // outbound request the script made this server pay for.
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
    /*
     * The failure mode a two-budget design invents if nobody looks for it.
     *
     * If a 429 were itself charged to the failure budget, every retry would push the caller's own
     * window forward and they would never be readmitted — `@fastify/rate-limit` calls that
     * `continueExceeding`, this application enables it nowhere, and re-inventing it by accident
     * here would turn one cancelled consent screen into an unbounded lockout for everybody behind
     * a campus address.
     *
     * Asserted through the budget's own bookkeeping rather than by waiting out a real window: the
     * retry-after the caller is told is compared before and after a burst of refusals, and it must
     * only ever count DOWN.
     */
    const config = testConfig();
    const { app } = await harness(config, refusingRelyingParty());
    // Enough failed sign-ins to exhaust the failure budget with room to spare, and few enough
    // that the cohort ceiling — which is four times larger — is demonstrably not what refuses.
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

// ---------------------------------------------------------------------------
// Property 2a — the budget cannot be spent BY SOMEBODY ELSE
// ---------------------------------------------------------------------------

/**
 * Whose budget is it? It is keyed on the client ADDRESS, and that is a third party's opportunity.
 *
 * `GET /auth/oidc/callback` is a GET, so a page on any other site can make a visitor's browser
 * issue it as a plain subresource load — an `<img>`, a `no-cors` `fetch`, a `<script>` tag. CORS
 * does not stop the request being SENT, only the response being read; a GET carries no CSRF token;
 * and no session is needed. So every one of those lands in the victim's address bucket.
 *
 * Measured against the code this test was written for, with `<img>`-shaped headers:
 *
 *     20 cross-site GETs to /auth/oidc/callback     -> 400 x15, then 429 x5
 *     a real learner's /auth/oidc/start, same address -> 429, retryAfterSeconds 60
 *
 * Fifteen image tags on any page one student on a campus network visits locked the whole cohort
 * out of signing in — which is the failure this entire file exists to prevent, handed to a third
 * party for free. `routes/auth.ts` now charges a callback failure only once `acceptAttempt` has
 * succeeded, which is the point at which the caller has presented the `__Host-`, `HttpOnly`,
 * signed attempt cookie this server set on their browser. No other site can produce one.
 *
 * The control is the test above it: a script that starts a REAL flow and then fails at the token
 * endpoint still spends the budget, and still meets `oidcFailureMax` exactly.
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
    // Comfortably past the budget: if any of these charged, the last few would be 429.
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

    // The learner the attack was aimed at. This is the assertion that matters.
    const victim = await app.inject({ method: 'GET', url: '/api/v1/auth/oidc/start' });
    assert.equal(
      victim.statusCode,
      303,
      `a learner behind the same address was refused a sign-in by somebody else's traffic: ${victim.payload}`,
    );
    await app.close();
  });

  /**
   * The same hazard on the OTHER route, which the first fix left open.
   *
   * `provenAttempts` gated the CALLBACK. `/auth/oidc/start` kept an unconditional
   * `chargeFailedOutcome`, and a start is refused with a 400 in two ways a third party reaches for
   * nothing. Measured against the code that shipped the callback fix, on this harness:
   *
   *     20 cross-site <img>-shaped GETs to /auth/oidc/start
   *       -> 400 x20 (`refuseNonNavigationOidc`), every one charged to the victim's address
   *       -> the victim's own /auth/oidc/start    429, retryAfterSeconds 60
   *       -> the victim's own /auth/oidc/callback 429, retryAfterSeconds 60
   *
   * Note what the attacker sees: twenty 400s and never a 429. They are refused by the
   * Fetch-Metadata guard on every request while the victim pays for all of them, so the attack is
   * quieter than the callback one it replaced and costs fifteen requests rather than sixty.
   */
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
   * The door `refuseNonNavigationOidc` cannot close, and the reason this is not a duplicate.
   *
   * Fastify validates the query string BEFORE `preHandler`, so a start whose `redirectAfter` is
   * not a site-relative path is refused by the SCHEMA and no guard of ours ever runs. Measured
   * against the code that shipped the Fetch-Metadata guard:
   *
   *     17 cross-site GETs to /auth/oidc/start?redirectAfter=https%3A%2F%2Fevil.test%2Fx
   *       -> 400 x17 from the schema, every one charged
   *       -> the victim's own /auth/oidc/start   429
   *
   * No `sec-fetch-dest` is needed and none is sent here on purpose: the point is that a layer
   * ABOVE the guard produced the refusal, so a fix that lives in a `preHandler` cannot be what
   * closes it. Only refusing to charge for anything that never reached the handler does.
   */
  /**
   * The positive control on the two above, and the thing that stops them being satisfied by
   * deleting the charge.
   *
   * A start that fails INSIDE the handler — the provider unreachable, discovery refusing — has
   * spent an outbound request and is exactly what the failed-outcome budget was sized for. It must
   * still be charged, or "do not charge for what never reached the handler" becomes "do not charge
   * for anything" and a script driving start-after-start against a broken provider is bounded only
   * by the ceiling.
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
    // The control on the control: if these stopped being 400s the assertion below would pass for
    // the wrong reason — a query the schema accepts is not the case under test.
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

// ---------------------------------------------------------------------------
// Property 2b — the script that never comes back
// ---------------------------------------------------------------------------

/**
 * The cheapest attack on this design, and the one the failed-outcome budget cannot see.
 *
 * A caller that only ever hits `/auth/oidc/start` and never calls back writes an attempt row
 * every time and produces no failed outcome, because a start that SUCCEEDS is not a failure.
 * Raising the ceiling from 15 to 60 therefore quadrupled what that caller could write, and
 * measurement said nothing else was holding it:
 *
 *   * The global limiter contributes nothing. `@fastify/rate-limit` lets a route's own
 *     `config.rateLimit` replace the global bucket rather than stack with it — measured, and
 *     asserted below, because a comment claiming a bound exists is exactly the error this
 *     section was added to correct.
 *   * Rows are not removed at their TTL. `maintenance/retention-sweep.ts` removes them every six
 *     hours, at most 1,000 x 100 = 100,000 per table per sweep, so residency is `rate x 360
 *     minutes`. At 60/min that is 21,600 rows per address per sweep and FIVE addresses outrun the
 *     sweep, against nineteen before the change.
 *
 * So `oidcUnredeemedStarts` bounds unredeemed starts over the attempt row's own 10-minute TTL
 * instead, which brings it to 2,160 per address per sweep and 46 addresses — tighter than the
 * code this change started from.
 *
 * The load-bearing test here is the multi-window one. A single 60-second window cannot tell the
 * ceiling and this budget apart, because both refuse at 60; the difference is that the ceiling
 * hands back 60 more every minute and this budget does not until the TTL rolls.
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
    // Exactly the ceiling, from a caller that never produced a single failed outcome. This is the
    // measurement, not an aspiration: it is what makes the multi-window test below necessary.
    assert.equal(written, config.rateLimit.oidcMax);
    assert.equal(store.attempts.size, written, 'every allowed start must have written its row');
    await app.close();
  });

  it('costs the flooder nothing from the global bucket, so that is not the bound either', async () => {
    // Asserted rather than assumed. The first version of this design's comment claimed "the global
    // limiter (300 per minute) still sits above it", and it does not: a route-level `rateLimit`
    // config REPLACES the global one for that route. A reader who believes otherwise will size
    // the ceiling as though a second bound existed.
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
    /*
     * The control that pins the fix.
     *
     * `RATE_LIMIT_OIDC_WINDOW_MS` is set to its 1-second floor so the CEILING's window rolls
     * several times inside this test, while the unredeemed-start budget's window — the attempt
     * row's own 10-minute TTL — does not roll at all. Against the ceiling alone the flooder
     * collects a fresh allowance every window; against this budget it collects one per TTL.
     *
     * Without `oidcUnredeemedStarts` this writes `ceiling x rounds` rows. With it, `ceiling`.
     */
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
      // Past the ceiling's window, so the next round starts with a fresh ceiling allowance and
      // the only thing still refusing is the unredeemed-start budget.
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
    /*
     * The positive control, and the one that stops the fix above from being a cohort regression.
     *
     * A learner who completes a sign-in has redeemed the attempt row their start wrote, so it
     * must not count against the address as an abandoned one. Driven with MORE learners than the
     * unredeemed budget allows outstanding (`ceiling` is both), across several ceiling windows:
     * without the credit, learner `ceiling + 1` is refused at the start and never signs in.
     */
    const ceiling = 4;
    const learners = 10;
    const config = testConfig({
      RATE_LIMIT_OIDC_MAX: String(ceiling),
      RATE_LIMIT_OIDC_WINDOW_MS: '1000',
      // Stated rather than left to the default of 15, exactly as the test above states it. A
      // ceiling of 4 with a failure budget of 15 is a configuration `checkSignInBudgets` now
      // refuses on every boot rather than only on a boot that declared a cohort — the failure
      // budget could never refuse anything the ceiling had not refused already.
      RATE_LIMIT_OIDC_FAILURE_MAX: String(ceiling - 1),
    });
    const { app, store } = await harness(config, cohortRelyingParty());

    let completed = 0;
    for (let learner = 0; learner < learners; learner += 1) {
      // Paced so the CEILING is never what refuses — each route allows `ceiling` requests per
      // window and a sign-in costs one of each. The subject here is the unredeemed-start budget,
      // whose window does not roll during this test at all.
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

// ---------------------------------------------------------------------------
// The eviction bound inside the budgets themselves
// ---------------------------------------------------------------------------

/**
 * An LRU inside a security control invites one question: what does an attacker gain by filling it?
 *
 * The answer here is "nothing", and it rests on an asymmetry that is worth pinning rather than
 * asserting in a comment: **an entry's only effect is to refuse, so evicting one can only ever
 * permit.** There is no state in these budgets whose loss causes a refusal, which is what makes
 * "an attacker cycling addresses flushes the map" uninteresting — they flush their own counters,
 * and an attacker holding 5,000 addresses already had 5,000 independent budgets.
 *
 * Both directions are driven, because only having one would leave the interesting half untested.
 *
 * ## Why every call below names its own `now`
 *
 * `refusalFor` returns `windowMs - (now - iterationStartMs)`, so an assertion on the exact figure
 * is an assertion that the wall clock did not tick between the charge and the read. It does tick:
 * measured on this machine, `evicts the least recently used key…` — a hundred charges and then a
 * read — failed with `59999 !== 60000` on 1 run in 7, and the whole `test` gate (and therefore
 * `pnpm run verify`) failed with it. The mechanism, made deterministic:
 *
 *     charge('addr-99', t); refusalFor('addr-99', t)     -> 60000
 *     charge('addr-99', t); refusalFor('addr-99', t + 1) -> 59999
 *
 * `OutcomeBudget` already takes `now` on every method for exactly this reason, so the fix is to
 * use it rather than to loosen the assertion to a range: the figure IS the `Retry-After` a caller
 * is handed, and "about a minute" is not what this test is pinning.
 */
describe('the outcome budgets bound their own memory', () => {
  /** A fixed instant. Any value; what matters is that every call in a test shares one. */
  const NOW = 1_700_000_000_000;

  it('evicts the least recently used key at capacity and never grows past it', () => {
    const budget = new OutcomeBudget({ max: 1, windowMs: 60_000, cache: 4 });
    for (let key = 0; key < 100; key += 1) budget.charge(`addr-${key}`, NOW);
    assert.equal(budget.size(), 4, 'the map grew past its cache bound');
    // The most recent four survive; everything older is gone.
    assert.equal(budget.refusalFor('addr-99', NOW), 60_000);
    assert.equal(budget.refusalFor('addr-0', NOW), null, 'the oldest key should have been evicted');
  });

  it('eviction can only ever PERMIT, which is why flushing it is not an attack', () => {
    const budget = new OutcomeBudget({ max: 1, windowMs: 60_000, cache: 4 });
    budget.charge('victim', NOW);
    assert.equal(budget.refusalFor('victim', NOW), 60_000, 'the victim must be refused to begin with');
    // An attacker cycles addresses to push the victim out.
    for (let key = 0; key < 50; key += 1) budget.charge(`attacker-${key}`, NOW);
    // The victim is now PERMITTED, not refused. That is the only thing eviction can do, and it is
    // why a flushed map cannot be used to deny anybody service. If this ever asserts a refusal,
    // something has been added whose ABSENCE refuses — and that thing is a denial-of-service
    // channel keyed on a cache an anonymous caller controls.
    assert.equal(
      budget.refusalFor('victim', NOW),
      null,
      'eviction produced a REFUSAL. An evicted entry must only ever loosen a budget, never ' +
        'tighten one, or filling this map becomes a way to lock other callers out',
    );
  });

  it('never lets a credit bank below zero, so completions cannot pay for a later flood', () => {
    // A caller who completes many sign-ins must not accumulate negative charge and then spend it
    // on a burst of abandoned starts.
    const budget = new OutcomeBudget({ max: 2, windowMs: 60_000 });
    for (let credit = 0; credit < 50; credit += 1) budget.credit('addr', NOW);
    assert.equal(budget.chargedFor('addr', NOW), 0);
    budget.charge('addr', NOW);
    budget.charge('addr', NOW);
    assert.equal(budget.refusalFor('addr', NOW), 60_000, 'banked credit paid for a flood');
  });
});

// ---------------------------------------------------------------------------
// Property 3 — guest creation stays bounded
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The sizing is an operator decision the process refuses to boot without
// ---------------------------------------------------------------------------

/**
 * `COHORT_SIZE` and the boot refusal it arms.
 *
 * The shape of the fix above only helps a deployment whose numbers are right, and the numbers
 * depend on a fact this process cannot discover: how many learners share one egress address. So
 * the operator declares it, and `checkCohortSizing` refuses to start when the configured limits
 * cannot serve the declaration — the same mechanism, and the same argument, as the refusal on
 * `RATE_LIMIT_RESET_TOKEN`. A warning would be written into the boot log days before the class
 * and read by nobody.
 *
 * The positive control is the important one here. Without "a correctly sized cohort boots", every
 * refusal below would also pass against a check that rejected all configuration outright.
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

/** The problems a refused boot reported, or `null` when it booted. */
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
    // 59 rather than 15, so this is a test of the ARITHMETIC and not merely of "the old default
    // is too small". 30 learners x 2 requests is 60; one short must still refuse.
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
    // The refusal has to say what raising it COSTS, or an operator raises it reflexively to make
    // the message go away and this check has done harm rather than good.
    assert.ok(
      (problems ?? []).some((problem) => problem.includes('COHORT_ENTRY=oidc')),
      'the refusal must offer the alternative that does not loosen guest creation',
    );
  });

  it('checks both doors when the entry is not narrowed, because that is the safe default', () => {
    // No COHORT_ENTRY at all: the default is `both`, so the guest budget is checked even for a
    // deployment whose operator was only thinking about the identity provider.
    const problems = bootProblems(cohortEnv({ COHORT_SIZE: '30', RATE_LIMIT_OIDC_MAX: '60' }));
    assertNames(problems, 'RATE_LIMIT_GUEST_MAX');
  });

  it('refuses a cohort declared to use an identity provider that is not configured', () => {
    const env = cohortEnv(
      { COHORT_SIZE: '30', COHORT_ENTRY: 'oidc', RATE_LIMIT_OIDC_MAX: '60' },
      // No OIDC variables at all. Not three of four — that is already refused by `readOidc` as a
      // partial configuration, and this test would then pass for the wrong reason.
      false,
    );
    assertNames(bootProblems(env), 'COHORT_ENTRY');
  });

  it('refuses a failure budget raised to meet the ceiling, which throws the split away', () => {
    // The wrong fix, arriving later and by a different route: an operator who hits the failure
    // budget during a load test and "fixes" it by raising it to the ceiling has turned two
    // budgets back into one. Refused at boot, naming both variables.
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
    // Found by an adversarial review. The check above lived inside `checkCohortSizing`, which
    // returns immediately when COHORT_SIZE is 0 — the shipped default, and the state `.env.example`
    // calls the right one for a public instance. So the one deployment shape the failure budget was
    // written to protect was the one shape that never checked it. Measured against the code as it
    // stood: RATE_LIMIT_OIDC_FAILURE_MAX=10000 against a ceiling of 60 booted cleanly, while
    // `.env.example` said "the process refuses to boot if this is not below RATE_LIMIT_OIDC_MAX".
    //
    // Both spellings of the violation, because `>=` and `>` are one character apart: equal to the
    // ceiling makes the budget unreachable, above it makes it absurd, and neither can ever refuse
    // anything the ceiling has not refused already.
    for (const failureMax of ['60', '10000']) {
      const problems = bootProblems(
        cohortEnv({ RATE_LIMIT_OIDC_MAX: '60', RATE_LIMIT_OIDC_FAILURE_MAX: failureMax }),
      );
      assertNames(problems, 'RATE_LIMIT_OIDC_FAILURE_MAX');
    }
  });

  it('checks nothing when no cohort is declared, so a public instance is unaffected', () => {
    // The shipped defaults must remain a valid configuration for the deployment they were
    // written for. A check that made every existing production process refuse to boot would be a
    // worse incident than the one it prevents.
    assert.equal(bootProblems(cohortEnv({})), null);
  });
});

/**
 * The two OIDC GET routes refuse a browser-declared subresource load.
 *
 * ## The incident
 *
 * An adversarial review measured this: CORS does not stop a cross-site *request*, only the reading
 * of its response, so sixty `<img>` tags on any page one student on a campus network opens
 * exhausted that whole address's unredeemed-start budget — and the next real learner to press sign
 * in got a 429. A third party denying sign-in to an entire cohort for ten minutes, from a page
 * nobody on the cohort's side controls.
 *
 * The budgets are address-keyed and must be (a route that ISSUES a session cannot be keyed by that
 * session — measured, at the top of `routes/auth.ts`), so the budget itself cannot tell the
 * attacker from the victim. What can is that a browser states what it is loading a URL *for*.
 *
 * ## Would this fail if the guard were unwired?
 *
 * These drive the real routes through `app.inject`, not a copy of the predicate. The first draft
 * of this file asserted against a re-implementation living beside it, which would have passed
 * against a route with no `preHandler` at all — the check would have been testing itself.
 */
describe('the OIDC GET routes and Fetch Metadata', () => {
  const SUBRESOURCE_DESTS = ['image', 'script', 'style', 'iframe', 'empty', 'font'];
  // The callback carries a schema-valid query on purpose. Fastify validates BEFORE `preHandler`,
  // so a callback with no query string is rejected by the schema and the guard never runs — the
  // first draft of these tests was green for that reason, on a route the guard was not protecting.
  // `state` is required and must be 8..256 characters; it need not name a real attempt, because
  // what is under test is which layer answers, not what the handler decides.
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
    // Differential, deliberately. Both routes answer 400 on their own merits for a request with no
    // query string, so asserting a status here would pass against a guard that was never wired.
    // What the guard changes is that a SUBRESOURCE is refused where a navigation is not — so the
    // assertion is that `document` and "no header at all" are indistinguishable, and that both
    // differ from the subresource case measured above.
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

        // `requestId` is server-generated per request, so it differs on every call and is not
        // part of what is being compared.
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
