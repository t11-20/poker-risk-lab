/**
 * The authentication routes: guest sessions, the session read, sign-out, OIDC, unit reset, and
 * the erasure of an account.
 *
 * Seven endpoints, and the interesting thing about them is how differently they treat "not signed
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
 * - `POST /me/delete` is the opposite of the reset in every respect, and deliberately so. It
 *   needs a session, a confirmation phrase in the body and a rate-limit budget of its own,
 *   because it is the one request in this product that cannot be undone. Friction on a reset is
 *   a dark pattern; friction on an erasure is the feature.
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

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/*
 * The unauthenticated limits, and the classroom that broke the first version of them.
 *
 * ## The part that has not changed: the KEY
 *
 * Every limit in this section is keyed on a hash of the client ADDRESS and deliberately ignores
 * the session cookie. That is not a preference, it is forced: `POST /auth/guest` and
 * `GET /auth/oidc/callback` both ISSUE a session, so a client that keeps the cookie it was just
 * handed presents a DIFFERENT key on its next request and the counter never accumulates.
 * Measured against the running server: 60 consecutive guest creations produced zero 429s, while
 * freezing the cookie produced a 429 after six — which is what proved key rotation was the cause
 * rather than a missing config. `clientKeyedRateLimit` in `plugins/security.ts` carries the whole
 * argument. Nothing below may reintroduce a key that rotates under the caller.
 *
 * ## The part that WAS wrong: the size, and the shape
 *
 * This comment used to say the NAT cost of address keying was accepted knowingly, because "a
 * classroom of thirty sharing an account-creation budget will occasionally be told to wait". That
 * was reasoned for a public instance and it was wrong for the product's actual first five minutes.
 * A cohort of thirty students on one campus, office or VPN egress address IS one caller as far as
 * these limits are concerned, and they all sign in inside the same ten seconds.
 *
 * Measured against the shipped defaults, thirty learners, one address, one window
 * (`test/cohort-sign-in-limits.test.ts` drives exactly this):
 *
 *     OIDC sign-in    15 of 30 completed, 15 refused with 429, first refusal at learner 16
 *     guest creation  10 of 30 created,   20 refused with 429, first refusal at learner 11
 *
 * "Occasionally told to wait" was half the room, on their first interaction with a product their
 * institution had paid for.
 *
 * ## Why the fix is not a bigger number
 *
 * Raising `oidcMax` from 15 to 60 on its own would buy the cohort headroom by handing the same
 * headroom to a script. So the OIDC limit became THREE budgets counting three different things:
 *
 *   1. **A ceiling, sized for the cohort** — `config.rateLimit.oidcMax` / `oidcWindowMs`, applied
 *      to `/auth/oidc/start` and `/auth/oidc/callback` through `clientKeyedRateLimit` exactly as
 *      before. Default 60 per 60 s, which is 30 learners x 2 requests each.
 *
 *   2. **A budget spent only by FAILURES, sized for the abuse** — `config.rateLimit.oidcFailureMax`
 *      over the same window, held in an `OutcomeBudget` and charged in an `onResponse` hook when
 *      the request ended in an error. Default 15 per 60 s, unchanged in effect from what shipped.
 *
 *   3. **A budget spent by UNREDEEMED STARTS** — charged when a start writes an attempt row,
 *      credited when a callback redeems one, over the attempt row's own 10-minute TTL. It exists
 *      because (1) and (2) together cannot see the cheapest attack of all; the measurement that
 *      forced it is on `oidcUnredeemedStarts` in `createAuthRoutes` below and summarised in the
 *      delta at the end of this comment.
 *
 * The reason an OUTCOME is a better thing to count than a request: at the moment it arrives, a
 * start from a student is identical to a start from a script, and no limiter can separate them.
 * What separates them is how the flow ENDS. Completing a sign-in needs an authorization code that
 * only the identity provider can mint, presented with the matching single-use attempt row and the
 * PKCE verifier from a cookie handed out one request earlier. A script cannot produce that. It can
 * produce unlimited requests that FAIL to produce it, and unlimited starts it never comes back
 * for. Thirty completions from one address in a minute is a classroom; fifteen failures, or sixty
 * abandoned attempt rows, is not.
 *
 * The budgets are checked in `preHandler`, so a refused caller never reaches the attempt row or
 * the token exchange. A 429 is never itself charged: a caller who kept retrying would otherwise
 * keep pushing their own window forward and never be let back in, which is `continueExceeding` by
 * accident and is not something this application enables anywhere.
 *
 * ## Guest creation is a DIFFERENT case, and keeps the tight default
 *
 * The split above does not transfer, and pretending it did would be the dangerous move. On
 * `POST /auth/guest` every attempt SUCCEEDS — there is no email, no password and no provider to
 * fail against. So there is no failed outcome to charge, "refund on success" is meaningless, and
 * the successful creations ARE the abuse: this is the one unauthenticated endpoint that writes a
 * user row, so it is the one a script points at to fill the users table.
 *
 * Therefore `config.rateLimit.guestMax` stays at its shipped 10 per 60 s for every deployment. A
 * cohort that uses guest accounts needs that raised, and raising it is an operator decision with a
 * security consequence rather than a default: `COHORT_SIZE` plus `COHORT_ENTRY` in `config.ts`
 * makes the process REFUSE TO BOOT when a declared cohort cannot get in, naming the arithmetic and
 * naming what raising it costs. Nothing is raised automatically.
 *
 * The numbers live in `config.rateLimit.*` rather than as literals here, and that has been true
 * since a smoke run proved why: this is the limit an automated caller actually hits, `RATE_LIMIT_MAX`
 * in CI raises only the global bucket, and so the one limit that needed tuning for an automated
 * caller was the one that could not be tuned.
 *
 * ## THE SECURITY DELTA, stated plainly
 *
 * A first version of this comment said the raised ceiling cost "roughly 600 short-lived rows per
 * address, and the global limiter (300 per minute) still sits above it". BOTH HALVES OF THAT WERE
 * WRONG, and they are recorded here rather than quietly corrected because the shape of the error
 * is the useful part: it assumed a bound existed instead of measuring it.
 *
 *   * The 10-minute TTL does not remove rows. It bounds when a row is USABLE.
 *     `maintenance/retention-sweep.ts` is what removes them, every SIX HOURS, at most 1,000 x 100
 *     = 100,000 rows per table per sweep. Residency is `rate x 360 minutes`, not `rate x 10`.
 *   * The global limiter contributes NOTHING here. `@fastify/rate-limit` lets a route's own
 *     `config.rateLimit` replace the global bucket rather than stack with it. Measured: after 500
 *     starts from one address, `GET /ready` from that address still answered 200 and
 *     `POST /auth/guest` still answered 201. A start flood is free of the 300-per-minute budget.
 *
 * With those two facts, the honest arithmetic for the one table nothing else bounds:
 *
 *                            rows/min   per address per 6 h sweep   addresses to outrun the sweep
 *     before this change        15                5,400                          19
 *     ceiling raised alone      60               21,600                           5
 *     with budget (3)           60 per 10 min     2,160                          46
 *
 * So the raised ceiling ALONE was a real regression — it took the number of addresses needed to
 * make `prl.oidc_login_attempts` grow without limit from 19 to 5 — and budget (3) is what pays it
 * back with interest. The final position, per address:
 *
 *   GAINED by an attacker:
 *   * Complete up to `oidcMax` (60) sign-ins per minute instead of 15. Accepted: every one needs
 *     real credentials at the identity provider, so the bound on this was never our limiter — it
 *     is how many accounts the attacker actually holds at the IdP.
 *   * Burst up to 60 attempt rows in a minute rather than 15, which matters for a spike and not
 *     for residency, because the row below is what governs the sustained rate.
 *
 *   TIGHTENED against an attacker:
 *   * Sustained attempt-row creation: 60 per 10 minutes, down from 15 per minute. That is 2,160
 *     rows per address per sweep against 5,400 before — TIGHTER than the code this started from.
 *
 *   UNCHANGED, which is the part that matters most:
 *   * Outbound requests to the identity provider. Those cost real money and real reputation with
 *     the provider, and they only happen on a callback that gets past the state, cookie and PKCE
 *     checks and then fails at the token endpoint — that is, on a FAILED outcome. Measured, a
 *     script driving incomplete sign-ins from one address forced 15 token exchanges per minute
 *     and was then refused. It still forces 15 and is still refused. The failure budget's default
 *     is 15 precisely so that this number does not move.
 *   * Guest account creation: 10 per minute per address, exactly as before.
 *   * Unbounded account creation and unbounded IdP round trips are still refused. The refusal
 *     arrives from a different counter, at the same place.
 *
 * Every line of that table is asserted, with the before and after numbers, in
 * `test/cohort-sign-in-limits.test.ts`.
 */

