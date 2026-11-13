/**
 * The closed sets of strings that may reach a metric label, and helpers that count work the pool
 * and the audit log already do. `ProblemDetail.event` is required and typed so the label set of
 * `prl_table_actor_failures_total` cannot drift without `tsc` failing. `message` stays the first
 * hook argument because nine test files read the hook as `(message, detail)`.
 * Nothing here interpolates an id or caller string into a label. Those go to the log line.
 */

import { getSql, isDatabaseConfigured } from '../db.ts';
import { isAppError } from '../errors.ts';
import * as auditRepository from '../repositories/audit.ts';
import type { PoolWarning } from '../workers/pool.ts';
import { type AppMetrics, appMetrics, bindWorkerPoolMetrics } from './metrics.ts';

/**
 * Each value is exactly one `onProblem` call site. A new failure path gets a new value, so an
 * operator can separate it from the old ones. Hyphenated like `PoolWarning.event`, unlike the
 * dotted audit grammar, so the two vocabularies are not confused.
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
  | 'first-sit-record'
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

/** Kept in step with the type by `classifyProblem`'s exhaustive switch. */
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
  'first-sit-record',
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

/** Extra values go to `app.log.warn`, which censors them, never to a label. */
export interface ProblemDetail {
  readonly event: ProblemEvent;
  readonly [key: string]: unknown;
}

export type ProblemHook = (message: string, detail: ProblemDetail) => void;

/**
 * - `actor`. A seat's actor failed to act, which stalls a table with no failing request.
 * - `counted-at-source`. The raising module counts it with a number the hook lacks (hands closed,
 *   chairs not freed, lease reason). Counting here too would double it.
 * - `logged-only`. A log line, not a series.
 */
export type ProblemClass = 'actor' | 'counted-at-source' | 'logged-only';

export function classifyProblem(event: ProblemEvent): ProblemClass {
  switch (event) {
    // It is somebody's turn and nothing is going to act.
    case 'bot-policy':
    case 'bot-action-rejected':
    case 'bot-rehydrate':
    case 'seat-retake':
    case 'turn-timeout':
    case 'timeout-rejection':
    case 'departed-seat-fold':
      return 'actor';
    // Each has its own metric and runbook. `seat-release` is not `archive-write`, and
    // `seat-entitlement` is not `seat-retake` (a chair left free on purpose is not a stalled actor).
    // Folding them together once sent an operator to the wrong subsystem (runbooks/stuck-seat.md).
    case 'archive-write':
    case 'hands-interrupted':
    case 'seat-release':
    case 'room-lease-refused':
    case 'room-fenced':
    case 'seat-entitlement':
      return 'counted-at-source';
    // `engine-rejection` is a client's stale action, already counted as `illegal_action`.
    case 'engine-rejection':
    case 'opponent-model':
    case 'subscriber-throw':
    case 'room-open-read':
    case 'reconcile-read':
    // The lease expires on its own within `LEASE_TTL_MS`.
    case 'room-lease-release':
    // The learner is still seated. The cost is a smaller stack shown after a stand before the deal.
    case 'first-sit-record':
    case 'socket-intent':
    case 'socket-send':
    case 'socket-close':
    case 'audit-write':
      return 'logged-only';
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** Called after the caller has logged the problem. */
export function recordProblem(event: ProblemEvent, metrics: AppMetrics = appMetrics()): void {
  if (classifyProblem(event) !== 'actor') return;
  metrics.tableActorFailures.inc({ reason: event });
}

export type AnalysisKind = 'coach' | 'equity';

/** A timeout, a refusal and a dead thread each need a different response. */
export type AnalysisOutcome = 'ok' | 'timeout' | 'rejected' | 'failed';

/**
 * By contract code. `computation_timeout` comes only from the pool deadline, `computation_rejected`
 * from the maths, `service_unavailable` from a full or closed pool. Anything else is our bug.
 */
export function analysisOutcomeFor(error: unknown): Exclude<AnalysisOutcome, 'ok'> {
  if (!isAppError(error)) return 'failed';
  if (error.code === 'computation_timeout') return 'timeout';
  // Neither consumed a thread.
  if (error.code === 'computation_rejected' || error.code === 'service_unavailable') return 'rejected';
  return 'failed';
}

/**
 * Wraps the whole `await`, including queueing, which the pool cannot see. Failures are timed too,
 * or the histogram would get faster as the service got worse.
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

/** Only what the gauges need, so this file imports no worker code. */
export interface PoolStatsSource {
  readonly stats: () => {
    readonly size: number;
    readonly workers: number;
    readonly busy: number;
    readonly queued: number;
  };
}

/**
 * The pool warns only about failures, so `completed` never arrives here. Successes are in
 * `prl_analysis_total`. `protocol-mismatch` is `failed`, the same outcome as a crashed thread.
 */
export function workerTaskOutcomeFor(event: PoolWarning['event']): 'failed' | 'timed_out' {
  return event === 'task-timeout' ? 'timed_out' : 'failed';
}

/**
 * Keyed on the metrics instance, not the pool, because `closeSharedPool()` replaces the pool. Several
 * route modules bind, and a second hook would write the same gauges twice per scrape.
 */
const boundMetrics = new WeakSet<AppMetrics>();

/** Production passes `peekSharedPool`, so a scrape cannot create threads. */
export type PoolStatsProvider = PoolStatsSource | (() => PoolStatsSource | null);

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

/**
 * Names satisfy `audit_log_event_shape`. A name is added with its write, never before, because an
 * empty query result would read as "it never happened". Routine activity is not audited.
 */
export type SecurityAuditEvent =
  | 'ws.upgrade.refused'
  | 'auth.guest.created'
  | 'auth.session.revoked'
  | 'auth.account.deleted'
  | 'security.rate_limit.banned';

/**
 * Lets a test await fire-and-forget audit writes instead of polling. Polling timed out at 15,036 ms
 * inside `pnpm run verify` after the deadline was already raised to 15 s. Entries remove themselves.
 */
const pendingAuditWrites = new Set<Promise<unknown>>();

/** Lets a waiting test tell a slow write from a refused one. */
let auditWriteFailures = 0;

export function failedAuditWrites(): number {
  return auditWriteFailures;
}

function trackAuditWrite(write: Promise<unknown>): void {
  pendingAuditWrites.add(write);
  void write.finally(() => {
    pendingAuditWrites.delete(write);
  });
}

/** For tests. Waits only for writes started before the call. */
export async function awaitPendingAuditWrites(): Promise<void> {
  await Promise.allSettled([...pendingAuditWrites]);
}

/**
 * `repositories/audit.ts` throws on a failed write. Here the failure is reported and swallowed, so
 * a refused WebSocket upgrade does not become an outage. Fire-and-forget because the socket is
 * already closed. Rejection is handled by `onFailure`, since `server.ts` exits on an unhandled one.
 * The database is checked first so unit tests without one produce no failure lines.
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
    auditWriteFailures += 1;
    onFailure('a security event could not be written to the audit log', {
      event: 'audit-write',
      auditEvent: entry.event,
      error: String(error),
    });
  };
  try {
    trackAuditWrite(
      auditRepository
        .record(getSql(), {
          event: entry.event,
          userId: entry.userId ?? null,
          ...(entry.detail === undefined ? {} : { detail: entry.detail }),
        })
        .catch(report),
    );
  } catch (error) {
    // Synchronous throw from `getSql()` or validation. Same treatment.
    report(error);
  }
}
