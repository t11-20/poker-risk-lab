#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING API and web origin (`pnpm run test:smoke`).
 *
 * It speaks HTTP and WebSocket the way a browser does and imports nothing from the app, because the
 * worst bugs found here (a session decorator scoped to one module, a no-op hand archive) passed every
 * in-process test. The central claim is that one player never receives another player's private
 * cards or any undealt card.
 *
 * Section 12 drains the address-keyed, fixed-window guest limiter, so the next run starts with a
 * spent bucket. The run therefore resets the counters first when the server has
 * `RATE_LIMIT_RESET_TOKEN` (a production process refuses to start with it). Without that control it
 * waits out one 429 on guest creation, bounded by `--max-wait`, and retries once.
 *
 * It does not prove the production limit values, or that the reset control is absent in production
 * (`apps/api/test/rate-limit-isolation.test.ts` does).
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

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `apiOrigin` is a literal address because the rate-limit bucket is keyed on the connecting address
 * and the API keys `::1` and `127.0.0.1` separately. A hostname would let DNS order pick the bucket.
 * The web server reaches the API through `localhost` (`guest-bootstrap.ts`), so section 11 can spend
 * a second bucket this run never sees.
 */
const DEFAULTS = {
  apiOrigin: 'http://127.0.0.1:3001',
  webOrigin: 'http://localhost:3000',
  /**
   * Bound on the wait-out fallback, in seconds. The shipped guest window is 60 s, so 90 s clears one
   * full window. A deployment with an hour-long window fails in 90 s instead of hanging the gate.
   */
  maxWaitSeconds: 90,
  /**
   * The `PRL_ENROLMENT_REQUIRED` posture expected on the target. `discover` asserts whichever one it
   * finds. `scripts/staging.mjs` passes `enforced`, so a run that cannot exercise the guard fails there.
   */
  expectEnrolment: 'discover',
};

const ENROLMENT_EXPECTATIONS = ['discover', 'off', 'enforced'];

/**
 * The cohort the throwaway guests are enrolled into. It is reused forever because
 * `enrolments.cohort_id` is ON DELETE RESTRICT and no role holds DELETE. The run revokes its grants
 * instead, and the rows cascade away when the retention sweep erases the guests after 60 days.
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
 * Takes `env` as a parameter so tests can check the fallbacks without mutating `process.env`.
 * Precedence is flag, then environment, then default. The reset token reads
 * `PRL_RATE_LIMIT_RESET_TOKEN` before the server's own `RATE_LIMIT_RESET_TOKEN`, so a local `.env`
 * gives isolation for free.
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
    expectEnrolment: env['PRL_SMOKE_ENROLMENT_REQUIRED'] ?? DEFAULTS.expectEnrolment,
    // Never printed. Only the migrating identity can write an enrolment; `prl_app` holds SELECT.
    migrationUrl: env['DATABASE_MIGRATION_URL'] ?? '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // `pnpm run test:smoke -- --strict` forwards the `--` itself.
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
    // Names the environment variable too, because the value may not be on the command line.
    throw new Error(
      '--max-wait (or PRL_SMOKE_MAX_WAIT_SECONDS) must be a whole number of seconds, ' +
        `got "${options.maxWaitSeconds}"`,
    );
  }
  // Past ten minutes the gate is hanging, and the answer is to configure the reset control.
  if (options.maxWaitSeconds > 600) {
    throw new Error(
      `--max-wait ${options.maxWaitSeconds}s exceeds 600s; a gate that waits longer than that ` +
        'should be given RATE_LIMIT_RESET_TOKEN instead of a longer bound',
    );
  }
  return options;
}

/**
 * Built from two constants on purpose. `apps/api/test/harness-paths.test.ts` asserts the server routes
 * every `/api/v1/...` literal in this file, and this route is absent unless `RATE_LIMIT_RESET_TOKEN`
 * is set. `smoke-test.test.mjs` checks the path against apps/api/src/plugins/security.ts instead.
 */
