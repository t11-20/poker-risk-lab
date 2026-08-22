#!/usr/bin/env node
/**
 * A dependency-free load and capacity harness that drives the real user journey against a
 * running API, ramps concurrency until a stated failure criterion is crossed, and reports what
 * saturated using the server's own `GET /metrics` rather than a guess.
 *
 * This is what `pnpm run test:load` does.
 *
 * ## What this replaced, and why the old numbers were worthless
 *
 * The previous harness ran 1 table x 2 seats x 3 hands, finished in 0.11 s, and reported
 * p50/p90/p99 over 18 latency samples. Eighteen samples cannot carry a p99 — the 99th percentile
 * of eighteen numbers IS the maximum, so the figure was the slowest single request wearing a
 * percentile's name. It never drove Coach, never disconnected a client, never opened Hand
 * Review, and measured nothing on the server side at all: no memory, no CPU, no event-loop lag,
 * no database pool pressure. Its own footer admitted it was "a regression check, not a capacity
 * measurement", which was true and was also the whole problem, because a repository with no
 * capacity measurement anywhere quietly promotes that footer's numbers into planning documents.
 *
 * ## What this measures, stated as precisely as it can be
 *
 * ONE API process, at whatever address `--base-url` names, driven by a generator that is
 * usually running on the same machine and therefore competing with it for CPU. Every reported
 * number is stamped with that environment (see `describeEnvironment` and the `Environment`
 * block in the report) because a latency figure without its environment is not a measurement,
 * it is a rumour. The report states the measured capacity of one instance as a specific number
 * of concurrent seated players with those caveats attached, and states which resource ran out.
 *
 * ## What this still does NOT measure, and no footer will let you forget it
 *
 * - **A cluster.** One process. Nothing here says anything about horizontal scaling, sticky
 *   sessions, or what happens when two API processes share one database.
 * - **A real network.** Over loopback there is no packet loss, no reordering, no RTT and no
 *   TLS handshake. Real clients pay all four, and the WebSocket path is where that hurts most.
 * - **A production database.** The compose Postgres holds a development-sized dataset on the
 *   same machine. Query plans change with data volume; these do not.
 * - **A proxy.** `--via-proxy` records an operator's assertion that one is present. It does not
 *   detect one, and a terminating proxy has its own connection limits which this never reaches.
 * - **Browser clients.** These sockets do no rendering, no React reconciliation and no layout,
 *   so a number here is an upper bound on what a browser at the same concurrency would see.
 * - **Sustained running.** The default hold is tens of seconds per level. Memory leaks, cache
 *   eviction and connection churn need hours. The RSS figure is a snapshot, not a trend.
 *
 * ## Where the server-side numbers come from, and what happens when one is missing
 *
 * `GET /metrics` (Prometheus text exposition; bearer token when `METRICS_TOKEN` is set) is
 * scraped before, during and after every level and parsed by `parseExposition` below. The series
 * this harness asks for are listed in `SERIES`, and every one of them is resolved AT RUN TIME
 * rather than assumed: a metric the scraped process does not emit reads as `null`, its name goes
 * into `server.missing` in the JSON and `not exported by this build` in the printed output, and
 * it can never fire a saturation signal.
 *
 * That distinction is the whole reason this is not a lookup table. `observability/registry.ts`
 * renders no line at all for a counter that has never been incremented, so a scraper cannot tell
 * `0` from "nothing in this build feeds this metric" — and a harness that printed the second as
 * the first would be reporting missing instrumentation as an absence of load, which is the worst
 * failure an observability-driven measurement has. It also means this file does not go stale
 * when the instrumentation grows: a metric that starts being fed starts being reported, with no
 * edit here.
 *
 * Two gaps worth knowing about while reading a report, because they change which numbers are the
 * client's and which are the server's:
 *
 *   - Live socket count and hands per minute are reported from THIS side of the wire as well,
 *     labelled as such, because the generator knows them exactly and does not need the server to
 *     agree.
 *   - The Coach analysis served over the WebSocket (`requestCoach`) IS now fed into
 *     `prl_analysis_duration_seconds{kind="coach"}`, as the REST calculation routes always were —
 *     it began going through the worker pool at the same time. The Coach latency in this report
 *     is still measured client-side, send to `coach` frame, because that is what a learner
 *     experiences and it includes the socket round trip the server-side histogram cannot see. The
 *     two are now worth comparing: a large gap between them is queueing or loop delay, not work.
 *
 * Three consequences of the metrics design that change how this harness behaves:
 *
 * 1. `prl_event_loop_delay_*` is a rolling window RESET BY EVERY SCRAPE. Each sample therefore
 *    describes the interval since the previous scrape, which is what makes it useful — and it
 *    means a second scraper running at the same time silently halves these windows. The report
 *    prints the scrape count so that is visible.
 * 2. `prl_db_probe_duration_seconds` only advances when `GET /ready` is called, because the
 *    readiness probe is the only thing that observes it. So this harness calls `/ready` once per
 *    scrape and the database figures describe THOSE probes — a `select 1` waiting for a pooled
 *    connection — not the application's own queries. That is still the right pool-pressure
 *    signal (see `DB_PROBE_BUCKETS` in observability/metrics.ts), and it is not the same thing
 *    as query latency.
 * 3. Those same three gauges are written only when the window HAS samples, so a scrape taken
 *    moments after another reports the previous window's numbers unchanged. The baseline scrape
 *    of a level sits milliseconds after the previous level's final one, so it carries the
 *    previous level's figures — which is why `gaugePeak` drops it. See the note there; it made
 *    two levels report an identical event-loop p99 to six decimal places on a run where one did
 *    a sixth of the work of the other.
 *
 * ## The journey each virtual user walks
 *
 * connect -> join room -> sit -> play hands -> ask Coach mid-hand -> disconnect mid-hand ->
 * reconnect -> finish the hand -> open Hand Review. The reconnect uses the real resume path
 * (`hello` on a fresh socket; the server answers `welcome` and the current view, because there
 * is no catch-up protocol) and every reconnect is CHECKED for consistency: same seat, same hand
 * id, identical own hole cards, a never-decreasing action sequence and a never-shrinking pot.
 * A load test that quietly loses correctness under load is measuring the wrong thing, so a
 * consistency failure fails the whole run regardless of how good the latency looked.
 *
 * ## The clients never guess an action
 *
 * The server sends `legalActions` in every `state` frame where it is that seat's turn, with
 * exact bounds (`minTo`, `maxTo`). This harness picks one of those entries and, for a bet or a
 * raise, sends `minTo` clamped into `[minTo, maxTo]`. It never constructs an action from its own
 * model of the rules. That is not politeness: a harness that guesses actions spends its time
 * measuring the server's rejection path and reports a latency figure for a request that was
 * never valid, while the interesting path goes untested.
 *
 * Likewise `expectedSequence` is copied from the `view.actionSequence` the client is responding
 * to, and `actionId` is unique per attempt, so a retry cannot double-apply. Both are the
 * protocol's own anti-race machinery (see @prl/contracts ws-protocol.ts) and using them
 * properly is part of what is being exercised.
 *
 * ## Why the harness paces Coach and Hand Review
 *
 * `WS_LIMITS.coachRequestsPerMinute` is 30 per socket and `GET /hands/:handId` sits behind the
 * expensive rate limit (20 per minute per session by default). A harness that ignores both
 * spends the whole run measuring the limiter and reports a capacity number for a server that
 * was refusing most of the offered work. So each socket holds off Coach for
 * `COACH_MIN_INTERVAL_MS` and each session holds off review for `REVIEW_MIN_INTERVAL_MS`,
 * which is also what a human does — nobody asks Coach five times a second. The server's own
 * `prl_rate_limit_events_total` is reported per level anyway, so a run that hit the limiter
 * despite the pacing is visible rather than hidden.
 *
 * ## Randomness
 *
 * Which legal action a synthetic client takes is chosen by a small seeded PRNG (mulberry32),
 * not by Math.random and not by a CSPRNG. Two deliberate reasons: a load run has to be
 * repeatable to be comparable, so `--seed` must produce the same decision sequence twice; and
 * this choice has nothing to do with fairness or secrecy, because the server deals every card
 * from its own CSPRNG and this side of the wire cannot influence any outcome. The repo's ban on
 * Math.random is about anything that could touch a game outcome — this cannot, and it still is
 * not Math.random, because reproducibility is worth more here than entropy. Each client gets its
 * OWN stream, derived from the seed and its level, table and seat, so two runs at the same
 * concurrency make the same decisions even though the interleaving between sockets does not
 * repeat.
 *
 * ## Two things that are easy to get wrong and are handled here
 *
 * 1. **The WebSocket handshake needs the session cookie.** The standard `WebSocket` constructor
 *    takes only (url, protocols) and has no way to set a header, which would make every socket
 *    here fail the upgrade with close code 4401. Node's implementation accepts a non-standard
 *    options bag as the SECOND argument — `new WebSocket(url, { headers })` — and forwards those
 *    headers on the upgrade request. Passing it as a third argument silently does nothing, which
 *    is a fun half hour. Verified on Node 24.18.0.
 *
 * 2. **`fetch` has no cookie jar.** Every session here keeps its own tiny jar, populated from
 *    `response.headers.getSetCookie()` — the plural accessor, because `get('set-cookie')` folds
 *    multiple cookies into one comma-joined string that cannot be reliably split (expiry dates
 *    contain commas).
 *
 * ## Usage
 *
 *     node scripts/load-test.mjs [options]        # see --help for every flag
 *     pnpm run test:load -- --ramp 1,2,4,8 --hold 20 --json
 *
 * ## Exit codes
 *
 *     0  every level that ran met every threshold, and the ramp completed
 *     1  a threshold was breached, a reconnect lost state, the metrics endpoint was
 *        unreachable, the run exceeded its budget, or an option was invalid
 *     0  --help
 *
 * A refused or unreachable `/metrics` is a FAILURE, not a warning: the server-side half of
 * every number below comes from there, and a run that silently degrades to client-side timings
 * is exactly the kind of "capacity measurement" this file exists to stop.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { arch, availableParallelism, loadavg, platform, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

/** Protocol version this harness speaks. Must match WS_PROTOCOL_VERSION. */
const WS_PROTOCOL_VERSION = 1;

