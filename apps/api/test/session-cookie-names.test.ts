/**
 * Server renders forward the session cookie by name, from the list in
 * `apps/web/src/lib/session-cookie-names.ts`, so the CSRF secret and other cookies stay behind.
 * A rename on the server would silently make every server render signed out. The client's list
 * must be exactly the two names the server emits, `__Host-` in production and unprefixed over HTTP.
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

/** Read as source, because this package cannot resolve `@prl/web`'s module graph. */
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
    // A server render holding the CSRF secret could act as the reader with no user gesture.
    // The compare screen uses `serverCsrfHandshake` in `apps/web/src/lib/api.ts` instead.
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
