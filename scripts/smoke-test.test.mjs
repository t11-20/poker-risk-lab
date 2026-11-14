#!/usr/bin/env node
/**
 * Tests for the decisions in `scripts/smoke-test.mjs`: the Retry-After parser, the leftover-quota
 * classifier, the bounded recovery plan, argument parsing, the reset path against the API's own
 * constant, and the confidentiality checks. Each negative control writes out the old expression and
 * asserts it disagrees with the new one, so a revert fails here by construction.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  auditReviewSeats,
  classifyGuestLimit,
  classifyHostileRefusal,
  listIsMissingOrEmpty,
  liveHandTruth,
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

const EMPTY_ENV = Object.freeze({});

describe('parseDeltaSeconds', () => {
  it('reads the delta-seconds form this API actually sends', () => {
    assert.equal(parseDeltaSeconds('42'), 42);
    assert.equal(parseDeltaSeconds('0'), 0);
    assert.equal(parseDeltaSeconds('  30  '), 30);
  });

  it('refuses every malformed shape a Number() parser would accept', () => {
    // Each of these is numeric under `Number`, which is how a malformed header becomes a bad wait.
    for (const malformed of ['-5', '12.7', '1e3', '0x10', ' +7', 'Infinity']) {
      assert.equal(parseDeltaSeconds(malformed), null, `"${malformed}" must not parse`);
      // `!Number.isNaN`, not `Number.isFinite`, so "Infinity" counts as a value a naive parser accepts.
      assert.ok(
        !Number.isNaN(Number(malformed.trim())),
        `"${malformed}" is not a useful negative control unless Number() accepts it`,
      );
    }
  });

  it('refuses the HTTP-date form rather than guessing at clock skew', () => {
    // This API never sends an HTTP-date, and converting one needs both clocks to agree.
    assert.equal(parseDeltaSeconds('Wed, 21 Oct 2026 07:28:00 GMT'), null);
  });

  it('refuses absence, emptiness and non-strings', () => {
    for (const absent of [null, undefined, '', '   ', 'soon', 42, {}]) {
      assert.equal(parseDeltaSeconds(absent), null, `${String(absent)} must not parse`);
    }
  });

  it('refuses a value too large to be a safe integer', () => {
    // 25 nines parse as a finite Number with lost precision.
    assert.equal(parseDeltaSeconds('9'.repeat(25)), null);
  });
});

describe('recoveryWaitSeconds', () => {
  it('takes the largest of the three sources a 429 carries', () => {
    // Both headers come from one ttl rounded in opposite directions, and the harness gets one retry.
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
    // `Math.max` would return a negative body value.
    assert.equal(recoveryWaitSeconds({ bodySeconds: -4 }), null);
  });
});

describe('classifyGuestLimit', () => {
  it('calls a 429 leftover when this run cannot have caused it', () => {
    // The first guest creation of the run, so the previous run's section 12 drained the bucket.
    assert.equal(classifyGuestLimit({ attempt: 1, limit: 10 }), 'leftover');
  });

  it('calls a 429 the limiter working once this run has spent the budget', () => {
    // If this returned 'leftover', a limit that is too low would be waited out as a pause.
    assert.equal(classifyGuestLimit({ attempt: 11, limit: 10 }), 'working');
    assert.equal(classifyGuestLimit({ attempt: 60, limit: 10 }), 'working');
  });

  it('puts the boundary where the limiter puts it', () => {
    // `max: 10` allows ten and refuses the eleventh.
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

const HEALTHY = Object.freeze({
  verdict: 'leftover',
  waitSeconds: 30,
  maxWaitSeconds: 90,
  alreadyWaited: false,
});

describe('planRecovery', () => {
  it('waits out a window that fits inside the bound', () => {
    // A planner that refused everything would pass every refusal below.
    const plan = planRecovery(HEALTHY);
    assert.equal(plan.action, 'wait');
    assert.equal(plan.waitMs, (30 + RECOVERY_PADDING_SECONDS) * 1_000);
    assert.match(plan.reason, /30s left/);
  });

  it('pads the wait past the window boundary rather than landing on it', () => {
    // Retry-After is whole seconds, and a wait of exactly that can land on the window boundary.
    assert.ok(RECOVERY_PADDING_SECONDS >= 1, 'the padding must actually pad');
    assert.equal(planRecovery({ ...HEALTHY, waitSeconds: 0 }).waitMs, RECOVERY_PADDING_SECONDS * 1_000);
  });

  it('refuses a window longer than the bound, and says which bound', () => {
    const plan = planRecovery({ ...HEALTHY, waitSeconds: 91 });
    assert.equal(plan.action, 'abandon');
    assert.match(plan.reason, /exceeds the --max-wait bound of 90s/);
    assert.match(plan.reason, /RATE_LIMIT_RESET_TOKEN/, 'the refusal must name the deterministic fix');
    assert.equal(plan.waitMs, 0);
    // Exactly at the bound is still a wait.
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
    // A working limiter must be reported as too low, not as a header problem.
    const plan = planRecovery({ ...HEALTHY, verdict: 'working', waitSeconds: null });
    assert.match(plan.reason, /limiter working as documented/);
  });

  it('accepts a bound of zero as "never wait"', () => {
    const plan = planRecovery({ ...HEALTHY, waitSeconds: 1, maxWaitSeconds: 0 });
    assert.equal(plan.action, 'abandon');
  });
});

describe('originBucketNote', () => {
  it('says a literal address pins the bucket', () => {
    assert.match(originBucketNote('http://127.0.0.1:3001'), /literal address/);
    assert.match(originBucketNote('http://[::1]:3001'), /literal address/);
  });

  it('warns that a hostname hands the bucket to DNS', () => {
    const note = originBucketNote('http://localhost:3001');
    assert.match(note, /hostname/);
    assert.match(note, /::1 and 127\.0\.0\.1 are deliberately separate/);
  });
});

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
    // A local .env that carries the server's RATE_LIMIT_RESET_TOKEN gives isolation for free.
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
    // Only exactly "1" arms strict mode.
    assert.equal(parseArgs([], { PRL_SMOKE_STRICT: 'true' }).strict, false);
  });

  it('absorbs the -- that pnpm forwards', () => {
    const options = parseArgs(['--', '--strict'], EMPTY_ENV);
    assert.equal(options.strict, true);
  });

  it('prints help without validating anything else', () => {
    // --help must work when the environment is broken.
    const options = parseArgs(['--help'], { PRL_API_ORIGIN: 'not-a-url' });
    assert.equal(options.help, true);
  });

  it('names the reason for every refusal', () => {
    // Each refusal says what is wrong.
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
    // A trailing slash is the same origin and the same rate-limit bucket.
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

/** A text scan, because importing the `.ts` module would pull in the API's dependency graph. */
function exportedResetPath(source) {
  return /export const RATE_LIMIT_RESET_PATH = '([^']+)'/.exec(source)?.[1] ?? null;
}

