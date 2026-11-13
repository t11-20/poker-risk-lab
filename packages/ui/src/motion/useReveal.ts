'use client';

/**
 * Reveals an element the first time it enters the viewport. An `IntersectionObserver`, never a
 * scroll listener or layout read, and unobserved after the first trigger.
 * This decides when. CSS decides how, from `data-revealed` (see `Reveal.tsx`).
 * On the server `observerAvailable` is `true`, so the markup matches most clients' first render.
 */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { shouldRevealImmediately } from './reduced-motion.ts';
import { BROWSER_REVEAL_HOST, watchForReveal } from './reveal-watcher.ts';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';

/** A fifth in view, so a tall panel arrives early and a one-pixel sliver does not count. */
const DEFAULT_THRESHOLD = 0.2;

export interface RevealOptions {
  /** Fraction of the element that must be visible, 0..1. */
  readonly threshold?: number;
}

export interface RevealState<T extends Element> {
  readonly ref: RefObject<T | null>;
  readonly revealed: boolean;
}

export function useReveal<T extends Element = HTMLElement>(options: RevealOptions = {}): RevealState<T> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const reducedMotion = usePrefersReducedMotion();
  const ref = useRef<T | null>(null);
  const [observed, setObserved] = useState(false);

  // No `documentHidden` at render, because it has no server answer and would mismatch on hydration.
  // The effect handles it.
  const immediate = shouldRevealImmediately({
    reducedMotion,
    observerAvailable: typeof window === 'undefined' || typeof window.IntersectionObserver === 'function',
  });
  const revealed = immediate || observed;

  useEffect(() => {
    if (immediate || observed) return;
    const node = ref.current;
    if (node === null) return;

    // `watchForReveal` takes the browser as an argument, so `test/motion.test.ts` can run it.
    return watchForReveal(
      { target: node, reducedMotion, observerAvailable: true, threshold },
      BROWSER_REVEAL_HOST,
      () => setObserved(true),
    );
  }, [immediate, observed, reducedMotion, threshold]);

  return { ref, revealed };
}
