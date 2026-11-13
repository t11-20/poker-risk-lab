/**
 * A hand review must be given longer than the server may spend building it. The route's analysis
 * budget is `requestTimeoutMs / 2` (10 s at the shipped 20 s), and a 4 s client deadline once turned a
 * 6.3 to 7 s review into "there is nothing at this address". The window is
 *
 *     analysis budget  <  the client's deadline for this endpoint  <  the API's request timeout
 *
 * Both bounds are re-derived from `apps/api` source, so they move with its config. A figure that
 * cannot be located fails the test rather than skipping.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { EXPENSIVE_READ_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../src/lib/api.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const WEB_SRC = resolve(HERE, '..', 'src');

const readRepo = (...parts: readonly string[]): string => readFileSync(join(REPO, ...parts), 'utf8');
const readWeb = (...parts: readonly string[]): string => readFileSync(join(WEB_SRC, ...parts), 'utf8');

/** `20_000` and `20000` both appear in the source. */
function asInteger(raw: string, what: string): number {
  const value = Number.parseInt(raw.replaceAll('_', ''), 10);
  assert.ok(
    Number.isSafeInteger(value) && value > 0,
    `${what} did not parse as a positive integer (got ${JSON.stringify(raw)}).`,
  );
  return value;
}

/** The API's request timeout, from the fallback in its config reader, which is what ships. */
function apiRequestTimeoutMs(): number {
  const source = readRepo('apps', 'api', 'src', 'config.ts');
  const match = /requestTimeoutMs:\s*readInt\([\s\S]{0,400}?fallback:\s*([\d_]+)/u.exec(source);
  assert.ok(
    match?.[1] !== undefined,
    'Could not find the fallback for REQUEST_TIMEOUT_MS in apps/api/src/config.ts. This test ' +
      'derives the web client’s hand-review deadline from it, so it must not guess: find where the ' +
      'API now states its request timeout and update the pattern here.',
  );
  return asInteger(match[1], 'the API’s REQUEST_TIMEOUT_MS fallback');
}

/** The analysis divisor, read rather than restated, because the route derives its budget from it. */
function reviewAnalysisBudgetMs(requestTimeoutMs: number): number {
  const source = readRepo('apps', 'api', 'src', 'routes', 'hands.ts');
  // The receiver has been spelled two ways, so only the divisor is pinned tightly.
  const matches = [
    ...source.matchAll(/budgetMs:\s*Math\.floor\(\s*[A-Za-z.]*requestTimeoutMs\s*\/\s*(\d+)\s*\)/gu),
  ];
  assert.ok(
    matches.length > 0,
    'Could not find the analysis budget GET /hands/:handId gives itself in apps/api/src/routes/hands.ts. ' +
      'The web client’s deadline for that endpoint is derived from it and must stay above it; if the ' +
      'route now expresses its budget differently, update the pattern here rather than deleting the check.',
  );

  // The hand review and the Legends comparison share one client deadline, so they must agree.
  const divisors = new Set(matches.map((match) => asInteger(match[1] ?? '', 'a review budget divisor')));
  assert.equal(
    divisors.size,
    1,
    `apps/api/src/routes/hands.ts states ${divisors.size} different analysis budgets ` +
      `(divisors ${[...divisors].join(', ')}). The web client has one deadline for these routes, so ` +
      'it cannot be correct for all of them. Make them agree, or give the client a deadline per route.',
  );
  const divisor = [...divisors][0] ?? 0;
  return Math.floor(requestTimeoutMs / divisor);
}

describe('the hand-review deadline sits inside the window the API defines', () => {
  const requestTimeoutMs = apiRequestTimeoutMs();
  const budgetMs = reviewAnalysisBudgetMs(requestTimeoutMs);

  it('is longer than the analysis the server is allowed to perform', () => {
    // At the shipped configuration this is 15,000 > 10,000. Before the fix the client gave 4,000.
    assert.ok(
      EXPENSIVE_READ_TIMEOUT_MS > budgetMs,
      `The web client gives GET /hands/:handId ${String(EXPENSIVE_READ_TIMEOUT_MS)} ms, but the route ` +
        `may spend ${String(budgetMs)} ms on analysis alone before it starts returning ` +
        '`analysis: null`. A deadline below that budget aborts healthy work, and the abort is ' +
        'indistinguishable from an absent API — which is how a hand that exists came to render a 404.',
    );
  });

  it('is short enough that the SERVER gives up first, with a code and a request id', () => {
    // A server timeout carries a request id that maps to a log line. A client abort is `transport`.
    assert.ok(
      EXPENSIVE_READ_TIMEOUT_MS < requestTimeoutMs,
      `The web client waits ${String(EXPENSIVE_READ_TIMEOUT_MS)} ms but the API gives up at ` +
        `${String(requestTimeoutMs)} ms, so the client would abort a request the server was about to ` +
        'answer — and would throw away the code and request id that say why.',
    );
  });

  it('is not the default deadline, which stays short for the reads that do not compute', () => {
    // A second deadline, not a longer default, so the shell's session read never waits 15 s.
    assert.ok(
      REQUEST_TIMEOUT_MS < EXPENSIVE_READ_TIMEOUT_MS,
      'The ordinary deadline should stay well below the one for endpoints that compute.',
    );
    assert.ok(
      REQUEST_TIMEOUT_MS <= 5_000,
      `The default deadline is ${String(REQUEST_TIMEOUT_MS)} ms. It exists to keep a server render ` +
        'from hanging on an API that accepts a connection and never answers; if it has grown to the ' +
        'point of being a substitute for the per-endpoint deadline, the shell is paying for it.',
    );
  });
});

describe('the review route actually uses that deadline', () => {
  it('passes it on the call that builds the hand review', () => {
    // The constant existing changes nothing on its own. This is the line that was missing.
    const page = readWeb('app', 'review', '[handId]', 'page.tsx');
    assert.match(
      page,
      /API_PATHS\.hand\(handId\)[\s\S]{0,200}timeoutMs:\s*EXPENSIVE_READ_TIMEOUT_MS/u,
      'apps/web/src/app/review/[handId]/page.tsx must give the hand-review call the ' +
        'EXPENSIVE_READ_TIMEOUT_MS deadline. Without it the call takes the four-second default, and ' +
        'the hands worth reviewing — the ones with several decisions in them — abort and render a 404.',
    );
  });
});
