/**
 * The only place that turns the `prl_session` cookie into an identity, mints one or destroys one.
 * Guest-first. No cookie means `request.session === null`. A route is private only when it calls
 * `requireSession()`, so there is no allowlist of public routes to get wrong.
 * SQL and token hashing live in `src/repositories/sessions.ts`, so plaintext never reaches a query.
 * The idle window slides past halfway but never beyond `created_at + SESSION_ABSOLUTE_TTL_SECONDS`.
 */

import type { CookieSerializeOptions } from '@fastify/cookie';
import type { UserKind } from '@prl/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.ts';
import { AppError } from '../errors.ts';
import { sessionCookieName, sessionCookieOptions } from '../plugins/security.ts';
import { hashIp, hashUserAgent } from '../repositories/hashing.ts';
import { SESSION_TTL_SECONDS } from '../repositories/sessions.ts';

/** Derived from `SESSION_TTL_SECONDS` so this module and the stored row agree on the TTL. */
export const SESSION_IDLE_TTL_MS = SESSION_TTL_SECONDS * 1_000;

/** Hard ceiling from creation. Without it a stolen cookie that stays in use never expires. */
export const SESSION_ABSOLUTE_TTL_SECONDS = 60 * 24 * 60 * 60;

/** Slide only past this fraction of the idle window, so it writes at most once per half window. */
export const SESSION_REFRESH_AFTER = 0.5;

/**
 * Not the contract's `SessionUser`, whose `units` needs an aggregate over live seats that most
 * requests never read.
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
  /**
   * The row's `expires_at`. A WebSocket is authenticated once at the upgrade, so `ws/hub.ts` uses
   * this to bound the socket by the credential's lifetime.
   */
  readonly expiresAt: Date;
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
 * Session persistence, with `sql` bound. Every method is total, so logout stays idempotent and a
 * failed slide never fails a request.
 */
export interface SessionStore {
  /**
   * Takes the plaintext token and hashes it in the repository. Returns `null` for unknown, expired
   * and revoked alike.
   */
  readonly findValidByToken: (token: string) => Promise<StoredSession | null>;
  readonly create: (userId: string, fingerprints: SessionFingerprints) => Promise<IssuedSession>;
  /** Slides `expires_at` out, bounded by the absolute ceiling. `null` when nothing moved. */
  readonly extendExpiry: (sessionId: string) => Promise<Date | null>;
  readonly revoke: (sessionId: string) => Promise<boolean>;
  /**
   * Keeps an active guest out of `maintenance/retention-sweep.ts`. The sweep reads live sessions
   * directly, so writing this only when a session slides cannot cost anybody their account.
   */
  readonly touchLastSeen: (userId: string) => Promise<boolean>;
}

/**
 * `unknown` covers expired, revoked and fictional, which the store does not distinguish.
 * A `null` rejection means no cookie was presented.
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

/** The idle window is constant, so `expiresAt` alone locates the refresh point. */
export function shouldRefresh(nowMs: number, expiresAt: Date): boolean {
  return nowMs >= expiresAt.getTime() - SESSION_IDLE_TTL_MS * SESSION_REFRESH_AFTER;
}

/** Attributes come from `sessionCookieOptions` only. `maxAge` tracks the server-side expiry. */
function cookieOptions(config: AppConfig, expiresAt: Date): CookieSerializeOptions {
  const remainingMs = expiresAt.getTime() - Date.now();
  return { ...sessionCookieOptions(config), maxAge: Math.max(1, Math.floor(remainingMs / 1_000)) };
}

function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(sessionCookieName(config), sessionCookieOptions(config));
}

/**
 * `request.cookies` is typed as present but is `null` until `@fastify/cookie`'s `onRequest` hook
 * runs, so a request answered by an earlier hook would throw.
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

/**
 * One session, or every session an account holds. Account erasure revokes all sessions inside its
 * transaction and never learns their ids.
 */
export interface SessionRevocation {
  readonly sessionId?: string;
  readonly userId?: string;
}

/**
 * Listeners for "a session stopped being honoured". A WebSocket resolves its session once, at the
 * upgrade, so without these a logout, an erasure or a second sign-in would leave the socket live.
 * Polling instead would cost a query per socket per interval. Module scope is safe because session
 * ids are unique.
 */
const revocationListeners = new Set<(revocation: SessionRevocation) => void>();

/**
 * Returns the unsubscribe, which callers MUST use. A leftover listener keeps a closed hub's router
 * alive and closes sockets through it.
 */
export function onSessionRevoked(listener: (revocation: SessionRevocation) => void): () => void {
  revocationListeners.add(listener);
  return () => revocationListeners.delete(listener);
}

/**
 * Call only AFTER the store write commits, or a failed revocation signs somebody out of a live
 * session. A throwing listener must not fail the revoking request.
 */
export function noteSessionRevoked(revocation: SessionRevocation): void {
  for (const listener of [...revocationListeners]) {
    try {
      listener(revocation);
    } catch {
      // This module has no logger, and every listener handles its own errors.
    }
  }
}

