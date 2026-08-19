/**
 * The reader's session, on the server side of a render.
 *
 * ## The problem this closes
 *
 * `src/lib/api.ts` sets `credentials: 'include'` on every request, and that flag is a *browser*
 * instruction. Node's `fetch` has no cookie jar and no document, so on the server it is inert. A
 * server component therefore called the API as an anonymous stranger, and every per-reader
 * endpoint answered `not_authenticated` — correctly. The visible consequence was that `/review`
 * and `/review/[handId]` could never show a signed-in reader their own hand history: they printed
 * a notice explaining that this page is rendered where there is no session to read it with, and
 * fell back to a bundled fixture, for every reader, in every deployment.
 *
 * The fix is to forward the reader's session cookie from the incoming request. `next/headers`
 * exposes it: `cookies()` is a request-scoped read that also marks the route dynamic, which is
 * correct here — a page whose content is one reader's private history must not be cached or
 * prerendered.
 *
 * ## THE SECURITY BOUNDARY, WHICH IS THE REASON THIS IS ITS OWN MODULE
 *
 * Forwarding credentials from one request into another is the mechanism behind a whole family of
 * server-side request forgery bugs, so the rules are narrow and stated rather than implied:
 *
 *  1. **Only the session cookie leaves this module.** Not the `Cookie` header, not "every cookie
 *     whose name starts with `prl_`", not the CSRF secret. `SESSION_COOKIE_NAMES` is the entire
 *     list, and it is two entries only because the API prefixes the name with `__Host-` in
 *     production and not in development (`apps/api/src/plugins/security.ts`). Both spellings are
 *     the same one cookie under two naming regimes.
 *
 *     The CSRF secret is deliberately excluded even though forwarding it would make a server-side
 *     `POST` possible. A server render has no user gesture behind it, so a mutation issued from
 *     one is precisely the request CSRF exists to stop; the honest way to reach a POST endpoint is
 *     from the browser, which holds the token legitimately. See `src/app/legends/compare`.
 *
 *  2. **It can only ever be sent to this deployment's own API.** The value produced here is
 *     consumed by `ApiCallOptions.cookie`, and `call()` in `api.ts` builds every URL as
 *     `API_ORIGIN` plus a path from `API_PATHS`. No caller anywhere supplies a host, so there is
 *     no arrangement of these functions that sends the cookie to a third party. That property
 *     lives in `api.ts`; this module's job is to make sure that what arrives there is only ever
 *     the one cookie.
 *
 *  3. **This must not be generalised.** A `forwardCredentials(headers, url)` helper — the obvious
 *     "tidier" version — would be a function whose whole purpose is to send a credential to a URL
 *     a caller chose. If a future feature needs to call a second host, it needs its own
 *     credential for that host, not this one.
 *
 * ## Import rule
 *
 * `next/headers` is server-only. Importing this module from a client component is a build error,
 * which is the desired failure: it is caught at compile time rather than by a runtime check that
 * somebody could delete. That is also why this is not in `api.ts` — the app shell's `SiteHeader`
 * is a client component and imports `fetchSession` from there.
 */

import { cookies } from 'next/headers';
import type { ApiCallOptions } from './api.ts';
import { SESSION_COOKIE_NAMES } from './session-cookie-names.ts';

/**
 * Re-exported so the forwarding rule below and its one list of names stay next to each other in a
 * reader's mind. The declaration moved to `session-cookie-names.ts` — a leaf with no `next/headers`
 * import — because the proxy's guest bootstrap needs the names and must not pull a server-only
 * module into the Node runtime it runs in. That file explains the rest.
 */
export { SESSION_COOKIE_NAMES } from './session-cookie-names.ts';

/**
 * The reader's session cookie as a `name=value` pair, or null when they are not signed in.
 *
 * The value is not parsed, validated or inspected: it is a signed opaque token that only the API
 * can verify, and a client that formed an opinion about its contents would be a second
 * implementation of the session format.
 */
export async function readerSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const found = jar.get(name);
    if (found !== undefined) return `${name}=${found.value}`;
  }
  return null;
}

/**
 * Call options that carry the reader's session, for a per-reader read during a server render.
 *
 * Returns `{}` for a signed-out reader rather than a `cookie` of `''`: `exactOptionalPropertyTypes`
 * means the property is either present and a string or absent, and an empty header would be a
 * request that claims to carry a session and does not.
 *
 * Merge extra options into the result at the call site — this owns the cookie and nothing else.
 */
export async function readerCallOptions(): Promise<ApiCallOptions> {
  const cookie = await readerSessionCookie();
  return cookie === null ? {} : { cookie };
}
