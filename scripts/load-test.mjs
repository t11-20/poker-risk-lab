#!/usr/bin/env node
/**
 * Load and capacity harness (`pnpm run test:load`); `--help` lists every flag.
 *
 * A metric the process does not emit reads as `null` and can never fire a saturation signal, because
 * the registry renders no line for a counter that was never incremented and `0` would claim an
 * absence of load. `prl_event_loop_delay_*` is a rolling window reset by every scrape, so a second
 * scraper halves it. `prl_db_probe_duration_seconds` only advances on `GET /ready`, so the harness
 * calls it per scrape.
 *
 * The WebSocket cookie goes in Node's non-standard options bag as the SECOND constructor argument,
 * `new WebSocket(url, { headers })`. A third argument is silently ignored (verified on Node 24.18.0).
 * Cookies are read with `getSetCookie()`, because `get('set-cookie')` comma-joins them and Expires
 * contains commas.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { arch, availableParallelism, loadavg, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { RATE_LIMIT_RESET_PATH } from './smoke-test.mjs';

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

/** Must match WS_PROTOCOL_VERSION. */
const WS_PROTOCOL_VERSION = 1;

/** `/metrics` is registered at the root beside `/health`, not under `/api/v1`. */
const ROUTES = {
  health: '/api/v1/health',
  ready: '/api/v1/ready',
  guest: '/api/v1/auth/guest',
  session: '/api/v1/auth/session',
  rooms: '/api/v1/rooms',
  joinRoom: '/api/v1/rooms/join',
  hands: '/api/v1/hands',
  hand: (handId) => `/api/v1/hands/${encodeURIComponent(handId)}`,
  ws: '/api/v1/ws',
  metrics: '/metrics',
};

/** Server metric names, kept in one table so the report can say which ones the process emitted. */
const SERIES = {
  httpRequests: 'prl_http_requests_total',
  httpDuration: 'prl_http_request_duration_seconds',
  apiErrors: 'prl_api_errors_total',
  rateLimitEvents: 'prl_rate_limit_events_total',
  dbProbe: 'prl_db_probe_duration_seconds',
  dbPoolMax: 'prl_db_pool_max',
  dbErrors: 'prl_db_errors_total',
  readinessState: 'prl_readiness_state',
  cpuSeconds: 'prl_process_cpu_seconds_total',
  residentMemory: 'prl_process_resident_memory_bytes',
  heapUsed: 'prl_process_heap_used_bytes',
  eventLoopP99: 'prl_event_loop_delay_p99_seconds',
  eventLoopMean: 'prl_event_loop_delay_seconds',
  eventLoopMax: 'prl_event_loop_delay_max_seconds',
  wsConnections: 'prl_websocket_connections',
  wsOpened: 'prl_websocket_opened_total',
  wsRefused: 'prl_websocket_refused_total',
  roomsLive: 'prl_rooms_live',
  handsStarted: 'prl_hands_started_total',
  handsCompleted: 'prl_hands_completed_total',
  workerPoolSize: 'prl_worker_pool_size',
  workerPoolBusy: 'prl_worker_pool_busy',
  workerPoolQueued: 'prl_worker_pool_queued',
  analysisDuration: 'prl_analysis_duration_seconds',
};

/**
 * `WS_LIMITS.coachRequestsPerMinute` is 30 per session. 2100 ms allows 28 per minute, so a run that
 * drifts a few milliseconds fast does not measure the limiter.
 */
const COACH_MIN_INTERVAL_MS = 2_100;

/** `GET /hands/:handId` allows 20 per minute per caller by default. 3500 ms is at most 17. */
const REVIEW_MIN_INTERVAL_MS = 3_500;

/** About two minutes on a developer machine: four levels, fifteen seconds of steady state each. */
const DEFAULTS = {
  baseUrl: process.env.PRL_API_ORIGIN ?? 'http://127.0.0.1:3001',
  /**
   * Must match a `PUBLIC_WEB_ORIGIN` entry exactly. `127.0.0.1` and `localhost` are different
   * origins, and `.env.example` ships `localhost`.
   */
  origin: process.env.PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000',
  wsPath: ROUTES.ws,
  metricsPath: ROUTES.metrics,
  metricsToken: process.env.METRICS_TOKEN ?? '',
  /** Tables per level, ascending. Concurrency is `tables x seats` seated players. */
  ramp: '1,2,4,8',
  /** Overrides the ramp with one level of this many tables. 0 means "use --ramp". */
  tables: 0,
  /** The schema caps a room at 6 (createRoomBody, rooms.max_seats). */
  seats: 3,
  holdSeconds: 15,
  drainSeconds: 20,
  /** Seconds between `/metrics` scrapes, each preceded by the `/ready` probe that feeds the DB histogram. */
  scrapeSeconds: 3,
  /**
   * A throwaway warm-up level before the ramp. The first Coach analysis on a cold worker thread
   * costs about 3 s against 20-30 ms warm, and left in level 1 it fails every run. It is reported as
   * its own cold-start figure. `--skip-warmup` measures the cold process instead.
   */
  warmupSeconds: 5,
  /**
   * Optional cap on hands per table per level; 0 lets the hold decide. A default cap of 200 ended fast
   * levels after two seconds and reported 7970 hands/minute beside 762.
   */
  hands: 0,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  actionTimeoutSeconds: 15,
  /**
   * Delay before sending an already-chosen action. At 0 a virtual user offers the most work one seat
   * can, so the capacity figure counts virtual users, not people. `--think 1000` models people. The
   * latency clock starts after the delay, and `parseArgs` keeps it below half the turn clock.
   */
  thinkMs: 0,
  /** Hands between one client's mid-hand disconnect/reconnect cycles. */
  reconnectEvery: 2,
  /** Hands between one client's Hand Review reads, on top of REVIEW_MIN_INTERVAL_MS. */
  reviewEvery: 2,
  seed: 1,
  /** Whole-run budget across every level. The run fails if it has not finished by then. */
  timeoutSeconds: 900,
  // Stop criteria. Crossing any of these ends the ramp and names itself.
  maxErrorRate: 0.01,
  maxP95Ms: 150,
  maxP99Ms: 250,
  minReconnectRate: 0.99,
  // Saturation thresholds, in the units the metric reports.
  eventLoopP99Ms: 50,
  cpuCores: 0.9,
  dbProbeP99Ms: 50,
  // Asserted by the operator, never measured.
  serverEnv: 'unstated',
};

const HELP = `
${bold('pnpm run test:load')} — ramp real user journeys against one API instance and find where it saturates

  ${yellow('Every number this prints is stamped with the environment it was measured in.')}
  ${yellow('Read the Environment block and the footer before quoting any of them.')}

  Connection
    --base-url <url>        API origin                         (default ${DEFAULTS.baseUrl})
    --origin <url>          Origin header on REST and the WS upgrade
                                                               (default ${DEFAULTS.origin})
    --ws-path <path>        WebSocket path                     (default ${DEFAULTS.wsPath})
    --metrics-path <path>   Prometheus endpoint                (default ${DEFAULTS.metricsPath})
    --metrics-token <token> bearer token for it, when the server requires one
                                                               (default: $METRICS_TOKEN)

  Ramp
    --ramp <list>           tables per level, ascending        (default ${DEFAULTS.ramp})
    --tables <n>            one level of n tables, instead of the ramp
    --seats <n>             seats filled per table, 2-6        (default ${DEFAULTS.seats})
    --hold <secs>           steady state held per level        (default ${DEFAULTS.holdSeconds})
    --drain <secs>          time for in-flight hands to finish (default ${DEFAULTS.drainSeconds})
    --scrape <secs>         seconds between /metrics scrapes   (default ${DEFAULTS.scrapeSeconds})
    --warmup <secs>         throwaway level run before the ramp (default ${DEFAULTS.warmupSeconds})
    --skip-warmup           measure the COLD process instead; level 1 then carries the
                            first-Coach cost, which is seconds, not milliseconds
    --hands <n>             stop a table after n hands, 0 lets the hold decide
                                                               (default ${DEFAULTS.hands})
    --timeout <secs>        whole-run budget                   (default ${DEFAULTS.timeoutSeconds})

  Journey
    --think <ms>            pause before each action, modelling a person
                                                               (default ${DEFAULTS.thinkMs} — a virtual user
                            at 0 is not a person; it is the most work one seat can offer)
    --reconnect-every <n>   hands between mid-hand reconnects  (default ${DEFAULTS.reconnectEvery})
    --review-every <n>      hands between Hand Review reads    (default ${DEFAULTS.reviewEvery})
    --no-coach              do not request Coach at all
    --no-reconnect          do not disconnect mid-hand
    --no-review             do not open Hand Review

  Table setup
    --small-blind <n>                                          (default ${DEFAULTS.smallBlind})
    --big-blind <n>                                            (default ${DEFAULTS.bigBlind})
    --starting-stack <n>                                       (default ${DEFAULTS.startingStack})
    --action-timeout <secs> server-side turn clock, 5-120      (default ${DEFAULTS.actionTimeoutSeconds})
    --seed <n>              seeds every client's action policy (default ${DEFAULTS.seed})

  Stop criteria — the ramp ends at the first level that crosses one, and says which
    --max-error-rate <r>    errors / operations, 0-1           (default ${DEFAULTS.maxErrorRate})
    --max-p95-ms <ms>       action round-trip p95              (default ${DEFAULTS.maxP95Ms})
    --max-p99-ms <ms>       action round-trip p99              (default ${DEFAULTS.maxP99Ms})
    --min-reconnect-rate <r> reconnects that resumed, 0-1      (default ${DEFAULTS.minReconnectRate})

  Saturation classification — which resource is blamed, and at what value
    --event-loop-p99-ms <ms>                                   (default ${DEFAULTS.eventLoopP99Ms})
    --cpu-cores <n>         process CPU seconds per wall second (default ${DEFAULTS.cpuCores})
    --db-probe-p99-ms <ms>                                     (default ${DEFAULTS.dbProbeP99Ms})

  Honest labelling — asserted by you, never detected
    --server-env <name>     the server's NODE_ENV              (default ${DEFAULTS.serverEnv})
    --via-proxy             a reverse proxy or TLS terminator is in front of the API

    --json                  also print the report as one JSON object
    --out <file>            write that JSON object to a file
    -h, --help              this text

  Sockets open at the widest level = (largest --ramp entry) x --seats. Guest sessions are
  provisioned once, up front, for that widest level and reused by every level, so the ramp
  measures play rather than account creation.
`;

const NUMERIC_OPTIONS = new Map([
  ['--tables', 'tables'],
  ['--seats', 'seats'],
  ['--hold', 'holdSeconds'],
  ['--drain', 'drainSeconds'],
  ['--scrape', 'scrapeSeconds'],
  ['--warmup', 'warmupSeconds'],
  ['--hands', 'hands'],
  ['--timeout', 'timeoutSeconds'],
  ['--small-blind', 'smallBlind'],
  ['--big-blind', 'bigBlind'],
  ['--starting-stack', 'startingStack'],
  ['--action-timeout', 'actionTimeoutSeconds'],
  ['--think', 'thinkMs'],
  ['--reconnect-every', 'reconnectEvery'],
  ['--review-every', 'reviewEvery'],
  ['--seed', 'seed'],
  ['--max-error-rate', 'maxErrorRate'],
  ['--max-p95-ms', 'maxP95Ms'],
  ['--max-p99-ms', 'maxP99Ms'],
  ['--min-reconnect-rate', 'minReconnectRate'],
  ['--event-loop-p99-ms', 'eventLoopP99Ms'],
  ['--cpu-cores', 'cpuCores'],
  ['--db-probe-p99-ms', 'dbProbeP99Ms'],
]);

const STRING_OPTIONS = new Map([
  ['--base-url', 'baseUrl'],
  ['--origin', 'origin'],
  ['--ws-path', 'wsPath'],
  ['--metrics-path', 'metricsPath'],
  ['--metrics-token', 'metricsToken'],
  ['--ramp', 'ramp'],
  ['--server-env', 'serverEnv'],
  ['--out', 'out'],
]);

const BOOLEAN_OPTIONS = new Map([
  ['--json', 'json'],
  ['--via-proxy', 'viaProxy'],
]);

/** These set `false`, not `true`. */
const DISABLE_OPTIONS = new Map([
  ['--no-coach', 'coach'],
  ['--no-reconnect', 'reconnect'],
  ['--no-review', 'review'],
  ['--skip-warmup', 'warmup'],
]);

