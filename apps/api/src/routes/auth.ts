/**
 * The authentication routes: guest sessions, the session read, sign-out, OIDC, unit reset.
 *
 * Six endpoints, and the interesting thing about them is how differently they treat "not signed
 * in":
 *
 * - `GET /auth/session` never fails for it. A reader who has never signed in is the *normal* case
 *   in a teaching app, and answering 401 there would make the web app's very first request an
 *   error it has to special-case.
 * - `POST /auth/guest` fixes it in one request, with no email, no password and no verification
 *   step. A guest is a first-class account (see the comment on `prl.users`), not a lesser one.
 * - `POST /auth/logout` is idempotent, so a client that has lost track of its own state can
 *   always reach a known one.
 * - `POST /me/units/reset` needs a session and is otherwise unconditional: always available,
 *   never penalised, no cooldown, no confirmation gate. That is a product guardrail
 *   (`docs/PRODUCT-GUARDRAILS.md` §1), not a nicety — a reset that is grudging is how a
 *   play-money app starts behaving like a paid one.
 *
 * ## Where the SQL is
 *
 * Not here. Not one statement. `createAuthStore(sql)` at the bottom binds the `sql` handle into
 * the repository functions from `src/repositories/{sessions,users}.ts`, which is the only place a
 * query lives.
 *
 * `createAuthRoutes({ store, relyingParty })` takes any implementation of the two ports, which is
 * why `test/auth.test.ts` exercises this whole surface against a `Map` and a fake identity
 * provider, with no database and no network.
 *
 * ## Units are derived, not stored
 *
 * There is no `users.units` column and there must not be one — `docs/PRODUCT-GUARDRAILS.md` says
 * there is "no schema column that could represent" a transfer of value, and a stored balance is
 * the first half of one. `repositories/users.ts` derives units from the learner's live seats and
 * documents the model at length; these routes just ask it.
 */

import { randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { ResetUnitsResponse, SessionResponse, SessionUser } from '@prl/contracts';
import { PROTOCOL_VERSION } from '@prl/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { OidcRelyingParty } from '../auth/oidc.ts';
import {
  createAttemptSecrets,
  createOidcRelyingParty,
  isSafeRedirectPath,
  OIDC_ATTEMPT_TTL_MS,
  packAttemptCookie,
  safeRedirectTarget,
  stateMismatch,
  unpackAttemptCookie,
} from '../auth/oidc.ts';
import type { SessionAccount, SessionStore } from '../auth/session.ts';
import {
  destroySession,
  issueSession,
  requireSession,
  SESSION_ABSOLUTE_TTL_SECONDS,
  sessionPlugin,
} from '../auth/session.ts';
import type { AppConfig } from '../config.ts';
import type { Sql } from '../db.ts';
import { getSql } from '../db.ts';
import { AppError } from '../errors.ts';
import { clientKeyedRateLimit, sessionCookieOptions } from '../plugins/security.ts';
import { hashOidcSecret, timingSafeEquals } from '../repositories/hashing.ts';
import * as sessionsRepository from '../repositories/sessions.ts';
import { SESSION_TTL_SECONDS } from '../repositories/sessions.ts';
import * as usersRepository from '../repositories/users.ts';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Guest creation, rate limited hard.
 *
 * This is the one unauthenticated endpoint that writes a row, so it is the one a script would
 * point at to fill the users table. Ten a minute per caller is far more than a person needs and
 * far less than a loop wants.
 *
 * The bucket is deliberately NOT the default one from `plugins/security.ts`. That key prefers the
 * session cookie, which is correct for ordinary routes and broken here: this endpoint ISSUES a
 * session, so a client that keeps the cookie it was just handed presents a different key on its
 * next request and the counter never accumulates. Measured against the running server: 60
 * consecutive guest creations produced zero 429s, while freezing the cookie produced a 429 after
 * six — which is what proved key rotation was the cause rather than a missing config.
 *
 * `clientKeyedRateLimit` ignores the cookie and keys on the hashed address instead. The NAT
 * trade-off is accepted knowingly: a classroom of thirty sharing an account-creation budget will
 * occasionally be told to wait, which is much better than unbounded account creation.
 */
const GUEST_RATE_LIMIT_MAX = 10;
const GUEST_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Sign-in starts and callbacks, also tight: each start writes an attempt row, and each callback
 * can cost two outbound requests to the identity provider. Address-keyed for the same reason as
 * guest creation — the callback completes by issuing a session.
 */
const OIDC_RATE_LIMIT_MAX = 15;
const OIDC_RATE_LIMIT_WINDOW_MS = 60_000;

/** Display-name shape, mirroring `DISPLAY_NAME_SCHEMA` in `@prl/contracts`. */
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '._-]{0,22}[A-Za-z0-9]$/;
const DISPLAY_NAME_DISALLOWED = /[^A-Za-z0-9 '._-]/g;
const DISPLAY_NAME_MAX = 24;

/** The attempt cookie's name, following the same `__Host-` rule as the session cookie. */
const OIDC_COOKIE_BASE = 'prl_oidc';

/** Longest provider `error` code echoed into a log line, after being stripped to a safe alphabet. */
const MAX_LOGGED_PROVIDER_ERROR = 64;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** The `prl.users` operations these routes need, with `sql` already bound. */
export interface UserStore {
  /** `undefined` means "generate one"; the repository owns that fallback. */
  readonly createGuest: (displayName: string | undefined) => Promise<SessionAccount>;
  /** Finds or creates the account for `(issuer, subject)`. Never a duplicate, never a rename. */
  readonly findOrCreateOidc: (
    issuer: string,
    subject: string,
    displayName: string,
  ) => Promise<SessionAccount>;
  readonly readUnits: (userId: string) => Promise<number>;
  readonly resetUnits: (userId: string) => Promise<number>;
}

/** The `prl.oidc_login_attempts` operations, with `sql` already bound. */
export interface OidcAttemptStore {
  readonly create: (input: {
    readonly state: string;
    readonly nonce: string;
    readonly pkceVerifier: string;
    readonly redirectAfter: string | null;
  }) => Promise<void>;
  /**
   * Consumes an attempt by its plaintext `state`, exactly once. `null` for unknown, expired and
   * already-used alike — see the long note on `consumeLoginAttempt`.
   */
  readonly consume: (state: string) => Promise<{
    readonly nonceHash: Buffer;
    readonly pkceVerifierHash: Buffer;
    readonly redirectAfter: string | null;
  } | null>;
}

/** Everything these routes persist, in three ports mirroring the repository modules. */
export interface AuthStore {
  readonly sessions: SessionStore;
  readonly users: UserStore;
  readonly oidcAttempts: OidcAttemptStore;
}

export interface AuthRoutesOptions {
  /** Defaults to the repository-backed store over the process-wide pool. */
  readonly store?: AuthStore;
  /** Defaults to a relying party built from `config.oidc`. Injected by the tests. */
  readonly relyingParty?: OidcRelyingParty;
}

// ---------------------------------------------------------------------------
// Display names
// ---------------------------------------------------------------------------

/**
 * A display name that cannot be rejected by the database, whatever arrived.
 *
 * Ajv has already checked a *submitted* name against the contract's pattern, so why again? Because
 * this also handles the two inputs Ajv never sees: an absent name, and the `name` claim from an
 * identity provider — text a learner typed into somebody else's form. The characters removed here
 * are the ones that make a name a weapon rather than a label: control characters, bidi overrides
 * and zero-width joiners, all of which let one player render as another.
 *
 * Returns `undefined` when nothing usable survives, rather than inventing a name, so the caller
 * decides the fallback. That matters because `repositories/users.ts` *throws* `invalid_request` on
 * a name it cannot store — right for a form submission, wrong halfway through an OIDC callback,
 * where the learner did nothing wrong and the honest answer is to pick a name for them.
 */
export function sanitiseDisplayName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const collapsed = raw.replace(DISPLAY_NAME_DISALLOWED, ' ').replace(/\s+/g, ' ').trim();
  const clipped = collapsed.slice(0, DISPLAY_NAME_MAX).trim();
  return DISPLAY_NAME_PATTERN.test(clipped) ? clipped : undefined;
}

/**
 * A name for a federated account whose provider gave us nothing usable.
 *
 * Not `defaultGuestDisplayName()` from the repository, even though it is right there: labelling a
 * signed-in learner "Guest" in a room list is wrong, and the six hex characters are the part worth
 * borrowing rather than the word.
 */
function federatedDisplayName(): string {
  return `Player ${randomHex()}`;
}

function randomHex(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

// ---------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------

async function sessionUserFor(account: SessionAccount, users: UserStore): Promise<SessionUser> {
  return {
    id: account.id,
    kind: account.kind,
    displayName: account.displayName,
    units: await users.readUnits(account.id),
    createdAt: account.createdAt,
  };
}

/**
 * The `SessionResponse` body.
 *
 * The CSRF token is minted for everybody, signed in or not, and that is not an oversight: the
 * first mutating request a new visitor makes is `POST /auth/guest`, which needs a token, so a
 * token issued only to authenticated callers would be unreachable. `generateCsrf` rotates the
 * paired secret cookie, which is exactly what should happen when the session changes.
 */
async function sessionResponse(
  reply: FastifyReply,
  account: SessionAccount | null,
  users: UserStore,
  config: AppConfig,
): Promise<SessionResponse> {
  return {
    user: account === null ? null : await sessionUserFor(account, users),
    csrfToken: reply.generateCsrf(),
    protocolVersion: PROTOCOL_VERSION,
    oidcEnabled: config.oidcEnabled,
  };
}

// ---------------------------------------------------------------------------
// OIDC helpers
// ---------------------------------------------------------------------------

function oidcCookieName(config: AppConfig): string {
  return config.isProduction ? `__Host-${OIDC_COOKIE_BASE}` : OIDC_COOKIE_BASE;
}

/**
 * The attempt cookie's attributes.
 *
 * Reuses `sessionCookieOptions` wholesale — `httpOnly`, `secure`, `sameSite: 'lax'`, `path`,
 * `signed` — and adds only a lifetime. `lax` rather than `strict` is load-bearing here, and is the
 * reason that value was chosen in `plugins/security.ts`: the provider finishes the flow with a
 * cross-site top-level navigation to the callback, a `Strict` cookie is not sent on one, and this
 * cookie carries the PKCE verifier. With `Strict`, every sign-in on earth would fail as
 * `oidc_state_mismatch`.
 */
function oidcCookieOptions(config: AppConfig): CookieSerializeOptions {
  return { ...sessionCookieOptions(config), maxAge: Math.floor(OIDC_ATTEMPT_TTL_MS / 1_000) };
}

/** The relying party, or a truthful 501. */
function requireRelyingParty(party: OidcRelyingParty | null): OidcRelyingParty {
  if (party === null) {
    throw new AppError('oidc_not_configured', { logDetail: 'OIDC is not configured on this server' });
  }
  return party;
}

/**
 * Route generics.
 *
 * Fastify types `request.body` and `request.query` as `unknown` until a route says otherwise,
 * which is the right default: a handler should not be able to read a field no schema validated.
 * These interfaces mirror the schemas they sit beside — the schema is what enforces them at
 * runtime, these only make the handlers readable.
 */
interface GuestBody {
  readonly displayName?: string;
}

interface StartQuery {
  readonly redirectAfter?: string;
}

interface CallbackQuery {
  readonly code?: string;
  readonly state: string;
  readonly error?: string;
}

interface AcceptedAttempt {
  readonly nonceHash: Buffer;
  readonly codeVerifier: string;
  readonly redirectAfter: string | null;
}

/**
 * Everything the callback checks before it spends the authorization code.
 *
 * Split out from the route so the *order* is readable in one screen, because the order is the
 * security property: the cookie is checked before the database is touched, the attempt is consumed
 * before the code is spent, and the PKCE verifier is checked before anything is sent to the
 * provider.
 */
async function acceptAttempt(
  request: FastifyRequest,
  query: CallbackQuery,
  store: AuthStore,
): Promise<AcceptedAttempt> {
  const config = request.server.appConfig;
  const raw = request.cookies[oidcCookieName(config)];
  if (raw === undefined || raw === '') throw stateMismatch('no OIDC attempt cookie was presented');
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid) throw stateMismatch('OIDC attempt cookie signature was invalid');
  const held = unpackAttemptCookie(unsigned.value);
  if (held === null) throw stateMismatch('OIDC attempt cookie was malformed');

  // Double submit. The attempt row already makes `state` single-use; this makes it *ours*. An
  // attacker who feeds a victim a prepared callback URL supplies their own `state`, and the
  // victim's browser holds no cookie matching it, so the flow dies here without a query. Compared
  // as digests so the comparison is constant time and length-independent.
  if (!timingSafeEquals(hashOidcSecret(held.state), hashOidcSecret(query.state))) {
    throw stateMismatch('callback state did not match the attempt cookie');
  }

  // Single use, enforced by the UPDATE rather than by trust: `null` means unknown, expired, or
  // already consumed, and the three are deliberately indistinguishable from out here.
  const attempt = await store.oidcAttempts.consume(held.state);
  if (attempt === null) throw stateMismatch('OIDC attempt was unknown, expired or already used');

  // The verifier the browser held has to be the one whose digest we recorded. This is the check
  // that makes an intercepted authorization code useless: whoever took it does not have the
  // cookie, so they cannot produce a verifier that hashes to this.
  if (!timingSafeEquals(hashOidcSecret(held.codeVerifier), attempt.pkceVerifierHash)) {
    throw stateMismatch('PKCE verifier did not match the attempt');
  }

  return {
    nonceHash: attempt.nonceHash,
    codeVerifier: held.codeVerifier,
    redirectAfter: attempt.redirectAfter,
  };
}

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

/**
 * Builds the plugin.
 *
 * Exported alongside the default so tests can supply a store and a relying party; the default
 * export is what `registerRoutes` uses and takes no required options.
 */
export function createAuthRoutes(options: AuthRoutesOptions = {}): FastifyPluginAsync {
  return async (app) => {
    const config = app.appConfig;
    const store = options.store ?? createAuthStore(getSql());
    const relyingParty =
      options.relyingParty ?? (config.oidc === null ? null : createOidcRelyingParty({ config: config.oidc }));

    // Registered here so this module works on its own. `sessionPlugin` is idempotent and marked
    // `skip-override`, so hoisting it to the root instance later — which is where it belongs, so
    // that `rooms.ts` and the WebSocket hub see `request.session` too — makes this a no-op rather
    // than a conflict.
    await app.register(sessionPlugin, { store: store.sessions });

    /**
     * `POST /auth/guest` — an account in one request.
     *
     * No email, no password, no confirmation link. Requiring any of those would put a form between
     * a learner and the first lesson for no security benefit, because there is nothing of value
     * attached to the account to protect.
     */
    // Address-keyed, not session-keyed: see GUEST_RATE_LIMIT_MAX above for why the default
    // key is unusable on a route that issues a session.
    const guestRateLimit = clientKeyedRateLimit(config, GUEST_RATE_LIMIT_MAX, GUEST_RATE_LIMIT_WINDOW_MS);
    const oidcRateLimit = clientKeyedRateLimit(config, OIDC_RATE_LIMIT_MAX, OIDC_RATE_LIMIT_WINDOW_MS);
    app.post<{ Body: GuestBody | undefined }>(
      '/auth/guest',
      { config: guestRateLimit, schema: { body: { $ref: 'prl:createGuestBody#' } } },
      async (request, reply) => {
        // The body is optional in the type because the schema has no required members, so `{}` is
        // a legitimate payload and the parser may leave it absent altogether.
        const account = await store.users.createGuest(sanitiseDisplayName(request.body?.displayName));
        await issueSession(reply, account);
        reply.status(201);
        return sessionResponse(reply, account, store.users, config);
      },
    );

    /**
     * `GET /auth/session` — who am I, and what token do I need to change anything?
     *
     * Never 401. `user: null` is a complete, successful answer.
     */
    app.get('/auth/session', (request, reply) =>
      sessionResponse(reply, request.session === null ? null : request.session.user, store.users, config),
    );

    /**
     * `POST /auth/logout` — revoke and clear, idempotent.
     *
     * 204 whether or not there was anything to revoke. A client that has lost its cookie, or is
     * retrying after a timeout, has to be able to reach "signed out" without interpreting an error.
     */
    app.post('/auth/logout', async (_request, reply) => {
      await destroySession(reply);
      // `send()` with no argument rather than returning `null`: a 204 must carry no body, and a
      // `null` return value would serialise the four characters "null".
      return reply.status(204).send();
    });

    /**
     * `GET /auth/oidc/start` — begin a sign-in.
     *
     * `redirectAfter` is a PATH, enforced by `oidcStartQuerySchema`. Restating why, because this is
     * the single most-exploited parameter in any authentication flow: if an absolute URL were
     * accepted, `?redirectAfter=https://evil.example/login` would send a learner who has *just*
     * proven their identity straight to somebody else's sign-in page, with our domain behind them
     * in the history. The origin is supplied by this server from its own allowlist (see
     * `safeRedirectTarget`), so the worst a hostile value can do is choose which page of our own
     * app somebody lands on.
     */
    app.get<{ Querystring: StartQuery }>(
      '/auth/oidc/start',
      { config: oidcRateLimit, schema: { querystring: { $ref: 'prl:oidcStartQuery#' } } },
      async (request, reply) => {
        const party = requireRelyingParty(relyingParty);
        const wanted = request.query.redirectAfter;
        // Re-checked rather than trusted. The schema and this must agree, and if they ever drift
        // the stricter one should win.
        const redirectAfter = wanted !== undefined && isSafeRedirectPath(wanted) ? wanted : null;

        const secrets = createAttemptSecrets();
        // The URL is built first, because building it may fetch and validate discovery and that is
        // the step most likely to fail. Writing the attempt row first would leave a row behind for
        // every request made while the provider is unreachable.
        const url = await party.authorizationUrl({
          state: secrets.state,
          nonce: secrets.nonce,
          codeChallenge: secrets.codeChallenge,
        });

        // Plaintext in, digests stored. There is no column for the three plaintexts and there must
        // not be one: a database read has to be insufficient to complete somebody else's sign-in.
        await store.oidcAttempts.create({
          state: secrets.state,
          nonce: secrets.nonce,
          pkceVerifier: secrets.codeVerifier,
          redirectAfter,
        });

        reply.setCookie(oidcCookieName(config), packAttemptCookie(secrets), oidcCookieOptions(config));
        // 303 rather than 302: the method on the way out is unambiguously GET, whatever the browser
        // would otherwise have inferred.
        return reply.redirect(url, 303);
      },
    );

    /**
     * `GET /auth/oidc/callback` — finish a sign-in.
     *
     * No CSRF token is required, and none could be: this is a cross-site top-level navigation the
     * identity provider triggers, so no page of ours gets to add a header. `state` plus the attempt
     * cookie is the substitute, and it is checked before anything else happens.
     *
     * Every failure is either `oidc_state_mismatch` (this response does not belong to a sign-in of
     * ours) or `oidc_exchange_failed` (the provider or its token could not be trusted). Nothing
     * from the provider's error body, the token, or the query string reaches the client.
     */
    app.get<{ Querystring: CallbackQuery }>(
      '/auth/oidc/callback',
      { config: oidcRateLimit, schema: { querystring: { $ref: 'prl:oidcCallbackQuery#' } } },
      async (request, reply) => {
        const party = requireRelyingParty(relyingParty);
        const query = request.query;
        // Cleared unconditionally and early: the attempt is over either way, and a cookie left
        // behind after a failure is a PKCE verifier sitting in a browser for another ten minutes.
        reply.clearCookie(oidcCookieName(config), sessionCookieOptions(config));

        if (query.error !== undefined) {
          // The provider's `error` is echoed nowhere and logged only after being stripped to a
          // safe alphabet: it is caller-influenceable text on the request most likely to be probed.
          request.log.warn(
            {
              oidcProviderError: query.error.replace(/[^a-z_]/gi, '').slice(0, MAX_LOGGED_PROVIDER_ERROR),
            },
            'identity provider returned an error',
          );
          throw new AppError('oidc_exchange_failed', { logDetail: 'provider returned an error response' });
        }

        const attempt = await acceptAttempt(request, query, store);
        if (query.code === undefined) {
          throw new AppError('oidc_exchange_failed', {
            logDetail: 'callback carried neither code nor error',
          });
        }

        const idToken = await party.exchangeCode({ code: query.code, codeVerifier: attempt.codeVerifier });
        const verified = await party.verifyIdToken(idToken, { nonceHash: attempt.nonceHash });

        // Identity is the (issuer, subject) pair and nothing else. Not the email — mutable, often
        // unverified, reused between providers — and not the name.
        const account = await store.users.findOrCreateOidc(
          verified.issuer,
          verified.subject,
          sanitiseDisplayName(verified.nameHint ?? undefined) ?? federatedDisplayName(),
        );

        await issueSession(reply, account);
        return reply.redirect(safeRedirectTarget(attempt.redirectAfter, config.webOrigins), 303);
      },
    );

    /**
     * `POST /me/units/reset` — back to the starting figure.
     *
     * Deliberately not given a tighter rate limit than the global one: "you have reset too
     * recently" is precisely the friction `docs/PRODUCT-GUARDRAILS.md` §1 forbids.
     */
    app.post('/me/units/reset', async (request) => {
      const session = requireSession(request);
      const body: ResetUnitsResponse = { units: await store.users.resetUnits(session.user.id) };
      return body;
    });
  };
}

/** What `registerRoutes(app, [authRoutes])` gets: a plugin with no required options. */
const authRoutes: FastifyPluginAsync = async (app, options) => {
  await createAuthRoutes()(app, options);
};

export default authRoutes;

// ---------------------------------------------------------------------------
// Binding the repositories
// ---------------------------------------------------------------------------

/** `prl.users` rows carry `Date`s; the wire carries ISO strings. One conversion, one place. */
function accountFrom(row: usersRepository.UserRow): SessionAccount {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Binds `sql` into every port.
 *
 * The one place in this module that mentions the database, and every call is a repository function,
 * so the queries themselves live where they can be reviewed together.
 */
export function createAuthStore(sql: Sql): AuthStore {
  return {
    sessions: {
      findValidByToken: async (token) => {
        const found = await sessionsRepository.findValidByToken(sql, token);
        if (found === null) return null;
        return {
          sessionId: found.sessionId,
          expiresAt: found.expiresAt,
          user: {
            id: found.user.id,
            kind: found.user.kind,
            displayName: found.user.displayName,
            createdAt: found.user.createdAt.toISOString(),
          },
        };
      },

      create: async (userId, fingerprints) =>
        sessionsRepository.create(sql, {
          userId,
          ipHash: fingerprints.ipHash,
          userAgentHash: fingerprints.userAgentHash,
        }),

      /**
       * Sliding expiry.
       *
       * The two lifetimes are supplied here rather than known by the repository, which is why
       * `extendExpiry` takes them: `SESSION_TTL_SECONDS` is the table's own idle window and lives
       * with the rows, while `SESSION_ABSOLUTE_TTL_SECONDS` is an authentication policy owned by
       * `auth/session.ts`. A repository that imported the second would be reaching upwards into the
       * middleware, and the two modules already point at each other for the first.
       */
      extendExpiry: async (sessionId) =>
        sessionsRepository.extendExpiry(sql, sessionId, SESSION_TTL_SECONDS, SESSION_ABSOLUTE_TTL_SECONDS),

      revoke: async (sessionId) => sessionsRepository.revoke(sql, sessionId),
      touchLastSeen: async (userId) => usersRepository.touchLastSeen(sql, userId),
    },

    users: {
      createGuest: async (displayName) => {
        const input = displayName === undefined ? {} : { displayName };
        return accountFrom(await usersRepository.createGuest(sql, input));
      },

      findOrCreateOidc: async (issuer, subject, displayName) => {
        const result = await usersRepository.findOrCreateOidcUser(sql, { issuer, subject, displayName });
        return accountFrom(result.user);
      },

      readUnits: async (userId) => (await usersRepository.readUnits(sql, userId)).units,
      resetUnits: async (userId) => (await usersRepository.resetUnits(sql, userId)).units,
    },

    oidcAttempts: {
      create: async (input) => {
        await sessionsRepository.createLoginAttempt(sql, {
          state: input.state,
          nonce: input.nonce,
          pkceVerifier: input.pkceVerifier,
          redirectAfter: input.redirectAfter,
        });
      },

      consume: async (state) => {
        const consumed = await sessionsRepository.consumeLoginAttempt(sql, state);
        if (consumed === null) return null;
        return {
          nonceHash: consumed.nonceHash,
          pkceVerifierHash: consumed.pkceVerifierHash,
          redirectAfter: consumed.redirectAfter,
        };
      },
    },
  };
}
