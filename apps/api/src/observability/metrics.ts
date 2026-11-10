/**
 * The metrics this service actually exports, and the Fastify plugin that feeds them.
 *
 * `registry.ts` is the mechanism; this file is the policy. Every metric below exists because
 * an operator needs it to answer a specific question during an incident, and each one names
 * that question. A metric nobody would page on, graph, or quote in a post-mortem is not worth
 * the cardinality it costs, so there are deliberately fewer of these than the instrumentation
 * a framework would emit by default.
 *
 * ## The three rules this file follows
 *
 * 1. **No metric may carry an unbounded label.** The route label is the Fastify *route
 *    pattern* (`/rooms/:roomId`), never the URL, so a caller cannot mint series by varying an
 *    id. Error codes come from the closed `ERROR_CODES` union. Close codes are integers from
 *    `WS_CLOSE`. See `routeLabel` below for the one place a URL is touched.
 * 2. **No metric may carry anything secret or personally identifying.** Metrics are scraped
 *    into a store with weaker access control than the database and a longer retention — the
 *    same sentence `logging.ts` opens with. There is no user id, no session id, no client key,
 *    no room id and no hand id anywhere in this file. Those belong in a log line, correlated
 *    by request id, where retention and access are governed.
 * 3. **A gauge that mirrors state owned elsewhere is read at scrape time**, never written on
 *    change. See `Gauge.setFrom` in `registry.ts` for why.
 *
 * ## Why `/metrics` is on the API and not a sidecar
 *
 * Everything worth measuring here — event-loop lag, worker-pool depth, live socket count — is
 * process-local state that only this process can see. A sidecar could scrape the same numbers
 * only by being told them, which is the same code with an extra hop and an extra failure mode.
 *
 * ## Units
 *
 * Seconds, everywhere, because that is what the exposition format's conventions and every
 * `histogram_quantile` example assume. Millisecond-valued sources are divided at the call
 * site, never stored as milliseconds under a `_seconds` name.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { ERROR_CODES, type ErrorCode } from '@prl/contracts';
import type { FastifyPluginCallback, FastifyRequest } from 'fastify';
import { MetricsRegistry } from './registry.ts';

/** Prefix on every metric, so a shared Prometheus can tell this service from another. */
const PREFIX = 'prl';

/**
 * Latency buckets for HTTP requests, in seconds.
 *
 * Chosen so the numbers the alert rules use are *counted* rather than interpolated: the
 * warning threshold for p95 (250 ms) and the paging threshold for p99 (1 s) are both bucket
 * boundaries. See the note on `Histogram` in `registry.ts` for why that matters. The low end
 * goes to 5 ms because a healthy request here is a few hundred microseconds of JSON, and a
 * histogram whose first bucket already holds everything cannot show a regression.
 */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/**
 * Latency buckets for Coach and equity work, in seconds.
 *
 * A different shape from HTTP on purpose. This work is Monte Carlo on a worker thread with a
 * wall-clock budget (`config.coachTimeoutMs`, default measured in seconds), so the interesting
 * region is hundreds of milliseconds to a few seconds and the sub-10 ms buckets HTTP needs
 * would all be empty. The top bucket sits above the default timeout so a run that was
 * abandoned still lands somewhere countable rather than only in `+Inf`.
 */
const ANALYSIS_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30] as const;

/**
 * Buckets for the database liveness probe, in seconds.
 *
 * `select 1` against a healthy pool is sub-millisecond. What this histogram is mostly measuring
 * is *pool queueing*: when every pooled connection is busy, the probe waits for one, so a probe
 * that used to take 0.4 ms and now takes 200 ms is pool exhaustion with no other symptom yet.
 * That is why the buckets stretch to 10 s even though the happy path is three orders of
 * magnitude below the first one.
 *
 * ## It is not ONLY pool queueing, and the difference was measured
 *
 * The timing in `/ready` spans an `await`, so any event-loop delay landing between the query
 * completing and the handler resuming is inside the figure too. With the pre-fix blocking review
 * path, one probe in 480 landed in the (0.5, 1] s bucket against a completely idle database.
 * After the Coach and review moved to the worker pool, 630 consecutive probes under the same
 * load were all under 50 ms, mean 1.8 ms.
 *
 * So: a reading here is "pool wait plus whatever loop delay followed it", and a large one is
 * genuinely ambiguous between the two. Read it beside `prl_event_loop_delay_p99_seconds`, which
 * is what `runbooks/db-saturation.md` and `runbooks/worker-saturation.md` both instruct — and
 * note that the ambiguity only bites when the loop is ALSO blocked, which is itself a paging
 * condition with its own alert. Timing only the acquisition would need a hook `postgres.js` does
 * not expose; measuring what can actually be measured and stating its limits beats inventing a
 * number that sounds cleaner.
 */
const DB_PROBE_BUCKETS = [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10] as const;

