/**
 * Turn timers: one absolute deadline per table, and a clock seam so nothing sleeps in a test.
 * Absolute deadlines, never intervals. The client counts down from `deadlineMs`, a reconnect needs
 * no catch-up, and an event-loop stall makes an expiry late rather than wrong.
 * Every expiry carries `handId`, `seat` and `deadlineMs`, and the table re-checks them before acting,
 * so a timer that fires after the hand moved on folds nobody.
 * Real timers are `unref`'d so a pending turn never keeps the process alive.
 */

/** A scheduled callback that has not run yet. Cancelling twice is safe. */
export interface ScheduledTask {
  cancel(): void;
}

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
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  },
};

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

/** `advance` removes a task before running it, so a task that re-arms at the same instant cannot spin. */
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
  /** Called once, when the deadline has passed. The callback must re-check the expiry is current. */
  readonly onExpiry: (expiry: TurnExpiry) => void;
}

/** Holds at most one armed deadline. Arming again replaces the previous one. */
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
   * A deadline already past fires on the next event-loop turn, not synchronously, so it cannot
   * re-enter the table's queue mid-mutation.
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

  /** Called when a room closes, so no timer folds a seat at a closed table or pins it in memory. */
  dispose(): void {
    this.cancel();
    this.disposed = true;
  }

  private fire(expiry: TurnExpiry): void {
    if (this.disposed) return;
    // A later `arm` replaced this deadline.
    if (this.armed !== expiry) return;
    const remaining = expiry.deadlineMs - this.clock.now();
    if (remaining > 0) {
      // `setTimeout` may fire early. Re-arm for the remainder.
      this.task = this.clock.schedule(remaining, () => this.fire(expiry));
      return;
    }
    this.task = null;
    this.armed = null;
    this.onExpiry(expiry);
  }
}
