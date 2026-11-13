/**
 * The count-up loop with the clock passed in, so `test/motion.test.ts` can count frames (A11Y-016).
 * Under reduced motion no frame is ever requested. An injected clock also steps deterministically
 * and leaves this module free of DOM references, so a server import needs no guard.
 */

import { easeStandard, interpolate, progress } from './easing.ts';
import { type CountUpDecision, shouldCountUp } from './reduced-motion.ts';

/** Methods, because a detached `requestAnimationFrame` throws "Illegal invocation" in several engines. */
export interface FrameClock {
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

/**
 * When `shouldCountUp` says no, `onValue` gets the target once and the clock is never touched.
 * The canceller is idempotent, so a React effect can use it directly as its cleanup.
 * `onValue` ends on `to` exactly (see `interpolate`).
 */
export function driveCountUp(
  decision: CountUpDecision,
  clock: FrameClock,
  onValue: (value: number) => void,
): () => void {
  if (!shouldCountUp(decision)) {
    onValue(decision.to);
    return () => undefined;
  }

  let handle: number | null = null;

  // The first frame's timestamp is the start, so a frame lost before the first callback skips no curve.
  let startedAt: number | null = null;
  const step = (now: number): void => {
    if (startedAt === null) startedAt = now;
    const elapsed = progress(now - startedAt, decision.durationMs);
    onValue(interpolate(decision.from, decision.to, easeStandard(elapsed)));
    if (elapsed < 1) {
      handle = clock.requestAnimationFrame(step);
      return;
    }
    handle = null;
  };
  handle = clock.requestAnimationFrame(step);

  return () => {
    if (handle === null) return;
    clock.cancelAnimationFrame(handle);
    handle = null;
  };
}
