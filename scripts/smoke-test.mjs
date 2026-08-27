#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING API.
 *
 * Invoked by:  pnpm run test:smoke
 *
 * This is deliberately not a unit test and does not import the application. It speaks HTTP to a
 * real server with a real database, the way a browser does, because the two most serious bugs
 * found in this codebase were both invisible to unit tests:
 *
 *   - the session decorator was registered inside one module's encapsulated Fastify scope, so
 *     every other module returned 500 for an authenticated caller;
 *   - the room registry defaulted to a no-op archive, so hands were played and never persisted.
 *
 * Both pass every in-process test and both break the running product. So this walks the
 * critical journeys and, most importantly, asserts the confidentiality property that matters:
 * **one player must never receive another player's private cards or any undealt card.**
 *
 * It also checks the WEB origin's security headers (section 10), because the response headers of
 * a rendered HTML page are another thing no in-process test can see: the app shipped with no
 * Content-Security-Policy at all while a carefully maintained CSP hash sat unused in the source.
 * `PRL_WEB_ORIGIN` says where that is; it defaults to the dev/compose address.
 *
 * ## Why this script now begins by isolating itself from its own previous run
 *
 * Section 12 proves the guest limiter exists by exhausting it: it floods `POST /auth/guest` until
 * the first 429. That route is keyed on the caller's ADDRESS and not on the session — it has to
 * be, because it ISSUES the session an address-free key would rotate (`clientKeyedRateLimit` in
 * apps/api/src/plugins/security.ts) — so the bucket it drains is byte-for-byte the bucket the
 * NEXT run needs. The window is fixed, not sliding: it is stamped by the first request and clears
 * only once the whole window has elapsed. Section 12 is last, so a run ends with that counter over
 * the limit and most of a window still to go.
 *
 * The consequence was a release gate that could not be run twice. Run 2 reached section 2 within
 * seconds, was refused 429, and then sections 7, 8 and 9 all failed — for the unrelated reason
 * that the run never had a session at all. The output blamed hand history and hidden information
 * for a rate-limit window.
 *
 * Two mechanisms close that, in this order of preference:
 *
 *   1. **Reset the counters before the run.** `POST /api/v1/_test/rate-limit/reset` exists only
 *      when the SERVER was started with `RATE_LIMIT_RESET_TOKEN`, and `loadConfig` refuses to
 *      start a production process that sets it — so this is deterministic, costs nothing, and is
 *      unavailable exactly where it must be. The harness reports what it cleared.
 *   2. **Wait out the window it consumed.** When there is no reset control — a staging stack
 *      running with `NODE_ENV=production` is the case that matters — a 429 on the first guest
 *      creation is recovered from by reading `Retry-After` / `x-ratelimit-reset`, waiting exactly
 *      that long (plus one second for the boundary), and retrying ONCE. The wait is bounded and
 *      the run says out loud that it waited and why.
 *
 * Neither mechanism weakens a limit. The first empties a counter on a process that cannot be a
 * production process; the second does nothing but wait.
 *
 * ## What it does NOT prove
 *
 * That the limiter is correctly configured for production traffic — section 12 proves a 429
 * arrives, not that the number behind it is the right number. That the reset control is absent in
 * production; that is `apps/api/test/rate-limit-isolation.test.ts`, which drives `loadConfig`
 * directly. And nothing at all about the database's contents beyond the rows this run created.
 *
 * Usage:
 *     node scripts/smoke-test.mjs [--origin http://127.0.0.1:3001] [--strict]
 *     node scripts/smoke-test.mjs --reset-token "$RATE_LIMIT_RESET_TOKEN"
 *     node scripts/smoke-test.mjs --no-reset            # exercise the wait-out fallback
 *
 * Exit codes: 0 pass, 1 any failure (or any warning under --strict), 0 for --help.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, so the enrolment CLI can be found however this script was invoked. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The fallbacks used when neither a flag nor an environment variable says otherwise.
 *
 * `apiOrigin` is a LITERAL ADDRESS on purpose, and the reason is not cosmetic. The rate-limit
 * bucket this run consumes is derived from the address the API sees the connection arrive from,
 * and `::1` and `127.0.0.1` are deliberately NOT folded together (see `normaliseAddress` in
 * apps/api/src/plugins/request-context.ts — they are genuinely different addresses on different
 * stacks). A hostname would hand that choice to whatever DNS resolution order the machine
 * happens to have, so two runs on one laptop could quietly land in two different buckets and the
 * isolation this script now depends on would hold only by luck.
 *
 * It therefore differs, knowingly, from `apps/web/src/lib/guest-bootstrap.ts`, whose
 * `PRL_API_ORIGIN` default is `http://localhost:3001`. That is the web server's own reach to the
 * API and it is a different client from this one; section 11 drives it, so a run can consume TWO
 * guest buckets and see only one of them. The isolation section prints that fact rather than
 * leaving it to be discovered.
 */
const DEFAULTS = {
  apiOrigin: 'http://127.0.0.1:3001',
  webOrigin: 'http://localhost:3000',
  /**
   * Bound on the wait-out fallback, in seconds.
   *
   * The shipped guest window is 60 s (`RATE_LIMIT_GUEST_WINDOW_MS`), so 90 s clears a full window
   * plus the second of padding plus headroom for a run that stamped its window moments before
   * finishing. The bound exists so that a deployment which raised the window to an hour fails in
   * 90 seconds with a diagnosis rather than hanging a release gate for one.
   */
  maxWaitSeconds: 90,
  /**
   * What this run expects `PRL_ENROLMENT_REQUIRED` to be on the deployment it is pointed at.
   *
   * `discover` accepts either posture and asserts whichever one it finds, which is right for a
   * developer stack: the shipped default is `off`, and proving that an open instance seats anybody
   * is a real check rather than a skip. `scripts/staging.mjs` passes `enforced`, because staging is
   * the deployment that runs the guard ON and a run that could not exercise it there must fail
   * rather than quietly report the open behaviour.
   */
  expectEnrolment: 'discover',
};

/** The legal values of `--expect-enrolment`. */
const ENROLMENT_EXPECTATIONS = ['discover', 'off', 'enforced'];

/**
 * The cohort this harness enrols its throwaway guests into.
 *
 * Created once per database and then reused forever, because a cohort with enrolments in it is not
 * a row anybody may remove — `enrolments.cohort_id` is `ON DELETE RESTRICT` and no role holds
 * DELETE on the table. That is the schema working, not an obstacle: the accounts this run creates
 * are guests that the retention sweep erases after 60 days, and `enrolments.user_id` is ON DELETE
 * CASCADE, so the rows go with the accounts that own them. What this run cleans up itself is the
 * ENTITLEMENT, by revoking it — which is an UPDATE that keeps the record, and is the only shape of
 * withdrawal this schema has.
 */
const SMOKE_COHORT = {
  key: 'smoke-test',
  name: 'Smoke test cohort',
  by: 'scripts/smoke-test.mjs',
  reference: 'smoke-test-harness',
};

const HELP = `Poker Risk Lab smoke test — walks the critical journeys against a running API.

Usage:
  node scripts/smoke-test.mjs [options]

Options:
  --origin <url>          API origin to test          (default ${DEFAULTS.apiOrigin}, env PRL_API_ORIGIN)
  --web-origin <url>      Rendered web origin         (default ${DEFAULTS.webOrigin}, env PRL_WEB_ORIGIN)
  --strict                Promote every warning to a failure   (env PRL_SMOKE_STRICT=1)
  --reset-token <token>   Token for POST /api/v1/_test/rate-limit/reset
                          (env PRL_RATE_LIMIT_RESET_TOKEN, then RATE_LIMIT_RESET_TOKEN)
  --no-reset              Never call the reset control, even with a token, so the
                          wait-out fallback is the thing under test
  --max-wait <seconds>    Bound on the wait-out fallback       (default ${DEFAULTS.maxWaitSeconds})
  --expect-enrolment <v>  discover | off | enforced            (default ${DEFAULTS.expectEnrolment},
                          env PRL_SMOKE_ENROLMENT_REQUIRED). What PRL_ENROLMENT_REQUIRED is
                          expected to be on the deployment under test. "enforced" makes a run
                          that cannot exercise the seat guard a FAILURE rather than a note.
  --migration-url <dsn>   Migrating identity, for writing the enrolment the enforced direction
                          needs (env DATABASE_MIGRATION_URL). Never printed.
  -h, --help              Print this and exit 0

Exit codes: 0 pass, 1 any failure (or any warning under --strict).
`;

const STRING_OPTIONS = new Map([
  ['--origin', 'apiOrigin'],
  ['--web-origin', 'webOrigin'],
  ['--reset-token', 'resetToken'],
  ['--expect-enrolment', 'expectEnrolment'],
  ['--migration-url', 'migrationUrl'],
]);

const NUMERIC_OPTIONS = new Map([['--max-wait', 'maxWaitSeconds']]);

const BOOLEAN_OPTIONS = new Map([
  ['--strict', 'strict'],
  ['--no-reset', 'noReset'],
]);

/** `scheme://host[:port]`, or throws the reason. Used for both origins so they cannot differ. */
function requireHttpOrigin(flag, value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${flag} must be an absolute URL, got "${value}"`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${flag} must be http or https, got "${url.protocol}//"`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`${flag} must be an origin with no path, query or fragment, got "${value}"`);
  }
  return url.origin;
}

/**
 * Parses argv into a validated option set.
 *
 * Exported so `smoke-test.test.mjs` can assert the precedence and the refusals without a server.
 * `env` is a parameter rather than a read of `process.env` for the same reason: a test that has
 * to mutate the real environment to check a fallback is a test that leaks into its neighbours.
 *
 * Precedence, per the repository's script convention: explicit flag, then environment variable,
 * then a default. The reset token reads `PRL_RATE_LIMIT_RESET_TOKEN` first and `RATE_LIMIT_RESET_TOKEN`
 * second so that a developer whose local `.env` already carries the SERVER's variable gets
 * isolation for free under `node --env-file-if-exists=.env`, while a caller who needs to point the
 * harness at a different process can do so without editing the server's own configuration.
 */
