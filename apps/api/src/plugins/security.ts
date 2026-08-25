/**
 * The security layer: headers, cookies, CSRF, CORS, rate limiting, cache policy.
 *
 * Everything in this file is one of two things: a header that tells the browser to
 * enforce something, or a check that refuses a request the browser was willing to send.
 * The comments say *why* for each, because a security header nobody understands is a
 * security header the next person deletes to fix a bug.
 *
 * ## Hook order, which is the part that is easy to get wrong
 *
 * Fastify runs instance-level hooks before route-level hooks, and `@fastify/rate-limit`
 * attaches itself per route (via `onRoute`). So an instance-level `onRequest` CSRF check
 * would run *before* the rate limiter, and a caller could send unlimited requests that
 * fail CSRF without ever being counted.
 *
 * The order below is therefore deliberate:
 *
 *   1. `onRequest` (instance)  — request context, helmet headers, cookies, CORS / preflight.
 *   2. `onRequest` (route)     — rate limit. First thing that can cost a caller anything.
 *   3. body parsing            — bounded by `bodyLimit`.
 *   4. `preValidation`         — CSRF. After the limiter, before schema validation, so a
 *                                cross-site caller learns "not verified" rather than a
 *                                field-by-field description of our schema.
 *   5. validation, handler.
 *
 * ## Where that ordering was not enough, and what was done about it
 *
 * The invariant above is about the ORDER of the hooks, and the order alone does not deliver it.
 * Anything answered from an INSTANCE hook is answered before stage 2 has run, and anything
 * answered at stage 4 is answered before a route whose limiter is a `preHandler` — which the
 * not-found route's is. Four request classes were therefore refused without ever being counted:
 * a CORS-refused mutating request, a rejected preflight, an ACCEPTED preflight, and a `POST` to
 * a nonexistent path with a bad CSRF token. Measured: 50 of each returned 403 with the caller's
 * bucket still empty afterwards. Responses are cheap on all four paths — no body parse, no
 * database — so this was amplification rather than a knockout, but it was unbounded and it was
 * the property this comment claimed.
 *
 * All four now call the limiter by hand before they answer, via `countRequest` below. The library
 * counts a request once, so nothing is double-counted and no route's stricter limit is displaced.
 * `test/security-uncounted-requests.test.ts` holds each class, with the controls that show the
 * limiter is what refused them.
 *
 * ## What is NOT here
 *
 * Sessions and authentication. This plugin defines the session cookie's *attributes* and
 * nothing else — no reading, writing or validating of session state. That belongs to the
 * auth module, which imports `sessionCookieName` and `sessionCookieOptions` from here so
 * that the attributes exist in exactly one place.
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
 * A type shim, not a feature. Delete it the moment it stops being necessary.
 *
 * `@fastify/csrf@8.1.0` — a transitive dependency of `@fastify/csrf-protection` — types one
 * of its options as `CryptoKey`. That is a DOM global: `@types/node` declares `CryptoKey`
 * only as a *value* (`web-globals/crypto.d.ts`), never as a type, and this repo compiles
 * with `lib: ["ES2024"]`, `types: ["node"]` and `skipLibCheck: false`. The result is a
 * TS2749 raised inside a dependency's own `.d.ts`, which no amount of care in our own
 * source can route around.
 *
 * Declaring the missing global *type* here fixes the reference without adding a
 * dependency, without loosening the compiler for the whole repo, and without editing
 * `node_modules`. Structurally it is the WebCrypto key type, which is exactly what the
 * dependency means by it.
 */
declare global {
  interface CryptoKey extends webcrypto.CryptoKey {}
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Route config fragment applying the stricter limit. Spread into a route's `config`:
     *
     * ```ts
     * app.post('/api/v1/equity', { config: app.expensiveRateLimit, schema }, handler);
     * ```
     */
    expensiveRateLimit: { readonly rateLimit: { readonly max: number; readonly timeWindow: number } };
  }
}

// ---------------------------------------------------------------------------
// Origins
// ---------------------------------------------------------------------------

/**
 * The allowlist, held at module scope so that `isAllowedOrigin` can be imported by the
 * WebSocket hub without threading configuration through it.
 *
 * It starts empty, which means `isAllowedOrigin` returns false until the plugin has been
 * registered. That is the correct direction to fail: an unconfigured check that rejects
 * everything is a broken deployment, while one that accepts everything is a vulnerability
 * that nobody notices.
 *
 * The trade-off of module scope: a process that built two apps with *different*
 * `PUBLIC_WEB_ORIGIN` values would have the second overwrite the first. A server process only
 * ever builds one, and a test that builds several uses the same allowlist — but if that ever
 * stops being true, this becomes per-instance state and the hub gets it from the instance.
 */
let allowedOrigins: ReadonlySet<string> = new Set<string>();

/** Called by the plugin. Exported for tests that need the check without a whole app. */
export function configureAllowedOrigins(origins: readonly string[]): void {
  allowedOrigins = new Set(origins.map((origin) => origin.toLowerCase()));
}

/**
 * Exact-match origin check, shared by CORS and the WebSocket upgrade.
 *
 * Exact match, never a prefix or suffix test. `origin.endsWith('example.com')` also
 * accepts `evil-example.com`, and `origin.startsWith('https://app.example.com')` also
 * accepts `https://app.example.com.evil.test`. Both mistakes are common enough to be
 * worth naming here.
 *
 * A literal `null` origin — a sandboxed iframe, a `file://` page, some redirect chains —
 * is rejected. There is no way to tell a friendly null origin from a hostile one.
 */
