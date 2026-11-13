'use client';

/**
 * A display copy of a figure that counts towards its new value. `Metric` renders it `aria-hidden`
 * and puts the true value in a polite live region, so a screen reader never hears a mid-count number.
 * The first render is the final value, so SSR and hydration match and no `0%` flashes.
 * The decisions live in `driveCountUp`, where `test/motion.test.ts` asserts zero frames under
 * reduced motion. One re-render per frame, which is why `Metric` keeps this in a leaf.
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
 * Wrapped because a detached `requestAnimationFrame` throws "Illegal invocation" in several engines.
 * Nothing calls it at import time, so a server import is safe.
 */
const BROWSER_FRAMES: FrameClock = {
  requestAnimationFrame: (callback) => requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => {
    cancelAnimationFrame(handle);
  },
};

/** Returns the figure to show. Always render `value` itself for assistive tech. */
export function useCountUp(value: number, options: CountUpOptions = {}): number {
  const durationMs = options.durationMs ?? COUNT_DURATION_MS;
  const minChange = options.minChange ?? MIN_COUNT_UP_CHANGE;
  const reducedMotion = usePrefersReducedMotion();

  const [shown, setShown] = useState(value);
  // A ref, so a mid-flight change restarts from where the figure got to without `shown` as a dependency.
  const shownRef = useRef(value);

  useEffect(() => {
    // The canceller is the cleanup, so a mid-flight change stops the previous loop before the next starts.
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
