/**
 * The retention sweep's loop and schedule. The SQL is `repositories.test.ts` and
 * `retention-sweep-database.test.ts`. This file asserts batching through a backlog, a reported
 * `maxPasses` ceiling, survival of a database error, no overlapping sweeps, and the guest loop's
 * re-check and per-account failure isolation. Timers are injected because the interval is six hours.
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
 * `came-back` was chosen in an earlier snapshot and is no longer abandoned when locked.
 * `blocked` has its delete refused, as a foreign key without a referential action would.
 */
type GuestOutcome = 'erased' | 'came-back' | 'blocked';

/**
 * A `Sql` stand-in that dispatches on a distinctive phrase in each literal and records calls.
 * A guest erasure goes through `deleteAccount` and is eight statements, answered here so a sweep
 * that never opened a transaction would be noticed. `came-back` is decided by the separate
 * re-check, never by the lock, so this fake fails the single-statement version that erased a
 * student granted a place while the sweep waited.
 */
function fakeSql(plan: {
  readonly sessions: readonly number[];
  readonly attempts: readonly number[];
  readonly guests?: readonly number[];
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
    // The limit is the LAST number. Earlier ones are retention windows.
    const numbers = values.filter((value): value is number => typeof value === 'number');
    const limit = numbers.at(-1);

    // `abandonedGuestPredicate` is a fragment that postgres.js keeps lazy and this fake evaluates.
    // Unrecognised, it would eat a pass of the session plan.
    if (text.includes("u.kind = 'guest'")) return Promise.resolve([]);

    if (text.includes('order by u.last_seen_at')) {
      calls.guests.push(limit ?? 0);
      const count = plan.guests?.[guestPass] ?? 0;
      guestPass += 1;
      const pass = guestPass;
      return Promise.resolve(Array.from({ length: count }, (_, i) => ({ id: `usr_g${pass}_${i}` })));
    }
    if (text.includes('from prl.users u') && text.includes('for update')) {
      const userId = String(values[0]);
      calls.transactions.push(userId);
      return Promise.resolve([{ id: userId }]);
    }
    if (text.includes('from prl.users u')) {
      const userId = String(values[0]);
      return Promise.resolve(outcomeOf(userId) === 'came-back' ? [] : [{ id: userId }]);
    }
    if (text.includes('count(*)')) {
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

  // `deleteAccount` refuses a handle without `savepoint`, so only the transaction handle has one.
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

/** `tick()` fires the first-sweep one-shot, then the interval it arms. */
function manualTimer(): {
  readonly setTimeoutImpl: typeof setTimeout;
  readonly clearTimeoutImpl: typeof clearTimeout;
  readonly setIntervalImpl: typeof setInterval;
  readonly clearIntervalImpl: typeof clearInterval;
  readonly tick: () => void;
  readonly cleared: () => boolean;
  /** Counted apart, because one shared flag let a `stop()` that skipped the interval pass. */
  readonly timeoutsCleared: () => number;
  readonly intervalsCleared: () => number;
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

/** A clock that honours the requested delays, to count sweeps over a process lifetime. */
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
      // Re-read every round, because a callback may arm a new timer.
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
    const { sql, calls } = fakeSql({ sessions: [10, 10, 10, 3], attempts: [10, 0] });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 10, maxPasses: 100 });

    assert.equal(result.sessions, 33, 'a sweep that stopped after one batch would report 10');
    assert.equal(result.loginAttempts, 10);
    assert.equal(result.incomplete, false);
    assert.deepEqual(calls.sessions, [10, 10, 10, 10], 'every statement must carry the batch limit');
    assert.deepEqual(calls.attempts, [10, 10]);
  });

  it('stops at maxPasses and reports that it is incomplete', async () => {
    const { sql, calls } = fakeSql({ sessions: Array.from({ length: 20 }, () => 10), attempts: [0] });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 10, maxPasses: 3 });

    assert.equal(result.sessions, 30);
    assert.equal(result.incomplete, true, 'a ceiling that is not reported is a silent truncation');
    assert.equal(calls.sessions.length, 3, 'it must not keep going past the ceiling');
  });

  it('takes nothing when there is nothing expired', async () => {
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
    // Derived, not chosen. A guest is unreachable once its last possible session expires, and
    // `legal-register.md` L5 says an engineer may not pick this number.
    assert.equal(GUEST_RETENTION_SECONDS, SESSION_ABSOLUTE_TTL_SECONDS);
    assert.equal(GUEST_RETENTION_SECONDS, 60 * 24 * 60 * 60, 'sixty days, as /privacy §5 publishes it');
  });

  it('erases each candidate in its own transaction and works through a backlog', async () => {
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0], guests: [3, 3, 1] });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 3, maxPasses: 100 });

    assert.equal(result.guestAccounts, 7, 'a sweep that stopped after one batch would report 3');
    assert.equal(result.guestAccountsBlocked, 0);
    assert.equal(result.incomplete, false);
    assert.deepEqual(calls.guests, [3, 3, 3], 'every choosing query must carry the batch limit');
    assert.equal(calls.transactions.length, 7, 'each account must be erased in a transaction of its own');
  });

  it('leaves a guest that came back to life between being chosen and being locked (NEGATIVE CONTROL)', async () => {
    const { sql, calls } = fakeSql({
      sessions: [0],
      attempts: [0],
      guests: [2, 0],
      guestOutcome: (userId) => (userId === 'usr_g1_0' ? 'came-back' : 'erased'),
    });
    const result = await runRetentionSweep({ sql: () => sql, batchSize: 2, maxPasses: 100 });

    assert.equal(result.guestAccounts, 1, 'the account that came back must not be counted as erased');
    assert.equal(result.guestAccountsBlocked, 0, 'coming back is not a failure');
    // Termination counts rows offered, not removed.
    assert.deepEqual(calls.guests, [2, 2], 'a full batch must be followed by another pass');
  });

  it('steps over an account the database refuses and still takes the rest (NEGATIVE CONTROL)', async () => {
    // A shared transaction or an escaped error would offer this account first for ever, oldest first.
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
   * A first sweep on the six-hour interval's first tick meant a deployment shipped more often than
   * that swept nothing, and the uptime-based age gauge hid it. `>= 8`, not `> 0`, so the schedule
   * cannot depend on a process living long enough.
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
   * The age gauge reports uptime before a first sweep, which is safe only if three processes dying
   * before their first sweep trip `ProcessRestartLoop` (`changes(...[15m]) >= 3`). The literals
   * mirror that rule in `deploy/staging/observability/`, which cannot be imported.
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
    // An unhandled rejection is fatal in `server.ts`, so the error must reach `onProblem` only.
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

    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(problems.length, 2);
  });

  it('does not start a second sweep while one is still running', async () => {
    // A holder, because TypeScript narrows a `let` assigned only in a callback to `null`.
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

  /** Every shutdown after the first minutes stops a live `setInterval`, then `server.ts` closes the pool. */
  it('clears the six-hourly interval too, not only the first delay (NEGATIVE CONTROL)', async () => {
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0] });
    const timer = manualTimer();
    const handle = startRetentionSweep({
      sql: () => sql,
      onSwept: () => undefined,
      onProblem: () => undefined,
      ...timer,
    });

    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(timer.intervalArmed(), 'the schedule never armed an interval, so there is nothing to stop');
    const afterFirst = calls.sessions.length + calls.attempts.length;
    assert.ok(afterFirst > 0, 'the boot sweep issued no statements, so this asserts over nothing');

    handle.stop();
    assert.equal(timer.intervalsCleared(), 1, 'stop() left the six-hourly interval armed');
    assert.ok(!timer.intervalArmed(), 'the interval callback survived the stop');

    timer.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      calls.sessions.length + calls.attempts.length,
      afterFirst,
      'a sweep ran after the schedule was stopped',
    );
  });

  /**
   * `startRetentionSweep` checks `stopped` in the timeout callback because not every timer cancels.
   * With that check deleted, the rest of the suite passed 1,001 of 1,001.
   */
  it('a schedule stopped before its first delay never arms an interval (NEGATIVE CONTROL)', async () => {
    const { sql, calls } = fakeSql({ sessions: [0], attempts: [0] });
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