/**
 * How often the event-loop delay histogram is sampled, in milliseconds.
 *
 * `monitorEventLoopDelay` samples continuously in libuv at this resolution and costs
 * essentially nothing; 10 ms is fine enough to see a blocking call that a 100 ms resolution
 * would average away, and coarse enough that the histogram is not itself a workload (100
 * samples a second, each one an integer added to a native histogram).
 *
 * The value is also the floor that `EVENT_LOOP_FLOOR_NS` subtracts, so it is deliberately
 * small: whatever the subtraction cannot resolve is lost, and 10 ms of event-loop delay is
 * nothing anyone would act on.
 */
const EVENT_LOOP_RESOLUTION_MS = 10;

/**
 * What is subtracted from every event-loop sample, in nanoseconds.
 *
 * ## Why a correction is needed at all
 *
 * `monitorEventLoopDelay` does not report the *excess* delay its name suggests. On an
 * otherwise idle loop it reports approximately the whole sampling interval, because libuv's
 * poll phase blocks until the monitor's own timer is the next thing due — so the timer is
 * "late" by the interval it was scheduled for. Measured on this platform, with nothing else
 * running:
 *
 *   resolution  5 ms -> mean 5.64 ms, min 4.54 ms   (212 samples in 1.2 s)
 *   resolution 10 ms -> mean 10.87 ms, min 10.05 ms (110 samples)
 *   resolution 20 ms -> mean 20.94 ms, min 20.15 ms  (57 samples)
 *
 * Uncorrected, a perfectly healthy process would export 20 ms of "event-loop delay" and an
 * operator would spend an incident chasing it. That is the specific failure this constant
 * exists to prevent: a metric that is confidently wrong is worse than one that is missing.
 *
 * ## Why subtraction is the right correction
 *
 * The offset is additive, which the same measurements show at the other end of the range: a
 * deliberate 300 ms synchronous block at a 10 ms resolution reported a maximum of 310.9 ms.
 * Subtracting the interval recovers the number the metric name promises, at both ends.
 *
 * ## What it costs
 *
 * Real delays smaller than the resolution clamp to zero. That is accepted: the question this
 * metric answers is "is the loop blocked", the alert threshold is 250 ms, and nobody acts on
 * 8 ms. The correction is also a floor rather than a calibration — when the loop is busy the
 * monitor's timer is woken early by other work and the raw floor drops towards zero, so this
 * subtraction is conservative there, understating small delays rather than inventing them.
 * Understating a small number is the safe direction; overstating an idle one is not.
 */
const EVENT_LOOP_FLOOR_NS = EVENT_LOOP_RESOLUTION_MS * 1_000_000;

/** One event-loop sample in nanoseconds, corrected and converted to seconds. */
function eventLoopSeconds(nanoseconds: number): number {
  return Math.max(0, nanoseconds - EVENT_LOOP_FLOOR_NS) / 1_000_000_000;
}

/**
 * Status class for a response code: `2xx`, `4xx`, `5xx`.
 *
 * A class rather than the exact code, because the exact code multiplies the series count by
 * roughly ten for no operational gain — what an alert asks is "are we serving errors", and the
 * specific code for a given failure is in the log line and in `prl_api_errors_total`.
 */
function statusClass(statusCode: number): string {
  if (!Number.isFinite(statusCode) || statusCode < 100 || statusCode > 599) return 'unknown';
  return `${Math.floor(statusCode / 100)}xx`;
}

/**
 * The route label for a request.
 *
 * `request.routeOptions.url` is the *pattern* Fastify matched (`/api/v1/rooms/:roomId`), so
 * the label's value set is exactly the set of declared routes — bounded, stable across
 * deploys, and free of ids. This is the one function in this file that decides a label from a
 * request, and it is the reason `registry.ts`'s cardinality cap is a net rather than the
 * primary defence.
 *
 * A request that matched no route (a 404, a probe, a scanner) has no pattern. It gets the
 * fixed string `unmatched` rather than its URL — a scanner walking a wordlist is precisely the
 * caller who would otherwise mint one series per path it guesses.
 */
export function routeLabel(request: FastifyRequest): string {
  const url: unknown = request.routeOptions?.url;
  return typeof url === 'string' && url !== '' ? url : 'unmatched';
}

/**
 * The method label.
 *
 * Constrained to the methods this API declares. Node parses arbitrary tokens as methods on a
 * raw socket, so without this an attacker could mint a series per invented verb.
 */
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

/** Narrows an arbitrary string to a declared error code, so the label set stays closed. */
export function errorCodeLabel(code: string): string {
  return (ERROR_CODES as readonly string[]).includes(code) ? code : 'unknown';
}

/**
 * Everything this process exports, built once.
 *
 * A class rather than a bag of module-level constants so that a test can construct one,
 * assert on it and discard it. The process-wide instance is `appMetrics()` below.
 */
export class AppMetrics {
  readonly registry = new MetricsRegistry();

