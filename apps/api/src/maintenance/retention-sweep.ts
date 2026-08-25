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
 * ## The third sweep: abandoned guest accounts
 *
 * Added later, and it had exactly the same shape of defect behind it. The guest sweep was
 * documented in four places — a DELETE grant widened for it (`0001_initial.sql:916`), that
 * justification quoted (`0004_account_deletion.sql:94`), an index built for it
 * (`0002_indexes_and_constraints.sql:51-55`) and `touchLastSeen` maintained to feed it
 * (`auth/session.ts`) — and implemented in none of them. A compliance review filed it as D4 in
 * `docs/production/legal-register.md`: *"abandoned guest accounts … are retained indefinitely,
 * and a DELETE privilege was widened for a sweep that does not exist."* An account is created
 * automatically for every visitor who opens a lesson, so the population that was being kept for
 * ever is "everybody who ever loaded a page", not "everybody who signed up".
 *
 * Three things make it different from the two row sweeps above, and each is argued where it is
 * implemented rather than here:
 *
 *   * **It is an erasure, not a delete.** It goes through `deleteAccount`, the same
 *     self-verifying path `POST /me/delete` uses, so the policy in
 *     `db/migrations/0004_account_deletion.sql` exists once. See `deleteAbandonedGuest`.
 *   * **"Abandoned" is read from the database, not from a clock.** No account with a live
 *     session, a room membership, a hand seat, a room of its own or an enrolment in any cohort is
 *     ever taken, at any age.
 *     Deleting a learner who is sitting at a live table is a far worse defect than keeping a dead
 *     row, so the guard is a lock and a predicate rather than an argument about timestamps. See
 *     `abandonedGuestPredicate` in `repositories/users.ts`.
 *   * **The period is derived, not chosen.** See `GUEST_RETENTION_SECONDS`.
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

import { SESSION_ABSOLUTE_TTL_SECONDS } from '../auth/session.ts';
import type { Sql } from '../db.ts';
import { deleteExpired, deleteExpiredLoginAttempts } from '../repositories/sessions.ts';
import { deleteAbandonedGuest, findAbandonedGuests } from '../repositories/users.ts';

/**
 * How long a guest account may go unseen before it is abandoned.
 *
 * ############################################################################
 * ## THIS NUMBER IS DERIVED. IT WAS NOT CHOSEN, AND IT MUST NOT BE.          ##
 * ############################################################################
 *
 * The guest sweep is documented in four places and, until this change, implemented in none of
 * them: `db/migrations/0001_initial.sql:916` widens a DELETE grant for it,
 * `db/migrations/0004_account_deletion.sql:94` quotes that justification,
 * `db/migrations/0002_indexes_and_constraints.sql:51-55` builds an index *specifically* for it
 * ("Guest reaping: which guest accounts have not been seen since <cutoff>?"), and
 * `auth/session.ts` documents `touchLastSeen` as what keeps an active learner out of it.
 *
 * **Not one of those four states a period.** They agree on the mechanism and on the column, and
 * they are silent on the number — the index comment even writes it as the placeholder `<cutoff>`.
 * `docs/production/legal-register.md` §5 L5 is where the number was left: it is a question for
 * counsel, open, and an engineer may not answer it. So this is not the specification being
 * implemented; it is the *smallest* period that cannot destroy anything a person could still
 * reach, which is the only cutoff that can be justified without answering L5.
 *
 * The derivation, in one step. A guest account has no email, no password and no federated
 * identity — there is no column that could hold one (`0001_initial.sql:229-267`) — so its ONLY
 * credential is a session cookie, and there is no recovery path of any kind. A session cannot
 * outlive `SESSION_ABSOLUTE_TTL_SECONDS` from its creation whatever the learner does
 * (`auth/session.ts`), and `/privacy` §5 already publishes that ceiling to readers as "sixty days
 * from creation". Therefore, once a guest has been unseen for that ceiling, every cookie that
 * ever pointed at it is dead and no new one can be minted for it: the account is unreachable by
 * its owner, permanently. Deleting it destroys nothing anybody could have looked at again.
 *
 * Anything SHORTER would delete accounts whose owners could still come back, which is a decision
 * about a learner's data and belongs to L5. Anything LONGER keeps rows that are provably
 * unreachable, which is the defect this closes. Written as the constant rather than as `60 * ...`
 * so that moving the session ceiling moves this with it; two numbers that must agree and are
 * spelled separately are two numbers that will not agree.
 *
 * It is not the safety mechanism. The sweep never removes an account with a live session, a
 * membership, a hand seat, a room or an enrolment, whatever this says — see
 * `abandonedGuestPredicate` in `repositories/users.ts`. This decides how long a *dead* account is kept, and nothing else.
 */
export const GUEST_RETENTION_SECONDS = SESSION_ABSOLUTE_TTL_SECONDS;

