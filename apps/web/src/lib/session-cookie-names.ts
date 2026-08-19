/**
 * The two names the API's session cookie can have. Nothing else lives in this file.
 *
 * ## Why it is its own module
 *
 * It used to be declared in `server-session.ts`, which is the right home for the *forwarding*
 * logic and the wrong home for a constant: that module imports `cookies()` from `next/headers`, so
 * anything that needs only the names — `guest-bootstrap.ts`, which runs in the proxy and has no
 * request scope, and any plain `node --test` file — had to drag a server-only framework import in
 * with them, or copy the list. Copying it is the one outcome that must not happen: the list is a
 * client-side literal of a name the SERVER owns, and a rename that the two copies disagreed about
 * would silently sign every server render out with no error anywhere.
 *
 * `apps/api/test/session-cookie-names.test.ts` reads this file's source and asserts the list is
 * exactly the set `sessionCookieName()` can emit across environments.
 *
 * ## Why there are two
 *
 * `__Host-` is a browser-enforced guarantee — exact host, `Secure`, `Path=/`, no `Domain` — and it
 * cannot be used over plain HTTP, so development gets the unprefixed name and production gets the
 * prefixed one (`apps/api/src/plugins/security.ts`). They are one cookie under two naming regimes.
 * Ordered with the prefixed one first, so that if both are somehow present the one carrying the
 * stronger guarantee is the one used.
 */

export const SESSION_COOKIE_NAMES = ['__Host-prl_session', 'prl_session'] as const;