/** Exported for `load-test.test.mjs`. Every rejection throws the reason, not "invalid --seats". */
export function parseArgs(argv) {
  const options = {
    ...DEFAULTS,
    out: '',
    json: false,
    viaProxy: false,
    coach: true,
    reconnect: true,
    review: true,
    warmup: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run test:load -- --ramp 1,2` forwards the `--` itself.
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(arg)) {
      options[BOOLEAN_OPTIONS.get(arg)] = true;
      continue;
    }
    if (DISABLE_OPTIONS.has(arg)) {
      options[DISABLE_OPTIONS.get(arg)] = false;
      continue;
    }
    const value = argv[i + 1];
    if (NUMERIC_OPTIONS.has(arg)) {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${arg} needs a number, got "${value}"`);
      options[NUMERIC_OPTIONS.get(arg)] = parsed;
      i += 1;
      continue;
    }
    if (STRING_OPTIONS.has(arg)) {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      options[STRING_OPTIONS.get(arg)] = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown option ${arg} (try --help)`);
  }

  if (options.help) return options;

  // rooms.max_seats has a CHECK BETWEEN 2 AND 6, and createRoomBody repeats it.
  if (!Number.isInteger(options.seats) || options.seats < 2 || options.seats > 6) {
    throw new Error('--seats must be an integer from 2 to 6 (rooms.max_seats CHECK)');
  }
  options.levels = parseRamp(options);
  if (!Number.isInteger(options.hands) || options.hands < 0) {
    throw new Error('--hands must be a non-negative integer (0 lets --hold decide the level length)');
  }
  if (options.holdSeconds < 1) {
    throw new Error('--hold must be at least 1 second; a level shorter than that cannot carry a p99');
  }
  if (options.drainSeconds < 0) throw new Error('--drain cannot be negative');
  if (options.warmup && options.warmupSeconds < 1) {
    throw new Error('--warmup must be at least 1 second (use --skip-warmup to measure a cold process)');
  }
  if (options.scrapeSeconds < 0.5) {
    throw new Error('--scrape must be at least 0.5s; scraping resets the event-loop window each time');
  }
  if (options.scrapeSeconds > options.holdSeconds) {
    throw new Error(
      `--scrape ${options.scrapeSeconds}s exceeds --hold ${options.holdSeconds}s, so a level would ` +
        'produce a single scrape and no interval to compute a delta over',
    );
  }
  if (options.bigBlind <= options.smallBlind) {
    throw new Error('--big-blind must exceed --small-blind (rooms CHECK constraint)');
  }
  if (options.startingStack < options.bigBlind * 2) {
    throw new Error('--starting-stack must be at least twice --big-blind (rooms CHECK constraint)');
  }
  if (
    !Number.isInteger(options.actionTimeoutSeconds) ||
    options.actionTimeoutSeconds < 5 ||
    options.actionTimeoutSeconds > 120
  ) {
    throw new Error('--action-timeout must be an integer from 5 to 120 (createRoomBody schema)');
  }
  if (options.maxErrorRate < 0 || options.maxErrorRate > 1) {
    throw new Error('--max-error-rate is a fraction between 0 and 1');
  }
  if (options.minReconnectRate < 0 || options.minReconnectRate > 1) {
    throw new Error('--min-reconnect-rate is a fraction between 0 and 1');
  }
  if (!Number.isInteger(options.reconnectEvery) || options.reconnectEvery < 1) {
    throw new Error('--reconnect-every must be a positive integer (use --no-reconnect to switch it off)');
  }
  if (options.thinkMs < 0) throw new Error('--think cannot be negative');
  // Half the turn clock. A think time near the clock races the server's timer, and the losing seat is
  // folded automatically.
  if (options.thinkMs > options.actionTimeoutSeconds * 500) {
    throw new Error(
      `--think ${options.thinkMs}ms is more than half the ${options.actionTimeoutSeconds}s turn clock, ` +
        'so seats would be folded by the server timer instead of acting',
    );
  }
  if (!Number.isInteger(options.reviewEvery) || options.reviewEvery < 1) {
    throw new Error('--review-every must be a positive integer (use --no-review to switch it off)');
  }
  return options;
}

/** Ascending is required, because the report is built on the highest level that met every threshold. */
function parseRamp(options) {
  if (options.tables !== 0) {
    if (!Number.isInteger(options.tables) || options.tables < 1) {
      throw new Error('--tables must be a positive integer');
    }
    return [options.tables];
  }
  const levels = options.ramp
    .split(',')
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .map((piece) => {
      const parsed = Number(piece);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`--ramp entries must be positive integers, got "${piece}"`);
      }
      return parsed;
    });
  if (levels.length === 0) throw new Error('--ramp needs at least one table count');
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] <= levels[i - 1]) {
      throw new Error(
        `--ramp must ascend strictly: ${levels[i - 1]} is followed by ${levels[i]}. The report's ` +
          '"highest level that passed" has no meaning over an unordered ramp.',
      );
    }
  }
  return levels;
}

/**
 * Nearest-rank percentile with no interpolation, so it never reports a latency no request had.
 * `Math.ceil(fraction * n)` is the 1-based rank and the index is one less. `load-test.test.mjs`
 * feeds both off-by-one variants as negative controls.
 */
export function percentile(sortedSamples, fraction) {
  if (sortedSamples.length === 0) return null;
  const rank = Math.ceil(fraction * sortedSamples.length);
  const index = Math.min(Math.max(rank, 1), sortedSamples.length) - 1;
  return sortedSamples[index];
}

/**
 * Latency summary in milliseconds. p95 is here because `HTTP_BUCKETS` puts the 250 ms p95 alert on a
 * bucket boundary. `count` sits beside every percentile because a p99 over fewer than about 100
 * samples is the maximum.
 */
export function summariseLatency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { count: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  }
  let total = 0;
  for (const sample of sorted) total += sample;
  return {
    count: sorted.length,
    meanMs: total / sorted.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1],
  };
}

/** At n = 100 the nearest rank for 0.99 is 99, so p99 is the second-largest sample. */
const MIN_SAMPLES_FOR_P99 = 100;

/**
 * Parses Prometheus text exposition: HELP/TYPE/comment lines, labelled and unlabelled samples, the
 * three label escapes, `+Inf`/`-Inf`/`NaN` values, and an optional trailing timestamp. Hand-written
 * to avoid a dependency. An unparseable line goes into `malformed` instead of throwing, so one bad
 * line still yields every other number.
 */
export function parseExposition(text) {
  const samples = [];
  const index = new Map();
  const help = new Map();
  const types = new Map();
  const malformed = [];

  for (const rawLine of text.split('\n')) {
    // Strip only a trailing CR. Leading whitespace is not legal exposition and must not be hidden.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;
    if (line.startsWith('#')) {
      const meta = /^#\s+(HELP|TYPE)\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (meta === null) continue;
      if (meta[1] === 'HELP') help.set(meta[2], meta[3] ?? '');
      else types.set(meta[2], (meta[3] ?? '').trim());
      continue;
    }
    const sample = parseSampleLine(line);
    if (sample === null) {
      malformed.push(line);
      continue;
    }
    samples.push(sample);
    const existing = index.get(sample.name);
    if (existing === undefined) index.set(sample.name, [sample]);
    else existing.push(sample);
  }

  return { samples, index, help, types, malformed };
}

function parseSampleLine(line) {
  const nameMatch = /^[a-zA-Z_:][a-zA-Z0-9_:]*/.exec(line);
  if (nameMatch === null) return null;
  const name = nameMatch[0];
  let cursor = name.length;

  let labels = {};
  if (line[cursor] === '{') {
    const parsed = parseLabels(line, cursor);
    if (parsed === null) return null;
    labels = parsed.labels;
    cursor = parsed.cursor;
  }

  const rest = line.slice(cursor).trim();
  if (rest === '') return null;
  // Take the first token, so a timestamp is not concatenated into the value (about 10^13 too large).
  const [valueToken] = rest.split(/\s+/);
  const value = parseExpositionValue(valueToken);
  if (value === null) return null;
  return { name, labels, value };
}

/** Hand-written because a label value may legally contain `}`, `,` and an escaped `"`. */
function parseLabels(line, open) {
  const labels = {};
  let cursor = open + 1;
  for (;;) {
    while (line[cursor] === ' ') cursor += 1;
    if (line[cursor] === '}') return { labels, cursor: cursor + 1 };
    const nameMatch = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(line.slice(cursor));
    if (nameMatch === null) return null;
    const name = nameMatch[0];
    cursor += name.length;
    while (line[cursor] === ' ') cursor += 1;
    if (line[cursor] !== '=') return null;
    cursor += 1;
    while (line[cursor] === ' ') cursor += 1;
    if (line[cursor] !== '"') return null;
    cursor += 1;

    let value = '';
    for (;;) {
      const char = line[cursor];
      if (char === undefined) return null;
      if (char === '"') {
        cursor += 1;
        break;
      }
      if (char === '\\') {
        const escaped = line[cursor + 1];
        if (escaped === undefined) return null;
        // The format defines three escapes. Anything else after a backslash passes through.
        value += escaped === 'n' ? '\n' : escaped;
        cursor += 2;
        continue;
      }
      value += char;
      cursor += 1;
    }
    labels[name] = value;

    while (line[cursor] === ' ') cursor += 1;
    if (line[cursor] === ',') {
      cursor += 1;
      continue;
    }
    if (line[cursor] === '}') return { labels, cursor: cursor + 1 };
    return null;
  }
}

export function parseExpositionValue(token) {
  if (token === '+Inf' || token === 'Inf' || token === '+inf') return Number.POSITIVE_INFINITY;
  if (token === '-Inf' || token === '-inf') return Number.NEGATIVE_INFINITY;
  if (token === 'NaN' || token === 'nan') return Number.NaN;
  const value = Number(token);
  return Number.isNaN(value) ? null : value;
}

function matchesLabels(sample, labels) {
  for (const [name, value] of Object.entries(labels)) {
    if (sample.labels[name] !== value) return false;
  }
  return true;
}

/** Null, never zero, when the process does not export the series. See the header. */
export function sampleValue(snapshot, name, labels = {}) {
  const series = snapshot.index.get(name);
  if (series === undefined) return null;
  const found = series.find((sample) => matchesLabels(sample, labels));
  return found === undefined ? null : found.value;
}

/**
 * Sum across every label combination, or null when not exported. `filter` drops this harness's own
 * `/metrics` and `/ready` traffic from the HTTP totals.
 */
export function seriesTotal(snapshot, name, filter = () => true) {
  const series = snapshot.index.get(name);
  if (series === undefined) return null;
  let total = 0;
  for (const sample of series) {
    if (filter(sample.labels)) total += sample.value;
  }
  return total;
}

export function seriesByLabel(snapshot, name, labelName) {
  const series = snapshot.index.get(name);
  if (series === undefined) return null;
  const out = {};
  for (const sample of series) {
    const key = sample.labels[labelName] ?? 'none';
    out[key] = (out[key] ?? 0) + sample.value;
  }
  return out;
}

/** `le` is a number and `+Inf` becomes `Infinity`, so the buckets sort with no special case. */
export function histogramOf(snapshot, name, labels = {}) {
  const buckets = (snapshot.index.get(`${name}_bucket`) ?? [])
    .filter((sample) => matchesLabels(sample, labels) && sample.labels.le !== undefined)
    .map((sample) => ({ le: parseExpositionValue(sample.labels.le) ?? Number.NaN, cumulative: sample.value }))
    .filter((bucket) => !Number.isNaN(bucket.le))
    .sort((a, b) => a.le - b.le);
  const count = sampleValue(snapshot, `${name}_count`, labels);
  const sum = sampleValue(snapshot, `${name}_sum`, labels);
  if (buckets.length === 0 && count === null) return null;
  return { buckets, sum: sum ?? 0, count: count ?? 0 };
}

/**
 * Subtracts a baseline so a level's distribution covers only its own observations. A bucket missing
 * from `before` counts as zero.
 */
export function histogramDelta(before, after) {
  if (after === null) return null;
  if (before === null) return after;
  const baseline = new Map(before.buckets.map((bucket) => [bucket.le, bucket.cumulative]));
  return {
    buckets: after.buckets.map((bucket) => ({
      le: bucket.le,
      cumulative: bucket.cumulative - (baseline.get(bucket.le) ?? 0),
    })),
    sum: after.sum - before.sum,
    count: after.count - before.count,
  };
}

