/**
 * Sessions: a signed cookie in, a user or nobody out.
 *
 * This module is the only place that turns the `prl_session` cookie into an identity, and the
 * only place that mints or destroys one. Everything else reads `request.session`.
 *
 * ## Guest-first, so "nobody" is not an error
 *
 * Most of this API is readable without signing in — lessons, the glossary, an equity
 * calculation. So the hook below resolves the session and then gets out of the way: no cookie
 * means `request.session === null`, and that is a perfectly ordinary state, not a 401. Only a
 * handler that genuinely needs an account calls `requireSession()`, and only that call throws.
 * Doing it the other way round — a hook that rejects anonymous requests, with an allowlist of
 * public routes — fails in the dangerous direction, because a public route added by somebody
 * who did not read the allowlist becomes an accidental 401 while a new *private* route added
 * the same way becomes an accidental hole.
 *
 * ## What this module does and does not know
 *
 * It does not know SQL, and it does not hash the session token. Both belong to
 * `src/repositories/sessions.ts`, which mints the token, stores `sha256(token)`, and hands the
 * plaintext back exactly once — so a plaintext credential can never reach a query parameter
 * from here. What this module owns is the cookie, the sliding expiry policy, and the shape of
 * `request.session`.
 *
 * `SessionStore` is that repository's four operations with the `sql` handle already bound. The
 * repository functions take `sql` first; `src/routes/auth.ts` binds it once. That indirection is
 * what lets every test in `test/auth.test.ts` run with no database at all — the fake store is a
 * `Map`.
 *
 * ## Sliding expiry, and why it has a ceiling
 *
 * A fixed fourteen-day expiry signs somebody out mid-hand on day fourteen with no warning. A
 * purely sliding expiry never signs anybody out at all, which turns one stolen cookie into
 * permanent access. So: the idle window slides — a request past the halfway mark pushes
 * `expires_at` out and re-sends the cookie — but never past `created_at + SESSION_ABSOLUTE_TTL`.
 * An active learner is not interrupted, an idle one still expires, and no session lives forever.
 *
 * The refresh happens on a `GET`, which means a read can write. That is deliberate and bounded:
 * it only happens once the session is past halfway, so it is at most one row update per session
 * per half-window, not one per request. (The one wart: a session sitting at the absolute ceiling
 * re-attempts the update on each request and matches no row. That is an index probe, not a
 * write, and it is the price of the ceiling.)
 */

import type { CookieSerializeOptions } from '@fastify/cookie';
import type { UserKind } from '@prl/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { sessionCookieName, sessionCookieOptions } from '../plugins/security.ts';
import { hashIp, hashUserAgent } from '../repositories/hashing.ts';
import { SESSION_TTL_SECONDS } from '../repositories/sessions.ts';

// ---------------------------------------------------------------------------
// Lifetimes
// ---------------------------------------------------------------------------

/**
 * The idle window, in milliseconds.
 *
 * Derived from the repository's `SESSION_TTL_SECONDS` rather than restated, because "halfway
 * through its life" is meaningless if this module's idea of the TTL and the one the row was
 * written with ever drift apart.
 */
export const SESSION_IDLE_TTL_MS = SESSION_TTL_SECONDS * 1_000;

/**
 * Hard ceiling from creation, whatever the activity.
 *
 * Sliding expiry with no ceiling means a stolen cookie stays valid forever provided the thief
 * keeps using it, which is precisely the property an attacker wants. Sixty days is generous for
 * a play-money learning app and still finite.
 */
export const SESSION_ABSOLUTE_TTL_SECONDS = 60 * 24 * 60 * 60;

/**
 * When the slide happens, as a fraction of the idle window.
 *
 * Halfway is the usual trade-off: refreshing on every request writes a row per request, and
 * refreshing only near the end signs out anybody whose clock or proxy cache is slightly behind.
 */
export const SESSION_REFRESH_AFTER = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The identity half of a session, as the hook attaches it.
 *
 * Deliberately *not* `SessionUser` from the contract: that carries `units`, and units are
 * derived from a learner's live seats (there is no column — see the header of
 * `src/repositories/users.ts`). Running that aggregate on every request, including the many
 * that never look at it, would be a real cost for no reader. The endpoints that do report units
 * compose the full `SessionUser` themselves.
 */
