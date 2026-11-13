/**
 * The guest session Learn and the Scenario Lab mint for a first-time visitor (PROD-048). Only opening
 * a table used to create an account, so a Learn reader's reads were never recorded.
 * This pins the proxy's decisions and the two-call CSRF exchange against a stub. That the cookie
 * reaches a browser is `scripts/smoke-test.mjs` §11 "Guest bootstrap on Learn" against a real server.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  GUEST_MINT_TIMEOUT_MS,
  hasSessionCookie,
  isDocumentNavigation,
  isPrefetch,
  isRouterNavigation,
  isRouterPrefetch,
  mintGuestSession,
  pathNeedsGuest,
} from '../src/lib/guest-bootstrap.ts';

describe('which requests may mint a guest', () => {
  it('covers the paths whose own copy promises the reader a record', () => {
    for (const path of ['/learn', '/learn/pot-odds', '/lab', '/lab/river-bluff-catch', '/record']) {
      assert.equal(pathNeedsGuest(path), true, `${path} must bootstrap`);
    }
  });

  it('leaves every other path alone', () => {
    // `/play` mints through `ensureSession` before it opens a socket. The rest must not create rows
    // for a passing crawler.
    for (const path of ['/', '/play', '/legends', '/legends/compare', '/review', '/learn-more', '/labs']) {
      assert.equal(pathNeedsGuest(path), false, `${path} must not bootstrap`);
    }
  });
});

describe('a request that already has a session', () => {
  it('is recognised under both cookie names', () => {
    assert.equal(hasSessionCookie('prl_session=abc'), true);
    assert.equal(hasSessionCookie('__Host-prl_session=abc'), true);
    assert.equal(hasSessionCookie('prl_csrf=x; __Host-prl_session=abc; other=1'), true);
    assert.equal(hasSessionCookie(' prl_session=abc '), true);
  });

  it('is not confused by a cookie whose name merely contains the session name', () => {
    // This stops an authenticated reader being replaced by a guest, so a substring match is a real bug.
    assert.equal(hasSessionCookie('not_prl_session=abc'), false);
    assert.equal(hasSessionCookie('prl_session_backup=abc'), false);
    assert.equal(hasSessionCookie('prl_csrf=abc'), false);
    assert.equal(hasSessionCookie(''), false);
    assert.equal(hasSessionCookie(null), false);
  });
});

describe('only a top-level document navigation mints', () => {
  const headers = (entries: Record<string, string>): Headers => new Headers(entries);

  it('accepts a document request', () => {
    assert.equal(isDocumentNavigation(headers({ 'sec-fetch-dest': 'document' })), true);
    // No `Sec-Fetch-Dest` at all is curl, a health check or the smoke test.
    assert.equal(isDocumentNavigation(headers({})), true);
  });

  it('refuses the several other requests one page view makes', () => {
    // Each of these would otherwise create its own account for one page view.
    assert.equal(isDocumentNavigation(headers({ rsc: '1' })), false);
    assert.equal(isDocumentNavigation(headers({ 'next-router-prefetch': '1' })), false);
    assert.equal(isDocumentNavigation(headers({ 'sec-fetch-dest': 'empty' })), false);
    assert.equal(isDocumentNavigation(headers({ 'sec-fetch-dest': 'script' })), false);
    assert.equal(isDocumentNavigation(headers({ 'sec-fetch-dest': 'image' })), false);
  });

  it('reports a purpose:prefetch document as the document Next will answer it with', () => {
    // Next answers `purpose: prefetch` with the complete document, so it is a document navigation for
    // the age gate and the CSP. Not minting for it is a separate rule, at the call site in `src/proxy.ts`.
    assert.equal(isDocumentNavigation(headers({ purpose: 'prefetch', 'sec-fetch-dest': 'document' })), true);
    assert.equal(isPrefetch(headers({ purpose: 'prefetch' })), true);
    assert.equal(isRouterPrefetch(headers({ purpose: 'prefetch' })), false);
  });

  it('separates "nobody asked for this" from "there is no page here"', () => {
    // The `purpose: prefetch` hole came from using one of these for the other's job.
    assert.equal(isPrefetch(headers({ 'next-router-prefetch': '1' })), true);
    assert.equal(isRouterPrefetch(headers({ 'next-router-prefetch': '1' })), true);
    assert.equal(isPrefetch(headers({})), false);
    assert.equal(isRouterPrefetch(headers({})), false);
    assert.equal(isPrefetch(headers({ purpose: 'navigate' })), false);
  });
});

/**
 * The age gate's half. Next deletes `rsc` and the other `FLIGHT_HEADERS` before middleware runs, so
 * a router navigation arrives as `sec-fetch-dest: empty` with no `rsc`. These pin the decision, and
 * `scripts/age-gate-audit.mjs` proves the headers in a real Chrome. Neither is sufficient alone.
 */
