/**
 * "We could not find out" must never be rendered as "there is no such thing". A real timeout is
 * classified as an outage, and the page sources are read because a page module needs a Next render.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiRequestError, apiGet, isApiUnavailable, isMissingResource } from '../src/lib/api.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/** Drops comment lines, so the pages' prose about `notFound()` does not count as a call site. */
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
    .join('\n');

const REVIEW_PAGE = ['app', 'review', '[handId]', 'page.tsx'] as const;
const SCENARIO_PAGE = ['app', 'lab', '[scenarioId]', 'page.tsx'] as const;

describe('a deadline that expires is an outage, and never a missing resource', () => {
  it('surfaces as a transport failure that isApiUnavailable owns and isMissingResource does not', async () => {
    // Accepts the connection and never answers, as the hand-review endpoint did at a four-second deadline.
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: { readonly signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined) return;
        signal.addEventListener('abort', () => {
          reject(signal.reason);
        });
      })) as typeof globalThis.fetch;

    try {
      const failure = await apiGet('/api/v1/hands/hand_slow', { timeoutMs: 5 }).then(
        () => null,
        (error: unknown) => error,
      );

      assert.ok(
        failure instanceof ApiRequestError,
        'A timeout must arrive as this client’s own error type, carrying a code the caller can branch on.',
      );
      assert.equal(failure.code, 'transport');
      assert.equal(failure.status, 0);
      assert.equal(
        isApiUnavailable(failure),
        true,
        'A timeout is an outage: nothing routed the request, so nothing was learned about the id in it.',
      );
      assert.equal(
        isMissingResource(failure),
        false,
        'A timeout must never satisfy the predicate whose whole meaning is "the API says this does not ' +
          'exist". Everything downstream of that distinction — including whether a real hand renders a ' +
          '404 — depends on it.',
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('/review/[handId] answers 404 only when the API said 404', () => {
  const page = read(...REVIEW_PAGE);

  it('renders the 404 body from the missing state and from nothing else', () => {
    assert.match(
      page,
      /data\.state === 'missing'\) return <NotFoundBody \/>/u,
      'The not-found screen must be gated on the state that means the API itself answered 404.',
    );
    const calls = codeOnly(page).match(/notFound\(\)/gu) ?? [];
    assert.equal(
      calls.length,
      0,
      'In-page notFound() produces empty HTML in Next 16. Missing hands render NotFoundBody instead.',
    );
  });

  it('does not turn "the fixture has no such hand" into a not-found screen', () => {
    assert.doesNotMatch(
      page,
      /fixture === null \? null/u,
      'A hand absent from the bundled fixture says nothing about whether the hand exists. It must ' +
        'produce the "could not be loaded" screen, not `null`.',
    );
    assert.match(page, /state: 'unavailable'/u);
  });

  it('has a screen that names what happened instead of denying the hand', () => {
    assert.match(page, /not the same\s*'?\s*\+?\s*'?\s*as the hand not existing/u);
    assert.match(
      page,
      /What happened/u,
      'The transport failure is shown. "Could not reach the API at …: the operation was aborted due to ' +
        'timeout" is the difference between a reader retrying and a reader concluding their history is gone.',
    );
  });

  it('tells a signed-out reader that, rather than that the hand is missing', () => {
    // A 401 says something about this browser and nothing about the hand.
    assert.match(page, /cause: ReviewFallbackCause = isSignedOut\(error\) \? 'signedOut' : 'unreachable'/u);
    assert.match(page, /This replay needs a session/u);
  });
});

describe('/lab/[scenarioId] answers 404 only when the API said 404', () => {
  const page = read(...SCENARIO_PAGE);

  it('reaches its outage screen when the bundle does not carry the scenario', () => {
    assert.match(
      page,
      /data\.state === 'missing'\) return <NotFoundBody \/>/u,
      'The not-found screen must be gated on the API’s own 404.',
    );
    assert.doesNotMatch(
      page,
      /fixture === null \? null/u,
      'Thirty of the API’s thirty-six scenarios have no offline fixture. "Not in the bundle" is not ' +
        '"no such scenario".',
    );
    assert.match(page, /state: 'unavailable'/u);
  });

  it('still names the scenario it could not stage, from the bundled content', () => {
    // Every title ships in `@prl/content`, though only six analyses do (`lab-scenario-titles.test.ts`).
    assert.match(page, /function ScenarioUnavailable/u);
    assert.match(page, /const summary = bundledScenarioTitle\(scenarioId\);/u);
    assert.match(page, /not one of the six that ship with the\s*\n?\s*app/u);
  });

  it('leaves the second, legitimate 404 in place', () => {
    // A scenario whose seats or cards will not parse cannot be staged, and that IS a 404.
    assert.match(page, /if \(table === null\) return <NotFoundBody \/>/u);
  });
});
