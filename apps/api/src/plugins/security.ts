/**
 * The security layer: headers, cookies, CSRF, CORS, rate limiting, cache policy.
 *
 * Hook order is instance `onRequest` (context, helmet, cookies, CORS), route `onRequest` (rate limit),
 * body parsing (`bodyLimit`), `preValidation` (CSRF), then validation and handler.
 * Hooks that answer before the route limiter call it by hand through `countRequest`, so CORS
 * refusals, preflights and bad-CSRF 404s are counted (`test/security-uncounted-requests.test.ts`).
 * One deliberate exception. `refuseNonNavigationOidc` in `routes/auth.ts` refuses cross-site
 * subresource loads of the OIDC GETs uncounted, because counting them lets any page spend a campus
 * address's sign-in ceiling.
 * Session state is not handled here. Only the session cookie's name and attributes are defined.
 */

import { timingSafeEqual, type webcrypto } from 'node:crypto';
import type { CookieSerializeOptions } from '@fastify/cookie';
import cookie from '@fastify/cookie';
import csrfProtection from '@fastify/csrf-protection';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
  FastifyServerOptions,
} from 'fastify';
import type { AppConfig } from '../config.ts';
import { AppError, apiErrorBody, rateLimitError } from '../errors.ts';
import { recordSecurityAudit } from '../observability/telemetry.ts';
import { ResettableRateLimitStore, resetAllRateLimitCounters } from './rate-limit-store.ts';
import { clientKeyFor, hashWithKey } from './request-context.ts';

/**
 * Type shim. Delete when no longer needed. `@fastify/csrf@8.1.0` types an option as the DOM
 * `CryptoKey`, which `@types/node` declares only as a value, so its `.d.ts` raises TS2749 under
 * `lib: ["ES2024"]` and `skipLibCheck: false`.
 */
declare global {
  interface CryptoKey extends webcrypto.CryptoKey {}
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Spread into a route's `config` to apply the stricter limit. */
    expensiveRateLimit: { readonly rateLimit: { readonly max: number; readonly timeWindow: number } };
  }
}

/**
 * Module scope so the WebSocket hub can call `isAllowedOrigin` without configuration.
 * Empty until the plugin registers, so the check fails closed. Two apps with different
 * `PUBLIC_WEB_ORIGIN` values in one process would overwrite each other.
 */
let allowedOrigins: ReadonlySet<string> = new Set<string>();

/** Exported for tests that need the check without an app. */
export function configureAllowedOrigins(origins: readonly string[]): void {
  allowedOrigins = new Set(origins.map((origin) => origin.toLowerCase()));
}

/**
 * Exact match only, shared by CORS and the WebSocket upgrade. A suffix test accepts
 * `evil-example.com`. A literal `null` origin is always rejected.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === '' || origin === 'null') return false;
  return allowedOrigins.has(origin.toLowerCase());
}

const SESSION_COOKIE_BASE = 'prl_session';
const CSRF_COOKIE_BASE = 'prl_csrf';

/**
 * `__Host-` in production, which the browser enforces as `Secure`, `Path=/` and no `Domain`, so a
 * sibling subdomain cannot plant a session cookie. Not in development, where `Secure` on
 * `http://localhost` is unreliable.
 */
export function sessionCookieName(config: AppConfig): string {
  return config.isProduction ? `__Host-${SESSION_COOKIE_BASE}` : SESSION_COOKIE_BASE;
}

export function csrfCookieName(config: AppConfig): string {
  return config.isProduction ? `__Host-${CSRF_COOKIE_BASE}` : CSRF_COOKIE_BASE;
}

/**
 * The one definition of the session cookie's attributes.
 * `sameSite: 'lax'`, not `'strict'`, because the OIDC callback is a cross-site top-level navigation
 * and a `Strict` cookie would fail every sign-in as `oidc_state_mismatch`. The residual risk is
 * covered because no GET changes state and every mutating method requires the CSRF header.
 * `signed`, so a modified cookie is rejected before any lookup.
 */
export function sessionCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    signed: true,
  };
}