  // --- HTTP ----------------------------------------------------------------
  /** "Are we serving errors, and to which route?" */
  readonly httpRequests = this.registry.counter({
    name: `${PREFIX}_http_requests_total`,
    help: 'HTTP requests completed, by method, matched route pattern and status class.',
    labelNames: ['method', 'route', 'status'],
  });

  /** "What is p50/p95/p99, and did this deploy move it?" */
  readonly httpDuration = this.registry.histogram(
    {
      name: `${PREFIX}_http_request_duration_seconds`,
      help: 'Wall-clock time from request received to response sent.',
      labelNames: ['method', 'route'],
    },
    HTTP_BUCKETS,
  );

  /** "Which contract error is being returned?" Closed label set; see `errorCodeLabel`. */
  readonly apiErrors = this.registry.counter({
    name: `${PREFIX}_api_errors_total`,
    help: 'Error responses by contract error code.',
    labelNames: ['code'],
  });

  /** "Is somebody being rate limited, and are they being banned for ignoring it?" */
  readonly rateLimitEvents = this.registry.counter({
    name: `${PREFIX}_rate_limit_events_total`,
    help: 'Rate-limit outcomes: limited (429 returned) or banned (over the ban threshold).',
    labelNames: ['kind'],
    // Both values, from boot. `RateLimitBans` fires on `increase(...{kind="banned"}[15m]) > 0`,
    // and without a zero to rise from the FIRST ban is invisible to it — measured against
    // staging, where a real ban sat in the counter at 1 and the rule stayed silent. See
    // `primeLabels` in registry.ts. The set is closed and has two members.
    primeLabels: [{ kind: 'limited' }, { kind: 'banned' }],
  });

  /** "Are sign-ins failing?" Reason comes from a closed set at the call site. */
  readonly authFailures = this.registry.counter({
    name: `${PREFIX}_auth_failures_total`,
    help: 'Authentication failures by reason.',
    labelNames: ['reason'],
  });

  /**
   * "Is somebody probing for other people's rooms and hands?"
   *
   * Separate from `authFailures` because the two mean different things operationally: a spike
   * in authentication failures is usually a broken client or a credential-stuffing run, while
   * a spike in authorisation failures from *authenticated* callers is enumeration.
   */
  readonly authzFailures = this.registry.counter({
    name: `${PREFIX}_authz_failures_total`,
    help: 'Authorisation failures: an authenticated caller refused a resource.',
    labelNames: ['reason'],
  });

  // --- WebSockets ----------------------------------------------------------
  /** "How many people are at a table right now?" Read at scrape time from the hub. */
  readonly wsConnections = this.registry.gauge({
    name: `${PREFIX}_websocket_connections`,
    help: 'WebSocket connections currently open.',
  });

  /** "Are clients reconnecting in a loop?" Compare the rate of these two. */
  readonly wsOpened = this.registry.counter({
    name: `${PREFIX}_websocket_opened_total`,
    help: 'WebSocket connections accepted.',
  });

  readonly wsClosed = this.registry.counter({
    name: `${PREFIX}_websocket_closed_total`,
    help: 'WebSocket connections closed, by close code.',
    labelNames: ['code'],
  });

  /** "Was the upgrade refused, and why?" Origin, auth, and capacity are different incidents. */
  readonly wsRefused = this.registry.counter({
    name: `${PREFIX}_websocket_refused_total`,
    help: 'WebSocket upgrades refused before a connection was established, by reason.',
    labelNames: ['reason'],
  });

  /** "Is a client sending frames we cannot parse?" Malformed traffic, separated from errors. */
  readonly wsFramesRejected = this.registry.counter({
    name: `${PREFIX}_websocket_frames_rejected_total`,
    help: 'Inbound WebSocket frames rejected, by reason.',
    labelNames: ['reason'],
  });

  // --- Tables and hands ----------------------------------------------------
  /** "How many tables are live in this process?" */
  readonly roomsLive = this.registry.gauge({
    name: `${PREFIX}_rooms_live`,
    help: 'Rooms held in memory by this process.',
  });

