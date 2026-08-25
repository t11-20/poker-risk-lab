/**
 * Minting the guest session a first-time visitor to Learn or the Scenario Lab has to have.
 *
 * ## The defect
 *
 * Every word of this product's copy is guest-first: "no email, no password, no confirmation", and
 * `/learn` tells the reader that "what you have read is recorded when you press the control at the
 * end of a lesson, and it is counted on your record". Nothing created the guest. `POST /auth/guest`
 * had exactly one caller in the whole client — `ensureSession` in `src/lib/table-rooms.ts`, reached
 * only by opening a table — so a reader who came to learn instead of to play stayed anonymous
 * forever.
 *
 * The API behaved correctly throughout and that is what made it invisible. A lesson read from an
 * anonymous caller answers `200` with `completedAt: null`, a scenario attempt answers `200` with
 * `recorded: false`, and `GET /me/progress` answers `401`. Honest, every one of them — and the
 * combined effect was a learner working through the curriculum while the product recorded nothing
 * and the screens said so in language most readers would not connect to "you have no account".
 *
 * ## Why the proxy, and not a client effect or a server component
 *
 * A **server component cannot set a cookie.** Next only permits that from a Server Action, a Route
 * Handler, or the proxy. So a `/learn` render could read a session but never create one.
 *
 * A **client effect can**, and that was the other candidate: call `ensureSession()` on mount. It
 * was rejected because the guest would then not exist until after hydration, so the *server* render
 * of `/learn` — the one that decides whether the page can show this reader's own "read" chips —
 * would still be anonymous, and the reader would have to navigate again before the page told them
 * the truth. Bootstrapping one request earlier removes that whole class of "correct on the second
 * page view" behaviour.
 *
 * The proxy runs in the **Node.js runtime** in Next 16 (it is the default, and the `runtime` option
 * is not even available there), which is what makes this possible at all: `PRL_API_ORIGIN` is read
 * from the live process environment rather than inlined at build time. `next.config.ts` explains at
 * length why that distinction is load-bearing in this repo.
 *
 * ## Idempotence, precisely
 *
 * Stated exactly, because "idempotent" is easy to claim and this one has a real boundary:
 *
 *  - **A request that carries a session cookie mints nothing.** That is the first check, it is a
 *    pure string test on the incoming cookie header, and it means every refresh, every in-app
 *    navigation, every RSC fetch and every parallel subresource of an already-bootstrapped visitor
 *    is free. An authenticated reader is therefore never replaced by a guest, and neither is a
 *    guest replaced by another guest.
 *  - **Only a top-level document navigation mints.** Prefetches, RSC payload fetches and asset
 *    requests are skipped, so the several requests a single page view generates cannot each create
 *    an account. The response sets the cookie, so everything that follows the first document
 *    already has it.
 *  - **Two genuinely simultaneous first navigations, in two tabs, from a browser that has never
 *    had a cookie, will mint two guests** and the second `Set-Cookie` wins. This is not fixable
 *    here and it is dishonest to pretend otherwise: before a cookie exists there is nothing on the
 *    wire that distinguishes "the same visitor twice" from "two visitors", and inventing a
 *    fingerprint to tell them apart would be both unreliable and a privacy regression. The cost is
 *    one unreferenced guest row with no progress on it.
 *
 * ## Failure is never the reader's problem
 *
 * If the API is unreachable or refuses, the page is served anyway, anonymous, exactly as it was
 * before this file existed. A learner must not be shown an error page because a background
 * convenience could not be arranged — and the screens all still tell the truth about what was
 * recorded, which is the property that makes failing open safe here.
 */

import { API_PATHS } from '@prl/contracts';
import { SESSION_COOKIE_NAMES } from './session-cookie-names.ts';

/**
 * Where the proxy reaches the API.
 *
 * Read at call time rather than at module load, so a test can set it and so nothing is captured
 * into a build. Same variable and same default as `API_ORIGIN` in `src/lib/api.ts`, deliberately:
 * two names for the API's address is how a deployment ends up half-configured.
 */
function apiOrigin(): string {
  return process.env['PRL_API_ORIGIN'] ?? 'http://localhost:3001';
}

/**
 * The routes a visitor is expected to reach without signing in, and which record something.
 *
 * Deliberately a list rather than "every page". Minting an account for a crawler that touches the
 * home page would fill `prl.users` with rows nobody asked for; these are the paths whose own copy
 * promises the reader that their progress is kept.
 *
 * `/play` is absent on purpose — it already mints through `ensureSession` before it opens a socket,
 * and doing it twice would be two mechanisms to keep in step.
 */
