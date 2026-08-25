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
 * through `@fastify/helmet`, and a nonce forwarded to it would be noise. A ROUTER prefetch is
 * skipped because Next answers it with a routing stub rather than with a document, so there is no
 * page there to protect — and note the word "router": a request merely carrying `purpose: prefetch`
 * IS answered with the whole document, was skipped here on the assumption that it was not, and so
 * arrived with no policy on it at all. `scripts/age-gate-audit.mjs` measured that and
 * the matcher below now says so. Everything else — every HTML route, including 404s and errors —
 * gets the policy, because "the page that got a policy" and "the page an attacker aims at" must
 * not be different sets.
 *
 * ## Three jobs, one function
 *
 * This file also mints the guest session Learn and the Scenario Lab need, and applies the age gate.
 * Neither is an unrelated errand bolted on: setting a cookie on a document response, and redirecting
 * before a page renders, are things only the proxy can do in the App Router — so everything this app
 * has to decide before a render lives here. The logic itself does not: it is in
 * `src/lib/guest-bootstrap.ts` and `src/lib/age-gate.ts`, which are where the reasoning for each is.
 *
 * The gate runs FIRST, and returns before the guest bootstrap when it redirects. A reader who has
 * not passed the age check must not have an account created for them on the way to being told so.
 *
 * ## Why the gate fires on router navigations and the guest bootstrap does not
 *
 * `isDocumentNavigation` answers "is this a top-level document request", and that is the right
 * question for minting an account: the several requests one page view makes must not each create a
 * row, and a prefetch must not create one for a page nobody opened.
 *
 * It is the wrong question for a gate, by one case. A reader already on `/learn` who clicks through
 * to `/play` does not make a document request at all — the router fetches an RSC payload, which
 * `isDocumentNavigation` correctly reports as not a document. A gate that skipped it would be walked
 * around by a single in-app click, which is not a gate. So the gate also fires on a router
 * NAVIGATION, and on nothing else: a ROUTER prefetch is still excluded, because redirecting one
 * puts a redirect into the router's cache for a page the reader never asked for.
 *
 * **This was wrong from the day the gate landed until `scripts/age-gate-audit.mjs` measured it.**
 * The test for a router navigation was `request.headers.get('rsc') !== null`, which is the header
 * the router sends and is the obvious answer — and Next deletes every one of its `FLIGHT_HEADERS`,
 * `rsc` included, before middleware runs. So the branch was dead, every in-app click walked through
 * a gate that was on, and the only thing that was ever gated was a document navigation. Nothing in
 * the repository could have caught it: the pure decision is correct and its unit tests construct
 * the header by hand, and no harness had ever clicked a link with the gate switched on.
 * `isRouterNavigation` in `src/lib/guest-bootstrap.ts` carries the mechanism and the replacement.
 *
 * If Next ever declined to follow a middleware redirect on a router navigation, the failure mode is
 * the client falling back to a hard navigation — which arrives here as a document request and is
 * gated again. There is no path through this that renders a gated page. That claim is a measurement
 * now rather than an argument: `pnpm run test:age-gate` clicks the link in a real Chrome.
 *
 * ## Nonce generation
 *
 * `crypto.getRandomValues` from the Web Crypto API, which the Edge runtime this file runs in
 * provides. 16 bytes, base64. Not `Math.random`: a predictable nonce is the same as no nonce, and
 * this is the sort of line that gets written once and read never.
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

  // The age gate, before anything that could create state: a reader who has not passed it must not
  // have an account minted on the way to being told so. See the header note for why the navigation
  // test is wider here than the one the guest bootstrap uses.
  const gate = decideAgeGate({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    cookieHeader: request.headers.get('cookie'),
    navigation: isGateableNavigation(request),
    secure: isSecureRequest(request),
    config: readAgeGateConfig(),
  });
  if (gate.kind !== 'allow') {
    // 303, not 302: "the answer is at this other URL, fetch it with GET". Correct for the
    // declaration, which is a form submission, and correct for the challenge, which is not one.
    // Neither is cacheable by default, which matters — a cached redirect for `/play` would outlive
    // the declaration that was supposed to end it.
    const redirect = NextResponse.redirect(new URL(gate.location, request.nextUrl.origin), 303);
    // A redirect is a response the browser handles and it still gets the full header set. A policy
    // applied only to responses that carry HTML is a policy with a hole in it.
    redirect.headers.set(CSP_HEADER, policy);
    for (const [name, value] of SECURITY_HEADERS) redirect.headers.set(name, value);
    if (gate.kind === 'accepted') redirect.headers.append('set-cookie', gate.setCookie);
    return redirect;
  }

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
 * True for a request the age gate may act on: a document navigation, or a router navigation.
 *
 * Both tests are `src/lib/guest-bootstrap.ts`'s rather than reimplemented here — it is the same
 * judgement, and two copies of "what counts as a navigation" would drift. What this adds is the
 * one case the guest bootstrap correctly excludes and the gate needs: an in-app router navigation.
 * See the header note for why leaving that out is a gate a single in-app click walks around, and
 * `isRouterNavigation`'s own comment for why the obvious way to detect one does not work.
 *
 * A ROUTER prefetch is excluded three times over — by the `matcher` below, by
 * `isDocumentNavigation` and by `isRouterNavigation` — because a prefetch and a router navigation
 * are the same request but for one header, and letting one through the second branch would put a
 * redirect into the router's cache for a page nobody asked for. The wider `purpose: prefetch`
 * spelling is deliberately NOT excluded: Next answers such a request with the whole page, so the
 * page is what the reader gets, and a gate that stepped aside for it would be stepping aside for a
 * delivery of the very thing it exists to hold back.
 */