  /**
   * All three hand counters are PRIMED, and the reason is the rule that reads them together.
   *
   * `HandCompletionGap` is the invariant `started = completed + failed + in flight`, evaluated as
   * a subtraction. In PromQL a series that has never been incremented is not zero, it is ABSENT,
   * and `A - absent` is the empty vector — so on a deployment where no hand has ever completed,
   * which is exactly the catastrophe the rule exists for, the alert could not fire at all. Primed,
   * the same catastrophe renders `started 40, completed 0, failed 0` and the subtraction is 40.
   *
   * `handsFailed` needs it for the second, independent reason: `HandsFailing` is
   * `increase(...) > 0`, and `increase()` is computed only from samples inside its range. A
   * counter that appears mid-window at 3 has an increase of 0, because Prometheus does not assume
   * a series began at zero before it was first scraped — so the FIRST failed hand, which is the
   * one a zero-tolerance page is entirely about, was invisible to it. Same argument, same
   * measurement, as `rateLimitEvents{kind="banned"}`; and `rooms/registry.ts` increments this
   * once, by `abandoned.length`, which is precisely the single step that shape hides.
   *
   * `reason` is a closed set of two, both named at their call sites in `rooms/registry.ts`:
   * `room_closed` (a hand in progress when its room shut) and `interrupted_by_restart` (hands a
   * restart abandoned, closed when the room is next opened). Both are primed, because an alert
   * cannot see a rise from a series that was never scraped and either one may be the first.
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

  /**
   * "Did a hand end in a way that was not a result?"
   *
   * The gap between started and completed is the number that matters, and this counter names
   * the reason for it. An archive write failing is not a failed hand — play continues by
   * design (`rooms/registry.ts`) — so that has its own counter below.
   */
  readonly handsFailed = this.registry.counter({
    name: `${PREFIX}_hands_failed_total`,
    help: 'Hands abandoned without a settled result, by reason.',
    labelNames: ['reason'],
    primeLabels: [{ reason: 'room_closed' }, { reason: 'interrupted_by_restart' }],
  });

  /** "Is a bot seat failing to act?" A stuck actor stalls a table without erroring anywhere. */
  readonly tableActorFailures = this.registry.counter({
    name: `${PREFIX}_table_actor_failures_total`,
    help: 'A seat actor (bot or timer) failed to produce an action, by reason.',
    labelNames: ['reason'],
  });

  /** "Are hands being persisted?" Play continues when this fires, so nothing else shows it. */
  readonly archiveFailures = this.registry.counter({
    name: `${PREFIX}_archive_failures_total`,
    help: 'Hand-archive writes that failed. Play continues; history is incomplete.',
    // No labels, so there is exactly one series and priming it is unambiguous. `ArchiveFailing`
    // is zero-tolerance (`rate(...[15m]) > 0`) and this is the metric whose whole point is that
    // nothing else shows the failure — play deliberately continues when an archive write fails.
    // A first failure that its own alert cannot see is the worst version of that.
    primeLabels: [{}],
  });

  /**
   * "Is a chair stuck holding somebody who has already left?"
   *
   * A seat is released when the hand it was in SETTLES, not when its player asked to leave, and
   * the durable write that frees `room_members.seat` hangs off that settlement
   * (`LiveRoom.releaseDeparted`). When that write fails there is nothing else to see it: the room
   * summary is built from the live table, which has already dropped the chair, so it advertises a
   * seat the database will refuse — and nothing retries, so it stays refused for the life of the
   * process. The first a human hears of it is a learner who cannot sit down.
   *
   * Its own metric rather than a label on `archiveFailures`, which is where this used to report
   * for want of an event name of its own. `ArchiveFailing` is zero-tolerance and its runbook is
   * about hand history: an operator paged by it for a stuck chair is being sent to the wrong
   * subsystem with the wrong instructions.
   *
   * NOT substitutable by `prl_api_errors_total{code="seat_taken"}`. That is what the failure looks
   * like from the outside, and it is indistinguishable from two people legitimately racing for the
   * same chair — which is a normal thing that happens and must not page anybody.
   *
   * Counted in seats rather than in failures, because "three chairs are stuck" and "one release
   * pass failed" are different sizes of incident. No labels, so priming is unambiguous; primed
   * for the reason `archiveFailures` is, so that the first stuck chair is a rise from zero.
   */
  readonly seatReleaseFailures = this.registry.counter({
    name: `${PREFIX}_seat_release_failures_total`,
    help: 'Durable seat releases that failed. The chair stays occupied by a player who has left.',
    primeLabels: [{}],
  });

  /**
   * "Did a SECOND process try to open a room this one is serving?"
   *
   * The guard working, and the only thing that reports it. `prl.room_ownership` refuses the open,
   * so no hand is corrupted and no learner loses a chip — but a refusal means two API processes are
   * pointed at one database, which the whole live-table design forbids (`rooms/ownership.ts`, and
   * `deploy.replicas: 1` in `docker-compose.staging.yml`). Every refusal is a configuration that
   * will keep producing them.
   *
   * NOT substitutable by `prl_api_errors_total{code="room_owned_elsewhere"}`, which counts the
   * REQUESTS refused rather than the refusals: one misconfigured process retrying a busy room
   * produces hundreds of the former from one of the latter, and the two answer different questions
   * — "how many learners were affected" and "how many times did a process try to take a room it
   * must not have".
   *
   * No labels, so priming is unambiguous; primed for the reason `archiveFailures` is, because the
   * alert on it is zero-tolerance and the FIRST refusal is exactly the one worth seeing.
   */
  readonly roomOwnershipRefusals = this.registry.counter({
    name: `${PREFIX}_room_ownership_refusals_total`,
    help: 'Room opens refused because another live API process holds the room lease.',
    primeLabels: [{}],
  });