export interface SessionAccount {
  readonly id: string;
  readonly kind: UserKind;
  readonly displayName: string;
  /** ISO-8601, because that is what crosses the wire. */
  readonly createdAt: string;
}

/** What `request.session` holds when somebody is signed in. */
export interface ResolvedSession {
  readonly sessionId: string;
  readonly user: SessionAccount;
}

/** A live session and its account, as the store returns them. */
export interface StoredSession {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly user: SessionAccount;
}

/** A session that has just been opened. The token exists here and nowhere else. */
export interface IssuedSession {
  readonly sessionId: string;
  readonly token: string;
  readonly expiresAt: Date;
}

/** Keyed digests of the request's fingerprints, or null when there is nothing to hash. */
export interface SessionFingerprints {
  readonly ipHash: Buffer | null;
  readonly userAgentHash: Buffer | null;
}

/**
 * Session persistence, with `sql` already bound.
 *
 * Every method is total. A lookup that finds nothing returns `null`, revoking an unknown id is
 * `false` rather than an error, and extending an expiry that cannot move returns `null` — because
 * `POST /auth/logout` is idempotent by contract and a failed slide must never fail a request.
 */
export interface SessionStore {
  /**
   * Resolves a *plaintext* cookie token. The digest is computed inside the repository, which is
   * what keeps a plaintext token out of every query parameter in the codebase.
   *
   * Returns `null` for unknown, expired and revoked alike — one query, three indistinguishable
   * answers. That is the repository's deliberate design and this module does not try to undo it.
   */
  readonly findValidByToken: (token: string) => Promise<StoredSession | null>;
  readonly create: (userId: string, fingerprints: SessionFingerprints) => Promise<IssuedSession>;
  /** Slides `expires_at` out, bounded by the absolute ceiling. `null` when nothing moved. */
  readonly extendExpiry: (sessionId: string) => Promise<Date | null>;
  readonly revoke: (sessionId: string) => Promise<boolean>;
  /** Keeps an active learner out of the guest-account sweep. */
  readonly touchLastSeen: (userId: string) => Promise<boolean>;
}

/**
 * Why the presented cookie was not accepted.
 *
 * Only two values, and that is the store's doing rather than an omission here: a session that is
 * expired, revoked or fictional all resolve to the same `null`, so `unknown` covers all three.
 *
 * `null` (the absence of a rejection) means the caller presented nothing at all, which is the
 * guest case and not a rejection.
 */
export type SessionRejection = 'malformed' | 'unknown';

declare module 'fastify' {
  interface FastifyRequest {
    /** The resolved session, or `null` for an anonymous reader. Set by `sessionPlugin`. */
    session: ResolvedSession | null;
    /** Why a presented cookie was refused, or `null` if none was presented. */
    sessionRejection: SessionRejection | null;
  }

  interface FastifyInstance {
    /** Session persistence. Decorated by `sessionPlugin`. */
    sessionStore: SessionStore;
  }
}

// ---------------------------------------------------------------------------
// Pure policy (unit-tested directly; no Fastify, no database)
// ---------------------------------------------------------------------------

/**
 * Whether this request should slide the session forward.
 *
 * `expiresAt` is enough to answer it, because the idle window is a constant: a session issued or
 * last slid at time `t` expires at `t + SESSION_IDLE_TTL_MS`, so halfway is
 * `expiresAt - SESSION_IDLE_TTL_MS / 2`. No `created_at` is needed on this side, which is the
 * reason `findValidByToken` does not have to return one.
 */
export function shouldRefresh(nowMs: number, expiresAt: Date): boolean {
  return nowMs >= expiresAt.getTime() - SESSION_IDLE_TTL_MS * SESSION_REFRESH_AFTER;
}