export function parseArgs(argv, env = process.env) {
  const options = {
    apiOrigin: env['PRL_API_ORIGIN'] ?? DEFAULTS.apiOrigin,
    apiOriginSource: env['PRL_API_ORIGIN'] === undefined ? 'default' : 'PRL_API_ORIGIN',
    webOrigin: env['PRL_WEB_ORIGIN'] ?? DEFAULTS.webOrigin,
    strict: env['PRL_SMOKE_STRICT'] === '1',
    resetToken: env['PRL_RATE_LIMIT_RESET_TOKEN'] ?? env['RATE_LIMIT_RESET_TOKEN'] ?? '',
    noReset: false,
    maxWaitSeconds: Number(env['PRL_SMOKE_MAX_WAIT_SECONDS'] ?? DEFAULTS.maxWaitSeconds),
    // What the deployment under test is expected to have set for PRL_ENROLMENT_REQUIRED, or
    // `discover` to accept whichever posture it is in. See `sectionEnrolment`.
    expectEnrolment: env['PRL_SMOKE_ENROLMENT_REQUIRED'] ?? DEFAULTS.expectEnrolment,
    // The MIGRATING identity, which is the only one that can write an enrolment: `prl_app` holds
    // SELECT and nothing else on prl.enrolments, on purpose. Never printed; see `redactUrl`.
    migrationUrl: env['DATABASE_MIGRATION_URL'] ?? '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // `pnpm run test:smoke -- --strict` forwards the `--` itself; absorb it rather than
    // rejecting the conventional invocation as an unknown option.
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(arg)) {
      options[BOOLEAN_OPTIONS.get(arg)] = true;
      continue;
    }
    const value = argv[i + 1];
    if (STRING_OPTIONS.has(arg)) {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      const key = STRING_OPTIONS.get(arg);
      options[key] = value;
      if (key === 'apiOrigin') options.apiOriginSource = '--origin';
      i += 1;
      continue;
    }
    if (NUMERIC_OPTIONS.has(arg)) {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${arg} needs a number, got "${value}"`);
      options[NUMERIC_OPTIONS.get(arg)] = parsed;
      i += 1;
      continue;
    }
    throw new Error(`unknown option ${arg} (try --help)`);
  }

  if (options.help) return options;

  options.apiOrigin = requireHttpOrigin('--origin', options.apiOrigin);
  options.webOrigin = requireHttpOrigin('--web-origin', options.webOrigin);
  if (!ENROLMENT_EXPECTATIONS.includes(options.expectEnrolment)) {
    throw new Error(
      '--expect-enrolment (or PRL_SMOKE_ENROLMENT_REQUIRED) must be one of ' +
        `${ENROLMENT_EXPECTATIONS.join(', ')}, got "${options.expectEnrolment}"`,
    );
  }
  if (!Number.isInteger(options.maxWaitSeconds) || options.maxWaitSeconds < 0) {
    // Names the environment variable as well as the flag, because the value can arrive from
    // either and "got NaN" sends the reader looking at a command line that does not mention it.
    throw new Error(
      '--max-wait (or PRL_SMOKE_MAX_WAIT_SECONDS) must be a whole number of seconds, ' +
        `got "${options.maxWaitSeconds}"`,
    );
  }
  // 600 s is ten minutes. Past that the harness is no longer waiting out a rate-limit window; it
  // is hanging a release gate on one, and the honest answer is to configure the reset control.
  if (options.maxWaitSeconds > 600) {
    throw new Error(
      `--max-wait ${options.maxWaitSeconds}s exceeds 600s; a gate that waits longer than that ` +
        'should be given RATE_LIMIT_RESET_TOKEN instead of a longer bound',
    );
  }
  return options;
}

// ---------------------------------------------------------------------------
// Rate-limit isolation: the decisions, kept pure
// ---------------------------------------------------------------------------

/**
 * The API prefix and the reset control's path.
 *
 * Assembled from two constants rather than written as one `'/api/v1/_test/rate-limit/reset'`
 * literal, and that is deliberate rather than a style choice. `apps/api/test/harness-paths.test.ts`
 * extracts every `'/api/v1/...'` literal out of this file and asserts the running server routes
 * each one — a guard that is right for every other path here and cannot be right for this one,
 * because this route is ABSENT unless `RATE_LIMIT_RESET_TOKEN` is configured. Its absence is the
 * shipped state and the entire point of the control, so a single literal would make that guard
 * demand a route production must never serve.
 *
 * The drift that literal would have caught is caught better instead: `smoke-test.test.mjs` reads
 * `RATE_LIMIT_RESET_PATH` out of apps/api/src/plugins/security.ts and asserts it equals this.
 */
const API_PREFIX = '/api/v1';
export const RATE_LIMIT_RESET_PATH = `${API_PREFIX}/_test/rate-limit/reset`;

/**
 * One second of padding on every computed wait.
 *
 * The store restarts a window when `iterationStartMs + timeWindow <= now`, which is a boundary a
 * wait of exactly the reported remaining time can land ON rather than past — and `Retry-After` is
 * a whole number of seconds derived from a millisecond ttl, so it is already rounded. One second
 * removes that race for a cost nobody will notice. It is not a fudge factor for clock skew: the
 * harness and the server are different processes and there is no assumption here that their
 * clocks agree, only that a ttl the server computed is a duration.
 */
export const RECOVERY_PADDING_SECONDS = 1;

/**
 * One `Retry-After` / `x-ratelimit-reset` header value as whole seconds, or null.
 *
 * Only the delta-seconds form is accepted. RFC 9110 also allows an HTTP-date, and this API never
 * sends one — `@fastify/rate-limit` emits `Math.ceil(ttl / 1000)` — so a date here would mean a
 * proxy rewrote the header, and turning a date into a duration requires trusting that two clocks
 * agree. Reporting "there is nothing to wait for" is more useful than a wait computed from a
 * disagreement, so a date returns null and the caller says so out loud.
 *
 * Anything that is not a run of digits is null, including a negative delta: `-5` is not a
 * duration, and `Number('-5')` succeeding is exactly how a malformed header becomes an instant
 * retry that fails again.
 */
export function parseDeltaSeconds(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * How long to wait before retrying, from every source a 429 carries, or null when none parse.
 *
 * The LARGEST candidate wins. `Retry-After` and `x-ratelimit-reset` are both derived from the
 * same ttl and the library has historically rounded them in opposite directions; the harness gets
 * exactly one retry, so spending it a second early because the smaller number was believed is the
 * failure mode worth engineering against. Waiting a second too long costs a second.
 *
 * `bodySeconds` is `error.retryAfterSeconds` from the JSON body, which `errors.ts` builds from the
 * same number as the header. It is read as a third source rather than assumed redundant, because a
 * proxy that strips response headers cannot strip a body.
 */
export function recoveryWaitSeconds({ retryAfter, rateLimitReset, bodySeconds }) {
  const candidates = [
    parseDeltaSeconds(retryAfter),
    parseDeltaSeconds(rateLimitReset),
    typeof bodySeconds === 'number' && Number.isSafeInteger(bodySeconds) && bodySeconds >= 0
      ? bodySeconds
      : null,
  ].filter((value) => value !== null);
  return candidates.length === 0 ? null : Math.max(...candidates);
}

/**
 * Whether a 429 on `POST /auth/guest` is leftover quota or the limiter doing its job.
 *
 * `attempt` is the 1-based count of guest creations THIS PROCESS has made when the 429 arrived;
 * `limit` is the route's own `x-ratelimit-limit`. A run that has made no more requests than the
 * limit allows cannot have exhausted the limit by itself, so the budget was spent by something
 * else — in practice the previous run's section 12. Past the limit, the 429 is the control working
 * exactly as documented and must never be waited out, because waiting would turn "this limit is
 * too low for the harness to complete a single run" into a silent pause.
 *
 * The count is a LOWER BOUND, and that is the safe direction. Section 11 makes the web server
 * create a guest of its own, which this process cannot see and does not count; the effect is to
 * make a genuine 'working' look like 'leftover'. The cost of that error is one bounded wait and a
 * retry that fails honestly. The opposite error — reading leftover quota as the limiter working —
 * is the one that produces the wrong diagnosis, and undercounting cannot cause it.
 */
export function classifyGuestLimit({ attempt, limit }) {
  if (!Number.isInteger(attempt) || attempt < 1) return 'indeterminate';
  if (!Number.isInteger(limit) || limit < 1) return 'indeterminate';
  return attempt <= limit ? 'leftover' : 'working';
}

/**
 * What to do about a 429 that stopped this run getting a session.
 *
 * Returns `{ action, waitMs, reason }`. `reason` is a sentence, not a code: it is printed
 * verbatim, and the whole point of this work is that the run says what happened rather than
 * failing four sections later for something else.
 *
 * The four refusals, in order, because each makes the ones below it meaningless:
 *
 *  1. The limiter is working and this run spent the budget. Waiting would hide a limit set too
 *     low for one run of this harness to finish — a real misconfiguration.
 *  2. This run already waited once. A second exhaustion inside one run means something other
 *     than the previous run is consuming the bucket (another harness, a shared address, a limit
 *     of one), and a retry loop would only make the report later and less clear.
 *  3. Nothing said how long to wait.
 *  4. The wait exceeds the bound.
 */
export function planRecovery({ verdict, waitSeconds, maxWaitSeconds, alreadyWaited }) {
  if (verdict === 'working') {
    return {
      action: 'abandon',
      waitMs: 0,
      reason:
        'this run has itself made more guest creations than the route allows, so the 429 is the ' +
        'limiter working as documented rather than quota left over from a previous run; the limit ' +
        'is too low for one run of this harness to complete',
    };
  }
  if (alreadyWaited === true) {
    return {
      action: 'abandon',
      waitMs: 0,
      reason:
        'this run has already waited out one window; a second exhaustion means something other ' +
        'than the previous run is consuming this address bucket',
    };
  }
  if (waitSeconds === null || waitSeconds === undefined) {
    return {
      action: 'abandon',
      waitMs: 0,
      reason:
        'the 429 carried no usable Retry-After, x-ratelimit-reset or retryAfterSeconds, so there ' +
        'is no window length to wait out',
    };
  }
  if (waitSeconds > maxWaitSeconds) {
    return {
      action: 'abandon',
      waitMs: 0,
      reason:
        `the window has ${waitSeconds}s left, which exceeds the --max-wait bound of ` +
        `${maxWaitSeconds}s; configure RATE_LIMIT_RESET_TOKEN rather than raising the bound`,
    };
  }
  return {
    action: 'wait',
    waitMs: (waitSeconds + RECOVERY_PADDING_SECONDS) * 1_000,
    reason: `the window has ${waitSeconds}s left, so this run waits it out and retries once`,
  };
}

/**
 * What an origin implies about which rate-limit bucket the run will consume.
 *
 * Stated rather than assumed, because it was the last untracked source of run-to-run variance
 * once the counters could be reset: a hostname resolves to whatever the machine resolves it to,
 * and the API keys `::1` and `127.0.0.1` separately on purpose.
 */
export function originBucketNote(origin) {
  const host = new URL(origin).hostname;
  const literal = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  return literal
    ? `${host} is a literal address, so DNS resolution order cannot move this run between buckets`
    : `${host} is a hostname; whichever address it resolves to decides the rate-limit bucket, and ` +
        '::1 and 127.0.0.1 are deliberately separate buckets — pass --origin with a literal address ' +
        'to pin it';
}

// ---------------------------------------------------------------------------
// Assertions about absence
// ---------------------------------------------------------------------------

/**
 * True when `value` is not a non-empty array — because it is empty, or because it is not there.
 *
 * ## The defect this exists for
 *
 * Section 5 asserted `report.uncertainty?.limitations?.length === 0`. For a report that carries
 * no `uncertainty` at all, `?.` short-circuits to `undefined`, `undefined === 0` is false, and
 * there was no `else` — so the field simply going missing produced neither a pass nor a
 * failure. The check evaporated, silently, in exactly the state that is MORE broken than the
 * one it was written to catch: an empty `limitations` array is a coach report that stated no
 * limitations, and a missing `uncertainty` object is a coach report that has stopped modelling
 * uncertainty at all.
 *
 * This is the idiom the rest of the file already used two lines away (`assumptions`,
 * `whatWouldChangeIt`, the Legends disclaimers), named and shared so that the next assertion
 * about a list cannot be written the other way by accident.
 */
export function listIsMissingOrEmpty(value) {
  return !Array.isArray(value) || value.length === 0;
}

/**
 * True when a sampled equity result came back without the interval that makes it honest.
 *
 * `== null`, not `=== null`: the check was written `=== null` and therefore passed a response
 * whose `confidenceHalfWidthPoints` key was absent entirely — which is what a serialiser that
 * drops undefined fields produces, and what a route that stopped computing the interval would
 * produce. A Monte Carlo figure printed without its half-width is a number that reads as exact
 * and is not, which is the single claim this repository's uncertainty policy is about. `!= null`
 * is the idiom already used for `holeCards` in section 8.
 */
export function sampledEquityMissesInterval(equity) {
  return equity?.method === 'monte-carlo' && equity?.confidenceHalfWidthPoints == null;
}

/**
 * Seats in one live `state` frame whose hole cards the recipient was not entitled to see.
 *
 * ## The defect this exists for
 *
 * Section 7's scan was `if (frame.view.street === 'complete') return false` — every frame of a
 * finished hand skipped, unconditionally, on the reasoning that a showdown makes cards public.
 * A showdown does. A FOLD does not, and `HandResult.showdowns` is documented as "empty when the
 * hand ended before showdown (everyone else folded)" while `endedByFold` says so in one field.
 * The smoke run's own client checks or calls when it can and folds when it cannot, so hands that
 * end without a showdown are the ordinary case here, not the exotic one.
 *
 * Measured against a stub API that served the opponent's hole cards in the `street: 'complete'`
 * frame of a hand nobody showed down: section 7 printed
 * `✓ no live frame carried another seat's hole cards mid-hand` and
 * `✓ no socket frame carried a deck, cursor or salt`, section 8 printed
 * `✓ an archived hand carries no opponent's unshown hole cards` — because the archive was
 * honest and only the wire was not — and the run reported no failure of any kind. That is the
 * single claim this script exists to make ("one player must never receive another player's
 * private cards") passing green over a live leak.
 *
 * So the exemption is now the one `redactFor` actually implements
 * (`maySeeCards = isSelf || shownSeats.has(seat.seat)`, packages/poker-engine/src/redact.ts):
 * cards may appear for the recipient's own seat, and for a seat named in
 * `view.result.showdowns` of a COMPLETED hand. Anything else is a leak whatever the street says.
 *
 * Three deliberate details:
 *
 *   * `holeCards != null`, not `!== null`. An absent key is a seat whose cards were not sent,
 *     which is the safe state; the strict form called that a leak and would have reported one
 *     against a serialiser that drops nulls. This is the idiom section 8 already uses.
 *   * A seat is the recipient's own when `isSelf === true` OR its index equals `viewerSeat`.
 *     Either field being renamed away therefore narrows the exemption rather than widening it,
 *     so the failure lands in the safe direction.
 *   * `shown` is built only for a completed hand, and only from an ARRAY. A `result` of null —
 *     which is what a completed frame carries if the server stopped populating it — exempts
 *     nobody, so the check gets stricter rather than evaporating.
 *
 * @returns {number[]} the offending seat indices, empty when the frame is clean or is not a view
 */
export function unentitledHoleCardSeats(frame) {
  if (frame?.type !== 'state' || frame.view === null || frame.view === undefined) return [];
  const view = frame.view;
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const showdowns =
    view.street === 'complete' && Array.isArray(view.result?.showdowns) ? view.result.showdowns : [];
  const shown = new Set(showdowns.map((showdown) => showdown?.seat));
  return seats
    .filter((seat) => seat?.holeCards != null)
    .filter((seat) => seat.isSelf !== true && seat.seat !== view.viewerSeat)
    .filter((seat) => !shown.has(seat.seat))
    .map((seat) => seat.seat);
}

/**
 * What the live wire said about the hand section 7 just played, for section 8 to hold the archive
 * to.
 *
 * The ground truth has to come from the socket and not from the archive, because the archive is
 * the thing being checked. `viewerSeat` says which seat's cards this caller is entitled to and
 * `result.showdowns` says which other seats legitimately opened theirs; a review that disagrees
 * with either is either serving cards nobody showed or claiming a showdown that never happened.
 *
 * Read off the LAST `state` frame, which for a completed hand is the terminal one. Every field is
 * type-checked rather than defaulted: a rename that turned `viewerSeat` into `undefined` would
 * otherwise make `seat.seat === truth.viewerSeat` false for every seat and quietly widen the
 * caller's entitlement to nothing, which reads as a stricter check and is in fact a broken one.
 * Absence returns null, and the caller treats null as a failure rather than as "nothing to check".
 *
 * @returns {{handId: string|null, viewerSeat: number|null, shownSeats: number[], complete: boolean}|null}
 */
export function liveHandTruth(frames) {
  const states = (Array.isArray(frames) ? frames : []).filter(
    (frame) => frame?.type === 'state' && frame.view !== null && frame.view !== undefined,
  );
  const last = states[states.length - 1];
  if (last === undefined) return null;
  const view = last.view;
  const showdowns = Array.isArray(view.result?.showdowns) ? view.result.showdowns : [];
  return {
    handId: typeof view.handId === 'string' ? view.handId : null,
    viewerSeat: typeof view.viewerSeat === 'number' ? view.viewerSeat : null,
    shownSeats: showdowns.map((showdown) => showdown?.seat).filter((seat) => typeof seat === 'number'),
    complete: view.street === 'complete',
  };
}

/**
 * Audits one served `GET /hands/:handId` against what the live wire said about the same hand.
 *
 * ## The defect this exists for
 *
 * Section 8's card check was:
 *
 *     const foreignCards = aliceRows.filter((hand) => {
 *       const seats = Array.isArray(hand.seats) ? hand.seats : [];
 *       return seats.some((seat) => seat.holeCards != null && seat.isSelf !== true && ...);
 *     });
 *
 * over the rows of `GET /api/v1/hands`. That response is `HandListResponse`, whose rows are
 * `HandSummary` — `id, roomId, handNumber, startedAt, completedAt, board, heroNet, endedByFold,
 * potTotal` — and it has no `seats` field at all, by design: `routes/hands.ts` says "hand_seats.
 * hole_cards is never projected here". So `hand.seats` was `undefined` on every row, the ternary
 * substituted `[]`, `.some()` over `[]` is false, and the run printed
 * `✓ an archived hand carries no opponent's unshown hole cards` having examined zero seats and
 * zero cards. Measured against the real routes and a real database on 2026-08-27, with a two-seat
 * fold-out hand in the archive: `row keys: ["id","roomId","handNumber","startedAt","completedAt",
 * "board","heroNet","endedByFold","potTotal"]`, `row.seats is undefined`, `foreignCards=0, seats
 * actually examined=0`. The one route that does serve hole cards, `GET /hands/:handId`, was never
 * fetched by this script for a real hand — only `hand_doesnotexist`.
 *
 * That is the same shape as the incident `unentitledHoleCardSeats` above was written for: the
 * strongest confidentiality claim in this file, green over a surface it had never looked at.
 *
 * ## The rule, and why `overclaimed` is part of it
 *
 * `HandReviewSeat` carries `{seat, displayName, isBot, startingStack, net, holeCards, showedDown}`
 * and — unlike a live `SeatView` — has no `isSelf`, so the caller's own seat has to come from the
 * wire (`truth.viewerSeat`). Cards may appear for that seat, or for a seat whose `showedDown` is
 * true, and nowhere else: the rule in `apps/api/src/review/build-review.ts`'s `toReviewSeat` and
 * in the SQL `case` it is fed from.
 *
 * `showedDown` is itself an assertion the server makes, so trusting it alone would let a server
 * that marked every seat as having shown open every hand and still pass. `overclaimed` holds it
 * to `result.showdowns` from the live hand: a seat the wire did not name as having shown must not
 * be marked as having shown in the archive.
 *
 * `examined` and `ownCards` exist because a sweep of nothing is not a pass. A review with no seat
 * rows, or one carrying no hole cards whatsoever, satisfies `leaked.length === 0` for free — which
 * is exactly how the old check passed. The caller fails on both.
 *
 * @returns {{leaked: number[], overclaimed: number[], examined: number, ownCards: boolean}}
 */
export function auditReviewSeats(review, truth) {
  const seats = Array.isArray(review?.seats) ? review.seats : [];
  const shown = new Set(Array.isArray(truth?.shownSeats) ? truth.shownSeats : []);
  const ownSeat = typeof truth?.viewerSeat === 'number' ? truth.viewerSeat : null;
  const leaked = [];
  const overclaimed = [];
  let ownCards = false;
  for (const seat of seats) {
    // `!= null`, not `!== null`: an absent key is a seat whose cards were not sent, which is the
    // safe state. The idiom `unentitledHoleCardSeats` already uses, for the same reason.
    const hasCards = seat?.holeCards != null;
    const isOwn = ownSeat !== null && seat?.seat === ownSeat;
    if (seat?.showedDown === true && !shown.has(seat.seat)) overclaimed.push(seat.seat);
    if (hasCards && isOwn) ownCards = true;
    if (hasCards && !isOwn && seat?.showedDown !== true) leaked.push(seat.seat);
  }
  return { leaked, overclaimed, examined: seats.length, ownCards };
}

/**
 * What a hostile calculation input's response actually proves.
 *
 * ## The defect this exists for
 *
 * The negative control read `if (response.status >= 400 && response.status < 500) rejected += 1`,
 * so ANY 4xx counted. Section 12 exhausts the expensive-rate-limit budget, and a run in which
 * that budget was already spent answered all six probes with 429 — a status the limiter produces
 * before the request reaches a route, let alone a validator. The script then printed "all 6
 * hostile calculation inputs rejected" having demonstrated nothing whatsoever about validation:
 * the strongest safety claim in section 5, entirely unearned, on a green run.
 *
 * So the refusal has to be a VALIDATION refusal, identified by the contract error code the way
 * section 3 identifies `csrf_failed` rather than by a status class:
 *
 *   - `invalid_request` (400) — the closed schema rejected the body;
 *   - `computation_rejected` (422) — the body parsed and the calculator refused it, which is
 *     where the absurd sample count and the duplicate card land;
 *   - `payload_too_large` (413) — the same refusal taken at the body limit.
 *
 * A 429 is `untested`, never a pass: the probe did not reach a validator, so the run has no
 * evidence either way and must say so rather than count it.
 */
const VALIDATION_REFUSAL_CODES = new Set(['invalid_request', 'computation_rejected', 'payload_too_large']);

export function classifyHostileRefusal(response) {
  const code = response?.json?.error?.code;
  if (response?.status === 429 || code === 'rate_limited') {
    return { kind: 'untested', why: 'the rate limiter answered before any validator ran' };
  }
  if (typeof code === 'string' && VALIDATION_REFUSAL_CODES.has(code)) {
    return { kind: 'rejected', why: code };
  }
  if (response?.status >= 400 && response?.status < 500) {
    return { kind: 'wrong-refusal', why: `refused with ${response.status} ${code ?? '(no contract code)'}` };
  }
  return { kind: 'accepted', why: `returned ${response?.status}` };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The WebSocket protocol version this script speaks. Must match WS_PROTOCOL_VERSION. */
const WS_PROTOCOL_VERSION = 1;

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

let passed = 0;
const failures = [];
const warnings = [];

/**
 * The run's options, set once by `main()`.
 *
 * Module-level and mutable, which is a departure worth naming: everything else in this file is
 * either pure or takes what it needs. The alternative was to parse argv at module scope, and that
 * makes the file unimportable — `node --test scripts/smoke-test.test.mjs` would hand its own argv
 * to `parseArgs` and die on an unknown option before a single assertion ran.
 */
let options = null;

const ok = (label, detail = '') => {
  passed += 1;
  console.log(`${GREEN}  ✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
};
const bad = (label, detail) => {
  failures.push(`${label} — ${detail}`);
  console.log(`${RED}  ✗${RESET} ${label}\n${DIM}      ${detail}${RESET}`);
};
const warn = (label, detail) => {
  if (options?.strict === true) {
    bad(label, `${detail}  (a warning, promoted to a failure by --strict)`);
    return;
  }
  warnings.push(`${label} — ${detail}`);
  console.log(`${YELLOW}  !${RESET} ${label} ${DIM}${detail}${RESET}`);
};
/**
 * An observation that is neither a pass nor a problem.
 *
 * Deliberately not `warn`: `--strict` turns a warning into a failure, and "there is no reset
 * token, so the fallback will be used" must not fail a run whose whole purpose is to prove the
 * fallback works. It is counted nowhere and printed always.
 */
const note = (detail) => console.log(`${DIM}  · ${detail}${RESET}`);
const section = (name) => console.log(`\n${BOLD}${name}${RESET}`);

/** A browser-like client: keeps cookies, sends Origin, echoes the CSRF token. */
function createClient(name) {
  const cookies = new Map();
  let csrfToken = null;

  const request = async (method, path, body, extraHeaders = {}) => {
    const headers = { origin: options.webOrigin, accept: 'application/json', ...extraHeaders };
    if (cookies.size > 0) {
      headers['cookie'] = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (csrfToken !== null && method !== 'GET') headers['x-csrf-token'] = csrfToken;

    const response = await fetch(`${options.apiOrigin}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual',
    });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = (pair ?? '').indexOf('=');
      if (eq > 0) cookies.set((pair ?? '').slice(0, eq), (pair ?? '').slice(eq + 1));
    }

    const text = await response.text();
    let json = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  };

  return {
    name,
    request,
    setCsrf(token) {
      csrfToken = token;
    },
    get cookieNames() {
      return [...cookies.keys()];
    },
    /** The jar as a `Cookie` header, for the WebSocket upgrade — which `fetch` cannot do for us. */
    get cookieHeader() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
  };
}

/** Recursively collect every string in an object graph, for leak scanning. */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

/** Every key name anywhere in an object graph. */
function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) for (const item of value) collectKeys(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      collectKeys(item, out);
    }
  }
  return out;
}

