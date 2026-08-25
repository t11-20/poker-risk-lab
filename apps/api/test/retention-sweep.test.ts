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
 * ## Why the timer is injected rather than faked with real time
 *
 * The interval is six hours. A test that waited for it would not be a test, and one that set the
 * interval to a millisecond would be a race dressed up as a schedule. The timer functions are
 * parameters, so the test holds the tick and fires it deliberately — which is also the only way
 * to assert the overlap guard, since that needs two ticks with a sweep pending between them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Sql } from '../src/db.ts';
import { runRetentionSweep, startRetentionSweep } from '../src/maintenance/retention-sweep.ts';

/**
 * A `Sql` stand-in that records the statements it is handed and answers with rows.
 *
 * The repository functions are tagged-template calls, so this is a function with the template
 * signature. It does not parse SQL — it distinguishes the two sweeps by the table name in the
 * literal, which is exactly as much as this file needs to know and no more.
 */
function fakeSql(plan: {
  readonly sessions: readonly number[];
  readonly attempts: readonly number[];
  readonly throwOn?: 'sessions' | 'attempts';
}): { sql: Sql; calls: { sessions: number[]; attempts: number[] } } {
  const calls = { sessions: [] as number[], attempts: [] as number[] };
  let sessionPass = 0;
  let attemptPass = 0;

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    // The LAST numeric interpolation is the limit in both statements. `deleteExpired` also
    // interpolates `REVOKED_RETENTION_SECONDS` (86,400) ahead of it, so "the first number" picks
    // the retention window and quietly asserts nothing about batching.
    const numbers = values.filter((value): value is number => typeof value === 'number');
    const limit = numbers.at(-1);
    const isSessions = text.includes('prl.sessions');
    if (isSessions) {
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
  }) as unknown as Sql;

  return { sql, calls };
}

/** A `setInterval`/`clearInterval` pair the test drives by hand. */
function manualTimer(): {
  readonly setIntervalImpl: typeof setInterval;
  readonly clearIntervalImpl: typeof clearInterval;
  readonly tick: () => void;
  readonly cleared: () => boolean;
} {
  let callback: (() => void) | null = null;
  let cleared = false;
  return {
    setIntervalImpl: ((fn: () => void) => {
      callback = fn;
      return { id: 'fake' } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setInterval,
    clearIntervalImpl: (() => {
      cleared = true;
    }) as unknown as typeof clearInterval,
    tick: () => callback?.(),
    cleared: () => cleared,
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
      { sessions: result.sessions, loginAttempts: result.loginAttempts, incomplete: result.incomplete },
      { sessions: 0, loginAttempts: 0, incomplete: false },
    );
    assert.equal(calls.sessions.length, 1, 'one statement is enough to learn there is nothing to do');
  });
});

describe('the schedule', () => {
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
    assert.equal(timer.cleared(), true);
  });
});