  /**
   * "Did this process lose a room it was already serving?"
   *
   * The far worse half. A refusal means the guard caught a second process BEFORE it dealt anything.
   * A fencing means this process was serving a room, lost the lease, and has had to evict it — so
   * for some window bounded by the heartbeat interval, two processes were both authoritative for one
   * room's hand state. That is the corruption itself, not a near miss: the hand in this process's
   * memory can never settle, and if the other process settled its own version of it the stacks that
   * hit `room_members` are not the ones anybody played for.
   *
   * The `reason` label separates the two ways it happens, because they send an operator to
   * different places. `fenced` means somebody actively took the room — a second replica, an
   * overlapping deploy — and the fix is the deployment. `lease_expired` means this process could not
   * renew for longer than the lease allows and stepped down of its own accord, which is a database
   * or scheduling problem here rather than a second process anywhere. A closed set of two, so both
   * are primed: an alert keyed on `increase()` cannot see a rise from a series that never existed.
   */
  readonly roomFencings = this.registry.counter({
    name: `${PREFIX}_room_fencings_total`,
    help: 'Live rooms evicted because this process no longer holds their lease, by reason.',
    labelNames: ['reason'],
    primeLabels: [{ reason: 'fenced' }, { reason: 'lease_expired' }],
  });

  // --- Entitlement ---------------------------------------------------------
  /**
   * "Is anybody being turned away from a seat, and how?"
   *
   * Only ever moves on a deployment running `PRL_ENROLMENT_REQUIRED=enforced`. On an open public
   * instance it sits at zero forever, which is the correct reading and is exactly why it is
   * PRIMED: a counter series is created by its first increment, so an unprimed one is absent from
   * every scrape until the first refusal, and `increase(...[1h])` over a series that has never
   * been scraped sees no rise — it has nothing to subtract from. The first refusal is the one an
   * operator most wants to see (a class list that missed somebody, on the morning of the class),
   * and it is precisely the one an unprimed counter hides. Same argument, same measurement, as
   * `rateLimitEvents{kind="banned"}`.
   *
   * The two reasons are different operator questions and must not be summed blindly:
   *
   *   * `not_entitled` — somebody asked for a seat and was told no. That is a person at a keyboard
   *     right now, and a spike of it on the hour a cohort starts means the class list is wrong.
   *   * `seat_not_restored` — a room was re-opened after a restart and a chair recorded in
   *     `room_members` was NOT given back, because whoever was sitting in it is no longer
   *     entitled. Nobody is being refused anything they just asked for; an expiry or a revocation
   *     took effect at the next restart rather than at the moment of the write. It is worth
   *     separating because it is the only one that can move with nobody using the product.
   *
   * NOT substitutable by `prl_api_errors_total{code="enrolment_required"}`: that counts REST
   * responses, so it misses every socket refusal (a `sit` frame is answered with an error FRAME
   * and no HTTP status) and misses `seat_not_restored` entirely, which no request ever sees.
   *
   * No identifier here, rule 2 at the top of this file. Which learner, which room and which seat
   * go to the log line beside it.
   */
  readonly seatEntitlementRefusals = this.registry.counter({
    name: `${PREFIX}_seat_entitlement_refusals_total`,
    help: 'Seats refused because the learner holds no live enrolment, by how the seat was reached.',
    labelNames: ['reason'],
    primeLabels: [{ reason: 'not_entitled' }, { reason: 'seat_not_restored' }],
  });