/**
 * Sits at a room over a REAL WebSocket and plays one hand to completion against the seated bot.
 *
 * ## Why the smoke test now opens a socket
 *
 * Section 8 asserts the confidentiality property this product is judged on — one player must never
 * receive another player's private cards. It used to assert it against two EMPTY hand histories,
 * because nothing in this script had ever played a hand: `collectKeys({hands: []})` cannot contain
 * `deck`, and comparing two empty sets of hand ids always finds no overlap. Three green ticks,
 * every one of them unconditional. A check that cannot fail is not a check.
 *
 * So a hand is played first, and section 8 refuses to run its scan against an empty list.
 *
 * Uses the global `WebSocket` (Node 24) with the non-standard options bag as the SECOND argument,
 * which is the only way to attach the session cookie to an upgrade — see the header of
 * scripts/load-test.mjs for the full explanation.
 *
 * Returns what was observed, so the caller can assert on it. Never throws: a failure here is
 * reported through `bad()` like every other check, and the caller degrades to reporting it rather
 * than the whole script dying half way through.
 */
async function playOneHandOverSocket(client, roomId, seat, timeoutMs = 30_000) {
  const url = new URL('/api/v1/ws', options.apiOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const observed = {
    welcomed: false,
    sat: false,
    completed: false,
    frames: [],
    closeCode: null,
    error: null,
  };

  await new Promise((resolve) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      observed.error = error;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'smoke test complete');
      resolve();
    };
    const timer = setTimeout(() => finish('timed out waiting for the hand to complete'), timeoutMs);

    const socket = new WebSocket(url, {
      headers: { cookie: client.cookieHeader, origin: options.webOrigin },
    });
    let lastActedKey = null;
    const send = (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    socket.addEventListener('open', () => {
      send({ type: 'hello', protocolVersion: WS_PROTOCOL_VERSION, roomId, clientNonce: 'smoke-nonce-1' });
    });

    socket.addEventListener('close', (event) => {
      observed.closeCode = event.code;
      finish(observed.completed ? null : `socket closed with ${event.code} before the hand completed`);
    });
    socket.addEventListener('error', () => finish('websocket error'));

    socket.addEventListener('message', (message) => {
      let frame;
      try {
        frame = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
      } catch {
        finish('a frame did not parse as JSON');
        return;
      }
      observed.frames.push(frame);

      if (frame.type === 'welcome') {
        observed.welcomed = true;
        send({ type: 'sit', seat, requestId: 'req-smokesit1' });
        return;
      }
      if (frame.type === 'ack' && frame.requestId === 'req-smokesit1') {
        observed.sat = true;
        send({ type: 'startHand', requestId: 'req-smokedeal' });
        return;
      }
      if (frame.type === 'error') {
        finish(`server refused a frame: ${frame.error?.code ?? 'unknown'}`);
        return;
      }
      if (frame.type !== 'state' || frame.view === null || frame.view === undefined) return;

      const view = frame.view;
      if (view.street === 'complete') {
        observed.completed = true;
        finish(null);
        return;
      }
      // Act only when the server says it is this seat's turn, and only with an action it offered.
      const legal = Array.isArray(view.legalActions) ? view.legalActions : [];
      if (legal.length === 0 || view.toAct === null || view.toAct !== view.viewerSeat) return;
      const key = `${String(view.handId)}:${view.actionSequence}`;
      if (key === lastActedKey) return;
      lastActedKey = key;
      const types = new Set(legal.map((action) => action.type));
      const chosen = types.has('check') ? 'check' : types.has('call') ? 'call' : 'fold';
      send({
        type: 'action',
        actionId: `act-smoke${String(view.actionSequence).padStart(4, '0')}`,
        expectedSequence: view.actionSequence,
        requestId: `req-smokeact${String(view.actionSequence).padStart(2, '0')}`,
        action: { type: chosen },
      });
    });
  });

  return observed;
}

