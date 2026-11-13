/**
 * The metrics this service exports, and the Fastify plugin that feeds them. `registry.ts` is the
 * mechanism, this file is the policy.
 * 1. No unbounded label. Routes are Fastify route patterns, error codes come from `ERROR_CODES`.
 * 2. Nothing secret or personal (no user, session, room or hand id). Those go to the log line.
 * 3. A gauge that mirrors state owned elsewhere is read at scrape time (`Gauge.setFrom`).
 * Units are seconds everywhere. Millisecond sources are divided at the call site.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ERROR_CODES, type ErrorCode } from '@prl/contracts';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { MetricsRegistry } from './registry.ts';

const PREFIX = 'prl';

/**
 * HTTP latency buckets, in seconds. The alert thresholds (p95 250 ms, p99 1 s) are bucket boundaries
 * so they are counted, not interpolated. A healthy request is a few hundred microseconds.
 */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/**
 * Coach and equity buckets, in seconds. The work is Monte Carlo with a budget of seconds, and the top
 * bucket sits above the default timeout so an abandoned run still lands below `+Inf`.
 */
const ANALYSIS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30] as const;

/**
 * Database probe buckets, in seconds. `select 1` is sub-millisecond, so this mostly measures pool
 * queueing. The timing spans an `await`, so it also includes event-loop delay. Read it beside
 * `prl_event_loop_delay_p99_seconds`. `postgres.js` exposes no hook to time acquisition alone.
 */
const DB_PROBE_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10] as const;

/** Event-loop sampling resolution in ms. It is also the floor `EVENT_LOOP_FLOOR_NS` subtracts. */
const EVENT_LOOP_RESOLUTION_MS = 10;

/**
 * Subtracted from every event-loop sample, in nanoseconds. On an idle loop `monitorEventLoopDelay`
 * reports about the whole sampling interval (measured at 10 ms resolution, mean 10.87 ms, min
 * 10.05 ms), and the offset is additive (a 300 ms block reported 310.9 ms). Delays under the
 * resolution clamp to zero, which understates small delays rather than inventing them.
 */
const EVENT_LOOP_FLOOR_NS = EVENT_LOOP_RESOLUTION_MS * 1_000_000;

function eventLoopSeconds(nanoseconds: number): number {
  return Math.max(0, nanoseconds - EVENT_LOOP_FLOOR_NS) / 1_000_000_000;
}

/** A class rather than the exact code, which would multiply series by about ten for no gain. */
function statusClass(statusCode: number): string {
  if (!Number.isFinite(statusCode) || statusCode < 100 || statusCode > 599) return 'unknown';
  return `${Math.floor(statusCode / 100)}xx`;
}

/**
 * `routeOptions.url` is the matched pattern, so the label set is the set of declared routes. An
 * unmatched request gets `unmatched`, never its URL, so a scanner cannot mint a series per guess.
 */
export function routeLabel(request: FastifyRequest): string {
  const url: unknown = request.routeOptions?.url;
  return typeof url === 'string' && url !== '' ? url : 'unmatched';
}

/** Node accepts arbitrary method tokens on a raw socket, so the label is closed to these. */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export function methodLabel(method: string): string {
  return KNOWN_METHODS.has(method) ? method : 'other';
}

export function errorCodeLabel(code: string): string {
  return (ERROR_CODES as readonly string[]).includes(code) ? code : 'unknown';
}

/** A class so a test can build one and discard it. The process-wide instance is `appMetrics()`. */
export class AppMetrics {
  readonly registry = new MetricsRegistry();

  readonly httpRequests = this.registry.counter({
    name: `${PREFIX}_http_requests_total`,
    help: 'HTTP requests completed, by method, matched route pattern and status class.',
    labelNames: ['method', 'route', 'status'],
  });

  readonly httpDuration = this.registry.histogram(
    {
      name: `${PREFIX}_http_request_duration_seconds`,
      help: 'Wall-clock time from request received to response sent.',
      labelNames: ['method', 'route'],
    },
    HTTP_BUCKETS,
  );

  readonly apiErrors = this.registry.counter({
    name: `${PREFIX}_api_errors_total`,
    help: 'Error responses by contract error code.',
    labelNames: ['code'],
  });