/**
 * The bucket bound at or above which a quantile fell, not an interpolated value. Returns a finite
 * bound, `Infinity` when it fell in the `+Inf` bucket, or `null` when there were no observations.
 * `null` reads downstream as "not exported", so `Infinity` keeps a database probe slower than the top
 * bucket from looking like no data.
 */
export function histogramBoundAtQuantile(histogram, quantile) {
  if (histogram === null || histogram.count <= 0) return null;
  const target = quantile * histogram.count;
  let seen = 0;
  for (const bucket of histogram.buckets) {
    seen = bucket.cumulative;
    if (seen >= target) return bucket.le;
  }
  // Reached only by a truncated exposition with no `+Inf` bucket.
  return Number.POSITIVE_INFINITY;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Counters and latency samples for ONE level. A fresh instance per level, because a shared one would
 * average the saturation point away. Every sample is kept, because a p99 needs them.
 */
class LevelMetrics {
  constructor() {
    this.connectionsAttempted = 0;
    this.connectionsEstablished = 0;
    this.reconnectsAttempted = 0;
    this.reconnectsEstablished = 0;
    this.reconnectsConsistent = 0;
    this.reconnectsHandAdvanced = 0;
    this.joins = 0;
    this.roomsCreated = 0;
    this.seated = 0;
    this.actionsSent = 0;
    this.actionsApplied = 0;
    this.coachRequested = 0;
    this.coachAnswered = 0;
    this.reviewsOpened = 0;
    this.handsCompleted = 0;
    this.serverMessages = 0;
    this.seatTimeouts = 0;
    this.socketsOpen = 0;
    this.socketsOpenPeak = 0;
    this.latencies = { action: [], coach: [], review: [], connect: [], reconnect: [] };
    /** code -> count. Protocol error codes, transport codes, and consistency failures. */
    this.errors = new Map();
    /** Any one of these fails the whole run. */
    this.consistencyFailures = [];
    this.startedAt = null;
    this.finishedAt = null;
  }

  error(code) {
    this.errors.set(code, (this.errors.get(code) ?? 0) + 1);
  }

  socketOpened() {
    this.socketsOpen += 1;
    if (this.socketsOpen > this.socketsOpenPeak) this.socketsOpenPeak = this.socketsOpen;
  }

  socketClosed() {
    if (this.socketsOpen > 0) this.socketsOpen -= 1;
  }

  get errorCount() {
    let total = 0;
    for (const count of this.errors.values()) total += count;
    return total;
  }

  /** The error rate's denominator, printed beside it. */
  get operationCount() {
    return (
      this.roomsCreated +
      this.joins +
      this.connectionsAttempted +
      this.reconnectsAttempted +
      this.seated +
      this.actionsSent +
      this.coachRequested +
      this.reviewsOpened
    );
  }

  get errorRate() {
    const operations = this.operationCount + this.errorCount;
    return operations === 0 ? 0 : this.errorCount / operations;
  }
}

/**
 * One guest identity. The cookie jar ignores Domain, Path, Expires and Secure, which is fine for one
 * origin for a few minutes. Sessions are provisioned once for the widest level, and each level sets
 * `metrics` to its own `LevelMetrics`.
 */
class Session {
  constructor(baseUrl, origin, name, metrics) {
    this.baseUrl = baseUrl;
    this.origin = origin;
    this.name = name;
    this.metrics = metrics;
    this.cookies = new Map();
    this.csrfToken = null;
    this.userId = null;
    this.lastReviewAt = 0;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(response) {
    // getSetCookie(), because `get('set-cookie')` comma-joins cookies and Expires contains commas.
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /** Errors are bucketed by the server's `error.code`, or `transport:*` when there was none. */
  async request(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json', origin: this.origin };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrfToken && method !== 'GET') headers['x-csrf-token'] = this.csrfToken;

    let response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      const code = typeof err?.cause?.code === 'string' ? err.cause.code : 'fetch-failed';
      this.metrics.error(`transport:${code}`);
      throw new Error(`${method} ${path} failed: ${err.message}`);
    }

    this.absorb(response);

    const text = await response.text();
    let payload = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        this.metrics.error('transport:non-json-response');
        throw new Error(`${method} ${path} returned ${response.status} with a non-JSON body`);
      }
    }

    if (!response.ok) {
      const code = payload?.error?.code ?? `http-${response.status}`;
      this.metrics.error(code);
      const message = payload?.error?.message ?? response.statusText;
      throw new Error(`${method} ${path} -> ${response.status} ${code}: ${message}`);
    }
    return payload;
  }

  /**
   * GET first. `POST /auth/guest` is mutating, so the CSRF hook needs the token and cookie that
   * `GET /auth/session` hands out. POSTing first fails `csrf_failed` every time.
   */
  async createGuest() {
    const seed = await this.request(ROUTES.session);
    this.csrfToken = seed?.csrfToken ?? null;
    if (this.csrfToken === null) {
      throw new Error(`no CSRF token from GET ${ROUTES.session} — every mutation would be rejected`);
    }

    const created = await this.request(ROUTES.guest, { method: 'POST', body: { displayName: this.name } });
    // Keep the seeded token if the response ever stops carrying a fresh one.
    this.csrfToken = created?.csrfToken ?? this.csrfToken;
    this.userId = created?.user?.id ?? null;
    if (this.userId === null) {
      throw new Error(`POST ${ROUTES.guest} returned no user id; the session is unusable`);
    }
    return this;
  }
}

/**
 * Reads `GET /metrics` and `GET /ready`. `/ready` runs before each scrape, because it is the only
 * thing that observes `prl_db_probe_duration_seconds`.
 */
class MetricsScraper {
  constructor({ baseUrl, metricsPath, readyPath, token, origin }) {
    this.baseUrl = baseUrl;
    this.metricsPath = metricsPath;
    this.readyPath = readyPath;
    this.token = token;
    this.origin = origin;
    this.scrapes = 0;
    this.failures = 0;
  }

  async scrape() {
    // Reported as harness overhead, not applied load.
    try {
      await fetch(new URL(this.readyPath, this.baseUrl), {
        headers: { accept: 'application/json', origin: this.origin },
      });
    } catch {
      // Not a scrape failure. `/metrics` answers from memory when the database does not.
    }

    const headers = { accept: 'text/plain' };
    if (this.token !== '') headers.authorization = `Bearer ${this.token}`;
    try {
      const response = await fetch(new URL(this.metricsPath, this.baseUrl), { headers });
      const text = await response.text();
      if (!response.ok) {
        this.failures += 1;
        return { at: Date.now(), ok: false, reason: `HTTP ${response.status}`, body: text.slice(0, 200) };
      }
      this.scrapes += 1;
      return { at: Date.now(), ok: true, snapshot: parseExposition(text) };
    } catch (error) {
      this.failures += 1;
      return { at: Date.now(), ok: false, reason: error.message, body: '' };
    }
  }
}

/**
 * Counters become deltas across the level and gauges become the peak. Anything not exported is
 * `null` and goes in `missing`.
 */
function summariseServerSide(readings) {
  const good = readings.filter((reading) => reading.ok);
  const missing = new Set();
  const failed = readings.length - good.length;

  if (good.length < 2) {
    return {
      scrapes: good.length,
      scrapeFailures: failed,
      usable: false,
      note:
        'fewer than two successful scrapes, so no counter delta could be computed for this level; ' +
        'lower --scrape or raise --hold',
      missing: [],
    };
  }

  const first = good[0].snapshot;
  const last = good[good.length - 1].snapshot;
  const scrapeSpanSeconds = (good[good.length - 1].at - good[0].at) / 1000;

  const counterDelta = (name, filter) => {
    const before = seriesTotal(first, name, filter);
    const after = seriesTotal(last, name, filter);
    if (before === null || after === null) {
      missing.add(name);
      return null;
    }
    return after - before;
  };

  /**
   * Excludes the baseline reading. The event-loop gauges are only written when the window has samples,
   * and the baseline comes milliseconds after the previous level's last scrape, so it still holds the
   * previous level's numbers. Including it made level 1 and level 2 both report a 576.678271 ms p99.
   */
  const gaugePeak = (name) => {
    const during = good.length > 1 ? good.slice(1) : good;
    let peak = null;
    for (const reading of during) {
      const value = sampleValue(reading.snapshot, name);
      if (value === null) continue;
      peak = peak === null ? value : Math.max(peak, value);
    }
    if (peak === null) missing.add(name);
    return peak;
  };

  // This harness's own scraping and probing are measurement, not load.
  const isHarnessOverhead = (labels) => labels.route === '/metrics' || labels.route === ROUTES.ready;

  const cpuSecondsDelta = counterDelta(SERIES.cpuSeconds);
  const dbProbe = histogramDelta(histogramOf(first, SERIES.dbProbe), histogramOf(last, SERIES.dbProbe));
  if (dbProbe === null) missing.add(SERIES.dbProbe);

  for (const name of [SERIES.wsConnections, SERIES.workerPoolBusy, SERIES.workerPoolQueued]) {
    if (sampleValue(last, name) === null) missing.add(name);
  }
  for (const name of [SERIES.handsStarted, SERIES.handsCompleted, SERIES.wsOpened, SERIES.roomsLive]) {
    if (seriesTotal(last, name) === null) missing.add(name);
  }

  const apiErrorsBefore = seriesByLabel(first, SERIES.apiErrors, 'code') ?? {};
  const apiErrorsAfter = seriesByLabel(last, SERIES.apiErrors, 'code') ?? {};
  const apiErrors = {};
  for (const [code, after] of Object.entries(apiErrorsAfter)) {
    const delta = after - (apiErrorsBefore[code] ?? 0);
    if (delta > 0) apiErrors[code] = delta;
  }

  /**
   * Null when the process exports no rate-limit series, so `refusal-rate-limited` cannot report a
   * zero it never read. `metrics.ts` primes both series at 0 today, which masks the absent case.
   */
  const rateBefore = seriesByLabel(first, SERIES.rateLimitEvents, 'kind');
  const rateAfter = seriesByLabel(last, SERIES.rateLimitEvents, 'kind');
  if (rateAfter === null) missing.add(SERIES.rateLimitEvents);
  const rateDelta = (kind) =>
    rateAfter === null ? null : (rateAfter[kind] ?? 0) - (rateBefore?.[kind] ?? 0);
  const rateLimited = rateDelta('limited');
  const rateBanned = rateDelta('banned');

  return {
    scrapes: good.length,
    scrapeFailures: failed,
    usable: true,
    scrapeSpanSeconds,
    /**
     * Gauge readings after dropping the baseline. A level that ends before the first interval scrape
     * leaves one reading taken after the sockets closed, and every gauge reads zero. Reported, not
     * corrected, because the fix is a longer hold.
     */
    gaugeReadings: Math.max(good.length - 1, 0),
    gaugeNote:
      good.length - 1 < 2
        ? 'gauge peaks come from a single reading taken after this level had already finished, so ' +
          'sockets, memory and event-loop figures below describe a torn-down level; raise --hold ' +
          'or lower --scrape'
        : null,
    // Divided by the scrape span, the only interval the counter delta describes.
    httpRequestsPerSecond:
      scrapeSpanSeconds > 0
        ? (counterDelta(SERIES.httpRequests, (labels) => !isHarnessOverhead(labels)) ?? 0) / scrapeSpanSeconds
        : null,
    httpRequestsDelta: counterDelta(SERIES.httpRequests, (labels) => !isHarnessOverhead(labels)),
    harnessRequestsDelta: counterDelta(SERIES.httpRequests, isHarnessOverhead),
    apiErrors,
    rateLimitLimited: rateLimited,
    rateLimitBanned: rateBanned,
    cpuSecondsDelta,
    // CPU seconds per wall second, so 1.0 is one core. Same scrape-span denominator as above.
    cpuCores: cpuSecondsDelta !== null && scrapeSpanSeconds > 0 ? cpuSecondsDelta / scrapeSpanSeconds : null,
    residentMemoryPeakBytes: gaugePeak(SERIES.residentMemory),
    heapUsedPeakBytes: gaugePeak(SERIES.heapUsed),
    eventLoopP99PeakMs: scaleOrNull(gaugePeak(SERIES.eventLoopP99), 1000),
    eventLoopMeanPeakMs: scaleOrNull(gaugePeak(SERIES.eventLoopMean), 1000),
    eventLoopMaxPeakMs: scaleOrNull(gaugePeak(SERIES.eventLoopMax), 1000),
    dbPoolMax: sampleValue(last, SERIES.dbPoolMax),
    dbProbeCount: dbProbe === null ? null : dbProbe.count,
    dbProbeMeanMs: dbProbe === null || dbProbe.count <= 0 ? null : (dbProbe.sum / dbProbe.count) * 1000,
    dbProbeP99BoundMs: scaleOrNull(histogramBoundAtQuantile(dbProbe, 0.99), 1000),
    /** `JSON.stringify(Infinity)` is `null`, so the JSON needs this boolean to keep the distinction. */
    dbProbeP99AboveTopBound: histogramBoundAtQuantile(dbProbe, 0.99) === Number.POSITIVE_INFINITY,
    readinessState: sampleValue(last, SERIES.readinessState),
    websocketConnectionsPeak: gaugePeak(SERIES.wsConnections),
    workerPoolBusyPeak: gaugePeak(SERIES.workerPoolBusy),
    workerPoolQueuedPeak: gaugePeak(SERIES.workerPoolQueued),
    handsStartedDelta: counterDelta(SERIES.handsStarted),
    handsCompletedDelta: counterDelta(SERIES.handsCompleted),
    missing: [...missing].sort(),
  };
}

