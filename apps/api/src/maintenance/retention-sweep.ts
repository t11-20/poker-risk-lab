/**
 * The scheduled removal of expired sessions, expired OIDC login attempts and abandoned guest
 * accounts, which keeps the retention periods `/privacy` publishes true.
 * In-process, not a systemd timer, because it needs only the API's privileges and is meaningless
 * while the API is down. It assumes `replicas: 1`. N processes would only waste queries.
 * Each table is swept in bounded batches until a pass comes back short, with a pass ceiling.
 * A failed sweep is logged and retried at the next tick. It never takes the process down.
 */

import { SESSION_ABSOLUTE_TTL_SECONDS } from '../auth/session.ts';
import type { Sql } from '../db.ts';
import { deleteExpired, deleteExpiredLoginAttempts } from '../repositories/sessions.ts';
import { deleteAbandonedGuest, findAbandonedGuests } from '../repositories/users.ts';

/**
 * Derived, not chosen. The period is an open question for counsel (`legal-register.md` §5 L5).
 * A guest's only credential is a session cookie, which cannot outlive `SESSION_ABSOLUTE_TTL_SECONDS`,
 * so after that long unseen the account is unreachable by its owner. Shorter would delete accounts
 * an owner could still reach. Written as the constant so the two cannot drift. Safety is
 * `abandonedGuestPredicate` in `repositories/users.ts`, not this number.
 */
export const GUEST_RETENTION_SECONDS = SESSION_ABSOLUTE_TTL_SECONDS;

export interface SweepResult {
  readonly sessions: number;
  readonly loginAttempts: number;
  /** Erased through the same path `POST /me/delete` uses. */
  readonly guestAccounts: number;
  /**
   * Separate from `guestAccounts`, because "none to take" and "all refused" are both zero. Non-zero
   * means a reference to `prl.users` without a referential action. Counted, not thrown, so one
   * account cannot stop the batch.
   */
  readonly guestAccountsBlocked: number;
  /** Hit the pass ceiling with rows left. The next run continues. */
  readonly incomplete: boolean;
  readonly durationMs: number;
}

export interface RetentionSweepOptions {
  /** Six hours by default. Not load-bearing. */
  readonly intervalMs?: number;
  /** For tests only. See `startRetentionSweep`. */
  readonly firstSweepDelayMs?: number;
  readonly batchSize?: number;
  /** At the default batch, 100,000 rows per table per sweep. */
  readonly maxPasses?: number;
  /** For tests only. No environment variable, see `GUEST_RETENTION_SECONDS`. */
  readonly guestRetentionSeconds?: number;
  readonly sql: () => Sql;
  readonly onSwept: (result: SweepResult) => void;
  readonly onProblem: (error: unknown) => void;
  /**
   * Not `onProblem`, which means the sweep produced no result. A stuck account must not look like
   * a dead schedule.
   */
  readonly onGuestBlocked?: (userId: string, error: unknown) => void;
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
  readonly setTimeoutImpl?: typeof setTimeout;
  readonly clearTimeoutImpl?: typeof clearTimeout;
  readonly now?: () => number;
}

export const FIRST_SWEEP_DELAY_MS = 60_000;

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_PASSES = 100;

/**
 * The guest pass may decline some candidates it examined, so the loop ends on `examined`, not
 * `removed`. Ending on `removed` would drain a backlog at 999 rows per six hours.
 */
interface PassResult {
  readonly examined: number;
  readonly removed: number;
}

async function sweepTable(
  pass: (limit: number) => Promise<PassResult>,
  batchSize: number,
  maxPasses: number,
): Promise<{ removed: number; incomplete: boolean }> {
  let removed = 0;
  for (let attempt = 0; attempt < maxPasses; attempt += 1) {
    const result = await pass(batchSize);
    removed += result.removed;
    if (result.examined < batchSize) return { removed, incomplete: false };
  }
  return { removed, incomplete: true };
}

function rowsPass(remove: (limit: number) => Promise<number>): (limit: number) => Promise<PassResult> {
  return async (limit) => {
    const taken = await remove(limit);
    return { examined: taken, removed: taken };
  };
}

/**
 * One transaction per account, because `deleteAccount` verifies itself and may refuse. In a shared
 * transaction one refusal would roll back the batch, be chosen again oldest-first, and stall the
 * sweep for ever. Refusals are counted and stepped over.
 */