export function isAllowedOrigin(origin: string): boolean {
  if (origin === '' || origin === 'null') return false;
  return allowedOrigins.has(origin.toLowerCase());
}

// ---------------------------------------------------------------------------
// The session cookie, defined once
// ---------------------------------------------------------------------------

const SESSION_COOKIE_BASE = 'prl_session';
const CSRF_COOKIE_BASE = 'prl_csrf';

/**
 * The session cookie's name.
 *
 * `__Host-` in production. The prefix is enforced by the browser: a cookie whose name
 * starts with it is rejected unless it is `Secure`, has `Path=/`, and has **no `Domain`
 * attribute**. That last part is the reason to want it. Without the prefix, any code that
 * can set a cookie on a sibling subdomain — a takeover of a forgotten `docs.` host, a
 * stray CNAME — can plant a session cookie for the parent domain, and cookie-shadowing
 * attacks like that are invisible from the server side.
 *
 * Not in development, because the prefix also requires `Secure`, and whether a browser
 * accepts a `Secure` cookie over `http://localhost` still varies. A cookie that silently
 * fails to set is a bad first hour for a new contributor.
 */
export function sessionCookieName(config: AppConfig): string {
  return config.isProduction ? `__Host-${SESSION_COOKIE_BASE}` : SESSION_COOKIE_BASE;
}

export function csrfCookieName(config: AppConfig): string {
  return config.isProduction ? `__Host-${CSRF_COOKIE_BASE}` : CSRF_COOKIE_BASE;
}

/**
 * Session cookie attributes. The one definition; do not write these inline anywhere.
 *
 * - `httpOnly`: script cannot read it, so an XSS bug cannot exfiltrate the session in a
 *   single line. It does not stop an XSS bug from *using* the session, which is why the
 *   CSP above it is strict.
 * - `secure`: never sent over plaintext. Refused at boot if it cannot be set in
 *   production (see `config.ts`).
 * - `sameSite: 'lax'` and not `'strict'`: the OIDC provider finishes the flow by
 *   redirecting the browser to `GET /api/v1/auth/oidc/callback`. That is a *cross-site
 *   top-level navigation*, and a `Strict` cookie is not sent on one — so the `state`
 *   cookie written before the redirect would be invisible on return and every single
 *   sign-in would fail as `oidc_state_mismatch`. `Lax` sends cookies on top-level GET
 *   navigations and withholds them from cross-site POSTs and subresource loads, which is
 *   precisely the line we want. The residual risk — a cross-site GET navigation carrying
 *   the session — is covered by two other rules: no GET in this API changes state, and
 *   every method that does changes state requires the CSRF header.
 * - `path: '/'`: required by `__Host-`, and there is no narrower path that helps.
 * - no `domain`: forbidden by `__Host-`, and undesirable anyway (see above).
 * - `signed`: tamper-evident. A modified cookie is rejected before any lookup.
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

/**
 * CSRF secret cookie attributes.
 *
 * Same reasoning as the session cookie, and deliberately the same `sameSite` value: a
 * `Strict` CSRF cookie would be missing on the OIDC return navigation for the same reason,
 * and the token would then have nothing to verify against.
 */
function csrfCookieOptions(config: AppConfig): CookieSerializeOptions {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    signed: true,
  };
}

// ---------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------

/**
 * The API's own CSP: everything denied.
 *
 * This server returns JSON. It has no scripts, no styles, no images and no frames, so
 * `default-src 'none'` with every fetch directive spelled out is not a compromise — it is
 * the accurate description of what these responses need. There is no `unsafe-inline` and
 * no `unsafe-eval` anywhere, and there is nothing to relax them for.
 *
 * `frame-ancestors 'none'` (plus helmet's `X-Frame-Options: DENY` for older browsers)
 * stops any page from framing an API response, and `base-uri`/`form-action 'none'` close
 * the two directives people forget: without them, an HTML injection that reaches a
 * browser can still retarget relative URLs or post a form somewhere else.
 *
 * ## What the web app will need (it is NOT this policy)
 *
 * `apps/web` is a separate Next.js origin with its own headers. Its policy will need
 * roughly:
 *
 *   default-src 'none';
 *   script-src 'self' 'nonce-<per-response>';   // Next's inline bootstrap needs a nonce,
 *                                               // never 'unsafe-inline'
 *   style-src 'self' 'nonce-<per-response>';
 *   img-src 'self' data:;                       // data: for inline card SVGs
 *   font-src 'self';
 *   connect-src 'self' <api origin> <wss api origin>;
 *   base-uri 'none'; form-action 'self'; frame-ancestors 'none';
 *
 * The nonce must be generated per response and never reused. If a nonce turns out to be
 * hard to thread through, the answer is to move the inline code into a file, not to add
 * `unsafe-inline`.
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

/** One year. Long enough to matter; `preload` is left off on purpose (see below). */
const HSTS_MAX_AGE_SECONDS = 31_536_000;

// ---------------------------------------------------------------------------
// CORS, by hand
// ---------------------------------------------------------------------------

