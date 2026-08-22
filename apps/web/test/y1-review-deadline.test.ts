/**
 * A hand review must be given longer than the server is allowed to spend building it.
 *
 * ## What went wrong
 *
 * `GET /api/v1/hands/:handId` computes its answer. Nothing derived is stored, so every read re-runs
 * the Coach over every hero decision — a bounded Monte Carlo each — and the route sets its own
 * ceiling for that work in `apps/api/src/routes/hands.ts`:
 *
 *     budgetMs: Math.floor(app.appConfig.requestTimeoutMs / 2)
 *
 * which at the shipped `REQUEST_TIMEOUT_MS` of 20 s is ten seconds. The web client gave every call
 * four seconds. So a healthy server doing less than half its declared maximum of work lost the race
 * to its own client, `lib/api.ts` reported the abort as `transport` — "there is no API" — and
 * `/review/[handId]` fell through to a fixture that carries only sample hands and called
 * `notFound()`. A learner opening their own four-seat showdown was told, in the product's own
 * words, "there is nothing at this address". Measured at the time: 6,272 / 6,444 / 6,959 ms for
 * that hand, against 1,426 and 1,834 ms for two smaller ones that rendered.
 *
 * ## What this pins, and why it reads the API's source
 *
 * The correct deadline is not a number somebody liked; it is a window bounded at both ends by
 * figures the API already publishes:
 *
 *     analysis budget  <  the client's deadline for this endpoint  <  the API's request timeout
 *
 * Both bounds move if the API's config changes — halving `REQUEST_TIMEOUT_MS` halves the review
 * budget with it — so this test re-derives them from `apps/api/src/config.ts` and
 * `apps/api/src/routes/hands.ts` rather than restating them. Reading across the app boundary is
 * deliberate and is the only thing that makes this gate capable of failing for the right reason:
 * a constant copied into this file would be a second source of truth that goes stale silently,
 * which is the failure mode the audit kept finding.
 *
 * If either figure cannot be located the test FAILS rather than skipping. A gate that quietly
 * passes when it cannot find its subject is the other failure mode the audit kept finding.
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

/** `20_000`, `20000` and `20e3` are all the same number to TypeScript; only the first two appear. */
function asInteger(raw: string, what: string): number {
  const value = Number.parseInt(raw.replaceAll('_', ''), 10);
  assert.ok(
    Number.isSafeInteger(value) && value > 0,
    `${what} did not parse as a positive integer (got ${JSON.stringify(raw)}).`,
  );
  return value;
}

/**
 * The API's whole-request timeout, from the fallback in its own config reader.
 *
 * A deployment can raise or lower it; the fallback is what this repository ships and what the
 * hand-review budget below is derived from, so it is the figure this deadline is designed against.
 */
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

/**
 * The share of a request the hand-review route may spend on analysis.
 *
 * Expressed in the route as a divisor rather than a constant, on purpose — its comment says so:
 * "shortening `REQUEST_TIMEOUT_MS` tightens this automatically rather than leaving a second number
 * to remember." So this reads the divisor, not a number.
 */
function reviewAnalysisBudgetMs(requestTimeoutMs: number): number {
  const source = readRepo('apps', 'api', 'src', 'routes', 'hands.ts');
  // The receiver is deliberately loose — the route has spelled it `app.appConfig.requestTimeoutMs`
  // and `config.requestTimeoutMs` at different times and the two mean the same thing. What this
  // check actually depends on is the DIVISOR, so that is the only part pinned tightly.
  const matches = [
    ...source.matchAll(/budgetMs:\s*Math\.floor\(\s*[A-Za-z.]*requestTimeoutMs\s*\/\s*(\d+)\s*\)/gu),
  ];
  assert.ok(
    matches.length > 0,
    'Could not find the analysis budget GET /hands/:handId gives itself in apps/api/src/routes/hands.ts. ' +
      'The web client’s deadline for that endpoint is derived from it and must stay above it; if the ' +
      'route now expresses its budget differently, update the pattern here rather than deleting the check.',
  );

  // There is more than one review-shaped route (the hand review and the Legends comparison), and
  // the web client applies ONE deadline to both. If they ever disagree, the client's deadline is
  // right for one of them and wrong for the other — and it would be wrong silently, which is the
  // whole failure mode this file exists to prevent. So the check is that they agree, not that the
  // first one found is acceptable.
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
    // The defect, stated as an inequality. At the shipped configuration this is 15,000 > 10,000;
    // before the fix the client's only deadline was 4,000, and the endpoint could legitimately
    // spend two and a half times that before answering.
    assert.ok(
      EXPENSIVE_READ_TIMEOUT_MS > budgetMs,
      `The web client gives GET /hands/:handId ${String(EXPENSIVE_READ_TIMEOUT_MS)} ms, but the route ` +
        `may spend ${String(budgetMs)} ms on analysis alone before it starts returning ` +
        '`analysis: null`. A deadline below that budget aborts healthy work, and the abort is ' +
        'indistinguishable from an absent API — which is how a hand that exists came to render a 404.',
    );
  });

  it('is short enough that the SERVER gives up first, with a code and a request id', () => {
    // Losing this race matters. A server-side timeout arrives as a contract error with a request id
    // that correlates to a log line; a client-side abort arrives as `transport` and explains nothing.
    assert.ok(
      EXPENSIVE_READ_TIMEOUT_MS < requestTimeoutMs,
      `The web client waits ${String(EXPENSIVE_READ_TIMEOUT_MS)} ms but the API gives up at ` +
        `${String(requestTimeoutMs)} ms, so the client would abort a request the server was about to ` +
        'answer — and would throw away the code and request id that say why.',
    );
  });

  it('is not the default deadline, which stays short for the reads that do not compute', () => {
    // The fix is a second deadline, not a longer one. Raising the default would make every screen
    // in the app — including the session read in the shell, on every page — wait fifteen seconds on
    // a hung API.
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