const scaleOrNull = (value, factor) => (value === null ? null : value * factor);

class Client {
  constructor({ session, roomId, seat, options, metrics, random, hooks }) {
    this.session = session;
    this.roomId = roomId;
    this.seat = seat;
    this.options = options;
    this.metrics = metrics;
    this.random = random;
    this.hooks = hooks;

    this.socket = null;
    this.welcomed = false;
    this.welcomeFrame = null;
    this.welcomeSeat = null;
    this.sat = false;
    this.stopped = false;
    /** requestId -> { sentAt, kind }, for round-trip measurement. */
    this.pending = new Map();
    /**
     * `handId:actionSequence`. The sequence restarts at zero every hand, so without the hand id the
     * first decision of the next hand reads as already acted and the seat never acts.
     */
    this.lastActedKey = null;
    this.lastView = null;
    this.handsSeen = 0;
    this.currentHandId = null;
    this.lastCoachAt = 0;
    this.coachedHandId = null;
    this.reconnectedHandId = null;
    this.reconnecting = false;
    this.stateWaiters = [];
    /**
     * The latest `state` frame since this socket's `welcome`. Both can be dispatched in one tick
     * before `connect()` resumes, so a waiter registered afterwards would miss the frame.
     */
    this.stateSinceWelcome = null;
  }

  wsUrl() {
    const url = new URL(this.options.wsPath, this.options.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  /**
   * `purpose` keeps first connects and resumes in separate latency buckets, because they are
   * different server paths.
   */
  connect(purpose) {
    const startedAt = performance.now();
    if (purpose === 'reconnect') this.metrics.reconnectsAttempted += 1;
    else this.metrics.connectionsAttempted += 1;

    return new Promise((resolve, reject) => {
      let settled = false;
      // The options bag is the second argument (see the header). A wrong Origin closes with 4406.
      const socket = new WebSocket(this.wsUrl(), {
        headers: { cookie: this.session.cookieHeader(), origin: this.options.origin },
      });
      this.socket = socket;

      const fail = (reason, code) => {
        if (settled) return;
        settled = true;
        this.metrics.error(code);
        reject(new Error(reason));
      };

      socket.addEventListener('open', () => {
        this.metrics.socketOpened();
        // `hello` must arrive within WS_LIMITS.handshakeTimeoutMs or the server closes with 4408.
        this.send({
          type: 'hello',
          protocolVersion: WS_PROTOCOL_VERSION,
          roomId: this.roomId,
          clientNonce: randomUUID(),
        });
      });

      socket.addEventListener('message', (message) => {
        // A frame from a socket this client already replaced must not be credited to the resume.
        if (this.socket !== socket) return;
        this.metrics.serverMessages += 1;
        let frame;
        try {
          frame = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data));
        } catch {
          this.metrics.error('transport:unparseable-frame');
          return;
        }
        if (!settled && frame.type === 'welcome') {
          settled = true;
          const elapsed = performance.now() - startedAt;
          if (purpose === 'reconnect') {
            this.metrics.reconnectsEstablished += 1;
            this.metrics.latencies.reconnect.push(elapsed);
          } else {
            this.metrics.connectionsEstablished += 1;
            this.metrics.latencies.connect.push(elapsed);
          }
          this.welcomeFrame = frame;
        }
        this.handle(frame);
        if (settled && frame.type === 'welcome') resolve(frame);
      });

      socket.addEventListener('error', () => {
        // The error event carries no detail by design. The close frame has the reason.
        fail('websocket error before welcome', 'transport:ws-error');
      });

      socket.addEventListener('close', (event) => {
        if (this.socket === socket) this.metrics.socketClosed();
        if (event.code !== 1000 && event.code !== 1005) {
          this.metrics.error(`transport:close-${event.code}`);
        }
        // 4401 before welcome almost always means the cookie did not reach the upgrade.
        if (!settled && event.code === 4401) {
          fail(
            'closed 4401 (unauthenticated) before welcome — the session cookie did not reach the ' +
              'upgrade request. Node must support the non-standard WebSocket options bag; see the ' +
              'header of this script.',
            'transport:close-4401',
          );
          return;
        }
        fail(`closed before welcome with code ${event.code}`, `transport:close-${event.code}`);
      });
    });
  }

  send(message) {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  handle(frame) {
    switch (frame.type) {
      case 'welcome':
        this.welcomed = true;
        this.welcomeSeat = frame.seat ?? null;
        this.welcomeFrame = frame;
        // Cleared per socket here, so the frames decide, not promise timing.
        this.stateSinceWelcome = null;
        return;
      case 'state':
        this.stateSinceWelcome = frame;
        // Waiters first, so the reconnect check sees the frame before `onState` acts on it.
        for (const resolve of this.stateWaiters.splice(0)) resolve(frame);
        this.onState(frame);
        return;
      case 'ack':
        this.onAck(frame);
        return;
      case 'coach':
        this.onCoach(frame);
        return;
      case 'event':
        this.onEvent(frame.event);
        return;
      case 'error': {
        const code = frame.error?.code ?? 'unknown';
        this.metrics.error(code);
        if (frame.requestId) this.pending.delete(frame.requestId);
        return;
      }
      case 'pong':
        return;
      default:
        this.metrics.error(`transport:unknown-frame-${String(frame.type)}`);
    }
  }

  onEvent(event) {
    if (event?.kind === 'seatTimedOut') this.metrics.seatTimeouts += 1;
    if (event?.kind === 'handComplete') this.hooks.onHandComplete(this);
  }

  onAck(frame) {
    const waiting = this.pending.get(frame.requestId);
    if (waiting === undefined) return;
    this.pending.delete(frame.requestId);
    if (waiting.kind === 'action') {
      this.metrics.latencies.action.push(performance.now() - waiting.sentAt);
      // A deduplicated ack applied nothing new.
      if (frame.deduplicated !== true) this.metrics.actionsApplied += 1;
    }
    if (waiting.kind === 'sit') {
      this.sat = true;
      this.metrics.seated += 1;
    }
  }

  onCoach(frame) {
    const waiting = this.pending.get(frame.requestId);
    if (waiting === undefined) return;
    this.pending.delete(frame.requestId);
    this.metrics.latencies.coach.push(performance.now() - waiting.sentAt);
    this.metrics.coachAnswered += 1;
  }

  sit() {
    const requestId = randomUUID();
    this.pending.set(requestId, { sentAt: performance.now(), kind: 'sit' });
    return this.send({ type: 'sit', seat: this.seat, requestId });
  }

  startHand() {
    const requestId = randomUUID();
    this.pending.set(requestId, { sentAt: performance.now(), kind: 'startHand' });
    return this.send({ type: 'startHand', requestId });
  }

  /** `view.legalActions` is empty whenever it is not this seat's decision. */
  onState(frame) {
    const view = frame.view;
    if (view === null || view === undefined) return;
    this.lastView = view;
    if (view.handId !== this.currentHandId) {
      this.currentHandId = view.handId;
      this.handsSeen += 1;
    }
    if (this.stopped || this.reconnecting) return;

    const legal = Array.isArray(view.legalActions) ? view.legalActions : [];
    if (legal.length === 0) return;
    if (view.toAct === null || view.toAct !== view.viewerSeat) return;

    // The same decision point can arrive twice, and acting twice earns `stale_action_sequence`.
    const key = `${String(view.handId)}:${view.actionSequence}`;
    if (key === this.lastActedKey) return;

    this.maybeRequestCoach(view);

    // Disconnect on this seat's own decision, the case where the turn clock runs against a resume.
    if (this.shouldReconnect(view)) {
      this.reconnectedHandId = view.handId;
      void this.reconnectCycle();
      return;
    }

    // Claimed before the think delay, so a resent frame during the pause cannot schedule a second action.
    this.lastActedKey = key;
    const chosen = this.choose(legal);
    if (this.options.thinkMs > 0) {
      // `unref` so a pending think delay cannot hold the process open after teardown.
      setTimeout(() => this.sendAction(view, chosen), this.options.thinkMs).unref();
      return;
    }
    this.sendAction(view, chosen);
  }

  /** Split from `onState` so `--think` delays the send, never the measured round trip. */
  sendAction(view, chosen) {
    if (this.stopped || this.socket === null) return;
    const requestId = randomUUID();
    this.pending.set(requestId, { sentAt: performance.now(), kind: 'action' });
    this.metrics.actionsSent += 1;
    this.send({
      type: 'action',
      actionId: randomUUID(),
      expectedSequence: view.actionSequence,
      action: chosen,
      requestId,
    });
  }

  maybeRequestCoach(view) {
    if (!this.options.coach) return;
    if (this.coachedHandId === view.handId) return;
    const now = Date.now();
    if (now - this.lastCoachAt < COACH_MIN_INTERVAL_MS) return;
    this.lastCoachAt = now;
    this.coachedHandId = view.handId;
    const requestId = randomUUID();
    this.pending.set(requestId, { sentAt: performance.now(), kind: 'coach' });
    this.metrics.coachRequested += 1;
    this.send({ type: 'requestCoach', requestId });
  }

  shouldReconnect(view) {
    if (!this.options.reconnect) return false;
    if (this.reconnectedHandId === view.handId) return false;
    return this.handsSeen % this.options.reconnectEvery === 0;
  }

  /**
   * Drops the socket mid-hand and resumes on a fresh one. There is no catch-up protocol, so `hello`
   * returns `welcome` plus the current view, which must be the same hand, cards and seat with a
   * sequence that has not gone back. Any failure fails the whole run.
   */
  async reconnectCycle() {
    this.reconnecting = true;
    const before = snapshotOfView(this.lastView);
    try {
      await this.closeAndWait();
      const welcome = await this.connect('reconnect');
      const frame = await this.awaitState(5_000);
      const problems = compareAfterResume(before, snapshotOfView(frame?.view ?? null), welcome, this.roomId);
      if (problems.length === 0) {
        this.metrics.reconnectsConsistent += 1;
      } else if (problems.every((problem) => problem.kind === 'hand-advanced')) {
        // Not a failure. The hand can finish while this seat is away. Counted separately.
        this.metrics.reconnectsConsistent += 1;
        this.metrics.reconnectsHandAdvanced += 1;
      } else {
        for (const problem of problems) {
          if (problem.kind === 'hand-advanced') continue;
          this.metrics.error(`consistency:${problem.kind}`);
          this.metrics.consistencyFailures.push(problem.detail);
        }
      }
      this.reconnecting = false;
      // Nothing re-sends a decision point while the table waits for this seat, so act on it here.
      // `stateSinceWelcome` may be newer than `frame`.
      const resume = this.stateSinceWelcome ?? frame;
      if (resume !== null) this.onState(resume);
    } catch (error) {
      this.reconnecting = false;
      this.metrics.error('transport:reconnect-failed');
      this.hooks.onProblem(`seat ${this.seat} could not resume: ${error.message}`);
    }
  }

  /** Answers at once when a state frame already arrived since `welcome`. See `stateSinceWelcome`. */
  awaitState(timeoutMs) {
    if (this.stateSinceWelcome !== null) return Promise.resolve(this.stateSinceWelcome);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = this.stateWaiters.indexOf(wrapped);
        if (at >= 0) this.stateWaiters.splice(at, 1);
        resolve(null);
      }, timeoutMs);
      const wrapped = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.stateWaiters.push(wrapped);
    });
  }

  /**
   * Waits for the close, because `WS_LIMITS.maxSocketsPerSession` is 4 and overlapping sockets would
   * drift into 4429 closes.
   */
  closeAndWait(timeoutMs = 2_000) {
    const socket = this.socket;
    if (socket === null) return Promise.resolve();
    this.socket = null;
    if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.metrics.socketClosed();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'load harness reconnect');
      }
    });
  }

  /**
   * Picks an offered legal action, biased hard towards passive play so hands reach postflop, with a
   * little aggression to exercise betting and side pots. Never folds when checking is free. A bet or
   * raise is `minTo` clamped into `[minTo, maxTo]`.
   */
  choose(legal) {
    const byType = new Map(legal.map((action) => [action.type, action]));
    const roll = this.random();

    const aggressive = byType.get('raise') ?? byType.get('bet');
    if (aggressive !== undefined && roll < 0.15) {
      const min = Number(aggressive.minTo);
      const max = Number(aggressive.maxTo);
      if (Number.isFinite(min)) {
        const to = Number.isFinite(max) ? Math.min(min, max) : min;
        return { type: aggressive.type, to };
      }
    }

    const check = byType.get('check');
    if (check !== undefined) return { type: 'check' };

    const call = byType.get('call');
    if (call !== undefined && roll < 0.9) return { type: 'call' };

    const fold = byType.get('fold');
    if (fold !== undefined) return { type: 'fold' };

    // Fall back to the first offered action and its own minimum.
    const first = legal[0];
    if (first.type === 'bet' || first.type === 'raise') {
      return { type: first.type, to: Number(first.minTo) };
    }
    return { type: first.type };
  }

  close() {
    this.stopped = true;
    const socket = this.socket;
    if (socket === null) return;
    this.socket = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      this.metrics.socketClosed();
      socket.close(1000, 'load test complete');
    }
  }
}

