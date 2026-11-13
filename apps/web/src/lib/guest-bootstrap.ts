/**
 * Mints the guest session a first-time visitor to Learn, the Lab or the record needs, in the proxy.
 * A server component cannot set a cookie, and a client effect would leave the server render anonymous.
 * A request that already carries a session cookie mints nothing, and only a top-level document
 * navigation mints. Two first navigations in two tabs before any cookie exists mint two guests, and
 * nothing on the wire can tell them apart. On any API failure the page is served anonymous.
 */

import { API_PATHS } from '@prl/contracts';
import { SESSION_COOKIE_NAMES } from './session-cookie-names.ts';

/** Read at call time so tests can set it. Same variable and default as `API_ORIGIN` in `api.ts`. */
function apiOrigin(): string {
  return process.env['PRL_API_ORIGIN'] ?? 'http://localhost:3001';
}

/**
 * A list, not every page, so a crawler on the home page creates no rows.
 * `/play` is absent because it already mints through `ensureSession` before opening a socket.
 */
const GUEST_BOOTSTRAP_PREFIXES: readonly string[] = ['/learn', '/lab', '/record'];

export function pathNeedsGuest(pathname: string): boolean {
  return GUEST_BOOTSTRAP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (cookieHeader === null || cookieHeader === '') return false;
  const names = cookieHeader.split(';').map((pair) => pair.split('=')[0]?.trim() ?? '');
  return SESSION_COOKIE_NAMES.some((name) => names.includes(name));
}

/**
 * `next-router-prefetch` (App Router) or `purpose: prefetch` (browsers, proxies, link scanners).
 * This decides whether the reader asked for the page, which is what minting turns on. It does NOT
 * decide whether a page is served. Use `isRouterPrefetch` for that.
 */
export function isPrefetch(headers: Headers): boolean {
  if (isRouterPrefetch(headers)) return true;
  return headers.get('purpose') === 'prefetch';
}

/**
 * Only `next-router-prefetch` changes what Next renders (a 264-byte segment tree instead of the 38KB
 * page, measured on `/play`). `purpose: prefetch` gets the whole page, so the age gate and CSP must
 * treat it as a page request. `next-router-segment-prefetch` is stripped before middleware.
 */
export function isRouterPrefetch(headers: Headers): boolean {
  return headers.get('next-router-prefetch') !== null;
}

/**
 * An RSC navigation is `empty` and a router prefetch gets a stub, so both are excluded.
 * This reports request shape only. `purpose: prefetch` with `document` counts as a navigation, and
 * the minting caller excludes it with `isPrefetch`.
 */
export function isDocumentNavigation(headers: Headers): boolean {
  if (headers.get('rsc') !== null) return false;
  if (isRouterPrefetch(headers)) return false;
  const dest = headers.get('sec-fetch-dest');
  // A missing header (curl, a health check, the smoke test) is treated as a document.
  return dest === null || dest === 'document';
}

/**
 * An in-app `<Link>` navigation, used by the age gate.
 * Next strips its `FLIGHT_HEADERS` (`rsc` included) before middleware, so `rsc` is null here today
 * and `Sec-Fetch-Dest: empty` is the real test (measured by `scripts/age-gate-audit.mjs`). The `rsc`
 * line stays for a runtime that stops stripping it and sends no `Sec-Fetch-*`. This app's own fetches
 * go to the API prefix, which the proxy matcher excludes. GET and HEAD only, so a future Server
 * Action (a POST with `empty`) is not redirected.
 */
export function isRouterNavigation(headers: Headers, method: string): boolean {
  if (isRouterPrefetch(headers)) return false;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (headers.get('rsc') !== null) return true;
  return headers.get('sec-fetch-dest') === 'empty';
}

export interface MintedGuest {
  readonly requestCookies: readonly string[];
  readonly setCookies: readonly string[];
}

/**
 * `GET /auth/session` mints the CSRF token and its secret cookie, then `POST /auth/guest` sends both.
 * Same sequence as `ensureSession`, but with no cookie jar, so every cookie is carried by hand.
 * `origin` is the page's own, so the API's exact-match `PUBLIC_WEB_ORIGIN` allowlist sees what a
 * browser would send.
 */
/** Wall clock for the two CSRF calls. Long enough for a healthy API, short enough not to stall `/learn`. */
export const GUEST_MINT_TIMEOUT_MS = 4_000;

export async function mintGuestSession(options: {
  readonly origin: string;
  readonly signal?: AbortSignal;
}): Promise<MintedGuest | null> {
  const base = apiOrigin();
  const signal = options.signal ?? AbortSignal.timeout(GUEST_MINT_TIMEOUT_MS);
  const fetchOptions = { signal };

  let seed: Response;
  try {
    seed = await fetch(`${base}${API_PATHS.session()}`, {
      method: 'GET',
      headers: { accept: 'application/json', origin: options.origin },
      cache: 'no-store',
      ...fetchOptions,
    });
  } catch {
    return null;
  }
  if (!seed.ok) return null;

  const seedCookies = seed.headers.getSetCookie();
  const csrfToken = readCsrfToken(await seed.json());
  if (csrfToken === null) return null;

  // Only the pairs, never the attributes: this header is being sent, not stored.
  const csrfPairs = seedCookies.map(cookiePair).filter((pair): pair is string => pair !== null);

  let created: Response;
  try {
    created = await fetch(`${base}${API_PATHS.guest()}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        origin: options.origin,
        'x-csrf-token': csrfToken,
        ...(csrfPairs.length === 0 ? {} : { cookie: csrfPairs.join('; ') }),
      },
      body: '{}',
      cache: 'no-store',
      ...fetchOptions,
    });
  } catch {
    return null;
  }
  if (!created.ok) return null;

  const guestCookies = created.headers.getSetCookie();
  const sessionPair = guestCookies.map(cookiePair).find((pair) => pair !== null && isSessionPair(pair));
  if (sessionPair === undefined || sessionPair === null) return null;

  return {
    // The CSRF secret is forwarded too. The browser gets both cookies as a pair, and half of one would
    // fail the first client-side mutation's CSRF check.
    requestCookies: [...csrfPairs, sessionPair],
    setCookies: [...seedCookies, ...guestCookies],
  };
}

function cookiePair(setCookie: string): string | null {
  const first = setCookie.split(';')[0]?.trim() ?? '';
  return first.includes('=') && !first.startsWith('=') ? first : null;
}

function isSessionPair(pair: string): boolean {
  const name = pair.split('=')[0] ?? '';
  return (SESSION_COOKIE_NAMES as readonly string[]).includes(name);
}

function readCsrfToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const token = (body as { readonly csrfToken?: unknown }).csrfToken;
  return typeof token === 'string' && token !== '' ? token : null;
}