async function guestPass(
  sql: Sql,
  cutoffSeconds: number,
  limit: number,
  onBlocked: (userId: string, error: unknown) => void,
): Promise<PassResult> {
  const candidates = await findAbandonedGuests(sql, { cutoffSeconds, limit });
  let removed = 0;
  for (const userId of candidates) {
    try {
      // Boxed, as in `db.ts`'s `withTransaction`, because postgres.js unwraps an array from `begin`.
      const boxed = await sql.begin(async (tx) => ({
        value: await deleteAbandonedGuest(tx, userId, cutoffSeconds),
      }));
      if (boxed.value !== null) removed += 1;
    } catch (error) {
      onBlocked(userId, error);
    }
  }
  return { examined: candidates.length, removed };
}

/** Exported so a test can run it without a timer. */
export async function runRetentionSweep(
  options: Pick<
    RetentionSweepOptions,
    'sql' | 'batchSize' | 'maxPasses' | 'now' | 'guestRetentionSeconds' | 'onGuestBlocked'
  >,
): Promise<SweepResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  const cutoffSeconds = options.guestRetentionSeconds ?? GUEST_RETENTION_SECONDS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const sql = options.sql();

  const sessions = await sweepTable(
    rowsPass((limit) => deleteExpired(sql, { limit })),
    batchSize,
    maxPasses,
  );
  const attempts = await sweepTable(
    rowsPass((limit) => deleteExpiredLoginAttempts(sql, { limit })),
    batchSize,
    maxPasses,
  );

  // Guests last, so expired sessions are already gone and the sweeps never contend. A failing
  // session sweep takes the guest sweep with it, and `RetentionSweepStalled` fires on the age gauge.
  let blocked = 0;
  const guests = await sweepTable(
    (limit) =>
      guestPass(sql, cutoffSeconds, limit, (userId, error) => {
        blocked += 1;
        // The id goes to the log only, never a metric label.
        options.onGuestBlocked?.(userId, error);
      }),
    batchSize,
    maxPasses,
  );

  return {
    sessions: sessions.removed,
    loginAttempts: attempts.removed,
    guestAccounts: guests.removed,
    guestAccountsBlocked: blocked,
    incomplete: sessions.incomplete || attempts.incomplete || guests.incomplete,
    durationMs: now() - startedAt,
  };
}

/**
 * The first sweep is a one-shot at `FIRST_SWEEP_DELAY_MS`. When it was the first interval tick
 * (T+6h), a deployment shipping more often than that never swept (`test/retention-sweep.test.ts`
 * reproduces eight five-hour deployments with zero sweeps). Sixty seconds is past boot work, and
 * short enough that a restart pattern hiding a dead sweep trips `ProcessRestartLoop`. The test
 * checks that against the rule's literals. No jitter, because there is one replica. Timers are
 * `unref`'d.
 */
export function startRetentionSweep(options: RetentionSweepOptions): { stop: () => void } {
  const setIntervalFn = options.setIntervalImpl ?? setInterval;
  const clearIntervalFn = options.clearIntervalImpl ?? clearInterval;
  const setTimeoutFn = options.setTimeoutImpl ?? setTimeout;
  const clearTimeoutFn = options.clearTimeoutImpl ?? clearTimeout;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  // Clamped, so a test's short interval never puts the first sweep after the second.
  const firstSweepDelayMs = Math.min(options.firstSweepDelayMs ?? FIRST_SWEEP_DELAY_MS, intervalMs);

  // A slow first backlog could outlast the interval. Overlap is safe but doubles load.
  let running = false;

  const sweep = (): void => {
    if (running) return;
    running = true;
    void runRetentionSweep(options)
      .then(options.onSwept)
      .catch(options.onProblem)
      .finally(() => {
        running = false;
      });
  };

  // Injected fake timers may lack `unref`.
  const unref = (timer: unknown): void => {
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref: () => void }).unref();
    }
  };

  let interval: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const first = setTimeoutFn(() => {
    // Not all fake timers cancel, so a stopped schedule must not start an orphan interval.
    if (stopped) return;
    sweep();
    interval = setIntervalFn(sweep, intervalMs);
    unref(interval);
  }, firstSweepDelayMs);
  unref(first);

  return {
    stop: () => {
      stopped = true;
      clearTimeoutFn(first);
      if (interval !== null) clearIntervalFn(interval);
    },
  };
}