const API_PREFIX = '/api/v1';
export const RATE_LIMIT_RESET_PATH = `${API_PREFIX}/_test/rate-limit/reset`;

/**
 * Padding on every computed wait. The store restarts a window when `start + window <= now`, and a
 * wait of exactly the whole-second `Retry-After` can land on that boundary.
 */
export const RECOVERY_PADDING_SECONDS = 1;

/**
 * A `Retry-After` / `x-ratelimit-reset` value as whole seconds, or null. Only delta-seconds is
 * accepted. This API never sends an HTTP-date, and converting one would trust two clocks to agree.
 * A negative delta is null, so a malformed header cannot become an instant retry.
 */
export function parseDeltaSeconds(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

/**
 * The LARGEST candidate wins, because the library has rounded the two headers in opposite directions
 * and the run gets one retry. `bodySeconds` comes from the JSON body, which a header-stripping proxy
 * cannot remove.
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
 * Whether a guest-creation 429 is leftover quota or the limiter working. `attempt` is the 1-based
 * count of guest creations this process made. A run within the limit cannot have spent it, so the
 * budget is leftover. Past the limit the 429 is the control working and must never be waited out.
 * The count is a lower bound (section 11's web-server guest is not counted), which errs toward
 * 'leftover' and costs at most one bounded wait.
 */
export function classifyGuestLimit({ attempt, limit }) {
  if (!Number.isInteger(attempt) || attempt < 1) return 'indeterminate';
  if (!Number.isInteger(limit) || limit < 1) return 'indeterminate';
  return attempt <= limit ? 'leftover' : 'working';
}

/**
 * Returns `{ action, waitMs, reason }`; `reason` is printed verbatim. Refuses, in order, when this
 * run spent the budget itself, when it already waited once, when nothing said how long to wait, and
 * when the wait exceeds the bound.
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

export function originBucketNote(origin) {
  const host = new URL(origin).hostname;
  const literal = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
  return literal
    ? `${host} is a literal address, so DNS resolution order cannot move this run between buckets`
    : `${host} is a hostname; whichever address it resolves to decides the rate-limit bucket, and ` +
        '::1 and 127.0.0.1 are deliberately separate buckets — pass --origin with a literal address ' +
        'to pin it';
}

/**
 * True when `value` is not a non-empty array. Section 5 once used `?.length === 0` with no `else`,
 * so a missing `uncertainty` object produced neither a pass nor a failure.
 */
export function listIsMissingOrEmpty(value) {
  return !Array.isArray(value) || value.length === 0;
}

/**
 * Uses `== null` so an absent `confidenceHalfWidthPoints` key also fails. The earlier `=== null`
 * passed it, and a Monte Carlo figure without its half-width reads as exact.
 */
export function sampledEquityMissesInterval(equity) {
  return equity?.method === 'monte-carlo' && equity?.confidenceHalfWidthPoints == null;
}

/**
 * Seats in one live `state` frame whose hole cards the recipient may not see. The exemption matches
 * `redactFor` in packages/poker-engine/src/redact.ts: the recipient's own seat, and seats in
 * `view.result.showdowns` of a completed hand. Anything else is a leak whatever the street.
 *
 * The old scan skipped every `street === 'complete'` frame, and a hand that ends by fold is the usual
 * case here. Against a stub API that served the opponent's cards in such a frame, every section
 * stayed green.
 *
 * `holeCards != null` treats an absent key as safe. A seat is own when `isSelf === true` or its index
 * is `viewerSeat`, so renaming either field narrows the exemption. A null or non-array `result`
 * exempts nobody.
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
 * What the last live `state` frame said about the hand, for section 8 to hold the archive to. Every
 * field is type-checked, not defaulted, and absence returns null, which the caller treats as a failure.
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
 * Section 8 once scanned `hand.seats` on `GET /hands` rows, which are `HandSummary` and have no
 * `seats`. Measured on 2026-08-27 it examined zero seats and printed a pass.
 *
 * Cards may appear for `truth.viewerSeat` or for a seat with `showedDown`, as in `toReviewSeat`
 * (apps/api/src/review/build-review.ts). `overclaimed` holds `showedDown` to the wire's
 * `result.showdowns`, so a server cannot open every hand by marking every seat shown. The caller
 * fails when `examined` is 0 or `ownCards` is false, because a sweep of nothing is not a pass.
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
    // An absent key is a seat whose cards were not sent, which is the safe state.
    const hasCards = seat?.holeCards != null;
    const isOwn = ownSeat !== null && seat?.seat === ownSeat;
    if (seat?.showedDown === true && !shown.has(seat.seat)) overclaimed.push(seat.seat);
    if (hasCards && isOwn) ownCards = true;
    if (hasCards && !isOwn && seat?.showedDown !== true) leaked.push(seat.seat);
  }
  return { leaked, overclaimed, examined: seats.length, ownCards };
}

/**
 * Only a validation refusal counts, identified by contract code: `invalid_request` (400),
 * `computation_rejected` (422) or `payload_too_large` (413). Counting any 4xx once let six 429s from
 * a spent expensive-rate-limit budget print "all 6 hostile calculation inputs rejected". A 429 is
 * `untested`, never a pass.
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

/** Must match WS_PROTOCOL_VERSION. */
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
 * Set once by `main()`. Parsing argv at module scope would make the file unimportable, because
 * `node --test` would pass its own argv to `parseArgs`.
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
/** Neither a pass nor a warning, so `--strict` cannot fail a run that uses the wait-out fallback. */
const note = (detail) => console.log(`${DIM}  · ${detail}${RESET}`);
const section = (name) => console.log(`\n${BOLD}${name}${RESET}`);

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
    /** For the WebSocket upgrade, which `fetch` cannot do. */
    get cookieHeader() {
      return [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    },
  };
}