  readonly rateLimitEvents = this.registry.counter({
    name: `${PREFIX}_rate_limit_events_total`,
    help: 'Rate-limit outcomes: limited (429 returned) or banned (over the ban threshold).',
    labelNames: ['kind'],
    // Primed because `increase()` cannot see a rise from a series never scraped. Measured on
    // staging, a real first ban sat at 1 and `RateLimitBans` stayed silent.
    primeLabels: [{ kind: 'limited' }, { kind: 'banned' }],
  });

  readonly authFailures = this.registry.counter({
    name: `${PREFIX}_auth_failures_total`,
    help: 'Authentication failures by reason.',
    labelNames: ['reason'],
  });

  /** Separate from `authFailures`. A spike from authenticated callers means enumeration. */
  readonly authzFailures = this.registry.counter({
    name: `${PREFIX}_authz_failures_total`,
    help: 'Authorisation failures: an authenticated caller refused a resource.',
    labelNames: ['reason'],
  });

  readonly wsConnections = this.registry.gauge({
    name: `${PREFIX}_websocket_connections`,
    help: 'WebSocket connections currently open.',
  });

  readonly wsOpened = this.registry.counter({
    name: `${PREFIX}_websocket_opened_total`,
    help: 'WebSocket connections accepted.',
  });

  readonly wsClosed = this.registry.counter({
    name: `${PREFIX}_websocket_closed_total`,
    help: 'WebSocket connections closed, by close code.',
    labelNames: ['code'],
  });

  readonly wsRefused = this.registry.counter({
    name: `${PREFIX}_websocket_refused_total`,
    help: 'WebSocket upgrades refused before a connection was established, by reason.',
    labelNames: ['reason'],
  });

  readonly wsFramesRejected = this.registry.counter({
    name: `${PREFIX}_websocket_frames_rejected_total`,
    help: 'Inbound WebSocket frames rejected, by reason.',
    labelNames: ['reason'],
  });

  readonly roomsLive = this.registry.gauge({
    name: `${PREFIX}_rooms_live`,
    help: 'Rooms held in memory by this process.',
  });

  /**
   * All three hand counters are primed. `HandCompletionGap` subtracts them, and in PromQL an absent
   * series makes the subtraction empty, so a deployment where no hand ever completed could not page.
   * `HandsFailing` uses `increase()`, which cannot see the first failure on an unprimed series.
   * `reason` is `room_closed` or `interrupted_by_restart`, both set in `rooms/registry.ts`.
   */
  readonly handsStarted = this.registry.counter({
    name: `${PREFIX}_hands_started_total`,
    help: 'Hands dealt.',
    primeLabels: [{}],
  });

  readonly handsCompleted = this.registry.counter({
    name: `${PREFIX}_hands_completed_total`,
    help: 'Hands that reached a settled result.',
    primeLabels: [{}],
  });

  /** An archive write failing is not a failed hand. Play continues, and it has its own counter. */
  readonly handsFailed = this.registry.counter({
    name: `${PREFIX}_hands_failed_total`,
    help: 'Hands abandoned without a settled result, by reason.',
    labelNames: ['reason'],
    primeLabels: [{ reason: 'room_closed' }, { reason: 'interrupted_by_restart' }],
  });

  /** A stuck seat actor stalls a table without erroring anywhere. */
  readonly tableActorFailures = this.registry.counter({
    name: `${PREFIX}_table_actor_failures_total`,
    help: 'A seat actor (bot or timer) failed to produce an action, by reason.',
    labelNames: ['reason'],
  });

  readonly archiveFailures = this.registry.counter({
    name: `${PREFIX}_archive_failures_total`,
    help: 'Hand-archive writes that failed. Play continues; history is incomplete.',
    // Primed. `ArchiveFailing` is zero-tolerance and nothing else shows this failure.
    primeLabels: [{}],
  });

  /**
   * A failed durable release of `room_members.seat` after a hand settles (`LiveRoom.releaseDeparted`).
   * Nothing retries, and the room summary advertises a chair the database refuses. Not a label on
   * `archiveFailures`, whose runbook is about hand history. Not substitutable by
   * `api_errors{code="seat_taken"}`, which two players racing for a chair also produce. Counted in
   * seats. Primed.
   */
  readonly seatReleaseFailures = this.registry.counter({
    name: `${PREFIX}_seat_release_failures_total`,
    help: 'Durable seat releases that failed. The chair stays occupied by a player who has left.',
    primeLabels: [{}],
  });