function isGateableNavigation(request: NextRequest): boolean {
  if (isDocumentNavigation(request.headers)) return true;
  return isRouterNavigation(request.headers, request.method);
}

/**
 * Whether this request reached us over TLS, which decides the declaration cookie's name.
 *
 * Getting this WRONG in one direction is a redirect loop and not a subtlety: a `__Host-` cookie
 * carries `Secure`, a browser silently discards a `Secure` cookie delivered over plain HTTP, and a
 * declaration that never sticks means the gate asks again on every request for ever. So the test is
 * conservative — the connection says https, or a proxy in front says exactly `https` — and the
 * failure it errs towards is the harmless one: an unprefixed cookie on a TLS deployment whose proxy
 * forwards no protocol header.
 *
 * `x-forwarded-proto` is trusted here in a way the API deliberately does not trust it for rate
 * limiting, and the difference is what a lie buys: forging it costs the forger their own gate
 * cookie and gains them nothing, whereas forging an address there would move somebody else's rate
 * limit.
 */
function isSecureRequest(request: NextRequest): boolean {
  if (request.nextUrl.protocol === 'https:') return true;
  return request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
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
  // The WIDE prefetch test, and it is stated here rather than folded into `isDocumentNavigation`
  // because it is this caller's rule and not a fact about the request's shape. Minting turns on
  // "was this the reader's idea": a `<link rel="prefetch">`, or a link scanner walking the site,
  // must not create an account for a page nobody has opened, even though Next answers such a
  // request with a whole document and the age gate is therefore right to gate it.
  if (isPrefetch(request.headers)) return [];
  if (!isDocumentNavigation(request.headers)) return [];

  try {
    const minted = await mintGuestSession({
      // The PUBLIC origin, not this process's own. Behind a proxy the two differ, the API
      // exact-matches this header against its allowlist, and sending the container's listening
      // address made every guest mint a 403 on every real deployment. See `lib/public-origin.ts`
      // for the measurement and the order of preference.
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
     * Everything except the immutable asset routes and the favicon. Written as a negative lookahead
     * because the alternative — listing the routes that DO need a policy — is a list that goes
     * stale the first time somebody adds a page, and goes stale silently.
     */
    /*
     * `next-router-prefetch` is the ONLY prefetch header listed here, and the omission of the
     * other one is the point.
     *
     * `purpose: prefetch` used to be listed beside it, on the reasoning that a prefetch is not a
     * document. That reasoning was measured and it is false: `purpose: prefetch` changes nothing
     * about what Next renders. A request for `/play` carrying it is answered with the complete
     * 38KB document — the table, the whole page — while the same request carrying
     * `next-router-prefetch` is answered with 264 bytes of routing stub and no page content at all.
     *
     * So while it was listed, any client that set one header was served a gated page in full, with
     * no age gate applied to it and no Content-Security-Policy on it. `scripts/age-gate-audit.mjs`
     * found that; `src/lib/guest-bootstrap.ts` `isRouterPrefetch` is where the distinction lives
     * now. A request that will be answered with a page is a document, whatever it calls itself.
     */
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