/** `lax` for the same OIDC reason, or the token would have nothing to verify against on return. */
function csrfCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    signed: true,
  };
}

/**
 * Everything denied. The API returns only JSON, so `default-src 'none'` is accurate, with
 * `frame-ancestors`, `base-uri` and `form-action` closed too. The web app has its own nonce-based
 * policy on its own origin.
 */
const API_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  formAction: ["'none'"],
  frameAncestors: ["'none'"],
  scriptSrc: ["'none'"],
  styleSrc: ["'none'"],
  imgSrc: ["'none'"],
  fontSrc: ["'none'"],
  connectSrc: ["'none'"],
  mediaSrc: ["'none'"],
  objectSrc: ["'none'"],
  workerSrc: ["'none'"],
  manifestSrc: ["'none'"],
};

/** One year. `preload` is off because the preload list is effectively irreversible. */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

/**
 * CORS by hand, since adding `@fastify/cors` is release-blocking. Origins are reflected only from
 * the allowlist, with credentials, never `*`.
 */
const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_REQUEST_HEADERS = 'content-type, x-csrf-token';
/** Without this, client code cannot read `x-request-id` or `retry-after`. */
const EXPOSED_HEADERS =
  'x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset';
/** 10 minutes. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** `reply.header('vary', ...)` overwrites, and a clobbered `Vary: Origin` is a cache-poisoning bug. */
function appendVary(reply: FastifyReply, token: string): void {
  const existing = reply.getHeader('vary');
  if (typeof existing !== 'string' || existing === '') {
    reply.header('vary', token);
    return;
  }
  const present = existing
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .includes(token.toLowerCase());
  if (!present) reply.header('vary', `${existing}, ${token}`);
}

function applyCorsHeaders(reply: FastifyReply, origin: string): void {
  reply.header('access-control-allow-origin', origin);
  reply.header('access-control-allow-credentials', 'true');
  reply.header('access-control-expose-headers', EXPOSED_HEADERS);
  appendVary(reply, 'Origin');
}

/**
 * `applyCors` sends nothing itself, so its caller can run the rate limiter before answering.
 * `preflightAllowed` answers 204, `preflightRefused` answers 403, `refuse` throws `forbidden`.
 */
type CorsOutcome = 'continue' | 'preflightAllowed' | 'preflightRefused' | 'refuse';

/**
 * No `Origin`: nothing to say (but `Vary: Origin` is still set). A preflight is answered here,
 * since there is no `OPTIONS` route. A disallowed origin gets no CORS headers, and a mutating
 * request from one is refused, otherwise the side effect would still happen.
 */
function applyCors(request: FastifyRequest, reply: FastifyReply): CorsOutcome {
  appendVary(reply, 'Origin');
  const origin = request.headers.origin;
  const isPreflight =
    request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;

  if (typeof origin !== 'string') {
    // No browser sends a preflight without an Origin.
    return isPreflight ? 'preflightRefused' : 'continue';
  }

  const allowed = isAllowedOrigin(origin);
  if (allowed) applyCorsHeaders(reply, origin);

  if (isPreflight) {
    if (!allowed) return 'preflightRefused';
    reply.header('access-control-allow-methods', ALLOWED_METHODS);
    reply.header('access-control-allow-headers', ALLOWED_REQUEST_HEADERS);
    reply.header('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS));
    appendVary(reply, 'Access-Control-Request-Headers');
    return 'preflightAllowed';
  }

  return !allowed && MUTATING_METHODS.has(request.method) ? 'refuse' : 'continue';
}

/**
 * `request.cookies` is typed as always present but is `null` until the cookie plugin's hook runs.
 * An unguarded read throws in `onSend` and Fastify's fallback serializer leaks the error message.
 */
function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const jar: { [key: string]: string | undefined } | null = request.cookies;
  return jar === null ? undefined : jar[name];
}

/**
 * Session first, hashed address second, so one NAT is not punished for one caller and discarding a
 * cookie does not reset the limit. The cookie value is hashed because it is a credential.
 * The signature is checked first. Measured with raw cookies, 60 requests rotating a garbage cookie
 * got zero 429s against a limit of 3. An unsigned cookie is keyed on its address.
 * Genuine cookies can still be rotated, but each costs a `POST /auth/guest`, address-limited to ten a minute.
 * Exported for `rate-limit-isolation.test.ts`.
 */