  /**
   * A second process tried to open a room this one serves, and `prl.room_ownership` refused it. That
   * means two API processes share one database (`rooms/ownership.ts`, `replicas: 1`). Counts
   * refusals, not refused requests, unlike `api_errors{code="room_owned_elsewhere"}`. Primed.
   */
  readonly roomOwnershipRefusals = this.registry.counter({
    name: `${PREFIX}_room_ownership_refusals_total`,
    help: 'Room opens refused because another live API process holds the room lease.',
    primeLabels: [{}],
  });

  /**
   * This process lost the lease on a room it was serving and evicted it, so two processes were both
   * authoritative for a window. `fenced` means another process took it (fix the deployment).
   * `lease_expired` means renewal failed here (database or scheduling). Both primed.
   */
  readonly roomFencings = this.registry.counter({
    name: `${PREFIX}_room_fencings_total`,
    help: 'Live rooms evicted because this process no longer holds their lease, by reason.',
    labelNames: ['reason'],
    primeLabels: [{ reason: 'fenced' }, { reason: 'lease_expired' }],
  });

  /**
   * Moves only under `PRL_ENROLMENT_REQUIRED=enforced`. Primed so the first refusal is visible.
   * `not_entitled` is a learner refused a seat now. `seat_not_restored` is a chair not given back on
   * reopen because its holder lost entitlement, and can move with nobody using the product. Not
   * substitutable by `api_errors{code="enrolment_required"}`, which misses socket refusals and
   * `seat_not_restored`.
   */
  readonly seatEntitlementRefusals = this.registry.counter({
    name: `${PREFIX}_seat_entitlement_refusals_total`,
    help: 'Seats refused because the learner holds no live enrolment, by how the seat was reached.',
    labelNames: ['reason'],
    primeLabels: [{ reason: 'not_entitled' }, { reason: 'seat_not_restored' }],
  });

  /**
   * Primed so a quiet deployment renders zeros rather than "no data". `abandoned_guests` counts
   * accounts, not rows. Values name what was removed, not the table, and must stay clear of
   * `ID_PREFIXES` (`observability-metrics.test.ts` rejected `oidc_login_attempts` as an id).
   */
  readonly retentionRowsDeleted = this.registry.counter({
    name: `${PREFIX}_retention_rows_deleted_total`,
    help: 'Rows removed by the scheduled retention sweep, by kind. Guests are counted as accounts.',
    labelNames: ['kind'],
    primeLabels: [
      { kind: 'expired_sessions' },
      { kind: 'expired_login_attempts' },
      { kind: 'abandoned_guests' },
    ],
  });

  /**
   * Age of the last successful sweep. A flat deletion counter cannot tell "nothing to remove" from
   * "nothing ran", so `RetentionSweepStalled` alerts on this.
   * - An age, not a timestamp, so the scraper's clock never enters the subtraction.
   * - Before the first sweep it counts from process start, so a restart does not page.
   * - That is safe only because the first sweep runs at `FIRST_SWEEP_DELAY_MS` (60 s), so a
   *   restart pattern that hides a dead sweep trips `ProcessRestartLoop`. Pinned in
   *   `test/retention-sweep.test.ts`.
   * It cannot say whether the previous process swept.
   */
  readonly retentionSweepAge = this.registry.gauge({
    name: `${PREFIX}_retention_sweep_age_seconds`,
    help: 'Seconds since the last successful retention sweep, or since process start if none.',
  });

  readonly analysisDuration = this.registry.histogram(
    {
      name: `${PREFIX}_analysis_duration_seconds`,
      help: 'End-to-end time for one Coach or equity analysis, including time queued.',
      labelNames: ['kind'],
    },
    ANALYSIS_BUCKETS,
  );

  readonly analysisOutcomes = this.registry.counter({
    name: `${PREFIX}_analysis_total`,
    help: 'Analyses by kind and outcome (ok, timeout, rejected, failed).',
    labelNames: ['kind', 'outcome'],
  });

  /** Read at scrape time. No utilisation ratio, because a ratio cannot aggregate across processes. */
  readonly workerPoolSize = this.registry.gauge({
    name: `${PREFIX}_worker_pool_size`,
    help: 'Maximum worker threads this pool may run.',
  });

  readonly workerPoolWorkers = this.registry.gauge({
    name: `${PREFIX}_worker_pool_threads`,
    help: 'Worker threads currently spawned.',
  });

  readonly workerPoolBusy = this.registry.gauge({
    name: `${PREFIX}_worker_pool_busy`,
    help: 'Worker threads currently running a task.',
  });