  // --- Retention -----------------------------------------------------------
  /**
   * "Is the retention promise being kept, and by how much?"
   *
   * One series per thing the sweep removes, and the label set is closed by the sweep itself —
   * there are three and adding a fourth is a code change, not a caller's choice. All three are
   * primed at zero because the honest reading of this counter is a rate of change, and
   * `increase()` cannot see a rise from a series that was never scraped: without priming, the
   * first deployment quiet enough to have nothing to sweep would render nothing at all, and a
   * dashboard would say "no data" for the metric whose entire purpose is to be evidence that the
   * sweep runs.
   *
   * `abandoned_guests` counts ACCOUNTS, not rows, and that is the honest unit: erasing one guest
   * removes its sessions, lesson progress, quiz attempts and scenario attempts too, and a number
   * that summed those would be a different figure every release as the schema grew.
   *
   * The values name what was removed rather than which table it came out of, and that is not a
   * stylistic choice: `oidc_login_attempts` was the first spelling and
   * `observability-metrics.test.ts` refused it, because `oidc_` is one of this schema's id
   * prefixes and the value is therefore indistinguishable from an identifier to the scanner that
   * exists to catch one reaching a label. A leak detector nobody can trust is worse than none, so
   * the label moved rather than the detector. Keep new values clear of `ID_PREFIXES`.
   *
   * No user id, no session id, nothing derived from a person — rule 2 at the top of this file.
   * The removed account's id goes to the log line, where retention and access are governed.
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
   * "Has the sweep run recently?" — the metric that exists because the counter above cannot say.
   *
   * ############################################################################
   * ## A SWEEP THAT STOPS RUNNING IS INVISIBLE IN EVERY OTHER SIGNAL          ##
   * ############################################################################
   *
   * `prl_retention_rows_deleted_total` not moving means one of two things and cannot tell them
   * apart: there was nothing to remove, or nothing ran. On a small deployment the first is the
   * normal state — most six-hour windows have no expired session and no sixty-day-old guest — so
   * the flat line that means "healthy" and the flat line that means "the timer died at the last
   * deploy and the retention promise has been false ever since" are the same line. That is
   * precisely the failure `docs/production/legal-register.md` §5 L5 calls the one where "nothing
   * fails, data simply persists", and it is how this subsystem got into the state it was in.
   *
   * So this reports the age of the last SUCCESSFUL sweep, in seconds, and `RetentionSweepStalled`
   * alerts on it. Three deliberate choices:
   *
   *   * **An age, not a timestamp.** `time() - prl_..._timestamp_seconds` would put the scraper's
   *     clock and this process's clock in the same subtraction, and the difference between two
   *     hosts' clocks is not a retention failure. Computed here, both readings come from one
   *     clock and the rule compares a duration against a duration.
   *   * **Read at scrape time**, per rule 3 at the top of this file — a gauge mirroring state
   *     owned elsewhere is never written on change.
   *   * **It starts from process start, not from zero.** A process that has never swept is not
   *     infinitely stale; it is as stale as it is old. Zero-initialising would page every
   *     deployment at every restart, which trains people to ignore the rule — and a process
   *     restarting often enough to hide a dead timer this way is already `ProcessRestartLoop`.
   *
   * ## The substitution above is honest only because the first sweep is at T+60s
   *
   * It used to say "the first sweep is deliberately at T+6h rather than at boot", and that is what
   * made the `ProcessRestartLoop` defence false. Substituting uptime means this gauge is RESET by
   * every restart, so a deployment redeployed more often than the sweep interval drew a sawtooth
   * that never reached the 27,000 s threshold while sweeping exactly zero times — and
   * `ProcessRestartLoop` is `changes(prl_process_start_time_seconds[15m]) >= 3`, which four
   * restarts a day is nowhere near. `maintenance/retention-sweep.ts` now runs the first sweep at
   * `FIRST_SWEEP_DELAY_MS`, sixty seconds, which is what makes the sentence above true: three
   * processes that each die before sweeping fit inside fifteen minutes, so the only restart pattern
   * that can hide a dead sweep is one that rule already pages for. The arithmetic is asserted in
   * `test/retention-sweep.test.ts` against that rule's own literals, because it is the kind of
   * claim that goes quietly false when somebody changes a number in the other file.
   *
   * What it still cannot answer, said plainly rather than left to be discovered again: **"did the
   * PREVIOUS process sweep?"** This reading is derived from THIS process's uptime, so it cannot.
   * Answering it needs something durable — the oldest `expires_at` still present, or a persisted
   * marker — which is a change to what this gauge reads and to the rule that reads it, and belongs
   * with that rule rather than here.
   */
  readonly retentionSweepAge = this.registry.gauge({
    name: `${PREFIX}_retention_sweep_age_seconds`,
    help: 'Seconds since the last successful retention sweep, or since process start if none.',
  });

  // --- Analysis ------------------------------------------------------------
  /** "Is the Coach slow, and is it slow because of queueing or because of the work?" */
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

  // --- Worker pool ---------------------------------------------------------
  /**
   * Pool state, all read at scrape time from `WorkerPool.stats()`.
   *
   * Utilisation is `busy / size` and is deliberately not exported as its own gauge: a ratio
   * cannot be aggregated across processes, while the two counts it is derived from can.
   */
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

  // --- Database ------------------------------------------------------------
  /**
   * "Is the pool saturated?"
   *
   * See `DB_PROBE_BUCKETS`. This histogram is fed by the readiness probe, which runs `select 1`
   * — so it measures the time to *acquire a connection and get an answer*, which rises under
   * pool exhaustion before any query starts failing.
   */
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