/**
 * Cookie attributes plus a lifetime.
 *
 * The attribute set comes from `sessionCookieOptions` and is not restated here — `httpOnly`,
 * `secure`, `sameSite`, `path` and `signed` are decided once, in `plugins/security.ts`, and a
 * second copy is a second thing to get wrong. `maxAge` is *added* rather than redefined: it is
 * not a security attribute but the session's own lifetime, which this module owns, and it has to
 * track the sliding expiry so the browser drops the cookie at roughly the moment the server
 * stops honouring it.
 */
function cookieOptions(config: AppConfig, expiresAt: Date): CookieSerializeOptions {
  const remainingMs = expiresAt.getTime() - Date.now();
  return { ...sessionCookieOptions(config), maxAge: Math.max(1, Math.floor(remainingMs / 1_000)) };
}

/** Clears the cookie using the one definition of its attributes. */
function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(sessionCookieName(config), sessionCookieOptions(config));
}

/**
 * Cookie value, tolerating a jar that has not been populated.
 *
 * `request.cookies` is *typed* as always present but is `null` until `@fastify/cookie`'s
 * `onRequest` hook runs, so the tidy-looking `request.cookies[name]` throws a `TypeError` on any
 * request answered by an earlier hook. Same guard, same reason, as `plugins/security.ts`.
 */
function rawCookie(request: FastifyRequest, name: string): string | undefined {
  const jar: { [key: string]: string | undefined } | null = request.cookies;
  return jar === null ? undefined : jar[name];
}

/** The optional request fingerprints, hashed. Absent headers stay absent rather than becoming ''. */
export function fingerprintsFor(request: FastifyRequest, secret: string): SessionFingerprints {
  const agent = request.headers['user-agent'];
  return {
    ipHash: hashIp(secret, request.ip),
    userAgentHash: hashUserAgent(secret, typeof agent === 'string' ? agent : undefined),
  };
}

// ---------------------------------------------------------------------------
// Issue and destroy
// ---------------------------------------------------------------------------

/**
 * Mints a session for `user`, sets the cookie, and attaches it to the current request.
 *
 * Always a brand-new token, never a reused one: carrying a token across a privilege change is
 * session fixation, and the attacker-known value from before the change keeps working after it.
 * Any session the caller already had is revoked first, so signing in twice does not leave a live
 * credential nobody is watching.
 */
export async function issueSession(reply: FastifyReply, user: SessionAccount): Promise<void> {
  const request = reply.request;
  const app = reply.server;
  const config = app.appConfig;
  const store = app.sessionStore;

  const previous = request.session;
  if (previous !== null) await store.revoke(previous.sessionId);

  const issued = await store.create(user.id, fingerprintsFor(request, config.sessionCookieSecret));
  reply.setCookie(sessionCookieName(config), issued.token, cookieOptions(config, issued.expiresAt));

  request.session = { sessionId: issued.sessionId, user };
  request.sessionRejection = null;
  // No token, no user id, no display name. `logging.ts` would censor the first and third anyway,
  // and the request log line already carries enough to correlate.
  request.log.info({ userKind: user.kind }, 'session issued');
}

/**
 * Revokes the caller's session and clears the cookie.
 *
 * Idempotent, because `POST /auth/logout` is idempotent by contract: with no session there is
 * nothing to revoke, and the cookie is cleared regardless so a stale or unknown one stops being
 * resent on every subsequent request.
 */