  readonly workerPoolQueued = this.registry.gauge({
    name: `${PREFIX}_worker_pool_queued`,
    help: 'Tasks waiting for a worker thread.',
  });

  readonly workerTasks = this.registry.counter({
    name: `${PREFIX}_worker_tasks_total`,
    help: 'Worker tasks by terminal outcome (completed, failed, timed_out, rejected).',
    labelNames: ['outcome'],
  });

  readonly dbProbeDuration = this.registry.histogram(
    {
      name: `${PREFIX}_db_probe_duration_seconds`,
      help: 'Time for the readiness probe to acquire a pooled connection and run select 1.',
    },
    DB_PROBE_BUCKETS,
  );

  readonly dbPoolMax = this.registry.gauge({
    name: `${PREFIX}_db_pool_max`,
    help: 'Configured upper bound on pooled connections for this process.',
  });

  readonly dbErrors = this.registry.counter({
    name: `${PREFIX}_db_errors_total`,
    help: 'Database operations that failed, by category.',
    labelNames: ['category'],
  });

  /**
   * A start timestamp, because a restart counter resets on the event it records. Set once, the one
   * exception to rule 3. Re-deriving it per scrape from `Date.now()` and `process.uptime()` wobbled
   * across a second boundary (4.5 ms spread measured), and `ProcessRestartLoop` counted it as restarts.
   */
  readonly processStart = this.registry.gauge({
    name: `${PREFIX}_process_start_time_seconds`,
    help: 'Unix time at which this process started.',
  });

  readonly residentMemory = this.registry.gauge({
    name: `${PREFIX}_process_resident_memory_bytes`,
    help: 'Resident set size of this process.',
  });

  readonly heapUsed = this.registry.gauge({
    name: `${PREFIX}_process_heap_used_bytes`,
    help: 'V8 heap in use.',
  });

  readonly cpuSeconds = this.registry.counter({
    name: `${PREFIX}_process_cpu_seconds_total`,
    help: 'Cumulative user plus system CPU time consumed by this process.',
  });

  /**
   * Gauges, not a histogram, because the source is already a native histogram. The window resets
   * on every scrape, so each sample covers the interval since the last scrape.
   */
  readonly eventLoopMean = this.registry.gauge({
    name: `${PREFIX}_event_loop_delay_seconds`,
    help: 'Mean event-loop delay since the previous scrape.',
  });

  readonly eventLoopP99 = this.registry.gauge({
    name: `${PREFIX}_event_loop_delay_p99_seconds`,
    help: '99th percentile event-loop delay since the previous scrape.',
  });

  readonly eventLoopMax = this.registry.gauge({
    name: `${PREFIX}_event_loop_delay_max_seconds`,
    help: 'Longest event-loop delay observed since the previous scrape.',
  });

  readonly readinessState = this.registry.gauge({
    name: `${PREFIX}_readiness_state`,
    help: 'Readiness of this instance: 1 ready, 0 degraded.',
  });

  readonly readinessFailures = this.registry.counter({
    name: `${PREFIX}_readiness_failures_total`,
    help: 'Readiness checks that reported degraded.',
  });

  readonly metricsSeries = this.registry.gauge({
    name: `${PREFIX}_metrics_series`,
    help: 'Live time series held by this process. A plateau at the cap means labels overflowed.',
  });

  readonly metricsOverflow = this.registry.gauge({
    name: `${PREFIX}_metrics_cardinality_overflow`,
    help: '1 if any metric has folded label combinations into an overflow series.',
  });