/**
 * Opens a socket, handshakes, sends ONE `sit` frame, and reports what came back.
 *
 * ## Why this exists next to `playOneHandOverSocket`
 *
 * That helper plays a whole hand and treats any `error` frame as a failure, which is exactly right
 * for what it proves and exactly wrong here: the subject IS the error frame. This one asks the one
 * question the seat guard is about — what does the server do with a `sit` from this session — and
 * reports the answer as data rather than as a verdict.
 *
 * ## The three things it reports and why each matters
 *
 * `welcomed` — the handshake succeeded. It must, in BOTH directions: watching a table is not the
 * course, and a deployment that refused the upgrade to an unenrolled learner would have gated the
 * shop window rather than the seat.
 *
 * `errorCode` — the refusal, as a contract code. A bare 403 would be a bad answer to a student.
 *
 * `closeCode` — null when the socket was left open, which is the required behaviour for this
 * refusal: it is permanent, so closing would send an honest client into a reconnect loop against
 * something only an operator can lift, and it would throw away the panel that displays the reason.
 *
 * Never throws, like every other helper here: a failure is reported through the caller's `bad()`.
 */
async function sitOverSocket(client, roomId, seat, timeoutMs = 20_000) {
  const url = new URL('/api/v1/ws', options.apiOrigin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const observed = { welcomed: false, acked: false, errorCode: null, closeCode: null, error: null };

  await new Promise((resolve) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      observed.error = error;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'smoke test complete');
      resolve();
    };
    const timer = setTimeout(() => finish('timed out waiting for an answer to the sit frame'), timeoutMs);
    const socket = new WebSocket(url, {
      headers: { cookie: client.cookieHeader, origin: options.webOrigin },
    });

    socket.addEventListener('open', () => {
      socket.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: WS_PROTOCOL_VERSION,
          roomId,
          clientNonce: 'enrolment-nonce-1',
        }),
      );
    });
    socket.addEventListener('close', (event) => {
      observed.closeCode = event.code;
      finish(observed.welcomed ? null : `socket closed with ${event.code} before the handshake`);
    });
    socket.addEventListener('error', () => finish('websocket error'));
    socket.addEventListener('message', (message) => {
      let frame;
      try {
        frame = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
      } catch {
        finish('a frame did not parse as JSON');
        return;
      }
      if (frame.type === 'welcome') {
        observed.welcomed = true;
        socket.send(JSON.stringify({ type: 'sit', seat, requestId: 'req-enrolsit1' }));
        return;
      }
      if (frame.type === 'error') {
        observed.errorCode = frame.error?.code ?? 'unknown';
        // Deliberately does NOT finish immediately. The point of the next moment is to see whether
        // the server ALSO closes the socket, which is the behaviour under test — a permanent
        // refusal that closed the connection would put an honest client into a reconnect loop. The
        // `close` listener settles the run if it happens; this short timer settles it if it does
        // not. Short because both the frame and any close arrive in the same round trip, and
        // waiting out the full deadline would add twenty seconds per refusal to a release gate.
        setTimeout(() => finish(null), REFUSAL_OBSERVATION_MS);
        return;
      }
      if (frame.type === 'ack' && frame.requestId === 'req-enrolsit1') {
        observed.acked = true;
        finish(null);
      }
    });
  });

  return observed;
}

/** How long a refused sit is watched for a close frame that must not arrive. */
const REFUSAL_OBSERVATION_MS = 1_000;

// ---------------------------------------------------------------------------
// The enrolment CLI, as an operator would run it
// ---------------------------------------------------------------------------

/**
 * Runs `apps/api/scripts/enrolments.mjs`, which is the ONLY way an enrolment can be written.
 *
 * ## Why this shells out instead of connecting to the database itself
 *
 * Because the privilege model says it must, and because the alternative is a second copy of the
 * grant statement. `db/migrations/0006_cohort_enrolments.sql` grants `prl_app` — the role the API
 * connects as — SELECT and nothing else on `prl.cohorts` and `prl.enrolments`, so the running
 * server cannot enrol anybody and there is no HTTP route that could. The write needs
 * `DATABASE_MIGRATION_URL`, the migrating identity, which this harness has only when its caller
 * hands it one. Running the operator's own tool means this run exercises the documented path
 * rather than a private one that could drift from it.
 *
 * ## What is redacted
 *
 * The DSN goes in through the environment and never onto a command line (where `ps` would show it)
 * and never into the output: the CLI redacts every connection string it prints, and the caller
 * below prints only the exit status and the tail of the message.
 */
function runEnrolmentCli(args) {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, 'apps/api/scripts/enrolments.mjs'), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_MIGRATION_URL: options.migrationUrl, NO_COLOR: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return { ok: result.status === 0, status: result.status, output };
}

/** The last non-empty line of the CLI's output, which is where its verdict is. */
function lastLine(output) {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  return (lines.at(-1) ?? '').trim().slice(0, 200);
}

// ---------------------------------------------------------------------------
// Guest creation, counted and recoverable
// ---------------------------------------------------------------------------

/**
 * How many guest creations this process has sent, and whether it has already waited out a window.
 *
 * The count is what `classifyGuestLimit` needs to tell leftover quota from a working limiter, so
 * EVERY call to `POST /auth/guest` in this file goes through `postGuest` — including section 3's
 * deliberately token-less probe, which is refused for CSRF but is counted by the limiter first
 * (the rate-limit hook is `onRequest`, the CSRF check is `preValidation`).
 */
let guestAttempts = 0;
let alreadyWaited = false;

/**
 * Not `async`, deliberately: the counter must be incremented BEFORE the request is sent, not when
 * its promise settles, or two concurrent creations would both read the pre-increment value and the
 * classifier would be told a smaller number than the server counted. Returning the promise from a
 * plain function is also what the linter wants from a body with nothing to await.
 */
