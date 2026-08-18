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
 * stated once. A jump is not a degraded experience here; for a figure that moved 0.3% it is
 * the *better* one.
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
import { easeStandard, interpolate, progress } from './easing.ts';
import { shouldCountUp } from './reduced-motion.ts';
import { COUNT_DURATION_MS, MIN_COUNT_UP_CHANGE } from './tokens.ts';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';

export interface CountUpOptions {
  /** Defaults to `COUNT_DURATION_MS`, the mirror of `--prl-dur-count`. */
  readonly durationMs?: number;
  /** Relative change floor as a fraction. Defaults to 1%. */
  readonly minChange?: number;
}

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
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const cancel = (): void => {
      if (frameRef.current === null) return;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };

    const from = shownRef.current;
    const to = value;
    cancel();

    if (!shouldCountUp({ from, to, reducedMotion, durationMs, minChange })) {
      shownRef.current = to;
      setShown(to);
      return;
    }

    // The first frame's own timestamp is the start, rather than a `performance.now()` read
    // taken here: between this line and the first callback the browser may have spent a
    // whole frame elsewhere, and starting the clock early would skip that much of the curve.
    let startedAt: number | null = null;
    const step = (now: number): void => {
      if (startedAt === null) startedAt = now;
      const elapsed = progress(now - startedAt, durationMs);
      const next = interpolate(from, to, easeStandard(elapsed));
      shownRef.current = next;
      setShown(next);
      if (elapsed < 1) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(step);

    return cancel;
  }, [value, durationMs, minChange, reducedMotion]);

  return shown;
}