/** Always mints a new token and revokes any previous session, which prevents session fixation. */
export async function issueSession(reply: FastifyReply, user: SessionAccount): Promise<void> {
  const request = reply.request;
  const app = reply.server;
  const config = app.appConfig;
  const store = app.sessionStore;

  const previous = request.session;
  if (previous !== null) {
    await store.revoke(previous.sessionId);
    noteSessionRevoked({ sessionId: previous.sessionId });
  }

  const issued = await store.create(user.id, fingerprintsFor(request, config.sessionCookieSecret));
  reply.setCookie(sessionCookieName(config), issued.token, cookieOptions(config, issued.expiresAt));

  request.session = { sessionId: issued.sessionId, user, expiresAt: issued.expiresAt };
  request.sessionRejection = null;
  // No token, user id or display name in the log.
  request.log.info({ userKind: user.kind }, 'session issued');
}

/**
 * Idempotent. The cookie is cleared even with no session, so a stale one stops being resent.
 */
export async function destroySession(reply: FastifyReply): Promise<void> {
  const request = reply.request;
  const session = request.session;
  if (session !== null) {
    await reply.server.sessionStore.revoke(session.sessionId);
    noteSessionRevoked({ sessionId: session.sessionId });
  }
  clearSessionCookie(reply, request.server.appConfig);
  request.session = null;
  request.sessionRejection = null;
}

interface Resolution {
  readonly session: ResolvedSession | null;
  readonly rejection: SessionRejection | null;
  /** True whenever a cookie was presented and refused, so it should stop being resent. */
  readonly clear: boolean;
  /** Carries the plaintext token so the cookie can be re-sent with a new `Max-Age`. Never logged. */
  readonly refresh: { readonly token: string; readonly sessionId: string; readonly userId: string } | null;
}

const NO_SESSION: Resolution = { session: null, rejection: null, clear: false, refresh: null };

function refused(rejection: SessionRejection): Resolution {
  return { session: null, rejection, clear: true, refresh: null };
}

async function resolveSession(request: FastifyRequest, store: SessionStore): Promise<Resolution> {
  const config = request.server.appConfig;
  const raw = rawCookie(request, sessionCookieName(config));
  // Guest-first. Nothing presented is not a rejection.
  if (raw === undefined || raw === '') return NO_SESSION;

  // Check the signature before any query, so a forged cookie cannot make the database do work.
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid) return refused('malformed');

  const found = await store.findValidByToken(unsigned.value);
  if (found === null) return refused('unknown');

  return {
    session: { sessionId: found.sessionId, user: found.user, expiresAt: found.expiresAt },
    rejection: null,
    clear: false,
    refresh: shouldRefresh(Date.now(), found.expiresAt)
      ? { token: unsigned.value, sessionId: found.sessionId, userId: found.user.id }
      : null,
  };
}

/**
 * Both rejections log at `warn`, since `LOG_LEVEL` defaults to `info` and `debug` would hide them.
 * `malformed` is an HMAC this server did not produce (tampering, another deployment, a rotated secret).
 * `unknown` is a signed cookie with no live session. The store cannot split expiry from revocation.
 * The cookie is cleared on refusal, so each dead cookie logs once, and a burst is the signal.
 * Distinct messages let a log query separate the two without knowing field names.
 */
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
 * `preHandler`, not `onRequest`, so the rate limit, CSRF check and schema validation all run before
 * the session lookup costs a query (`docs/ARCHITECTURE.md` §13).
 * `skip-override` is required. Without it the hook silently applies only to routes registered inside
 * this plugin, which is none. Registration is idempotent.
 * Not `async` because it awaits nothing, and lint rejects an `async` function with no `await`.
 */
export const sessionPlugin: FastifyPluginAsync<SessionPluginOptions> = (app, options) => {
  if (app.hasRequestDecorator('session')) return Promise.resolve();

  // Primitive defaults keep the properties on the shared Request prototype. Fastify 5 rejects reference ones.
  app.decorateRequest('session', null);
  app.decorateRequest('sessionRejection', null);
  app.decorate('sessionStore', options.store);

  app.addHook('preHandler', async (request, reply) => {
    const outcome = await resolveSession(request, options.store);
    request.session = outcome.session;
    request.sessionRejection = outcome.rejection;

    if (outcome.clear) {
      // Otherwise the browser resends the dead cookie on every request, each costing a lookup.
      clearSessionCookie(reply, request.server.appConfig);
      logRefusedCookie(request, outcome.rejection);
      return;
    }

    const refresh = outcome.refresh;
    if (refresh === null) return;

    // A failed slide must not fail the request. The cookie is re-sent only after the row moves, so the
    // browser never holds a later expiry than the server honours.
    try {
      const expiresAt = await options.store.extendExpiry(refresh.sessionId);
      if (expiresAt === null) return;
      await options.store.touchLastSeen(refresh.userId);
      // The WebSocket upgrade bounds the socket by `request.session.expiresAt`, so it moves with the row.
      const current = request.session;
      if (current !== null) request.session = { ...current, expiresAt };
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
 * `session_expired` when a cookie this server signed resolves to nothing, so the client knows to open
 * a fresh guest session. `not_authenticated` otherwise. Both are 401.
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
