/**
 * The count-up's animation loop, with the clock passed in.
 *
 * ## Why this is not inside `useCountUp`
 *
 * The release audit's A11Y-016 finding was that the three JavaScript animation drivers were
 * *not proven* to respect `prefers-reduced-motion`. They did respect it; nothing demonstrated
 * it, which for an accessibility guarantee is close to the same thing — a reader with
 * vestibular sensitivity finds out that the guard regressed by being made unwell by it.
 *
 * `node --test` runs no renderer in this repo, by policy, so a hook cannot be mounted and a hook
 * cannot be tested. This module is the answer that `easing.ts` already gave for the arithmetic:
 * move the part that can be wrong into a module that imports no React, and test *that*. What is
 * left in `useCountUp` is state plumbing with no decision in it.
 *
 * The test that matters reads as the requirement does — **ask for reduced motion and no
 * animation frame is ever requested.** Not "the flag is passed on", not "the predicate returns
 * false": zero frames, from the real driver, counted. It is the difference between checking the
 * wiring and checking the lights.
 *
 * ## Why the frame source is injected rather than read from `window`
 *
 * A fake `requestAnimationFrame` lets a test step the animation deterministically — feed it the
 * timestamps 0, 450 and 900 and the easing curve is evaluated exactly where the assertions say
 * it is, with no clock and no flake. It also means this module has no DOM reference at all, so
 * it can be imported on the server without a guard.
 *
 * Everything here is pure in the sense that matters: the same inputs and the same frame
 * timestamps produce the same sequence of values, every time.
 */

import { easeStandard, interpolate, progress } from './easing.ts';
import { type CountUpDecision, shouldCountUp } from './reduced-motion.ts';

/**
 * The two frame functions this loop needs.
 *
 * Methods rather than the bare globals, because `requestAnimationFrame` detached from `window`
 * throws "Illegal invocation" in several engines — a real bug that only appears in a browser,
 * which is the worst place for one to first appear.
 */
export interface FrameClock {
  requestAnimationFrame(callback: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

/**
 * Runs one count-up, or declines to, and returns the function that stops it.
 *
 * The decision is `shouldCountUp`'s, unchanged and unduplicated — reduced motion, a change under
 * 1%, a non-finite end, or a non-positive duration. What this adds is the *consequence*: when the
 * answer is no, `onValue` is called exactly once with the target and the clock is never touched,
 * so a reader who asked for no motion gets the settled figure and not one frame of counting.
 *
 * The returned canceller is idempotent and safe to call after the animation has finished on its
 * own, which is what lets a React effect use it directly as its cleanup.
 *
 * @param onValue called with each value to show, ending on `to` exactly (see `interpolate`)
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

  // The first frame's own timestamp is the start, rather than a clock read taken here: between
  // this line and the first callback the browser may have spent a whole frame elsewhere, and
  // starting the clock early would skip that much of the curve.
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