  /** Never stopped. It is a libuv timer and does not hold the loop open. */
  private readonly eventLoop = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });

  private lastCpu = process.cpuUsage();

  /** Epoch ms of the last sweep, or null so "not yet" falls back to process start, not 1970. */
  private lastRetentionSweepMs: number | null = null;

  constructor() {
    this.eventLoop.enable();
    this.processStart.set({}, Math.floor(Date.now() / 1000 - process.uptime()));
    this.retentionSweepAge.setFrom(() => {
      const since = this.lastRetentionSweepMs ?? Date.now() - process.uptime() * 1_000;
      // Clamped so a clock stepped backwards renders zero, not a negative age.
      return Math.max(0, Math.floor((Date.now() - since) / 1_000));
    });
    this.registry.onCollect(() => this.sampleProcess());
  }

  /**
   * Called from the sweep's `onSwept`, so the sweep's unit tests never build the singleton. A
   * failed sweep must never reach this, so the age gauge reports the last sweep that finished.
   */
  markRetentionSweep(removed: {
    readonly sessions: number;
    readonly loginAttempts: number;
    readonly guestAccounts: number;
  }): void {
    this.retentionRowsDeleted.inc({ kind: 'expired_sessions' }, removed.sessions);
    this.retentionRowsDeleted.inc({ kind: 'expired_login_attempts' }, removed.loginAttempts);
    this.retentionRowsDeleted.inc({ kind: 'abandoned_guests' }, removed.guestAccounts);
    this.lastRetentionSweepMs = Date.now();
  }

  /** Runs on every scrape. Nothing here may throw, because the registry swallows it silently. */
  private sampleProcess(): void {
    const memory = process.memoryUsage();
    this.residentMemory.set({}, memory.rss);
    this.heapUsed.set({}, memory.heapUsed);

    // `cpuUsage(previous)` is a delta in microseconds, which keeps the `_total` monotonic.
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    this.cpuSeconds.inc({}, (cpu.user + cpu.system) / 1_000_000);

    // An empty window reports 0 mean and a sentinel min, so `count` is checked first.
    if (this.eventLoop.count > 0) {
      this.eventLoopMean.set({}, eventLoopSeconds(this.eventLoop.mean));
      this.eventLoopP99.set({}, eventLoopSeconds(this.eventLoop.percentile(99)));
      this.eventLoopMax.set({}, eventLoopSeconds(this.eventLoop.max));
    }
    // Without a reset, one stall at boot pins the max forever.
    this.eventLoop.reset();

    this.metricsSeries.set({}, this.registry.totalSeries());
    this.metricsOverflow.set({}, this.registry.anyOverflowed() ? 1 : 0);
  }

  render(): string {
    return this.registry.render();
  }
}

/** Lazy, so importing this module does not start an event-loop monitor. */
let shared: AppMetrics | null = null;

export function appMetrics(): AppMetrics {
  shared ??= new AppMetrics();
  return shared;
}

export function metricsConfigured(): boolean {
  return shared !== null;
}

/** For tests, which build several apps in one process. */
export function resetAppMetricsForTests(): void {
  shared = null;
}

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsPluginOptions {
  readonly metrics?: AppMetrics;
}

/**
 * `onResponse`, not `onSend`, so the duration includes serialisation and the socket write.
 * `reply.elapsedTime` is the access log's clock. `skip-override` puts the hook on the registering
 * instance (see `plugins/request-context.ts`).
 */
export const metricsPlugin: FastifyPluginCallback<MetricsPluginOptions> = (app, options, done) => {
  const metrics = options.metrics ?? appMetrics();

  app.addHook('onResponse', (request, reply, next) => {
    const method = methodLabel(request.method);
    const route = routeLabel(request);
    const status = reply.statusCode;
    metrics.httpRequests.inc({ method, route, status: statusClass(status) });
    metrics.httpDuration.observe({ method, route }, reply.elapsedTime / 1_000);
    if (status === 429) metrics.rateLimitEvents.inc({ kind: 'limited' });
    next();
  });

  done();
};

Object.defineProperty(metricsPlugin, Symbol.for('skip-override'), { value: true });

/**
 * Called from `errors.ts` with the contract code, which carries more than the status.
 * `not_room_member` and `room_full` are both 403, and only one suggests enumeration.
 */
export function recordApiError(code: ErrorCode, metrics: AppMetrics = appMetrics()): void {
  metrics.apiErrors.inc({ code: errorCodeLabel(code) });
  if (code === 'not_authenticated' || code === 'session_expired' || code === 'csrf_failed') {
    metrics.authFailures.inc({ reason: code });
  } else if (
    code === 'forbidden' ||
    code === 'not_room_member' ||
    code === 'room_not_found_or_not_permitted'
  ) {
    metrics.authzFailures.inc({ reason: code });
  }
}

/** Takes a getter, so a pool created later or replaced is still the one read at scrape time. */
export function bindWorkerPoolMetrics(
  stats: () => {
    readonly size: number;
    readonly workers: number;
    readonly busy: number;
    readonly queued: number;
  },
  metrics: AppMetrics = appMetrics(),
): void {
  metrics.registry.onCollect(() => {
    const snapshot = stats();
    metrics.workerPoolSize.set({}, snapshot.size);
    metrics.workerPoolWorkers.set({}, snapshot.workers);
    metrics.workerPoolBusy.set({}, snapshot.busy);
    metrics.workerPoolQueued.set({}, snapshot.queued);
  });
}
