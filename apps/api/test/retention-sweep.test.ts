/**
 * The scheduled removal of expired rows.
 *
 * ## What this file is for
 *
 * `deleteExpired` and `deleteExpiredLoginAttempts` were implemented, tested and never called.
 * `docs/production/legal-review-requirements.md` §7 records it as a fact counsel can rely on —
 * "the sweeps that remove expired rows exist and are tested, and at the time of drafting nothing
 * called them on a schedule" — and its follow-up list says only "Schedule the expiry sweeps". So
 * the defect was never in the SQL, and a test that exercises the SQL again would prove nothing
 * that `repositories.test.ts` does not already prove.
 *
 * What was missing is a caller, a bound, and a failure mode. That is what this file asserts:
 *
 *   * a sweep removes what is expired and leaves what is live — the property a retention promise
 *     rests on, in both directions, because a sweep that took a live session would be far worse
 *     than one that took nothing;
 *   * it works through a backlog larger than one batch, rather than removing `batchSize` rows and
 *     declaring victory;
 *   * it stops at `maxPasses` and SAYS SO, rather than spinning on a backlog it cannot finish;
 *   * a database error is swallowed and the schedule survives it, because a maintenance timer
 *     that can kill the process is worse than no maintenance timer;
 *   * a tick that fires while a sweep is still running does not start a second one.
 *
 * The abandoned-guest sweep was added later and is asserted the same way, plus the two things its
 * loop can do that a `DELETE … LIMIT n` cannot: decline to remove a candidate that came back to
 * life between being chosen and being locked, and step over one the database refuses without
 * losing the rest of the batch. Both are about the loop, so both belong here; whether the SQL
 * picks the right accounts is `retention-sweep-database.test.ts`.
 *
 * ## Why the timer is injected rather than faked with real time
 *
 * The interval is six hours. A test that waited for it would not be a test, and one that set the
 * interval to a millisecond would be a race dressed up as a schedule. The timer functions are
 * parameters, so the test holds the tick and fires it deliberately — which is also the only way
 * to assert the overlap guard, since that needs two ticks with a sweep pending between them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SESSION_ABSOLUTE_TTL_SECONDS } from '../src/auth/session.ts';
import type { Sql } from '../src/db.ts';
import {
  FIRST_SWEEP_DELAY_MS,
  GUEST_RETENTION_SECONDS,
  runRetentionSweep,
  startRetentionSweep,
} from '../src/maintenance/retention-sweep.ts';

/**
 * What one candidate guest account does when the sweep tries to erase it.
 *
 * `came-back` is the race the re-check inside the transaction exists for: the account was chosen
 * by a query that ran in an earlier snapshot and is no longer abandoned by the time it is locked.
 * `blocked` is the database refusing the erasure, which today can only mean a foreign key added
 * to `prl.users` without a referential action.
 */
type GuestOutcome = 'erased' | 'came-back' | 'blocked';

/**
 * A `Sql` stand-in that records the statements it is handed and answers with rows.
 *
 * The repository functions are tagged-template calls, so this is a function with the template
 * signature. It does not parse SQL — it dispatches on a distinctive phrase in each literal, which
 * is exactly as much as this file needs to know and no more.
 *
 * ## Why the guest half has more shapes than the other two
 *
 * The session and login-attempt sweeps are one `DELETE` each. Erasing a guest goes through
 * `deleteAccount`, deliberately — the same self-verifying path `POST /me/delete` uses — so a
 * single erasure is eight statements: the bare `FOR UPDATE` on the account, the abandoned
 * re-check as a separate statement, the account lock inside `deleteAccount`, the footprint count,
 * the room closure, the session revocation, the delete, and the footprint count again. They are
 * answered here rather than stubbed out at a seam, because the loop under test is the loop that
 * issues them, and a fake that skipped straight to "one account gone" would not notice a sweep
 * that never opened a transaction at all. What this file does NOT assert is what those statements
 * mean; that is `retention-sweep-database.test.ts`, against real SQL.
 *
 * The lock and the re-check are two statements and not one on purpose, and this fake keeps them
 * apart for the same reason `deleteAbandonedGuest` does: locking and asking in one statement
 * answers the predicate from the snapshot it held before it blocked, which erased a student whose
 * place was granted while the sweep waited. The `came-back` outcome is therefore decided by the
 * RE-CHECK here, never by the lock — a fake that let the lock decide would pass against the
 * single-statement version this replaced.
 */
