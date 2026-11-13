/**
 * The two names the API's session cookie can have, in a module with no imports so the proxy and
 * `node --test` can load it. `apps/api/test/session-cookie-names.test.ts` holds it to the server.
 * `__Host-` cannot be set over plain HTTP, so development uses the unprefixed name. The prefixed one is
 * first, so the stronger guarantee wins if both are present.
 */

export const SESSION_COOKIE_NAMES = ['__Host-prl_session', 'prl_session'] as const;