function postGuest(client, displayName) {
  guestAttempts += 1;
  return client.request('POST', '/api/v1/auth/guest', { displayName });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a guest session, recovering once from quota a previous run consumed.
 *
 * Returns the successful response, or exits the process with the real diagnosis. Exiting is the
 * point: before this, a 429 here was reported as `bad('guest creation')` and the run carried on
 * without a session, so sections 7, 8 and 9 failed for reasons that had nothing to do with rooms,
 * hand history or progress. Four wrong diagnoses are worse than one right one.
 */
async function createGuestSession(client, displayName) {
  const first = await postGuest(client, displayName);
  if (first.status === 200 || first.status === 201) return first;

  if (first.status !== 429) {
    fatalGuestFailure(
      client,
      `expected 200 or 201, got ${first.status} ${first.text.slice(0, 200)}`,
      'That status is not a rate limit, so the cause is upstream of this harness.',
    );
  }

  const limit = parseDeltaSeconds(first.headers.get('x-ratelimit-limit'));
  const verdict = classifyGuestLimit({ attempt: guestAttempts, limit });
  const waitSeconds = recoveryWaitSeconds({
    retryAfter: first.headers.get('retry-after'),
    rateLimitReset: first.headers.get('x-ratelimit-reset'),
    bodySeconds: first.json?.error?.retryAfterSeconds,
  });
  const plan = planRecovery({
    verdict,
    waitSeconds,
    maxWaitSeconds: options.maxWaitSeconds,
    alreadyWaited,
  });

  if (plan.action === 'abandon') {
    fatalGuestFailure(
      client,
      `429 rate_limited after ${guestAttempts} guest creation(s) this run, limit ${limit ?? 'unknown'}`,
      plan.reason,
    );
  }

  note(
    `${client.name} was refused 429 on its first guest creation, which this run cannot have caused ` +
      `(${guestAttempts} attempt(s) against a limit of ${limit ?? 'unknown'}). ${plan.reason}.`,
  );
  note(
    "The cause is this harness's own previous run: section 12 floods the guest limiter on purpose " +
      'and the window is fixed, not sliding. Set RATE_LIMIT_RESET_TOKEN on a non-production API to ' +
      'make this instant.',
  );
  alreadyWaited = true;
  await sleep(plan.waitMs);

  const retry = await postGuest(client, displayName);
  if (retry.status === 200 || retry.status === 201) {
    ok(
      `${client.name} obtained a session after waiting out the previous run's window`,
      `${Math.round(plan.waitMs / 1_000)}s waited, one retry`,
    );
    return retry;
  }
  fatalGuestFailure(
    client,
    `the retry after waiting ${Math.round(plan.waitMs / 1_000)}s returned ${retry.status} ` +
      `${retry.text.slice(0, 160)}`,
    'The window was waited out in full and the budget was still spent, so something other than ' +
      'this harness is driving that address bucket.',
  );
}

/**
 * Stops the run, mirroring section 1's behaviour for an unreachable API.
 *
 * A missing session is not a check that failed; it is the precondition for four later sections,
 * and continuing past it manufactures failures that name the wrong subsystem.
 */
function fatalGuestFailure(client, detail, why) {
  bad(`${client.name} could not obtain a guest session`, detail);
  console.log(
    `\n${RED}This run cannot continue: sections 7, 8 and 9 all need a session, and without one they ` +
      `would fail for a reason that has nothing to do with what they test.${RESET}\n` +
      `${DIM}  ${why}\n` +
      '  Deterministic fix:  start the API with RATE_LIMIT_RESET_TOKEN set (never possible in\n' +
      '                      production — loadConfig refuses to boot) and pass the same value as\n' +
      '                      --reset-token, or leave it in .env and run with --env-file.\n' +
      '  Fallback:           wait for the guest window to elapse and run again; this harness does\n' +
      '                      that automatically when the wait is within --max-wait ' +
      `(${options.maxWaitSeconds}s).${RESET}\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** 1. Liveness and readiness. Exits the process when the API is not there at all. */
async function sectionHealth() {
  section('1. Health');
  const health = await createClient('probe').request('GET', '/api/v1/health');
  if (health.status === 200 && health.json?.status === 'ok') {
    ok('health responds', `version ${health.json.version}, protocol ${health.json.protocolVersion}`);
  } else {
    bad('health', `expected 200 {status:"ok"}, got ${health.status} ${health.text.slice(0, 120)}`);
    console.log(`\n${RED}The API is not reachable. Start it with: pnpm run dev:api${RESET}\n`);
    process.exit(1);
  }

  const ready = await createClient('probe').request('GET', '/api/v1/ready');
  if (ready.status === 200 && ready.json?.status === 'ready') {
    ok('readiness passes', `database ${ready.json.checks?.database?.ok === true ? 'ok' : 'DEGRADED'}`);
  } else if (ready.json?.status === 'degraded') {
    warn('readiness degraded', JSON.stringify(ready.json.checks));
  } else {
    bad('readiness', `got ${ready.status} ${ready.text.slice(0, 120)}`);
  }
}

/**
 * Empties the rate-limit counters, when this deployment has the control and the caller has its
 * token. Unnumbered on purpose: the sections are referenced by number from three other files, and
 * renumbering them to make room would have made those references wrong to fix a different defect.
 *
 * Runs after section 1 rather than before it so that an API which is simply not running produces
 * section 1's "start it with pnpm run dev:api" rather than a confusing failure to reset something.
 * Health and readiness spend no guest quota, so nothing has been consumed by the time this runs.
 */
async function sectionIsolation() {
  section('Rate-limit isolation');
  note(
    `API origin ${options.apiOrigin} (from ${options.apiOriginSource}) — ${originBucketNote(options.apiOrigin)}`,
  );
  note(
    `section 11 drives ${options.webOrigin}, whose server-side calls reach the API on its own ` +
      'PRL_API_ORIGIN (default http://localhost:3001 in apps/web/src/lib/guest-bootstrap.ts). That ' +
      'may be a different address bucket from this one, and this run cannot see it.',
  );

  if (options.noReset) {
    note('--no-reset was passed, so the wait-out fallback is deliberately the mechanism under test.');
    return;
  }
  if (options.resetToken === '') {
    note(
      'no reset token (--reset-token, PRL_RATE_LIMIT_RESET_TOKEN, RATE_LIMIT_RESET_TOKEN), so a ' +
        `spent guest budget will be waited out instead, bounded at ${options.maxWaitSeconds}s.`,
    );
    return;
  }

  // The control is a POST, so it goes through the same CSRF check as every other mutating route —
  // it is not exempt and must not be. One GET first to obtain the token and its cookie.
  const client = createClient('isolation');
  const seed = await client.request('GET', '/api/v1/auth/session');
  if (typeof seed.json?.csrfToken === 'string') client.setCsrf(seed.json.csrfToken);

  const reset = await client.request('POST', RATE_LIMIT_RESET_PATH, undefined, {
    authorization: `Bearer ${options.resetToken}`,
  });

  if (reset.status === 200 && typeof reset.json?.cleared === 'number') {
    ok('rate-limit counters reset before the run', `${reset.json.cleared} counter(s) cleared`);
    return;
  }
  if (reset.status === 404) {
    note(
      `${RATE_LIMIT_RESET_PATH} is not registered on this server, so it was started without ` +
        'RATE_LIMIT_RESET_TOKEN (a production process cannot have it at all). Falling back to ' +
        'waiting out any window this harness consumed.',
    );
    return;
  }
  // A refused token is a failure and not a fallback: the caller asked for isolation with a
  // credential the server did not accept, and quietly proceeding is how a control rots.
  bad(
    'rate-limit reset',
    `the reset control answered ${reset.status} ${reset.text.slice(0, 160)} — the token this ` +
      'harness holds is not the one the server was started with',
  );
}

/** 2. Guest session, CSRF token, and the units framing. */
async function sectionGuestSession() {
  section('2. Guest session');
  const alice = createClient('alice');

  const anon = await alice.request('GET', '/api/v1/auth/session');
  if (anon.status === 200 && anon.json?.user === null) {
    ok('an anonymous session read returns 200 with user:null', 'guest-first, not a 401');
  } else {
    bad('anonymous session read', `expected 200 user:null, got ${anon.status} ${anon.text.slice(0, 120)}`);
  }
  if (typeof anon.json?.csrfToken === 'string') alice.setCsrf(anon.json.csrfToken);

  const guest = await createGuestSession(alice, 'Alice');
  const user = guest.json?.user;
  ok('guest created', `${user?.displayName} with ${user?.units} units`);
  if (typeof user?.units !== 'number' || user.units <= 0) {
    bad('guest units', `expected a positive unit balance, got ${String(user?.units)}`);
  }
  if (typeof guest.json?.csrfToken === 'string') alice.setCsrf(guest.json.csrfToken);
  if (!alice.cookieNames.some((name) => /session/i.test(name))) {
    fatalGuestFailure(
      alice,
      `no session cookie was set; got ${alice.cookieNames.join(', ')}`,
      'The account was created and the cookie was not returned, so this is a session-issuing ' +
        'defect rather than a rate limit.',
    );
  }
  ok('session cookie set', alice.cookieNames.join(', '));

  // No currency framing anywhere in the payload.
  const strings = collectStrings(guest.json).join(' ');
  if (/[$£€]|\bUSD\b|\bbalance\b/i.test(strings)) {
    bad('units framing', 'the session payload uses currency or "balance" wording');
  } else {
    ok('no currency framing in the session payload');
  }

  const authed = await alice.request('GET', '/api/v1/auth/session');
  if (authed.json?.user?.id !== undefined) ok('the session persists across requests', authed.json.user.id);
  else bad('session persistence', `got ${authed.status} ${authed.text.slice(0, 120)}`);

  // The account id as well as the client. The enrolment section needs it, because the operator CLI
  // resolves people by `usr_` id or by OIDC subject and a guest has only the first.
  return { client: alice, userId: authed.json?.user?.id ?? user?.id ?? '' };
}

/**
 * Enrolment and the seat guard: BOTH directions, over BOTH transports, against the live deployment.
 *
 * ## Why this section is unnumbered, and why it runs here
 *
 * Unnumbered for the same reason `Rate-limit isolation` is: it is not one of the numbered journeys,
 * it prepares the ones that follow. It runs immediately after the guest session because section 7
 * has Alice take a seat and play a hand — so on a deployment with `PRL_ENROLMENT_REQUIRED=enforced`,
 * which is what staging runs, Alice has to be enrolled before section 7 or three later sections
 * fail for a reason that has nothing to do with rooms, hidden information or hand history. That is
 * the same mistake `createGuestSession` exists to stop making, one subsystem along.
 *
 * ## What it proves, and how the posture is decided
 *
 * The posture is DISCOVERED rather than assumed: a fresh guest who has never been enrolled asks for
 * a seat, and what comes back says which mode the server is in. That makes the discovery probe and
 * the negative direction the same request — there is no way for this to report "enforced" without
 * having watched a refusal happen.
 *
 * Enforced, four cells, all four asserted:
 *
 *   * unenrolled over REST      -> 403 enrolment_required
 *   * unenrolled over wss       -> an `error` frame carrying enrolment_required, socket LEFT OPEN
 *   * enrolled over wss         -> `ack`, seated
 *   * enrolled over REST        -> 200, seated
 *
 * Off (the shipped default, and what a developer stack runs): the same first request seats the
 * learner, and that is asserted too. It is not a skip — it is the control, run on every developer
 * and CI run of this script, that says the guard is absent exactly where it is meant to be absent.
 *
 * ## Where the enrolment comes from, given that the API cannot write one
 *
 * `prl_app` holds SELECT and nothing else on `prl.enrolments`, deliberately and by GRANT, so there
 * is no request this harness could make that would enrol anybody — which is the property being
 * relied on, not an inconvenience. The write goes through `apps/api/scripts/enrolments.mjs` as the
 * MIGRATING identity, from `DATABASE_MIGRATION_URL`, which `scripts/staging.mjs` already computes
 * for the migration step and now also hands to this run.
 *
 * A deployment that enforces, reached by a run with no migrating identity, is a FAILURE rather than
 * a note: the whole positive direction is unprovable, and quietly reporting three of four cells is
 * how a gate starts passing over less than it says.
 *
 * ## What it leaves behind
 *
 * Two revocations and a cohort. The cohort stays — `enrolments.cohort_id` is ON DELETE RESTRICT and
 * no role holds DELETE — and is reused by every later run. The entitlements are withdrawn by
 * `revokeEnrolments` at the very end of the run (not here, because Alice needs hers for sections 7
 * and 8), which is an UPDATE that keeps the record of the grant and its withdrawal. The guest
 * accounts themselves are erased by the retention sweep after 60 days, and `enrolments.user_id` is
 * ON DELETE CASCADE, so the rows go with them.
 */
async function sectionEnrolment(alice, aliceUserId) {
  section('Enrolment and the seat guard');

  /**
   * Puts a second session into the probe table by invite code, the way a second learner arrives.
   *
   * A second session is what both branches below need for their socket half, and for the same
   * reason: the first one is already in seat 0 by then, and a second `sit` from the SAME session is
   * answered `already_seated` whatever this deployment's entitlement posture is. That is a check
   * that passes or fails for a reason unrelated to the guard, which is worse than no check.
   */
  const joinProbeTable = async (client, inviteCode) => {
    if (typeof inviteCode !== 'string') return false;
    const joined = await client.request('POST', '/api/v1/rooms/join', { inviteCode });
    if (joined.status === 200 || joined.status === 201) return true;
    bad('enrolment probe', `a second session could not join the probe table: ${joined.status}`);
    return false;
  };

  // A guest who has never been enrolled and never will be until this section says so. Separate
  // from Alice on purpose: the refusal has to be observed against an account in the state a real
  // prospective student is in, and Alice is about to be enrolled.
  const carol = createClient('carol');
  const seed = await carol.request('GET', '/api/v1/auth/session');
  if (typeof seed.json?.csrfToken === 'string') carol.setCsrf(seed.json.csrfToken);
  const guest = await createGuestSession(carol, 'Carol');
  if (typeof guest.json?.csrfToken === 'string') carol.setCsrf(guest.json.csrfToken);
  const carolUserId = guest.json?.user?.id;
  if (typeof carolUserId !== 'string') {
    bad('enrolment probe', `the guest response carried no user id: ${guest.text.slice(0, 160)}`);
    return { enforced: false, enrolled: [] };
  }

  // Creating a table is NOT the course and must stay open, so this is asserted rather than assumed.
  // Somebody deciding whether to enrol can still open a table and look at it; what they cannot do
  // is take a seat at one.
  const created = await carol.request('POST', '/api/v1/rooms', {
    name: 'Enrolment probe table',
    maxSeats: 3,
    smallBlind: 5,
    bigBlind: 10,
    startingStack: 1000,
  });
  const roomId = created.json?.room?.id;
  const inviteCode = created.json?.inviteCode;
  if ((created.status === 200 || created.status === 201) && typeof roomId === 'string') {
    ok('an unenrolled learner can still create a table', 'the guard is on the seat, not the door');
  } else {
    bad('enrolment probe', `could not create a table: ${created.status} ${created.text.slice(0, 160)}`);
    return { enforced: false, enrolled: [] };
  }

  // THE PROBE, and the negative direction, in one request.
  const refusedRest = await carol.request('POST', `/api/v1/rooms/${roomId}/sit`, { seat: 0 });
  const restCode = refusedRest.json?.error?.code ?? '';
  const enforced = refusedRest.status === 403 && restCode === 'enrolment_required';

  if (!enforced && refusedRest.status !== 200) {
    bad(
      'seat guard',
      `sitting answered ${refusedRest.status} ${restCode || refusedRest.text.slice(0, 140)}, which is ` +
        'neither the open behaviour (200) nor the enforced one (403 enrolment_required)',
    );
    return { enforced: false, enrolled: [] };
  }

  if (options.expectEnrolment !== 'discover' && (options.expectEnrolment === 'enforced') !== enforced) {
    bad(
      'seat guard posture',
      `this run was told to expect PRL_ENROLMENT_REQUIRED=${options.expectEnrolment} and the server ` +
        `behaves as ${enforced ? 'enforced' : 'off'}. Either the deployment is not configured the ` +
        'way the caller believes, or the guard is not wired into the image it is running.',
    );
    return { enforced, enrolled: [] };
  }

  if (!enforced) {
    ok('an unenrolled learner is seated', 'PRL_ENROLMENT_REQUIRED is off, which is the shipped default');
    // A SECOND session for the socket half, not Carol again. Carol is now in seat 0, and a second
    // `sit` from her is answered `already_seated` whatever the entitlement posture is — which is a
    // check that proves nothing about the guard and passes for the wrong reason. Measured: it
    // reported `no ack; last code already_seated` and read as a socket-path failure.
    const joinedForSocket = await joinProbeTable(alice, inviteCode);
    const openSocket = joinedForSocket ? await sitOverSocket(alice, roomId, 1) : null;
    if (openSocket?.acked === true) {
      ok('and seated over the socket too', 'a second session, so the seat is genuinely free');
    } else {
      bad(
        'seat guard (off)',
        openSocket === null
          ? 'the second session could not join the probe table'
          : (openSocket.error ?? `no ack; last code ${String(openSocket.errorCode)}`),
      );
    }
    await alice.request('POST', `/api/v1/rooms/${roomId}/leave`);
    note(
      'the ENFORCED direction was not exercised here, because this deployment does not enforce. ' +
        '`pnpm run staging up` runs a stack that does, and passes --expect-enrolment enforced so ' +
        'that a run which cannot exercise it there fails instead of printing this line.',
    );
    return { enforced: false, enrolled: [] };
  }

  ok('an unenrolled learner is refused a seat over REST', `403 ${restCode}`);
  const message = refusedRest.json?.error?.message ?? '';
  if (/enrols? your class|not enrolled/i.test(message)) {
    ok('the refusal tells the learner what to do', `"${message.slice(0, 80)}…"`);
  } else {
    bad('refusal quality', `the message is not actionable: "${message.slice(0, 160)}"`);
  }
  if (/[$£€]|\bUSD\b|\bprice\b|\bpay\b/i.test(message)) {
    bad('refusal quality', 'the refusal implies a transaction; this software cannot take money');
  }

  const refusedSocket = await sitOverSocket(carol, roomId, 0);
  if (!refusedSocket.welcomed) {
    bad('seat guard (socket)', refusedSocket.error ?? 'the handshake itself failed');
  } else if (refusedSocket.errorCode === 'enrolment_required') {
    ok('an unenrolled learner is refused a seat over the socket', 'a real sit frame, over wss');
  } else if (refusedSocket.acked) {
    bad(
      'seat guard (socket)',
      'THE SOCKET PATH IS NOT GATED. REST refused this session and the sit frame seated it, which ' +
        'is worse than no guard at all: the deployment reads as enforced and is not.',
    );
  } else {
    bad('seat guard (socket)', `expected enrolment_required, got ${String(refusedSocket.errorCode)}`);
  }
  if (refusedSocket.closeCode === null) {
    ok('the refusal left the socket open', 'a permanent refusal must not drive a reconnect loop');
  } else {
    bad(
      'seat guard (socket)',
      `the socket was closed ${refusedSocket.closeCode} for a refusal that is permanent. A client ` +
        'that reconnects against it will do so forever; the refusal belongs in a frame.',
    );
  }

  // ---- The positive direction, which needs a write the API cannot make ----
  if (options.migrationUrl.trim() === '') {
    bad(
      'seat guard (enrolled)',
      'this deployment enforces and this run has no DATABASE_MIGRATION_URL, so no enrolment can be ' +
        'written and the ENROLLED direction cannot be exercised. prl_app holds SELECT and nothing ' +
        'else on prl.enrolments, on purpose, so there is no request that would do it instead. Pass ' +
        '--migration-url or set DATABASE_MIGRATION_URL.',
    );
    return { enforced, enrolled: [] };
  }

  const cohort = runEnrolmentCli([
    'cohort-create',
    '--key',
    SMOKE_COHORT.key,
    '--name',
    SMOKE_COHORT.name,
    '--starts',
    '2020-01-01',
  ]);
  // A cohort that already exists is the normal case from the second run onwards, and the CLI says
  // so by name. Anything else is a real failure.
  if (cohort.ok) note(`created the ${SMOKE_COHORT.key} cohort`);
  else if (/already taken/i.test(cohort.output)) note(`reusing the existing ${SMOKE_COHORT.key} cohort`);
  else {
    bad('enrolment CLI', `cohort-create exited ${cohort.status}: ${lastLine(cohort.output)}`);
    return { enforced, enrolled: [] };
  }

  const grant = runEnrolmentCli([
    'grant',
    '--cohort',
    SMOKE_COHORT.key,
    '--by',
    SMOKE_COHORT.by,
    '--reference',
    SMOKE_COHORT.reference,
    '--user',
    carolUserId,
    '--user',
    aliceUserId,
  ]);
  if (grant.ok) {
    ok('two learners enrolled through the operator CLI', 'as the migrating identity, never the API');
  } else {
    bad('enrolment CLI', `grant exited ${grant.status}: ${lastLine(grant.output)}`);
    return { enforced, enrolled: [] };
  }

  const seatedSocket = await sitOverSocket(carol, roomId, 0);
  if (seatedSocket.acked) {
    ok('an enrolled learner takes a seat over the socket', 'the same frame that was refused a moment ago');
  } else {
    bad(
      'seat guard (enrolled, socket)',
      seatedSocket.error ?? `expected an ack, got ${String(seatedSocket.errorCode)}`,
    );
  }

  // Alice reaches the same table the way a second learner does, and sits over REST.
  const joinedForRest = await joinProbeTable(alice, inviteCode);
  const seatedRest = joinedForRest
    ? await alice.request('POST', `/api/v1/rooms/${roomId}/sit`, { seat: 1 })
    : { status: 0, json: { error: { code: 'never joined the probe table' } } };
  if (seatedRest.status === 200) {
    ok('an enrolled learner takes a seat over REST', 'both transports, both directions, over TLS');
  } else {
    bad(
      'seat guard (enrolled, REST)',
      `expected 200, got ${seatedRest.status} ${seatedRest.json?.error?.code ?? ''}`,
    );
  }
  // Alice leaves this table, so section 7 finds her at exactly one room: her own.
  await alice.request('POST', `/api/v1/rooms/${roomId}/leave`);

  return { enforced, enrolled: [carolUserId, aliceUserId] };
}

/**
 * Withdraws the entitlements this run granted, at the end of the run.
 *
 * A revocation and not a delete, because that is the only withdrawal this schema has: the row stays
 * with `revoked_at`, `revoked_by` and `revoked_reason` set, which is what makes "was their access
 * withdrawn, when and why?" answerable, and `prl_app` holds no DELETE on the table in any case. The
 * accounts are throwaway guests; the retention sweep erases them after 60 days and the enrolment
 * rows cascade away with them.
 *
 * Reported rather than silent, and a failure here is a real failure: an entitlement this harness
 * granted and could not withdraw is a row somebody has to clean up by hand.
 */
function revokeEnrolments(userIds) {
  if (userIds.length === 0) return;
  section('Enrolment cleanup');
  const revoke = runEnrolmentCli([
    'revoke',
    '--cohort',
    SMOKE_COHORT.key,
    '--by',
    SMOKE_COHORT.by,
    '--reason',
    'smoke test run finished',
    ...userIds.flatMap((userId) => ['--user', userId]),
  ]);
  if (revoke.ok) ok(`withdrew ${userIds.length} entitlement(s) this run granted`, lastLine(revoke.output));
  else bad('enrolment cleanup', `revoke exited ${revoke.status}: ${lastLine(revoke.output)}`);
}

/** 3. CSRF is actually enforced. */
async function sectionCsrf() {
  section('3. CSRF');
  const noToken = createClient('csrf-probe');
  const seed = await noToken.request('GET', '/api/v1/auth/session');
  // Deliberately do NOT set the csrf token.
  void seed;
  const attempt = await postGuest(noToken, 'Mallory');
  if (attempt.status === 403 && attempt.json?.error?.code === 'csrf_failed') {
    ok('a mutating request without a CSRF token is rejected', 'csrf_failed');
  } else if (attempt.status === 403) {
    ok('a mutating request without a CSRF token is rejected', `403 ${attempt.json?.error?.code}`);
  } else {
    bad('CSRF', `expected 403 csrf_failed, got ${attempt.status} ${attempt.text.slice(0, 140)}`);
  }
}

/** 4. Content, computed live. */
async function sectionContent(alice) {
  section('4. Content');
  const lessons = await alice.request('GET', '/api/v1/content/lessons');
  const count = lessons.json?.lessons?.length ?? 0;
  if (lessons.status === 200 && count >= 12) ok('lessons served', `${count} lessons`);
  else bad('lessons', `expected >= 12, got ${count} (status ${lessons.status})`);

  const scenarios = await alice.request('GET', '/api/v1/content/scenarios');
  const scenarioCount = scenarios.json?.scenarios?.length ?? 0;
  if (scenarios.status === 200 && scenarioCount >= 30) ok('scenarios served', `${scenarioCount} scenarios`);
  else bad('scenarios', `expected >= 30, got ${scenarioCount} (status ${scenarios.status})`);

  const first = scenarios.json?.scenarios?.[0]?.id;
  if (typeof first === 'string') {
    const detail = await alice.request('GET', `/api/v1/content/scenarios/${first}`);
    const analysis = detail.json?.analysis;
    if (detail.status === 200 && analysis !== undefined && analysis !== null) {
      ok('a scenario carries live analysis', `equity ${(analysis.equity?.heroEquity * 100).toFixed(1)}%`);
      // The guardrail that matters: assumptions and uncertainty are never absent.
      if (!Array.isArray(analysis.assumptions) || analysis.assumptions.length === 0) {
        bad('scenario analysis', 'assumptions are missing or empty — a figure without them is a guess');
      } else {
        ok('the analysis states its assumptions', `${analysis.assumptions.length} of them`);
      }
      if (analysis.uncertainty?.method === undefined) {
        bad('scenario analysis', 'uncertainty does not state its method');
      } else {
        ok('the analysis states its method', analysis.uncertainty.method);
      }
      const text = collectStrings(analysis).join(' ');
      if (/\b(?:the )?(?:correct|optimal) play\b/i.test(text)) {
        bad('scenario analysis', 'claims a uniquely correct play');
      } else {
        ok('the analysis never claims a correct or optimal play');
      }
    } else {
      bad('scenario detail', `no analysis returned (status ${detail.status})`);
    }
  }

  const glossary = await alice.request('GET', '/api/v1/content/glossary');
  const terms = glossary.json?.entries?.length ?? 0;
  if (terms >= 45) ok('glossary served', `${terms} terms`);
  else bad('glossary', `expected >= 45, got ${terms}`);
}

/** 5. The calculation endpoints, including their refusals. */
async function sectionCalculation(alice) {
  section('5. Calculation');
  const equity = await alice.request('POST', '/api/v1/math/equity', {
    heroCards: 'AhAd',
    opponents: ['KsKc'],
  });
  const heroEquity = equity.json?.equity?.heroEquity;
  if (equity.status === 200 && typeof heroEquity === 'number') {
    // AA vs KK is ~81%. A figure outside 75-88% means something is badly wrong.
    const percent = heroEquity * 100;
    if (percent > 75 && percent < 88) {
      ok('AA vs KK equity is plausible', `${percent.toFixed(2)}% by ${equity.json.equity.method}`);
    } else {
      bad('equity', `AA vs KK returned ${percent.toFixed(2)}%, which is not credible`);
    }
    // `sampledEquityMissesInterval` uses `!= null` rather than the `=== null` that used to be
    // written out here: an absent key is the more broken state, and it was the one this check
    // could not see.
    if (sampledEquityMissesInterval(equity.json.equity)) {
      bad('equity', 'a sampled result reported no confidence interval');
    } else if (equity.json.equity.method === 'monte-carlo') {
      ok(
        'the sampled result carries a confidence interval',
        `±${equity.json.equity.confidenceHalfWidthPoints} pts`,
      );
    }
  } else {
    bad('equity endpoint', `got ${equity.status} ${equity.text.slice(0, 160)}`);
  }

  const coach = await alice.request('POST', '/api/v1/math/coach', {
    heroCards: 'AhKh',
    board: 'Qh 7h 2c',
    opponents: ['QsQd'],
    pot: 100,
    toCall: 50,
    heroStack: 400,
    opponentStacks: [400],
    bigBlind: 10,
    street: 'flop',
  });
  const report = coach.json?.report;
  if (coach.status === 200 && report !== undefined) {
    ok('coach report returned', `suggests ${report.suggestion?.action} (${report.suggestion?.confidence})`);
    if (listIsMissingOrEmpty(report.assumptions)) {
      bad('coach report', 'assumptions empty or absent');
    } else ok('coach states assumptions', `${report.assumptions.length}`);
    // Was `report.uncertainty?.limitations?.length === 0` with no `else`, which is false for
    // `undefined` — so a report that had lost its `uncertainty` object entirely produced neither
    // a pass nor a failure and the assertion vanished from the run. See `listIsMissingOrEmpty`.
    if (listIsMissingOrEmpty(report.uncertainty?.limitations)) {
      bad('coach report', 'no limitations stated (the uncertainty block is empty or missing)');
    } else ok('coach states its limitations', `${report.uncertainty.limitations.length}`);
    if (listIsMissingOrEmpty(report.suggestion?.whatWouldChangeIt)) {
      bad('coach report', 'the suggestion does not say what would change it');
    } else ok('the suggestion says what would change it');
  } else {
    bad('coach endpoint', `got ${coach.status} ${coach.text.slice(0, 200)}`);
  }

  // Hostile input must be rejected, not absorbed.
  const hostile = [
    [{ heroCards: 'ZZZZ', opponents: ['KsKc'] }, 'nonsense cards'],
    [{ heroCards: 'AhAd', opponents: ['T9s+'] }, 'ambiguous range notation'],
    [{ heroCards: 'AhAd', opponents: ['KsKc'], samples: 10 ** 12 }, 'absurd sample count'],
    [{ heroCards: 'AhAh', opponents: ['KsKc'] }, 'duplicate card'],
    [{ heroCards: 'AhAd', opponents: [] }, 'no opponents'],
    [{ heroCards: 'AhAd', opponents: ['KsKc'], unexpectedField: 1 }, 'unknown field (closed schema)'],
  ];
  let rejected = 0;
  let untested = 0;
  for (const [body, label] of hostile) {
    const response = await alice.request('POST', '/api/v1/math/equity', body);
    // Not `status >= 400 && status < 500`. See `classifyHostileRefusal`: that test counted the
    // limiter's 429 as a validation refusal, so a run whose expensive-rate-limit budget was
    // already spent printed "all 6 hostile calculation inputs rejected" without a validator
    // having seen a single one of them.
    const verdict = classifyHostileRefusal(response);
    if (verdict.kind === 'rejected') rejected += 1;
    else if (verdict.kind === 'untested') untested += 1;
    else bad('hostile input accepted', `${label} ${verdict.why}`);
  }
  if (untested > 0) {
    // A failure, not a warning. This is the section's strongest claim, and a gate that reports
    // a claim it could not test is a gate that lies. The fix on the operator's side is to let
    // the expensive-input window drain, or to run with a reset token configured.
    bad(
      'hostile input untested',
      `${untested} of ${hostile.length} probes were answered by the rate limiter (429), so no ` +
        'validator was reached and this run proves nothing about input validation',
    );
  } else if (rejected === hostile.length) {
    ok(`all ${hostile.length} hostile calculation inputs rejected`, 'by a validator, with a contract code');
  }
}

/** 6. AI Legends labelling. */
async function sectionLegends(alice) {
  section('6. AI Legends');
  const profiles = await alice.request('GET', '/api/v1/legends/profiles');
  const list = profiles.json?.profiles ?? [];
  if (profiles.status === 200 && list.length >= 11) {
    ok('legend profiles served', `${list.length} profiles, naming mode "${profiles.json.namingMode}"`);
  } else {
    bad('legend profiles', `expected >= 11, got ${list.length} (status ${profiles.status})`);
  }
  if (profiles.json?.namingMode !== undefined && profiles.json.namingMode !== 'archetype') {
    warn('naming mode', `is "${profiles.json.namingMode}"; archetype is the safe production default`);
  } else if (profiles.json?.namingMode === 'archetype') {
    ok('the safe archetype naming mode is the default');
  }
  let missingDisclaimer = 0;
  for (const profile of list) {
    if (!Array.isArray(profile.disclosure?.disclaimers) || profile.disclosure.disclaimers.length === 0) {
      missingDisclaimer += 1;
    }
  }
  if (missingDisclaimer === 0 && list.length > 0) ok('every profile carries at least one disclaimer');
  else if (missingDisclaimer > 0) bad('legend disclaimers', `${missingDisclaimer} profile(s) carry none`);

  // No profile may claim to BE a person or be endorsed.
  const text = collectStrings(profiles.json).join(' ');
  if (/\bdigital twin\b|\bendorsed by\b(?!\s+anyone)|\bofficial (?:profile|partner)\b/i.test(text)) {
    bad('legend framing', 'a profile implies endorsement or a digital twin');
  } else {
    ok('no profile implies endorsement or a digital twin');
  }
}

/**
 * 7. Rooms, a real hand over a real socket, and the confidentiality property on the wire.
 *
 * Returns the second client AND `truth` — what the terminal `state` frame said about the hand that
 * was played. Section 8 needs it: the archive cannot be checked against its own account of which
 * seats showed down, and `HandReviewSeat` has no `isSelf` for the caller's own seat to be found by.
 * Null when no hand completed, which section 8 treats as a failure rather than as nothing to do.
 */
async function sectionRooms(alice) {
  section('7. Rooms and hidden information');
  let truth = null;
  const bob = createClient('bob');
  const seed = await bob.request('GET', '/api/v1/auth/session');
  if (typeof seed.json?.csrfToken === 'string') bob.setCsrf(seed.json.csrfToken);
  const guest = await createGuestSession(bob, 'Bob');
  if (typeof guest.json?.csrfToken === 'string') bob.setCsrf(guest.json.csrfToken);
  ok('a second guest session created', 'Bob');

  // A bot takes seat 1 so that Alice can actually PLAY a hand below. Without an opponent there is
  // nothing to deal, the hand history stays empty, and section 8's confidentiality checks scan an
  // empty list and pass unconditionally — which is exactly what they used to do.
  const created = await alice.request('POST', '/api/v1/rooms', {
    name: 'Smoke Table',
    // Three seats: Alice plays, a bot fills seat 1 so there is a hand to deal, and Bob still has
    // room to join as a member. At maxSeats 2 the bot fills the table and Bob's join — which is
    // what the isolation check below depends on — is refused room_full.
    maxSeats: 3,
    smallBlind: 5,
    bigBlind: 10,
    startingStack: 1000,
    bots: [{ profile: 'tight-aggressive', count: 1 }],
  });
  const roomId = created.json?.room?.id;
  const inviteCode = created.json?.inviteCode;
  if (created.status === 200 || created.status === 201) {
    ok('room created', `${roomId}, invite code returned once`);
    if (typeof inviteCode !== 'string' || inviteCode.length < 8) {
      bad('invite code', `expected a code of >= 8 chars, got ${String(inviteCode)}`);
    }
    if (created.json?.room?.visibility !== 'invite_only') {
      bad('room visibility', `expected invite_only, got ${String(created.json?.room?.visibility)}`);
    } else ok('the room is invite-only');
  } else {
    bad('room creation', `got ${created.status} ${created.text.slice(0, 200)}`);
  }

  // Bob must NOT be able to read a room he was not invited to, and the error must not
  // confirm the room exists.
  if (typeof roomId === 'string') {
    const peek = await bob.request('GET', `/api/v1/rooms/${roomId}`);
    if (peek.status === 404) {
      ok('an uninvited user gets 404, not 403', 'the error does not confirm the room exists');
    } else if (peek.status === 403) {
      bad('room enumeration', '403 confirms the room exists; the threat model requires 404');
    } else if (peek.status === 200) {
      bad('authorization', 'an uninvited user could read the room');
    } else {
      warn('room read by non-member', `status ${peek.status}`);
    }

    // A wrong invite code must fail.
    const wrong = await bob.request('POST', '/api/v1/rooms/join', { inviteCode: 'AAAAAAAA' });
    if (wrong.status >= 400)
      ok('a wrong invite code is rejected', `${wrong.json?.error?.code ?? wrong.status}`);
    else bad('invite code', 'a wrong code was accepted');
  }

  // Join properly, then check what each player can see.
  if (typeof inviteCode === 'string') {
    const joined = await bob.request('POST', '/api/v1/rooms/join', { inviteCode });
    if (joined.status === 200 || joined.status === 201) ok('Bob joined with the invite code');
    else bad('room join', `got ${joined.status} ${joined.text.slice(0, 200)}`);
  }

  // ---- The live table, over a real socket ----
  if (typeof roomId === 'string') {
    const played = await playOneHandOverSocket(alice, roomId, 0);
    if (played.welcomed) ok('the WebSocket upgrade succeeded', 'session cookie carried on the handshake');
    else bad('websocket upgrade', played.error ?? `closed with ${String(played.closeCode)}`);
    if (played.sat) ok('Alice took a seat over the socket');
    else if (played.welcomed) bad('sit', played.error ?? 'no ack for the sit request');

    if (played.completed) {
      ok('a hand was played to completion against a bot', `${played.frames.length} frames`);
    } else {
      bad('live hand', played.error ?? 'the hand did not reach a completed state');
    }

    // The confidentiality property, on the live wire rather than on a stored row. Every frame this
    // socket received is scanned; the bot's hole cards may appear only in a completed hand that
    // actually reached showdown, and the deck may never appear at all.
    const frameKeys = collectKeys(played.frames);
    const leakedKeys = ['deck', 'deckCursor', 'deckSalts', 'salts'].filter((key) => frameKeys.has(key));
    if (leakedKeys.length > 0) {
      bad('hidden information', `a socket frame carried ${leakedKeys.join(', ')}`);
    } else if (played.frames.length > 0) {
      ok('no socket frame carried a deck, cursor or salt', `${played.frames.length} frames scanned`);
    } else {
      bad('hidden information', 'no frames were received, so the socket scan proved nothing');
    }

    // Every frame, including the completed ones. The old scan skipped `street === 'complete'`
    // outright, which exempts a hand that ended by FOLD — the ordinary outcome for this client —
    // from the only confidentiality check on the wire. See `unentitledHoleCardSeats`.
    const leakedSeats = [...new Set(played.frames.flatMap(unentitledHoleCardSeats))];
    const completedFrames = played.frames.filter(
      (frame) => frame.type === 'state' && frame?.view?.street === 'complete',
    );
    if (leakedSeats.length > 0) {
      bad(
        'hidden information',
        `a live frame carried the hole cards of seat(s) ${leakedSeats.join(', ')}, which are neither ` +
          "the recipient's own nor named in result.showdowns",
      );
    } else if (completedFrames.length > 0) {
      ok(
        'no live frame carried hole cards the recipient was not entitled to',
        `${played.frames.length} frame(s), including ${completedFrames.length} completed-hand frame(s) ` +
          'checked against result.showdowns rather than exempted',
      );
    } else {
      // A sweep of nothing is not a pass: with no completed frame the showdown exemption was
      // never exercised, and the mid-hand half alone is the weaker of the two claims.
      bad(
        'hidden information',
        'no completed-hand frame reached this scan, so the showdown half of the confidentiality ' +
          'check ran over nothing',
      );
    }

    // What the wire said about this hand, so section 8 can hold the ARCHIVE to it rather than to
    // the archive's own account of itself. See `liveHandTruth` and `auditReviewSeats`.
    truth = liveHandTruth(played.frames);
  }

  return { bob, truth };
}

/** 8. Hand history isolation. */
async function sectionHandHistory(alice, bob, truth) {
  section('8. Hand history isolation');
  const aliceHands = await alice.request('GET', '/api/v1/hands');
  const aliceRows = aliceHands.json?.hands ?? [];
  if (aliceHands.status === 200) {
    ok('hand history reads', `${aliceRows.length} hand(s)`);
    // THE PRECONDITION. Every check below scans Alice's rows, and a scan of an empty list finds
    // nothing wrong with anything: `collectKeys({hands: []})` cannot contain "deck", and comparing
    // an empty set of ids to Bob's finds no overlap. All three used to pass unconditionally because
    // this script had never played a hand. An empty list is now a failure, not a free pass.
    if (aliceRows.length < 1) {
      bad(
        'hand history',
        'Alice has no hands, so every isolation check below would scan an empty list and pass ' +
          'for free. The live hand in section 7 did not reach the archive.',
      );
    } else {
      ok('the isolation checks below have rows to be wrong about', `${aliceRows.length} archived`);
    }
    // The regression that returned 500 for every caller.
    const keys = collectKeys(aliceHands.json);
    const leaked = ['deck', 'deckCursor', 'deckSalts', 'salts'].filter((key) => keys.has(key));
    if (leaked.length > 0) bad('hidden information', `the hand list exposes ${leaked.join(', ')}`);
    else if (aliceRows.length >= 1) ok('the hand list exposes no deck, cursor or salt key');

    // The list must carry no hole card under ANY key, which is a real property of this route:
    // `routes/hands.ts` never projects `hand_seats.hole_cards` into a summary. Stated as "the key
    // is absent" rather than as a scan of `hand.seats`, because `hand.seats` does not exist — the
    // check that used to stand here walked it anyway and examined zero seats. See
    // `auditReviewSeats` for the measurement.
    if (aliceRows.length >= 1) {
      if (keys.has('holeCards') || keys.has('seats')) {
        bad('hidden information', 'a hand summary now carries seats or hole cards; it never did');
      } else {
        ok('a hand summary carries no seats and no hole cards', `${keys.size} distinct keys walked`);
      }
    }
  } else {
    bad(
      'hand history',
      `got ${aliceHands.status} ${aliceHands.text.slice(0, 200)} — this route returned 500 for every caller before the session plugin was moved to the root scope`,
    );
  }

  const bobHands = await bob.request('GET', '/api/v1/hands');
  if (bobHands.status !== 200) {
    // The `else` that was missing. A 500 from Bob's history used to produce no check at all —
    // neither a pass nor a failure — so the isolation assertion simply vanished on the one status
    // code that most needed reporting.
    bad('hand isolation', `Bob's history returned ${bobHands.status} ${bobHands.text.slice(0, 200)}`);
  }
  if (bobHands.status === 200) {
    // `.filter(typeof === 'string')` and not a bare `.map`, because the guard below is the whole
    // reason this comparison is trustworthy and a bare map defeats it. A list of rows that carry
    // no `id` at all — a renamed field, a summary shape that dropped it — maps to `[undefined]`,
    // and `new Set([undefined]).size` is 1, so `aliceIds.size === 0` was false and the run printed
    // "1 of Alice's ids checked" having compared nothing to nothing. Measured against a stub whose
    // /hands rows carried `handId` instead of `id`: that exact line, green.
    const aliceIds = new Set(aliceRows.map((hand) => hand.id).filter((id) => typeof id === 'string'));
    const overlap = (bobHands.json?.hands ?? []).filter((hand) => aliceIds.has(hand.id));
    if (aliceIds.size === 0) {
      bad(
        'hand isolation',
        `Alice has ${aliceRows.length} archived hand(s) and not one usable id among them, so the ` +
          'overlap comparison would be two empty sets. The rows are there and the identifier this ' +
          'check keys on is not.',
      );
    } else if (overlap.length === 0) {
      ok("Bob's hand history does not contain Alice's hands", `${aliceIds.size} of Alice's ids checked`);
    } else {
      bad('hand isolation', `${overlap.length} of Alice's hands appear in Bob's history`);
    }
  }

  // ---- The archive's ONE card-bearing route, fetched for a real hand ----
  //
  // `GET /hands/:handId` is the only route in this API that ever serves a hole card over HTTP, and
  // until this block existed no smoke run had ever asked it for a hand that exists — only
  // `hand_doesnotexist`, below. The check that claimed to cover it walked `hand.seats` on a
  // `HandSummary`, which has no such field. See `auditReviewSeats` for what that measured.
  await sectionHandReview(alice, aliceRows, truth);

  // Requesting a hand that does not exist must 404, not 403 or 500.
  const missing = await alice.request('GET', '/api/v1/hands/hand_doesnotexist');
  if (missing.status === 404) ok('an unknown hand returns 404');
  else warn('unknown hand', `status ${missing.status}`);
}

/**
 * The hole-card rule on the served review, held to what the live wire said about the same hand.
 *
 * Split out of `sectionHandHistory` only for length: it is section 8, and it is the half of it
 * that touches cards at all.
 *
 * Every branch that cannot check the property FAILS rather than falling through. A hand id that
 * did not survive section 7, a review that would not load, a review with no seats, a review
 * carrying no hole cards whatsoever — each of those makes the scan below prove nothing, and each
 * used to be the state this script was silently in.
 */
async function sectionHandReview(alice, aliceRows, truth) {
  if (truth === null) {
    bad(
      'hidden information',
      'section 7 produced no terminal state frame, so there is no wire account of the hand to hold ' +
        'the archive to and the review scan would have nothing to compare against',
    );
    return;
  }
  if (truth.viewerSeat === null) {
    bad(
      'hidden information',
      "the terminal frame named no viewerSeat, so the caller's own seat is unknown and every seat " +
        'in the review would read as foreign — a scan that is stricter by accident and wrong',
    );
    return;
  }
  // The hand section 7 played, by id, and not merely "the first row": the list is ordered by start
  // time and this run has created exactly one, but keying on the id is what makes the seat indices
  // below belong to the same hand as `truth`.
  const row = aliceRows.find((hand) => hand.id === truth.handId);
  if (row === undefined) {
    bad(
      'hidden information',
      `the hand played over the socket (${String(truth.handId)}) is not in Alice's history, so the ` +
        'review below would be about a different hand than the wire account it is checked against',
    );
    return;
  }

  // `GET /hands/:handId` takes `app.expensiveRateLimit`, the same bucket sections 5 and the
  // `hand_doesnotexist` probe below draw on. Named as its own failure rather than folded into
  // 'hidden information', because a run that reported a confidentiality failure when what actually
  // happened was a spent budget is the mis-attribution `classifyHostileRefusal` above exists for.
  // Counted at the time of writing: Alice spends eight expensive tokens before this call, against
  // a default `RATE_LIMIT_EXPENSIVE_MAX` of 20.
  const review = await alice.request('GET', `/api/v1/hands/${row.id}`);
  if (review.status === 429) {
    bad(
      'hand review',
      "the expensive rate limit refused the review of Alice's own hand, so the confidentiality " +
        'scan below did not run. This is a budget problem, not a leak — see RATE_LIMIT_EXPENSIVE_MAX.',
    );
    return;
  }
  if (review.status !== 200) {
    bad('hidden information', `the review of Alice's own hand returned ${review.status}`);
    return;
  }
  ok('a learner can review their own hand', `${row.id}, seat ${truth.viewerSeat}`);

  const audit = auditReviewSeats(review.json, truth);
  if (audit.examined === 0) {
    bad(
      'hidden information',
      'the served review carried no seat rows, so the hole-card scan ran over nothing. This is the ' +
        'exact state the old check was permanently in, against a response shape that has no seats.',
    );
  } else if (audit.leaked.length > 0) {
    bad(
      'hidden information',
      `the review served seat(s) ${audit.leaked.join(', ')}'s hole cards, which are neither the ` +
        "caller's own seat nor a seat that showed down",
    );
  } else if (audit.overclaimed.length > 0) {
    bad(
      'hidden information',
      `the review marks seat(s) ${audit.overclaimed.join(', ')} as having shown down, which the ` +
        'live hand never did — the archive is opening cards the game did not',
    );
  } else if (!audit.ownCards) {
    bad(
      'hidden information',
      "the review carried no hole cards at all, not even the caller's own, so a scan for foreign " +
        'cards would have passed whatever the server sent',
    );
  } else {
    ok(
      "the served review carries the caller's own cards and no unshown opponent's",
      `${audit.examined} seat(s) checked against a wire account naming ` +
        `${truth.shownSeats.length} showdown(s)`,
    );
  }
}

/** 9. Progress carries no score. */
async function sectionProgress(alice) {
  section('9. Progress');
  const progress = await alice.request('GET', '/api/v1/me/progress');
  if (progress.status === 200) {
    ok('progress reads', `${progress.json?.handsPlayed ?? 0} hands played`);
    const keys = [...collectKeys(progress.json)];
    const gamified = keys.filter((k) => /^(?:score|streak|level|rank|xp|points|badge)$/i.test(k));
    if (gamified.length > 0) bad('gamification', `progress exposes ${gamified.join(', ')}`);
    else ok('progress carries no score, streak, level or rank');
  } else {
    bad('progress', `got ${progress.status} ${progress.text.slice(0, 200)}`);
  }
}

/**
 * 10. The HTML origin carries an effective CSP.
 *
 * Not an API check, and here anyway, because this is the only script in the repo that speaks HTTP
 * to a RUNNING deployment. The defect it exists for was exactly the kind a unit test cannot see:
 * `THEME_BOOT_SCRIPT_CSP_HASH` was computed, kept accurate by a test, and never placed on a
 * response — `next.config.ts` had no `headers()` and there was no proxy file, so the page origin
 * served no policy at all. Only a real response can prove otherwise.
 *
 * `apps/web/test/csp-policy.test.ts` asserts the policy's SHAPE. This asserts it ARRIVED, and that
 * Next actually stamped the nonce on the scripts the policy admits — a policy whose nonce reaches
 * no script tag is a page that renders and never hydrates.
 */
async function sectionWebHeaders() {
  section('10. Web origin security headers');
  let page = null;
  try {
    page = await fetch(`${options.webOrigin}/learn`, { headers: { accept: 'text/html' } });
  } catch (error) {
    warn(
      'web origin',
      `${options.webOrigin} is not reachable (${error instanceof Error ? error.message : 'error'})`,
    );
  }
  if (page === null) return;

  const policy = page.headers.get('content-security-policy');
  if (policy === null) {
    bad('content-security-policy', `${options.webOrigin}/learn returned an HTML page with no policy at all`);
  } else {
    ok('content-security-policy is served on HTML', `${policy.length} chars`);

    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1] ?? null;
    if (nonce === null) bad('csp nonce', `script-src carries no nonce: ${policy}`);
    else ok('csp carries a per-response nonce');

    if (/script-src[^;]*'unsafe-inline'/.test(policy)) {
      bad('csp script-src', "allows 'unsafe-inline' — an injected inline script would run");
    } else {
      ok("script-src does not allow 'unsafe-inline'");
    }
    if (/script-src[^;]*'unsafe-eval'/.test(policy)) {
      bad('csp script-src', "allows 'unsafe-eval' — a development allowance reached production");
    } else {
      ok("script-src does not allow 'unsafe-eval'");
    }
    if (/script-src[^;]*'sha256-[A-Za-z0-9+/=]+'/.test(policy)) {
      ok('the theme boot script is allowed by hash as well as nonce');
    } else {
      warn('csp script-src', 'carries no sha256 source — the theme boot hash is not being served');
    }

    const html = await page.text();
    const tags = html.match(/<script\b[^>]*>/g) ?? [];
    const unnonced = tags.filter((tag) => !tag.includes('nonce='));
    if (tags.length === 0) {
      bad('rendered scripts', 'the page carries no script tags at all, which cannot be right');
    } else if (unnonced.length > 0) {
      bad(
        'rendered scripts',
        `${unnonced.length} of ${tags.length} script tag(s) carry no nonce, so they are blocked: ` +
          unnonced.slice(0, 2).join(' '),
      );
    } else {
      ok('every rendered script tag carries the nonce', `${tags.length} tag(s)`);
    }

    if (nonce !== null && !html.includes(nonce)) {
      bad('csp nonce', 'the policy nonce does not appear in the HTML, so nothing it allows is present');
    }
  }

  for (const [header, expected] of [
    ['x-content-type-options', 'nosniff'],
    ['x-frame-options', 'DENY'],
    ['referrer-policy', 'same-origin'],
  ]) {
    const value = page.headers.get(header);
    if (value === expected) ok(`${header}: ${expected}`);
    else bad(header, `expected ${expected}, got ${value === null ? '(absent)' : value}`);
  }
}

