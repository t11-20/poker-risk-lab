/**
 * The shared vocabulary the rest of the service is instrumented against.
 *
 * `registry.ts` is the mechanism and `metrics.ts` is the policy about *what* is exported. This
 * file is the policy about what the code is allowed to *say* — the closed sets of strings that
 * reach a metric label, and the two helpers that put a number on work the pool and the audit
 * log already do.
 *
 * ## Why the problem hook needed a discriminator
 *
 * `LiveTable`, `BotRunner`, `RoomRegistry` and `WsRouter` all report non-fatal failures through
 * one hook whose only parameter was a prose message. Seventeen distinct failure kinds arrived
 * as seventeen different sentences, so the only way to count "bots are failing to act" was a
 * substring match over log lines — which is not a metric, breaks the moment somebody rewords a
 * message, and cannot be alerted on. `PoolWarning` in `workers/pool.ts` got this right with a
 * four-value `event` union and is the model this follows.
 *
 * So `ProblemDetail.event` is required and typed. A call site that omits it, or invents a value,
 * fails `tsc` — which is the property that matters: the label set of
 * `prl_table_actor_failures_total` cannot drift without the compiler saying so.
 *
 * ### Why the event is a field on the detail and not the first argument
 *
 * `(event, message, detail)` would read better and is not worth what it costs. Nine test files
 * already consume this hook as `(message, detail)`, and reordering the parameters would silently
 * turn every one of their assertions into a comparison against the event name instead of the
 * message — a green suite asserting nothing. Keeping `message` first makes the change additive:
 * every existing consumer keeps working, and `detail.event` is the new, typed fact.
 *
 * ## What this file must never do
 *
 * Carry an identifier into a label. The events below are constants written in this repository;
 * nothing here interpolates a room id, a hand id, a user id or a caller-supplied string into a
 * value that reaches the registry. Those belong in the log line the hook also produces, which is
 * where retention and access are governed (`logging.ts`).
 */

import { getSql, isDatabaseConfigured } from '../db.ts';
import { isAppError } from '../errors.ts';
import * as auditRepository from '../repositories/audit.ts';
import type { PoolWarning } from '../workers/pool.ts';
import { type AppMetrics, appMetrics, bindWorkerPoolMetrics } from './metrics.ts';

// ---------------------------------------------------------------------------
// The problem hook
// ---------------------------------------------------------------------------

/**
 * Every non-fatal failure the live-table stack can report, enumerated from the call sites.
 *
 * Not a guess and not a taxonomy invented here: each value below is exactly one `onProblem`
 * call in `rooms/registry.ts`, `rooms/table.ts`, `rooms/bots.ts` or `ws/router.ts`. Adding a
 * failure path means adding a value here, which is the point — a new failure that reuses an
 * existing name is a failure an operator cannot separate from the old one.
 *
 * Hyphenated rather than dotted, matching `PoolWarning.event`, and deliberately NOT matching the
 * audit log's dotted event grammar: these two vocabularies describe different things and a
 * shared spelling would invite somebody to pass one where the other is expected.
 */
export type ProblemEvent =
  // rooms/registry.ts
  | 'archive-write'
  | 'room-open-read'
  | 'hands-interrupted'
  | 'reconcile-read'
  | 'seat-retake'
  | 'seat-release'
  | 'bot-rehydrate'
  | 'room-lease-refused'
  | 'room-fenced'
  | 'room-lease-release'
  | 'seat-entitlement'
  // rooms/table.ts
  | 'turn-timeout'
  | 'engine-rejection'
  | 'departed-seat-fold'
  | 'timeout-rejection'
  | 'subscriber-throw'
  // rooms/bots.ts
  | 'opponent-model'
  | 'bot-policy'
  | 'bot-action-rejected'
  // ws/router.ts
  | 'socket-intent'
  | 'socket-send'
  | 'socket-close'
  // this file, when an audit write fails
  | 'audit-write';