  // --- Process and readiness ----------------------------------------------
  /**
   * "Has this process restarted?"
   *
   * A start timestamp rather than a restart counter, because a counter held in the process
   * that restarted resets to zero on exactly the event it is meant to record. `time() -
   * prl_process_start_time_seconds` is the uptime, and a drop in it is a restart — which is
   * both the standard convention and the only version of this that survives the event.
   *
   * ## `set()` once, not `setFrom()` — and this is the one gauge in the file where that is right
   *
   * Rule 3 at the top of this file says a gauge whose value lives somewhere authoritative is read
   * at scrape time, and every other gauge here obeys it. This one is the exception, because the
   * value it reports is not a state that can change: it is a single instant in the past. It was
   * written as `setFrom(() => Math.floor(Date.now() / 1000 - process.uptime()))`, which re-derived
   * that fixed instant on EVERY scrape from two clocks that do not agree — `Date.now()` is a wall
   * clock subject to NTP and to leap smearing, `process.uptime()` is monotonic — and `Math.floor`
   * turned their disagreement into an integer that flipped between two adjacent seconds.
   *
   * Measured on this machine, sampling the old expression: 4.5 ms of spread over five seconds,
   * enough to straddle a second boundary. `ProcessRestartLoop` is
   * `changes(prl_process_start_time_seconds[15m]) >= 3`, and `changes()` counts a one-second
   * wobble exactly as it counts a restart — so the alert fired at sixteen minutes on a process
   * that had never restarted, which is a page in the middle of the night about nothing.
   *
   * Computed once here, at construction, which is within milliseconds of process start and is the
   * same number the old expression was trying to recover. Every scrape now renders the same
   * integer for the life of the process, so every change in it is a restart.
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
   * "Is the event loop blocked?"
   *
   * Exported as three gauges over a rolling window rather than as a histogram, because the
   * source (`monitorEventLoopDelay`) is already a native histogram and re-bucketing it would
   * lose the resolution that makes it useful. The window is reset on every scrape, so each
   * sample describes the interval since the last one — which is what a graph of it should
   * mean.
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

  /** "Is this instance in the load balancer?" 1 ready, 0 degraded. */
  readonly readinessState = this.registry.gauge({
    name: `${PREFIX}_readiness_state`,
    help: 'Readiness of this instance: 1 ready, 0 degraded.',
  });

  readonly readinessFailures = this.registry.counter({
    name: `${PREFIX}_readiness_failures_total`,
    help: 'Readiness checks that reported degraded.',
  });

  /** Self-observation: if the registry ever caps a label set, this is how it becomes visible. */
  readonly metricsSeries = this.registry.gauge({
    name: `${PREFIX}_metrics_series`,
    help: 'Live time series held by this process. A plateau at the cap means labels overflowed.',
  });

  readonly metricsOverflow = this.registry.gauge({
    name: `${PREFIX}_metrics_cardinality_overflow`,
    help: '1 if any metric has folded label combinations into an overflow series.',
  });

  /**
   * The native event-loop delay monitor.
   *
   * Started in the constructor and never stopped: it is a libuv timer with no JavaScript work
   * per sample, and `unref` is not needed because `monitorEventLoopDelay` does not hold the
   * loop open.
   */
  private readonly eventLoop = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });

  /** Previous CPU reading, so `cpuSeconds` can be the monotonic counter it is declared as. */
  private lastCpu = process.cpuUsage();

  /**
   * When the last retention sweep finished, in epoch milliseconds, or null before the first one.
   *
   * Null rather than 0, so "has not swept yet" is a state the gauge can substitute process start
   * for rather than a timestamp in 1970 that reads as fifty-six years of staleness.
   */
  private lastRetentionSweepMs: number | null = null;

  constructor() {
    this.eventLoop.enable();
    // Once, and never again — see the gauge's own comment. A collector here re-derives one fixed
    // instant from two disagreeing clocks on every scrape, and `ProcessRestartLoop` counts the
    // resulting one-second wobble as a restart.
    this.processStart.set({}, Math.floor(Date.now() / 1000 - process.uptime()));
    this.retentionSweepAge.setFrom(() => {
      const since = this.lastRetentionSweepMs ?? Date.now() - process.uptime() * 1_000;
      // Clamped at zero: a clock stepped backwards between the sweep and the scrape must render a
      // dull "just swept" rather than a negative number that no threshold can be written against.
      return Math.max(0, Math.floor((Date.now() - since) / 1_000));
    });
    this.registry.onCollect(() => this.sampleProcess());
  }

  /**
   * Records one completed retention sweep.
   *
   * Called from the sweep's `onSwept` beside the log line, rather than from inside the sweep
   * itself, for the reason every other counter in this file is fed from its caller: the sweep is
   * unit-tested against a fake `sql` with no process-wide singleton anywhere near it, and a
   * `runRetentionSweep` that reached for `appMetrics()` would build an event-loop monitor inside
   * every one of those tests.
   *
   * A FAILED sweep must never reach this. That is what makes the age gauge mean what it says: it
   * is the age of the last sweep that finished, not of the last one that was attempted, so a
   * database that has been refusing the sweep for a day reports a day of staleness.
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

  /**
   * Reads everything that is cheaper to sample on demand than to mirror on change.
   *
   * Runs on every scrape. Nothing in here may throw — the registry swallows it, which would
   * silently stop these gauges updating — so every read is one that cannot fail.
   */
  private sampleProcess(): void {
    const memory = process.memoryUsage();
    this.residentMemory.set({}, memory.rss);
    this.heapUsed.set({}, memory.heapUsed);

    // `process.cpuUsage(previous)` returns the delta since `previous`, in microseconds. Taking
    // the delta and adding it keeps the exported value monotonic even though the source is a
    // pair of absolute counters, which is what a `_total` must be.
    const cpu = process.cpuUsage(this.lastCpu);
    this.lastCpu = process.cpuUsage();
    this.cpuSeconds.inc({}, (cpu.user + cpu.system) / 1_000_000);

    // The native monitor reports nanoseconds, and reports the whole sampling interval rather
    // than the excess delay — see `EVENT_LOOP_FLOOR_NS`, which is what `eventLoopSeconds`
    // corrects for. An empty window (no samples yet) reports 0 for mean and a huge sentinel
    // for min, so `count` is checked first.
    if (this.eventLoop.count > 0) {
      this.eventLoopMean.set({}, eventLoopSeconds(this.eventLoop.mean));
      this.eventLoopP99.set({}, eventLoopSeconds(this.eventLoop.percentile(99)));
      this.eventLoopMax.set({}, eventLoopSeconds(this.eventLoop.max));
    }
    // Reset so the next scrape describes the next interval rather than all of history. Without
    // this, a single stall at boot pins the max forever and the metric stops being actionable.
    this.eventLoop.reset();

    this.metricsSeries.set({}, this.registry.totalSeries());
    this.metricsOverflow.set({}, this.registry.anyOverflowed() ? 1 : 0);
  }

  /** The exposition body. */
  render(): string {
    return this.registry.render();
  }
}

