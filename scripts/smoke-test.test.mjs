#!/usr/bin/env node
/**
 * Tests for the parts of `scripts/smoke-test.mjs` that decide things.
 *
 * Run with:  node --test scripts/smoke-test.test.mjs
 * Also run by:  pnpm run test:scripts
 *
 * ## What these exist to prevent
 *
 * The smoke script is a release gate, and a release gate that cannot be run twice in a row is a
 * gate nobody trusts. Section 12 deliberately exhausts the guest-creation limiter, that limiter is
 * keyed on the caller's ADDRESS (it has to be — the route issues the session an address-free key
 * would rotate), and its window is fixed rather than sliding. So a run ends with the counter over
 * the limit and most of a window still to go, and the next run is refused at section 2.
 *
 * The script now recovers from that: it resets the counters when the deployment has the reset
 * control, and waits out the window when it does not. Every decision in that recovery is pure and
 * is tested here, because every one of them can be wrong in a way that still looks like a working
 * script:
 *
 * 1. **The Retry-After parser.** `Number('-5')` is -5 and `Number('12.7')` is 12.7. A parser that
 *    uses `Number` alone turns a malformed or hostile header into an instant retry that fails
 *    again, or into a fractional-second wait, and the run then reports the wrong cause. So the
 *    parser accepts only a run of digits, and the negative controls below feed it every shape a
 *    naive parser would accept.
 *
 * 2. **The classifier.** Reading "the limiter is working" as "leftover quota from last run" costs
 *    one bounded wait. Reading it the other way round is the defect this whole change exists to
 *    remove: the run fails at section 2 and then four later sections fail for a reason that has
 *    nothing to do with rooms, hand history or progress. Both directions are asserted, including
 *    the exact boundary (a 429 on attempt N with a limit of N is leftover; on attempt N+1 it is
 *    the limiter).
 *
 * 3. **The bound.** A fallback that waits without a ceiling is a release gate that hangs. The
 *    bound is asserted to refuse, and — the part that matters — the healthy case is asserted to
 *    WAIT, because a planner that refuses everything would pass a file full of "assert refused".
 *
 * 4. **Argument parsing.** `--origin` is passed by `scripts/staging.mjs` on every staging smoke
 *    run, so a regression here breaks a gate rather than a convenience. Precedence (flag, then
 *    environment, then default) is asserted at each layer, and every refusal is asserted to name
 *    its reason rather than to say "invalid".
 *
 * 5. **The reset path, against the server's own constant.** The harness composes the path from
 *    `API_PREFIX` instead of writing one literal, because `apps/api/test/harness-paths.test.ts`
 *    extracts every `'/api/v1/...'` literal from the script and demands the server route it —
 *    which this route deliberately is not, unless RATE_LIMIT_RESET_TOKEN is configured. That
 *    dodge would have removed a real guard against drift, so the drift is caught here instead, by
 *    reading the exported constant out of the API source and comparing.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Checked by breaking each one on purpose while writing them:
 *
 *  * Parser: reverting `parseDeltaSeconds` to `Number(raw)` makes the `-5`, `12.7`, `1e3` and
 *    HTTP-date cases return numbers, and each of those is asserted `null` here. Confirmed by
 *    computing the naive answer inside the test and asserting it DIFFERS, so the negative control
 *    is a property of the test rather than of the current implementation.
 *  * Classifier: a version that always returns 'leftover' fails the boundary case; one that always
 *    returns 'working' fails the first-attempt case. Both are present.
 *  * Planner: a planner that ignored `maxWaitSeconds` fails the bound case; one that refused
 *    everything fails `waits out a window that fits inside the bound`.
 *  * Argument parsing: each refusal asserts on the MESSAGE, so a change that throws a generic
 *    'invalid' still fails.
 *  * Path drift: the extractor is fed a doctored source with a different path and asserted to
 *    return that different value, which is what proves it reads the file rather than restating a
 *    constant. It is also fed a source with the declaration deleted and asserted to return null.
 *
 * Every scan-style assertion also checks that it scanned something: the API source is asserted to
 * be substantial and to contain the neighbouring code, so a truncated or wrong file could not pass
 * quietly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyGuestLimit,
  classifyHostileRefusal,
  listIsMissingOrEmpty,
  originBucketNote,
  parseArgs,
  parseDeltaSeconds,
  planRecovery,
  RATE_LIMIT_RESET_PATH,
  RECOVERY_PADDING_SECONDS,
  recoveryWaitSeconds,
  sampledEquityMissesInterval,
  unentitledHoleCardSeats,
} from './smoke-test.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** An environment with nothing set, so a default is genuinely a default and not an inherited value. */
const EMPTY_ENV = Object.freeze({});

