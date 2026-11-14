/**
 * Auth routes for guest sessions, the session read, sign-out, OIDC, units reset and account erasure.
 *
 * `GET /auth/session` never answers 401, since signed out is the normal case. A guest is a
 * first-class account created in one request. Logout is idempotent. Units reset is unconditional
 * with no cooldown (`docs/PRODUCT-GUARDRAILS.md` §1). Erasure is the opposite. It needs a
 * confirmation phrase and its own rate limit because it cannot be undone.
 * No SQL here. `createAuthStore(sql)` binds the repositories, and tests inject a fake store and
 * identity provider. Units are derived by `repositories/users.ts`, never stored as a column.
 */

import { randomBytes } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { DeleteAccountResponse, ResetUnitsResponse, SessionResponse, SessionUser } from '@prl/contracts';
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
  noteSessionRevoked,
  requireSession,
  SESSION_ABSOLUTE_TTL_SECONDS,
  sessionPlugin,
} from '../auth/session.ts';
import type { AppConfig } from '../config.ts';
import type { Sql } from '../db.ts';
import { getSql } from '../db.ts';
import { AppError, rateLimitError } from '../errors.ts';
import { recordSecurityAudit } from '../observability/telemetry.ts';
import { OutcomeBudget } from '../plugins/outcome-budget.ts';
import { addressRateLimitKey, clientKeyedRateLimit, sessionCookieOptions } from '../plugins/security.ts';
import { hashOidcSecret, timingSafeEquals } from '../repositories/hashing.ts';
import * as sessionsRepository from '../repositories/sessions.ts';
import { SESSION_TTL_SECONDS } from '../repositories/sessions.ts';
import * as usersRepository from '../repositories/users.ts';
import { type RoomRegistry, roomRegistry } from '../rooms/registry.ts';

/*
 * Unauthenticated limits.
 *
 * All are keyed on the hashed client address, never the session, because these routes issue a
 * session and a fresh cookie would rotate the key (60 guest creations, zero 429s; frozen cookie,
 * 429 after six). Never introduce a key that rotates under the caller.
 * A cohort behind one address is one caller, so OIDC has three budgets: a cohort-sized ceiling
 * (`oidcMax`, default 60 per 60 s), a failed-outcome budget (`oidcFailureMax`, default 15, so forced
 * token exchanges stay at 15 a minute), and an unredeemed-start budget over the attempt TTL. A
 * script can send requests but cannot complete a sign-in. Budgets are checked in `preHandler`, and
 * a 429 is never charged. Guest creation always succeeds, so it keeps `guestMax` at 10 per 60 s.
 * The route limit replaces the global bucket rather than stacking, and the retention sweep runs
 * every six hours, so attempt-row residency is `rate x 360 minutes`. Outrunning the sweep takes 46
 * addresses with the unredeemed-start budget, and 5 with the ceiling raised alone. Every figure here
 * is asserted in `test/cohort-sign-in-limits.test.ts`.
 */

/**
 * The budget is for failed requests. A wrong confirmation phrase is free to send and the deletion
 * takes `for update` on the account row. Session-keyed by default, which is correct because this
 * route consumes a session. Literals because nothing automated needs to raise them.
 */
const ACCOUNT_DELETE_MAX = 5;
const ACCOUNT_DELETE_WINDOW_MS = 15 * 60 * 1_000;