function fakeSql(plan: {
  readonly sessions: readonly number[];
  readonly attempts: readonly number[];
  /** Candidate guests returned per pass of the choosing query. */
  readonly guests?: readonly number[];
  /** Defaults to `erased` for every candidate. */
  readonly guestOutcome?: (userId: string) => GuestOutcome;
  readonly throwOn?: 'sessions' | 'attempts';
}): {
  sql: Sql;
  calls: { sessions: number[]; attempts: number[]; guests: number[]; transactions: string[] };
} {
  const calls = {
    sessions: [] as number[],
    attempts: [] as number[],
    guests: [] as number[],
    transactions: [] as string[],
  };
  let sessionPass = 0;
  let attemptPass = 0;
  let guestPass = 0;
  const outcomeOf = (userId: string): GuestOutcome => plan.guestOutcome?.(userId) ?? 'erased';

  const statement = (strings: TemplateStringsArray, values: unknown[]): Promise<unknown[]> => {
    const text = strings.join('?');
    // The LAST numeric interpolation is the limit in every statement that has one. `deleteExpired`
    // also interpolates `REVOKED_RETENTION_SECONDS` (86,400) ahead of it, and the guest queries
    // interpolate the retention cutoff, so "the first number" would pick a retention window and
    // quietly assert nothing about batching.
    const numbers = values.filter((value): value is number => typeof value === 'number');
    const limit = numbers.at(-1);

    // `abandonedGuestPredicate` is a FRAGMENT, not a statement: the repository builds it with the
    // same tagged template and interpolates it into the two queries below. Real postgres.js keeps
    // a nested query lazy; this fake evaluates it, so it has to be recognised and answered with
    // nothing. Without this guard it reads as a statement mentioning `prl.sessions` and eats a
    // pass of the session plan — the sweep would still work and the assertions would be nonsense.
    if (text.includes("u.kind = 'guest'")) return Promise.resolve([]);

    // --- the guest sweep, in the order one erasure issues them -------------
    if (text.includes('order by u.last_seen_at')) {
      calls.guests.push(limit ?? 0);
      const count = plan.guests?.[guestPass] ?? 0;
      guestPass += 1;
      const pass = guestPass;
      return Promise.resolve(Array.from({ length: count }, (_, i) => ({ id: `usr_g${pass}_${i}` })));
    }
    // The bare lock. It takes no predicate, so it can only answer "the row is there" — which is
    // the whole point of splitting it out, and why the outcome is decided by the next branch.
    if (text.includes('from prl.users u') && text.includes('for update')) {
      const userId = String(values[0]);
      calls.transactions.push(userId);
      return Promise.resolve([{ id: userId }]);
    }
    // The re-check, as its own statement and therefore its own snapshot. This is where an account
    // that came back to life between being chosen and being locked disappears.
    if (text.includes('from prl.users u')) {
      const userId = String(values[0]);
      return Promise.resolve(outcomeOf(userId) === 'came-back' ? [] : [{ id: userId }]);
    }
    if (text.includes('count(*)')) {
      // `accountFootprint`, before and after. Zeros both times: nothing was left behind, which is
      // what lets `deleteAccount` commit.
      return Promise.resolve([
        {
          sessions: 0,
          lesson_progress: 0,
          quiz_attempts: 0,
          scenario_attempts: 0,
          room_members: 0,
          hand_seats: 0,
          audit_events: 0,
          rooms_owned: 0,
        },
      ]);
    }
    if (text.includes('delete from prl.users')) {
      const userId = calls.transactions.at(-1) ?? '';
      if (outcomeOf(userId) === 'blocked') {
        // Shaped like the real thing: 23503 is a foreign-key violation, which is exactly what a
        // ninth reference to `prl.users` without a referential action would raise.
        return Promise.reject(
          Object.assign(new Error('update or delete violates foreign key'), {
            code: '23503',
            constraint_name: 'invented_later_user_id_fkey',
          }),
        );
      }
      return Promise.resolve([]);
    }
    if (text.includes('update prl.rooms') || text.includes('update prl.sessions')) return Promise.resolve([]);
    if (text.includes('select id from prl.users')) return Promise.resolve([{ id: String(values[0]) }]);

    // --- the two row sweeps -------------------------------------------------
    if (text.includes('prl.sessions')) {
      if (plan.throwOn === 'sessions') return Promise.reject(new Error('connection terminated unexpectedly'));
      calls.sessions.push(limit ?? 0);
      const count = plan.sessions[sessionPass] ?? 0;
      sessionPass += 1;
      return Promise.resolve(Array.from({ length: count }, (_, index) => ({ id: `ses_${index}` })));
    }
    if (plan.throwOn === 'attempts') return Promise.reject(new Error('connection terminated unexpectedly'));
    calls.attempts.push(limit ?? 0);
    const count = plan.attempts[attemptPass] ?? 0;
    attemptPass += 1;
    return Promise.resolve(Array.from({ length: count }, (_, index) => ({ id: `oid_${index}` })));
  };

  // `savepoint` is what `deleteAccount` and `deleteAbandonedGuest` test for to refuse a pool
  // handle, so the transaction handle carries one and the pool handle deliberately does not.
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    statement(strings, values)) as unknown as Sql;
  Object.assign(tx, { savepoint: () => Promise.resolve() });

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    statement(strings, values)) as unknown as Sql;
  Object.assign(sql, {
    begin: <T>(fn: (handle: Sql) => Promise<T>): Promise<T> => fn(tx),
  });

  return { sql, calls };
}

