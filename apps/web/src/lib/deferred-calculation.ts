/**
 * Runs one deferred calculation on a worker. Preflop equity blocked the main thread for ~0.95 s at 4x
 * CPU. If the worker cannot start or load, the same function runs here after a zero-delay timer, so the
 * figure always arrives. Nothing is stored (ADR 0006).
 */

import type { LiveCalculation } from '@prl/contracts';
import type { CalculationOutcome } from './learn-calculations.ts';

export interface CalculationRequest {
  readonly calculation: LiveCalculation;
}

export interface CalculationReply {
  readonly outcome: CalculationOutcome;
}

/** The part of `Worker` this uses, so a test can stand one in. */
export interface CalculationThread {
  addEventListener(type: 'message' | 'error' | 'messageerror', listener: (event: Event) => void): void;
  postMessage(request: CalculationRequest): void;
  terminate(): void;
}

/** Where the figure was computed, so a gate can tell a dead worker from a working one. */
export type ComputedOn = 'worker' | 'here';

export interface DeferredHost {
  /** `null` where workers are unavailable. May throw, which is treated the same way. */
  readonly startThread: () => CalculationThread | null;
  readonly computeHere: (calculation: LiveCalculation) => CalculationOutcome;
  /** A timer, not `requestAnimationFrame`, which never fires in a background tab. Returns a cancel. */
  readonly later: (run: () => void) => () => void;
}

/** Calls `onOutcome` once, unless cancelled first. Returns the cancel. */
export function computeDeferred(
  calculation: LiveCalculation,
  host: DeferredHost,
  onOutcome: (outcome: CalculationOutcome, on: ComputedOn) => void,
): () => void {
  let done = false;
  let thread: CalculationThread | null = null;
  let cancelTimer: (() => void) | null = null;

  const finish = (outcome: CalculationOutcome, on: ComputedOn): void => {
    if (done) return;
    done = true;
    thread?.terminate();
    thread = null;
    onOutcome(outcome, on);
  };

  const fallBack = (): void => {
    if (done || cancelTimer !== null) return;
    thread?.terminate();
    thread = null;
    // A worker reply that lands before the timer has already finished, so the figure is not computed twice.
    cancelTimer = host.later(() => {
      if (!done) finish(host.computeHere(calculation), 'here');
    });
  };

  try {
    thread = host.startThread();
  } catch {
    thread = null;
  }
  if (thread === null) {
    fallBack();
  } else {
    thread.addEventListener('message', (event) => {
      finish((event as MessageEvent<CalculationReply>).data.outcome, 'worker');
    });
    thread.addEventListener('error', fallBack);
    thread.addEventListener('messageerror', fallBack);
    thread.postMessage({ calculation });
  }

  return () => {
    done = true;
    thread?.terminate();
    thread = null;
    cancelTimer?.();
  };
}