/**
 * The endpoints, as the server actually registers them.
 *
 * `/metrics` is NOT under the `/api/v1` prefix: `app.ts` registers it at the root, beside
 * `/health` and `/ready`, because it is not a feature of the product. Writing it as
 * `/api/v1/metrics` here would produce `content_not_found`, which reads like an authentication
 * problem and is why the path is named rather than derived.
 */
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

/**
 * Server metric names this harness reads.
 *
 * Named as a table rather than inline so the report can say exactly which of them the scraped
 * process actually emitted and which it did not. Several are declared in
 * `observability/metrics.ts` and never incremented by anything, and a harness that printed a
 * confident `0` for those would be reporting the absence of instrumentation as the absence of
 * load — which is the worst failure mode an observability-driven measurement has.
 */
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
 * Minimum gap between one socket's Coach requests, in milliseconds.
 *
 * `WS_LIMITS.coachRequestsPerMinute` is 30, so 2100 ms allows at most 28 per minute and leaves
 * headroom for clock jitter and for the fact that the server's window is not aligned with ours.
 * Deliberately not 2000: at exactly the limit, a run that drifted a few milliseconds fast would
 * spend part of every level measuring the limiter instead of the analysis.
 */
const COACH_MIN_INTERVAL_MS = 2_100;

/**
 * Minimum gap between one session's Hand Review reads, in milliseconds.
 *
 * `GET /hands/:handId` carries `app.expensiveRateLimit` — 20 per minute per caller by default —
 * because a review replays the hand and prices the actions that were not taken. 3500 ms is at
 * most 17 per minute, which is well inside that and is already far more attentive than a person
 * reviewing their own hands.
 */
const REVIEW_MIN_INTERVAL_MS = 3_500;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Defaults describe a ramp that finishes in about two minutes on a developer machine and is
 * still long enough for the numbers to mean something: four levels, fifteen seconds of steady
 * state each. That is a deliberate change from the old defaults, which finished in 0.11 s and
 * produced percentiles over eighteen samples. Every value below is printed before the run
 * starts, so what was measured is never in doubt.
 */