/**
 * The process-wide metrics.
 *
 * Lazily created rather than constructed at module load, for the same reason `db.ts` has no
 * eager `sql`: importing this module — from a test that only wants `routeLabel`, say — must not
 * start an event-loop monitor as a side effect.
 */
let shared: AppMetrics | null = null;

export function appMetrics(): AppMetrics {
  shared ??= new AppMetrics();
  return shared;
}

/** True when the process-wide metrics have been created. Lets callers avoid creating them. */
export function metricsConfigured(): boolean {
  return shared !== null;
}

/**
 * Discards the process-wide metrics.
 *
 * Exists for tests, which build several apps in one process and would otherwise share counters
 * across cases. Production never calls it.
 */
export function resetAppMetricsForTests(): void {
  shared = null;
}

/** The content type Prometheus expects for the text exposition format. */
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface MetricsPluginOptions {
  /** Defaults to the process-wide instance. Tests pass their own. */
  readonly metrics?: AppMetrics;
}

/**
 * The HTTP half of the instrumentation: one hook, and nothing else.
 *
 * `onResponse` rather than `onSend`, because `onSend` runs before the payload is written and
 * would report a duration that excludes serialisation and the socket write — which is exactly
 * the part that goes wrong under load. Fastify's `reply.elapsedTime` is milliseconds from the
 * moment the request was received, which is the same clock the access log uses, so the metric
 * and the log line can never disagree.
 *
 * Marked `skip-override` so the hook lands on the instance it is registered on rather than on
 * a child scope containing no routes — see `plugins/request-context.ts` for the full note on
 * why that symbol is used here instead of `fastify-plugin`.
 */
export const metricsPlugin: FastifyPluginCallback<MetricsPluginOptions> = (app, options, done) => {
  const metrics = options.metrics ?? appMetrics();

  app.addHook('onResponse', (request, reply, next) => {
    const method = methodLabel(request.method);
    const route = routeLabel(request);
    const status = reply.statusCode;
    metrics.httpRequests.inc({ method, route, status: statusClass(status) });
    // Milliseconds to seconds. `elapsedTime` is a float, so this keeps sub-millisecond
    // resolution rather than rounding a fast request to zero.
    metrics.httpDuration.observe({ method, route }, reply.elapsedTime / 1_000);
    if (status === 429) metrics.rateLimitEvents.inc({ kind: 'limited' });
    next();
  });

  done();
};

Object.defineProperty(metricsPlugin, Symbol.for('skip-override'), { value: true });

/**
 * Records one error response against the closed code label.
 *
 * Called from `errors.ts` rather than derived from the status code, because the contract code
 * carries information the status does not: `not_room_member` and `room_full` are both 403, and
 * only one of them is a sign of somebody enumerating rooms.
 */
export function recordApiError(code: ErrorCode, metrics: AppMetrics = appMetrics()): void {
  metrics.apiErrors.inc({ code: errorCodeLabel(code) });
  // Authentication and authorisation get their own counters as well as the shared one, so an
  // alert on either does not have to encode this classification in a query.
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

/**
 * Binds the gauges that mirror the worker pool to the pool itself.
 *
 * Called once, from wherever the pool is created. Takes a getter rather than the pool so that
 * a pool created later — or replaced — is still the one read at scrape time.
 */
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