/**
 * Only identity (hand, seat, cards) and monotonic fields (sequence, pot). The other seats change the
 * rest of the view legitimately while this one is away.
 */
export function snapshotOfView(view) {
  if (view === null || view === undefined) return null;
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const own = seats.find((seat) => seat.isSelf === true) ?? null;
  return {
    handId: view.handId ?? null,
    roomId: view.roomId ?? null,
    viewerSeat: view.viewerSeat ?? null,
    actionSequence: typeof view.actionSequence === 'number' ? view.actionSequence : null,
    potTotal: typeof view.potTotal === 'number' ? view.potTotal : null,
    street: view.street ?? null,
    holeCards: own?.holeCards === undefined || own?.holeCards === null ? null : [...own.holeCards].join(''),
  };
}

/**
 * Problems after a resume, each with a `kind` so "the hand finished" is distinct from "wrong cards".
 * Pure so tests can prove it fires.
 */
export function compareAfterResume(before, after, welcome, expectedRoomId) {
  const problems = [];
  if (before === null) return problems;
  if (welcome?.room?.id !== undefined && welcome.room.id !== expectedRoomId) {
    problems.push({
      kind: 'wrong-room',
      detail: `resumed into room ${welcome.room.id}, expected ${expectedRoomId}`,
    });
  }
  if (after === null) {
    // No live hand after the resume: the hand finished and the next is not dealt yet. Benign.
    problems.push({ kind: 'hand-advanced', detail: 'no hand was live after the resume' });
    return problems;
  }
  if (after.handId !== before.handId) {
    problems.push({
      kind: 'hand-advanced',
      detail: `hand ${before.handId} became ${after.handId} while the socket was down`,
    });
    return problems;
  }
  if (after.viewerSeat !== before.viewerSeat) {
    problems.push({
      kind: 'seat-changed',
      detail: `seat ${String(before.viewerSeat)} became ${String(after.viewerSeat)} on resume`,
    });
  }
  if (after.holeCards !== before.holeCards) {
    problems.push({
      kind: 'hole-cards-changed',
      detail: `own hole cards changed on resume within hand ${String(before.handId)}`,
    });
  }
  if (
    before.actionSequence !== null &&
    after.actionSequence !== null &&
    after.actionSequence < before.actionSequence
  ) {
    problems.push({
      kind: 'sequence-rewound',
      detail: `action sequence went from ${before.actionSequence} back to ${after.actionSequence}`,
    });
  }
  if (before.potTotal !== null && after.potTotal !== null && after.potTotal < before.potTotal) {
    problems.push({
      kind: 'pot-shrank',
      detail: `pot went from ${before.potTotal} back to ${after.potTotal} within one hand`,
    });
  }
  return problems;
}

/**
 * Lists hands, then reads one in full, timed together. The second request carries
 * `app.expensiveRateLimit`. Failures are counted in `Session.request` and swallowed, so a 429 cannot
 * take the table down.
 */
async function openHandReview(client) {
  const now = Date.now();
  if (now - client.session.lastReviewAt < REVIEW_MIN_INTERVAL_MS) return;
  client.session.lastReviewAt = now;
  const startedAt = performance.now();
  try {
    const list = await client.session.request(`${ROUTES.hands}?limit=5`);
    const handId = list?.hands?.[0]?.id;
    if (typeof handId !== 'string') {
      client.metrics.error('review:no-archived-hand');
      return;
    }
    await client.session.request(ROUTES.hand(handId));
    client.metrics.latencies.review.push(performance.now() - startedAt);
    client.metrics.reviewsOpened += 1;
  } catch {
    // Already counted in `Session.request`.
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleepUntil(deadline) {
  return sleep(Math.max(0, deadline - Date.now()));
}

async function waitFor(predicate, deadline, what) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Only the owner (seat 0) sends `startHand`. Hands are counted from the owner's socket, because every
 * seat receives the same `handComplete`.
 */
async function runTable({ level, index, sessions, options, metrics, dealUntil, drainDeadline, onProblem }) {
  const owner = sessions[0];
  const created = await owner.request(ROUTES.rooms, {
    method: 'POST',
    body: {
      name: `Load L${level} T${index}`,
      maxSeats: options.seats,
      smallBlind: options.smallBlind,
      bigBlind: options.bigBlind,
      startingStack: options.startingStack,
      actionTimeoutSeconds: options.actionTimeoutSeconds,
    },
  });
  metrics.roomsCreated += 1;

  const roomId = created?.room?.id;
  const inviteCode = created?.inviteCode;
  if (typeof roomId !== 'string' || typeof inviteCode !== 'string') {
    throw new Error('room creation did not return { room: { id }, inviteCode }');
  }

  // The invite code is returned once and only its hash is stored, so it is carried in memory.
  for (const session of sessions.slice(1)) {
    await session.request(ROUTES.joinRoom, { method: 'POST', body: { inviteCode } });
    metrics.joins += 1;
  }

  let handsCompleted = 0;
  let settleTable;
  const tableDone = new Promise((resolve) => {
    settleTable = resolve;
  });

  const clients = sessions.map(
    (session, seat) =>
      new Client({
        session,
        roomId,
        seat,
        options,
        metrics,
        // One stream per seat, so a rerun at the same concurrency makes the same decisions.
        random: mulberry32(options.seed + level * 1_000_003 + index * 1_009 + seat),
        hooks: {
          onProblem,
          onHandComplete: (client) => {
            if (options.review && client.handsSeen % options.reviewEvery === 0) {
              void openHandReview(client);
            }
            if (client.seat !== 0) return;
            handsCompleted += 1;
            metrics.handsCompleted += 1;
            // A cap of zero means no cap.
            if (Date.now() >= dealUntil || (options.hands > 0 && handsCompleted >= options.hands)) {
              settleTable('complete');
              return;
            }
            client.startHand();
          },
        },
      }),
  );

  try {
    // Sequential, so the limiter does not see N simultaneous upgrades and failures are attributable.
    for (const client of clients) await client.connect('initial');
    for (const client of clients) client.sit();

    // Dealing before every seat is acked produces a short-handed hand.
    await waitFor(() => clients.every((client) => client.sat), drainDeadline, 'all seats to be taken');

    clients[0].startHand();

    const outcome = await Promise.race([tableDone, sleepUntil(drainDeadline).then(() => 'drained')]);
    return { index, roomId, handsCompleted, outcome };
  } finally {
    for (const client of clients) client.close();
  }
}

/**
 * Setup, steady state, drain. Only the steady state is held to a threshold, because the setup burst
 * is a shape no deployment sees. A setup that cannot complete is a refusal.
 */
async function runLevel({ level, tables, allSessions, options, scraper, runDeadline, onProblem }) {
  const metrics = new LevelMetrics();
  for (const session of allSessions) session.metrics = metrics;

  const perTable = [];
  for (let table = 0; table < tables; table++) {
    perTable.push(allSessions.slice(table * options.seats, (table + 1) * options.seats));
  }

  const readings = [];
  metrics.startedAt = performance.now();
  const dealUntil = Date.now() + options.holdSeconds * 1000;
  const drainDeadline = Math.min(dealUntil + options.drainSeconds * 1000, runDeadline);

  // Baseline before any socket opens, so deltas describe this level only.
  readings.push(await scraper.scrape());

  let scraping = true;
  const scrapeLoop = (async () => {
    while (scraping && Date.now() < drainDeadline) {
      await sleep(options.scrapeSeconds * 1000);
      if (!scraping) break;
      readings.push(await scraper.scrape());
    }
  })();

  const results = await Promise.allSettled(
    perTable.map((sessions, index) =>
      runTable({ level, index, sessions, options, metrics, dealUntil, drainDeadline, onProblem }),
    ),
  );

  scraping = false;
  await scrapeLoop;
  // After the sockets close, where a leak shows.
  readings.push(await scraper.scrape());
  metrics.finishedAt = performance.now();

  const tableSummaries = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      tableSummaries.push(result.value);
      continue;
    }
    metrics.error('setup:table-failed');
    tableSummaries.push({
      index,
      handsCompleted: 0,
      outcome: `failed: ${result.reason?.message ?? 'unknown'}`,
    });
    onProblem(`level ${level} table ${index} failed: ${result.reason?.message ?? result.reason}`);
  }

  const wallSeconds = (metrics.finishedAt - metrics.startedAt) / 1000;
  return summariseLevel({ level, tables, options, metrics, tableSummaries, readings, wallSeconds });
}

/** Pure, so tests can drive the stop criteria and the renderer with a hand-built level. */
function summariseLevel({ level, tables, options, metrics, tableSummaries, readings, wallSeconds }) {
  const reconnectRate =
    metrics.reconnectsAttempted === 0 ? null : metrics.reconnectsEstablished / metrics.reconnectsAttempted;

  return {
    level,
    tables,
    seats: options.seats,
    virtualUsers: tables * options.seats,
    holdSeconds: options.holdSeconds,
    // The stop criteria read it, because "no hand completed" depends on the think time.
    thinkMs: options.thinkMs,
    wallSeconds,
    client: {
      action: summariseLatency(metrics.latencies.action),
      coach: summariseLatency(metrics.latencies.coach),
      review: summariseLatency(metrics.latencies.review),
      connect: summariseLatency(metrics.latencies.connect),
      reconnect: summariseLatency(metrics.latencies.reconnect),
      actionsSent: metrics.actionsSent,
      actionsApplied: metrics.actionsApplied,
      actionsPerSecond: wallSeconds > 0 ? metrics.actionsApplied / wallSeconds : 0,
      handsCompleted: metrics.handsCompleted,
      handsPerMinute: wallSeconds > 0 ? (metrics.handsCompleted / wallSeconds) * 60 : 0,
      coachRequested: metrics.coachRequested,
      coachAnswered: metrics.coachAnswered,
      reviewsOpened: metrics.reviewsOpened,
      serverMessages: metrics.serverMessages,
      seatTimeouts: metrics.seatTimeouts,
      socketsOpenPeak: metrics.socketsOpenPeak,
      connectionsAttempted: metrics.connectionsAttempted,
      connectionsEstablished: metrics.connectionsEstablished,
      reconnectsAttempted: metrics.reconnectsAttempted,
      reconnectsEstablished: metrics.reconnectsEstablished,
      reconnectsConsistent: metrics.reconnectsConsistent,
      reconnectsHandAdvanced: metrics.reconnectsHandAdvanced,
      reconnectRate,
      errors: Object.fromEntries([...metrics.errors].sort((a, b) => b[1] - a[1])),
      errorCount: metrics.errorCount,
      errorRate: metrics.errorRate,
      errorRateDenominator: metrics.operationCount + metrics.errorCount,
      consistencyFailures: [...metrics.consistencyFailures],
    },
    server: summariseServerSide(readings),
    // Not `tables`, which is the count.
    tableOutcomes: tableSummaries.map((table) => ({
      index: table.index,
      handsCompleted: table.handsCompleted,
      outcome: table.outcome,
    })),
  };
}

