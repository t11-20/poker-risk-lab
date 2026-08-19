/**
 * "We could not find out" must never be rendered as "there is no such thing".
 *
 * ## The defect, which was the same defect twice
 *
 * Both `/review/[handId]` and `/lab/[scenarioId]` loaded their subject, and both collapsed four
 * unrelated outcomes into one `null`:
 *
 *   - the API answered 404 for this id                → really is "no such thing"
 *   - the API could not be reached, or timed out      → nothing is known about this id
 *   - the reader has no session to look it up with    → nothing is known about this id
 *   - the bundled fixture does not carry this id      → says nothing about this id at all
 *
 * and then answered `notFound()` for all four. So a hand that demonstrably exists rendered
 * "404 — Page not found. There is nothing at this address" whenever the review took longer than the
 * client's deadline, and thirty of the API's thirty-six scenarios did the same whenever the API was
 * down, because the bundle carries six. A learner who bookmarked a scenario was told it had never
 * existed.
 *
 * ## What is asserted
 *
 * Two things, and the first is the load-bearing one.
 *
 * **Behavioural:** a timed-out request really does arrive as `transport` and really is classified
 * as an outage rather than as a missing resource. That is the premise the whole defect rests on —
 * an abort was being handed to a `null` that meant "not found" — and it is proved here with a real
 * `apiGet` call against a real `AbortSignal`, not asserted about.
 *
 * **Structural:** neither page may reach `notFound()` from anything except the API's own 404, and
 * each must carry the screen that says what actually happened. These are source assertions because
 * the loaders are private to their page modules and a page module cannot be imported outside a
 * Next render. They are written against the shape of the decision rather than against prose, so
 * they fail if the branch comes back, not merely if a sentence is reworded.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ApiRequestError, apiGet, isApiUnavailable, isMissingResource } from '../src/lib/api.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), 'utf8');

/**
 * The same file with its comment lines dropped.
 *
 * These pages explain at length WHY they used to answer 404 and no longer do, so the prose names
 * `notFound()` several times. Counting call sites has to look at code only, or the explanation of
 * the defect would trip the check that the defect is gone.
 */
const codeOnly = (source: string): string =>
  source
    .split('\n')
    .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/u.test(line))
    .join('\n');

const REVIEW_PAGE = ['app', 'review', '[handId]', 'page.tsx'] as const;
const SCENARIO_PAGE = ['app', 'lab', '[scenarioId]', 'page.tsx'] as const;

describe('a deadline that expires is an outage, and never a missing resource', () => {
  it('surfaces as a transport failure that isApiUnavailable owns and isMissingResource does not', async () => {
    // A server that accepts the connection and then takes longer than we allow. This is exactly
    // what the hand-review endpoint looked like from the client at a four-second deadline.
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

  it('reaches notFound() from the missing state and from nothing else', () => {
    assert.match(
      page,
      /data\.state === 'missing'\)\s*notFound\(\)/u,
      'The not-found screen must be gated on the state that means the API itself answered 404.',
    );
    const calls = codeOnly(page).match(/notFound\(\)/gu) ?? [];
    assert.equal(
      calls.length,
      1,
      `notFound() is called ${String(calls.length)} times in this page. There is exactly one condition ` +
        'that earns it — a 404 from the API about an id the reader supplied — and every extra call site ' +
        'is a chance to tell a reader that something which exists does not.',
    );
  });

  it('does not turn "the fixture has no such hand" into a not-found screen', () => {
    // The exact line that produced the defect was
    //   `return fixture === null ? null : { review: fixture, fromFixture: true };`
    // — a bundle miss, rendered as a missing hand.
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
    // A 401 says something about this browser and nothing about the hand. It used to reach the same
    // `null` as everything else.
    assert.match(page, /cause: ReviewFallbackCause = isSignedOut\(error\) \? 'signedOut' : 'unreachable'/u);
    assert.match(page, /This replay needs a session/u);
  });
});

describe('/lab/[scenarioId] answers 404 only when the API said 404', () => {
  const page = read(...SCENARIO_PAGE);

  it('reaches its outage screen when the bundle does not carry the scenario', () => {
    assert.match(
      page,
      /data\.state === 'missing'\)\s*notFound\(\)/u,
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

  it('still names the scenario it could not stage, from the bundled index', () => {
    // The index of all thirty-six titles ships even though only six bodies do, so this page can say
    // WHICH scenario failed to load. "Rule of 4: a big draw on the flop could not be loaded" and
    // "there is nothing at this address" are not the same message.
    assert.match(page, /function ScenarioUnavailable/u);
    assert.match(page, /LAB_SCENARIO_SUMMARIES\.find\(\(candidate\) => candidate\.id === scenarioId\)/u);
    assert.match(page, /not one of the six carried in the\s*\n?\s*bundled copy/u);
  });

  it('leaves the second, legitimate 404 in place', () => {
    // A scenario whose seats or cards will not parse cannot be staged, and that IS a 404: the
    // alternative is a question asked without the situation it needs. Widening the first fix into
    // this one would be the opposite error.
    assert.match(page, /if \(table === null\) notFound\(\);/u);
  });
});