/**
 * The timers the schedule arms, driven by hand.
 *
 * `tick()` fires whatever is next due without the test having to know which kind it is: the FIRST
 * tick is the one-shot that runs the first sweep at `FIRST_SWEEP_DELAY_MS`, and every tick after it
 * is the interval that one-shot arms. Keeping one `tick()` is what let the cases below stay about
 * what a sweep does rather than about which timer function the schedule happens to use — they read
 * identically to before the first sweep stopped being the interval's first tick.
 */
function manualTimer(): {
  readonly setTimeoutImpl: typeof setTimeout;
  readonly clearTimeoutImpl: typeof clearTimeout;
  readonly setIntervalImpl: typeof setInterval;
  readonly clearIntervalImpl: typeof clearInterval;
  readonly tick: () => void;
  readonly cleared: () => boolean;
  /**
   * The two clears, told apart.
   *
   * They used to share one `cleared` flag, and that is how `stops when asked` came to prove
   * nothing: the case never ticked, so the interval had never been armed, `stop()` reached only
   * `clearTimeoutFn`, and one flag cannot say which of the two ran. Measured — with `stop()`
   * reduced to `clearTimeoutFn(first)` alone, dropping both `stopped = true` and the
   * `clearIntervalFn(interval)`, the whole `@prl/api` suite passed 1,001 of 1,001.
   */
  readonly timeoutsCleared: () => number;
  readonly intervalsCleared: () => number;
  /** True while an interval callback is armed and would fire on the next `tick()`. */
  readonly intervalArmed: () => boolean;
} {
  let pendingTimeout: (() => void) | null = null;
  let interval: (() => void) | null = null;
  let timeoutsCleared = 0;
  let intervalsCleared = 0;
  return {
    setTimeoutImpl: ((fn: () => void) => {
      pendingTimeout = fn;
      return { id: 'fake-timeout' } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout,
    clearTimeoutImpl: (() => {
      timeoutsCleared += 1;
      pendingTimeout = null;
    }) as unknown as typeof clearTimeout,
    setIntervalImpl: ((fn: () => void) => {
      interval = fn;
      return { id: 'fake-interval' } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {
      intervalsCleared += 1;
      // Actually forgotten, not merely counted: a `clearInterval` that leaves the callback armed
      // could not tell a shutdown that stopped the sweep from one that only said it had.
      interval = null;
    }) as unknown as typeof clearInterval,
    tick: () => {
      const once = pendingTimeout;
      if (once !== null) {
        pendingTimeout = null;
        once();
        return;
      }
      interval?.();
    },
    cleared: () => timeoutsCleared + intervalsCleared > 0,
    timeoutsCleared: () => timeoutsCleared,
    intervalsCleared: () => intervalsCleared,
    intervalArmed: () => interval !== null,
  };
}

/**
 * A clock a test advances, driving both a `setTimeout` and a `setInterval`.
 *
 * `manualTimer` above fires a tick on demand, which is right for "what does one sweep do" and
 * useless for "how many sweeps does a process of a given lifetime get" — the question the first
 * case below asks, and the one whose answer was zero. This one knows the DELAYS the schedule asked
 * for, so a test can say "this process lived five hours" and get the number of sweeps a five-hour
 * process actually gets.
 */
function virtualTimer(): {
  readonly setTimeoutImpl: typeof setTimeout;
  readonly clearTimeoutImpl: typeof clearTimeout;
  readonly setIntervalImpl: typeof setInterval;
  readonly clearIntervalImpl: typeof clearInterval;
  readonly advance: (ms: number) => void;
} {
  interface Entry {
    readonly fn: () => void;
    readonly delay: number;
    readonly repeating: boolean;
    due: number;
    cancelled: boolean;
  }
  const entries = new Map<object, Entry>();
  let now = 0;
  const arm = (fn: () => void, delay: number, repeating: boolean): NodeJS.Timeout => {
    const handle = {};
    entries.set(handle, { fn, delay, repeating, due: now + delay, cancelled: false });
    return handle as unknown as NodeJS.Timeout;
  };
  const cancel = (handle: unknown): void => {
    const entry = entries.get(handle as object);
    if (entry !== undefined) entry.cancelled = true;
  };
  return {
    setTimeoutImpl: ((fn: () => void, delay: number) =>
      arm(fn, delay, false)) as unknown as typeof setTimeout,
    clearTimeoutImpl: ((handle: unknown) => cancel(handle)) as unknown as typeof clearTimeout,
    setIntervalImpl: ((fn: () => void, delay: number) =>
      arm(fn, delay, true)) as unknown as typeof setInterval,
    clearIntervalImpl: ((handle: unknown) => cancel(handle)) as unknown as typeof clearInterval,
    advance: (ms) => {
      const target = now + ms;
      // Smallest-due-first, and re-read every round, because a callback may arm a new timer — which
      // is exactly what a schedule whose first sweep is a one-shot does.
      for (;;) {
        let next: Entry | null = null;
        for (const entry of entries.values()) {
          if (entry.cancelled || entry.due > target) continue;
          if (next === null || entry.due < next.due) next = entry;
        }
        if (next === null) break;
        now = next.due;
        if (next.repeating) next.due = now + next.delay;
        else next.cancelled = true;
        next.fn();
      }
      now = target;
    },
  };
}

describe('one retention sweep', () => {
  it('works through a backlog larger than one batch and stops when a pass comes back short', async () => {
    // Three full batches then a short one. The short pass is the terminating condition — a pass
    // that returns fewer rows than it asked for has, by construction, run out of rows to take.
    const { sql, calls } = fakeSql({ sessions: [10, 10, 10, 3], attempts: [10, 0] });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 10, maxPasses: 100 });

    assert.equal(result.sessions, 33, 'a sweep that stopped after one batch would report 10');
    assert.equal(result.loginAttempts, 10);
    assert.equal(result.incomplete, false);
    assert.deepEqual(calls.sessions, [10, 10, 10, 10], 'every statement must carry the batch limit');
    assert.deepEqual(calls.attempts, [10, 10]);
  });

  it('stops at maxPasses and reports that it is incomplete', async () => {
    // The bound that keeps a first sweep against a years-old deployment from running unboundedly.
    // Reporting it matters as much as doing it: a sweep that quietly gives up looks identical to
    // one that finished, and the difference is whether anybody looks at the backlog.
    const { sql, calls } = fakeSql({ sessions: Array.from({ length: 20 }, () => 10), attempts: [0] });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 10, maxPasses: 3 });

    assert.equal(result.sessions, 30);
    assert.equal(result.incomplete, true, 'a ceiling that is not reported is a silent truncation');
    assert.equal(calls.sessions.length, 3, 'it must not keep going past the ceiling');
  });

  it('takes nothing when there is nothing expired', async () => {
    // The other direction, and the one that matters most: this deletes rows from the table that
    // holds every live session. A sweep that took a live session would log somebody out.
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0] });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 10, maxPasses: 100 });

    assert.deepEqual(
      {
        sessions: result.sessions,
        loginAttempts: result.loginAttempts,
        guestAccounts: result.guestAccounts,
        incomplete: result.incomplete,
      },
      { sessions: 0, loginAttempts: 0, guestAccounts: 0, incomplete: false },
    );
    assert.equal(calls.sessions.length, 1, 'one statement is enough to learn there is nothing to do');
    assert.equal(calls.transactions.length, 0, 'no candidates means no transaction was opened');
  });
});