export async function destroySession(reply: FastifyReply): Promise<void> {
  const request = reply.request;
  const session = request.session;
  if (session !== null) await reply.server.sessionStore.revoke(session.sessionId);
  clearSessionCookie(reply, request.server.appConfig);
  request.session = null;
  request.sessionRejection = null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Resolution {
  readonly session: ResolvedSession | null;
  readonly rejection: SessionRejection | null;
  /** True whenever a cookie was presented and refused, so it should stop being resent. */
  readonly clear: boolean;
  /**
   * Set when the session is live and past halfway.
   *
   * Carries the plaintext token because the cookie has to be re-sent with a new `Max-Age`, and
   * re-reading and re-unsigning it would be the same work twice. A local value that never leaves
   * this module and is never logged.
   */
  readonly refresh: { readonly token: string; readonly sessionId: string; readonly userId: string } | null;
}

const NO_SESSION: Resolution = { session: null, rejection: null, clear: false, refresh: null };

function refused(rejection: SessionRejection): Resolution {
  return { session: null, rejection, clear: true, refresh: null };
}

/** The whole decision, with no side effects, so it can be read in one place. */
async function resolveSession(request: FastifyRequest, store: SessionStore): Promise<Resolution> {
  const config = request.server.appConfig;
  const raw = rawCookie(request, sessionCookieName(config));
  // Guest-first: nothing presented is not a rejection.
  if (raw === undefined || raw === '') return NO_SESSION;

  // The signature is checked before anything else touches the value, so a tampered or
  // foreign-signed cookie is refused without a query. Without this, a forged cookie would be a
  // way to make the database do work on demand.
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid) return refused('malformed');

  const found = await store.findValidByToken(unsigned.value);
  if (found === null) return refused('unknown');

  return {
    session: { sessionId: found.sessionId, user: found.user },
    rejection: null,
    clear: false,
    refresh: shouldRefresh(Date.now(), found.expiresAt)
      ? { token: unsigned.value, sessionId: found.sessionId, userId: found.user.id }
      : null,
  };
}

/**
 * Records a refused cookie at a level somebody will actually see.
 *
 * ## Why this is not `debug`
 *
 * It was, and that made the whole class invisible: `LOG_LEVEL` defaults to `info`, so a wave of
 * forged or dead cookies — the shape of both a credential-replay attempt and a botched secret
 * rotation — produced nothing at all in a production log. A security control whose activations
 * are unobservable is a control nobody can tell is working.
 *
 * ## The two rejections, and why both are `warn`
 *
 * `malformed` is a cookie whose HMAC this server did not produce. Page script cannot forge one,
 * so it is either a tampered value, a cookie from another deployment, or this deployment after a
 * `SESSION_COOKIE_SECRET` rotation. None of those is ordinary traffic.
 *
 * `unknown` is a cookie this server DID sign that no longer resolves to a live session. Ordinary
 * expiry lands here, and ordinary expiry is exactly the thing that should stay at `debug` — but
 * there is nothing to attach that rule to: `SessionStore.findValidByToken` returns `null` for
 * expired, revoked and fictional alike, deliberately (see its doc comment), so `unknown` is the
 * union of all three and this module cannot tell them apart. Splitting them means returning the
 * reason from `src/repositories/sessions.ts`, which is a change to a different file.
 *
 * So `unknown` is kept at `warn`, and the reason it does not drown the signal is a property of
 * the code above rather than an assumption: the cookie is CLEARED on refusal, so one dead cookie
 * produces one line and never another, and `maxAge` tracks the session's own expiry, so a
 * compliant browser stops sending an expired cookie without ever reaching this hook. What is left
 * is one line per genuinely dead cookie — a burst of which is the signal, not the noise.
 *
 * The cost, stated: a secret rotation or a guest-account sweep produces a burst of these once.
 * That is a burst an operator should see.
 *
 * The two are logged under different messages rather than distinguished only by a field, so a
 * log query can separate "somebody is presenting cookies we never signed" from "somebody is
 * presenting dead ones" without knowing this module's field names.
 */
// `rejection` is typed nullable because `Resolution` is, but `clear` is only ever set alongside a
// rejection — see `refused` — so the null case is unreachable today and lands on the general
// branch, which is the safe reading if that ever changes.
function logRefusedCookie(request: FastifyRequest, rejection: SessionRejection | null): void {
  if (rejection === 'malformed') {
    request.log.warn({ sessionRejection: rejection }, 'session cookie refused: signature is not ours');
    return;
  }
  request.log.warn({ sessionRejection: rejection }, 'session cookie refused: no live session');
}

export interface SessionPluginOptions {
  readonly store: SessionStore;
}