/**
 * The same list as a value, so a test can assert over all of it.
 *
 * Kept in step with the type by `classifyProblem`'s exhaustive switch: a value added to the
 * union and not to this array still has to be classified, and a value in this array that is not
 * in the union does not compile. Two halves of one fact, each of which fails loudly on its own.
 */
export const PROBLEM_EVENTS: readonly ProblemEvent[] = [
  'archive-write',
  'room-open-read',
  'hands-interrupted',
  'reconcile-read',
  'seat-retake',
  'seat-release',
  'bot-rehydrate',
  'room-lease-refused',
  'room-fenced',
  'room-lease-release',
  'seat-entitlement',
  'turn-timeout',
  'engine-rejection',
  'departed-seat-fold',
  'timeout-rejection',
  'subscriber-throw',
  'opponent-model',
  'bot-policy',
  'bot-action-rejected',
  'socket-intent',
  'socket-send',
  'socket-close',
  'audit-write',
];

/**
 * What a problem carries besides its message.
 *
 * The index signature is what keeps every existing call site's extra context (`roomId`, `seat`,
 * `error`) legal without enumerating a shape per event. It is deliberately `unknown` rather than
 * `string`: the values go to `app.log.warn`, which serialises and censors them, never to a label.
 */
export interface ProblemDetail {
  readonly event: ProblemEvent;
  readonly [key: string]: unknown;
}

/** The hook every live-table component reports through. */
export type ProblemHook = (message: string, detail: ProblemDetail) => void;

/**
 * How one problem event is counted, decided in one place.
 *
 * - `actor` — a seat's actor (a bot policy, a rehydrated seat, or the turn timer) failed to
 *   produce an action. This is the class that stalls a table without any request failing, so it
 *   gets `prl_table_actor_failures_total` and the event as its reason.
 * - `counted-at-source` — already counted by the module that raised it, against a metric that
 *   needs a number the hook does not carry. `archive-write` increments
 *   `prl_archive_failures_total` inside `rooms/registry.ts`, `hands-interrupted` increments
 *   `prl_hands_failed_total` *by the number of hands it closed*, and `seat-release` increments
 *   `prl_seat_release_failures_total` by the number of chairs it could not free. Counting any of
 *   them again here would double it.
 *
 *   Counting at the source rather than here also means the number is right for a registry built
 *   with its own `onProblem` — every test, and any future embedder — instead of depending on the
 *   one consumer in `routes/index.ts` being wired up.
 * - `logged-only` — worth a log line and not worth a series. A subscriber that threw, a socket
 *   send that failed on an already-dead socket, an audit row that could not be written: each is
 *   real, none is a question an operator would put on a dashboard, and every metric costs
 *   cardinality that the ones above have to share.
 */
export type ProblemClass = 'actor' | 'counted-at-source' | 'logged-only';

