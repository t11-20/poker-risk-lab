'use client';

/**
 * Reveals an element the first time it enters the viewport, and never thinks about it again.
 *
 * ## The rules this hook exists to keep
 *
 *  - **`IntersectionObserver`, never a scroll listener.** A scroll handler runs on the main
 *    thread at scroll frequency; an observer is delivered by the browser only when the
 *    answer changes. There is no `getBoundingClientRect` here either, for the same reason —
 *    reading layout during a scroll is what turns a smooth page into a stuttering one.
 *  - **Unobserve after the first trigger.** A reveal is a one-shot event. Leaving the
 *    observer attached would keep firing for the rest of the session and would let an
 *    element un-reveal itself on the way back up, which answers no question a reader has.
 *  - **Resolve immediately when motion is off, when there is no observer, or when the document
 *    is hidden.** All three fail towards *visible content*: a reveal that cannot observe is a
 *    reveal that would otherwise hide its children permanently.
 *
 * ## The hidden-document case, which is not theoretical
 *
 * `IntersectionObserver` entries are delivered from the browser's "update the rendering" step,
 * and a hidden document does not run it. Measured in Chrome on this app: with the tab in the
 * background, an element sitting **fully inside** the viewport received no entry in 1.5s, and
 * `document.timeline.currentTime` advanced by 0ms over the same window — so neither the
 * observer nor a CSS animation was going to resolve anything. Every `.prl-reveal` stayed at
 * `opacity: 0`. That is the whole of "I opened it in a new tab and the page was blank".
 *
 * So the effect checks visibility before it observes, and listens for `visibilitychange` in
 * case the reader backgrounds the tab while a reveal is still pending. Note the check is made
 * in the *effect*, never during render: `document.visibilityState` has no server-side answer,
 * and reading it during render would make the client's first pass disagree with the server's
 * markup for exactly the readers whose tab is hidden.
 *
 * ## Where the CSS boundary is
 *
 * This hook decides *when*; the stylesheet decides *what it looks like*. The state is
 * published as `data-revealed="true" | "false"` (see `Reveal.tsx`) so `.prl-reveal` can
 * express the hidden state as `[data-revealed='false']` and the arrival as a transition on
 * `transform` and `opacity`. No inline transition, no measured height, no JS animation.
 *
 * ## Server rendering
 *
 * `observerAvailable` reports `true` on the server rather than probing a global that only
 * exists in a browser. That keeps the server's markup identical to what the
 * overwhelming majority of clients render on their first pass, so hydration has nothing to
 * correct. On the vanishing minority with no observer, the first client render resolves to
 * revealed straight away.
 */

import { type RefObject, useEffect, useRef, useState } from 'react';
import { shouldRevealImmediately } from './reduced-motion.ts';
import { BROWSER_REVEAL_HOST, watchForReveal } from './reveal-watcher.ts';
import { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';

/**
 * A fifth of the element in view. Small enough that a tall panel arrives while the reader is
 * still reading towards it, large enough that a one-pixel sliver does not count as arrival.
 */
const DEFAULT_THRESHOLD = 0.2;

export interface RevealOptions {
  /** Fraction of the element that must be visible, 0..1. */
  readonly threshold?: number;
}

export interface RevealState<T extends Element> {
  /** Attach to the element being revealed. */
  readonly ref: RefObject<T | null>;
  readonly revealed: boolean;
}

export function useReveal<T extends Element = HTMLElement>(options: RevealOptions = {}): RevealState<T> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const reducedMotion = usePrefersReducedMotion();
  const ref = useRef<T | null>(null);
  const [observed, setObserved] = useState(false);

  // `documentHidden` is deliberately NOT supplied here. It has no server-side answer, and a
  // render-time probe would resolve differently on the server (visible) and in a backgrounded
  // client (hidden), which is a hydration mismatch on the very attribute this hook publishes.
  // The hidden case is handled in the effect below, where the DOM exists and hydration is done.
  const immediate = shouldRevealImmediately({
    reducedMotion,
    observerAvailable: typeof window === 'undefined' || typeof window.IntersectionObserver === 'function',
  });
  const revealed = immediate || observed;

  useEffect(() => {
    // Nothing to observe: either motion is off, there is no observer, or this element has
    // already had its one reveal.
    if (immediate || observed) return;
    const node = ref.current;
    if (node === null) return;

    // The observation itself lives in `watchForReveal` (`reveal-watcher.ts`), which imports no
    // React and takes the browser as an argument — so the rule that a reader who asked for
    // reduced motion never gets an observer at all is a thing `test/motion.test.ts` can run,
    // rather than a thing this file merely claims. It re-asks the same predicate with the one
    // input only the client can answer: a hidden document runs no rendering step, so it delivers
    // no observer entries and advances no animation clock; waiting for either is waiting forever.
    return watchForReveal(
      { target: node, reducedMotion, observerAvailable: true, threshold },
      BROWSER_REVEAL_HOST,
      () => setObserved(true),
    );
  }, [immediate, observed, reducedMotion, threshold]);

  return { ref, revealed };
}