function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

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
 * Sits at a room over a real WebSocket and plays one hand against the seated bot, so section 8 scans
 * a non-empty history. Uses the global `WebSocket` with the options bag as the second argument to
 * attach the session cookie (see the header of scripts/load-test.mjs). Never throws; failures go
 * through `bad()`.
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
 * Opens a socket, handshakes, sends ONE `sit` frame, and reports the answer as data. The error frame
 * is the subject here, which is why `playOneHandOverSocket` does not fit.
 *
 * `welcomed` must be true in both postures, because watching a table is not gated. `errorCode` is the
 * contract code. `closeCode` must be null for this refusal, because closing a permanent refusal
 * sends an honest client into a reconnect loop. Never throws.
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
        // Wait briefly to see whether the server also closes the socket. The frame and any close
        // arrive in the same round trip, so the full deadline would add 20 s per refusal.
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

const REFUSAL_OBSERVATION_MS = 1_000;

/**
 * Runs `apps/api/scripts/enrolments.mjs`, the only way to write an enrolment. `prl_app` holds SELECT
 * only on `prl.cohorts` and `prl.enrolments`, so the write needs `DATABASE_MIGRATION_URL`. The DSN
 * goes through the environment, never argv where `ps` shows it, and is never printed.
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

function lastLine(output) {
  const lines = output.split('\n').filter((line) => line.trim() !== '');
  return (lines.at(-1) ?? '').trim().slice(0, 200);
}

/**
 * Every `POST /auth/guest` goes through `postGuest` so `classifyGuestLimit` gets a true count. That
 * includes section 3's token-less probe, because the rate-limit hook (`onRequest`) runs before the
 * CSRF check (`preValidation`).
 */
let guestAttempts = 0;
let alreadyWaited = false;

/**
 * Not `async`, so the counter increments before the request is sent. Otherwise two concurrent
 * creations would read the same value.
 */