describe('the abandoned-guest sweep', () => {
  it('keeps a guest exactly as long as a session could still reach it', () => {
    // Not a tautology, and worth a test of its own: nothing in the four places that document this
    // sweep states a period, and the number is therefore DERIVED rather than chosen — a guest's
    // only credential is a session cookie and there is no recovery path, so the account becomes
    // unreachable when the last session it could ever hold has expired. If somebody replaces this
    // with a literal, or moves the session ceiling without moving this, the derivation is gone and
    // the cutoff becomes a number an engineer picked — which is exactly what `legal-register.md`
    // L5 says an engineer may not do.
    assert.equal(GUEST_RETENTION_SECONDS, SESSION_ABSOLUTE_TTL_SECONDS);
    assert.equal(GUEST_RETENTION_SECONDS, 60 * 24 * 60 * 60, 'sixty days, as /privacy §5 publishes it');
  });

  it('erases each candidate in its own transaction and works through a backlog', async () => {
    // Two full batches then a short one, exactly like the row sweeps — and the terminating
    // condition is how many were OFFERED, not how many went, which is what the next case is about.
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0], guests: [3, 3, 1] });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 3, maxPasses: 100 });

    assert.equal(result.guestAccounts, 7, 'a sweep that stopped after one batch would report 3');
    assert.equal(result.guestAccountsBlocked, 0);
    assert.equal(result.incomplete, false);
    assert.deepEqual(calls.guests, [3, 3, 3], 'every choosing query must carry the batch limit');
    assert.equal(calls.transactions.length, 7, 'each account must be erased in a transaction of its own');
  });

  it('leaves a guest that came back to life between being chosen and being locked (NEGATIVE CONTROL)', async () => {
    // The whole reason the predicate is evaluated twice. The choosing query ran against a snapshot
    // that is already old by the time the row is locked; if the second evaluation were dropped,
    // this account — which now has a live session — would be erased out from under somebody who is
    // using it. Deleting a live learner is far worse than keeping a dead row, so the guard returns
    // "not removed" and the sweep carries on.
    const { sql, calls } = fakeSql({
      sessions: [0],
      attempts: [0],
      guests: [2, 0],
      guestOutcome: (userId) => (userId === 'usr_g1_0' ? 'came-back' : 'erased'),
    });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 2, maxPasses: 100 });

    assert.equal(result.guestAccounts, 1, 'the account that came back must not be counted as erased');
    assert.equal(result.guestAccountsBlocked, 0, 'coming back is not a failure');
    // Two candidates were offered, so the batch was full and the sweep asked for another one. A
    // loop terminating on rows REMOVED would have stopped here and drained one row per six hours.
    assert.deepEqual(calls.guests, [2, 2], 'a full batch must be followed by another pass');
  });

  it('steps over an account the database refuses and still takes the rest (NEGATIVE CONTROL)', async () => {
    // A foreign key added to `prl.users` later without a referential action — the case migration
    // 0004 calls "a ninth reference added without a clause". One transaction rolls back; the other
    // two commit. If the batch shared a transaction, or the error escaped, the oldest-first order
    // would offer this same account first for ever and the sweep would report "removed nothing"
    // while its log line said it ran — which is precisely the defect this whole sweep closes.
    const { sql } = fakeSql({
      sessions: [0],
      attempts: [0],
      guests: [3, 0],
      guestOutcome: (userId) => (userId === 'usr_g1_1' ? 'blocked' : 'erased'),
    });
    const blocked: string[] = [];
    const result = await runRetentionSweep({
      sql: () => sql,
      batchSize: 3,
      maxPasses: 100,
      onGuestBlocked: (userId) => blocked.push(userId),
    });

    assert.equal(result.guestAccounts, 2, 'the other two accounts must still have been erased');
    assert.equal(result.guestAccountsBlocked, 1, 'a refusal that is not counted is a silent stall');
    assert.deepEqual(blocked, ['usr_g1_1'], 'the operator needs to know WHICH account is stuck');
  });

  it('stops at maxPasses and reports that it is incomplete', async () => {
    const { sql, calls } = fakeSql({
      sessions: [0],
      attempts: [0],
      guests: Array.from({ length: 20 }, () => 2),
    });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 2, maxPasses: 3 });

    assert.equal(result.guestAccounts, 6);
    assert.equal(result.incomplete, true, 'a ceiling that is not reported is a silent truncation');
    assert.equal(calls.guests.length, 3, 'it must not keep going past the ceiling');
  });
});

