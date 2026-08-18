/**
 * Turn timers: one absolute deadline per table, and a clock seam so nothing sleeps in a test.
 *
 * ## Absolute deadlines, never intervals
 *
 * A turn timer is "seat 3 must act by 1755470412345", not "tick every second and count down".
 * Three reasons, and the third is the one that bites:
 *
 *   1. The client renders the countdown from `deadlineMs` in `WsState`, so the server sends one
 *      number per state change instead of a tick per second per socket.
 *   2. A reconnect needs no catch-up: the deadline is in the next state frame, and the browser
 *      computes the remainder itself.
 *   3. `setInterval` drift and event-loop stalls accumulate. A deadline does not: if the process
 *      was busy for 400ms, the deadline has still passed at exactly the moment it was always
 *      going to pass, and the expiry fires late rather than wrong. `schedule()` is therefore
 *      re-armed for the remainder whenever a timer fires early (`setTimeout` is allowed to, and
 *      does, fire a millisecond short).
 *
 * ## Why every expiry carries the hand and the seat it was armed for
 *
 * A timer that fires after the hand moved on must do nothing. Between arming and firing the
 * seat may have acted, folded, stood up, or the whole hand may have completed and a new one
 * started — and "the timer fired, so fold whoever is to act" would fold a player who has been
 * thinking for two seconds. `TurnExpiry` records `handId`, `seat` and `deadlineMs`, and the
 * table re-checks all three against its current state before it applies anything. Cancelling on
 * action is the first line of defence; this is the second, and it is the one that holds when the
 * cancel is missed.
 *
 * ## The clock seam
 *
 * `Clock` exists so that a test can drive a five-minute timeout in a microsecond and so that
 * nothing in the suite depends on wall time. `createManualClock` lives here rather than in the
 * test tree deliberately: it is an implementation of this file's own interface, it is compiled
 * by the same `tsconfig.json` as the production path, and keeping the two next to each other is
 * what stops them drifting. Nothing under `src/` uses it.
 *
 * Real timers are `unref`'d. An armed turn timer must never be the reason a process refuses to
 * exit — a table waiting on a player who has closed their laptop would otherwise hold the event
 * loop open for the whole timeout, including after a test finishes.
 */

/** A scheduled callback that has not run yet. Cancelling twice is safe. */
export interface ScheduledTask {
  cancel(): void;
}

/** The two things this module needs from time. Injected everywhere; never read globally. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
  /** Runs `run` after at least `delayMs`. */
  schedule(delayMs: number, run: () => void): ScheduledTask;
}

/** The production clock: `Date.now` and an `unref`'d `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (delayMs, run) => {
    const handle = setTimeout(run, Math.max(0, delayMs));
    // See the module comment: a pending turn timer must not keep the process alive.
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

/** A clock a test drives by hand. */
export interface ManualClock extends Clock {
  /** Moves time forward and runs everything that came due, in deadline order. */
  advance(ms: number): void;
  /** Tasks still waiting. Lets a test assert that a timer was cancelled. */
  readonly pending: number;
}

interface ManualTask {
  readonly dueAt: number;
  readonly run: () => void;
  cancelled: boolean;
}

/**
 * A clock whose time only moves when `advance` is called.
 *
 * `advance` runs due tasks in deadline order and tolerates a task that schedules another one:
 * the loop re-checks the queue after each callback, so a re-armed timer inside the advanced
 * window still fires within the same call. It will not spin forever on a task that re-arms at
 * the same instant, because a task is removed from the queue before it runs.
 */
export function createManualClock(startMs = 1_700_000_000_000): ManualClock {
  let current = startMs;
  let tasks: ManualTask[] = [];

  const runDue = (): void => {
    for (;;) {
      tasks = tasks.filter((task) => !task.cancelled);
      const due = tasks
        .filter((task) => task.dueAt <= current)
        .sort((left, right) => left.dueAt - right.dueAt);
      const next = due[0];
      if (next === undefined) return;
      tasks = tasks.filter((task) => task !== next);
      next.run();
    }
  };

  return {
    now: () => current,
    schedule: (delayMs, run) => {
      const task: ManualTask = { dueAt: current + Math.max(0, delayMs), run, cancelled: false };
      tasks.push(task);
      return {
        cancel: () => {
          task.cancelled = true;
        },
      };
    },
    advance: (ms) => {
      current += Math.max(0, ms);
      runDue();
    },
    get pending(): number {
      return tasks.filter((task) => !task.cancelled).length;
    },
  };
}

/** What a fired timer says about itself, so the table can check it is still relevant. */
export interface TurnExpiry {
  readonly handId: string;
  readonly seat: number;
  /** The deadline this expiry belongs to, so a late fire cannot be mistaken for a fresh one. */
  readonly deadlineMs: number;
}

export interface TurnTimerOptions {
  readonly clock: Clock;
  /**
   * Called once, when the deadline has genuinely passed. The callback must re-check that the
   * expiry still describes the current hand and the seat still to act — see the module comment.
   */
  readonly onExpiry: (expiry: TurnExpiry) => void;
}

/**
 * One table's turn timer.
 *
 * Holds at most one armed deadline. Arming again replaces the previous one, which is exactly
 * what happens when the action moves to the next seat, so a caller cannot leak timers by
 * forgetting to cancel first.
 */
export class TurnTimer {
  private readonly clock: Clock;
  private readonly onExpiry: (expiry: TurnExpiry) => void;
  private task: ScheduledTask | null = null;
  private armed: TurnExpiry | null = null;
  private disposed = false;

  constructor(options: TurnTimerOptions) {
    this.clock = options.clock;
    this.onExpiry = options.onExpiry;
  }

  /** The absolute deadline currently armed, or null. Goes straight onto the wire. */
  get deadlineMs(): number | null {
    return this.armed?.deadlineMs ?? null;
  }

  /** What is armed, for the table's staleness check. */
  get expiry(): TurnExpiry | null {
    return this.armed;
  }

  /**
   * Arms an absolute deadline, replacing whatever was armed before.
   *
   * A deadline already in the past fires on the next turn of the event loop rather than
   * synchronously: firing inside the caller would re-enter the table's queue from the middle of
   * a mutation, which is the one thing the queue exists to prevent.
   */
  arm(expiry: TurnExpiry): void {
    if (this.disposed) return;
    this.cancel();
    this.armed = expiry;
    this.task = this.clock.schedule(expiry.deadlineMs - this.clock.now(), () => this.fire(expiry));
  }

  cancel(): void {
    this.task?.cancel();
    this.task = null;
    this.armed = null;
  }

  /**
   * Releases the timer for good.
   *
   * Called when a room closes. A closed room that could still fire a timer would fold a seat at
   * a table nobody is sitting at, and — worse — would hold a reference to the whole table for
   * the length of the timeout, so the registry's `delete` would not actually free anything.
   */
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private fire(expiry: TurnExpiry): void {
    if (this.disposed) return;
    // Not the deadline we are waiting on any more: a later `arm` replaced it and this is a
    // callback that had already been queued. Ignore it.
    if (this.armed !== expiry) return;
    const remaining = expiry.deadlineMs - this.clock.now();
    if (remaining > 0) {
      // Fired early. `setTimeout` is permitted to, so re-arm for the remainder rather than
      // treating a deadline that has not passed as one that has.
      this.task = this.clock.schedule(remaining, () => this.fire(expiry));
      return;
    }
    this.task = null;
    this.armed = null;
    this.onExpiry(expiry);
  }
}