/** Mirrors `DISPLAY_NAME_SCHEMA` in `@prl/contracts`. */
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 '._-]{0,22}[A-Za-z0-9]$/;
const DISPLAY_NAME_DISALLOWED = /[^A-Za-z0-9 '._-]/g;
const DISPLAY_NAME_MAX = 24;

/** Same `__Host-` rule as the session cookie. */
const OIDC_COOKIE_BASE = 'prl_oidc';

/** Provider `error` codes are stripped to a safe alphabet and clipped to this length before logging. */
const MAX_LOGGED_PROVIDER_ERROR = 64;

/** `sql` already bound. */
export interface UserStore {
  /** `undefined` means the repository generates one. */
  readonly createGuest: (displayName: string | undefined) => Promise<SessionAccount>;
  /** Never a duplicate, never a rename. */
  readonly findOrCreateOidc: (
    issuer: string,
    subject: string,
    displayName: string,
  ) => Promise<SessionAccount>;
  readonly readUnits: (userId: string) => Promise<number>;
  readonly resetUnits: (userId: string) => Promise<number>;
  /**
   * Erases the account in one transaction, so a half-applied erasure is impossible.
   * `null` means no such account, which a retried request can reach. The repository refuses a pool handle.
   */
  readonly deleteAccount: (userId: string) => Promise<DeleteAccountResponse | null>;
}

export interface OidcAttemptStore {
  readonly create: (input: {
    readonly state: string;
    readonly nonce: string;
    readonly pkceVerifier: string;
    readonly redirectAfter: string | null;
  }) => Promise<void>;
  /** Single use. `null` for unknown, expired and already used alike (see `consumeLoginAttempt`). */
  readonly consume: (state: string) => Promise<{
    readonly nonceHash: Buffer;
    readonly pkceVerifierHash: Buffer;
    readonly redirectAfter: string | null;
  } | null>;
}

export interface AuthStore {
  readonly sessions: SessionStore;
  readonly users: UserStore;
  readonly oidcAttempts: OidcAttemptStore;
}

export interface AuthRoutesOptions {
  readonly store?: AuthStore;
  /** Injected by tests. */
  readonly relyingParty?: OidcRelyingParty;
  /** Live tables a units reset must restack (see `POST /me/units/reset`). */
  readonly tables?: Pick<RoomRegistry, 'restackForUnitsReset'>;
}

/**
 * Also covers inputs Ajv never sees, an absent name and the provider's `name` claim. Strips control,
 * bidi and zero-width characters that let one player render as another. Returns `undefined` rather
 * than throwing, because `repositories/users.ts` throws mid-callback where the learner did nothing wrong.
 */
export function sanitiseDisplayName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const collapsed = raw.replace(DISPLAY_NAME_DISALLOWED, ' ').replace(/\s+/g, ' ').trim();
  const clipped = collapsed.slice(0, DISPLAY_NAME_MAX).trim();
  return DISPLAY_NAME_PATTERN.test(clipped) ? clipped : undefined;
}

/** Not "Guest", which would mislabel a signed-in learner. */
function federatedDisplayName(): string {
  return `Player ${randomHex()}`;
}

function randomHex(): string {
  return randomBytes(3).toString('hex').toUpperCase();
}

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
 * The CSRF token is minted for everybody, since `POST /auth/guest` itself needs one.
 * `generateCsrf` does NOT rotate the secret (`@fastify/csrf-protection@8.0.1` reuses a usable
 * cookie), so a token survives sign-in and sign-out. Double submit does not depend on freshness.
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

function oidcCookieName(config: AppConfig): string {
  return config.isProduction ? `__Host-${OIDC_COOKIE_BASE}` : OIDC_COOKIE_BASE;
}

/**
 * `sessionCookieOptions` plus a lifetime. `lax` is required because the provider returns by a
 * cross-site navigation, and this cookie carries the PKCE verifier.
 */
function oidcCookieOptions(config: AppConfig): CookieSerializeOptions {
  return { ...sessionCookieOptions(config), maxAge: Math.floor(OIDC_ATTEMPT_TTL_MS / 1_000) };
}

/** Otherwise a 501. */
function requireRelyingParty(party: OidcRelyingParty | null): OidcRelyingParty {
  if (party === null) {
    throw new AppError('oidc_not_configured', { logDetail: 'OIDC is not configured on this server' });
  }
  return party;
}

/** Mirror the schemas beside them. The schema enforces them at runtime. */
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
  /** RFC 9207 issuer. Optional because many deployed providers predate it. Checked when present. */
  readonly iss?: string;
}

interface AcceptedAttempt {
  readonly nonceHash: Buffer;
  readonly codeVerifier: string;
  readonly redirectAfter: string | null;
}