describe('an in-app router navigation is a navigation for gating, and a prefetch is not', () => {
  const headers = (entries: Record<string, string>): Headers => new Headers(entries);

  it('accepts the shape a router navigation really arrives in', () => {
    // No `rsc` header, because Next has already removed it. This is the regression.
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'empty' }), 'GET'), true);
    assert.equal(
      isRouterNavigation(
        headers({ 'sec-fetch-dest': 'empty', 'sec-fetch-mode': 'cors', 'sec-fetch-site': 'same-origin' }),
        'GET',
      ),
      true,
    );
    assert.equal(isRouterNavigation(headers({ rsc: '1' }), 'GET'), true);
  });

  it('refuses a prefetch under either spelling', () => {
    // Redirecting a prefetch would cache the interstitial for a page the reader never opened.
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'empty', rsc: '1' }), 'GET'), true);
    assert.equal(
      isRouterNavigation(headers({ 'sec-fetch-dest': 'empty', 'next-router-prefetch': '1' }), 'GET'),
      false,
    );
    assert.equal(isRouterNavigation(headers({ rsc: '1', 'next-router-prefetch': '1' }), 'GET'), false);
    // `purpose: prefetch` is not excluded, because Next answers it with the page (see `isRouterPrefetch`).
    assert.equal(
      isRouterNavigation(headers({ 'sec-fetch-dest': 'empty', purpose: 'prefetch' }), 'GET'),
      true,
    );
  });

  it('refuses the requests that are not navigations at all', () => {
    // A document is `isDocumentNavigation`'s to report, and the proxy asks both.
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'document' }), 'GET'), false);
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'image' }), 'GET'), false);
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'script' }), 'GET'), false);
    assert.equal(isRouterNavigation(headers({}), 'GET'), false);
  });

  it('refuses a POST, so a Server Action is never answered with a redirect', () => {
    // A Server Action posts to the page's URL with `sec-fetch-dest: empty`, and a redirect would break it.
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'empty' }), 'POST'), false);
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'empty' }), 'HEAD'), true);
  });
});

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubApi(options: {
  readonly sessionStatus?: number;
  readonly guestStatus?: number;
  readonly guestSetCookie?: readonly string[];
  readonly csrfToken?: string | null;
}): Recorded[] {
  const calls: Recorded[] = [];
  // Not `async`, because nothing here awaits, which keeps biome's async-without-await rule meaningful.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (init?.signal?.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return Promise.reject(error);
    }
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });

    if (url.endsWith('/auth/session')) {
      const status = options.sessionStatus ?? 200;
      const body = JSON.stringify({
        user: null,
        csrfToken: options.csrfToken === undefined ? 'token-abc' : options.csrfToken,
        protocolVersion: 1,
        oidcEnabled: false,
      });
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.append('set-cookie', 'prl_csrf=secret-1; Path=/; HttpOnly; SameSite=Lax');
      return Promise.resolve(new Response(status === 200 ? body : '{}', { status, headers }));
    }

    const headers = new Headers({ 'content-type': 'application/json' });
    for (const cookie of options.guestSetCookie ?? [
      'prl_session=session-1; Max-Age=1209599; Path=/; HttpOnly; SameSite=Lax',
    ]) {
      headers.append('set-cookie', cookie);
    }
    return Promise.resolve(
      new Response('{"user":{"id":"usr_1"}}', { status: options.guestStatus ?? 201, headers }),
    );
  }) as typeof fetch;
  return calls;
}

