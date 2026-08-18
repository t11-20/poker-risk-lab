'use client';

/**
 * Interpolates a figure towards its new value for the eye, while the DOM already holds the
 * real one.
 *
 * A naive count-up is an accessibility regression, not a flourish. The four rules below are
 * what separate the two, and every one of them is a decision this hook makes rather than a
 * convention its callers are asked to remember.
 *
 * ## 1. The real value is in the DOM immediately; only a presented copy interpolates
 *
 * This hook returns a *display* number. The component that uses it (`Metric`) renders that
 * number in an `aria-hidden` span and puts the true value in a visually hidden node inside a
 * polite live region. A screen reader therefore never reads a mid-count figure — which would
 * be worse than useless: "forty-one point two" announced eleven times, each one wrong,
 * while the reader waits to find out what their equity actually is.
 *
 * ## 2. Reduced motion, or a change under 1%, jumps straight there
 *
 * Both decisions live in `shouldCountUp` (`reduced-motion.ts`) so they are testable and
 * stated once, and the loop that acts on them lives in `driveCountUp` (`count-up-driver.ts`)
 * for the same reason — `test/motion.test.ts` runs the real driver with a fake frame clock and
 * asserts that a reader who asked for reduced motion causes **zero** animation frames. A jump is
 * not a degraded experience here; for a figure that moved 0.3% it is the *better* one.
 *
 * ## 3. `requestAnimationFrame`, cancelled on unmount and on a value change mid-flight
 *
 * The effect's cleanup cancels the pending frame, so a table pushing three updates in a
 * second cannot leave three loops running and fighting over one number. A mid-flight change
 * restarts from wherever the figure had reached — `shownRef` is written every frame — so the
 * number never jumps backwards to an old starting point.
 *
 * ## 4. Server-render safe: the first render is the final value
 *
 * `useState(value)` seeds with the target, not zero. So the server's HTML, the hydration
 * render and the browser's first paint all show the real figure: no hydration mismatch, and
 * no flash of `0%` on a page whose whole subject is that number. Counting only ever happens
 * on a *change* after mount, which is also the only time it means anything (§5.1: motion
 * answers "what changed?").
 *
 * The cost is one re-render per frame in the component that calls it, which is why `Metric`
 * confines the hook to a leaf. There is no layout in the loop — a text node changes, nothing
 * moves — and the tabular figures required by §3.3 are what stop the digits jittering while
 * they change.
 */

import { useEffect, useRef, useState } from 'react';
import { driveCountUp, type FrameClock } from './count-up-driver.ts';
import { COUNT_DURATION_MS, MIN_COUNT_UP_CHANGE } from './tokens.ts';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';

export interface CountUpOptions {
  /** Defaults to `COUNT_DURATION_MS`, the mirror of `--prl-dur-count`. */
  readonly durationMs?: number;
  /** Relative change floor as a fraction. Defaults to 1%. */
  readonly minChange?: number;
}

/**
 * The browser's frame clock, wrapped.
 *
 * The wrapping is not ceremony: `requestAnimationFrame` detached from `window` throws "Illegal
 * invocation" in several engines. Module-level rather than rebuilt per render, so the effect's
 * dependency list stays honest. Nothing calls it at import time, so a server import is safe even
 * though `requestAnimationFrame` does not exist there.
 */
const BROWSER_FRAMES: FrameClock = {
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => {
    cancelAnimationFrame(handle);
  },
};

/**
 * @param value the true figure; always render this one for assistive tech
 * @returns the figure to *show*, which equals `value` except while a count-up is running
 */
export function useCountUp(value: number, options: CountUpOptions = {}): number {
  const durationMs = options.durationMs ?? COUNT_DURATION_MS;
  const minChange = options.minChange ?? MIN_COUNT_UP_CHANGE;
  const reducedMotion = usePrefersReducedMotion();

  const [shown, setShown] = useState(value);
  // The displayed figure, mirrored outside React state so the effect can read where the
  // animation actually got to without listing `shown` as a dependency (which would restart
  // the animation on every frame it produced).
  const shownRef = useRef(value);

  useEffect(() => {
    // Everything that decides anything lives in `driveCountUp` (`count-up-driver.ts`), which is
    // testable without a renderer — including the rule that matters most here, that reduced
    // motion requests no frame at all. What is left is the state plumbing: where the animation
    // starts from, and how the figure it produces reaches React.
    //
    // The returned canceller IS the cleanup, so React's own ordering does the work the old
    // hand-rolled `frameRef` did: a value change mid-flight cancels the previous run before the
    // next one starts, and a table pushing three updates a second cannot leave three loops
    // fighting over one number.
    return driveCountUp(
      { from: shownRef.current, to: value, reducedMotion, durationMs, minChange },
      BROWSER_FRAMES,
      (next) => {
        shownRef.current = next;
        setShown(next);
      },
    );
  }, [value, durationMs, minChange, reducedMotion]);

  return shown;
}