// ---------------------------------------------------------------------------
// The Retry-After parser
// ---------------------------------------------------------------------------

describe('parseDeltaSeconds', () => {
  it('reads the delta-seconds form this API actually sends', () => {
    assert.equal(parseDeltaSeconds('42'), 42);
    assert.equal(parseDeltaSeconds('0'), 0);
    // Whitespace around a header value is not part of it (RFC 9110 field values are trimmed).
    assert.equal(parseDeltaSeconds('  30  '), 30);
  });

  it('refuses every malformed shape a Number() parser would accept', () => {
    // The negative control. Each of these has a NUMERIC value under `Number`, which is exactly how
    // a malformed header becomes a wait of the wrong length or an instant retry.
    for (const malformed of ['-5', '12.7', '1e3', '0x10', ' +7', 'Infinity']) {
      assert.equal(parseDeltaSeconds(malformed), null, `"${malformed}" must not parse`);
      // And the property the assertion depends on: a naive parser really would have accepted it.
      // `!Number.isNaN` rather than `Number.isFinite`, because "Infinity" is precisely the case a
      // finite-only guard would already have caught and the others are the cases it would not.
      assert.ok(
        !Number.isNaN(Number(malformed.trim())),
        `"${malformed}" is not a useful negative control unless Number() accepts it`,
      );
    }
  });

  it('refuses the HTTP-date form rather than guessing at clock skew', () => {
    // RFC 9110 allows it, this API never sends it, and converting one needs both clocks to agree.
    // Returning null makes the run say "there is nothing to wait for" instead of waiting wrong.
    assert.equal(parseDeltaSeconds('Wed, 21 Oct 2026 07:28:00 GMT'), null);
  });

  it('refuses absence, emptiness and non-strings', () => {
    for (const absent of [null, undefined, '', '   ', 'soon', 42, {}]) {
      assert.equal(parseDeltaSeconds(absent), null, `${String(absent)} must not parse`);
    }
  });

  it('refuses a value too large to be a safe integer', () => {
    // A header of 25 nines parses as a finite Number and loses precision. A wait computed from it
    // is meaningless, and `--max-wait` would refuse it anyway — but silently rounding first is how
    // a bound gets compared against a number nobody produced.
    assert.equal(parseDeltaSeconds('9'.repeat(25)), null);
  });
});

describe('recoveryWaitSeconds', () => {
  it('takes the largest of the three sources a 429 carries', () => {
    // Retry-After and x-ratelimit-reset come from one ttl rounded in opposite directions, and the
    // harness gets exactly one retry. Believing the smaller one spends it a second early.
    assert.equal(recoveryWaitSeconds({ retryAfter: '30', rateLimitReset: '31', bodySeconds: 29 }), 31);
    assert.equal(recoveryWaitSeconds({ retryAfter: '31', rateLimitReset: '30', bodySeconds: 29 }), 31);
  });

  it('falls back to the body when a proxy has stripped the headers', () => {
    assert.equal(recoveryWaitSeconds({ retryAfter: null, rateLimitReset: null, bodySeconds: 17 }), 17);
  });

  it('falls back to a header when the body is not JSON at all', () => {
    assert.equal(recoveryWaitSeconds({ retryAfter: '17', rateLimitReset: null, bodySeconds: undefined }), 17);
  });

  it('returns null when nothing usable arrived, rather than inventing a wait', () => {
    assert.equal(
      recoveryWaitSeconds({ retryAfter: 'soon', rateLimitReset: '-1', bodySeconds: 'quick' }),
      null,
    );
    assert.equal(recoveryWaitSeconds({}), null);
    // A negative body value is not a duration either; `Math.max` would happily return it.
    assert.equal(recoveryWaitSeconds({ bodySeconds: -4 }), null);
  });
});

// ---------------------------------------------------------------------------
// Leftover quota versus a working limiter
// ---------------------------------------------------------------------------

