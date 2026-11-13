/**
 * Forwards the reader's session cookie into server-render API calls. `credentials: 'include'` is inert
 * in Node, so without this every per-reader read was anonymous. `cookies()` also marks the route
 * dynamic, which a page of one reader's private history needs.
 *
 * Security boundary:
 *  - Only the session cookie leaves this module. Never the whole header, and never the CSRF secret,
 *    because a server render has no user gesture behind it and must not mutate.
 *  - `call()` in `api.ts` builds every URL from `API_ORIGIN`, so the cookie only reaches our own API.
 *  - Never generalise this into a helper that sends a credential to a caller-chosen URL.
 * `next/headers` is server-only, so importing this from a client component fails the build.
 */

import { cookies } from 'next/headers';
import type { ApiCallOptions } from './api.ts';
import { SESSION_COOKIE_NAMES } from './session-cookie-names.ts';

/** Declared in the leaf `session-cookie-names.ts` so the proxy can use it without `next/headers`. */
export { SESSION_COOKIE_NAMES } from './session-cookie-names.ts';

/** `name=value`, or null. The value is an opaque token only the API verifies, so it is never parsed. */
export async function readerSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const found = jar.get(name);
    if (found !== undefined) return `${name}=${found.value}`;
  }
  return null;
}

/** `{}` when there is no session, never an empty `cookie`, which would claim a session it lacks. */
export async function readerCallOptions(): Promise<ApiCallOptions> {
  const cookie = await readerSessionCookie();
  return cookie === null ? {} : { cookie };
}