export function rateLimitKeyFor(request: FastifyRequest, config: AppConfig): string {
  const secret = config.sessionCookieSecret;
  const raw = cookieValue(request, sessionCookieName(config));
  if (typeof raw === 'string' && raw !== '') {
    const unsigned = request.unsignCookie(raw);
    if (unsigned.valid && unsigned.value !== null) {
      // The unsigned value, so a re-signed cookie with the same token keeps its bucket.
      return `s:${hashWithKey(secret, 'ratelimit-session', unsigned.value)}`;
    }
  }
  return `c:${clientRateLimitKey(request, config)}`;
}

/** Never the raw address. */
function clientRateLimitKey(request: FastifyRequest, config: AppConfig): string {
  const secret = config.sessionCookieSecret;
  return request.clientKey === '' ? clientKeyFor(secret, request.ip) : request.clientKey;
}

/**
 * The address key `clientKeyedRateLimit` uses, for the `OutcomeBudget`s in `routes/auth.ts`, so
 * they bucket callers identically. It has no `a:` prefix. Each budget is its own `Map`, so no
 * namespace is shared.
 */
export function addressRateLimitKey(request: FastifyRequest, config: AppConfig): string {
  return clientRateLimitKey(request, config);
}

/**
 * Keyed on the client address, ignoring the session. Required for any route that issues a session,
 * because a client keeping each new cookie presents a fresh key. Measured on `POST /auth/guest`:
 * 60 creations, zero 429s. Freezing the cookie gave a 429 after 6.
 * For OIDC this ceiling is cohort-sized, and the tight limit is the `OutcomeBudget`s in `routes/auth.ts`.
 */
export function clientKeyedRateLimit(
  config: AppConfig,
  max: number,
  timeWindowMs: number,
): {
  readonly rateLimit: {
    readonly max: number;
    readonly timeWindow: number;
    readonly keyGenerator: (request: FastifyRequest) => string;
  };
} {
  return {
    rateLimit: {
      max,
      timeWindow: timeWindowMs,
      keyGenerator: (request: FastifyRequest) => `a:${clientRateLimitKey(request, config)}`,
    },
  };
}

/** Under `_test/` so every log, proxy rule and WAF signature shows what it is. */
export const RATE_LIMIT_RESET_PATH = '/api/v1/_test/rate-limit/reset';

/** Constant-time. Length is compared first because `timingSafeEqual` throws on unequal lengths. */
function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token === '' ? null : token;
}

/**
 * Absent unless a token is configured, and `config.ts` refuses that in production.
 * Constant-time token check. Every accepted reset logs at `warn`. Not exempt from the rate limit,
 * so the token cannot be guessed without limit.
 * ORDERING: call AFTER `registerErrorHandlers`, since Fastify binds a route's error handler when the
 * route is added. Called earlier, its refusals used Fastify's error shape instead of `ApiError`.
 */
export function registerRateLimitResetRoute(app: FastifyInstance, config: AppConfig): void {
  const token = config.rateLimitResetToken;
  if (token === null) return;

  app.post(RATE_LIMIT_RESET_PATH, (request, reply) => {
    const provided = bearerToken(request);
    if (provided === null || !secretsMatch(token, provided)) {
      request.log.warn({ path: RATE_LIMIT_RESET_PATH }, 'rate-limit reset refused: bad or missing token');
      // 401, since no credential was accepted.
      return reply.status(401).send(apiErrorBody('not_authenticated', request.id));
    }
    const cleared = resetAllRateLimitCounters();
    request.log.warn({ cleared }, 'rate-limit counters were reset by the test control');
    return reply.send({ cleared });
  });

  app.log.warn(
    { path: RATE_LIMIT_RESET_PATH },
    'the rate-limit reset control is registered; this process must not serve real users',
  );
}