/**
 * Rough think time one hand costs: four rounds, about one decision per seat per round. Crude on
 * purpose. It only answers whether a hand could finish inside the hold.
 */
export function thinkTimePerHandMs(level) {
  const think = level.thinkMs ?? 0;
  return think === 0 ? 0 : level.seats * think * 4;
}

/** Explains "no hand completed" when the hold was too short for the think time. */
function describeHandBudget(level) {
  const budgetMs = thinkTimePerHandMs(level);
  if (budgetMs === 0 || budgetMs <= level.holdSeconds * 1000) return '';
  return (
    `. At --think ${level.thinkMs}ms with ${level.seats} seats a hand needs roughly ` +
    `${(budgetMs / 1000).toFixed(0)}s of think time alone and the hold was ${level.holdSeconds}s, ` +
    'so this is very likely the hold rather than the server'
  );
}

/**
 * Whether this level crossed a stated failure criterion, and which. Each criterion returns the
 * observed value beside its limit. Consistency has no threshold, because a resume to the wrong state
 * is never an acceptable trade.
 */
export function evaluateStopCriteria(level, thresholds) {
  const breaches = [];
  const client = level.client;

  if (client.consistencyFailures.length > 0) {
    breaches.push({
      criterion: 'reconnect-consistency',
      observed: client.consistencyFailures.length,
      limit: 0,
      detail: `resumed clients disagreed with the server ${client.consistencyFailures.length} time(s): ${client.consistencyFailures[0]}`,
    });
  }
  if (client.errorRate > thresholds.maxErrorRate) {
    breaches.push({
      criterion: 'error-rate',
      observed: client.errorRate,
      limit: thresholds.maxErrorRate,
      detail: `${(client.errorRate * 100).toFixed(2)}% of ${client.errorRateDenominator} operations failed`,
    });
  }
  if (client.action.p95Ms !== null && client.action.p95Ms > thresholds.maxP95Ms) {
    breaches.push({
      criterion: 'latency-p95',
      observed: client.action.p95Ms,
      limit: thresholds.maxP95Ms,
      detail: `action p95 ${client.action.p95Ms.toFixed(1)}ms over ${thresholds.maxP95Ms}ms`,
    });
  }
  if (client.action.p99Ms !== null && client.action.p99Ms > thresholds.maxP99Ms) {
    breaches.push({
      criterion: 'latency-p99',
      observed: client.action.p99Ms,
      limit: thresholds.maxP99Ms,
      detail: `action p99 ${client.action.p99Ms.toFixed(1)}ms over ${thresholds.maxP99Ms}ms`,
    });
  }
  if (client.reconnectRate !== null && client.reconnectRate < thresholds.minReconnectRate) {
    breaches.push({
      criterion: 'reconnect-rate',
      observed: client.reconnectRate,
      limit: thresholds.minReconnectRate,
      detail: `${client.reconnectsEstablished} of ${client.reconnectsAttempted} reconnects resumed`,
    });
  }
  if (client.connectionsEstablished < client.connectionsAttempted) {
    breaches.push({
      criterion: 'refusal-connect',
      observed: client.connectionsAttempted - client.connectionsEstablished,
      limit: 0,
      detail: `${client.connectionsAttempted - client.connectionsEstablished} of ${client.connectionsAttempted} sockets never reached welcome`,
    });
  }
  /**
   * No usable server-side half. Without this the level passed on client timings alone and became the
   * capacity figure (reproduced through `buildReport` with `scrapeFailures: 5`). The preflight only
   * covers the first scrape, and a level with no scrapes cannot see a rate-limit refusal.
   */
  if (level.server.usable !== true) {
    breaches.push({
      criterion: 'server-side-blind',
      observed: level.server.scrapes ?? 0,
      limit: 2,
      detail:
        `${level.server.scrapes ?? 0} usable /metrics scrape(s) at this level ` +
        `(${level.server.scrapeFailures ?? 0} failed), so no server-side criterion could be ` +
        'evaluated — including the rate-limit refusal count, which is what tells a limiter-bound ' +
        `ramp from a saturated machine${level.server.note == null ? '' : `. ${level.server.note}`}`,
    });
  }
  if (level.server.usable === true && level.server.rateLimitLimited > 0) {
    breaches.push({
      criterion: 'refusal-rate-limited',
      observed: level.server.rateLimitLimited,
      limit: 0,
      detail: `the server returned ${level.server.rateLimitLimited} rate-limit refusal(s) during this level`,
    });
  }
  if (client.handsCompleted === 0) {
    breaches.push({
      criterion: 'no-progress',
      observed: 0,
      limit: 1,
      detail: `no hand completed at this level, so nothing here is a measurement of play${describeHandBudget(level)}`,
    });
  }
  return { stop: breaches.length > 0, breaches };
}

/**
 * Names the resource that ran out, reporting every signal whether it fired or not. A signal that is
 * not exported never fires. The first firing signal is named, so order matters. Event-loop delay is
 * first because every socket, timer and turn clock shares that thread.
 */
export function classifySaturation(level, thresholds) {
  const server = level.server;
  const exported = (value) => value !== null && value !== undefined;

  const signals = [
    {
      name: 'event-loop',
      metric: SERIES.eventLoopP99,
      observed: server.eventLoopP99PeakMs ?? null,
      limit: thresholds.eventLoopP99Ms,
      unit: 'ms',
      fired: exported(server.eventLoopP99PeakMs) && server.eventLoopP99PeakMs >= thresholds.eventLoopP99Ms,
      meaning: 'the process could not get back to the event loop; requests queue behind CPU work',
    },
    {
      name: 'cpu',
      metric: SERIES.cpuSeconds,
      observed: server.cpuCores ?? null,
      limit: thresholds.cpuCores,
      unit: 'cores',
      fired: exported(server.cpuCores) && server.cpuCores >= thresholds.cpuCores,
      meaning: 'the process is consuming most of a core; one Node process has only one to give',
    },
    {
      name: 'worker-pool',
      metric: SERIES.workerPoolQueued,
      observed: server.workerPoolQueuedPeak ?? null,
      limit: 1,
      unit: 'tasks queued',
      fired: exported(server.workerPoolQueuedPeak) && server.workerPoolQueuedPeak >= 1,
      meaning: 'analysis work waited for a worker thread',
    },
    {
      name: 'db-pool',
      metric: SERIES.dbProbe,
      observed: server.dbProbeP99BoundMs ?? null,
      limit: thresholds.dbProbeP99Ms,
      unit: 'ms',
      /**
       * Strictly greater, because the value is a bucket bound. `>=` fired on every p99 in the
       * 25-50 ms bucket and blamed `db-pool` for a three-player level at 0.4 requests per second.
       * `Infinity` exceeds every threshold.
       */
      fired: exported(server.dbProbeP99BoundMs) && server.dbProbeP99BoundMs > thresholds.dbProbeP99Ms,
      /** `JSON.stringify(Infinity)` is `null`, so the signal record needs its own boolean. */
      observedAboveTopBound: server.dbProbeP99BoundMs === Number.POSITIVE_INFINITY,
      meaning: 'select 1 waited for a pooled connection, which is pool exhaustion before any query fails',
      /**
       * The probe is timed inside the handler, so a blocked event loop also slows it. A five-second
       * `select 1` against an idle database is a blocked process, not a busy pool.
       */
      confoundedBy: 'event-loop',
    },
    {
      name: 'rate-limit',
      metric: SERIES.rateLimitEvents,
      observed: server.rateLimitLimited ?? null,
      limit: 1,
      unit: 'refusals',
      fired: exported(server.rateLimitLimited) && server.rateLimitLimited >= 1,
      meaning: 'the server refused work by policy; this is a configured ceiling, not a resource',
    },
  ].map((signal) => ({
    ...signal,
    exported: signal.observed !== null,
    fired: signal.observed === null ? false : signal.fired,
  }));

  const first = signals.find((signal) => signal.fired);
  return {
    resource: first === undefined ? 'not-identified' : first.name,
    meaning: first === undefined ? 'no exported server-side signal crossed its threshold' : first.meaning,
    signals,
  };
}

/**
 * `--server-env` and `--via-proxy` are the operator's claim and print as one. `generatorCpuSeconds`
 * is filled in at the end. If the generator burned as much CPU as the server, they shared cores.
 */
function describeEnvironment(options) {
  const target = new URL(options.baseUrl);
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  return {
    target: options.baseUrl,
    transport: target.protocol === 'https:' ? 'TLS' : 'plaintext (no TLS)',
    network: loopback ? 'loopback — no network hop, no packet loss, no RTT' : 'network path',
    generatorLocation: loopback
      ? 'same host as the server, competing with it for CPU'
      : 'a different host, or the same one behind a network address — not determinable from here',
    serverNodeEnv: `${options.serverEnv} (asserted with --server-env; a client cannot observe it)`,
    proxy: options.viaProxy
      ? 'asserted present with --via-proxy; its own limits were not measured'
      : 'none asserted; nothing here detects a transparent one',
    otherTenants: 'neither controlled nor measured by this harness',
    generator: {
      node: process.version,
      platform: `${platform()} ${arch()}`,
      logicalCpus: availableParallelism(),
      totalMemoryBytes: totalmem(),
      loadAverageAtStart: loadavg(),
    },
    generatorCpuSeconds: null,
    loadAverageAtEnd: null,
  };
}

/**
 * Pure and JSON-safe. `renderReport` is the only thing that turns it into text, so the human and
 * `--json` outputs are one object and cannot drift.
 */
export function buildReport({ options, environment, levels, thresholds, stopped, runSeconds, setup }) {
  const evaluated = levels.map((level) => {
    const verdict = evaluateStopCriteria(level, thresholds);
    return {
      ...level,
      breaches: verdict.breaches,
      passed: !verdict.stop,
      saturation: classifySaturation(level, thresholds),
    };
  });

  const passing = evaluated.filter((level) => level.passed);
  const firstFailing = evaluated.find((level) => !level.passed) ?? null;
  const highestPassing = passing.length > 0 ? passing[passing.length - 1] : null;

  const capacity =
    highestPassing === null
      ? null
      : {
          concurrentSeatedPlayers: highestPassing.virtualUsers,
          tables: highestPassing.tables,
          actionsPerSecond: highestPassing.client.actionsPerSecond,
          handsPerMinute: highestPassing.client.handsPerMinute,
          actionP50Ms: highestPassing.client.action.p50Ms,
          actionP95Ms: highestPassing.client.action.p95Ms,
          actionP99Ms: highestPassing.client.action.p99Ms,
          measuredOver: `${highestPassing.holdSeconds}s of steady state`,
          instances: 1,
          /** At `thinkMs: 0` a virtual user is a load shape, not a person. */
          virtualUserModel: {
            thinkMs: options.thinkMs,
            reconnectsEveryHands: options.reconnect ? options.reconnectEvery : null,
            reviewsEveryHands: options.review ? options.reviewEvery : null,
            requestsCoach: options.coach,
            note:
              options.thinkMs === 0
                ? 'think time 0: each virtual user acts the instant the server asks, which is the ' +
                  'most work one seat can offer and is not how a person plays. Re-run with --think ' +
                  'to model people; do not convert this figure to a population of readers by hand.'
                : `each virtual user paused ${options.thinkMs}ms before every action`,
          },
        };

  // Levels whose p99 came from too few samples. Reported, not suppressed.
  const thinTails = evaluated
    .filter((level) => level.client.action.count > 0 && level.client.action.count < MIN_SAMPLES_FOR_P99)
    .map((level) => ({ level: level.level, samples: level.client.action.count }));

  const failures = [];
  if (firstFailing !== null) {
    for (const breach of firstFailing.breaches) {
      failures.push(`level ${firstFailing.level} (${firstFailing.virtualUsers} players): ${breach.detail}`);
    }
  }
  if (stopped.reason !== null) failures.push(stopped.reason);
  if (highestPassing === null) failures.push('no level met every threshold, so there is no capacity figure');

  const consistencyFailures = evaluated.flatMap((level) =>
    level.client.consistencyFailures.map((detail) => `level ${level.level}: ${detail}`),
  );

  return {
    measuredAt: new Date().toISOString(),
    runSeconds,
    environment,
    settings: settingsFor(options),
    thresholds,
    setup,
    levels: evaluated,
    capacity,
    saturation:
      firstFailing === null
        ? {
            found: false,
            note: 'the ramp completed without crossing a stop criterion, so the saturation point is ABOVE the widest level run',
            atLevel: null,
            stoppedBy: [],
            resource: null,
            signals: highestPassing === null ? [] : highestPassing.saturation.signals,
          }
        : {
            found: true,
            note: `the ramp stopped at level ${firstFailing.level}`,
            atLevel: firstFailing.level,
            atConcurrency: firstFailing.virtualUsers,
            stoppedBy: firstFailing.breaches.map((breach) => breach.criterion),
            resource: firstFailing.saturation.resource,
            meaning: firstFailing.saturation.meaning,
            signals: firstFailing.saturation.signals,
          },
    notMeasured: NOT_MEASURED,
    thinTails,
    consistencyFailures,
    failures,
    passed: failures.length === 0,
  };
}