/**
 * `@fastify/cors` is not a dependency of this app and adding one is release-blocking, so
 * CORS is implemented here as two hooks. That is not a hardship: the whole policy is
 * "reflect an origin from the allowlist, allow credentials, never wildcard", which is
 * about twenty lines, and writing it out means the one dangerous combination is visible
 * rather than hidden in an option object.
 *
 * The dangerous combination: `Access-Control-Allow-Origin: *` together with
 * `Access-Control-Allow-Credentials: true`. Browsers reject that pair, so a server that
 * sets it has no working CORS *and* looks like it intended to allow everyone — and the
 * usual "fix" is to reflect whatever `Origin` arrives, which allows every site on the
 * internet to make credentialed requests. Reflection here only ever happens for an origin
 * that is already in the allowlist.
 */
const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_REQUEST_HEADERS = 'content-type, x-csrf-token';
/**
 * Headers a browser is permitted to read from the response. Without this list, client
 * code cannot see `x-request-id` (so a user cannot quote it in a bug report) or
 * `retry-after` (so a client cannot back off correctly).
 */
const EXPOSED_HEADERS =
  'x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset';
/** 10 minutes. Long enough to spare the preflights, short enough that policy edits land. */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

const MUTATING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Adds a token to `Vary` without discarding what is already there.
 *
 * `reply.header('vary', ...)` overwrites, and a response whose body depends on `Origin`
 * but whose `Vary` was clobbered is a cache-poisoning bug: one origin's response gets
 * served to another.
 */
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
 * What the caller of `applyCors` must do next.
 *
 * - `continue`: carry on with the request.
 * - `preflightAllowed`: answer 204; the headers are already on the reply.
 * - `preflightRefused`: answer 403 with the contract's error body.
 * - `refuse`: reject the request with `forbidden`.
 *
 * `applyCors` used to send the two preflight answers itself and report `answered`. It no longer
 * sends anything, and that is the whole of the fix for the second and third of the three request
 * classes this file's header promised were counted and were not: the caller has to run the rate
 * limiter BEFORE the reply goes out, and it cannot do that if the reply has already gone.
 */
type CorsOutcome = 'continue' | 'preflightAllowed' | 'preflightRefused' | 'refuse';

/**
 * The CORS decision.
 *
 * Three cases, in order:
 *
 * 1. No `Origin` header — a same-origin request, a server-to-server call, or curl. There is
 *    nothing for CORS to say, so nothing is said. (`Vary: Origin` is still set, because the
 *    *absence* of the header changes the response.)
 * 2. A preflight (`OPTIONS` carrying `Access-Control-Request-Method`). Answered here rather
 *    than by a route, because there is no `OPTIONS` route to match and Fastify would return a
 *    404, which no browser accepts as permission.
 * 3. A real request with an `Origin`. Allowed origins get the headers. Disallowed origins get
 *    no CORS headers — which stops the browser handing the *response* to the caller — and, if
 *    the method is state-changing, the request is refused outright. That second part matters:
 *    without it the side effect still happens and only the reading of the result is blocked.
 *    It also gives a strict origin check that stands on its own, independently of the CSRF
 *    token.
 */