describe('the schedule', () => {
  /**
   * ##########################################################################
   * ## A DEPLOYMENT REDEPLOYED MORE OFTEN THAN THE INTERVAL SWEPT NOTHING.  ##
   * ## EVER. NOT LATE — NEVER.                                             ##
   * ##########################################################################
   *
   * The first sweep used to be the first TICK of a six-hour interval, on the reasoning that "boot
   * is the busiest moment a process has ... and there is nothing about an expired row that cannot
   * wait six hours longer than it already has". The premise is right and the conclusion did not
   * follow: a process that never reaches six hours of uptime never reaches its first sweep, so a
   * deployment that ships twice a day removes nothing, for ever. Expired sessions, every abandoned
   * federated sign-in attempt and every abandoned guest account accumulate with nothing failing —
   * which is `docs/production/legal-register.md` L5's phrase, "nothing fails, data simply
   * persists", and it is now a published promise on `/privacy` rather than a tidiness question.
   *
   * Nothing could see it either. `prl_retention_sweep_age_seconds` substitutes process uptime when
   * this process has not swept, so it is RESET by the very restarts that cause the problem: a
   * six-hourly redeploy draws a sawtooth peaking at 21,600 s against a `RetentionSweepStalled`
   * threshold of 27,000 s. The comment on that gauge defends the substitution with "a process
   * restarting often enough to hide a dead timer this way is already `ProcessRestartLoop`", and
   * that rule is `changes(prl_process_start_time_seconds[15m]) >= 3` — four restarts a DAY is not
   * within two orders of magnitude of it.
   *
   * Eight consecutive five-hour deployments is the shape of an ordinary week here. The assertion
   * is `>= 8` and not `> 0` deliberately: one sweep in eight deploys would be a schedule that
   * still depends on a process happening to live long enough.
   */
  it('sweeps on every deployment, however short (NEGATIVE CONTROL)', async () => {
    const { sql } = fakeSql({ sessions: [0], attempts: [0] });
    const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
    let sweeps = 0;
    for (let deployment = 0; deployment < 8; deployment += 1) {
      const clock = virtualTimer();
      const handle = startRetentionSweep({
        sql: () => sql,
        onSwept: () => {
          sweeps += 1;
        },
        onProblem: () => undefined,
        ...clock,
      });
      clock.advance(FIVE_HOURS_MS);
      await new Promise((resolve) => setImmediate(resolve));
      handle.stop();
    }
    assert.ok(
      sweeps >= 8,
      `eight five-hour deployments produced ${sweeps} sweeps: a deployment that ships more often ` +
        'than the sweep interval never enforces a retention period at all',
    );
  });

  /**
   * The arithmetic that makes the age gauge's uptime substitution defensible, asserted rather than
   * left as a sentence in a comment.
   *
   * That gauge reports process uptime while this process has not yet swept, so it under-reports
   * staleness across a restart. That is only acceptable while a process which fails to reach its
   * first sweep is a process something ELSE is already paging about, and the something else is
   * `ProcessRestartLoop` — `changes(prl_process_start_time_seconds[15m]) >= 3`. Three processes
   * that each died before their first sweep therefore have to fit inside fifteen minutes, which is
   * a statement about `FIRST_SWEEP_DELAY_MS` and nothing else. It was false by a factor of seventy
   * when the first sweep was at T+6h.
   *
   * The literals are spelled out here because the rule lives in `deploy/staging/observability/`
   * and cannot import anything. If that rule's window or threshold changes, this is what fails.
   */
  it('reaches its first sweep well inside the restart-loop window', () => {
    const RESTART_LOOP_WINDOW_MS = 15 * 60 * 1_000;
    const RESTART_LOOP_RESTARTS = 3;
    assert.ok(
      FIRST_SWEEP_DELAY_MS * RESTART_LOOP_RESTARTS < RESTART_LOOP_WINDOW_MS,
      `a first sweep at T+${FIRST_SWEEP_DELAY_MS} ms means ${RESTART_LOOP_RESTARTS} processes can ` +
        'each die before sweeping without ProcessRestartLoop firing, so nothing sees a dead sweep',
    );
  });

  it('does not sweep before the first tick', () => {
    // Boot is the busiest moment the process has, and an expired row can wait one interval longer
    // than it already has.
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0] });
    const timer = manualTimer();
    startRetentionSweep({
      sql: () => sql,
      onSwept: () => undefined,
      onProblem: () => undefined,
      ...timer,
    });
    assert.deepEqual(calls.sessions, [], 'a sweep ran during start-up');
  });

  it('reports what it removed on each tick', async () => {
    const { sql } = fakeSql({ sessions: [4, 0], attempts: [2, 0] });
    const timer = manualTimer();
    const swept: { sessions: number; loginAttempts: number }[] = [];
    startRetentionSweep({
      sql: () => sql,
      batchSize: 10,
      onSwept: (result) => swept.push({ sessions: result.sessions, loginAttempts: result.loginAttempts }),
      onProblem: () => undefined,
      ...timer,
    });

    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(swept, [{ sessions: 4, loginAttempts: 2 }]);
  });

  it('survives a database failure and keeps the schedule (NEGATIVE CONTROL)', async () => {
    // A maintenance timer that can take the process down is worse than no maintenance timer. The
    // rejection must reach `onProblem` and nothing else — in particular it must not become an
    // unhandled rejection, which `server.ts` turns into a fatal log and a non-zero exit.
    const { sql } = fakeSql({ sessions: [], attempts: [], throwOn: 'sessions' });
    const timer = manualTimer();
    const problems: unknown[] = [];
    let sweeps = 0;
    startRetentionSweep({
      sql: () => sql,
      onSwept: () => {
        sweeps += 1;
      },
      onProblem: (error) => problems.push(error),
      ...timer,
    });

    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(problems.length, 1, 'the failure must be reported');
    assert.equal(sweeps, 0, 'a failed sweep must not report a successful one');

    // The schedule survives it: a second tick tries again rather than the timer being dead.
    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(problems.length, 2);
  });

  it('does not start a second sweep while one is still running', async () => {
    // Possible whenever a sweep takes longer than the interval — a large first backlog on a slow
    // database. Overlapping sweeps corrupt nothing (each statement is independent) but they
    // double the load at precisely the moment the database is already struggling.
    // Typed through a holder rather than a bare `let`: TypeScript narrows a `let` assigned only
    // inside a callback to `null`, so `release?.()` below reads as "not callable".
    const held: { release: (() => void) | null } = { release: null };
    const gate = new Promise<void>((resolve) => {
      held.release = resolve;
    });
    let statements = 0;
    const sql = ((_strings: TemplateStringsArray) => {
      statements += 1;
      return gate.then(() => [] as { id: string }[]);
    }) as unknown as Sql;

    const timer = manualTimer();
    startRetentionSweep({ sql: () => sql, onSwept: () => undefined, onProblem: () => undefined, ...timer });

    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statements, 1, 'the first sweep should be in flight');

    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(statements, 1, 'a second sweep started while the first was still running');

    held.release?.();
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('stops when asked, so shutdown does not race a sweep for a pooled connection', () => {
    const { sql } = fakeSql({ sessions: [0], attempts: [0] });
    const timer = manualTimer();
    const handle = startRetentionSweep({
      sql: () => sql,
      onSwept: () => undefined,
      onProblem: () => undefined,
      ...timer,
    });
    handle.stop();
    assert.equal(timer.timeoutsCleared(), 1, 'the first delay was left armed');
  });

  /**
   * The interval, which is the timer a running process actually holds.
   *
   * The case above stops a schedule whose first delay has not elapsed, so the only thing there is
   * to cancel is a `setTimeout`. That is the shutdown of a process that has just booted. Every
   * OTHER shutdown — the one a deploy performs, every time — stops a schedule that has been
   * running for hours and whose live timer is the six-hourly `setInterval`. Nothing reached it.
   *
   * `server.ts` calls `retention?.stop()` and then closes the pool. An interval left armed against
   * a closed pool is the race this test's NAME claims to prevent, and it is what the sweep does
   * every six hours afterwards, forever, in a process that is trying to exit.
   */
  it('clears the six-hourly interval too, not only the first delay (NEGATIVE CONTROL)', async () => {
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0] });
    const timer = manualTimer();
    const handle = startRetentionSweep({
      sql: () => sql,
      onSwept: () => undefined,
      onProblem: () => undefined,
      ...timer,
    });

    // The first delay elapses: the boot sweep runs and the recurring interval is armed. This is
    // the state a process is in for all but the first few minutes of its life.
    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(timer.intervalArmed(), 'the schedule never armed an interval, so there is nothing to stop');
    const afterFirst = calls.sessions.length + calls.attempts.length;
    assert.ok(afterFirst > 0, 'the boot sweep issued no statements, so this asserts over nothing');

    handle.stop();
    assert.equal(timer.intervalsCleared(), 1, 'stop() left the six-hourly interval armed');
    assert.ok(!timer.intervalArmed(), 'the interval callback survived the stop');

    // And the consequence, asserted rather than argued: nothing sweeps a pool the shutdown is
    // about to close.
    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      calls.sessions.length + calls.attempts.length,
      afterFirst,
      'a sweep ran after the schedule was stopped',
    );
  });

  /**
   * `stop()` between arming the first delay and it firing.
   *
   * A SIGTERM in the first few minutes of a process's life lands exactly here, and the fake timers
   * a test injects do not all cancel — which is why `startRetentionSweep` checks `stopped` inside
   * the timeout callback rather than trusting `clearTimeout`. Without that flag a stopped schedule
   * arms an interval nobody holds a handle to: `stop()` has already returned, so nothing will ever
   * clear it.
   *
   * Measured: with `if (stopped) return;` deleted, the whole `@prl/api` suite passed 1,001 of
   * 1,001.
   */
  it('a schedule stopped before its first delay never arms an interval (NEGATIVE CONTROL)', async () => {
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0] });
    // A timer whose `clearTimeout` does NOT cancel, which is the case the `stopped` flag exists
    // for and the one a real fake timer library reproduces.
    const timer = manualTimer();
    const uncancellable = {
      ...timer,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    };
    const handle = startRetentionSweep({
      sql: () => sql,
      onSwept: () => undefined,
      onProblem: () => undefined,
      ...uncancellable,
    });

    handle.stop();
    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(
      calls.sessions.length + calls.attempts.length,
      0,
      'a stopped schedule still ran its boot sweep',
    );
    assert.ok(!timer.intervalArmed(), 'a stopped schedule armed an interval nothing holds a handle to');
  });
});
