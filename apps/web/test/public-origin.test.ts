/**
 * Regression test: the origin the proxy presents to the API must be the PUBLIC one.
 *
 * ## The defect
 *
 * `proxy.ts` mints a guest by calling the API server-to-server, and the API exact-matches the
 * `Origin` header against its `PUBLIC_WEB_ORIGIN` allowlist. The proxy sent
 * `request.nextUrl.origin` — the address the container itself was reached at. Behind a reverse
 * proxy that is not the browser's origin, so the API answered `403 cross-origin POST from an
 * origin that is not allowlisted` and guest bootstrap was broken on every real deployment.
 *
 * Measured before the fix, in a production-configured staging stack: with `Host`,
 * `X-Forwarded-Proto` and `X-Forwarded-Host` all set to `localhost:8443`, the web container
 * still sent `origin: https://localhost:3000`.
 *
 * It passed unnoticed because the development stack publishes the proxy on port 3000 and the web
 * container listens on 3000, so the wrong value and the right value happened to coincide. Every
 * case below therefore uses a public origin that DIFFERS from the request's own — the coincidence
 * is the thing that hid this, so no case is allowed to reproduce it.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes. Reverting `publicOriginFor` to return `input.requestOrigin` fails 7 of the eleven cases
 * below. That was run, not assumed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalisePublicOrigin, publicOriginFor } from '../src/lib/public-origin.ts';

/** Headers as the proxy sees them, without needing a `NextRequest`. */
function headers(entries: Readonly<Record<string, string>> = {}): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}

/** The container's own listening address. Never the right answer behind a proxy. */
const CONTAINER_ORIGIN = 'https://localhost:3000';

describe('the origin presented to the API', () => {
  it('prefers PUBLIC_WEB_ORIGIN, because that is the list the API matches against', () => {
    const origin = publicOriginFor({
      env: { PUBLIC_WEB_ORIGIN: 'https://app.example' },
      headers: headers({ 'x-forwarded-host': 'somewhere-else.example' }),
      requestOrigin: CONTAINER_ORIGIN,
    });
    assert.equal(origin, 'https://app.example');
  });

  it('takes the first usable entry of a list, matching the API treating webOrigins[0] as canonical', () => {
    const origin = publicOriginFor({
      env: { PUBLIC_WEB_ORIGIN: 'https://app.example, https://alt.example' },
      headers: headers(),
      requestOrigin: CONTAINER_ORIGIN,
    });
    assert.equal(origin, 'https://app.example');
  });

  it('skips an unusable head rather than disabling the mechanism it exists to fix', () => {
    const origin = publicOriginFor({
      env: { PUBLIC_WEB_ORIGIN: 'https://app.example/deep/path, https://alt.example' },
      headers: headers(),
      requestOrigin: CONTAINER_ORIGIN,
    });
    assert.equal(origin, 'https://alt.example');
  });

  it('tolerates a trailing slash, which the API refuses at boot but which is harmless here', () => {
    // The API compares raw strings, so a trailing slash in ITS allowlist matches nothing and it
    // refuses to start. This module compares nothing — it builds a value — so normalising through
    // `URL.origin` makes the slash a non-event rather than a silent fallback to the wrong origin.
    const origin = publicOriginFor({
      env: { PUBLIC_WEB_ORIGIN: 'https://app.example/' },
      headers: headers(),
      requestOrigin: CONTAINER_ORIGIN,
    });
    assert.equal(origin, 'https://app.example');
  });

  it('falls back to the forwarded host and protocol when nothing is configured', () => {
    const origin = publicOriginFor({
      env: {},
      headers: headers({ 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' }),
      requestOrigin: CONTAINER_ORIGIN,
    });
    assert.equal(origin, 'https://app.example');
  });

  it('takes the FIRST forwarded host, which is the hop nearest the browser', () => {
    // Taking the last would name whichever proxy is nearest to us — the internal address this
    // module exists to stop sending.
    const origin = publicOriginFor({
      env: {},
      headers: headers({
        'x-forwarded-host': 'app.example, internal.svc.cluster.local',
        'x-forwarded-proto': 'https, http',
      }),
      requestOrigin: CONTAINER_ORIGIN,
    });
    assert.equal(origin, 'https://app.example');
  });

  it('keeps a non-default port from the forwarded host, because an origin includes it', () => {
    const origin = publicOriginFor({
      env: {},
      headers: headers({ 'x-forwarded-host': 'localhost:8443', 'x-forwarded-proto': 'https' }),
      requestOrigin: CONTAINER_ORIGIN,
    });
    assert.equal(origin, 'https://localhost:8443', 'this is the exact case measured in staging');
  });

  it('uses the request origin only when there is no configuration and no proxy', () => {
    const origin = publicOriginFor({
      env: {},
      headers: headers(),
      requestOrigin: 'http://localhost:3000',
    });
    assert.equal(origin, 'http://localhost:3000');
  });

  it('ignores a forwarded host that is not a usable origin, rather than building nonsense', () => {
    const origin = publicOriginFor({
      env: {},
      headers: headers({ 'x-forwarded-host': 'not a host', 'x-forwarded-proto': 'https' }),
      requestOrigin: 'http://localhost:3000',
    });
    assert.equal(origin, 'http://localhost:3000');
  });
});

describe('normalisePublicOrigin refuses what would match nothing', () => {
  it('accepts a bare origin, lower-cases it, and drops a trailing slash', () => {
    assert.equal(normalisePublicOrigin('HTTPS://App.Example'), 'https://app.example');
    assert.equal(normalisePublicOrigin('https://app.example:8443'), 'https://app.example:8443');
    assert.equal(normalisePublicOrigin('https://app.example/'), 'https://app.example');
  });

  it('refuses the shapes that silently match nothing', () => {
    // Each of these is a real way an allowlist entry has been got wrong before: they parse as
    // URLs, so nothing complains, and then no comparison ever succeeds.
    for (const bad of [
      'https://app.example/path',
      'https://app.example?a=1',
      'https://app.example#x',
      'https://user:pw@app.example',
      'https://*.example',
      'https://app.example.',
      'ftp://app.example',
      'not-a-url',
      '',
    ]) {
      assert.equal(normalisePublicOrigin(bad), null, `"${bad}" must be refused`);
    }
  });
});