function applyCors(request: FastifyRequest, reply: FastifyReply): CorsOutcome {
  appendVary(reply, 'Origin');
  const origin = request.headers.origin;
  const isPreflight =
    request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;

  if (typeof origin !== 'string') {
    // A preflight with no Origin is malformed — no browser sends one. Refuse rather than
    // guess. Anything else without an Origin is same-origin or not a browser, and needs
    // no CORS headers at all.
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

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/**
 * Reads a cookie, tolerating the case where the cookie plugin has not run.
 *
 * `@fastify/cookie` populates `request.cookies` from its own `onRequest` hook and leaves the
 * property as `null` until then. It is *typed* as always present, so `request.cookies[name]`
 * looks safe and throws a TypeError on any request answered by an earlier hook. That crash then
 * surfaces from `onSend`, at which point Fastify's last-resort serializer takes over and puts the
 * raw error message into the response body. In other words: the tidy-looking version of this line
 * leaks internal detail on exactly the requests the security layer rejected. Hence the guard.
 *
 * The cookie plugin now registers BEFORE the CORS hook, so the three cases this comment used to
 * name — a preflight, a rejected origin, a 429 — all have a parsed jar today. The guard stays
 * because the hooks that still run earlier (`request-context.ts`, helmet) can answer a request
 * too, and because "which hook runs first" is exactly the kind of fact that changes underneath a
 * line like this one. It has changed once already.
 */
function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const jar: { [key: string]: string | undefined } | null = request.cookies;
  return jar === null ? undefined : jar[name];
}

/**
 * The rate-limit bucket for a request.
 *
 * Session first, hashed address second. Keying on address alone punishes everyone behind one
 * NAT or one campus proxy for the behaviour of one of them; keying on session alone lets
 * anyone reset their limit by discarding a cookie. Session-when-present,
 * address-otherwise takes the useful half of each.
 *
 * The session cookie's value is hashed rather than used directly. It is a credential, and
 * `@fastify/rate-limit` keeps keys in an in-memory cache and hands them to `onBanReach` for
 * logging — neither of which should ever hold something that can be replayed.
 *
 * ## The signature is checked FIRST, and that check is the whole limiter
 *
 * This function used to hash the raw cookie string straight out of `request.cookies`, which is
 * whatever the caller sent. `@fastify/cookie` parses cookies; it does not verify them, and
 * unsigning is a separate call that happens much later, at session resolution. So the bucket was
 * chosen by a string the caller invents, and rate limiting was optional for anybody who noticed:
 * send `prl_session=1`, then `prl_session=2`, and every request is the first request in a fresh
 * bucket. Measured before the fix: 60 requests with a rotating garbage cookie, **zero** 429s,
 * against a configured limit of 3. The same trick emptied the expensive limiter that guards
 * `POST /math/equity`, which accepts up to 500,000 Monte Carlo samples per call.
 *
 * `resolveSession` in `auth/session.ts` already had this exactly right, and says why in its own
 * comment: "a forged cookie would be a way to make the database do work on demand". The limiter
 * is the same problem one layer earlier, so it gets the same answer — an unsigned or
 * foreign-signed cookie is not a session, and a request carrying one is keyed on its address
 * like any other anonymous caller.
 *
 * What this leaves, stated because it is the real bound: a caller can still obtain genuine
 * signed cookies and rotate those. Each one costs a `POST /auth/guest`, which is address-keyed
 * by `clientKeyedRateLimit` below at ten per minute, so the number of buckets one address can
 * hold is bounded by that limiter rather than by the caller's imagination. That is the trade the
 * session-preferring key was always meant to make.
 *
 * Exported for `rate-limit-isolation.test.ts`, which asserts the preference directly. Doing it
 * over HTTP would need a route that is rate-limited AND does not resolve a session, and there is
 * no such route — a valid cookie reaches the session store, which is the whole point of it.
 */
export function rateLimitKeyFor(request: FastifyRequest, config: AppConfig): string {
  const secret = config.sessionCookieSecret;
  const raw = cookieValue(request, sessionCookieName(config));
  if (typeof raw === 'string' && raw !== '') {
    const unsigned = request.unsignCookie(raw);
    if (unsigned.valid && unsigned.value !== null) {
      // The UNSIGNED value, not the raw string: it is the stable identity of the session, so a
      // re-signed cookie carrying the same token lands in the same bucket.
      return `s:${hashWithKey(secret, 'ratelimit-session', unsigned.value)}`;
    }
  }
  return `c:${clientRateLimitKey(request, config)}`;
}

/** The address-derived bucket, hashed. Never the raw address. */
function clientRateLimitKey(request: FastifyRequest, config: AppConfig): string {
  const secret = config.sessionCookieSecret;
  return request.clientKey === '' ? clientKeyFor(secret, request.ip) : request.clientKey;
}

/**
 * The address key, for anything that has to bucket a caller the same way `clientKeyedRateLimit`
 * does without being a `@fastify/rate-limit` route config.
 *
 * `routes/auth.ts` holds a second, tighter budget alongside the OIDC route limits — one spent by
 * FAILED sign-in outcomes rather than by requests (`plugins/failed-outcome-budget.ts`). It has to
 * bucket callers identically to the limiter it sits beside, and the way to guarantee that is to
 * call the same function rather than to write a second one that happens to agree today. The
 * prefix differs (`f:` there, `a:` here) because the two counters are separate; the identity they
 * are counting is the same one.
 */
export function addressRateLimitKey(request: FastifyRequest, config: AppConfig): string {
  return clientRateLimitKey(request, config);
}

/**
 * A rate limit keyed on the CLIENT ADDRESS, ignoring the session cookie entirely.
 *
 * `rateLimitKeyFor` prefers the session because address-only keying punishes everyone behind one
 * NAT for the behaviour of one of them. That preference is right for ordinary routes and wrong —
 * dangerously so — for any route that *issues* a session.
 *
 * The hole, which a smoke test against the running server found rather than any unit test:
 * `POST /auth/guest` mints a new session and sets a new cookie. A client that keeps the cookie it
 * was just handed therefore presents a DIFFERENT rate-limit key on its next request, so the
 * counter never accumulates and the declared 10-per-minute limit never fires. Measured: 60
 * consecutive guest creations, zero 429s. Freezing the cookie instead produced a 429 after 6,
 * which is what proved the key rotation was the cause rather than a missing config.
 *
 * The attacker does not even have to be clever here. Rotating the key is the *natural* behaviour
 * of a client that creates accounts, because the endpoint hands it a fresh identity every time.
 *
 * So session-minting routes key on the address. That much has not changed and must not: it is the
 * only key on these routes that accumulates at all.
 *
 * What HAS changed is what used to be written here — that the NAT cost was "a mild inconvenience".
 * It was not. Measured against the shipped defaults: thirty learners behind one address, signing
 * in through the identity provider at the start of a class, got FIFTEEN sign-ins through and
 * fifteen 429s, the first at learner sixteen. Half a paying cohort refused on its first
 * interaction with the product is not an inconvenience, it is the product failing.
 *
 * The fix is not a bigger number here — that would hand a script the same headroom. It is that the
 * routes above this one now carry two budgets: a cohort-sized ceiling counted by this function,
 * and a much tighter budget counted by `FailedOutcomeBudget` that only a FAILED outcome spends.
 * `routes/auth.ts` argues the split, states what it costs and states what it does not cost.
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

// ---------------------------------------------------------------------------
// The rate-limit reset control (never present in production)
// ---------------------------------------------------------------------------

/**
 * Where the reset control lives when it exists at all.
 *
 * Under `/api/v1` like everything else, and under `_test/` so that the name says what it is
 * at every place a path appears — an access log, a proxy rule, a WAF signature. A control
 * named `/admin/` invites somebody to decide it is a legitimate operations endpoint and
 * enable it somewhere real.
 */
export const RATE_LIMIT_RESET_PATH = '/api/v1/_test/rate-limit/reset';

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `===` on strings short-circuits at the first differing byte, so the time it takes reveals
 * how many leading characters a guess got right — enough to recover a token one character at
 * a time over a network. `timingSafeEqual` requires equal-length buffers and throws
 * otherwise, so the lengths are compared first (which is not itself a secret worth hiding:
 * an attacker can vary length freely and learn it from the response either way).
 */
function secretsMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads a bearer token from an `Authorization` header, or null. */
function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return null;
  const token = header.slice(prefix.length).trim();
  return token === '' ? null : token;
}