describe('minting the session', () => {
  it('reads a CSRF token first, then presents it and its cookie on the mutation', async () => {
    const calls = stubApi({});
    const minted = await mintGuestSession({ origin: 'http://localhost:3000' });

    assert.ok(minted !== null);
    assert.equal(calls.length, 2, 'exactly two calls: the token, then the account');
    assert.match(calls[0]?.url ?? '', /\/auth\/session$/);
    assert.equal(calls[0]?.method, 'GET');
    assert.match(calls[1]?.url ?? '', /\/auth\/guest$/);
    assert.equal(calls[1]?.method, 'POST');

    // `@fastify/csrf-protection` refuses the header token without the cookie issued with it.
    assert.equal(calls[1]?.headers.get('x-csrf-token'), 'token-abc');
    assert.match(calls[1]?.headers.get('cookie') ?? '', /prl_csrf=secret-1/);
  });

  it('forwards the page’s own origin, so the API allowlist sees what a browser would send', () => {
    const calls = stubApi({});
    return mintGuestSession({ origin: 'https://lab.example' }).then(() => {
      for (const call of calls) assert.equal(call.headers.get('origin'), 'https://lab.example');
    });
  });

  it('returns the session cookie for the browser and for this render', async () => {
    stubApi({});
    const minted = await mintGuestSession({ origin: 'http://localhost:3000' });
    assert.ok(minted !== null);

    // Replayed verbatim, because the attributes are the API's cookie policy.
    assert.deepEqual(minted.setCookies, [
      'prl_csrf=secret-1; Path=/; HttpOnly; SameSite=Lax',
      'prl_session=session-1; Max-Age=1209599; Path=/; HttpOnly; SameSite=Lax',
    ]);

    // Pairs only, because this is a `Cookie` header being sent, not a `Set-Cookie` being stored.
    assert.deepEqual(minted.requestCookies, ['prl_csrf=secret-1', 'prl_session=session-1']);
    for (const pair of minted.requestCookies) assert.ok(!pair.includes(';'));
  });

  it('handles the production cookie name, which is prefixed', async () => {
    stubApi({
      guestSetCookie: ['__Host-prl_session=s2; Max-Age=1209599; Path=/; Secure; HttpOnly; SameSite=Lax'],
    });
    const minted = await mintGuestSession({ origin: 'https://lab.example' });
    assert.ok(minted !== null);
    assert.ok(minted.requestCookies.includes('__Host-prl_session=s2'));
  });

  it('returns null when the request is aborted, rather than throwing', async () => {
    stubApi({});
    assert.equal(
      await mintGuestSession({ origin: 'http://localhost:3000', signal: AbortSignal.abort() }),
      null,
    );
  });

  it('caps the mint so a down API cannot stall the first Learn document', () => {
    assert.ok(GUEST_MINT_TIMEOUT_MS >= 1_000 && GUEST_MINT_TIMEOUT_MS <= 8_000);
  });

  it('gives up rather than half-succeeding', async () => {
    for (const broken of [
      { what: 'the session read failed', options: { sessionStatus: 503 } },
      { what: 'no CSRF token came back', options: { csrfToken: null } },
      { what: 'the guest route refused', options: { guestStatus: 429 } },
      { what: 'no session cookie was issued', options: { guestSetCookie: [] } },
      { what: 'only an unrelated cookie was issued', options: { guestSetCookie: ['other=1; Path=/'] } },
    ]) {
      stubApi(broken.options);
      assert.equal(
        await mintGuestSession({ origin: 'http://localhost:3000' }),
        null,
        `${broken.what}: must return null so the page is served anonymous rather than broken`,
      );
    }
  });
});