describe('classifyGuestLimit', () => {
  it('calls a 429 leftover when this run cannot have caused it', () => {
    // Section 2 is the first guest creation of the run. A 429 there, against a limit of 10, can
    // only mean the previous run's section 12 drained the bucket.
    assert.equal(classifyGuestLimit({ attempt: 1, limit: 10 }), 'leftover');
  });

  it('calls a 429 the limiter working once this run has spent the budget', () => {
    // The negative control for the case above, and the one that matters: if this ever returns
    // 'leftover', the harness would wait out a limit that is genuinely too low and report a pause
    // instead of a misconfiguration.
    assert.equal(classifyGuestLimit({ attempt: 11, limit: 10 }), 'working');
    assert.equal(classifyGuestLimit({ attempt: 60, limit: 10 }), 'working');
  });

  it('puts the boundary where the limiter puts it', () => {
    // `max: 10` allows ten and refuses the eleventh. So a 429 on the tenth means somebody else
    // spent one, and a 429 on the eleventh is the documented behaviour.
    assert.equal(classifyGuestLimit({ attempt: 10, limit: 10 }), 'leftover');
    assert.equal(classifyGuestLimit({ attempt: 11, limit: 10 }), 'working');
  });

  it('says indeterminate rather than guessing when the limit was not stated', () => {
    for (const limit of [null, undefined, 0, -1, 'ten', 10.5]) {
      assert.equal(classifyGuestLimit({ attempt: 1, limit }), 'indeterminate', `limit ${String(limit)}`);
    }
    for (const attempt of [0, -1, null, 1.5]) {
      assert.equal(classifyGuestLimit({ attempt, limit: 10 }), 'indeterminate', `attempt ${String(attempt)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The recovery plan and its bound
// ---------------------------------------------------------------------------

const HEALTHY = Object.freeze({
  verdict: 'leftover',
  waitSeconds: 30,
  maxWaitSeconds: 90,
  alreadyWaited: false,
});

describe('planRecovery', () => {
  it('waits out a window that fits inside the bound', () => {
    // The positive control for every refusal below. A planner that refused everything would pass
    // all of them and break every fallback run.
    const plan = planRecovery(HEALTHY);
    assert.equal(plan.action, 'wait');
    assert.equal(plan.waitMs, (30 + RECOVERY_PADDING_SECONDS) * 1_000);
    assert.match(plan.reason, /30s left/);
  });

  it('pads the wait past the window boundary rather than landing on it', () => {
    // The store restarts a window when `iterationStartMs + timeWindow <= now`, and Retry-After is
    // already rounded to whole seconds. Waiting exactly the reported time can land inside.
    assert.ok(RECOVERY_PADDING_SECONDS >= 1, 'the padding must actually pad');
    assert.equal(planRecovery({ ...HEALTHY, waitSeconds: 0 }).waitMs, RECOVERY_PADDING_SECONDS * 1_000);
  });

  it('refuses a window longer than the bound, and says which bound', () => {
    const plan = planRecovery({ ...HEALTHY, waitSeconds: 91 });
    assert.equal(plan.action, 'abandon');
    assert.match(plan.reason, /exceeds the --max-wait bound of 90s/);
    assert.match(plan.reason, /RATE_LIMIT_RESET_TOKEN/, 'the refusal must name the deterministic fix');
    assert.equal(plan.waitMs, 0);
    // Exactly at the bound is still a wait; an off-by-one here silently halves the useful range.
    assert.equal(planRecovery({ ...HEALTHY, waitSeconds: 90 }).action, 'wait');
  });

  it('refuses to wait out a limiter that is working', () => {
    const plan = planRecovery({ ...HEALTHY, verdict: 'working' });
    assert.equal(plan.action, 'abandon');
    assert.match(plan.reason, /limiter working as documented/);
    assert.match(plan.reason, /too low/, 'the refusal must name the misconfiguration it found');
  });

  it('refuses a second wait inside one run', () => {
    const plan = planRecovery({ ...HEALTHY, alreadyWaited: true });
    assert.equal(plan.action, 'abandon');
    assert.match(plan.reason, /already waited/);
  });

  it('refuses when the 429 said nothing about how long to wait', () => {
    for (const waitSeconds of [null, undefined]) {
      const plan = planRecovery({ ...HEALTHY, waitSeconds });
      assert.equal(plan.action, 'abandon');
      assert.match(plan.reason, /no usable Retry-After/);
    }
  });

  it('checks the working verdict before the missing-header case', () => {
    // Order matters: a working limiter that also stripped its headers must be reported as a limit
    // that is too low, not as a header problem, because only the first is actionable.
    const plan = planRecovery({ ...HEALTHY, verdict: 'working', waitSeconds: null });
    assert.match(plan.reason, /limiter working as documented/);
  });

  it('accepts a bound of zero as "never wait"', () => {
    // `--max-wait 0` is the honest way to say "fail immediately rather than pause a pipeline".
    const plan = planRecovery({ ...HEALTHY, waitSeconds: 1, maxWaitSeconds: 0 });
    assert.equal(plan.action, 'abandon');
  });
});

// ---------------------------------------------------------------------------
// Which bucket a run consumes
// ---------------------------------------------------------------------------

describe('originBucketNote', () => {
  it('says a literal address pins the bucket', () => {
    assert.match(originBucketNote('http://127.0.0.1:3001'), /literal address/);
    assert.match(originBucketNote('http://[::1]:3001'), /literal address/);
  });

  it('warns that a hostname hands the bucket to DNS', () => {
    const note = originBucketNote('http://localhost:3001');
    assert.match(note, /hostname/);
    // The specific trap: the API deliberately does NOT fold ::1 into 127.0.0.1.
    assert.match(note, /::1 and 127\.0\.0\.1 are deliberately separate/);
  });
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to the literal loopback address and the dev web origin', () => {
    const options = parseArgs([], EMPTY_ENV);
    assert.equal(options.apiOrigin, 'http://127.0.0.1:3001');
    assert.equal(options.apiOriginSource, 'default');
    assert.equal(options.webOrigin, 'http://localhost:3000');
    assert.equal(options.strict, false);
    assert.equal(options.noReset, false);
    assert.equal(options.resetToken, '');
    assert.equal(options.maxWaitSeconds, 90);
  });

  it('prefers an explicit flag over the environment, and the environment over the default', () => {
    const env = { PRL_API_ORIGIN: 'http://api.internal:9001', PRL_WEB_ORIGIN: 'http://web.internal:9000' };
    const fromEnv = parseArgs([], env);
    assert.equal(fromEnv.apiOrigin, 'http://api.internal:9001');
    assert.equal(fromEnv.apiOriginSource, 'PRL_API_ORIGIN');
    assert.equal(fromEnv.webOrigin, 'http://web.internal:9000');

    const fromFlag = parseArgs(['--origin', 'http://127.0.0.1:4001'], env);
    assert.equal(fromFlag.apiOrigin, 'http://127.0.0.1:4001');
    assert.equal(fromFlag.apiOriginSource, '--origin');
  });

  it('reads the reset token from the flag, then PRL_, then the server variable', () => {
    // The last of those is deliberate: a developer whose local .env already carries the SERVER's
    // RATE_LIMIT_RESET_TOKEN gets deterministic isolation for free under --env-file.
    assert.equal(parseArgs([], { RATE_LIMIT_RESET_TOKEN: 'server' }).resetToken, 'server');
    assert.equal(
      parseArgs([], { RATE_LIMIT_RESET_TOKEN: 'server', PRL_RATE_LIMIT_RESET_TOKEN: 'harness' }).resetToken,
      'harness',
    );
    assert.equal(
      parseArgs(['--reset-token', 'flag'], {
        RATE_LIMIT_RESET_TOKEN: 'server',
        PRL_RATE_LIMIT_RESET_TOKEN: 'harness',
      }).resetToken,
      'flag',
    );
  });

  it('takes --strict from either the flag or the environment', () => {
    assert.equal(parseArgs(['--strict'], EMPTY_ENV).strict, true);
    assert.equal(parseArgs([], { PRL_SMOKE_STRICT: '1' }).strict, true);
    // Anything other than exactly "1" is not strict; a stray "true" must not silently arm a gate.
    assert.equal(parseArgs([], { PRL_SMOKE_STRICT: 'true' }).strict, false);
  });

  it('absorbs the -- that pnpm forwards', () => {
    // `pnpm run test:smoke -- --strict` passes the separator through as an argument.
    const options = parseArgs(['--', '--strict'], EMPTY_ENV);
    assert.equal(options.strict, true);
  });

  it('prints help without validating anything else', () => {
    // --help must work on a machine whose environment is nonsense, or it cannot explain how to fix
    // the environment.
    const options = parseArgs(['--help'], { PRL_API_ORIGIN: 'not-a-url' });
    assert.equal(options.help, true);
  });

  it('names the reason for every refusal', () => {
    // "invalid --origin" would send the reader to the source. Each of these says what is wrong.
    assert.throws(() => parseArgs(['--nope'], EMPTY_ENV), /unknown option --nope \(try --help\)/);
    assert.throws(() => parseArgs(['--origin'], EMPTY_ENV), /--origin needs a value/);
    assert.throws(() => parseArgs(['--max-wait'], EMPTY_ENV), /--max-wait needs a value/);
    assert.throws(() => parseArgs(['--max-wait', 'soon'], EMPTY_ENV), /--max-wait needs a number/);
    assert.throws(() => parseArgs(['--max-wait', '-1'], EMPTY_ENV), /whole number of seconds/);
    assert.throws(() => parseArgs(['--max-wait', '1.5'], EMPTY_ENV), /whole number of seconds/);
    assert.throws(() => parseArgs(['--max-wait', '601'], EMPTY_ENV), /exceeds 600s/);
    assert.throws(() => parseArgs(['--origin', 'ftp://host:21'], EMPTY_ENV), /must be http or https/);
    assert.throws(() => parseArgs(['--origin', 'nonsense'], EMPTY_ENV), /must be an absolute URL/);
    assert.throws(() => parseArgs(['--origin', 'http://h:1/api'], EMPTY_ENV), /no path, query or fragment/);
  });

  it('normalises an origin to scheme://host:port so two spellings cannot fork a bucket', () => {
    // A trailing slash is not a different origin, and the whole point of pinning the origin is
    // that one run and the next agree about which rate-limit bucket they are in.
    assert.equal(
      parseArgs(['--origin', 'http://127.0.0.1:3001/'], EMPTY_ENV).apiOrigin,
      'http://127.0.0.1:3001',
    );
  });

  it('accepts --no-reset, which is how the fallback gets exercised deliberately', () => {
    const options = parseArgs(['--no-reset', '--reset-token', 'x'], EMPTY_ENV);
    assert.equal(options.noReset, true);
    assert.equal(options.resetToken, 'x', 'the token is still parsed; --no-reset only declines to use it');
  });
});

// ---------------------------------------------------------------------------
// The reset path, against the server's own constant
// ---------------------------------------------------------------------------

/**
 * Reads `export const RATE_LIMIT_RESET_PATH = '...'` out of a TypeScript source.
 *
 * A text scan rather than an import because this is a `.mjs` test and the constant lives in a
 * `.ts` module with the repository's whole dependency graph behind it. The scan is narrow enough
 * to be unambiguous and is negative-controlled below.
 */
function exportedResetPath(source) {
  return /export const RATE_LIMIT_RESET_PATH = '([^']+)'/.exec(source)?.[1] ?? null;
}

describe('the reset path the harness posts to', () => {
  const securitySource = readFileSync(join(REPO_ROOT, 'apps/api/src/plugins/security.ts'), 'utf8');

  it('scanned the file it meant to scan', () => {
    // The scanned-set check. A truncated read, a moved file or a wrong path would otherwise make
    // every assertion below vacuous.
    assert.ok(securitySource.length > 12_000, `security.ts is only ${securitySource.length} bytes`);
    assert.match(securitySource, /clientKeyedRateLimit/, 'this is not the security plugin');
    assert.match(securitySource, /registerRateLimitResetRoute/, 'the reset control is not in this file');
  });

  it('matches the constant the server registers', () => {
    assert.equal(RATE_LIMIT_RESET_PATH, exportedResetPath(securitySource));
    assert.equal(RATE_LIMIT_RESET_PATH, '/api/v1/_test/rate-limit/reset');
  });

  it('would notice a rename: the extractor reads the file rather than restating a constant', () => {
    // The negative control. Feed it a doctored source and it must report the doctored value.
    const doctored = securitySource.replace(
      "export const RATE_LIMIT_RESET_PATH = '/api/v1/_test/rate-limit/reset'",
      "export const RATE_LIMIT_RESET_PATH = '/api/v1/_test/rate-limit/moved'",
    );
    assert.notEqual(doctored, securitySource, 'the replacement matched nothing, so this proves nothing');
    assert.equal(exportedResetPath(doctored), '/api/v1/_test/rate-limit/moved');
    assert.notEqual(exportedResetPath(doctored), RATE_LIMIT_RESET_PATH);
  });

  it('reports null when the declaration is gone entirely', () => {
    assert.equal(exportedResetPath('export const SOMETHING_ELSE = 1;'), null);
  });
});

/**
 * Removes comments, exactly as `apps/api/test/harness-paths.test.ts` does, so that a path
 * discussed in prose is not read as a path the script calls.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every `'/api/v1/...'` literal in a source, using harness-paths.test.ts's own extractor. */
function apiPathLiterals(source) {
  return [...stripComments(source).matchAll(/['"`](\/api\/v1\/[^'"`\s]*)['"`]/g)].map((match) => match[1]);
}

describe('the harness does not hand harness-paths.test.ts a route that must not exist', () => {
  const harnessSource = readFileSync(join(REPO_ROOT, 'scripts/smoke-test.mjs'), 'utf8');
  const literals = apiPathLiterals(harnessSource);

  it('scanned a real set of paths', () => {
    // Without this, an extractor that silently matched nothing would make the assertion below
    // pass for the wrong reason.
    assert.ok(literals.length > 12, `expected the harness to name many API paths, found ${literals.length}`);
    assert.ok(literals.includes('/api/v1/auth/guest'), 'the guest route is the one this whole file is about');
  });

  it('never writes the reset path as a single literal', () => {
    // `harness-paths.test.ts` extracts these literals and asserts the server routes every one.
    // That guard is right for all of them except this route, which is ABSENT unless
    // RATE_LIMIT_RESET_TOKEN is configured — its absence is the shipped state. Composing the path
    // from API_PREFIX keeps that guard honest instead of forcing it to demand a route production
    // must never serve.
    const offenders = literals.filter((path) => path.startsWith('/api/v1/_test/'));
    assert.deepEqual(offenders, [], 'compose the test-control path from API_PREFIX instead');
  });

  it('would notice if somebody inlined it', () => {
    // The negative control: the same detector, fed a source that really does inline the path.
    const doctored = `const p = '${RATE_LIMIT_RESET_PATH}';`;
    const offenders = apiPathLiterals(doctored).filter((path) => path.startsWith('/api/v1/_test/'));
    assert.deepEqual(offenders, [RATE_LIMIT_RESET_PATH]);
  });
});

// ---------------------------------------------------------------------------
// Assertions that must not evaporate when the field is absent
// ---------------------------------------------------------------------------

/**
 * Section 5's checks on the coach report and the equity result were written so that a MISSING
 * field produced neither a pass nor a failure. That is the worst of the three outcomes: an
 * empty list is a coach that stated nothing, and an absent block is a coach that has stopped
 * modelling the thing at all — and the run said neither.
 *
 * ## Would these fail against the old code?
 *
 * Yes, and it was checked that way rather than assumed. Each block below states the OLD
 * expression as well as the new one and asserts they DISAGREE on the absent case, so the
 * negative control is a property of this test rather than of the current implementation — a
 * revert to `?.length === 0` or `=== null` fails here, not merely a rename.
 */
describe('assertions about absence', () => {
  it('treats an empty list as missing, which is what it was already doing', () => {
    assert.equal(listIsMissingOrEmpty([]), true);
  });

  it('treats an ABSENT list as missing, which is what the old expression could not see', () => {
    const report = { suggestion: {} };
    assert.equal(listIsMissingOrEmpty(report.uncertainty?.limitations), true);

    // The old test, spelled out. It is false for `undefined`, and section 5 had no `else`, so
    // the check produced nothing at all — neither `ok` nor `bad`.
    const asItWasWritten = report.uncertainty?.limitations?.length === 0;
    assert.equal(asItWasWritten, false, 'the fixture must actually reproduce the old blind spot');
    assert.notEqual(listIsMissingOrEmpty(report.uncertainty?.limitations), asItWasWritten);
  });

  it('is false for a list that has something in it, so it cannot fire on every report', () => {
    // The positive control. A predicate that returned true unconditionally would pass both
    // assertions above.
    assert.equal(listIsMissingOrEmpty(['sampling error is not modelled']), false);
    assert.equal(listIsMissingOrEmpty([0]), false);
  });

  it('treats a non-array as missing rather than reading .length off it', () => {
    assert.equal(listIsMissingOrEmpty('sampling error is not modelled'), true);
    assert.equal(listIsMissingOrEmpty({ length: 3 }), true);
    assert.equal(listIsMissingOrEmpty(null), true);
  });
});

describe('the confidence-interval check on a sampled equity', () => {
  it('passes a sampled result that carries its interval', () => {
    // Positive control: a predicate that always fired would pass every other case here.
    assert.equal(
      sampledEquityMissesInterval({ method: 'monte-carlo', confidenceHalfWidthPoints: 0.4 }),
      false,
    );
  });

  it('ignores an exact result, which has no interval to carry', () => {
    assert.equal(sampledEquityMissesInterval({ method: 'exhaustive' }), false);
    assert.equal(sampledEquityMissesInterval(undefined), false);
  });

  it('fires on an explicit null, which is what the old expression caught', () => {
    assert.equal(
      sampledEquityMissesInterval({ method: 'monte-carlo', confidenceHalfWidthPoints: null }),
      true,
    );
  });

  it('fires on an ABSENT key, which is what the old `=== null` missed', () => {
    const equity = { method: 'monte-carlo' };
    assert.equal(sampledEquityMissesInterval(equity), true);

    // The old test, spelled out, disagreeing on exactly this case. A serialiser that drops
    // undefined fields — or a route that stopped computing the half-width — produces this
    // shape, and the run then printed a Monte Carlo percentage that reads as exact.
    const asItWasWritten = equity.confidenceHalfWidthPoints === null;
    assert.equal(asItWasWritten, false, 'the fixture must actually reproduce the old blind spot');
    assert.notEqual(sampledEquityMissesInterval(equity), asItWasWritten);
  });
});

// ---------------------------------------------------------------------------
// The hostile-input negative control
// ---------------------------------------------------------------------------

/**
 * Section 5 sends six deliberately invalid bodies to `POST /math/equity` and reports "all 6
 * hostile calculation inputs rejected". It used to accept ANY 4xx as a rejection.
 *
 * Section 12 exhausts the expensive-rate-limit budget on purpose, and that limiter answers
 * before the request reaches a route. So a run in which the budget was already spent — a second
 * run inside one window, a shared bucket, a deployment without the reset control — answered all
 * six probes with 429 and printed the claim anyway, having reached no validator at all.
 *
 * ## Would these fail against the old code?
 *
 * The old rule is written out below as `oldRuleCountedItRejected` and asserted to DISAGREE with
 * the classifier on the 429 case. Restoring `status >= 400 && status < 500` therefore fails
 * here by construction rather than by coincidence.
 */
describe('classifyHostileRefusal', () => {
  const response = (status, code) => ({
    status,
    json: code === undefined ? {} : { error: { code, message: 'x', requestId: 'r' } },
  });

  it('counts a closed-schema rejection', () => {
    assert.equal(classifyHostileRefusal(response(400, 'invalid_request')).kind, 'rejected');
  });

  it('counts a calculator refusal, which is where the absurd sample count lands', () => {
    assert.equal(classifyHostileRefusal(response(422, 'computation_rejected')).kind, 'rejected');
    assert.equal(classifyHostileRefusal(response(413, 'payload_too_large')).kind, 'rejected');
  });

  it('calls a 429 UNTESTED rather than rejected, which is the whole defect', () => {
    const limited = response(429, 'rate_limited');
    const verdict = classifyHostileRefusal(limited);
    assert.equal(verdict.kind, 'untested');
    assert.match(verdict.why, /before any validator/);

    // The old rule, spelled out. It counted this as a pass, which is how six 429s became
    // "all 6 hostile calculation inputs rejected".
    const oldRuleCountedItRejected = limited.status >= 400 && limited.status < 500;
    assert.equal(oldRuleCountedItRejected, true, 'the fixture must reproduce what the old rule saw');
    assert.notEqual(verdict.kind, 'rejected');
  });

  it('calls a 429 untested even when a proxy stripped the body', () => {
    assert.equal(classifyHostileRefusal({ status: 429, json: null }).kind, 'untested');
  });

  it('does not count a 4xx that carries no validation code', () => {
    // 401 and 403 are 4xx and are not validation: a session that expired mid-section would
    // otherwise have read as six successful refusals.
    assert.equal(classifyHostileRefusal(response(401, 'not_authenticated')).kind, 'wrong-refusal');
    assert.equal(classifyHostileRefusal(response(403, 'csrf_failed')).kind, 'wrong-refusal');
    assert.equal(classifyHostileRefusal(response(404, undefined)).kind, 'wrong-refusal');
  });

  it('calls a 200 accepted, which is the failure the section was written for', () => {
    // The positive control for the other direction: a classifier that returned 'rejected' for
    // everything would pass the three cases above, and a classifier that never did would pass
    // this one.
    assert.equal(classifyHostileRefusal(response(200)).kind, 'accepted');
    assert.equal(classifyHostileRefusal(response(500, 'internal_error')).kind, 'accepted');
  });
});

// ---------------------------------------------------------------------------
// The confidentiality property, on the wire
// ---------------------------------------------------------------------------

/**
 * Section 7's live scan used to read, in full:
 *
 *     if (frame.view.street === 'complete') return false;
 *     return seats.some((seat) => seat.holeCards !== null && seat.seat !== view.viewerSeat);
 *
 * — every frame of a finished hand exempted, on the reasoning that a showdown makes cards
 * public. A showdown does; a FOLD does not, and `HandResult.showdowns` is documented as "empty
 * when the hand ended before showdown (everyone else folded)". The smoke run's own client checks
 * or calls when it can and folds when it cannot, so a hand that ends without a showdown is the
 * ORDINARY outcome here.
 *
 * Measured, before the fix, against a stub API that served the opponent's hole cards in the
 * `street: 'complete'` frame of a hand nobody showed down: section 7 printed
 * `✓ no live frame carried another seat's hole cards mid-hand`, section 8 printed
 * `✓ an archived hand carries no opponent's unshown hole cards` (the archive was honest — only
 * the wire was not), and the whole run reported no failure. The one claim this script exists to
 * make, green over a live leak.
 *
 * ## Would these fail against the old code?
 *
 * The old expression is written out below as `oldScanExemptedIt` and asserted to DISAGREE on the
 * fold-ended case, so restoring the `street === 'complete'` exemption fails here by construction
 * rather than by coincidence.
 */
describe('unentitledHoleCardSeats', () => {
  const frame = (street, { opponentCards = null, showdowns = null } = {}) => ({
    type: 'state',
    view: {
      street,
      viewerSeat: 0,
      seats: [
        { seat: 0, isSelf: true, holeCards: ['Ah', 'Kd'] },
        { seat: 1, isSelf: false, holeCards: opponentCards },
      ],
      result: street === 'complete' ? { endedByFold: showdowns === null, showdowns: showdowns ?? [] } : null,
    },
  });

  it('finds nothing in an honest mid-hand frame', () => {
    assert.deepEqual(unentitledHoleCardSeats(frame('flop')), []);
  });

  it('finds a mid-hand leak, which is what the old scan already caught', () => {
    assert.deepEqual(unentitledHoleCardSeats(frame('turn', { opponentCards: ['Qs', 'Qc'] })), [1]);
  });

  it('finds a leak in a COMPLETED hand that nobody showed down', () => {
    const leaking = frame('complete', { opponentCards: ['Qs', 'Qc'] });
    assert.deepEqual(unentitledHoleCardSeats(leaking), [1]);

    // The old expression, spelled out. It returned early on every completed frame, so this leak
    // produced neither a pass nor a failure — it produced a tick.
    const oldScanExemptedIt = leaking.view.street === 'complete';
    assert.equal(oldScanExemptedIt, true, 'the fixture must reproduce what the old scan skipped');
    assert.notEqual(unentitledHoleCardSeats(leaking).length, 0);
  });

  it('exempts a seat that genuinely showed down, so the check is not just "never send cards"', () => {
    // The positive control. A predicate that flagged every foreign holeCards would pass every
    // assertion above and would fail every honest showdown this product is built to display.
    const shown = frame('complete', { opponentCards: ['Qs', 'Qc'], showdowns: [{ seat: 0 }, { seat: 1 }] });
    assert.deepEqual(unentitledHoleCardSeats(shown), []);
  });

  it('exempts nobody when a completed frame carries no result, so the check gets stricter', () => {
    const noResult = frame('complete', { opponentCards: ['Qs', 'Qc'] });
    noResult.view.result = null;
    assert.deepEqual(unentitledHoleCardSeats(noResult), [1]);
  });

  it('treats an ABSENT holeCards key as absent rather than as a leak', () => {
    // `!== null` reported a leak here — a serialiser that drops nulls would have failed the gate
    // for emitting nothing at all. `!= null` is the idiom section 8 already used.
    const dropped = frame('flop');
    dropped.view.seats[1].holeCards = undefined;
    assert.deepEqual(unentitledHoleCardSeats(dropped), []);
  });

  it('falls back to viewerSeat when isSelf is absent, so a rename narrows the exemption', () => {
    const renamed = frame('flop');
    renamed.view.seats[0].isSelf = undefined;
    assert.deepEqual(unentitledHoleCardSeats(renamed), [], "the viewer's own seat is still exempt");

    // …and the other way: with viewerSeat gone, isSelf still carries it.
    const noViewerSeat = frame('flop');
    noViewerSeat.view.viewerSeat = null;
    assert.deepEqual(unentitledHoleCardSeats(noViewerSeat), []);
  });

  it('ignores frames that are not a view at all', () => {
    assert.deepEqual(unentitledHoleCardSeats({ type: 'ack', requestId: 'r' }), []);
    assert.deepEqual(unentitledHoleCardSeats({ type: 'state', view: null }), []);
    assert.deepEqual(unentitledHoleCardSeats(undefined), []);
  });
});