/** Options Fastify takes only at construction. `app.ts` spreads them in. */
export function securityServerOptions(config: AppConfig): FastifyServerOptions {
  return {
    // FST_ERR_CTP_BODY_TOO_LARGE maps to `payload_too_large`.
    bodyLimit: config.bodyLimitBytes,
    // Enforced by Node, so a timeout is a socket-level 408 with no ApiError body.
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
    // Drops idle keep-alive sockets on `app.close()`. Not sufficient alone. It runs once, so a
    // socket mid-request is never revisited. `server.ts` keeps sweeping (`drainIdleConnections`,
    // `test/shutdown.test.ts`).
    forceCloseConnections: 'idle',
    // Fastify 5 defaults, stated anyway. A body with `__proto__` or `constructor` is rejected.
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    // The request id is ours, never the caller's (`plugins/request-context.ts`).
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    routerOptions: {
      // Our id patterns cap at 64 characters.
      maxParamLength: 64,
      // A backtracking route pattern is a denial of service in the router.
      allowUnsafeRegex: false,
    },
  };
}

export interface SecurityPluginOptions {
  readonly config: AppConfig;
}

/** `skip-override` (see `request-context.ts`), so hooks land on the caller's instance. */
export const securityPlugin: FastifyPluginAsync<SecurityPluginOptions> = async (app, options) => {
  const { config } = options;
  configureAllowedOrigins(config.webOrigins);

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: { ...API_CSP_DIRECTIVES } },
    // An API URL can contain a room or hand id.
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' },
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xDnsPrefetchControl: { allow: false },
    // Cross-origin isolation, for the day a route returns a document by accident. CORP does not block
    // the web app's credentialed CORS `fetch`, since it applies only to `no-cors` requests.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    originAgentCluster: true,
    // Production only, or `localhost` is pinned to https for a year.
    strictTransportSecurity: config.isProduction
      ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: false }
      : false,
  });

  // Before the CORS hook, so its hand-run limiter sees the signed session and uses the same bucket
  // as the route limiter rather than the shared address bucket.
  await app.register(cookie, {
    secret: config.sessionCookieSecret,
    // The default, stated so a dependency bump cannot silently change it.
    algorithm: 'sha256',
    hook: 'onRequest',
  });

  /** The library store in production. The resettable one lets the smoke test run twice in a row. */
  const resettableStore = config.rateLimitResetToken === null ? undefined : ResettableRateLimitStore;

  /**
   * `onBanReach` fires on every request past the ban threshold, not once. Undeduplicated, a flood
   * turned each refusal into a log line, a metric and an un-awaited audit INSERT. This map records
   * one ban per (key, window), and is swept once it passes the threshold because keys are caller-derived.
   */
  const bansRecordedUntil = new Map<string, number>();
  const BAN_SWEEP_THRESHOLD = 1_024;

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: config.rateLimit.globalWindowMs,
    ...(resettableStore === undefined ? {} : { store: resettableStore }),
    // Past this far over the limit the caller is banned (still `rate_limited`).
    // `0` does NOT disable banning. The library treats only negative values as off, and `config.ts`
    // bounds the variable at 0, so `0` bans every request past the limit.
    ban: config.rateLimit.banAfter,
    hook: 'onRequest',
    keyGenerator: (request) => rateLimitKeyFor(request, config),
    // Fail open if the store errors. The in-memory store cannot, but a shared store could, and
    // during such a failure there is no rate limit.
    skipOnError: true,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    onBanReach: (request, key) => {
      const now = Date.now();
      if (bansRecordedUntil.size > BAN_SWEEP_THRESHOLD) {
        for (const [seen, until] of bansRecordedUntil) {
          if (until <= now) bansRecordedUntil.delete(seen);
        }
      }
      const recordedUntil = bansRecordedUntil.get(key);
      // Already recorded this window. The log line is skipped too, since it amplifies the same way.
      if (recordedUntil !== undefined && recordedUntil > now) return;
      bansRecordedUntil.set(key, now + config.rateLimit.globalWindowMs);

      request.log.warn({ rateLimitKey: key }, 'rate-limit ban threshold reached');
      // Audited because a ban means `Retry-After` was ignored. The key is not recorded, being
      // address-derived. The route is, and it is the first route crossed in the window.
      recordSecurityAudit(
        { event: 'security.rate_limit.banned', detail: { route: request.routeOptions.url ?? null } },
        (message, detail) => {
          request.log.warn({ ...detail }, message);
        },
      );
      // The key is not a label (unbounded, identifying). One increment per (key, window), so this
      // counts banned callers. `kind="exceeded"` counts requests.
      app.appMetrics.rateLimitEvents.inc({ kind: 'banned' });
    },
    // Built from `AppError`, so `retryAfterSeconds` and `Retry-After` come from one number.
    errorResponseBuilder: (_request, context) => rateLimitError(context.ttl / 1000),
  });

  app.decorate('expensiveRateLimit', {
    rateLimit: { max: config.rateLimit.expensiveMax, timeWindow: config.rateLimit.expensiveWindowMs },
  });

  /**
   * The route limiter, called by hand from hooks that would otherwise answer before it.
   * Measured before the fix, 50 rejected-`Origin` POSTs, 50 rejected preflights and 50 bad-CSRF POSTs to
   * missing paths all got 403 with the bucket still empty.
   * Safe because `@fastify/rate-limit` counts a request once, so a route's stricter limit that already
   * ran stands. Never call it on the `continue` path, which would take the global limiter's turn
   * and disable every per-route limit.
   */
  const countRequest = app.rateLimit();

  app.addHook('onRequest', async (request, reply) => {
    const outcome = applyCors(request, reply);
    if (outcome === 'continue') return;
    // Everything below answers from this hook, so it is counted first. A 429 replaces the CORS answer.
    await countRequest.call(app, request, reply);
    if (outcome === 'refuse') {
      throw new AppError('forbidden', {
        logDetail: `cross-origin ${request.method} from an origin that is not allowlisted`,
      });
    }
    if (outcome === 'preflightRefused') {
      reply.header('cache-control', 'no-store');
      return reply.status(403).send(apiErrorBody('forbidden', request.id));
    }
    // Accepted preflights are counted too. The cost is one count per `PREFLIGHT_MAX_AGE_SECONDS`.
    return reply.status(204).send();
  });

  await app.register(csrfProtection, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: csrfCookieName(config),
    cookieOpts: csrfCookieOptions(config),
    /**
     * `x-csrf-token` only, no body form, so the check runs before validation. A cross-site page
     * cannot set a custom header without a preflight, and only allowlisted origins pass one.
     */
    getToken: (request) => {
      const header = request.headers['x-csrf-token'];
      return typeof header === 'string' ? header : undefined;
    },
  });

  /**
   * Mutating methods only. No GET changes state, and the OIDC redirect and plain links cannot carry
   * a header. The WebSocket upgrade cannot carry one either, so the hub checks `isAllowedOrigin`.
   * `countRequest` runs first because the not-found limiter is a later `preHandler`. On existing
   * routes it is a no-op.
   * Callback-style on purpose. `@fastify/csrf-protection` answers a failure without calling `next`,
   * so a promise wrapper would never settle and would leak one per failed request.
   */
  app.addHook('preValidation', (request, reply, done) => {
    if (!MUTATING_METHODS.has(request.method)) {
      done();
      return;
    }
    countRequest.call(app, request, reply).then(
      () => {
        app.csrfProtection(request, reply, done);
      },
      // The limiter's `rate_limited`, not a bad-token answer.
      (error: unknown) => {
        done(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  /**
   * `no-store` unless a route set otherwise, and always when a session cookie was sent, so a
   * personalised response is never held by a shared cache.
   */
  const sessionCookie = sessionCookieName(config);
  app.addHook('onSend', (request, reply, _payload, done) => {
    const authenticated = cookieValue(request, sessionCookie) !== undefined;
    if (authenticated) {
      reply.header('cache-control', 'no-store');
      appendVary(reply, 'Cookie');
    } else if (reply.getHeader('cache-control') === undefined) {
      reply.header('cache-control', 'no-store');
    }
    done();
  });
};

Object.defineProperty(securityPlugin, Symbol.for('skip-override'), { value: true });