function postGuest(client, displayName) {
  guestAttempts += 1;
  return client.request('POST', '/api/v1/auth/guest', { displayName });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a guest session, recovering once from quota a previous run consumed, or exits with the
 * diagnosis. Carrying on without a session made sections 7, 8 and 9 fail naming the wrong subsystem.
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
 * Empties the rate-limit counters when the deployment has the control and the caller has its token.
 * Unnumbered because other files cite the section numbers. Runs after section 1 so a missing API
 * gets section 1's message.
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

  // The control goes through the same CSRF check as every mutating route.
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
  // A refused token fails the run rather than falling back.
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

  const strings = collectStrings(guest.json).join(' ');
  if (/[$£€]|\bUSD\b|\bbalance\b/i.test(strings)) {
    bad('units framing', 'the session payload uses currency or "balance" wording');
  } else {
    ok('no currency framing in the session payload');
  }

  const authed = await alice.request('GET', '/api/v1/auth/session');
  if (authed.json?.user?.id !== undefined) ok('the session persists across requests', authed.json.user.id);
  else bad('session persistence', `got ${authed.status} ${authed.text.slice(0, 120)}`);

  // The enrolment CLI resolves a guest by its `usr_` id.
  return { client: alice, userId: authed.json?.user?.id ?? user?.id ?? '' };
}

/**
 * Enrolment and the seat guard, in both directions, over REST and WebSocket.
 *
 * Unnumbered, and before section 7, because on an enforcing deployment Alice must be enrolled before
 * she can sit. The posture is discovered by a never-enrolled guest asking for a seat, so "enforced"
 * is only reported after a refusal was observed.
 *
 * Enforced asserts four cells: unenrolled REST gets 403 enrolment_required, unenrolled wss gets an
 * `error` frame with the socket left open, and enrolled wss and REST both seat. Off asserts that the
 * same first request seats the learner.
 *
 * The API cannot write an enrolment, so the grant goes through the operator CLI with
 * `DATABASE_MIGRATION_URL`. An enforcing deployment reached without it is a failure, not a note.
 * `revokeEnrolments` withdraws the grants at the end of the run, after sections 7 and 8.
 */
async function sectionEnrolment(alice, aliceUserId) {
  section('Enrolment and the seat guard');

  /**
   * A second session for the socket half. A second `sit` from the session already in seat 0 is
   * answered `already_seated` whatever the posture.
   */
  const joinProbeTable = async (client, inviteCode) => {
    if (typeof inviteCode !== 'string') return false;
    const joined = await client.request('POST', '/api/v1/rooms/join', { inviteCode });
    if (joined.status === 200 || joined.status === 201) return true;
    bad('enrolment probe', `a second session could not join the probe table: ${joined.status}`);
    return false;
  };

  // A separate never-enrolled guest, because Alice is about to be enrolled.
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

  // Creating a table must stay open to a prospective student. Only taking a seat is gated.
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

  // The probe, and the negative direction, in one request.
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
    // A second session, not Carol again. Measured: reusing Carol reported `already_seated`.
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
  // Alice leaves, so section 7 finds her at exactly one room.
  await alice.request('POST', `/api/v1/rooms/${roomId}/leave`);

  return { enforced, enrolled: [carolUserId, aliceUserId] };
}