/**
 * 11. A first-time visitor to Learn gets a guest session (PROD-048).
 *
 * The product's copy is guest-first and nothing created the guest: `POST /auth/guest` had one
 * caller in the whole client, reached only by opening a table. A reader who came to Learn stayed
 * anonymous, so every lesson read answered `completedAt: null` and `/me/progress` answered 401 —
 * each honest on its own, and together a learner whose work was recorded nowhere.
 *
 * This walks it the way a browser does, with one cookie jar, because the fix lives in the web
 * origin's proxy and nothing in the API changed. Note that the guest it mints is created by the
 * WEB SERVER's call to the API, from the web server's address — a bucket this harness never sees
 * and cannot reset. The isolation section prints that.
 */
async function sectionGuestBootstrap() {
  section('11. Guest bootstrap on Learn');
  const jar = new Map();
  const remember = (response) => {
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';')[0] ?? '';
      const name = pair.split('=')[0];
      if (name !== undefined && name !== '') jar.set(name, pair);
    }
  };
  const cookieHeader = () => [...jar.values()].join('; ');
  const page = async (path) => {
    const response = await fetch(`${options.webOrigin}${path}`, {
      headers: {
        accept: 'text/html',
        'sec-fetch-dest': 'document',
        ...(jar.size === 0 ? {} : { cookie: cookieHeader() }),
      },
      redirect: 'manual',
    });
    const minted = response.headers.getSetCookie().length;
    remember(response);
    return { response, minted };
  };

  let first = null;
  try {
    first = await page('/learn');
  } catch (error) {
    warn(
      'web origin',
      `${options.webOrigin} is not reachable (${error instanceof Error ? error.message : 'error'})`,
    );
  }
  if (first === null) return;

  const sessionCookie = [...jar.keys()].find((name) => name.endsWith('prl_session'));
  if (sessionCookie === undefined) {
    bad('guest bootstrap', 'a fresh visitor to /learn was issued no session cookie');
    return;
  }
  ok('a fresh visitor to /learn is issued a session', sessionCookie);

  // Who the guest is, asked of the API directly with the cookie the web origin just set.
  const who = await fetch(`${options.apiOrigin}/api/v1/auth/session`, {
    headers: { accept: 'application/json', origin: options.webOrigin, cookie: cookieHeader() },
  });
  const body = await who.json().catch(() => null);
  if (body?.user?.kind === 'guest') ok('the session is a real guest account', body.user.id);
  else
    bad('guest bootstrap', `the cookie does not resolve to a guest: ${JSON.stringify(body?.user ?? null)}`);

  // Idempotence. Navigating on, refreshing, and several requests at once must all reuse it.
  const second = await page('/lab');
  const third = await page('/learn');
  const concurrent = await Promise.all([page('/learn'), page('/lab'), page('/record')]);
  const extra = second.minted + third.minted + concurrent.reduce((sum, r) => sum + r.minted, 0);
  if (extra === 0) ok('navigation, refresh and concurrent requests mint nothing further');
  else bad('guest bootstrap', `${extra} further Set-Cookie header(s) after the session existed`);

  const stillTheSame = [...jar.keys()].filter((name) => name.endsWith('prl_session'));
  if (stillTheSame.length === 1) ok('the visitor keeps one identity across navigation');
  else bad('guest bootstrap', `the jar now holds ${stillTheSame.length} session cookies`);

  // A path outside the bootstrap set must not create an account for a passing crawler.
  const anonymous = await fetch(`${options.webOrigin}/legends`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
  });
  if (anonymous.headers.getSetCookie().length === 0) ok('/legends mints nothing for an anonymous visitor');
  else warn('guest bootstrap', '/legends issued a cookie; the bootstrap set is wider than intended');

  // A prefetch must not create an account for a page nobody opened.
  const prefetch = await fetch(`${options.webOrigin}/learn`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'empty', rsc: '1', 'next-router-prefetch': '1' },
  });
  if (prefetch.headers.getSetCookie().length === 0) ok('a prefetch of /learn mints nothing');
  else bad('guest bootstrap', 'a prefetch created an account for a page that was never opened');

  // And the point of the whole thing: the reader's own work is now recorded.
  const seed = await fetch(`${options.apiOrigin}/api/v1/auth/session`, {
    headers: { accept: 'application/json', origin: options.webOrigin, cookie: cookieHeader() },
  });
  remember(seed);
  const token = (await seed.json().catch(() => ({}))).csrfToken;
  const read = await fetch(`${options.apiOrigin}/api/v1/content/lessons/pot-odds/read`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      origin: options.webOrigin,
      cookie: cookieHeader(),
      'x-csrf-token': typeof token === 'string' ? token : '',
    },
    body: JSON.stringify({ completed: true }),
  });
  const recorded = await read.json().catch(() => null);
  if (typeof recorded?.completedAt === 'string') {
    ok('a lesson read by the bootstrapped guest is actually recorded', recorded.completedAt);
  } else {
    bad('guest bootstrap', `the lesson read was not recorded: ${JSON.stringify(recorded)}`);
  }
}