describe('the reset path the harness posts to', () => {
  const securitySource = readFileSync(join(REPO_ROOT, 'apps/api/src/plugins/security.ts'), 'utf8');

  it('scanned the file it meant to scan', () => {
    // A truncated read or a moved file would make every assertion below vacuous.
    assert.ok(securitySource.length > 12_000, `security.ts is only ${securitySource.length} bytes`);
    assert.match(securitySource, /clientKeyedRateLimit/, 'this is not the security plugin');
    assert.match(securitySource, /registerRateLimitResetRoute/, 'the reset control is not in this file');
  });

  it('matches the constant the server registers', () => {
    assert.equal(RATE_LIMIT_RESET_PATH, exportedResetPath(securitySource));
    assert.equal(RATE_LIMIT_RESET_PATH, '/api/v1/_test/rate-limit/reset');
  });

  it('would notice a rename: the extractor reads the file rather than restating a constant', () => {
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

/** The same comment stripping as `apps/api/test/harness-paths.test.ts`. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function apiPathLiterals(source) {
  return [...stripComments(source).matchAll(/['"`](\/api\/v1\/[^'"`\s]*)['"`]/g)].map((match) => match[1]);
}

describe('the harness does not hand harness-paths.test.ts a route that must not exist', () => {
  const harnessSource = readFileSync(join(REPO_ROOT, 'scripts/smoke-test.mjs'), 'utf8');
  const literals = apiPathLiterals(harnessSource);

  it('scanned a real set of paths', () => {
    assert.ok(literals.length > 12, `expected the harness to name many API paths, found ${literals.length}`);
    assert.ok(literals.includes('/api/v1/auth/guest'), 'the guest route is the one this whole file is about');
  });

  it('never writes the reset path as a single literal', () => {
    // `harness-paths.test.ts` asserts the server routes every literal, and this route is absent unless
    // RATE_LIMIT_RESET_TOKEN is configured.
    const offenders = literals.filter((path) => path.startsWith('/api/v1/_test/'));
    assert.deepEqual(offenders, [], 'compose the test-control path from API_PREFIX instead');
  });

  it('would notice if somebody inlined it', () => {
    const doctored = `const p = '${RATE_LIMIT_RESET_PATH}';`;
    const offenders = apiPathLiterals(doctored).filter((path) => path.startsWith('/api/v1/_test/'));
    assert.deepEqual(offenders, [RATE_LIMIT_RESET_PATH]);
  });
});

/**
 * Each case states an expression that lets a missing field produce neither a pass nor a failure,
 * and asserts it disagrees with the new one on the absent case.
 */
describe('assertions about absence', () => {
  it('treats an empty list as missing, which is what it was already doing', () => {
    assert.equal(listIsMissingOrEmpty([]), true);
  });

  it('treats an ABSENT list as missing, which is what the old expression could not see', () => {
    const report = { suggestion: {} };
    assert.equal(listIsMissingOrEmpty(report.uncertainty?.limitations), true);

    // The old test. It is false for `undefined`, and section 5 had no `else`.
    const asItWasWritten = report.uncertainty?.limitations?.length === 0;
    assert.equal(asItWasWritten, false, 'the fixture must actually reproduce the old blind spot');
    assert.notEqual(listIsMissingOrEmpty(report.uncertainty?.limitations), asItWasWritten);
  });

  it('is false for a list that has something in it, so it cannot fire on every report', () => {
    // A predicate that always returned true would pass the assertions above.
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

    // The old test, which passed an absent half-width.
    const asItWasWritten = equity.confidenceHalfWidthPoints === null;
    assert.equal(asItWasWritten, false, 'the fixture must actually reproduce the old blind spot');
    assert.notEqual(sampledEquityMissesInterval(equity), asItWasWritten);
  });
});

/**
 * `oldRuleCountedItRejected` counts any 4xx as a rejection, so 429s from a spent expensive-rate-limit
 * budget read as "hostile calculation inputs rejected". It must disagree on the 429 case.
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

    const oldRuleCountedItRejected = limited.status >= 400 && limited.status < 500;
    assert.equal(oldRuleCountedItRejected, true, 'the fixture must reproduce what the old rule saw');
    assert.notEqual(verdict.kind, 'rejected');
  });

  it('calls a 429 untested even when a proxy stripped the body', () => {
    assert.equal(classifyHostileRefusal({ status: 429, json: null }).kind, 'untested');
  });

  it('does not count a 4xx that carries no validation code', () => {
    // A session that expired mid-section must not read as six refusals.
    assert.equal(classifyHostileRefusal(response(401, 'not_authenticated')).kind, 'wrong-refusal');
    assert.equal(classifyHostileRefusal(response(403, 'csrf_failed')).kind, 'wrong-refusal');
    assert.equal(classifyHostileRefusal(response(404, undefined)).kind, 'wrong-refusal');
  });

  it('calls a 200 accepted, which is the failure the section was written for', () => {
    // A classifier that returned 'rejected' for everything would pass the three cases above.
    assert.equal(classifyHostileRefusal(response(200)).kind, 'accepted');
    assert.equal(classifyHostileRefusal(response(500, 'internal_error')).kind, 'accepted');
  });
});

/**
 * `oldScanExemptedIt` skips every `street === 'complete'` frame, which exempts a hand that ended by
 * fold, the ordinary outcome here. It must disagree on the fold-ended case.
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

    const oldScanExemptedIt = leaking.view.street === 'complete';
    assert.equal(oldScanExemptedIt, true, 'the fixture must reproduce what the old scan skipped');
    assert.notEqual(unentitledHoleCardSeats(leaking).length, 0);
  });

  it('exempts a seat that genuinely showed down, so the check is not just "never send cards"', () => {
    // A predicate that flagged every foreign holeCards would fail every honest showdown.
    const shown = frame('complete', { opponentCards: ['Qs', 'Qc'], showdowns: [{ seat: 0 }, { seat: 1 }] });
    assert.deepEqual(unentitledHoleCardSeats(shown), []);
  });

  it('exempts nobody when a completed frame carries no result, so the check gets stricter', () => {
    const noResult = frame('complete', { opponentCards: ['Qs', 'Qc'] });
    noResult.view.result = null;
    assert.deepEqual(unentitledHoleCardSeats(noResult), [1]);
  });

  it('treats an ABSENT holeCards key as absent rather than as a leak', () => {
    // An absent key is safe. `!== null` would fail a serialiser that drops nulls.
    const dropped = frame('flop');
    dropped.view.seats[1].holeCards = undefined;
    assert.deepEqual(unentitledHoleCardSeats(dropped), []);
  });

  it('falls back to viewerSeat when isSelf is absent, so a rename narrows the exemption', () => {
    const renamed = frame('flop');
    renamed.view.seats[0].isSelf = undefined;
    assert.deepEqual(unentitledHoleCardSeats(renamed), [], "the viewer's own seat is still exempt");

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

/**
 * `oldSectionEightSaidClean` scans `hand.seats` on `GET /hands` rows. Those are `HandSummary`, with
 * no `seats` field, so it walks zero seats and passes. With both server-side redaction layers
 * removed, `auditReviewSeats` reports `leaked: [1]` while the old check stays clean.
 */
describe('auditReviewSeats', () => {
  const oldSectionEightSaidClean = (listRows) =>
    listRows.filter((hand) => {
      const seats = Array.isArray(hand.seats) ? hand.seats : [];
      return seats.some((seat) => seat.holeCards != null && seat.isSelf !== true && seat.showedDown !== true);
    }).length === 0;

  /** A `GET /hands` row as the live routes return it. */
  const LIST_ROW = {
    id: 'hand_realshapeaaaaaaaaaaa',
    roomId: 'room_realshapeaaaaaaaaaaa',
    handNumber: 1,
    startedAt: '2026-08-27T00:00:00.000Z',
    completedAt: '2026-08-27T00:00:01.000Z',
    board: [],
    heroNet: -1,
    endedByFold: true,
    potTotal: 2,
  };

  const truth = { handId: LIST_ROW.id, viewerSeat: 0, shownSeats: [], complete: true };
  const seat = (index, cards, showedDown = false) => ({
    seat: index,
    displayName: `Seat ${index}`,
    isBot: false,
    startingStack: 200,
    net: 0,
    holeCards: cards,
    showedDown,
  });

  it('passes an honest fold-out review: own cards, nobody else’s', () => {
    const review = { seats: [seat(0, ['Ah', 'Ks']), seat(1, null)] };
    assert.deepEqual(auditReviewSeats(review, truth), {
      leaked: [],
      overclaimed: [],
      examined: 2,
      ownCards: true,
    });
  });

  it('finds the leak the old check could not see, on the payload the old check was given', () => {
    const review = { seats: [seat(0, ['Ah', 'Ks']), seat(1, ['7c', '2d'])] };
    assert.deepEqual(auditReviewSeats(review, truth).leaked, [1]);

    // The old check never looked. `seats` is not a field of a hand summary.
    assert.equal(LIST_ROW.seats, undefined, 'the fixture must reproduce the shape that has no seats');
    assert.equal(oldSectionEightSaidClean([LIST_ROW]), true, 'the old expression printed a tick here');
  });

  it('exempts a seat that genuinely showed down, so the rule is not "never send cards"', () => {
    // A predicate that flagged every foreign holeCards would fail every honest showdown.
    const shown = { seats: [seat(0, ['Ah', 'Ks']), seat(1, ['7c', '2d'], true)] };
    const showdownTruth = { ...truth, shownSeats: [0, 1] };
    assert.deepEqual(auditReviewSeats(shown, showdownTruth), {
      leaked: [],
      overclaimed: [],
      examined: 2,
      ownCards: true,
    });
  });

  it('refuses to take showedDown on trust when the wire named no such showdown', () => {
    // A server that marked every seat as shown would open every hand, so `showedDown` is held to
    // `result.showdowns` from the live hand.
    const overclaiming = { seats: [seat(0, ['Ah', 'Ks']), seat(1, ['7c', '2d'], true)] };
    const audit = auditReviewSeats(overclaiming, truth);
    assert.deepEqual(audit.leaked, [], 'the flag does exempt it from the card rule');
    assert.deepEqual(audit.overclaimed, [1], 'and the flag itself is what fails');
  });

  it('reports a sweep of nothing as a sweep of nothing, rather than as clean', () => {
    // Neither shape may read as a pass, although `leaked` is empty for both.
    const noSeats = auditReviewSeats({ seats: [] }, truth);
    assert.deepEqual(noSeats.leaked, []);
    assert.equal(noSeats.examined, 0, 'section 8 fails on this');

    const noCards = auditReviewSeats({ seats: [seat(0, null), seat(1, null)] }, truth);
    assert.deepEqual(noCards.leaked, []);
    assert.equal(noCards.ownCards, false, 'and on this');

    assert.equal(auditReviewSeats(undefined, truth).examined, 0);
    assert.equal(auditReviewSeats({ hands: [] }, truth).examined, 0);
  });

  it('treats an ABSENT holeCards key as absent rather than as a leak', () => {
    const dropped = { seats: [seat(0, ['Ah', 'Ks']), { seat: 1, showedDown: false }] };
    assert.deepEqual(auditReviewSeats(dropped, truth).leaked, []);
  });

  it('does not exempt anybody when the caller’s own seat is unknown', () => {
    // `HandReviewSeat` has no `isSelf`, so the own seat comes from the wire. Section 8 refuses to run
    // without it.
    const review = { seats: [seat(0, ['Ah', 'Ks']), seat(1, null)] };
    const audit = auditReviewSeats(review, { ...truth, viewerSeat: null });
    assert.deepEqual(audit.leaked, [0]);
    assert.equal(audit.ownCards, false);
  });
});

describe('liveHandTruth', () => {
  const stateFrame = (view) => ({ type: 'state', view });

  it('reads the terminal frame, not the first', () => {
    const truth = liveHandTruth([
      stateFrame({ handId: 'hand_a', viewerSeat: 0, street: 'preflop', result: null }),
      { type: 'event', event: { kind: 'street' } },
      stateFrame({
        handId: 'hand_a',
        viewerSeat: 0,
        street: 'complete',
        result: { showdowns: [{ seat: 0 }, { seat: 1 }] },
      }),
    ]);
    assert.deepEqual(truth, {
      handId: 'hand_a',
      viewerSeat: 0,
      shownSeats: [0, 1],
      complete: true,
    });
  });

  it('returns null when no state frame arrived, so section 8 refuses rather than guesses', () => {
    assert.equal(liveHandTruth([{ type: 'ack', requestId: 'r' }]), null);
    assert.equal(liveHandTruth([]), null);
    assert.equal(liveHandTruth(undefined), null);
  });

  it('reports a missing viewerSeat as null rather than letting undefined stand in for a seat', () => {
    // An undefined viewerSeat would call every seat foreign. Section 8 fails on a null instead.
    const truth = liveHandTruth([stateFrame({ handId: 'h', street: 'complete', result: null })]);
    assert.equal(truth.viewerSeat, null);
    assert.deepEqual(truth.shownSeats, [], 'a null result exempts nobody');
  });

  it('drops a showdown entry that carries no seat index', () => {
    const truth = liveHandTruth([
      stateFrame({
        handId: 'h',
        viewerSeat: 1,
        street: 'complete',
        result: { showdowns: [{ seat: 1 }, { playerId: 'usr_x' }] },
      }),
    ]);
    assert.deepEqual(truth.shownSeats, [1], 'an entry with no seat exempts nothing');
  });
});
