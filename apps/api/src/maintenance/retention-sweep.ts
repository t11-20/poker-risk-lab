/**
 * The scheduled removal of rows that have expired.
 *
 * ## The gap this closes
 *
 * `deleteExpired` and `deleteExpiredLoginAttempts` in `repositories/sessions.ts` have existed and
 * been tested since sessions did. Nothing called them outside the test suite.
 * `docs/production/legal-review-requirements.md` §7 records the consequence in the plainest
 * possible terms, as a fact counsel can rely on: *"The sweeps that remove expired rows exist and
 * are tested, and at the time of drafting nothing called them on a schedule … So an expired
 * session is unusable, and its row may still be present."* Its follow-up list says only
 * "Schedule the expiry sweeps", and notes that the retention paragraph on `/privacy` is honest
 * only because it says the sweep does not run.
 *
 * Two separate problems sat behind that sentence:
 *
 *   1. **A retention promise nobody kept.** A deployment that tells a learner their data is
 *      removed on a schedule, and has no schedule, has made a statement that is not true. That is
 *      the half a lawyer cares about, and it is the half that matters the moment this product has
 *      paying readers rather than a demo.
 *   2. **Two tables that only ever grow.** `prl.sessions` gains a row per sign-in and
 *      `prl.oidc_login_attempts` gains one per *attempted* federated sign-in — including every
 *      abandoned one. Neither is bounded by anything. The index on `expires_at` keeps the sweep
 *      itself cheap, but nothing else about a table that grows forever is cheap.
 *
 * ## Why this runs in the process rather than as a systemd timer
 *
 * The backups are a timer (`deploy/backup/prl-backup.timer`) and that is right for them: they run
 * as a different identity, with a different database role, and they must keep running when the
 * application is down — the whole point of a backup is that it survives the thing it backs up.
 *
 * None of that is true here. This sweep needs exactly the privileges the API already has, on
 * exactly the tables the API already owns, and it is meaningless while the API is not running.
 * Making it a unit would add a deployment artefact, a second database credential to rotate, and a
 * new way for a deployment to be half-configured — to run four `DELETE`s a day. It runs here.
 *
 * The cost, stated because it is real: this assumes ONE API process. `docker-compose.staging.yml`
 * and ADR 0001 already make `deploy.replicas: 1` a correctness constraint for a different and
 * much stronger reason (two processes holding one room's hand state deal two different hands), so
 * this adds no new constraint. If that ever changes, N processes would each run this sweep; the
 * `DELETE … where id in (select … limit N)` shape is safe under concurrency — the losers simply
 * delete nothing — so the failure mode is wasted queries, not wrong data. Worth knowing, not worth
 * a lock.
 *
 * ## Why it deletes in bounded batches, and keeps going until it stops finding rows
 *
 * `deleteExpired` takes `limit` and defaults to 1,000. A first sweep against a deployment that has
 * never run one could face an unbounded backlog, and a single unbounded `DELETE` would hold locks
 * and a transaction open for as long as it took. So each pass deletes at most `batchSize` rows and
 * the sweep repeats until a pass comes back short — with a hard ceiling on passes, because a sweep
 * that cannot finish must yield rather than spin. Anything left is taken by the next run.
 *
 * ## What it does when the database is unavailable
 *
 * Logs and carries on. A sweep is not on any request path and there is nothing a learner is
 * waiting for; the next tick tries again. It must never take the process down, which is why the
 * timer callback can throw nothing.
 */

import type { Sql } from '../db.ts';
import { deleteExpired, deleteExpiredLoginAttempts } from '../repositories/sessions.ts';

/** What one sweep removed, so a caller can log it and a test can assert on it. */
export interface SweepResult {
  readonly sessions: number;
  readonly loginAttempts: number;
  /** True when a sweep hit its pass ceiling with rows still to take. The next run continues. */
  readonly incomplete: boolean;
  readonly durationMs: number;
}

export interface RetentionSweepOptions {
  /**
   * How often to sweep. Six hours by default.
   *
   * The number is not load-bearing and deliberately so: a session's row becomes removable when it
   * expires, and nothing observes the gap between "removable" and "removed" except the size of a
   * table. Six hours keeps a day's worth of turnover to four passes and keeps the first pass after
   * a deploy close enough to be visible in a log somebody is watching.
   */
  readonly intervalMs?: number;
  /** Rows per statement. Passed straight to the repository's own `limit`. */
  readonly batchSize?: number;
  /**
   * Most statements per table per sweep. At the default batch this is 100,000 rows a table a
   * sweep, which is far more than any real backlog and still a bound.
   */
  readonly maxPasses?: number;
  /** Injected by the tests. Defaults to the shared pool. */
  readonly sql: () => Sql;
  readonly onSwept: (result: SweepResult) => void;
  readonly onProblem: (error: unknown) => void;
  /** Injected by the tests so a sweep can be driven without waiting six hours. */
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
  readonly now?: () => number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_PASSES = 100;

/**
 * Deletes expired rows from one table in bounded batches until a pass comes back short.
 *
 * Returns the total removed and whether it stopped early. A pass that deletes fewer rows than the
 * batch size has, by construction, run out of rows to take — that is the terminating condition,
 * and it is why the repository functions return a count rather than a boolean.
 */
async function sweepTable(
  remove: (limit: number) => Promise<number>,
  batchSize: number,
  maxPasses: number,
): Promise<{ removed: number; incomplete: boolean }> {
  let removed = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const taken = await remove(batchSize);
    removed += taken;
    if (taken < batchSize) return { removed, incomplete: false };
  }
  return { removed, incomplete: true };
}

/** One sweep of both tables. Exported so a test can run it without a timer. */
export async function runRetentionSweep(
  options: Pick<RetentionSweepOptions, 'sql' | 'batchSize' | 'maxPasses' | 'now'>,
): Promise<SweepResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const sql = options.sql();

  const sessions = await sweepTable((limit) => deleteExpired(sql, { limit }), batchSize, maxPasses);
  const attempts = await sweepTable(
    (limit) => deleteExpiredLoginAttempts(sql, { limit }),
    batchSize,
    maxPasses,
  );

  return {
    sessions: sessions.removed,
    loginAttempts: attempts.removed,
    incomplete: sessions.incomplete || attempts.incomplete,
    durationMs: now() - startedAt,
  };
}

/**
 * Starts the sweep and returns a handle that stops it.
 *
 * The first sweep runs on the first tick rather than immediately: boot is the busiest moment a
 * process has — migrations may still be settling, the worker pool is warming, and `/ready` has not
 * answered yet — and there is nothing about an expired row that cannot wait six hours longer than
 * it already has.
 *
 * `unref()` so a sweep timer alone never keeps the process alive. A process whose only remaining
 * work is a maintenance timer should exit.
 */
export function startRetentionSweep(options: RetentionSweepOptions): { stop: () => void } {
  const setIntervalFn = options.setIntervalImpl ?? setInterval;
  const clearIntervalFn = options.clearIntervalImpl ?? clearInterval;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  // Guards against a tick firing while the previous sweep is still running — possible if a sweep
  // ever takes longer than the interval, which a large first backlog on a slow database could.
  // Overlapping sweeps would not corrupt anything (the `limit` subquery makes each statement
  // independent) but they would double the load at exactly the wrong moment.
  let running = false;

  const timer = setIntervalFn(() => {
    if (running) return;
    running = true;
    void runRetentionSweep(options)
      .then(options.onSwept)
      .catch(options.onProblem)
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  // `unref` is not on the fake timers a test injects, so it is called only when it exists.
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }

  return {
    stop: () => {
      clearIntervalFn(timer);
    },
  };
}