export function classifyProblem(event: ProblemEvent): ProblemClass {
  switch (event) {
    // A bot that cannot decide, a bot whose action the engine refused, a seat that could not be
    // re-taken or rehydrated after a restart, and a turn clock whose expiry could not be applied
    // all end the same way: it is somebody's turn and nothing is going to act.
    case 'bot-policy':
    case 'bot-action-rejected':
    case 'bot-rehydrate':
    case 'seat-retake':
    case 'turn-timeout':
    case 'timeout-rejection':
    case 'departed-seat-fold':
      return 'actor';
    // `seat-release` is deliberately NOT folded into `archive-write`, which is where it used to
    // report for want of a name of its own. The two are different subsystems with different
    // consequences and different runbooks: an archive failure loses hand history while play
    // continues, and a seat-release failure leaves a chair durably occupied by somebody who has
    // left — the summary shows it free, the next client to tap it is refused `seat_taken`, and
    // nothing retries. Paging the archive runbook for that sends somebody to the wrong system.
    //
    // `room-lease-refused` and `room-fenced` are counted at their source too, and NOT as actor
    // failures. An actor failure is "it is somebody's turn and nothing is going to act", which the
    // turn clock resolves; these two are "two processes are pointed at one room", which nothing in
    // the process can resolve and which has its own page-tier alert. `rooms/registry.ts` increments
    // `prl_room_ownership_refusals_total` and `prl_room_fencings_total` at the moment it decides,
    // because only that code knows which of the two reasons a fencing had.
    //
    // `seat-entitlement` joins them, and is deliberately NOT `seat-retake` even though it is
    // raised from the same loop and means "this chair was not given back". `seat-retake` is an
    // ACTOR failure — "it is somebody's turn and nothing is going to act", which the turn clock
    // has to resolve — and a seat left free on purpose is the opposite of that: nobody is in it,
    // nobody is waiting on it, and no clock has anything to do. Reusing the nearest existing kind
    // is the mistake `docs/production/runbooks/stuck-seat.md` records being made once already,
    // where an archive failure and a stuck chair became one indistinguishable series and sent
    // somebody to the wrong subsystem. `rooms/registry.ts` increments
    // `prl_seat_entitlement_refusals_total{reason="seat_not_restored"}` at the moment it decides,
    // because only that code knows which of the two reasons a refusal had.
    case 'archive-write':
    case 'hands-interrupted':
    case 'seat-release':
    case 'room-lease-refused':
    case 'room-fenced':
    case 'seat-entitlement':
      return 'counted-at-source';
    // `engine-rejection` is deliberately NOT an actor failure: it is the engine refusing an
    // action a client submitted, the caller is told `illegal_action`, and it is already counted
    // as an API error. Folding it in here would make a table look broken every time somebody
    // clicked a stale button.
    case 'engine-rejection':
    case 'opponent-model':
    case 'subscriber-throw':
    case 'room-open-read':
    case 'reconcile-read':
    // A lease this process could not give back on the way out. Worth a line, not a series: the
    // lease expires on its own within `LEASE_TTL_MS`, so the whole cost is that one room is
    // unopenable for up to that long — and the two events that matter, being refused and being
    // fenced, are counted above.
    case 'room-lease-release':
    case 'socket-intent':
    case 'socket-send':
    case 'socket-close':
    case 'audit-write':
      return 'logged-only';
    default: {
      // Exhaustiveness, enforced by the compiler rather than by review. A value added to
      // `ProblemEvent` and not handled above fails to build.
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/**
 * Records one problem against the metrics, having already been logged by the caller.
 *
 * Separate from the logging so that the consumer in `routes/index.ts` reads as "log it, then
 * count it" rather than hiding a metric inside a logger call. Takes the metrics instance
 * explicitly-with-a-default for the same reason `recordApiError` does: production has one, and a
 * test that wants isolation passes its own.
 */
export function recordProblem(event: ProblemEvent, metrics: AppMetrics = appMetrics()): void {
  if (classifyProblem(event) !== 'actor') return;
  metrics.tableActorFailures.inc({ reason: event });
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** The two kinds of work that reach a calculator thread. A closed label set. */
export type AnalysisKind = 'coach' | 'equity';

/**
 * How one analysis ended.
 *
 * Four values rather than a boolean, because the three failures need different responses: a
 * timeout means the work is too big or the pool is too small, a rejection means the caller asked
 * for something the maths refuses (or the queue was full), and a failure means a thread died.
 */
export type AnalysisOutcome = 'ok' | 'timeout' | 'rejected' | 'failed';

/**
 * Classifies a thrown analysis failure.
 *
 * By contract error code, which is the one classification both `workers/pool.ts` and
 * `calc/parse.ts` already agree on — `computation_timeout` is only ever produced by the pool's
 * deadline, `computation_rejected` only by the maths refusing a task, and `service_unavailable`
 * only by the pool refusing to accept one. Anything else is a bug on our side and is counted as
 * such rather than being quietly folded into a caller-facing category.
 */
export function analysisOutcomeFor(error: unknown): Exclude<AnalysisOutcome, 'ok'> {
  if (!isAppError(error)) return 'failed';
  if (error.code === 'computation_timeout') return 'timeout';
  // A full queue and a closed pool are both "we did not run this", which is the same operational
  // question as "the maths refused it": neither consumed a thread.
  if (error.code === 'computation_rejected' || error.code === 'service_unavailable') return 'rejected';
  return 'failed';
}

/**
 * Times one Coach or equity analysis and counts how it ended.
 *
 * Wrapped around the `await` rather than measured inside the pool, because what matters to a
 * learner waiting for a Coach panel is the whole thing — queueing, the thread hand-off, the
 * calculation and the assembly — and the pool can only see the middle of that.
 *
 * The duration is observed on the failure path too. A timeout that was not recorded is a
 * histogram that gets *faster* as the service gets worse, which is the single most misleading
 * shape a latency graph can have.
 */
export async function observeAnalysis<T>(
  kind: AnalysisKind,
  work: () => Promise<T>,
  metrics: AppMetrics = appMetrics(),
): Promise<T> {
  const startedAt = performance.now();
  const finish = (outcome: AnalysisOutcome): void => {
    metrics.analysisDuration.observe({ kind }, (performance.now() - startedAt) / 1_000);
    metrics.analysisOutcomes.inc({ kind, outcome });
  };
  try {
    const result = await work();
    finish('ok');
    return result;
  } catch (error) {
    finish(analysisOutcomeFor(error));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The worker pool
// ---------------------------------------------------------------------------

/** Only what the gauges need from `WorkerPool.stats()`, so this file imports no worker code. */
export interface PoolStatsSource {
  readonly stats: () => {
    readonly size: number;
    readonly workers: number;
    readonly busy: number;
    readonly queued: number;
  };
}

/**
 * Which `workerTasks` outcome a `PoolWarning` describes.
 *
 * Honest about what this counter can and cannot see: the pool warns only about failures, so
 * `outcome="completed"` never arrives through this path. The per-request view — including the
 * successes — is `prl_analysis_total`, and the pool's own cumulative totals live in
 * `WorkerPool.stats()`, which a counter cannot mirror without drifting the first time a code
 * path settles a job and forgets to say so.
 *
 * `protocol-mismatch` is `failed` rather than a category of its own: it means a thread replied
 * out of turn, the thread is dropped and the job is rejected, which is the same outcome for the
 * caller as a thread that crashed.
 *
 * The parameter is `PoolWarning['event']` rather than the same union written out again, so a value
 * added to the pool's vocabulary fails to compile here until somebody decides what it means. The
 * import is type-only and erased, so this module still pulls in no worker code at runtime.
 */
export function workerTaskOutcomeFor(event: PoolWarning['event']): 'failed' | 'timed_out' {
  return event === 'task-timeout' ? 'timed_out' : 'failed';
}

/**
 * Which metrics instances have already had a pool bound to them.
 *
 * `bindWorkerPoolMetrics` appends an `onCollect` hook, and both `routes/calc.ts` and
 * `routes/content.ts` take the shared pool — deliberately, so that whichever modules a
 * deployment registers, the gauges still exist. Binding twice would run the same four `set`
 * calls twice on every scrape, and an app built repeatedly in one test process would accumulate
 * a hook per build. A `WeakMap` keyed on the metrics instance keeps it to one, and holds neither
 * the metrics nor the pool alive.
 */
/**
 * Which metrics instances have already had a pool getter bound.
 *
 * Keyed on the metrics instance, not the pool: the process-wide pool is replaced on
 * `closeSharedPool()`, and binding the *instance* at registration left scrapes reading a
 * closed leftover. One getter per metrics registry is enough — three route modules all pass
 * `peekSharedPool`, and a second hook on the same registry would write the same four gauges
 * twice.
 */
const boundMetrics = new WeakSet<AppMetrics>();

/**
 * A pool, or a getter that may return `null` when none exists yet.
 *
 * The getter form is what production uses: scrape-time `peekSharedPool()` so a Prometheus poll
 * cannot create threads, and so a pool that was closed and replaced is the one that is read.
 */
export type PoolStatsProvider = PoolStatsSource | (() => PoolStatsSource | null);

/** Binds the worker-pool gauges once per metrics instance. Safe to call from every module. */
export function bindCalculationPoolMetrics(
  pool: PoolStatsProvider,
  metrics: AppMetrics = appMetrics(),
): void {
  if (boundMetrics.has(metrics)) return;
  boundMetrics.add(metrics);
  bindWorkerPoolMetrics(() => {
    const source = typeof pool === 'function' ? pool() : pool;
    if (source === null) return { size: 0, workers: 0, busy: 0, queued: 0 };
    return source.stats();
  }, metrics);
}

// ---------------------------------------------------------------------------
// The audit log
// ---------------------------------------------------------------------------

/**
 * The security events this service writes to `prl.audit_log`, as a closed set.
 *
 * Each name satisfies `audit_log_event_shape` (3..64 characters, dot-separated lowercase
 * segments) and is a constant in this repository rather than anything a caller can influence.
 *
 * A name is added here at the same time as its write, never before: a name with no call site is
 * a promise the log does not keep, and an operator querying for it would read the empty result as
 * "it never happened" rather than "nothing records it".
 *
 * What is deliberately NOT here: anything routine. A successful sign-in, a hand played, a lesson
 * completed — none of them is a security event, and recording them would turn the audit log into
 * a second, worse activity log with the retention policy of an audit trail.
 */
export type SecurityAuditEvent =
  /** A socket handshake was refused: bad origin, unauthenticated, or too many for one session. */
  | 'ws.upgrade.refused'
  /** A guest account was created. The one unauthenticated endpoint that writes a user row. */
  | 'auth.guest.created'
  /** A session was ended deliberately — sign-out, or erasure taking every session with it. */
  | 'auth.session.revoked'
  /** A learner erased their account. Irreversible, so the fact of it is worth keeping. */
  | 'auth.account.deleted'
  /** A caller went so far past a rate limit that it was blocked outright rather than told to wait. */
  | 'security.rate_limit.banned';

/**
 * Writes one audit entry, and never lets it fail the thing it describes.
 *
 * ## Why this wrapper exists at all
 *
 * `repositories/audit.ts` throws on a failed write, deliberately and correctly: "the security
 * event was not recorded and nobody knows" is worse than a failed request, and its header says
 * the caller that must not fail can decide that for itself. This is that decision, taken once,
 * for the call sites where it is obviously right. Refusing a WebSocket upgrade and then throwing
 * because the *record* of the refusal could not be written would turn a working security control
 * into an outage — and the refusal is already in the request log, so the failure is not silent.
 *
 * The same trade `rooms/registry.ts` makes for a hand it could not archive, for the same reason.
 *
 * ## Why it is fire-and-forget
 *
 * The caller is a socket handler that has already closed the socket. Awaiting a database round
 * trip there would hold the handler open for an event that nobody is waiting on. The promise's
 * rejection IS handled — that is what `onFailure` is — so this cannot become an unhandled
 * rejection, which `server.ts` exits the process on.
 *
 * ## Why the database is checked rather than tried
 *
 * `getSql()` throws when `configureDatabase` was never called, which is the normal state for a
 * unit test and for a development run with no database. Asking first keeps that ordinary case
 * from producing a failure line on every refused upgrade.
 */
export function recordSecurityAudit(
  entry: {
    readonly event: SecurityAuditEvent;
    readonly userId?: string | null;
    readonly detail?: Record<string, unknown>;
  },
  onFailure: (message: string, detail: ProblemDetail) => void,
): void {
  if (!isDatabaseConfigured()) return;
  const report = (error: unknown): void => {
    onFailure('a security event could not be written to the audit log', {
      event: 'audit-write',
      auditEvent: entry.event,
      error: String(error),
    });
  };
  try {
    void auditRepository
      .record(getSql(), {
        event: entry.event,
        userId: entry.userId ?? null,
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      })
      .catch(report);
  } catch (error) {
    // `getSql()` or `record`'s synchronous validation threw. Same treatment: reported, swallowed.
    report(error);
  }
}
