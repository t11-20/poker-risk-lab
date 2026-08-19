/**
 * The web client forwards the session cookie by NAME, so the two spellings must be the same two.
 *
 * ## Why a test rather than a comment
 *
 * A server render has no cookie jar: `credentials: 'include'` is a browser instruction and does
 * nothing in Node, so `/review` and `/review/[handId]` asked the API for one reader's private hand
 * history as an anonymous stranger and were correctly refused. Every reader saw "your history is
 * private and this page has no session to read it with" over a bundled fixture.
 *
 * The fix reads the cookie out of the incoming request and forwards it — and forwarding by name is
 * what makes it narrow. `apps/web/src/lib/session-cookie-names.ts` carries the list, deliberately, so
 * that it forwards the session cookie and NOT the CSRF secret, not a third-party cookie, and not
 * the whole `Cookie` header. The cost of that narrowness is a literal on the client side of a name
 * the server owns: rename it here and every server render silently becomes signed-out again, with
 * no error anywhere and a page that looks like a correct empty state.
 *
 * That is a failure with no symptom, which is the kind worth a test.
 *
 * ## Both spellings, because the prefix is environment-dependent
 *
 * `__Host-` is a browser-enforced guarantee that requires `Secure`, so it cannot be used over plain
 * HTTP and development gets the unprefixed name. Both are the same cookie under two naming regimes
 * and the client accepts either; this asserts the client's list is exactly the set the server can
 * emit, with nothing extra in it.
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { csrfCookieName, sessionCookieName } from '../src/plugins/security.ts';

const CLIENT_MODULE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'web',
  'src',
  'lib',
  'session-cookie-names.ts',
);

/**
 * The client's list, read as source.
 *
 * It lives in `session-cookie-names.ts`, a leaf module with no imports at all — it moved out of
 * `server-session.ts` so that the proxy's guest bootstrap could use the names without dragging
 * `next/headers` into the Node runtime. Read rather than imported all the same: this package
 * cannot resolve `@prl/web`'s module graph, and this file is asserting a fact about two lists of
 * strings, which does not need a module loader.
 */
async function clientCookieNames(): Promise<readonly string[]> {
  const source = await (await import('node:fs/promises')).readFile(CLIENT_MODULE, 'utf8');
  const match = /export const SESSION_COOKIE_NAMES = \[([^\]]*)\]/.exec(source);
  assert.ok(match !== null, 'SESSION_COOKIE_NAMES is not declared where this test expects it');
  const body = match[1] ?? '';
  return [...body.matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? '');
}

function nameFor(isProduction: boolean): string {
  return sessionCookieName(
    loadConfig({
      NODE_ENV: isProduction ? 'production' : 'development',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
      PUBLIC_WEB_ORIGIN: isProduction ? 'https://example.test' : 'http://localhost:3000',
      SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    }),
  );
}

describe('the web client forwards the cookie this API actually sets', () => {
  it('lists exactly the two names the server can emit', async () => {
    const server = new Set([nameFor(true), nameFor(false)]);
    assert.deepEqual(new Set(await clientCookieNames()), server);
  });

  it('prefers the __Host- spelling, which carries the stronger guarantee', async () => {
    const names = await clientCookieNames();
    assert.equal(names[0], nameFor(true), 'the prefixed name must be tried first');
  });

  it('does not forward the CSRF secret', async () => {
    // Forwarding it would let a server render mint a valid token and act as the reader — a request
    // with no user gesture behind it, which is precisely what the CSRF check exists to stop. The
    // compare screen reaches its POST by completing its own anonymous handshake instead; see
    // `serverCsrfHandshake` in `apps/web/src/lib/api.ts`.
    const names = await clientCookieNames();
    for (const production of [true, false]) {
      const csrf = csrfCookieName(
        loadConfig({
          NODE_ENV: production ? 'production' : 'development',
          DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
          PUBLIC_WEB_ORIGIN: production ? 'https://example.test' : 'http://localhost:3000',
          SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
        }),
      );
      assert.ok(!names.includes(csrf), `${csrf} must never be in the forwarding list`);
    }
  });
});
