/**
 * The one place a Content-Security-Policy is put on an HTML response.
 *
 * Next 16 calls this file convention `proxy` (it was `middleware` up to 15, and `next build` warns
 * on the old name). Same runtime, same contract: one function in front of every matched request.
 *
 * ## Why here rather than `next.config.ts` `headers()`
 *
 * A static `headers()` entry cannot mint a per-response nonce, and this policy needs one: React
 * Server Components stream their payload through inline `<script>` tags whose contents change per
 * render, so they can be allowed by a nonce or by nothing. `src/lib/csp.ts` explains at length why
 * a hash-only policy is not an option here and what it breaks.
 *
 * The exchange Next expects is specific and easy to get half-right:
 *
 *   1. This function generates the nonce.
 *   2. It sets the finished policy on the **request** headers it forwards. That is the copy Next's
 *      renderer reads (`getScriptNonceFromHeader`) to stamp the nonce onto its own script tags.
 *      Setting it only on the response would produce a policy the browser enforces and scripts
 *      that do not satisfy it — a page that renders and never hydrates.
 *   3. It sets the same policy on the **response**, which is the copy the browser enforces.
 *
 * The root layout reads the nonce back through `next/headers` for the theme boot script.
 *
 * ## The matcher, and what deliberately has no policy
 *
 * Static assets under `/_next/static` are immutable files served by the same origin; a CSP on them
 * protects nothing and running this function per chunk would mint a nonce per asset. `/api/*` is
 * excluded too — it is rewritten to the API (`next.config.ts`), which sets its own security headers
 * through `@fastify/helmet`, and a nonce forwarded to it would be noise. Prefetches are skipped
 * because they are not a document. Everything else — every HTML route, including 404s and errors —
 * gets the policy, because "the page that got a policy" and "the page an attacker aims at" must
 * not be different sets.
 *
 * ## Two jobs, one function
 *
 * This file also mints the guest session Learn and the Scenario Lab need. That is not an unrelated
 * errand bolted on: setting a cookie on a document response is something only the proxy can do in
 * the App Router, so both of the things this app has to decide before a page renders live here.
 * The guest logic itself is in `src/lib/guest-bootstrap.ts`, which is where its reasoning is.
 *
 * ## Nonce generation
 *
 * `crypto.getRandomValues` from the Web Crypto API, which the Edge runtime this file runs in
 * provides. 16 bytes, base64. Not `Math.random`: a predictable nonce is the same as no nonce, and
 * this is the sort of line that gets written once and read never.
 */

import { type NextRequest, NextResponse } from 'next/server';
import { CSP_HEADER, contentSecurityPolicy, SECURITY_HEADERS } from '@/lib/csp.ts';
import {
  GUEST_MINT_TIMEOUT_MS,
  hasSessionCookie,
  isDocumentNavigation,
  mintGuestSession,
  pathNeedsGuest,
} from '@/lib/guest-bootstrap.ts';

/** 128 bits of randomness, base64 — comfortably past the length CSP recommends. */
function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = newNonce();
  // `NODE_ENV` is `development` only under `next dev`. `next build` and `next start` both set
  // `production`, so the two development allowances in `contentSecurityPolicy` cannot reach a
  // built image — `test/csp-policy.test.ts` asserts that property directly rather than trusting it.
  const policy = contentSecurityPolicy({
    nonce,
    development: process.env.NODE_ENV === 'development',
  });

  // (2) The copy Next's renderer reads.
  const forwarded = new Headers(request.headers);
  forwarded.set('x-nonce', nonce);
  forwarded.set(CSP_HEADER, policy);

  // The other thing this file does: give a first-time visitor to Learn or the Lab the guest
  // session the product's own copy promises them. See `src/lib/guest-bootstrap.ts` for why it
  // happens here and nowhere else, and for exactly what "idempotent" means for it.
  const minted = await bootstrapGuest(request, forwarded);

  const response = NextResponse.next({ request: { headers: forwarded } });

  // (3) The copy the browser enforces.
  response.headers.set(CSP_HEADER, policy);
  for (const [name, value] of SECURITY_HEADERS) response.headers.set(name, value);
  for (const cookie of minted) response.headers.append('set-cookie', cookie);
  return response;
}

/**
 * Mints a guest when this request needs one, and adds it to the headers being forwarded.
 *
 * Returns the `Set-Cookie` values for the browser, or an empty list when nothing was minted —
 * which is the overwhelmingly common case, decided by two string tests before any network call.
 *
 * Every failure is swallowed on purpose. A reader must not be shown an error page because a
 * background convenience could not be arranged; the screens tell the truth about what was recorded
 * either way, which is what makes failing open safe rather than merely quiet.
 */
async function bootstrapGuest(request: NextRequest, forwarded: Headers): Promise<readonly string[]> {
  if (!pathNeedsGuest(request.nextUrl.pathname)) return [];
  if (hasSessionCookie(request.headers.get('cookie'))) return [];
  if (!isDocumentNavigation(request.headers)) return [];

  try {
    const minted = await mintGuestSession({
      origin: request.nextUrl.origin,
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
     * Everything except the immutable asset routes and the favicon. Written as a negative lookahead
     * because the alternative — listing the routes that DO need a policy — is a list that goes
     * stale the first time somebody adds a page, and goes stale silently.
     */
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
