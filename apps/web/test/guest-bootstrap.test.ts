/**
 * The guest session Learn and the Scenario Lab mint for a first-time visitor.
 *
 * ## The defect (PROD-048)
 *
 * `POST /auth/guest` had one caller in the whole client — `ensureSession` in `table-rooms.ts`,
 * reached only by opening a table. So a reader who came to Learn instead of to Play never got an
 * account, and every recording endpoint answered them honestly and uselessly: a lesson read came
 * back `completedAt: null`, a scenario attempt `recorded: false`, and `GET /me/progress` a 401 —
 * while `/learn` told them their reading "is counted on your record".
 *
 * Reproduced before the fix by fetching `/learn`, then `/learn/pot-odds`, then `/lab` with one
 * cookie jar and finding it empty, and `GET /auth/session` answering `user: null`.
 *
 * ## What is asserted here, and what is asserted elsewhere
 *
 * Here: the three decisions the proxy makes before it does anything at all (is this a path that
 * needs a guest, is there already a session, is this a document navigation), and the two-call CSRF
 * exchange itself against a stub. These are the parts that decide whether an account is created,
 * so they are the parts a regression would land in.
 *
 * Elsewhere: `scripts/smoke-test.mjs` **§11 "Guest bootstrap on Learn"** drives a real production
 * server — fresh jar to `/learn`, assert a session cookie comes back, assert it resolves to a guest
 * account, navigate and refresh and fire three concurrent requests and assert nothing further is
 * minted, assert a prefetch mints nothing, and finally record a lesson read as that guest and
 * assert the server stored it. A stub cannot prove the cookie reaches the browser.
 *
 * The section number is checked here rather than remembered: it was cited as §12 for two releases,
 * and §12 is the rate-limit flood, which deliberately runs LAST and drains the limiter's bucket. A
 * reader sent there to see the guest walk would have found a section whose whole purpose is to make
 * `POST /auth/guest` answer 429. Sending somebody to the wrong evidence is the same defect as
 * having none.
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
    // `/play` mints through `ensureSession` before it opens a socket; two mechanisms for one
    // account is two things to keep in step. The rest must not create rows for a passing crawler.
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
    // This is the check that stops an authenticated reader being replaced by a guest, so a
    // substring match here would be a real bug rather than a tidiness point.
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
    // No `Sec-Fetch-Dest` at all: curl, a health check, the smoke test. A real page request.
    assert.equal(isDocumentNavigation(headers({})), true);
  });

  it('refuses the several other requests one page view makes', () => {
    // Each of these would otherwise create its own account for a single page view, which is the
    // shape of "idempotent bootstrap" going wrong.
    assert.equal(isDocumentNavigation(headers({ rsc: '1' })), false);
    assert.equal(isDocumentNavigation(headers({ 'next-router-prefetch': '1' })), false);
    assert.equal(isDocumentNavigation(headers({ 'sec-fetch-dest': 'empty' })), false);
    assert.equal(isDocumentNavigation(headers({ 'sec-fetch-dest': 'script' })), false);
    assert.equal(isDocumentNavigation(headers({ 'sec-fetch-dest': 'image' })), false);
  });

  it('reports a purpose:prefetch document as the document Next will answer it with', () => {
    // This used to be false, and the reason it changed is worth keeping: `purpose: prefetch`
    // changes nothing about what the server renders — such a request for `/play` is answered with
    // the complete document, table and all, while `next-router-prefetch` is answered with a routing
    // stub. So it IS a document navigation, and the age gate and the CSP both have to treat it as
    // one. Not minting for it is a separate rule and now lives at the call site in `src/proxy.ts`.
    assert.equal(isDocumentNavigation(headers({ purpose: 'prefetch', 'sec-fetch-dest': 'document' })), true);
    assert.equal(isPrefetch(headers({ purpose: 'prefetch' })), true);
    assert.equal(isRouterPrefetch(headers({ purpose: 'prefetch' })), false);
  });

  it('separates "nobody asked for this" from "there is no page here"', () => {
    // The two tests answer different questions and the whole `purpose: prefetch` hole was the
    // result of one being used for the other's job.
    assert.equal(isPrefetch(headers({ 'next-router-prefetch': '1' })), true);
    assert.equal(isRouterPrefetch(headers({ 'next-router-prefetch': '1' })), true);
    assert.equal(isPrefetch(headers({})), false);
    assert.equal(isRouterPrefetch(headers({})), false);
    // Only the literal value counts, so a stray `purpose: navigate` is not a prefetch.
    assert.equal(isPrefetch(headers({ purpose: 'navigate' })), false);
  });
});

/**
 * `isRouterNavigation` is the age gate's half of the same question, and it exists because the
 * obvious implementation of it was wrong in a way nothing here could see.
 *
 * The gate used to ask `headers.get('rsc') !== null`, which is the header the App Router really
 * sends — and which Next deletes, along with the rest of its `FLIGHT_HEADERS`, before middleware
 * runs. A test that builds a `Headers` by hand cannot reproduce that deletion, so the honest thing
 * to state here is what these assertions are and are not: they pin the DECISION, and the proof
 * that the decision is being handed the headers it thinks it is belongs to
 * `scripts/age-gate-audit.mjs`, which clicks a real `<Link>` in a real Chrome against a real
 * production build. Neither half is sufficient alone. That is the whole lesson of the defect.
 *
 * The case that matters most below is the `sec-fetch-dest: empty` one WITHOUT an `rsc` header: it
 * is the shape a router navigation actually arrives in, and under the old test it was allowed
 * straight through a gate that was switched on.
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
    // And still accepts an `rsc` header if some runtime ever stops stripping it.
    assert.equal(isRouterNavigation(headers({ rsc: '1' }), 'GET'), true);
  });

  it('refuses a prefetch under either spelling', () => {
    // Redirecting one of these would put the interstitial into the router cache for a page the
    // reader never opened, which is a worse failure than not gating it: the prefetch itself
    // renders nothing.
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'empty', rsc: '1' }), 'GET'), true);
    assert.equal(
      isRouterNavigation(headers({ 'sec-fetch-dest': 'empty', 'next-router-prefetch': '1' }), 'GET'),
      false,
    );
    assert.equal(isRouterNavigation(headers({ rsc: '1', 'next-router-prefetch': '1' }), 'GET'), false);
    // And the other spelling is NOT excluded, because Next answers it with the page rather than
    // with a stub. See `isRouterPrefetch` for the measurement behind that asymmetry.
    assert.equal(
      isRouterNavigation(headers({ 'sec-fetch-dest': 'empty', purpose: 'prefetch' }), 'GET'),
      true,
    );
  });

  it('refuses the requests that are not navigations at all', () => {
    // A document is a navigation, but it is `isDocumentNavigation`'s to report, not this one's;
    // the proxy asks both. Subresources are nobody's.
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'document' }), 'GET'), false);
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'image' }), 'GET'), false);
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'script' }), 'GET'), false);
    assert.equal(isRouterNavigation(headers({}), 'GET'), false);
  });

  it('refuses a POST, so a Server Action is never answered with a redirect', () => {
    // A Server Action posts to the page's own URL with `sec-fetch-dest: empty`. Gating one would
    // break it rather than gate it, and the page it was invoked from was gated already.
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'empty' }), 'POST'), false);
    assert.equal(isRouterNavigation(headers({ 'sec-fetch-dest': 'empty' }), 'HEAD'), true);
  });
});

// ---------------------------------------------------------------------------
// The exchange
// ---------------------------------------------------------------------------

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
  // Not `async`: nothing in here awaits, and `fetch`'s contract is a promise rather than an async
  // function. Returning `Promise.resolve(...)` says the same thing and keeps biome's
  // "async without await" rule meaningful for the code that really does need it.
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

    // The double-submit pair: the header token and the cookie the API issued with it. Sending one
    // without the other is refused by `@fastify/csrf-protection`, which is the point of the pair.
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

    // Replayed verbatim: the attributes (`HttpOnly`, `Max-Age`, `SameSite`, and `Secure`/`__Host-`
    // in production) are the API's decision, and rewriting them here would be a second, weaker
    // cookie policy that nobody reviews.
    assert.deepEqual(minted.setCookies, [
      'prl_csrf=secret-1; Path=/; HttpOnly; SameSite=Lax',
      'prl_session=session-1; Max-Age=1209599; Path=/; HttpOnly; SameSite=Lax',
    ]);

    // The forwarded request gets pairs only — no attributes, because this is a `Cookie` header
    // being sent, not a `Set-Cookie` being stored.
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