/** The settings block, minus the flags that describe output rather than the run. */
function settingsFor(options) {
  const out = {};
  for (const [key, value] of Object.entries(options)) {
    if (key === 'help' || key === 'json' || key === 'out') continue;
    // A credential, and reports get pasted into issues.
    if (key === 'metricsToken') {
      out.metricsToken = value === '' ? 'not set' : 'set (not shown)';
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** In the JSON as well as the footer, because the JSON is what gets pasted into planning documents. */
const NOT_MEASURED = [
  'more than one API instance: nothing here says anything about horizontal scaling',
  'a real network: over loopback there is no RTT, no loss, no reordering and no TLS handshake',
  'a production-sized database: query plans change with data volume, and these did not',
  'a reverse proxy or TLS terminator, which has connection limits of its own',
  'browser clients: these sockets do no rendering, so a browser at the same concurrency is slower',
  'sustained running: levels are tens of seconds, which cannot show a leak or cache eviction',
  'a cold start, a deploy, a failover, or a database restart under load',
];

const ms = (value) => (value === null || value === undefined ? '    -   ' : `${value.toFixed(1)}ms`);
const num = (value, digits = 1) =>
  value === null || value === undefined
    ? '   -  '
    : Number.isFinite(value)
      ? value.toFixed(digits)
      : 'above top bucket';

/** A histogram bound: `<= 50.0ms`, above the top bucket, or nothing measured. */
const boundMs = (value) =>
  value === null || value === undefined
    ? '   -  '
    : Number.isFinite(value)
      ? `<= ${value.toFixed(1)}ms`
      : 'above the top bucket';
const mib = (bytes) =>
  bytes === null || bytes === undefined ? '  -  ' : `${(bytes / 1048576).toFixed(0)}MiB`;

/** No colour, so the text a test asserts on does not depend on a TTY. */
const samplesNote = (count) => `(n=${count ?? 0})`;

/** Returns `{ tone, text }` lines, and `printReport` applies the colour. */
export function renderReport(report) {
  const lines = [];
  const plain = (text) => lines.push({ tone: 'plain', text });
  const head = (text) => lines.push({ tone: 'head', text });
  const detail = (text) => lines.push({ tone: 'dim', text });

  head('Environment');
  plain(`  target                  ${report.environment.target}`);
  plain(`  transport               ${report.environment.transport}`);
  plain(`  network                 ${report.environment.network}`);
  plain(`  load generator          ${report.environment.generatorLocation}`);
  plain(`  server NODE_ENV         ${report.environment.serverNodeEnv}`);
  plain(`  proxy                   ${report.environment.proxy}`);
  plain(`  other tenants           ${report.environment.otherTenants}`);
  plain(
    `  generator host          ${report.environment.generator.platform}, ` +
      `${report.environment.generator.logicalCpus} logical CPUs, node ${report.environment.generator.node}`,
  );
  if (report.environment.generatorCpuSeconds !== null) {
    detail(
      `  the generator itself burned ${report.environment.generatorCpuSeconds.toFixed(1)}s of CPU on this ` +
        'same machine; that is CPU the server did not have',
    );
  }

  head('Setup (excluded from every latency figure below)');
  plain(`  guest sessions          ${report.setup.sessionsCreated} provisioned up front`);
  plain(`  seconds                 ${report.setup.seconds.toFixed(2)}`);
  if (report.setup.failures.length > 0) {
    for (const failure of report.setup.failures) lines.push({ tone: 'bad', text: `  x ${failure}` });
  }

  const warmup = report.setup.warmup ?? null;
  if (warmup !== null) {
    head('Cold start');
    if (warmup.skipped === true) {
      lines.push({ tone: 'warn', text: `  ! ${warmup.note}` });
    } else {
      plain(`  first Coach analysis    ${ms(warmup.firstCoachMs)} ${samplesNote(warmup.coachSamples)}`);
      plain(`  first Hand Review       ${ms(warmup.firstReviewMs)} ${samplesNote(warmup.reviewSamples)}`);
      plain(`  event loop p99 then     ${ms(warmup.eventLoopP99Ms)}`);
      detail(`  ${warmup.note}`);
    }
  }

  head('Ramp');
  detail(
    '  rates are over each level wall clock — setup, hold and drain — not over the hold alone,' +
      ' so a level whose hands ran long reports a lower rate rather than a shorter level',
  );
  plain('  level  players  hands/min  act/s   p50      p95      p99      coach p95  review p95  errors');
  for (const level of report.levels) {
    const tone = level.passed ? 'ok' : 'bad';
    lines.push({
      tone,
      text:
        `  ${String(level.level).padStart(5)}  ${String(level.virtualUsers).padStart(7)}  ` +
        `${num(level.client.handsPerMinute).padStart(9)}  ${num(level.client.actionsPerSecond).padStart(5)}  ` +
        `${ms(level.client.action.p50Ms).padStart(8)} ${ms(level.client.action.p95Ms).padStart(8)} ` +
        `${ms(level.client.action.p99Ms).padStart(8)} ${ms(level.client.coach.p95Ms).padStart(10)} ` +
        `${ms(level.client.review.p95Ms).padStart(11)}  ${String(level.client.errorCount).padStart(6)}`,
    });
    detail(
      `         action samples ${level.client.action.count}, coach ${level.client.coach.count}, ` +
        `review ${level.client.review.count}, sockets peak ${level.client.socketsOpenPeak}, ` +
        `reconnects ${level.client.reconnectsEstablished}/${level.client.reconnectsAttempted} ` +
        `(${level.client.reconnectsHandAdvanced} resumed into a new hand)`,
    );
    if (level.server.usable) {
      detail(
        `         server: CPU ${num(level.server.cpuCores, 2)} cores, RSS ${mib(level.server.residentMemoryPeakBytes)}, ` +
          `event loop p99 ${ms(level.server.eventLoopP99PeakMs)}, db probe p99 ${boundMs(level.server.dbProbeP99BoundMs)}, ` +
          `${num(level.server.httpRequestsPerSecond)} req/s, ${level.server.scrapes} scrapes`,
      );
    } else {
      lines.push({ tone: 'warn', text: `         ! server-side: ${level.server.note}` });
    }
    if (level.server.gaugeNote != null) {
      lines.push({ tone: 'warn', text: `         ! ${level.server.gaugeNote}` });
    }
    if (level.client.seatTimeouts > 0) {
      // A seat timeout is the turn clock acting for a player, so the level was partly played by the timer.
      lines.push({
        tone: 'warn',
        text:
          `         ! ${level.client.seatTimeouts} seat timeout(s): the server acted for a seat that did not, ` +
          'so this level rate includes turn-clock waits rather than client decisions',
      });
    }
    for (const breach of level.breaches) {
      lines.push({ tone: 'bad', text: `         x ${breach.criterion}: ${breach.detail}` });
    }
  }

  head('Saturation');
  if (report.saturation.found) {
    lines.push({
      tone: 'bad',
      text:
        `  x saturated at level ${report.saturation.atLevel}, ${report.saturation.atConcurrency} seated players ` +
        `— stopped by ${report.saturation.stoppedBy.join(', ')}`,
    });
    lines.push({
      tone: 'warn',
      text: `  ! resource: ${report.saturation.resource} — ${report.saturation.meaning}`,
    });
    /** When the limiter stopped the ramp, N is a policy setting, not a capacity. */
    if (report.saturation.stoppedBy.includes('refusal-rate-limited')) {
      lines.push({
        tone: 'warn',
        text:
          '  ! the RATE LIMITER ended this ramp, so that concurrency is a configured ceiling and not ' +
          'a capacity. Raise the limits on the measured process (RATE_LIMIT_MAX, ' +
          'RATE_LIMIT_GUEST_MAX, RATE_LIMIT_EXPENSIVE_MAX) and re-run before quoting any figure ' +
          'from it, and say beside the figure that you did.',
      });
    }
  } else {
    lines.push({ tone: 'warn', text: `  ! ${report.saturation.note}` });
  }
  for (const signal of report.saturation.signals) {
    if (!signal.exported) {
      detail(`      ${signal.name.padEnd(12)} not exported by this build (${signal.metric})`);
      continue;
    }
    const mark = signal.fired ? 'FIRED ' : 'quiet ';
    // A non-finite value is the `+Inf` bucket and takes no unit.
    const observed = Number.isFinite(signal.observed)
      ? `${num(signal.observed, 2)} ${signal.unit}`
      : num(signal.observed, 2);
    detail(`      ${signal.name.padEnd(12)} ${mark} ${observed} (threshold ${signal.limit} ${signal.unit})`);
    const confounder =
      signal.confoundedBy === undefined
        ? null
        : report.saturation.signals.find((other) => other.name === signal.confoundedBy);
    if (signal.fired && confounder?.fired === true) {
      lines.push({
        tone: 'warn',
        text:
          `      ! ${signal.name} cannot be read as a ${signal.name} problem here: ${confounder.name} also ` +
          'fired, and this measurement includes time the process spent unable to reach the event loop',
      });
    }
  }

  head('Measured capacity of ONE API instance');
  if (report.capacity === null) {
    lines.push({ tone: 'bad', text: '  x no level met every threshold, so there is no capacity figure' });
  } else {
    lines.push({
      tone: 'ok',
      text:
        `  ${report.capacity.concurrentSeatedPlayers} concurrent seated players across ` +
        `${report.capacity.tables} table(s), sustaining ${num(report.capacity.handsPerMinute)} hands/minute ` +
        `and ${num(report.capacity.actionsPerSecond)} actions/second`,
    });
    lines.push({
      tone: 'ok',
      text: `  at action p50 ${ms(report.capacity.actionP50Ms)}, p95 ${ms(report.capacity.actionP95Ms)}, p99 ${ms(report.capacity.actionP99Ms)}`,
    });
    detail(`  measured over ${report.capacity.measuredOver}, on ${report.capacity.instances} instance`);
    detail('  in the environment printed above, and nowhere else');
    const model = report.capacity.virtualUserModel;
    plain(
      `  one "player" here = think time ${model.thinkMs}ms, ` +
        `${model.requestsCoach ? 'asks Coach in-hand, ' : 'never asks Coach, '}` +
        `${model.reconnectsEveryHands === null ? 'never reconnects, ' : `reconnects every ${model.reconnectsEveryHands} hand(s), `}` +
        `${model.reviewsEveryHands === null ? 'never opens Hand Review' : `opens Hand Review every ${model.reviewsEveryHands} hand(s)`}`,
    );
    lines.push({ tone: 'warn', text: `  ! ${model.note}` });
  }

  if (report.thinTails.length > 0) {
    head('Percentiles that are not percentiles');
    for (const thin of report.thinTails) {
      lines.push({
        tone: 'warn',
        text:
          `  ! level ${thin.level} produced ${thin.samples} action samples; below ${MIN_SAMPLES_FOR_P99} the ` +
          'p99 is the maximum wearing a percentile name',
      });
    }
  }

  head('What this did NOT measure');
  for (const item of report.notMeasured) detail(`  - ${item}`);

  head('Summary');
  plain(`  levels run              ${report.levels.length}`);
  plain(`  levels passing          ${report.levels.filter((level) => level.passed).length}`);
  plain(`  wall clock              ${report.runSeconds.toFixed(1)}s`);
  plain(`  reconnect consistency   ${report.consistencyFailures.length} failure(s)`);

  if (report.passed) {
    lines.push({ tone: 'ok', text: 'PASS' });
  } else {
    lines.push({ tone: 'bad', text: 'FAIL' });
    for (const failure of report.failures) lines.push({ tone: 'bad', text: `  - ${failure}` });
  }

  lines.push({
    tone: 'warn',
    text:
      'CAVEAT: every figure above describes ONE API process in the environment printed at the top. ' +
      'Over loopback the generator and the server share a machine, so both the latency and the CPU ' +
      'figures include that contention. Nothing here is a production capacity number, and nothing ' +
      'here may be multiplied out to a user count that was not actually run.',
  });
  return lines;
}

const TONES = {
  plain: (text) => text,
  head: (text) => `\n${bold(text)}`,
  dim: (text) => dim(text),
  ok: (text) => green(text),
  bad: (text) => red(text),
  warn: (text) => yellow(text),
};

function printReport(report) {
  for (const line of renderReport(report)) console.log(TONES[line.tone](line.text));
  console.log('');
}

/**
 * Clears the rate-limit counters before provisioning, when this process holds the token. CI runs
 * `test:smoke` first, whose section 12 drains the guest bucket. The route exists only with `RATE_LIMIT_RESET_TOKEN`, which production
 * refuses.
 *
 * Returns the number cleared, null with no token, or throws when the server refuses the token or the
 * route.
 */
export async function resetRateLimits(baseUrl, origin, token) {
  if (token === '') return null;
  const headers = { accept: 'application/json', origin };
  const seed = await fetch(new URL(ROUTES.session, baseUrl), { headers });
  const cookie = seed.headers
    .getSetCookie()
    .map((raw) => raw.split(';', 1)[0])
    .join('; ');
  const csrfToken = (await seed.json())?.csrfToken;
  if (typeof csrfToken !== 'string') throw new Error(`no CSRF token from GET ${ROUTES.session}`);
  const response = await fetch(new URL(RATE_LIMIT_RESET_PATH, baseUrl), {
    method: 'POST',
    headers: { ...headers, cookie, 'x-csrf-token': csrfToken, authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(`POST ${RATE_LIMIT_RESET_PATH} answered ${response.status} ${text.slice(0, 160)}`);
  }
  return JSON.parse(text).cleared;
}

/**
 * Creates every guest session the widest level needs, once and sequentially. Per-level or parallel
 * creation would hit the address-keyed `RATE_LIMIT_GUEST_MAX` mid-ramp.
 */
async function provisionSessions(count, options, metrics) {
  const sessions = [];
  const failures = [];
  for (let index = 0; index < count; index++) {
    const session = new Session(options.baseUrl, options.origin, `Load user ${index + 1}`, metrics);
    try {
      sessions.push(await session.createGuest());
    } catch (error) {
      failures.push(`guest ${index + 1} of ${count}: ${error.message}`);
      break;
    }
  }
  return { sessions, failures };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`load-test — ${err.message}`));
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  const startedAt = performance.now();
  const environment = describeEnvironment(options);
  const widest = options.levels[options.levels.length - 1];
  const maxVirtualUsers = widest * options.seats;

  console.log(bold('\nPoker Risk Lab load and capacity harness'));
  console.log(
    yellow('  Measures ONE API instance in ONE environment. Read the Environment block before quoting.'),
  );
  console.log(bold('\nPlanned run'));
  console.log(`  ${'levels (tables)'.padEnd(24)} ${options.levels.join(', ')}`);
  console.log(`  ${'seats per table'.padEnd(24)} ${options.seats}`);
  console.log(`  ${'widest concurrency'.padEnd(24)} ${maxVirtualUsers} seated players`);
  console.log(
    `  ${'hold per level'.padEnd(24)} ${options.holdSeconds}s (+ up to ${options.drainSeconds}s drain)`,
  );
  console.log(`  ${'scrape interval'.padEnd(24)} ${options.scrapeSeconds}s`);
  console.log(
    `  ${'journey'.padEnd(24)} sit, play, ${options.coach ? 'coach, ' : 'no coach, '}` +
      `${options.reconnect ? `reconnect every ${options.reconnectEvery} hand(s), ` : 'no reconnect, '}` +
      `${options.review ? `review every ${options.reviewEvery} hand(s)` : 'no review'}`,
  );
  console.log(
    `  ${'think time'.padEnd(24)} ${options.thinkMs}ms` +
      (options.thinkMs === 0 ? dim('  (a virtual user at 0 is not a person; see --help)') : ''),
  );
  // Warn before the run when a hand needs more think time than the hold allows.
  const handThinkMs = thinkTimePerHandMs({ thinkMs: options.thinkMs, seats: options.seats });
  if (handThinkMs > options.holdSeconds * 1000) {
    console.log(
      yellow(
        `  ! a hand at --think ${options.thinkMs}ms with ${options.seats} seats needs roughly ` +
          `${(handThinkMs / 1000).toFixed(0)}s of think time alone, which is longer than the ` +
          `${options.holdSeconds}s hold. Raise --hold or no level will complete a hand.`,
      ),
    );
  }

  const probeMetrics = new LevelMetrics();
  try {
    const probe = new Session(options.baseUrl, options.origin, 'probe', probeMetrics);
    const health = await probe.request(ROUTES.health);
    console.log(dim(`\n  health   ${health?.status ?? 'unknown'}  version ${health?.version ?? 'unknown'}`));
  } catch (err) {
    console.error(red(`\n  x cannot reach the API at ${options.baseUrl}${ROUTES.health}`));
    console.error(dim(`      ${err.message}`));
    console.error(dim('      start it with `pnpm run dev` or `docker compose up api`\n'));
    process.exit(1);
  }

  const scraper = new MetricsScraper({
    baseUrl: options.baseUrl,
    metricsPath: options.metricsPath,
    readyPath: ROUTES.ready,
    token: options.metricsToken,
    origin: options.origin,
  });

  // A refused or unreachable /metrics is a hard failure, not a warning.
  const firstScrape = await scraper.scrape();
  if (!firstScrape.ok) {
    console.error(red(`\n  x cannot scrape ${options.baseUrl}${options.metricsPath}: ${firstScrape.reason}`));
    console.error(
      dim(
        '      Every server-side number in this report comes from there, so the run is refused rather\n' +
          '      than degraded. In production the route is not registered at all unless METRICS_TOKEN is\n' +
          '      set; elsewhere it is open. Pass --metrics-token, or set METRICS_TOKEN in the environment.\n',
      ),
    );
    process.exit(1);
  }
  console.log(
    dim(
      `  metrics  ${firstScrape.snapshot.samples.length} series read from ${options.metricsPath}` +
        `${firstScrape.snapshot.malformed.length > 0 ? `, ${firstScrape.snapshot.malformed.length} unparseable line(s)` : ''}`,
    ),
  );

  const resetToken = process.env.PRL_RATE_LIMIT_RESET_TOKEN ?? process.env.RATE_LIMIT_RESET_TOKEN ?? '';
  try {
    const cleared = await resetRateLimits(options.baseUrl, options.origin, resetToken);
    if (cleared !== null)
      console.log(dim(`  reset    ${cleared} rate-limit counter(s) cleared before provisioning`));
  } catch (error) {
    console.error(red(`\n  x the rate-limit reset failed: ${error.message}`));
    process.exit(1);
  }

  const setupMetrics = new LevelMetrics();
  const setupStartedAt = performance.now();
  const { sessions, failures: setupFailures } = await provisionSessions(
    maxVirtualUsers,
    options,
    setupMetrics,
  );
  const setup = {
    sessionsRequested: maxVirtualUsers,
    sessionsCreated: sessions.length,
    seconds: (performance.now() - setupStartedAt) / 1000,
    failures: setupFailures,
    errors: Object.fromEntries(setupMetrics.errors),
  };

  if (sessions.length < maxVirtualUsers) {
    console.error(red(`\n  x only ${sessions.length} of ${maxVirtualUsers} guest sessions could be created`));
    for (const failure of setupFailures) console.error(dim(`      ${failure}`));
    if (setupMetrics.errors.has('rate_limited')) {
      console.error(
        yellow(
          '\n  The API rate-limited guest creation. That is the server behaving correctly, not a defect:\n' +
            '  every seat is its own guest session, and RATE_LIMIT_GUEST_MAX is address-keyed and low by\n' +
            `  design. Re-run the API with RATE_LIMIT_GUEST_MAX at or above ${maxVirtualUsers} for this ramp,\n` +
            '  or narrow --ramp / --seats. Whichever you choose, say so beside any number you quote.\n',
        ),
      );
    }
    process.exit(1);
  }

  const thresholds = {
    maxErrorRate: options.maxErrorRate,
    maxP95Ms: options.maxP95Ms,
    maxP99Ms: options.maxP99Ms,
    minReconnectRate: options.minReconnectRate,
    eventLoopP99Ms: options.eventLoopP99Ms,
    cpuCores: options.cpuCores,
    dbProbeP99Ms: options.dbProbeP99Ms,
  };

  const runDeadline = Date.now() + options.timeoutSeconds * 1000;
  const problems = [];
  const onProblem = (message) => {
    problems.push(message);
    console.error(red(`  x ${message}`));
  };

  // The cold-start figure, kept out of the ramp. See `warmupSeconds`.
  if (options.warmup) {
    console.log(
      bold('\nWarm-up') +
        dim('  one table, one hand, one Coach analysis, one Hand Review — excluded from the ramp'),
    );
    const warmupLevel = await runLevel({
      level: 0,
      tables: 1,
      allSessions: sessions.slice(0, options.seats),
      options: { ...options, holdSeconds: options.warmupSeconds, hands: 1, reconnect: false, reviewEvery: 1 },
      scraper,
      runDeadline,
      onProblem,
    });
    setup.warmup = {
      handsCompleted: warmupLevel.client.handsCompleted,
      firstCoachMs: warmupLevel.client.coach.maxMs,
      coachSamples: warmupLevel.client.coach.count,
      firstReviewMs: warmupLevel.client.review.maxMs,
      reviewSamples: warmupLevel.client.review.count,
      eventLoopP99Ms: warmupLevel.server.usable ? warmupLevel.server.eventLoopP99PeakMs : null,
      note:
        'a cold process, measured once. The first Coach analysis runs a Monte Carlo on the main ' +
        'thread, so its cost is also the event loop being blocked for that long. The ramp below ' +
        'measures a WARM process; --skip-warmup measures the cold one instead.',
    };
    console.log(
      dim(
        `  first Coach ${ms(setup.warmup.firstCoachMs)}, first Hand Review ${ms(setup.warmup.firstReviewMs)}, ` +
          `event loop p99 ${ms(setup.warmup.eventLoopP99Ms)}`,
      ),
    );
  } else {
    setup.warmup = {
      skipped: true,
      note:
        '--skip-warmup: level 1 below is a COLD process and carries the first-Coach cost, which is ' +
        'seconds rather than milliseconds and blocks the event loop for all of it',
    };
  }

  const levels = [];
  const stopped = { reason: null };
  for (const tables of options.levels) {
    const level = levels.length + 1;
    console.log(
      bold(`\nLevel ${level}: ${tables} table(s), ${tables * options.seats} seated players`) +
        dim(`  holding ${options.holdSeconds}s`),
    );
    if (Date.now() >= runDeadline) {
      stopped.reason = `the run budget of ${options.timeoutSeconds}s expired before level ${level}`;
      console.error(red(`  x ${stopped.reason}`));
      break;
    }
    const summary = await runLevel({
      level,
      tables,
      allSessions: sessions.slice(0, tables * options.seats),
      options,
      scraper,
      runDeadline,
      onProblem,
    });
    levels.push(summary);

    const verdict = evaluateStopCriteria(summary, thresholds);
    console.log(
      `  ${verdict.stop ? red('x') : green('OK')} ${summary.client.handsCompleted} hands, ` +
        `p95 ${ms(summary.client.action.p95Ms)}, p99 ${ms(summary.client.action.p99Ms)}, ` +
        `${summary.client.errorCount} error(s)`,
    );
    if (verdict.stop) {
      for (const breach of verdict.breaches) console.log(red(`     ${breach.criterion}: ${breach.detail}`));
      console.log(yellow('     stop criterion crossed — the ramp ends here'));
      break;
    }
  }

  const cpu = process.cpuUsage();
  environment.generatorCpuSeconds = (cpu.user + cpu.system) / 1_000_000;
  environment.loadAverageAtEnd = loadavg();

  const report = buildReport({
    options,
    environment,
    levels,
    thresholds,
    stopped,
    runSeconds: (performance.now() - startedAt) / 1000,
    setup,
  });

  printReport(report);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  if (options.out !== '') {
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(dim(`  wrote ${options.out}\n`));
  }

  process.exit(report.passed ? 0 : 1);
}

if (import.meta.main) await main();