/**
 * Attaches session resolution to every route in the scope it is registered on.
 *
 * ## Why `preHandler` and not `onRequest`
 *
 * `onRequest` runs *before* the route-level rate limit (`@fastify/rate-limit` attaches itself per
 * route, and route hooks run after instance hooks) and before the CSRF check. Resolving the
 * session there would give an unauthenticated flood a database lookup each before anything could
 * refuse it. `preHandler` runs after the limiter, after CSRF and after schema validation — which
 * is the order `docs/ARCHITECTURE.md` §13 documents — so by the time this hook costs a query the
 * request has already survived everything cheaper.
 *
 * ## Why `skip-override`
 *
 * Same reason as `requestContextPlugin` and `securityPlugin`: without it Fastify gives this
 * plugin a fresh child scope, and the hook and decorators would apply only to routes registered
 * *inside* this plugin — which is none of them. That failure is silent, which is why it is
 * spelled out here rather than left as a one-word symbol.
 *
 * Registration is idempotent, so a route module registering it after the root instance already
 * has is a no-op rather than a second hook doing the same lookup twice. Every route module that
 * wants `request.session` should register it; the tidier end state is one registration at the
 * root, and this is written so that both work.
 */
// Not declared `async` even though the type is `FastifyPluginAsync`: registering hooks and
// decorators awaits nothing, and an `async` function with no `await` in it is a lint error here
// (rightly — it usually means a missing one). Same shape, same reason, as `requestContextPlugin`.
export const sessionPlugin: FastifyPluginAsync<SessionPluginOptions> = (app, options) => {
  if (app.hasRequestDecorator('session')) return Promise.resolve();

  // Primitive defaults, so the properties live on the shared Request prototype instead of being
  // added per request. Fastify 5 rejects reference-type defaults here for exactly that reason;
  // `null` is accepted and is the honest starting value for both.
  app.decorateRequest('session', null);
  app.decorateRequest('sessionRejection', null);
  app.decorate('sessionStore', options.store);

  app.addHook('preHandler', async (request, reply) => {
    const outcome = await resolveSession(request, options.store);
    request.session = outcome.session;
    request.sessionRejection = outcome.rejection;

    if (outcome.clear) {
      // Clearing matters: a browser holding a dead cookie would otherwise resend it on every
      // request forever, and every one of those costs a lookup.
      clearSessionCookie(reply, request.server.appConfig);
      logRefusedCookie(request, outcome.rejection);
      return;
    }

    const refresh = outcome.refresh;
    if (refresh === null) return;

    // A failed slide must not fail the request: the session is valid until its current expiry, so
    // the right behaviour is to carry on and try again next time. Note the ordering — the cookie
    // is only re-sent *after* the row moves, so the browser is never told a later expiry than the
    // server will honour.
    try {
      const expiresAt = await options.store.extendExpiry(refresh.sessionId);
      if (expiresAt === null) return;
      await options.store.touchLastSeen(refresh.userId);
      const config = request.server.appConfig;
      reply.setCookie(sessionCookieName(config), refresh.token, cookieOptions(config, expiresAt));
    } catch (error) {
      request.log.warn({ err: error }, 'sliding session expiry could not be written');
    }
  });

  return Promise.resolve();
};

Object.defineProperty(sessionPlugin, Symbol.for('skip-override'), { value: true });

/**
 * The session, or a refusal.
 *
 * `not_authenticated` when nothing was presented or the cookie was not ours. `session_expired`
 * when a cookie that *this server signed* no longer resolves to a live session — which is almost
 * certainly what it says, because the alternative explanations (a forged token that happened to
 * beat HMAC-SHA256, a swept row) are not reachable in practice. Neither answer leaks anything:
 * both are 401, and the caller was holding the cookie in the first place. What it buys is a
 * client that knows to open a fresh guest session rather than showing a dead end.
 */
export function requireSession(request: FastifyRequest): ResolvedSession {
  const session = request.session;
  if (session !== null) return session;
  if (request.sessionRejection === 'unknown') {
    throw new AppError('session_expired', { logDetail: 'a signed session cookie resolved to nothing' });
  }
  throw new AppError('not_authenticated', {
    logDetail:
      request.sessionRejection === null ? 'no session cookie presented' : 'session cookie was not ours',
  });
}