const DEFAULTS = {
  baseUrl: process.env.PRL_API_ORIGIN ?? 'http://127.0.0.1:3001',
  /**
   * Must match an entry in the server's `PUBLIC_WEB_ORIGIN` allowlist, which is compared as an
   * exact string — `http://127.0.0.1:3000` and `http://localhost:3000` are different origins to
   * it, and the shipped `.env.example` ships the latter.
   */
  origin: process.env.PUBLIC_WEB_ORIGIN ?? 'http://localhost:3000',
  wsPath: ROUTES.ws,
  metricsPath: ROUTES.metrics,
  metricsToken: process.env.METRICS_TOKEN ?? '',
  /** Tables per level, ascending. Concurrency is `tables x seats` seated players. */
  ramp: '1,2,4,8',
  /** Overrides the ramp with one level of this many tables. 0 means "use --ramp". */
  tables: 0,
  /** Seats filled per table. The schema caps a room at 6 (createRoomBody, rooms.max_seats). */
  seats: 3,
  /** Seconds of steady state per level, after every seat is sat and before the drain. */
  holdSeconds: 15,
  /** Seconds to let in-flight hands finish once a level stops dealing. */
  drainSeconds: 20,
  /** Seconds between `/metrics` scrapes (and the `/ready` probe that feeds the DB histogram). */
  scrapeSeconds: 3,
  /**
   * Seconds of the throwaway warm-up level that runs before the ramp.
   *
   * It exists because the FIRST Coach analysis on a cold WORKER THREAD is enormously more
   * expensive than every one after it — measured at roughly 3 s on this machine against 20-30 ms
   * warm — because that thread has to build the preflop strength ordering before it can answer.
   * Left in the ramp, that single number fails level 1 of every run and buries the concurrency
   * signal under a one-off. So it is measured deliberately, reported as its own cold-start
   * figure, and kept out of the levels. `--skip-warmup` measures the cold process instead.
   *
   * It used to block the EVENT LOOP for the whole of that, because `coachForView` ran the Monte
   * Carlo synchronously on the main thread. It now goes to the worker pool, so the cost is paid
   * by the requester and by nobody else — measured across the same window, event-loop p99 fell
   * from 3028.8 ms to 2.1 ms. One thread warms per level as the pool spins up, so a cold-thread
   * requester still waits seconds while everybody else keeps playing; that trade is recorded in
   * `docs/production/load-test.md` rather than hidden here.
   */
  warmupSeconds: 5,
  /**
   * Optional cap on hands per table per level. `0` means the hold decides, which is the default.
   *
   * It used to default to 200, and that quietly broke the ramp at low think times: a three-seat
   * table with no think time finishes 200 hands in about two seconds, so a twenty-second level
   * ended after two, the wall-clock denominator collapsed, and the level reported 7970
   * hands/minute beside a level that reported 762. Neither number described the server. The hold
   * is the thing that is supposed to decide how long a level lasts, so it now does, and the cap
   * is a deliberate stop for someone who wants exactly N hands rather than a default that
   * silently truncates every fast level.
   */
  hands: 0,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
  actionTimeoutSeconds: 15,
  /**
   * Milliseconds a virtual user spends "thinking" before sending an action it has already chosen.
   *
   * Zero by default, and that is a measurement decision that has to be stated rather than
   * defaulted quietly: a virtual user with no think time acts the instant the server asks, which
   * is not a person. It is the most work one seat can possibly offer, so a ramp at zero finds the
   * point at which the INSTANCE runs out of headroom, and the resulting figure is a number of
   * virtual users rather than a number of players. A real learner takes seconds per decision —
   * `LEARNER_TURN_SECONDS` defaults to 240 precisely because the Coach panel they are meant to
   * read at that moment runs to about 950 words.
   *
   * `--think 1000` models people, and the same instance then holds many more seats because each
   * offers far less work. The report prints this value beside the capacity figure and never
   * restates that figure in terms of a think time the run did not use.
   *
   * The latency clock starts AFTER the delay, so this changes the offered rate and never the
   * measured round trip. It must stay well below the turn clock or every seat is folded by the
   * server instead of acting, which `parseArgs` enforces.
   */
  thinkMs: 0,
  /** Hands between one client's mid-hand disconnect/reconnect cycles. */
  reconnectEvery: 2,
  /** Hands between one client's Hand Review reads, on top of REVIEW_MIN_INTERVAL_MS. */
  reviewEvery: 2,
  seed: 1,
  /** Whole-run budget across every level. The run fails if it has not finished by then. */
  timeoutSeconds: 900,
  // --- stop criteria: crossing any of these ends the ramp and names itself ---
  maxErrorRate: 0.01,
  maxP95Ms: 150,
  maxP99Ms: 250,
  minReconnectRate: 0.99,
  // --- saturation classification thresholds, in the units the metric reports ---
  eventLoopP99Ms: 50,
  cpuCores: 0.9,
  dbProbeP99Ms: 50,
  // --- honest labelling: asserted by the operator, never measured ---
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

/** Flags that turn a leg of the journey off. Kept apart because they set `false`, not `true`. */
const DISABLE_OPTIONS = new Map([
  ['--no-coach', 'coach'],
  ['--no-reconnect', 'reconnect'],
  ['--no-review', 'review'],
  ['--skip-warmup', 'warmup'],
]);

/**
 * Parses argv into a fully validated option set.
 *
 * Exported so `load-test.test.mjs` can assert the validation without starting a server. Every
 * rejection throws the REASON — "--seats must be an integer from 2 to 6 (rooms.max_seats CHECK)"
 * rather than "invalid --seats" — because the reason is the difference between a one-second fix
 * and reading the source.
 */
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
    // `pnpm run test:load -- --ramp 1,2` forwards the `--` itself, so absorb it rather than
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

  // The seat bound is the database's: rooms.max_seats has a CHECK BETWEEN 2 AND 6, and
  // createRoomBody repeats it.
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
  // Half the turn clock, not all of it. A think time close to the clock races the server's own
  // timer, and the seat that loses that race is folded automatically — so the run would measure
  // the timeout path and report a hand rate for a table nobody was actually playing.
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

/**
 * Turns `--ramp` (or `--tables`) into the ascending list of table counts to run.
 *
 * Ascending is required rather than merely conventional: the whole report is built on "the
 * highest level that met every threshold", and a ramp that went 8, 2, 4 has no such level.
 */
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

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile: the smallest sample at or above the requested rank.
 *
 * No interpolation. Interpolated percentiles invent a latency that no request actually
 * experienced, which is exactly the wrong property for a tail metric — and the exposition
 * format's own `histogram_quantile` already does enough of that on the server side.
 *
 * `Math.ceil(fraction * n)` is the RANK (1-based); the array index is one less. Getting that
 * conversion wrong is the classic percentile bug and it is silent: it shifts every reported
 * figure by one sample, which looks plausible at any concurrency. `load-test.test.mjs` pins it
 * against a known distribution and feeds the two off-by-one variants in as negative controls.
 */
export function percentile(sortedSamples, fraction) {
  if (sortedSamples.length === 0) return null;
  const rank = Math.ceil(fraction * sortedSamples.length);
  const index = Math.min(Math.max(rank, 1), sortedSamples.length) - 1;
  return sortedSamples[index];
}

/**
 * The full latency summary for one bucket of samples, in milliseconds.
 *
 * p95 is in here because it was missing from the old harness and is the figure most alerting
 * uses — `HTTP_BUCKETS` in observability/metrics.ts is chosen so that the 250 ms p95 warning
 * threshold lands on a bucket boundary, and a harness that never reports p95 cannot tell you
 * whether that alert would have fired.
 *
 * `count` is reported beside every percentile on purpose. A p99 over fewer than about 100
 * samples IS the maximum, and the report prints a warning when a level lands there rather than
 * letting the number pass as a percentile.
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

/**
 * Fewest samples for which a p99 is a percentile rather than a synonym for the maximum.
 *
 * At n = 100 the nearest rank for 0.99 is 99, so the reported figure is the second-largest
 * sample and the maximum is still visible separately. Below that the two collapse.
 */
const MIN_SAMPLES_FOR_P99 = 100;

// ---------------------------------------------------------------------------
// Prometheus text exposition parser
// ---------------------------------------------------------------------------

/**
 * Parses the Prometheus text exposition format into samples this harness can query.
 *
 * Written here rather than pulled in, for the same reason `observability/registry.ts` renders it
 * by hand: the format is a documented, stable, line-oriented serialisation, and the repository's
 * dependency policy is deliberately hostile to a package that would need pinning, hashing,
 * IOC-scanning and re-reviewing on every bump.
 *
 * What it handles, all of which appear in a real scrape of this service:
 *
 *   - `# HELP name text` and `# TYPE name type`, and plain `#` comments, kept out of the samples
 *   - unlabelled samples (`prl_readiness_state 1`)
 *   - labelled samples, including the `le="+Inf"` bucket every histogram ends with
 *   - label values carrying the format's three escapes: backslash, double quote, and `\n`
 *   - `+Inf`, `-Inf` and `NaN` as VALUES, which a bare `Number()` would turn into NaN or null
 *   - an optional trailing millisecond timestamp, which this service never emits and the format
 *     permits; it is parsed off and discarded rather than being mistaken for part of the value
 *
 * A line it cannot parse is collected in `malformed` rather than thrown, because a scrape that
 * gained one unexpected line during an incident should still yield every other number. The
 * caller decides whether `malformed.length > 0` matters; this harness prints it.
 */
export function parseExposition(text) {
  const samples = [];
  const index = new Map();
  const help = new Map();
  const types = new Map();
  const malformed = [];

  for (const rawLine of text.split('\n')) {
    // Trailing CR rather than a full trim: leading whitespace on a sample line is not legal
    // exposition, and silently accepting it would hide a server that had started emitting it.
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

/** One sample line, or null when it is not one. */
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
  // The format is `value [timestamp]`. Splitting on whitespace and taking the first token keeps
  // a timestamp from being concatenated into the value, which would silently multiply every
  // reading by about 10^13.
  const [valueToken] = rest.split(/\s+/);
  const value = parseExpositionValue(valueToken);
  if (value === null) return null;
  return { name, labels, value };
}

/**
 * Reads a `{a="1",b="two"}` label set starting at `open`, honouring the format's escapes.
 *
 * Hand-written rather than a regex because a label value may legally contain `}` , `,` and an
 * escaped `"`, and every regex that pretends otherwise fails on exactly the label somebody is
 * debugging at the time.
 */
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
        // The exposition format defines exactly three escapes in a label value. Anything else
        // after a backslash is passed through as itself, which is what a scraper does.
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

/** A value token from the exposition format, or null when it is not a number at all. */
export function parseExpositionValue(token) {
  if (token === '+Inf' || token === 'Inf' || token === '+inf') return Number.POSITIVE_INFINITY;
  if (token === '-Inf' || token === '-inf') return Number.NEGATIVE_INFINITY;
  if (token === 'NaN' || token === 'nan') return Number.NaN;
  const value = Number(token);
  return Number.isNaN(value) ? null : value;
}

/** True when `sample` carries every label in `labels` with the same value. */
function matchesLabels(sample, labels) {
  for (const [name, value] of Object.entries(labels)) {
    if (sample.labels[name] !== value) return false;
  }
  return true;
}

/**
 * One series' value, or null when the process does not export it.
 *
 * Null, never zero. A metric that is declared and never incremented renders no line at all (see
 * `Counter.renderSamples` in observability/registry.ts), so `0` and "this build never feeds this
 * metric" are indistinguishable to a scraper — and reporting the second as the first turns
 * missing instrumentation into a confident claim of no load.
 */
export function sampleValue(snapshot, name, labels = {}) {
  const series = snapshot.index.get(name);
  if (series === undefined) return null;
  const found = series.find((sample) => matchesLabels(sample, labels));
  return found === undefined ? null : found.value;
}

/**
 * The sum across every label combination of one metric, or null when it is not exported.
 *
 * `filter` drops series the caller does not want counted — used here to subtract this harness's
 * own `/metrics` and `/ready` traffic from the HTTP totals, so the reported request rate is the
 * load being applied rather than the load plus the measuring of it.
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

/** Every label combination of one counter, as `{ labelValue: count }` keyed on `labelName`. */
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

/**
 * A histogram, as cumulative buckets plus its sum and count, or null when it is not exported.
 *
 * `le` is kept as a number, with the `+Inf` bucket becoming `Infinity`, so the buckets sort
 * correctly and the quantile search below needs no special case for the last one.
 */
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
 * The difference between two readings of the same histogram.
 *
 * Cumulative bucket counters only ever go up, so subtracting a baseline gives the distribution
 * of the observations made DURING a level rather than since the process started. Without this,
 * level 8's numbers would be diluted by every observation from levels 1, 2 and 4.
 *
 * A bucket present in `after` but not in `before` is treated as having been zero, which is what
 * a counter that had no observations in that bucket yet means.
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
 * The bucket bound at or above which a quantile of the observations fell, in the metric's units.
 *
 * Deliberately NOT `histogram_quantile`'s linear interpolation. Interpolating inside a bucket
 * asserts the observations were uniformly distributed across it, which they are not, and
 * produces a decimal that reads like a measurement. This returns a BOUND — "99% of probes
 * finished within 0.05 s" — which is a statement the data actually supports. `null` means the
 * quantile fell in the `+Inf` bucket, so all that is known is "above the top bound".
 */
export function histogramBoundAtQuantile(histogram, quantile) {
  if (histogram === null || histogram.count <= 0) return null;
  const target = quantile * histogram.count;
  let seen = 0;
  for (const bucket of histogram.buckets) {
    seen = bucket.cumulative;
    if (seen >= target) return Number.isFinite(bucket.le) ? bucket.le : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Seeded PRNG — see the module comment for why this is not Math.random
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-level accounting
// ---------------------------------------------------------------------------

/**
 * Counters and latency samples for ONE level of the ramp.
 *
 * A fresh instance per level, rather than one for the whole run, because the entire report is
 * built on comparing levels — a shared instance makes every level's numbers the average of it
 * and everything before it, and the saturation point disappears into the mean.
 *
 * Latency is stored as every individual sample rather than as a running summary, because you
 * cannot compute a p99 from a mean and a count, and the sample count here (tens of thousands at
 * most) makes the memory question irrelevant. If this is ever pointed at a run large enough for
 * that to matter, switch to a histogram with fixed buckets — and say so in the report, because
 * bucketed percentiles are approximations and the report should not pretend otherwise.
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
    /** Human-readable consistency failures; any one of these fails the whole run. */
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

  /**
   * The denominator for the error rate: every operation that could have failed.
   *
   * Deliberately explicit and printed beside the rate — an error rate whose denominator is
   * unstated is a number you can make say anything.
   */
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

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

/**
 * One guest identity: its cookie jar, its CSRF token, and its display name.
 *
 * The jar is a plain Map of name -> value. It ignores Domain, Path, Expires and Secure, which is
 * correct for a harness talking to exactly one origin for a few minutes, and would be wrong for
 * anything else.
 *
 * `metrics` is settable because a session outlives a level: sessions are provisioned once for
 * the widest level and reused, so each level points them at its own `LevelMetrics` and the
 * provisioning cost lands in the setup accounting rather than in level one.
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
    /** Wall-clock time of the last Hand Review, for the pacing described in the header. */
    this.lastReviewAt = 0;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(response) {
    // getSetCookie(), not get('set-cookie'): the singular accessor joins multiple cookies with a
    // comma, and cookie attributes legally contain commas ("Expires=Wed, 21 Oct 2026 ..."), so
    // splitting it back apart is guesswork.
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(';', 1)[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  /**
   * A request, with cookies, CSRF header and error accounting.
   *
   * Errors are classified into the protocol's own `error.code` where the server gave one, and
   * into `transport:*` buckets otherwise, so the report can distinguish "the server said no"
   * from "the server was not reachable".
   */
  async request(path, { method = 'GET', body } = {}) {
    const headers = { accept: 'application/json', origin: this.origin };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Sent on every mutating request; paired with the SameSite=Strict cookie.
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
   * Creates the guest identity and captures the cookie and CSRF token.
   *
   * The GET comes first and that is the whole point: `POST /auth/guest` is a mutating request,
   * so the CSRF hook demands the `x-csrf-token` header AND the matching secret cookie. Both come
   * from `GET /auth/session`, which is exempt (GET changes nothing) and hands out a token to
   * anyone. POSTing first is rejected `csrf_failed` every time, which reads like a client
   * problem rather than an ordering one.
   */
  async createGuest() {
    const seed = await this.request(ROUTES.session);
    this.csrfToken = seed?.csrfToken ?? null;
    if (this.csrfToken === null) {
      throw new Error(`no CSRF token from GET ${ROUTES.session} — every mutation would be rejected`);
    }

    const created = await this.request(ROUTES.guest, { method: 'POST', body: { displayName: this.name } });
    // The guest response is a SessionResponse and carries a fresh token bound to the new session
    // cookie. Keep the seeded one if it ever stops doing so, rather than dropping to null and
    // failing every later request.
    this.csrfToken = created?.csrfToken ?? this.csrfToken;
    this.userId = created?.user?.id ?? null;
    if (this.userId === null) {
      throw new Error(`POST ${ROUTES.guest} returned no user id; the session is unusable`);
    }
    return this;
  }
}

// ---------------------------------------------------------------------------
// Scraping the server's own metrics
// ---------------------------------------------------------------------------

/**
 * Reads `GET /metrics` and `GET /ready`, and keeps every reading of a level.
 *
 * `/ready` is called immediately BEFORE each scrape and not after, because the readiness probe
 * is the only thing that observes `prl_db_probe_duration_seconds` — calling it after the scrape
 * would put every probe in the next interval's window and leave the first one empty.
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

  /** One scrape. Returns the parsed snapshot, or an object carrying the reason it failed. */
  async scrape() {
    // The readiness probe is load in its own right, and small: one `select 1` per scrape
    // interval. It is reported as harness overhead rather than folded into the applied load.
    try {
      await fetch(new URL(this.readyPath, this.baseUrl), {
        headers: { accept: 'application/json', origin: this.origin },
      });
    } catch {
      // A failed readiness probe is not itself a scrape failure — the metrics endpoint below is
      // the thing this class exists to read, and it answers from memory when the database does
      // not. The db histogram simply gains no observation for this interval.
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
 * Turns a level's scrapes into the server-side half of its numbers.
 *
 * Counters become deltas across the level; gauges become the peak seen during it. Anything the
 * process did not export is `null` and its name goes in `missing`, so the report can say "this
 * build does not instrument that" instead of printing a zero that reads like an absence of load.
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

  /** A counter's increase across the level, or null when the metric is not exported at all. */
  const counterDelta = (name, filter) => {
    const before = seriesTotal(first, name, filter);
    const after = seriesTotal(last, name, filter);
    if (before === null || after === null) {
      missing.add(name);
      return null;
    }
    return after - before;
  };

  /** The largest reading of a gauge across the level, or null when it is not exported. */
  /**
   * The largest reading of a gauge DURING the level, or null when it is not exported.
   *
   * The baseline reading is excluded, and that is not tidiness — it is a correctness fix for a
   * specific way `prl_event_loop_delay_*` lies. Those three gauges are only written when the
   * native monitor has at least one sample in the window (`if (this.eventLoop.count > 0)` in
   * observability/metrics.ts), and every scrape RESETS that window. The baseline scrape of a
   * level happens milliseconds after the previous level's final scrape, so its window is
   * effectively empty, the guard skips the write, and the gauge still holds the PREVIOUS
   * level's numbers — which the registry then renders as though they were current.
   *
   * Including it made every level after the first report the worst event-loop delay of the level
   * before it, identical to six decimal places. Observed exactly that way: level 1 and level 2
   * both reported a 576.678271 ms p99 peak on a run where level 2 did a sixth of the work.
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

  // This harness's own traffic, kept out of the applied-load figures. Scraping and probing are
  // measurement, not load, and counting them would inflate the request rate by a fixed amount
  // per level that a reader would have no way to subtract.
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

  const rateBefore = seriesByLabel(first, SERIES.rateLimitEvents, 'kind') ?? {};
  const rateAfter = seriesByLabel(last, SERIES.rateLimitEvents, 'kind') ?? {};
  const rateLimited = (rateAfter.limited ?? 0) - (rateBefore.limited ?? 0);
  const rateBanned = (rateAfter.banned ?? 0) - (rateBefore.banned ?? 0);

  return {
    scrapes: good.length,
    scrapeFailures: failed,
    usable: true,
    scrapeSpanSeconds,
    /**
     * How many readings the gauge peaks were actually taken from.
     *
     * Counters are fine with two readings — a delta needs a start and an end. Gauges are not:
     * they are instantaneous, and `gaugePeak` drops the baseline, so a level that finished before
     * the first interval scrape landed leaves exactly one gauge reading, taken AFTER the sockets
     * were closed. Every gauge then reads zero and the report says the level ran with no
     * connections and no memory growth, which is a confident description of a level that had
     * already ended. Observed on an eight-second level that hit its 200-hand cap in under two
     * seconds. Reported rather than corrected, because the fix is a longer hold and the harness
     * cannot make that choice for the operator.
     */
    gaugeReadings: Math.max(good.length - 1, 0),
    gaugeNote:
      good.length - 1 < 2
        ? 'gauge peaks come from a single reading taken after this level had already finished, so ' +
          'sockets, memory and event-loop figures below describe a torn-down level; raise --hold ' +
          'or lower --scrape'
        : null,
    // Divided by the SCRAPE SPAN, not the level's wall clock: the counters were read at the
    // first and last scrape, so the span between them is the only interval the delta describes.
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
    // Process CPU seconds per wall second: 1.0 means one core fully consumed. Reported rather
    // than a percentage because "120% CPU" is meaningless without knowing the core count, and
    // the core count of the machine is in the environment block. Divided by the scrape span
    // rather than the level's wall clock for the same reason as the request rate above: the
    // counter was read at the first and last scrape and describes only the interval between.
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

// ---------------------------------------------------------------------------
// One WebSocket client — the virtual user
// ---------------------------------------------------------------------------

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
    /** The `welcome` frame of the current socket, kept for the resume check's room comparison. */
    this.welcomeFrame = null;
    this.welcomeSeat = null;
    this.sat = false;
    this.stopped = false;
    /** requestId -> { sentAt, kind }, for round-trip measurement. */
    this.pending = new Map();
    /**
     * The last decision point acted on, as `handId:actionSequence`.
     *
     * The hand id has to be in the key. `actionSequence` is per-hand and starts again at zero for
     * every deal, so a bare sequence number matches the first decision of the *next* hand as well
     * — which reads as "already acted", the seat never acts, the hand never advances, and the run
     * sits there until the turn clock times every seat out. Found exactly that way.
     */
    this.lastActedKey = null;
    this.lastView = null;
    this.handsSeen = 0;
    this.currentHandId = null;
    this.lastCoachAt = 0;
    this.coachedHandId = null;
    this.reconnectedHandId = null;
    this.reconnecting = false;
    /** Resolvers waiting for the next `state` frame, used by the reconnect check. */
    this.stateWaiters = [];
    /**
     * The most recent `state` frame received since the current socket's `welcome`.
     *
     * Kept because `welcome` and the state frame that follows it can arrive in ONE read and be
     * dispatched as two message events in the same tick, while the promise `connect()` resolved
     * on only resumes a microtask later. The reconnect cycle would then register its waiter
     * after the frame it was waiting for had already gone past, wait the full five seconds,
     * ignore every state frame in the meantime (`reconnecting` is still true), and never act —
     * so the seat sat there until the server's turn clock folded it. That produced eight seat
     * timeouts in a fifteen-second level and looked exactly like server-side stalling.
     */
    this.stateSinceWelcome = null;
  }

  wsUrl() {
    const url = new URL(this.options.wsPath, this.options.baseUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }

  /**
   * Opens a socket, sends `hello`, and resolves on `welcome`.
   *
   * `purpose` decides which latency bucket and which pair of counters the attempt lands in, so
   * a first connect and a resume are never averaged together — they are different code paths on
   * the server (one builds a room, one only reads it) and reporting them as one number hides
   * exactly the regression a reconnect test exists to catch.
   */
  connect(purpose) {
    const startedAt = performance.now();
    if (purpose === 'reconnect') this.metrics.reconnectsAttempted += 1;
    else this.metrics.connectionsAttempted += 1;

    return new Promise((resolve, reject) => {
      let settled = false;
      // See the module comment: the options bag must be the SECOND argument, and the cookie is
      // how the server authenticates the upgrade. The Origin header is checked too — a mismatch
      // closes with WS_CLOSE.badOrigin (4406).
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
        // `hello` must be the first frame; a socket that does not send it within
        // WS_LIMITS.handshakeTimeoutMs is closed with 4408.
        this.send({
          type: 'hello',
          protocolVersion: WS_PROTOCOL_VERSION,
          roomId: this.roomId,
          clientNonce: randomUUID(),
        });
      });

      socket.addEventListener('message', (message) => {
        // A frame from a socket this client has already replaced is from the pre-reconnect
        // socket. Counting it would credit the resumed session with state it did not receive.
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
        // The event carries no useful detail by design (it would be a cross-origin information
        // leak in a browser), so the close frame that follows is where the reason comes from.
        fail('websocket error before welcome', 'transport:ws-error');
      });

      socket.addEventListener('close', (event) => {
        if (this.socket === socket) this.metrics.socketClosed();
        if (event.code !== 1000 && event.code !== 1005) {
          this.metrics.error(`transport:close-${event.code}`);
        }
        // 4401 before welcome almost always means the cookie did not arrive on the upgrade. Say
        // so explicitly: the alternative is a wall of auth failures with no hint that the cause
        // is a header, not a credential.
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
        // Cleared here, not in `connect`, so that "a state frame has arrived on THIS socket
        // since its welcome" is decided by the frames themselves rather than by when a promise
        // happened to resume.
        this.stateSinceWelcome = null;
        return;
      case 'state':
        this.stateSinceWelcome = frame;
        // Waiters next: the reconnect check needs the frame as it arrived, before `onState` has
        // a chance to act on it and move the client's own bookkeeping on.
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
        // Resolve the waiter so a failed request does not sit in `pending` forever and quietly
        // inflate nothing.
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
      // A deduplicated ack means the server recognised a repeated actionId and did NOT apply
      // anything new, so counting it as applied would overstate throughput.
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

  /**
   * Reacts to one authoritative state frame: Coach, then maybe a reconnect, then the action.
   *
   * `view.legalActions` is empty in every frame that is not this seat's decision, which makes
   * "is it my turn" and "what may I do" the same question with one answer from one authority.
   */
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

    // The same decision point can arrive more than once (a reconnect, or a state resend after an
    // unrelated change). Acting twice on it would burn an actionId and earn a
    // stale_action_sequence for the second.
    const key = `${String(view.handId)}:${view.actionSequence}`;
    if (key === this.lastActedKey) return;

    this.maybeRequestCoach(view);

    // The disconnect happens HERE, on this seat's own decision, and not between hands: the
    // journey being modelled is "lost the connection while it was my turn", which is the case a
    // resume has to get right and the only one where the turn clock is running against you.
    if (this.shouldReconnect(view)) {
      this.reconnectedHandId = view.handId;
      void this.reconnectCycle();
      return;
    }

    // Claimed synchronously, before any think delay can suspend: a resent frame for the same
    // decision arriving during the pause would otherwise schedule a second action for it, and
    // the server would answer the second one `stale_action_sequence`.
    this.lastActedKey = key;
    const chosen = this.choose(legal);
    if (this.options.thinkMs > 0) {
      // `unref` so a pending think delay cannot hold the process open after the level has torn
      // its sockets down. The sockets keep the loop alive while a level is running, so the timer
      // still fires whenever it is meant to.
      setTimeout(() => this.sendAction(view, chosen), this.options.thinkMs).unref();
      return;
    }
    this.sendAction(view, chosen);
  }

  /**
   * Sends one already-chosen action and starts its latency clock.
   *
   * Separated from `onState` so that `--think` delays the SEND and not the measurement: the
   * round trip reported is server time, never the harness pretending to be a slow reader.
   */
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
    // See COACH_MIN_INTERVAL_MS: without this the run measures WS_LIMITS.coachRequestsPerMinute.
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
   * Drops the socket mid-hand and resumes on a fresh one, then checks what came back.
   *
   * There is no catch-up protocol: `hello` on a new socket answers `welcome` plus the current
   * view (ws/router.ts, "Reconnect is exactly this: send the current view"). So the check is
   * whether that view is the SAME hand this seat was in, with the same cards and a sequence that
   * has not gone backwards. A run whose latency looked fine while resumed clients silently saw a
   * different hand would be a worse outcome than a slow run, which is why any failure here fails
   * the whole run rather than counting towards an error rate.
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
        // Not a failure. Every other seat kept playing while this one was away, and a hand can
        // legitimately finish in that window — most often when the remaining players all fold.
        // Counted separately so a run where it happened constantly is visible rather than
        // reported as a clean resume.
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
      // The frame that came back with the resume is a real decision point if it is our turn, and
      // nothing else will re-send it: the server broadcasts on CHANGE, and nothing changes while
      // the table waits for this seat. Replaying it here is what "complete the hand after the
      // reconnect" means. `stateSinceWelcome` rather than `frame` because a state frame that
      // arrived while `reconnecting` was still true was deliberately not acted on, and that one
      // is newer than the one the await returned.
      const resume = this.stateSinceWelcome ?? frame;
      if (resume !== null) this.onState(resume);
    } catch (error) {
      this.reconnecting = false;
      this.metrics.error('transport:reconnect-failed');
      this.hooks.onProblem(`seat ${this.seat} could not resume: ${error.message}`);
    }
  }

  /**
   * Resolves with the state frame for the current socket, or null if none arrives in time.
   *
   * Answers immediately when one has ALREADY arrived since this socket's `welcome`. See
   * `stateSinceWelcome` in the constructor for the race this closes: the two frames can be
   * dispatched in one tick, and a waiter registered a microtask later would miss the only frame
   * the server was going to send.
   */
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
   * Closes the current socket and waits for the close to land.
   *
   * Waiting matters: `WS_LIMITS.maxSocketsPerSession` is 4, and a harness that opened the resumed
   * socket before the old one had gone would spend a long run drifting towards that cap and then
   * report the resulting 4429 closes as server instability.
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
   * Picks one of the offered legal actions and shapes it into a WsAction payload.
   *
   * The policy is biased hard towards passive play, because the purpose is to complete hands: a
   * table of maniacs ends most hands preflop with one all-in and measures almost no postflop
   * code. Aggression is included at a low rate so that betting, raising and side-pot paths are
   * exercised at all. Folding is only ever chosen when there is something to fold to, and never
   * when checking is free — a fold with a free check available is legal but would just end hands
   * without playing them.
   *
   * `to` for a bet or raise is `minTo` clamped into the server's own `[minTo, maxTo]`. Never a
   * computed size: sizing rules are the server's.
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

    // Nothing recognised. Fall back to the first thing the server offered rather than inventing
    // one; if it needs a size, use its own minimum.
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
 * The parts of a view a resumed socket must still agree about.
 *
 * Deliberately small. Everything in here is either identity (which hand, which seat, which
 * cards) or monotonic (the action sequence and the pot only ever go up within a hand). A
 * comparison over the whole view would fail on every legitimate change made by the other seats
 * while this one was away, which is not a bug and would make the check useless.
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
 * Compares what a seat saw before it dropped with what the server sent back when it resumed.
 *
 * Returns a list of problems, each naming its own kind so the report can separate a benign
 * "the hand finished while you were away" from "you came back to somebody else's cards".
 *
 * Exported and pure so `load-test.test.mjs` can drive it with fabricated snapshots, which is the
 * only way to prove the check fires — a real run that never loses state proves nothing about
 * whether the check works.
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
    // No live hand at all after the resume. That is what a client sees when the hand it was in
    // has finished and the next one has not been dealt, so it is the benign case.
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

// ---------------------------------------------------------------------------
// Hand Review
// ---------------------------------------------------------------------------

/**
 * Opens Hand Review the way the review screen does: list, then read one hand in full.
 *
 * The reported latency covers BOTH requests, because that is what a reader waits for and
 * because the second one cannot be issued without the first. `GET /hands/:handId` is the
 * expensive one — it replays the hand and prices the actions that were not taken — and it is the
 * only route in this journey that carries `app.expensiveRateLimit`.
 *
 * Failures are counted by `Session.request` and swallowed here: a review that 429s must not take
 * the table down with it, because the table is what the rest of the level is measuring.
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
    // Already counted, by code, inside `Session.request`.
  }
}

// ---------------------------------------------------------------------------
// A table: a room, sockets, and hands
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sleepUntil(deadline) {
  return sleep(Math.max(0, deadline - Date.now()));
}

/** Polls a predicate until true or the deadline passes. */
async function waitFor(predicate, deadline, what) {
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/**
 * Runs one table for one level.
 *
 * The owner (seat 0) is the only client that sends `startHand`, because that is what the
 * protocol says: "Ask the owner's table to deal the next hand". Hand completion is counted from
 * the owner's socket only — every seated client receives the same `handComplete` event, so
 * counting all of them would multiply the hand count by the number of seats.
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

  // The invite code is returned exactly once, at creation, and only a hash is stored — so it has
  // to be carried from here to the joiners in memory. The room id is NOT in the path: the server
  // looks the room up by the code, so a caller who does not hold the code cannot join by
  // guessing an id.
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
        // One stream per seat, derived from the seed and the seat's coordinates, so a rerun at
        // the same concurrency makes the same decisions. A single shared stream would be
        // consumed in whatever order the sockets happened to be scheduled in, which is exactly
        // the thing a load run cannot reproduce.
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
            // `options.hands > 0` first: a cap of zero means no cap, and without that guard every
            // table would settle after its very first hand.
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
    // Sequential connect, not Promise.all: a rate limiter that sees N simultaneous upgrades from
    // one machine is measuring the limiter, and a failure in the middle of a parallel connect is
    // much harder to attribute.
    for (const client of clients) await client.connect('initial');
    for (const client of clients) client.sit();

    // Wait for every seat to be acknowledged before dealing. Sitting is what makes a player part
    // of the hand, so dealing early produces a heads-up hand at a table that was meant to have
    // six players.
    await waitFor(() => clients.every((client) => client.sat), drainDeadline, 'all seats to be taken');

    clients[0].startHand();

    const outcome = await Promise.race([tableDone, sleepUntil(drainDeadline).then(() => 'drained')]);
    return { index, roomId, handsCompleted, outcome };
  } finally {
    for (const client of clients) client.close();
  }
}

// ---------------------------------------------------------------------------
// One level of the ramp
// ---------------------------------------------------------------------------

/**
 * Runs one concurrency level start to finish and returns its summary.
 *
 * The shape of a level is setup, then steady state, then drain. Only the steady state is
 * measured against a threshold: connecting twenty-four sockets and creating eight rooms is a
 * burst of a kind no running deployment sees, and letting it into the latency distribution
 * would make every level look worse than it is in exactly the way that hides a real regression.
 * Setup failures are still reported, and a setup that cannot complete is a refusal, which is one
 * of the stop criteria.
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

  // A baseline scrape before any socket opens, so the level's counter deltas describe this level
  // and not the tail of the previous one.
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
  // A final scrape AFTER the sockets are closed. Closing is where a leak shows: a room whose
  // sockets have gone should stop costing memory, and the difference between this reading and
  // the previous one is the only place that is visible.
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

/**
 * Turns one level's raw counters into the object the report is built from.
 *
 * Pure apart from reading the two arguments, so `load-test.test.mjs` can build a level summary
 * by hand and drive the stop criteria and the renderer with it — which is the only way to test
 * the criteria without a saturated server to hand.
 */
function summariseLevel({ level, tables, options, metrics, tableSummaries, readings, wallSeconds }) {
  const reconnectRate =
    metrics.reconnectsAttempted === 0 ? null : metrics.reconnectsEstablished / metrics.reconnectsAttempted;

  return {
    level,
    tables,
    seats: options.seats,
    virtualUsers: tables * options.seats,
    holdSeconds: options.holdSeconds,
    // Carried on the level rather than left in `settings`, because the stop criteria need it:
    // "no hand completed" means something entirely different at a think time of 0 than at one
    // where the think time alone exceeds the hold.
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
    // `tableOutcomes`, not `tables`: `tables` above is the COUNT this level ran, and it is what
    // the capacity figure is stated in. The two shared a key for one revision and the array
    // silently won, so the report printed "capacity: 24 players across [object Object] tables".
    tableOutcomes: tableSummaries.map((table) => ({
      index: table.index,
      handsCompleted: table.handsCompleted,
      outcome: table.outcome,
    })),
  };
}

// ---------------------------------------------------------------------------
// Stop criteria and saturation classification
// ---------------------------------------------------------------------------

/**
 * Decides whether this level crossed a stated failure criterion, and names which.
 *
 * Pure, and exported, because "the ramp stopped at 24 users" is the single most consequential
 * sentence this harness produces and it must be testable without a server. Every criterion
 * returns the observed value beside its limit so the report can show the margin rather than a
 * bare verdict.
 *
 * Consistency is in here as a criterion with no configurable threshold. A resumed client that
 * came back to the wrong state is a correctness failure, and there is no concurrency at which
 * that is an acceptable trade for throughput.
 */
/**
 * Rough think time one hand costs, in milliseconds, at this level's shape.
 *
 * Four betting rounds (preflop, flop, turn, river) with roughly one decision per seated player
 * per round. Deliberately crude — it exists to answer one question, "could a hand even have
 * finished inside the hold", and a more careful model would be a poker simulator inside a load
 * harness with no better answer to that question.
 */
export function thinkTimePerHandMs(level) {
  const think = level.thinkMs ?? 0;
  return think === 0 ? 0 : level.seats * think * 4;
}

/**
 * The sentence appended to "no hand completed" when the hold was the likely reason.
 *
 * Without it, a run at a realistic think time reports `no-progress` at every level and reads as
 * a saturated server, when what actually happened is that a six-handed hand at one second a
 * decision needs about twenty-four seconds of think time and the hold was twenty. That is a
 * misconfigured run, not a finding, and the difference has to be in the message rather than in
 * the reader's head.
 */
function describeHandBudget(level) {
  const budgetMs = thinkTimePerHandMs(level);
  if (budgetMs === 0 || budgetMs <= level.holdSeconds * 1000) return '';
  return (
    `. At --think ${level.thinkMs}ms with ${level.seats} seats a hand needs roughly ` +
    `${(budgetMs / 1000).toFixed(0)}s of think time alone and the hold was ${level.holdSeconds}s, ` +
    'so this is very likely the hold rather than the server'
  );
}

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
 * Names the resource that ran out at a level, with the evidence for and against each candidate.
 *
 * Every signal is reported whether it fired or not, because "the event loop was fine and the
 * database was fine" is as much a part of an honest saturation claim as the one that fired. A
 * signal the process does not export is reported as `not exported by this build` and can never
 * fire — this must not blame the worker pool on the basis of a metric nothing increments.
 *
 * Order matters: the first firing signal is the one named, and they are ordered by how directly
 * they cause the latency this harness measures. Event-loop delay is still first, but for a
 * weaker reason than it once had: the Coach and the hand review used to run their Monte Carlo
 * synchronously on the main thread, so a saturated instance showed up there first and everything
 * else was downstream of it. Both now go to the worker pool. The loop remains the signal that
 * explains the widest range of symptoms at once — it is the single thread every socket, timer
 * and turn clock shares — so it keeps the first position, and a saturated instance is now more
 * likely to name CPU or the pool instead. That is the fix working, not the classifier drifting.
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
      fired: exported(server.dbProbeP99BoundMs) && server.dbProbeP99BoundMs >= thresholds.dbProbeP99Ms,
      meaning: 'select 1 waited for a pooled connection, which is pool exhaustion before any query fails',
      /**
       * The probe is timed inside the request handler, so its duration includes any time the
       * process spent unable to reach the event loop. When the event-loop signal has also fired,
       * a slow probe is fully explained by that and says nothing about the pool — which is why
       * event-loop is ordered first and why this caveat is printed rather than left implied. A
       * five-second `select 1` against an idle database is a blocked process, not a busy pool.
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

// ---------------------------------------------------------------------------
// Environment — the label every number carries
// ---------------------------------------------------------------------------

/**
 * Everything about where this was measured that a reader needs before believing a number.
 *
 * The two fields that are ASSERTED rather than measured say so in their own values, not in a
 * footnote: a client cannot see the server's NODE_ENV and cannot detect a transparent proxy, so
 * `--server-env` and `--via-proxy` are an operator's claim and the report prints them as one.
 *
 * `generatorCpuSeconds` is filled in at the end of the run. It is the single most useful number
 * for judging a loopback measurement: if the generator burned as much CPU as the server, the two
 * were fighting over the same cores and every latency figure includes that fight.
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

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Builds the whole report from data.
 *
 * Pure: it reads its arguments and returns a plain object with no Maps, no class instances and
 * nothing that will not survive `JSON.stringify`. `renderReport` below is the only thing that
 * turns it into text. That split is the point — the human output and the `--json` output are the
 * same object seen twice, so the two cannot drift, and `load-test.test.mjs` asserts exactly that
 * by rendering a fabricated report and finding its numbers in the text.
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
          /**
           * What one "concurrent seated player" above actually was.
           *
           * Carried inside the capacity object rather than left in `settings`, because this is
           * the sentence that decides whether the number means anything. A virtual user at
           * `thinkMs: 0` acts the moment the server asks and reconnects every couple of hands;
           * that is a load shape, not a person, and a reader who takes the player count without
           * it will be wrong in whichever direction they happen to guess.
           */
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

  // Every level whose p99 came from too few samples to be a percentile. Reported rather than
  // suppressed: the figure is still the worst observed round trip, it is just not a p99.
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
    // Never echoed. It is a credential, and a report is exactly the kind of file that gets
    // pasted into an issue.
    if (key === 'metricsToken') {
      out.metricsToken = value === '' ? 'not set' : 'set (not shown)';
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * The standing caveats, carried in the JSON as well as the printed footer.
 *
 * In the report object rather than only in the printed output, because the JSON is what gets
 * pasted into a planning document and a caveat that only exists in a terminal is a caveat that
 * does not exist.
 */
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
const num = (value, digits = 1) => (value === null || value === undefined ? '   -  ' : value.toFixed(digits));
const mib = (bytes) =>
  bytes === null || bytes === undefined ? '  -  ' : `${(bytes / 1048576).toFixed(0)}MiB`;

/**
 * The sample count beside a single figure, in plain text.
 *
 * Deliberately does NOT apply colour: `renderReport` returns the text a test asserts on, and an
 * escape sequence embedded mid-line would make every such assertion depend on whether the test
 * runner happened to be attached to a TTY.
 */
const samplesNote = (count) => `(n=${count ?? 0})`;

/**
 * Renders the report as tagged lines.
 *
 * Returns `{ tone, text }` rather than pre-coloured strings so that the text a test asserts on is
 * the text a reader sees, with no escape sequences in between. `printReport` applies the colour.
 */
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
          `event loop p99 ${ms(level.server.eventLoopP99PeakMs)}, db probe p99 <= ${ms(level.server.dbProbeP99BoundMs)}, ` +
          `${num(level.server.httpRequestsPerSecond)} req/s, ${level.server.scrapes} scrapes`,
      );
    } else {
      lines.push({ tone: 'warn', text: `         ! server-side: ${level.server.note}` });
    }
    if (level.server.gaugeNote != null) {
      lines.push({ tone: 'warn', text: `         ! ${level.server.gaugeNote}` });
    }
    if (level.client.seatTimeouts > 0) {
      // A seat timeout is the server's turn clock acting FOR a player who did not act in time.
      // It is never a neutral fact: those decisions were not the client's, the hand took the
      // full turn clock instead of a round trip, and both the hand rate and the action rate at
      // that level are describing a table that was partly played by the timer.
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
  } else {
    lines.push({ tone: 'warn', text: `  ! ${report.saturation.note}` });
  }
  for (const signal of report.saturation.signals) {
    if (!signal.exported) {
      detail(`      ${signal.name.padEnd(12)} not exported by this build (${signal.metric})`);
      continue;
    }
    const mark = signal.fired ? 'FIRED ' : 'quiet ';
    detail(
      `      ${signal.name.padEnd(12)} ${mark} ${num(signal.observed, 2)} ${signal.unit} ` +
        `(threshold ${signal.limit} ${signal.unit})`,
    );
    // A confounded signal is worse than a missing one: it fires, it is true, and it means
    // something other than what its name says. Say so where the number is, not in a footnote.
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

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

/**
 * Creates every guest session the widest level will need, once.
 *
 * Up front, and reused by every level, for two reasons. A ramp that created accounts per level
 * would spend a growing share of each level's budget on `POST /auth/guest` — measuring signup,
 * not play — and it would hit `RATE_LIMIT_GUEST_MAX`, which is address-keyed and low by design,
 * somewhere in the middle of the ramp for reasons that look like server instability.
 *
 * Sequential rather than parallel: a burst of N simultaneous guest creations from one address is
 * the exact shape the limiter exists to refuse, and a failure in the middle of a parallel burst
 * is much harder to attribute.
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
  // Said before the run rather than diagnosed after it: at a realistic think time a hand costs
  // more wall clock than a short hold has, every level reports "no hand completed", and the run
  // reads as a saturated server when it is a misconfigured harness.
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

  // Fail fast and legibly when the server is not there, rather than reporting a hundred identical
  // connection errors.
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

  // A refused or unreachable /metrics is a hard failure, not a warning. The server-side half of
  // every number below comes from there, and a harness that quietly degraded to client-side
  // timings while still printing "capacity" would be the exact defect this file exists to end.
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

  // The cold-start measurement, taken once and kept out of the ramp. See `warmupSeconds` in
  // DEFAULTS for why this exists at all; the short version is that the first Coach analysis on a
  // fresh process costs seconds of blocked event loop and every one after it costs milliseconds,
  // so leaving it in level 1 fails every run for a reason that has nothing to do with concurrency.
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

  // Non-zero on any threshold breach, any consistency failure, or an unfinished ramp, so this can
  // gate CI unchanged.
  process.exit(report.passed ? 0 : 1);
}

if (import.meta.main) await main();