/**
 * Registers the reset control, when — and only when — a token is configured.
 *
 * Three properties this has to have, and they are the reason it is a function rather than
 * four lines inline:
 *
 * 1. **Absent by default.** With no token the route is never added, so an unconfigured
 *    process does not merely refuse the call, it has nowhere to make it. `config.ts` makes
 *    a production process carrying the variable refuse to boot, so "no token" is the only
 *    state production can be in.
 * 2. **Authenticated, in constant time.** See `secretsMatch`.
 * 3. **Loud.** Every accepted reset logs at `warn` with the number of counters discarded.
 *    A control that empties a security mechanism must leave a trace even when it is used
 *    exactly as intended, so that its use during an incident is visible in the same place
 *    the incident is.
 *
 * The route is deliberately NOT exempt from the rate limit. It is authenticated, so the
 * limit is not what protects it — but a caller who does not hold the token should not get an
 * unlimited number of guesses, and an exemption on the one route that can clear the limiter
 * would be a pleasing thing to find.
 *
 * ## ORDERING: this must be called AFTER `registerErrorHandlers`
 *
 * It used to be called from inside `securityPlugin`, which `app.ts` registers *before* the
 * error handlers. Fastify binds a route's error handler at the moment the route is ADDED, so
 * the reset route was bound to the framework's default handler and its own refusals came back
 * in Fastify's shape — `{"statusCode":403,"error":"Forbidden",...}` — rather than the single
 * `ApiError` shape every other endpoint returns. Nothing security-relevant leaked, and it was
 * still wrong: the contract says there is exactly one error shape, and a route that quietly has
 * a second one is how a client learns to parse two.
 *
 * Hence `app.ts` calls this, late, rather than the plugin calling it early.
 */