/**
 * `POST /me/delete`, rate limited on its own budget.
 *
 * Not because a loop could delete the account more than once — the first request removes the row
 * and the session with it, so the second is `not_authenticated`. The budget is for the requests
 * that FAIL: a wrong confirmation phrase costs nothing to send, and without a limit this becomes
 * a free way to make a signed-in victim's session grind through a locking transaction (the
 * deletion takes `for update` on the account row) for as long as an attacker who has stolen a
 * CSRF token and a cookie cares to keep sending them.
 *
 * Five in fifteen minutes. A person deciding to leave presses the button once, twice if they
 * mistyped; five is far more than that and far less than a loop. The limit inherits the default
 * key generator, which prefers the session cookie — correct here, unlike on `POST /auth/guest`,
 * because this route consumes a session rather than issuing one, so the key cannot rotate under
 * it.
 *
 * The numbers are literals rather than `config.rateLimit.*` entries, unlike the guest and OIDC
 * limits beside them. Those moved into configuration because an automated caller genuinely needs
 * to raise them; nothing in CI or in a smoke run deletes accounts in a loop, so a knob here would
 * be a setting that exists only to be turned down. If that changes, they belong in `config.ts`
 * with the others rather than being edited here.
 */
const ACCOUNT_DELETE_MAX = 5;
const ACCOUNT_DELETE_WINDOW_MS = 15 * 60 * 1_000;

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
  /**
   * Erases the account and everything that describes only it, in ONE transaction.
   *
   * `null` means the id named no account, which a client retrying a deletion whose response it
   * never saw can legitimately reach. Every other failure throws.
   *
   * The whole operation is one port method rather than several, because it has to be one
   * transaction: a half-applied erasure is a learner whose tables are shut and whose account
   * still exists, with nothing recording that anything was attempted. `createAuthStore` opens
   * the transaction; the repository refuses a pool handle outright.
   */
  readonly deleteAccount: (userId: string) => Promise<DeleteAccountResponse | null>;
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
  /**
   * RFC 9207's issuer identifier, present on any OpenID-conformant provider.
   *
   * Optional because the RFC is newer than plenty of deployed providers, and refusing a callback
   * that omits it would lock this endpoint to the modern half of the ecosystem. Present, it is
   * checked; absent, the state/nonce/PKCE triple is what carries the attempt's identity, exactly
   * as before.
   */
  readonly iss?: string;
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
    // Address-keyed, not session-keyed: see the guest-limit note above for why the default
    // key is unusable on a route that issues a session.
    const guestRateLimit = clientKeyedRateLimit(
      config,
      config.rateLimit.guestMax,
      config.rateLimit.guestWindowMs,
    );
    // The cohort-sized CEILING. Sized so a class fits under it; see the limits note above.
    const oidcRateLimit = clientKeyedRateLimit(
      config,
      config.rateLimit.oidcMax,
      config.rateLimit.oidcWindowMs,
    );

    /**
     * The second OIDC budget: the one only a FAILURE spends.
     *
     * Per app instance rather than per module, so two apps built in one process (which is what
     * every test file here does) cannot see each other's counters — the same isolation
     * `forgetRateLimitStoresForTests` exists to give the route limiters.
     */
    const oidcFailures = new OutcomeBudget({
      max: config.rateLimit.oidcFailureMax,
      windowMs: config.rateLimit.oidcWindowMs,
    });

    /**
     * The third: unredeemed starts, which is the one the first two cannot see.
     *
     * A caller that only ever hits `/auth/oidc/start` and never comes back writes an attempt row
     * every time and produces NO failed outcome, because a start that succeeds is not a failure.
     * So `oidcFailures` never charges it, and the only thing bounding it is the ceiling — which
     * this change raised from 15 to 60. Measured, and the numbers are the reason this budget
     * exists rather than a comment saying it is probably fine:
     *
     *   * A start flood is bounded by the route ceiling and by NOTHING ELSE. `@fastify/rate-limit`
     *     lets a route's own `config.rateLimit` REPLACE the global bucket rather than stack with
     *     it, so 500 starts from one address cost that address zero of its 300-per-minute global
     *     budget — measured: after the flood, `GET /ready` still answered 200 and
     *     `POST /auth/guest` still answered 201 from the same address.
     *   * `prl.oidc_login_attempts` rows are not removed when they expire. They are removed by
     *     `maintenance/retention-sweep.ts`, which runs every SIX HOURS and deletes at most
     *     `batchSize x maxPasses` = 1,000 x 100 = 100,000 rows per table per sweep. The 10-minute
     *     TTL bounds when a row is USABLE; the sweep is what bounds when it is GONE.
     *   * So residency per flooding address is `rate x 360 minutes`, and the number of addresses
     *     needed to outrun the sweep is `100,000 / that`:
     *
     *         before this change  15/min ->  5,400 rows per address per sweep -> 19 addresses
     *         ceiling raised      60/min -> 21,600 rows per address per sweep ->  5 addresses
     *         with this budget    60 per 10 min -> 2,160 per address per sweep -> 46 addresses
     *
     * Five addresses to make the only table with no other bound grow without limit, for ever, was
     * not an acceptable price for the cohort fix. With this budget the same attacker needs 46 —
     * better than the code this change started from, so the attempt-row channel ends up TIGHTER
     * than it shipped rather than four times looser.
     *
     * The window is `OIDC_ATTEMPT_TTL_MS`, not `oidcWindowMs`, and that is the whole trick: "still
     * charged when the window closes" then means exactly "the attempt row expired without being
     * redeemed", with no timer per attempt and no second sweep. The max is `oidcMax` — one
     * ceiling-window's worth of starts may be in flight at once — so it sizes itself from the
     * cohort declaration instead of being a fourth number an operator has to reason about. A
     * class of thirty holds about thirty for a few seconds and then gives them all back.
     */
    const oidcUnredeemedStarts = new OutcomeBudget({
      max: config.rateLimit.oidcMax,
      windowMs: OIDC_ATTEMPT_TTL_MS,
    });

    /**
     * The hooks that check and charge them.
     *
     * `preHandler` for the checks, so a refused caller is turned away before the attempt row is
     * written or the token endpoint is called — the two things these budgets exist to bound. It
     * runs after `@fastify/rate-limit`'s `onRequest`, so the ceiling still answers first when
     * both would.
     *
     * `onResponse` for the failure charge, because that is the first moment the OUTCOME is known,
     * which is the whole idea: this budget counts how a request ended, not that it happened.
     *
     * The unredeemed-start budget is charged and credited in the handlers instead, not here, for
     * a reason worth stating: BOTH routes answer 303 on success, so a response-status hook cannot
     * tell "sent a learner to the provider" from "brought one back with a session". The charge
     * belongs next to the `create` that writes the row it counts, and the credit next to the
     * `issueSession` that proves the row was redeemed.
     *
     * A 429 is never charged. Charging it would push the caller's own window forward on every
     * retry and lock them out for longer than the window they were told to wait — the library
     * calls that `continueExceeding`, this application does not enable it anywhere, and
     * re-inventing it here by accident would turn one cancelled consent screen into a lockout.
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

    const chargeFailedOutcome = (
      request: FastifyRequest,
      reply: FastifyReply,
      done: (error?: Error) => void,
    ) => {
      if (reply.statusCode >= 400 && reply.statusCode !== 429) {
        oidcFailures.charge(addressRateLimitKey(request, config));
      }
      done();
    };

    app.post<{ Body: GuestBody | undefined }>(
      '/auth/guest',
      { config: guestRateLimit, schema: { body: { $ref: 'prl:createGuestBody#' } } },
      async (request, reply) => {
        // The body is optional in the type because the schema has no required members, so `{}` is
        // a legitimate payload and the parser may leave it absent altogether.
        const account = await store.users.createGuest(sanitiseDisplayName(request.body?.displayName));
        await issueSession(reply, account);
        // The one unauthenticated endpoint that writes a user row, so it is the one a script
        // would point at to fill the users table. The rate limit is what stops that; this is what
        // makes it investigable afterwards. NO DISPLAY NAME is recorded — it is text the learner
        // typed, and `redactDetail` would censor it anyway.
        recordSecurityAudit({ event: 'auth.guest.created', userId: account.id }, (message, detail) => {
          request.log.warn({ ...detail }, message);
        });
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
    app.post('/auth/logout', async (request, reply) => {
      // Read before the session is destroyed; afterwards there is nothing to attribute it to.
      const userId = request.session === null ? null : request.session.user.id;
      await destroySession(reply);
      // Only when there was a session to end. A logout by a caller who had none is idempotent by
      // design (see above) and is not an event — recording it would fill the audit log with the
      // retries and lost cookies it exists to make legible.
      if (userId !== null) {
        recordSecurityAudit({ event: 'auth.session.revoked', userId }, (message, detail) => {
          request.log.warn({ ...detail }, message);
        });
      }
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
      {
        config: oidcRateLimit,
        // Both budgets guard the start: the failed-outcome one because a start can fail against
        // the provider, and the unredeemed one because a start that SUCCEEDS is the whole of what
        // a start flood produces.
        preHandler: [refuseWhenFailing, refuseWhenTooManyUnredeemed],
        onResponse: chargeFailedOutcome,
        schema: { querystring: { $ref: 'prl:oidcStartQuery#' } },
      },
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
        // Charged HERE, next to the row it counts, and only once that row exists — a start that
        // threw on the way to the provider wrote nothing and is the failed-outcome budget's
        // business, not this one's. The matching credit is in the callback below.
        oidcUnredeemedStarts.charge(addressRateLimitKey(request, config));

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
      {
        config: oidcRateLimit,
        // Only the failed-outcome budget. A callback REDEEMS an attempt row rather than writing
        // one, so refusing it for having too many outstanding would be refusing the one request
        // that reduces them.
        preHandler: refuseWhenFailing,
        onResponse: chargeFailedOutcome,
        schema: { querystring: { $ref: 'prl:oidcCallbackQuery#' } },
      },
      async (request, reply) => {
        const party = requireRelyingParty(relyingParty);
        const query = request.query;
        // Cleared unconditionally and early: the attempt is over either way, and a cookie left
        // behind after a failure is a PKCE verifier sitting in a browser for another ten minutes.
        reply.clearCookie(oidcCookieName(config), sessionCookieOptions(config));

        /**
         * RFC 9207, and the reason it exists.
         *
         * A client registered with more than one provider can be induced into a mix-up: the
         * attacker starts a flow at provider A, and returns a code minted by A to this client's
         * callback while the client believes it is talking to B. The client then sends A's code
         * to B's token endpoint, and with some provider pairs that is an account takeover. The
         * `state` cookie does not close it, because the attacker can start a genuine flow to get
         * a genuine `state`.
         *
         * Checked before anything else touches the callback, and before the attempt is consumed,
         * so a mismatched issuer cannot burn a legitimate single-use attempt row.
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
        // The attempt row this flow wrote has been redeemed, so the start that wrote it was not
        // abandoned and must not count against the address as though it were. Credited only after
        // `issueSession`, because up to that line the sign-in could still have failed.
        oidcUnredeemedStarts.credit(addressRateLimitKey(request, config));
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

    /**
     * `POST /me/delete` — the learner leaves, and takes their record with them.
     *
     * ## What this does, exactly, and what it deliberately does not
     *
     *   DELETED       every session; every lesson marked read; every quiz attempt; every
     *                 scenario attempt; every seat at every table, live or long departed.
     *   ANONYMISED    the learner's seat in every hand they played, the audit-log entries
     *                 naming them, and the tables they created. The identity is removed; the
     *                 row stays.
     *   RETAINED      every hand, in full — the actions, the board, the commitment root and the
     *                 reveal proofs. A hand is a shared record. The other seats belong to other
     *                 people, it is in their history, and deleting it would edit theirs. This is
     *                 the one thing a learner might not expect, so the response says so in
     *                 counts and `apps/web/src/app/record/DeleteAccount.tsx` says so in words
     *                 BEFORE they confirm rather than after.
     *   TABLES        a table the learner created is closed and loses its owner. It is not
     *                 deleted: `prl.hands` cascades from `prl.rooms`, so deleting the table
     *                 would delete everybody else's hands with it.
     *
     * That is a description of engineering behaviour and not a legal conclusion; nothing here
     * should be read as one. `db/migrations/0004_account_deletion.sql` argues each choice.
     *
     * ## The shape of the request
     *
     * A confirmation phrase in the body, checked by `prl:deleteAccountBody` before this handler
     * runs, because the operation cannot be undone and a bare `POST` is something a mis-wired
     * client, a replayed submission or a double-tapped button can produce by accident. The CSRF
     * layer already covers the cross-site case; this covers our own client.
     *
     * ## The order of the three steps, which is the part worth reading
     *
     *   1. `requireSession` — 401 before anything else, and it is what identifies WHOSE account
     *      is at stake. There is no user id in the path or the body, so this route cannot be
     *      aimed at somebody else.
     *   2. the erasure, in one transaction, which revokes every session as part of itself.
     *   3. `destroySession` — clears the cookie. It runs AFTER the transaction has committed,
     *      never before: clearing first would leave a browser signed out of an account that a
     *      failed transaction had left completely intact.
     *
     * `destroySession` also tries to revoke the caller's session row, which by now does not
     * exist; `sessions.revoke` answers false for a row it cannot find, so that is a no-op rather
     * than an error. The cookie is cleared regardless, which is the half that matters here.
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
        // Null means the row had already gone — a retry of a request whose answer never arrived,
        // or a guest swept between the session read and this statement. The cookie is still
        // cleared and the answer is still 401, because "there is no such account" and "you are
        // not signed in" are the same fact from out here, and inventing a success with zero
        // counts would tell the learner an erasure ran when none did.
        if (deleted === null) {
          await destroySession(reply);
          throw new AppError('not_authenticated', {
            logDetail: 'account deletion found no such account; the session outlived its user row',
          });
        }
        // No user id, no display name, no counts. The counts are the learner's own and belong in
        // the response; a log line saying how many hands somebody had played on their way out is
        // a record of the person who asked to have no record.
        request.log.info({ userKind: session.user.kind }, 'account erased at the learner request');
        // Recorded with a NULL user id, and that is the whole point rather than an oversight.
        // `audit_log.user_id` is ON DELETE SET NULL, so the row would be detached a moment later
        // anyway; writing it detached from the start means the audit log never briefly holds a
        // pointer to an account that asked to stop existing. What survives is that an erasure
        // happened and when — which is what an operator needs to answer "did it run?" — and
        // nothing that names who asked.
        recordSecurityAudit({ event: 'auth.account.deleted', userId: null }, (message, detail) => {
          request.log.warn({ ...detail }, message);
        });
        await destroySession(reply);
        return deleted;
      },
    );
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

      /**
       * The only binding here that opens a transaction, because it is the only one that has to.
       *
       * `sql.begin` rather than `withTransaction` from `db.ts`: that helper reaches for the
       * process-wide pool through `getSql()`, and every other method in this store runs on the
       * `sql` handle it was given. A store bound to one handle that quietly used a different one
       * for its most destructive operation would be a trap for whoever next writes a test against
       * a transaction of their own.
       *
       * The boxing is the same trick `withTransaction` documents at length: `begin` is typed
       * `UnwrapPromiseArray<T>`, so a callback returning an array comes back with a different
       * type from one returning an object, and wrapping the value makes the return type
       * unconditional.
       */
      deleteAccount: async (userId) => {
        const boxed = await sql.begin(async (tx) => ({
          value: await usersRepository.deleteAccount(tx, userId),
        }));
        const summary = boxed.value;
        if (summary === null) return null;
        // Re-shaped rather than returned whole: the repository's summary also carries the user
        // id, the number of sessions revoked and the number of tables closed, and none of those
        // are the learner's business. The wire type is the contract, and it is narrower.
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