/** What one sweep removed, so a caller can log it and a test can assert on it. */
export interface SweepResult {
  readonly sessions: number;
  readonly loginAttempts: number;
  /** Abandoned guest accounts erased, each through the same path `POST /me/delete` uses. */
  readonly guestAccounts: number;
  /**
   * Guest accounts the database refused to erase, this sweep.
   *
   * Separate from `guestAccounts` because zero and zero are the same number and the two mean
   * opposite things: "there were none to take" and "every one of them was refused". Today the
   * only way to be non-zero is a foreign key added to `prl.users` without a referential action,
   * which is the case `db/migrations/0004_account_deletion.sql` calls "a ninth reference added
   * without a clause". Counted rather than thrown so one poisoned account cannot stop the sweep
   * from removing the rest of the batch, for ever, silently.
   */
  readonly guestAccountsBlocked: number;
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
  /**
   * How long a guest account may go unseen before it is abandoned. Seconds.
   *
   * A parameter only so that a test can express "sixty days have passed" without waiting sixty
   * days. Nothing in the product sets it, and there is deliberately no environment variable: see
   * `GUEST_RETENTION_SECONDS` for why the number is derived rather than chosen, and what an
   * operator lowering it would be deciding on a learner's behalf.
   */
  readonly guestRetentionSeconds?: number;
  /** Injected by the tests. Defaults to the shared pool. */
  readonly sql: () => Sql;
  readonly onSwept: (result: SweepResult) => void;
  readonly onProblem: (error: unknown) => void;
  /**
   * One guest account the database refused to erase. The sweep continues.
   *
   * Separate from `onProblem`, which means "this sweep produced no result at all". A blocked
   * account is not that: the sweep ran, the other accounts went, and one is stuck. Reporting both
   * through one callback would make a stuck account look like a dead schedule in the log, which is
   * the distinction this whole subsystem is built around.
   */
  readonly onGuestBlocked?: (userId: string, error: unknown) => void;
  /** Injected by the tests so a sweep can be driven without waiting six hours. */
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
  readonly now?: () => number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_PASSES = 100;

/**
 * What one pass of one table did.
 *
 * `examined` and `removed` are the same number for a plain `DELETE … LIMIT n`, and they are not
 * for the guest sweep: a pass there chooses up to `n` candidates and may decline to remove some of
 * them, because the account came back to life between being chosen and being locked. Terminating
 * on `removed` would then stop the sweep early — a batch of 1,000 candidates of which 999 went
 * would look exactly like "there were only 999 left" — and the backlog would drain 999 rows per
 * six hours no matter how large it was. The loop terminates on how many were OFFERED.
 */
interface PassResult {
  readonly examined: number;
  readonly removed: number;
}

/**
 * Sweeps one table in bounded batches until a pass comes back short.
 *
 * Returns the total removed and whether it stopped early. A pass that examines fewer rows than the
 * batch size has, by construction, run out of rows to offer — that is the terminating condition,
 * and it is why the repository functions return a count rather than a boolean.
 */
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

/** A `DELETE … LIMIT n` pass, where everything offered is everything taken. */
function rowsPass(remove: (limit: number) => Promise<number>): (limit: number) => Promise<PassResult> {
  return async (limit) => {
    const taken = await remove(limit);
    return { examined: taken, removed: taken };
  };
}

/**
 * One pass of the abandoned-guest sweep: choose a batch, then erase each one in its own
 * transaction.
 *
 * ## Why each account gets a transaction of its own
 *
 * Because `deleteAccount` verifies itself and can therefore *refuse*: it counts the rows naming
 * the learner after the delete, inside the same transaction, and throws if any survived. That is
 * the property worth having in an unattended sweep, and it is only worth having if one refusal
 * rolls back one account. A batch-wide transaction would mean a single account the schema will not
 * let go of rolls back the other 999 — and since the batch is chosen oldest-first, it would be
 * chosen again on the next pass, and the next, and the sweep would report "removed nothing" for
 * ever while the log said it ran. That is the exact failure this whole change exists to end, so
 * reproducing it inside the fix would be a poor joke.
 *
 * So a failure here is counted and stepped over rather than thrown. `blocked` reaches the log line
 * and the metric; a persistent non-zero value is the runbook's cue that `prl.users` has grown a
 * reference nobody gave a referential action to.
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
      // Boxed for the reason `db.ts`'s `withTransaction` boxes: postgres.js unwraps a bare array
      // returned from `begin`, and a summary object is not an array today. Not relying on that.
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

/** One sweep of all three tables. Exported so a test can run it without a timer. */
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

  // Guests last, and not by accident: erasing an account cascades its sessions, so taking the
  // expired session rows first means the footprint check inside `deleteAccount` has less to count
  // and the two sweeps never contend for the same rows.
  //
  // The cost of that ordering, stated: a session sweep that throws every tick — a database that is
  // down, a lock it cannot get — takes the guest sweep with it, because the whole sweep is one
  // unit that either produces a result or reports a problem. That is the failure isolation this
  // module already had between its first two tables and it is deliberately not widened here: three
  // half-sweeps reporting three outcomes is a worse thing for an operator to reason about than one
  // sweep that either ran or did not. What makes it safe to leave is that the sweep no longer
  // reports success in that state, so `prl_retention_sweep_age_seconds` keeps climbing and
  // `RetentionSweepStalled` fires — the whole point of exporting an age rather than a count.
  let blocked = 0;
  const guests = await sweepTable(
    (limit) =>
      guestPass(sql, cutoffSeconds, limit, (userId, error) => {
        blocked += 1;
        // The id goes to the operator's own log and nowhere else. It is not a metric label — see
        // rule 2 at the top of `observability/metrics.ts` — and without it "one guest could not be
        // erased" is not something anybody can act on.
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