const GUEST_BOOTSTRAP_PREFIXES: readonly string[] = ['/learn', '/lab', '/record'];

export function pathNeedsGuest(pathname: string): boolean {
  return GUEST_BOOTSTRAP_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** True when the request already carries a session cookie under either of its two names. */
export function hasSessionCookie(cookieHeader: string | null): boolean {
  if (cookieHeader === null || cookieHeader === '') return false;
  const names = cookieHeader.split(';').map((pair) => pair.split('=')[0]?.trim() ?? '');
  return SESSION_COOKIE_NAMES.some((name) => names.includes(name));
}

/**
 * True for a prefetch under either spelling: a request for a page nobody has opened.
 *
 * `next-router-prefetch` is what the App Router sends. `purpose: prefetch` is the older, wider
 * convention that a browser (`<link rel="prefetch">`), a corporate proxy or a link scanner may send
 * on its own, and it says nothing about what the SERVER will do with it.
 *
 * This is the test for "was this request the reader's idea", which is the question minting an
 * account turns on. It is NOT the test for "will this be answered with a page" — see
 * `isRouterPrefetch`, and see the comment on the proxy `matcher`, where confusing the two served
 * the whole of a gated page to anybody who set one header.
 */
export function isPrefetch(headers: Headers): boolean {
  if (isRouterPrefetch(headers)) return true;
  return headers.get('purpose') === 'prefetch';
}

/**
 * True for a prefetch NEXT ITSELF will honour: one it answers with a routing stub, not with a page.
 *
 * The distinction is narrow and it was measured, because getting it wrong is not visible from
 * reading the code. `next-router-prefetch` is the only header that changes what Next renders: with
 * it, `/play` answers with 264 bytes of segment tree and no page content at all. `purpose:
 * prefetch` changes nothing on the server — the same request carrying it instead is answered with
 * the complete 38KB document, table and all.
 *
 * So a request wearing `purpose: prefetch` is a request for the page, whatever it calls itself, and
 * everything that acts on pages — the age gate, the Content-Security-Policy — has to treat it as
 * one. Only this narrow test may be used to decide "there is no page here to protect".
 *
 * `next-router-segment-prefetch` is deliberately not checked: it is one of Next's `FLIGHT_HEADERS`
 * and is stripped before middleware, so a test for it would be a line that reads as if it works.
 */
export function isRouterPrefetch(headers: Headers): boolean {
  return headers.get('next-router-prefetch') !== null;
}

/**
 * True for a top-level document navigation, as opposed to the several other things a page fetches.
 *
 * `Sec-Fetch-Dest` is the authoritative signal and every browser this app supports sends it. The
 * two Next-specific headers are checked as well because an RSC navigation is `empty`, not
 * `document`, and a router prefetch is answered with a stub rather than with a document.
 *
 * This answers what SHAPE a request is, not what should be done about it. In particular a request
 * carrying `purpose: prefetch` and `sec-fetch-dest: document` is a document navigation by this
 * test and reported as one, because Next answers it with a whole document — the caller that must
 * not mint an account for it says so itself, at its own call site, with `isPrefetch`.
 */
export function isDocumentNavigation(headers: Headers): boolean {
  if (headers.get('rsc') !== null) return false;
  if (isRouterPrefetch(headers)) return false;
  const dest = headers.get('sec-fetch-dest');
  // A missing header means a client that does not send it (curl, a health check). Treating that as
  // a document is the safe reading: it is a real request for a page, and it is the shape the
  // release smoke test uses.
  return dest === null || dest === 'document';
}

/**
 * True for an IN-APP router navigation: what a reader clicking a `<Link>` produces, where no
 * document request happens at all and the router fetches an RSC payload instead.
 *
 * Nothing in the guest bootstrap wants this — minting an account is a document-navigation-only
 * decision, and this file says why at length above. It lives here because this is the module that
 * owns "what shape of request is this", and the alternative is `src/proxy.ts` growing a second,
 * drifting copy of the same judgement for the age gate, which is the one caller that needs it.
 *
 * ## Why the `rsc` header cannot be the test, though it is the obvious one
 *
 * It was, and it did not work. Next strips its own `FLIGHT_HEADERS` — `rsc`,
 * `next-router-state-tree`, `next-router-prefetch`, `next-router-segment-prefetch`,
 * `next-hmr-refresh` — from the request BEFORE middleware runs. The line is in
 * `next/dist/server/web/adapter.js` and it is commented "Headers should only be stripped for
 * middleware"; the values are put back onto the response as `x-middleware-request-*` afterwards, so
 * the renderer still sees them and only the middleware does not. The effect is total:
 * `headers.get('rsc')` is null on every request middleware will ever be handed, including the
 * router navigations it is trying to catch.
 *
 * That is a silent failure of exactly the kind this repository keeps writing about. A gate written
 * against `rsc` reads correctly, passes every unit test that constructs a `Headers` by hand, gates
 * every document navigation it is pointed at — and lets a reader through on a single in-app click,
 * because the header it is looking for was deleted upstream. It was measured, in a real Chrome,
 * against a real production build, by `scripts/age-gate-audit.mjs`, which exists for this.
 *
 * ## What is used instead
 *
 * `Sec-Fetch-Dest: empty` — the value a browser puts on a `fetch()`. Combined with the matcher's
 * prefetch exclusion and with `isDocumentNavigation` handling `document` and the absent-header
 * case, that partitions every request for a page route into: a document, a prefetch, or a fetch
 * made by page script. The third is the router, and on the routes this is used for there is
 * nothing else it could be — this app's own `fetch` calls all go to `/api/*`, which the proxy
 * matcher excludes.
 *
 * A browser too old to send `Sec-Fetch-*` at all falls into `isDocumentNavigation`'s null case and
 * is treated as a document, which is the safe direction: it is gated rather than let through.
 *
 * The `rsc` test is kept, above the `Sec-Fetch-Dest` one and knowing it is dead today, because it
 * costs a line and the failure it would prevent is a runtime that stops stripping the header while
 * ALSO not sending `Sec-Fetch-*` — a client that would otherwise slip between the two tests.
 *
 * ## Why GET and HEAD only
 *
 * A Server Action is a POST to the page's own URL with `Sec-Fetch-Dest: empty`, and answering one
 * with a redirect would break it rather than gate it. This app has no Server Actions today (there
 * is no `'use server'` anywhere in `apps/web`), so the restriction changes nothing now and stops a
 * future one from being broken by a control that was never aimed at it. A Server Action can only
 * be invoked from a page the reader has already been served, which is the request that IS gated.
 */
export function isRouterNavigation(headers: Headers, method: string): boolean {
  if (isRouterPrefetch(headers)) return false;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (headers.get('rsc') !== null) return true;
  return headers.get('sec-fetch-dest') === 'empty';
}

/** Everything the caller has to do with the result: cookies to forward, and cookies to return. */
export interface MintedGuest {
  /** `name=value` pairs to add to the forwarded request, so this render already has the session. */
  readonly requestCookies: readonly string[];
  /** Raw `Set-Cookie` values from the API, to be replayed to the browser verbatim. */
  readonly setCookies: readonly string[];
}

/**
 * Two calls, in this order, because the API requires a double-submit CSRF token on every mutation.
 *
 * `GET /auth/session` mints the token and sets its paired secret cookie; `POST /auth/guest` needs
 * both. This is the same sequence `ensureSession` in `src/lib/table-rooms.ts` performs from the
 * browser, and it is spelled out again here rather than shared because the two run in different
 * worlds: that one has a cookie jar and `credentials: 'include'`, this one has neither and must
 * carry every cookie by hand.
 *
 * `origin` is the page's own origin, forwarded so the API's exact-match `PUBLIC_WEB_ORIGIN`
 * allowlist sees the same value a browser would send. Sending something else would either be
 * refused or, worse, quietly widen what that allowlist means.
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
    // The CSRF secret goes onto the forwarded request too. The render itself never mutates
    // anything, but the browser is about to be given both cookies and they are a matched pair —
    // handing over half of one would leave the first client-side mutation failing its CSRF check.
    requestCookies: [...csrfPairs, sessionPair],
    setCookies: [...seedCookies, ...guestCookies],
  };
}

/** `name=value` from a `Set-Cookie` value, dropping every attribute. Null for a malformed one. */
function cookiePair(setCookie: string): string | null {
  const first = setCookie.split(';')[0]?.trim() ?? '';
  return first.includes('=') && !first.startsWith('=') ? first : null;
}

function isSessionPair(pair: string): boolean {
  const name = pair.split('=')[0] ?? '';
  return (SESSION_COOKIE_NAMES as readonly string[]).includes(name);
}

/** The token out of a `SessionResponse`, without trusting the shape of a JSON body. */
function readCsrfToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const token = (body as { readonly csrfToken?: unknown }).csrfToken;
  return typeof token === 'string' && token !== '' ? token : null;
}
