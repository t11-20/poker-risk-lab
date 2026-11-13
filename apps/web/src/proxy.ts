/**
 * Puts the Content-Security-Policy on every HTML response, mints the guest session, and applies the
 * age gate. Next 16 names this file convention `proxy`.
 *
 * The policy needs a per-response nonce for the inline RSC scripts, so it cannot live in `headers()`.
 * It goes on the forwarded REQUEST headers, which Next's renderer reads to stamp its script tags, and
 * on the RESPONSE, which the browser enforces. Setting only the response gives a page that never hydrates.
 *
 * The gate runs first and returns before the guest bootstrap, so no account is minted for a reader
 * not yet past it. It also fires on router navigations, because a gate one in-app click walks around
 * is not a gate. `pnpm run test:age-gate` clicks the link in a real Chrome.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { decideAgeGate, readAgeGateConfig } from '@/lib/age-gate.ts';
import { CSP_HEADER, contentSecurityPolicy, SECURITY_HEADERS } from '@/lib/csp.ts';
import {
  GUEST_MINT_TIMEOUT_MS,
  hasSessionCookie,
  isDocumentNavigation,
  isPrefetch,
  isRouterNavigation,
  mintGuestSession,
  pathNeedsGuest,
} from '@/lib/guest-bootstrap.ts';
import { publicOriginFor } from '@/lib/public-origin.ts';

/** 16 bytes from Web Crypto, base64. Never `Math.random`, because a predictable nonce is no nonce. */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = newNonce();
  // `NODE_ENV` is `development` only under `next dev`, so dev allowances cannot reach a built image.
  const policy = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === 'development',
  });

  // The copy Next's renderer reads.
  const forwarded = new Headers(request.headers);
  // The root layout reads `x-nonce` through `next/headers` to stamp the theme boot script.
  forwarded.set('x-nonce', nonce);
  forwarded.set(CSP_HEADER, policy);

  // Before anything that creates state. Its navigation test is wider than the guest bootstrap's.
  const gate = decideAgeGate({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    cookieHeader: request.headers.get('cookie'),
    navigation: isGateableNavigation(request),
    secure: isSecureRequest(request),
    config: readAgeGateConfig(),
  });
  if (gate.kind !== 'allow') {
    // 303 so the follow-up is a GET, and not cacheable, because a cached redirect for `/play` would
    // outlive the declaration.
    const redirect = NextResponse.redirect(new URL(gate.location, request.nextUrl.origin), 303);
    // A redirect still gets the full header set.
    redirect.headers.set(CSP_HEADER, policy);
    for (const [name, value] of SECURITY_HEADERS) redirect.headers.set(name, value);
    if (gate.kind === 'accepted') redirect.headers.append('set-cookie', gate.setCookie);
    return redirect;
  }

  const minted = await bootstrapGuest(request, forwarded);

  const response = NextResponse.next({ request: { headers: forwarded } });

  // The copy the browser enforces.
  response.headers.set(CSP_HEADER, policy);
  for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
  for (const cookie of minted) response.headers.append('set-cookie', cookie);
  return response;
}

/**
 * A document navigation or a router navigation. A ROUTER prefetch is excluded, because redirecting
 * one caches a redirect for a page nobody asked for. `purpose: prefetch` is not excluded, because
 * Next answers it with the whole page.
 */
function isGateableNavigation(request: NextRequest): boolean {
  if (isDocumentNavigation(request.headers)) return true;
  return isRouterNavigation(request.headers, request.method);
}

/**
 * Decides the declaration cookie's name. A `__Host-` cookie is `Secure`, a browser drops it over plain
 * HTTP, and the gate would then ask forever, so this errs towards an unprefixed cookie. Trusting
 * `x-forwarded-proto` is safe here, because forging it only costs the forger their own gate cookie.
 */
function isSecureRequest(request: NextRequest): boolean {
  if (request.nextUrl.protocol === 'https:') return true;
  return request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

/**
 * Returns the `Set-Cookie` values, usually none. Every failure is swallowed, because the screens tell
 * the truth about what was recorded either way and a reader must not get an error page for this.
 */
async function bootstrapGuest(request: NextRequest, forwarded: Headers): Promise<readonly string[]> {
  if (!pathNeedsGuest(request.nextUrl.pathname)) return [];
  if (hasSessionCookie(request.headers.get('cookie'))) return [];
  // The wide prefetch test is this caller's rule. A `<link rel="prefetch">` or a link scanner must not
  // create an account, even though the age gate is right to gate the same request.
  if (isPrefetch(request.headers)) return [];
  if (!isDocumentNavigation(request.headers)) return [];

  try {
    const minted = await mintGuestSession({
      // The PUBLIC origin. The API exact-matches it against its allowlist, so the container's own
      // address made every mint a 403 behind a proxy (see `lib/public-origin.ts`).
      origin: publicOriginFor({
        env: process.env,
        headers: request.headers,
        requestOrigin: request.nextUrl.origin,
      }),
      signal: AbortSignal.timeout(GUEST_MINT_TIMEOUT_MS),
    });
    if (minted === null) return [];
    const existing = forwarded.get('cookie');
    forwarded.set(
      'cookie',
      [existing, ...minted.requestCookies].filter((part) => part !== null && part !== '').join('; '),
    );
    return minted.setCookies;
  } catch {
    return [];
  }
}

export const config = {
  matcher: [
    /*
     * Everything except static assets, the API rewrite and the favicon, as a negative lookahead so a
     * new page cannot be left out. The API sets its own security headers through helmet.
     */
    /*
     * Only `next-router-prefetch` is excluded. It gets a 264-byte routing stub, while
     * `purpose: prefetch` gets the full 38KB document and so must get the gate and the policy.
     */
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