export function registerRateLimitResetRoute(app: FastifyInstance, config: AppConfig): void {
  const token = config.rateLimitResetToken;
  if (token === null) return;

  // Synchronous: clearing the counters is a walk of in-memory maps, and nothing here waits
  // on anything.
  app.post(RATE_LIMIT_RESET_PATH, (request, reply) => {
    const provided = bearerToken(request);
    if (provided === null || !secretsMatch(token, provided)) {
      request.log.warn({ path: RATE_LIMIT_RESET_PATH }, 'rate-limit reset refused: bad or missing token');
      // `not_authenticated`, not `forbidden`: no credential was accepted, which is what 401
      // means. The body is the same shape every other failure uses.
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

// ---------------------------------------------------------------------------
// Server options that belong to this layer
// ---------------------------------------------------------------------------

/**
 * Options that must be given to Fastify at construction time and cannot be set from a
 * plugin. They live here so that every limit is decided in one file; `app.ts` spreads the
 * result into its `fastify()` call.
 */
export function securityServerOptions(config: AppConfig): FastifyServerOptions {
  return {
    // Refuses an oversized body before it is buffered. Fastify raises
    // FST_ERR_CTP_BODY_TOO_LARGE, which the error handler maps to `payload_too_large`.
    bodyLimit: config.bodyLimitBytes,
    // A slow or stalled request is closed by Node rather than pinning a socket forever.
    // This is enforced below Fastify, so it produces a socket-level 408 rather than an
    // ApiError body — noted here so nobody hunts for the missing error shape.
    requestTimeout: config.requestTimeoutMs,
    connectionTimeout: 0,
    keepAliveTimeout: 72_000,
    // Lets `app.close()` drop idle keep-alive sockets during shutdown instead of waiting out
    // `keepAliveTimeout` on each of them. Without it a graceful stop takes over a minute and
    // gets SIGKILLed halfway through.
    //
    // IT IS NOT SUFFICIENT ON ITS OWN, and that is worth stating here because the setting reads
    // as though it were: Fastify turns it into a single `closeIdleConnections()` call at the
    // moment `close()` is invoked. A socket that is mid-request at that moment is not idle and is
    // never revisited, so `app.close()` would hang until `keepAliveTimeout` — which is the normal
    // deploy case, because browsers keep connections alive. `server.ts` therefore keeps sweeping
    // for newly-idle sockets for the duration of the drain; see `drainIdleConnections` there and
    // `test/shutdown.test.ts`, which holds a keep-alive request open across a SIGTERM.
    forceCloseConnections: 'idle',
    // Both default to 'error' in Fastify 5, and both are stated anyway: a JSON body
    // containing `__proto__` or `constructor` must be rejected, not merged.
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    // See `plugins/request-context.ts`: the request id is ours, never the caller's.
    requestIdHeader: false,
    trustProxy: config.trustProxy,
    routerOptions: {
      // Longest single URL parameter. Our id patterns cap at 64 characters, so anything
      // longer is either a bug or someone probing the router.
      maxParamLength: 64,
      // A route pattern that can backtrack is a denial of service in the router itself.
      allowUnsafeRegex: false,
    },
  };
}

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

export interface SecurityPluginOptions {
  readonly config: AppConfig;
}

/**
 * Registers the whole security layer on the instance it is given.
 *
 * Marked `skip-override` (see `request-context.ts` for the full explanation) so that the
 * hooks and decorators land on the caller's instance rather than on a child scope that no
 * route belongs to.
 */
export const securityPlugin: FastifyPluginAsync<SecurityPluginOptions> = async (app, options) => {
  const { config } = options;
  configureAllowedOrigins(config.webOrigins);

  // --- headers ---------------------------------------------------------------
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: { useDefaults: false, directives: { ...API_CSP_DIRECTIVES } },
    // `no-referrer`: an API URL can contain a room or hand id, and there is no case in
    // which another site needs to know which of our endpoints a request came from.
    referrerPolicy: { policy: 'no-referrer' },
    xContentTypeOptions: true,
    xFrameOptions: { action: 'deny' },
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xDnsPrefetchControl: { allow: false },
    // Cross-origin isolation. On a JSON API these mostly matter for the day a route
    // returns a document by accident, but they cost nothing:
    //   COOP  — a window we open, or that opens us, gets no reference back.
    //   COEP  — no cross-origin subresource may be embedded without opting in.
    //   CORP  — our responses may not be embedded by another origin as an image, a
    //           script or a frame. This does NOT block the web app's `fetch`: CORP is
    //           only enforced for `no-cors` requests, and a credentialed CORS fetch is
    //           not one. If a genuine cross-origin embed is ever needed, relaxing this
    //           to 'cross-origin' must be a deliberate, reviewed change.
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    originAgentCluster: true,
    // HSTS in production only. Sending it from a development server would pin
    // `localhost` to https in the developer's browser for a year, which is a genuinely
    // unpleasant thing to debug. `preload` is off: submitting to the preload list is
    // effectively irreversible and is a decision for whoever owns the domain, not for a
    // default in a source file.
    strictTransportSecurity: config.isProduction
      ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true, preload: false }
      : false,
  });

  // --- cookies ---------------------------------------------------------------
  //
  // BEFORE the CORS hook, which is a reversal. It used to be after, with the comment "before
  // cookies: a rejected preflight should do no further work". That saving was one string split of
  // a header the request already carries, and it cost something real: the CORS hook now runs the
  // rate limiter by hand (see below), and `rateLimitKeyFor` prefers the SIGNED SESSION over the
  // address. With the jar unparsed, every CORS refusal from a caller holding a session would have
  // landed in that caller's ADDRESS bucket instead — a different bucket from the one the route
  // limiter uses for the same caller, and one shared with everybody behind the same NAT.
  await app.register(cookie, {
    secret: config.sessionCookieSecret,
    // HMAC-SHA256 signatures. The default in @fastify/cookie, stated so a future
    // dependency bump that changes the default is a visible diff rather than a silent
    // downgrade.
    algorithm: 'sha256',
    hook: 'onRequest',
  });

  // --- rate limiting ---------------------------------------------------------
  /**
   * The counter store.
   *
   * Production gets the library's own — this is `undefined` there, because
   * `config.rateLimitResetToken` cannot be set in production at all (`config.ts` refuses to
   * start such a process). Only a development, test or CI process substitutes the resettable
   * store, and it does so purely so `scripts/smoke-test.mjs` can run twice in a row without
   * the first run's deliberate flood of the guest limiter breaking the second one. See
   * `plugins/rate-limit-store.ts` for the whole argument.
   */
  const resettableStore = config.rateLimitResetToken === null ? undefined : ResettableRateLimitStore;

  /**
   * Bans are recorded once per key per window, not once per refused request.
   *
   * `onBanReach` is called by `@fastify/rate-limit` on EVERY request while
   * `current - max > ban` holds, which is every request for the rest of the window once a caller
   * has crossed the threshold — not, as the name and the comment below it both implied, once when
   * it is crossed. At the shipped defaults (`banAfter=200`, `globalMax=300`) a single address
   * flooding past 501 requests a minute therefore turned every subsequent REFUSED request into a
   * `warn` line, a metric increment and a fire-and-forget `INSERT` into `prl.audit_log`. That
   * INSERT is un-awaited (`observability/telemetry.ts`), so there is no backpressure and the
   * pending-promise queue is bounded only by the flood: the refusal path became a database write
   * amplifier under exactly the load the limiter exists to survive.
   *
   * This map is the deduplication. It holds one entry per banned key until that key's window has
   * elapsed, so the audit row, the log line and the metric are each written once per (key,
   * window) — which is what "a ban is a security event rather than traffic" was always supposed
   * to mean.
   *
   * It is swept rather than left to grow: the keys come from `rateLimitKeyFor`, so a caller
   * rotating addresses could otherwise mint entries indefinitely. The sweep is lazy and bounded
   * — it only runs once the map is larger than a flood from a handful of keys could make it.
   */
  const bansRecordedUntil = new Map<string, number>();
  const BAN_SWEEP_THRESHOLD = 1_024;

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalMax,
    timeWindow: config.rateLimit.globalWindowMs,
    ...(resettableStore === undefined ? {} : { store: resettableStore }),
    // Past this much over the limit the caller is blocked outright instead of merely
    // told to wait. It still answers `rate_limited` (the contract has no separate code),
    // but `onBanReach` records it.
    //
    // `0` does NOT turn this off, and `.env.example` says so at length: the library computes
    // `isBanned = ban !== -1 && current - max > ban` and treats only a NEGATIVE value as off,
    // while `config.ts` bounds the variable at `min: 0`. So `0` is the most aggressive setting
    // there is — every single request past the limit is a ban — and banning cannot be disabled
    // from configuration at all.
    ban: config.rateLimit.banAfter,
    hook: 'onRequest',
    keyGenerator: (request) => rateLimitKeyFor(request, config),
    // If the counter store ever fails, allow the request rather than turning every call into
    // a 500. The in-memory store this uses today cannot fail; the setting is here for the day
    // a shared store (Redis, or a second process) is introduced, when the failure mode changes
    // from impossible to "the cache is briefly unreachable". Note the trade-off: during such a
    // failure there is effectively no rate limit.
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
      // Already recorded for this key inside this window. Everything below is deliberately
      // skipped — including the log line, because a `warn` per refused request is the same
      // amplification in the log pipeline that the audit INSERT is in the database.
      if (recordedUntil !== undefined && recordedUntil > now) return;
      bansRecordedUntil.set(key, now + config.rateLimit.globalWindowMs);

      request.log.warn({ rateLimitKey: key }, 'rate-limit ban threshold reached');
      // Written to the audit log as well as logged and counted, because a ban is the one
      // rate-limit outcome that is a security event rather than traffic: the caller went far
      // past the limit while ignoring `Retry-After`, which is a script and not a person. The
      // KEY IS NOT RECORDED — it is derived from the caller's address, and the audit log is not
      // the place to keep a pseudonymous identifier for that. The route is, because the route
      // is what an investigation starts from.
      //
      // ONE ROW PER (KEY, WINDOW). The route recorded is therefore the first route the caller
      // crossed the threshold on rather than every route it went on to hit, which is the right
      // trade: an investigation starts from where a flood began, and a row per refused request
      // is a write amplifier rather than a record.
      recordSecurityAudit(
        { event: 'security.rate_limit.banned', detail: { route: request.routeOptions.url ?? null } },
        (message, detail) => {
          request.log.warn({ ...detail }, message);
        },
      );
      // Counted as well as logged. A ban is the signal that somebody is ignoring
      // `Retry-After` rather than merely being busy, which is the difference between a
      // popular hour and an abusive client — and an alert can only be written against the
      // counter. The key is NOT a metric label: it is derived from the caller's address and
      // would be both unbounded and personally identifying. See `observability/metrics.ts`.
      //
      // One increment per (key, window), so this counter now measures BANNED CALLERS rather
      // than refused requests. `prl_rate_limit_events_total{kind="exceeded"}` is the one that
      // counts requests; an alert written against `banned` should read as "distinct callers
      // banned per minute", which is what an operator wanted from it in the first place.
      app.appMetrics.rateLimitEvents.inc({ kind: 'banned' });
    },
    // The 429 body is built by `errors.ts` from the same `AppError` shape as everything
    // else, so `retryAfterSeconds` and the `Retry-After` header come from one number.
    errorResponseBuilder: (_request, context) => rateLimitError(context.ttl / 1000),
  });

  app.decorate('expensiveRateLimit', {
    rateLimit: { max: config.rateLimit.expensiveMax, timeWindow: config.rateLimit.expensiveWindowMs },
  });

  /**
   * The route limiter, callable by hand from a hook that would otherwise answer before it.
   *
   * ## What this closes
   *
   * The header of this file states an invariant — a caller cannot make this server answer
   * without being counted, because the route-level limiter is "the first thing that can cost a
   * caller anything". Three request classes broke it, all of them answered from an INSTANCE hook,
   * which Fastify runs before every route-level hook:
   *
   *  1. A cross-origin mutating request from an origin that is not allowlisted (403 from the CORS
   *     hook).
   *  2. A rejected preflight (403 from the same hook).
   *  3. An accepted preflight (204 from the same hook).
   *
   * and a fourth that is an ordering problem rather than a hook problem:
   *
   *  4. A `POST` to a path that does not exist and whose CSRF token is bad. The not-found route's
   *     limiter is a `preHandler` (`errors.ts`), and the CSRF check is a `preValidation` hook, so
   *     the 403 was answered one stage earlier than the counting. That is the exact hole the
   *     header names, and it also blunts the not-found limiter's own reason for existing: "a
   *     caller can hammer nonexistent paths for free — exactly what a path scanner does".
   *
   * Measured before: 50 x `POST /api/v1/ready` with a rejected `Origin`, 50 x rejected `OPTIONS`,
   * and 50 x `POST /api/v1/does-not-exist-N` each returned 403 with the caller's bucket still
   * empty afterwards. After: each class is counted, and a caller who exceeds the limit with them
   * is answered 429 instead. The negative controls are in
   * `test/security-uncounted-requests.test.ts`.
   *
   * ## Why calling it by hand is safe
   *
   * `rateLimitRequestHandler` sets a per-request flag the first time it runs and returns
   * immediately on every later call. So a request counted here is NOT counted again by its route,
   * and — the case that matters — a route carrying a STRICTER limit (`expensiveRateLimit`) has
   * already run its own at `onRequest`, so this call is the no-op and the strict limit stands.
   * That is also why the CORS hook only calls this when it is about to answer or refuse: calling
   * it on the `continue` path would consume the global limiter's turn for every request and quietly
   * disable every per-route limit in the API.
   *
   * It throws the same `AppError` the route limiter throws, so an over-limit caller gets the
   * contract's `rate_limited` body and `Retry-After` from these paths too.
   */
  const countRequest = app.rateLimit();

  // --- CORS (after cookies and the limiter; see both comments above) ----------
  app.addHook('onRequest', async (request, reply) => {
    const outcome = applyCors(request, reply);
    if (outcome === 'continue') return;
    // Every path below answers the caller from this hook, so every path below is counted first.
    // A throw from here is the limiter's 429 and replaces the CORS answer, which is correct: a
    // caller past the limit is past the limit whatever they were going to be told.
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
    // An ACCEPTED preflight is counted too. It costs the browser one extra count per
    // `PREFLIGHT_MAX_AGE_SECONDS` per method/header combination, which is negligible against the
    // limit, and the alternative is an uncounted 204 that anyone can ask for without a session,
    // without a token and without an allowlisted origin being needed for the count to matter.
    return reply.status(204).send();
  });

  // --- CSRF ------------------------------------------------------------------
  await app.register(csrfProtection, {
    sessionPlugin: '@fastify/cookie',
    cookieKey: csrfCookieName(config),
    cookieOpts: csrfCookieOptions(config),
    /**
     * Only the `x-csrf-token` header. The plugin's default also accepts `csrf-token`,
     * `xsrf-token`, `x-xsrf-token` and `body._csrf`; narrowing to one name means the
     * contract has exactly one answer, and dropping the body form means the check can run
     * before validation and cannot be confused by a body that parsed strangely.
     *
     * A custom header is what makes double-submit work at all: a cross-site page can make
     * the browser send our cookies, but it cannot set a custom header on a cross-origin
     * request without a preflight, and the preflight is answered only for allowlisted
     * origins.
     */
    getToken: (request) => {
      const header = request.headers['x-csrf-token'];
      return typeof header === 'string' ? header : undefined;
    },
  });

  /**
   * Applies the check to every state-changing method, and to nothing else.
   *
   * GET and HEAD are exempt because CSRF is about *state changes* caused by a request the
   * user did not intend, and no GET in this API changes state (a rule enforced by review,
   * not by this hook). Requiring a token on GET would also break the two navigations that
   * cannot carry a custom header at all: an ordinary link into the app, and the OIDC
   * provider's redirect back to the callback route.
   *
   * OPTIONS is exempt because a preflight is not the request — it is the browser asking
   * whether the request is allowed, and it never carries the token.
   *
   * The WebSocket upgrade is also a GET and is exempt here, and it cannot use this scheme
   * at all: browser script cannot set a header on a `new WebSocket()` handshake, and
   * WebSockets are outside CORS entirely, so the browser will happily open a cross-origin
   * socket *with cookies attached*. The only server-side signal is the `Origin` header,
   * which browsers always send on a handshake and page script cannot forge — which is why
   * `isAllowedOrigin` is exported for the hub to call before accepting the upgrade.
   *
   * ## The count comes first, and that is the fix for the fourth uncounted class
   *
   * `countRequest` runs BEFORE the check, not after it. This hook is `preValidation`, and the
   * not-found route's limiter is a `preHandler` — one stage later — so a `POST` to a path that
   * does not exist and carries a bad token was answered 403 here and never reached the counting
   * at all. Measured: 50 x `POST /api/v1/does-not-exist-N` with no token, all 403, the caller's
   * bucket empty afterwards. That is precisely the hole this file's header names ("unlimited
   * requests that fail CSRF without ever being counted") and it is also what `errors.ts` means by
   * "a caller can hammer nonexistent paths for free — exactly what a path scanner does".
   *
   * On every route that exists this call is a no-op: the route's own limiter has already run at
   * `onRequest` and `@fastify/rate-limit` counts a request once. So this adds counting exactly
   * where there was none, and changes nothing where there was. No mutating route is exempt from
   * the limiter (`rateLimit: false` appears on `/health` alone, which is a GET), so there is no
   * route this can count against an exemption somebody meant.
   *
   * The hook stays CALLBACK-STYLE, which is not an oversight. `@fastify/csrf-protection` answers a
   * failure by calling `reply.send(error)` itself and never calling `next`, so wrapping it in a
   * promise produces one that never settles — a pending promise retained per failed CSRF request,
   * which is a leak on precisely the path a flood uses. `countRequest` is the only asynchronous
   * part, so it is the only part with a `.then`, and `app.csrfProtection` still receives Fastify's
   * own `done` exactly as before.
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
      // The limiter's own `rate_limited`, so an over-limit caller is told to wait rather than
      // told their token was bad.
      (error: unknown) => {
        done(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  // --- cache policy ----------------------------------------------------------
  /**
   * `Cache-Control: no-store` unless a route deliberately said otherwise, and
   * unconditionally whenever the request carried a session cookie.
   *
   * The second half is the one that matters. A route author who marks a content endpoint
   * cacheable is usually right — lesson text is the same for everybody — but the moment a
   * response is personalised (progress, "completed", a display name) a shared cache
   * holding it becomes a way to serve one user's page to another. Deciding that here,
   * from the presence of the session cookie, means a route cannot get it wrong.
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