/**
 * The order is the security property. The cookie is checked before the database, the attempt is
 * consumed before the code is spent, and the PKCE verifier is checked before the provider is called.
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

  // Double submit. A victim fed a prepared callback URL holds no matching cookie. Compared as
  // digests so it is constant time.
  if (!timingSafeEquals(hashOidcSecret(held.state), hashOidcSecret(query.state))) {
    throw stateMismatch('callback state did not match the attempt cookie');
  }

  // Single use, enforced by the UPDATE. Unknown, expired and consumed are indistinguishable.
  const attempt = await store.oidcAttempts.consume(held.state);
  if (attempt === null) throw stateMismatch('OIDC attempt was unknown, expired or already used');

  // Makes an intercepted authorization code useless without the cookie.
  if (!timingSafeEquals(hashOidcSecret(held.codeVerifier), attempt.pkceVerifierHash)) {
    throw stateMismatch('PKCE verifier did not match the attempt');
  }

  return {
    nonceHash: attempt.nonceHash,
    codeVerifier: held.codeVerifier,
    redirectAfter: attempt.redirectAfter,
  };
}

export function createAuthRoutes(options: AuthRoutesOptions = {}): FastifyPluginAsync {
  return async (app) => {
    const config = app.appConfig;
    const store = options.store ?? createAuthStore(getSql());
    const tables = options.tables ?? roomRegistry();
    const relyingParty =
      options.relyingParty ?? (config.oidc === null ? null : createOidcRelyingParty({ config: config.oidc }));

    // Idempotent and `skip-override`, so the root registration in `routes/index.ts` makes this a no-op.
    await app.register(sessionPlugin, { store: store.sessions });

    // Address-keyed (see the limits note above).
    const guestRateLimit = clientKeyedRateLimit(
      config,
      config.rateLimit.guestMax,
      config.rateLimit.guestWindowMs,
    );
    const oidcRateLimit = clientKeyedRateLimit(
      config,
      config.rateLimit.oidcMax,
      config.rateLimit.oidcWindowMs,
    );

    /** Failures only. Per app instance, so test apps in one process do not share counters. */
    const oidcFailures = new OutcomeBudget({
      max: config.rateLimit.oidcFailureMax,
      windowMs: config.rateLimit.oidcWindowMs,
    });

    /**
     * Unredeemed starts, which `oidcFailures` cannot see because a successful start is not a failure.
     * Without it a start flood is bounded only by the ceiling (see the arithmetic above).
     * The window is `OIDC_ATTEMPT_TTL_MS`, so a charge still outstanding means the row expired unredeemed.
     * The max is `oidcMax`, so it sizes itself from the cohort.
     */
    const oidcUnredeemedStarts = new OutcomeBudget({
      max: config.rateLimit.oidcMax,
      windowMs: OIDC_ATTEMPT_TTL_MS,
    });

    /**
     * Checks run in `preHandler`, before the attempt row or token exchange. Failures are charged in
     * `onResponse`, when the outcome is known. Both routes answer 303 on success, so the unredeemed
     * budget is charged and credited in the handlers. A 429 is never charged (no `continueExceeding`).
     */
    const refuseWhenFailing = (
      request: FastifyRequest,
      _reply: FastifyReply,
      done: (error?: Error) => void,
    ) => {
      const refusalMs = oidcFailures.refusalFor(addressRateLimitKey(request, config));
      if (refusalMs === null) {
        done();
        return;
      }
      done(rateLimitError(refusalMs / 1_000));
    };

    const refuseWhenTooManyUnredeemed = (
      request: FastifyRequest,
      _reply: FastifyReply,
      done: (error?: Error) => void,
    ) => {
      const refusalMs = oidcUnredeemedStarts.refusalFor(addressRateLimitKey(request, config));
      if (refusalMs === null) {
        done();
        return;
      }
      done(rateLimitError(refusalMs / 1_000));
    };

    /**
     * Requests whose failure the caller pays for. Both OIDC routes are GETs, so any page can make a
     * victim's browser issue them. Charging every 4xx would let 15 cross-site image loads lock a
     * campus address out of sign-in, the start route included, where the schema refuses a bad
     * `redirectAfter` before any `preHandler` runs.
     * The callback is marked once `acceptAttempt` succeeds, which needs a cookie only this server can
     * set. The start is marked on entering the handler, the point past which a failure costs a
     * discovery fetch and an attempt row.
     * A `WeakSet` so nothing else can read or set it and no request is retained.
     */
    const chargeableOidcFailures = new WeakSet<FastifyRequest>();

    const chargeFailedOutcome = (
      request: FastifyRequest,
      reply: FastifyReply,
      done: (error?: Error) => void,
    ) => {
      // `delete` spends the mark, so `chargeAbandonedOutcome` cannot charge the same request again.
      const chargeable = chargeableOidcFailures.delete(request);
      if (chargeable && reply.statusCode >= 400 && reply.statusCode !== 429) {
        oidcFailures.charge(addressRateLimitKey(request, config));
      }
      done();
    };

    /**
     * `onResponse` does not run when the client aborts, and the handler keeps running. With a refusing
     * provider, destroying the socket gave 120 forced token exchanges and no refusal against a budget of 15.
     * Abandoned marked requests are charged as failures. That is the safe direction, since the mark
     * is set only after something was spent.
     */
    const chargeAbandonedOutcome = (request: FastifyRequest, done: (error?: Error) => void) => {
      if (chargeableOidcFailures.delete(request)) {
        oidcFailures.charge(addressRateLimitKey(request, config));
      }
      done();
    };

    app.post<{ Body: GuestBody | undefined }>(
      '/auth/guest',
      { config: guestRateLimit, schema: { body: { $ref: 'prl:createGuestBody#' } } },
      async (request, reply) => {
        // `{}` is valid, so the parser may leave the body absent.
        const account = await store.users.createGuest(sanitiseDisplayName(request.body?.displayName));
        await issueSession(reply, account);
        // Audited because this is the one unauthenticated endpoint that writes a user row. No display name.
        recordSecurityAudit({ event: 'auth.guest.created', userId: account.id }, (message, detail) => {
          request.log.warn({ ...detail }, message);
        });
        reply.status(201);
        return sessionResponse(reply, account, store.users, config);
      },
    );

    /** Never 401. `user: null` is a complete answer. */
    app.get('/auth/session', (request, reply) =>
      sessionResponse(reply, request.session === null ? null : request.session.user, store.users, config),
    );

    /** 204 whether or not there was a session, so a client can always reach signed out. */
    app.post('/auth/logout', async (request, reply) => {
      const userId = request.session === null ? null : request.session.user.id;
      await destroySession(reply);
      // Only when a session ended. Idempotent retries are not events.
      if (userId !== null) {
        recordSecurityAudit({ event: 'auth.session.revoked', userId }, (message, detail) => {
          request.log.warn({ ...detail }, message);
        });
      }
      // `send()` with no argument, since a `null` return serialises as "null".
      return reply.status(204).send();
    });

    /**
     * Refuses an OIDC GET whose `Sec-Fetch-Dest` says it is a subresource load. Both routes are
     * navigations by construction, and 60 `<img>` tags on one page exhaust a campus address's budget.
     * Fails open when the header is absent (curl, old clients), which cannot mount a cross-site request.
     * An `onRequest` hook, not a `preHandler`: `@fastify/rate-limit` appends its hook after a route's
     * declared `onRequest`, so this runs above the cohort ceiling and above the schema. As a
     * `preHandler`, refused loads would still spend the ceiling and the victim would get a 429.
     * Requests refused here are deliberately uncounted. It is one header comparison with no I/O.
     */
    const refuseNonNavigationOidc = (
      request: FastifyRequest,
      _reply: FastifyReply,
      done: (error?: Error) => void,
    ): void => {
      const dest = request.headers['sec-fetch-dest'];
      if (typeof dest === 'string' && dest !== '' && dest !== 'document') {
        done(new AppError('invalid_request'));
        return;
      }
      done();
    };

    /**
     * `redirectAfter` must be a path (`oidcStartQuerySchema`). The origin comes from our allowlist via
     * `safeRedirectTarget`, so a hostile value can only choose a page of our own app.
     */
    app.get<{ Querystring: StartQuery }>(
      '/auth/oidc/start',
      {
        config: oidcRateLimit,
        // Both budgets guard the start. `onRequest` runs above the route limiter (see
        // `refuseNonNavigationOidc`).
        onRequest: [refuseNonNavigationOidc],
        preHandler: [refuseWhenFailing, refuseWhenTooManyUnredeemed],
        onResponse: chargeFailedOutcome,
        onRequestAbort: chargeAbandonedOutcome,
        schema: { querystring: { $ref: 'prl:oidcStartQuery#' } },
      },
      async (request, reply) => {
        // Past the schema, the guard and both budgets, so a failure from here costs something.
        chargeableOidcFailures.add(request);
        const party = requireRelyingParty(relyingParty);
        const wanted = request.query.redirectAfter;
        // Re-checked. If the schema and this drift, the stricter wins.
        const redirectAfter = wanted !== undefined && isSafeRedirectPath(wanted) ? wanted : null;

        const secrets = createAttemptSecrets();
        // Built first because discovery may fail, and a row written first would be left behind.
        const url = await party.authorizationUrl({
          state: secrets.state,
          nonce: secrets.nonce,
          codeChallenge: secrets.codeChallenge,
        });

        // Only digests are stored, so a database read cannot complete somebody else's sign-in.
        await store.oidcAttempts.create({
          state: secrets.state,
          nonce: secrets.nonce,
          pkceVerifier: secrets.codeVerifier,
          redirectAfter,
        });
        // Charged once the row exists. The credit is in the callback.
        oidcUnredeemedStarts.charge(addressRateLimitKey(request, config));

        reply.setCookie(oidcCookieName(config), packAttemptCookie(secrets), oidcCookieOptions(config));
        // 303 so the method is unambiguously GET.
        return reply.redirect(url, 303);
      },
    );

    /**
     * No CSRF token is possible on a provider-triggered navigation. `state` plus the attempt cookie
     * substitutes. Failures are `oidc_state_mismatch` or `oidc_exchange_failed`, and nothing from the
     * provider, the token or the query reaches the client.
     */
    app.get<{ Querystring: CallbackQuery }>(
      '/auth/oidc/callback',
      {
        config: oidcRateLimit,
        // Only the failed-outcome budget, since a callback redeems a row. Above the route limiter.
        onRequest: [refuseNonNavigationOidc],
        preHandler: [refuseWhenFailing],
        // Charged only once the callback proves it belongs to our sign-in (`chargeableOidcFailures`).
        onResponse: chargeFailedOutcome,
        onRequestAbort: chargeAbandonedOutcome,
        schema: { querystring: { $ref: 'prl:oidcCallbackQuery#' } },
      },
      async (request, reply) => {
        const party = requireRelyingParty(relyingParty);
        const query = request.query;
        // Cleared early, so a failure does not leave the PKCE verifier in the browser.
        reply.clearCookie(oidcCookieName(config), sessionCookieOptions(config));

        /**
         * RFC 9207 mix-up defence. `state` does not stop an attacker returning another provider's code.
         * Checked before the attempt is consumed, so a mismatch cannot burn a legitimate row.
         */
        const expectedIssuer = config.oidc?.issuer;
        if (query.iss !== undefined && expectedIssuer !== undefined && query.iss !== expectedIssuer) {
          request.log.warn(
            {
              oidcCallbackIssuer: query.iss
                .replace(/[^a-z0-9:/._-]/gi, '')
                .slice(0, MAX_LOGGED_PROVIDER_ERROR),
            },
            'callback carried an issuer this deployment did not ask for',
          );
          throw new AppError('oidc_exchange_failed', {
            logDetail: 'callback issuer did not match the configured issuer (RFC 9207)',
          });
        }

        if (query.error !== undefined) {
          // Echoed nowhere and logged only after stripping, since it is caller-influenced.
          request.log.warn(
            {
              oidcProviderError: query.error.replace(/[^a-z_]/gi, '').slice(0, MAX_LOGGED_PROVIDER_ERROR),
            },
            'identity provider returned an error',
          );
          throw new AppError('oidc_exchange_failed', { logDetail: 'provider returned an error response' });
        }

        const attempt = await acceptAttempt(request, query, store);
        // The caller has presented our attempt cookie, so failures from here are chargeable.
        chargeableOidcFailures.add(request);
        if (query.code === undefined) {
          throw new AppError('oidc_exchange_failed', {
            logDetail: 'callback carried neither code nor error',
          });
        }

        const idToken = await party.exchangeCode({ code: query.code, codeVerifier: attempt.codeVerifier });
        const verified = await party.verifyIdToken(idToken, { nonceHash: attempt.nonceHash });

        // Identity is (issuer, subject) only. Email is mutable and often unverified.
        const account = await store.users.findOrCreateOidc(
          verified.issuer,
          verified.subject,
          sanitiseDisplayName(verified.nameHint ?? undefined) ?? federatedDisplayName(),
        );

        await issueSession(reply, account);
        // Credited only after `issueSession`, since the sign-in could fail up to here.
        oidcUnredeemedStarts.credit(addressRateLimitKey(request, config));
        return reply.redirect(safeRedirectTarget(attempt.redirectAfter, config.webOrigins), 303);
      },
    );

    /**
     * No tighter rate limit, by `docs/PRODUCT-GUARDRAILS.md` §1.
     * Live tables first, then the rows, or a seated learner's table writes the old stack back over
     * the reset (`RoomRegistry.restackForUnitsReset`, which also drains the archive).
     */
    app.post('/me/units/reset', async (request) => {
      const session = requireSession(request);
      await tables.restackForUnitsReset(session.user.id);
      const body: ResetUnitsResponse = { units: await store.users.resetUnits(session.user.id) };
      return body;
    });

    /**
     * Deletes sessions, lesson reads, quiz and scenario attempts and every seat. Anonymises hand seats,
     * audit entries and created tables. Retains every hand, which other people's history shares.
     * Created tables are closed, not deleted, because `prl.hands` cascades from `prl.rooms`.
     * `apps/web/src/app/record/DeleteAccount.tsx` explains this before confirmation, and
     * `db/migrations/0004_account_deletion.sql` argues each choice.
     * Order is `requireSession` (no user id in the request, so it cannot target anyone else), the
     * erasure transaction, then `destroySession`, never before, or a failed transaction leaves a
     * signed-out browser with an intact account.
     */
    app.post(
      '/me/delete',
      {
        config: { rateLimit: { max: ACCOUNT_DELETE_MAX, timeWindow: ACCOUNT_DELETE_WINDOW_MS } },
        schema: { body: { $ref: 'prl:deleteAccountBody#' } },
      },
      async (request, reply) => {
        const session = requireSession(request);
        const deleted = await store.users.deleteAccount(session.user.id);
        // Announced by user, since every session was revoked. After commit and before the response.
        if (deleted !== null) noteSessionRevoked({ userId: session.user.id });
        // Already gone (a retry, or a swept guest). 401, since a zero-count success would claim an erasure.
        if (deleted === null) {
          await destroySession(reply);
          throw new AppError('not_authenticated', {
            logDetail: 'account deletion found no such account; the session outlived its user row',
          });
        }
        // No user id, name or counts in the log.
        request.log.info({ userKind: session.user.kind }, 'account erased at the learner request');
        // NULL user id, so the audit log never points at an account that asked to stop existing.
        recordSecurityAudit({ event: 'auth.account.deleted', userId: null }, (message, detail) => {
          request.log.warn({ ...detail }, message);
        });
        await destroySession(reply);
        return deleted;
      },
    );
  };
}