/**
 * 12. Rate limiting exists.
 *
 * LAST, and it has to be: this section deliberately floods `POST /auth/guest` until the limiter
 * answers 429, and the limiter buckets by client key. Any later section that needs a new account —
 * section 11 does — would then be measuring the flood rather than itself. It was moved here after
 * exactly that happened.
 *
 * It leaves the bucket spent, which is the whole reason the isolation section at the top of this
 * file exists. Nothing is reset afterwards on purpose: a reset here would clear the evidence that
 * the next run needs to recover from, and would hide the very defect this design has to survive —
 * a run that ends with a drained limiter and a next run that starts one second later.
 */
async function sectionRateLimiting() {
  section('12. Rate limiting');
  const client = createClient('flood');
  const seed = await client.request('GET', '/api/v1/auth/session');
  if (typeof seed.json?.csrfToken === 'string') client.setCsrf(seed.json.csrfToken);
  let limited = null;
  for (let attempt = 0; attempt < 60 && limited === null; attempt += 1) {
    const response = await postGuest(client, `Flood${attempt}`);
    if (response.status === 429) limited = response;
  }
  if (limited !== null) {
    const seconds = recoveryWaitSeconds({
      retryAfter: limited.headers.get('retry-after'),
      rateLimitReset: limited.headers.get('x-ratelimit-reset'),
      bodySeconds: limited.json?.error?.retryAfterSeconds,
    });
    ok(
      'guest creation is rate limited',
      `429 after ${guestAttempts} guest creation(s) this run, limit ` +
        `${limited.headers.get('x-ratelimit-limit') ?? 'unstated'}, window ${seconds ?? '?'}s left`,
    );
    if (seconds === null) {
      bad(
        'rate limit headers',
        'the 429 carried no Retry-After, x-ratelimit-reset or retryAfterSeconds, so a client — and ' +
          'the next run of this harness — has nothing to back off against',
      );
    } else {
      ok('the 429 says how long to wait', `Retry-After ${seconds}s`);
    }
  } else {
    warn('rate limiting', 'no 429 after 60 guest creations — check the limit for this route');
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    // The REASON, on one line, and no stack: a stack trace for a mistyped flag buries the one
    // sentence that fixes it under twenty frames of Node internals.
    console.error(`${RED}smoke-test — ${error.message}${RESET}`);
    process.exit(1);
  }
  if (options.help) {
    console.log(HELP);
    return;
  }

  section(`Poker Risk Lab smoke test  ${DIM}${options.apiOrigin}${RESET}`);

  await sectionHealth();
  await sectionIsolation();
  const { client: alice, userId: aliceUserId } = await sectionGuestSession();
  // Before section 7, deliberately: on a deployment that enforces, Alice cannot take a seat or play
  // a hand until she is enrolled, and sections 7, 8 and 9 would all fail naming the wrong subsystem.
  const enrolment = await sectionEnrolment(alice, aliceUserId);
  await sectionCsrf();
  await sectionContent(alice);
  await sectionCalculation(alice);
  await sectionLegends(alice);
  const { bob, truth } = await sectionRooms(alice);
  await sectionHandHistory(alice, bob, truth);
  await sectionProgress(alice);
  await sectionWebHeaders();
  await sectionGuestBootstrap();
  await sectionRateLimiting();
  // Last, so that everything above ran with the entitlements it needed.
  revokeEnrolments(enrolment.enrolled);

  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${GREEN}${passed} check(s) passed${RESET}`);
  if (warnings.length > 0) {
    console.log(`  ${YELLOW}${warnings.length} warning(s)${RESET}`);
    console.log(`  ${DIM}re-run with --strict (as CI does) to make these fail the run${RESET}`);
  }
  if (failures.length > 0) {
    console.log(`  ${RED}${failures.length} failure(s)${RESET}`);
    for (const failure of failures) console.log(`${RED}    - ${failure}${RESET}`);
    console.log('');
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}\nSmoke test passed.${RESET}`);
  console.log(
    `${DIM}A pass says these journeys work on THIS deployment, once. It is not a load test, not a\n` +
      'correctness proof of the poker engine, and it says nothing about whether the rate limits are\n' +
      'the right size — only that a 429 arrives. This run consumed the guest budget for the address\n' +
      `${options.apiOrigin} resolves to; the next run resets it or waits it out.${RESET}\n`,
  );
}

if (import.meta.main) await main();