/**
 * Revokes the entitlements this run granted. A revocation is the only withdrawal this schema has;
 * the row keeps `revoked_at`, `revoked_by` and `revoked_reason`. A failure here is real, because the
 * grant then needs cleaning up by hand.
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
    // AA vs KK is ~81%.
    const percent = heroEquity * 100;
    if (percent > 75 && percent < 88) {
      ok('AA vs KK equity is plausible', `${percent.toFixed(2)}% by ${equity.json.equity.method}`);
    } else {
      bad('equity', `AA vs KK returned ${percent.toFixed(2)}%, which is not credible`);
    }
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
    if (listIsMissingOrEmpty(report.uncertainty?.limitations)) {
      bad('coach report', 'no limitations stated (the uncertainty block is empty or missing)');
    } else ok('coach states its limitations', `${report.uncertainty.limitations.length}`);
    if (listIsMissingOrEmpty(report.suggestion?.whatWouldChangeIt)) {
      bad('coach report', 'the suggestion does not say what would change it');
    } else ok('the suggestion says what would change it');
  } else {
    bad('coach endpoint', `got ${coach.status} ${coach.text.slice(0, 200)}`);
  }

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
    // See `classifyHostileRefusal`. A 429 is not a validation refusal.
    const verdict = classifyHostileRefusal(response);
    if (verdict.kind === 'rejected') rejected += 1;
    else if (verdict.kind === 'untested') untested += 1;
    else bad('hostile input accepted', `${label} ${verdict.why}`);
  }
  if (untested > 0) {
    // A failure, not a warning. Let the expensive-input window drain, or run with a reset token.
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
 * Returns the second client and `truth` from the terminal `state` frame, which section 8 holds the
 * archive to. `truth` is null when no hand completed, and section 8 treats that as a failure.
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

  // A bot in seat 1 gives Alice a hand to play, so section 8 does not scan an empty history.
  const created = await alice.request('POST', '/api/v1/rooms', {
    name: 'Smoke Table',
    // Three seats, so Bob can still join after the bot fills seat 1.
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

  // Bob must not read a room he was not invited to, and the error must not confirm it exists.
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

    const wrong = await bob.request('POST', '/api/v1/rooms/join', { inviteCode: 'AAAAAAAA' });
    if (wrong.status >= 400)
      ok('a wrong invite code is rejected', `${wrong.json?.error?.code ?? wrong.status}`);
    else bad('invite code', 'a wrong code was accepted');
  }

  if (typeof inviteCode === 'string') {
    const joined = await bob.request('POST', '/api/v1/rooms/join', { inviteCode });
    if (joined.status === 200 || joined.status === 201) ok('Bob joined with the invite code');
    else bad('room join', `got ${joined.status} ${joined.text.slice(0, 200)}`);
  }

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

    // Bot hole cards may appear only in a completed hand that reached showdown. The deck never may.
    const frameKeys = collectKeys(played.frames);
    const leakedKeys = ['deck', 'deckCursor', 'deckSalts', 'salts'].filter((key) => frameKeys.has(key));
    if (leakedKeys.length > 0) {
      bad('hidden information', `a socket frame carried ${leakedKeys.join(', ')}`);
    } else if (played.frames.length > 0) {
      ok('no socket frame carried a deck, cursor or salt', `${played.frames.length} frames scanned`);
    } else {
      bad('hidden information', 'no frames were received, so the socket scan proved nothing');
    }

    // Every frame, including completed ones. See `unentitledHoleCardSeats`.
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
      // Without a completed frame the showdown exemption was never exercised.
      bad(
        'hidden information',
        'no completed-hand frame reached this scan, so the showdown half of the confidentiality ' +
          'check ran over nothing',
      );
    }

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
    // An empty list is a failure. Every check below passes vacuously on one.
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

    // `routes/hands.ts` never projects `hand_seats.hole_cards` into a summary, so the key must be
    // absent. Rows have no `seats` field to scan.
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
    // Without this `else`, a 500 from Bob's history produced no check at all.
    bad('hand isolation', `Bob's history returned ${bobHands.status} ${bobHands.text.slice(0, 200)}`);
  }
  if (bobHands.status === 200) {
    // The filter matters. Rows without `id` map to `[undefined]`, a Set of size 1, and a stub using
    // `handId` printed "1 of Alice's ids checked" having compared nothing.
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

  // `GET /hands/:handId` is the only route that serves a hole card over HTTP.
  await sectionHandReview(alice, aliceRows, truth);

  // A hand that does not exist must 404, not 403 or 500.
  const missing = await alice.request('GET', '/api/v1/hands/hand_doesnotexist');
  if (missing.status === 404) ok('an unknown hand returns 404');
  else warn('unknown hand', `status ${missing.status}`);
}

/**
 * Section 8's hole-card check on the served review. Every branch that cannot check the property
 * fails rather than falling through.
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
  // Keyed on the id so the seat indices belong to the same hand as `truth`.
  const row = aliceRows.find((hand) => hand.id === truth.handId);
  if (row === undefined) {
    bad(
      'hidden information',
      `the hand played over the socket (${String(truth.handId)}) is not in Alice's history, so the ` +
        'review below would be about a different hand than the wire account it is checked against',
    );
    return;
  }

  // This route draws on `app.expensiveRateLimit`, so a spent budget gets its own failure rather than
  // a 'hidden information' one. Alice spends eight of the default 20 tokens before this call.
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
 * The page origin once served no policy while `THEME_BOOT_SCRIPT_CSP_HASH` sat unused, and only a
 * real response shows that. `apps/web/test/csp-policy.test.ts` checks the policy's shape. This checks
 * it arrived and that Next stamped the nonce on the scripts, because without that the page never
 * hydrates.
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
 * The web origin's proxy mints the guest, so this walks it with one cookie jar like a browser. That
 * guest is created from the web server's address, a rate-limit bucket this harness cannot reset.
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

  const who = await fetch(`${options.apiOrigin}/api/v1/auth/session`, {
    headers: { accept: 'application/json', origin: options.webOrigin, cookie: cookieHeader() },
  });
  const body = await who.json().catch(() => null);
  if (body?.user?.kind === 'guest') ok('the session is a real guest account', body.user.id);
  else
    bad('guest bootstrap', `the cookie does not resolve to a guest: ${JSON.stringify(body?.user ?? null)}`);

  // Navigating on, refreshing, and concurrent requests must all reuse the guest.
  const second = await page('/lab');
  const third = await page('/learn');
  const concurrent = await Promise.all([page('/learn'), page('/lab'), page('/record')]);
  const extra = second.minted + third.minted + concurrent.reduce((sum, r) => sum + r.minted, 0);
  if (extra === 0) ok('navigation, refresh and concurrent requests mint nothing further');
  else bad('guest bootstrap', `${extra} further Set-Cookie header(s) after the session existed`);

  const stillTheSame = [...jar.keys()].filter((name) => name.endsWith('prl_session'));
  if (stillTheSame.length === 1) ok('the visitor keeps one identity across navigation');
  else bad('guest bootstrap', `the jar now holds ${stillTheSame.length} session cookies`);

  // A path outside the bootstrap set must not create an account for a crawler.
  const anonymous = await fetch(`${options.webOrigin}/legends`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'document' },
  });
  if (anonymous.headers.getSetCookie().length === 0) ok('/legends mints nothing for an anonymous visitor');
  else warn('guest bootstrap', '/legends issued a cookie; the bootstrap set is wider than intended');

  const prefetch = await fetch(`${options.webOrigin}/learn`, {
    headers: { accept: 'text/html', 'sec-fetch-dest': 'empty', rsc: '1', 'next-router-prefetch': '1' },
  });
  if (prefetch.headers.getSetCookie().length === 0) ok('a prefetch of /learn mints nothing');
  else bad('guest bootstrap', 'a prefetch created an account for a page that was never opened');

  // The reader's own work is now recorded.
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
 * Last, because it floods `POST /auth/guest` until a 429 and any later guest creation would measure
 * the flood. Nothing is reset afterwards, because the next run must survive a drained limiter.
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

async function main() {
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    // The reason on one line, with no stack.
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
  // Before section 7. On an enforcing deployment Alice cannot sit until she is enrolled.
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