const authRoutes: FastifyPluginAsync = async (app, options) => {
  await createAuthRoutes()(app, options);
};

export default authRoutes;

/** `Date` to ISO string, in one place. */
function accountFrom(row: usersRepository.UserRow): SessionAccount {
  return {
    id: row.id,
    kind: row.kind,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

/** The only place this module touches the database, always through repository functions. */
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

      /** Lifetimes are passed in. `SESSION_ABSOLUTE_TTL_SECONDS` is auth policy in `auth/session.ts`. */
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

      /**
       * `sql.begin`, not `withTransaction`, which would use the process-wide pool instead of this handle.
       * Boxed because `begin` returns `UnwrapPromiseArray<T>`.
       */
      deleteAccount: async (userId) => {
        const boxed = await sql.begin(async (tx) => ({
          value: await usersRepository.deleteAccount(tx, userId),
        }));
        const summary = boxed.value;
        if (summary === null) return null;
        // Narrowed to the wire contract. The rest is not the learner's business.
        return {
          deleted: {
            sessions: summary.deleted.sessions,
            lessonsCompleted: summary.deleted.lessonsCompleted,
            quizAttempts: summary.deleted.quizAttempts,
            scenarioAttempts: summary.deleted.scenarioAttempts,
            roomMemberships: summary.deleted.roomMemberships,
          },
          anonymised: {
            handSeats: summary.anonymised.handSeats,
            auditEvents: summary.anonymised.auditEvents,
            roomsCreated: summary.anonymised.roomsCreated,
          },
        };
      },
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
