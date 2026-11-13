/**
 * The reveal's observation with the browser passed in, so a test can count observers (A11Y-016).
 * It checks visibility before observing and on `visibilitychange`, because a hidden document
 * delivers no entries (see `shouldRevealImmediately`). Every path fails towards visible content.
 */

import { shouldRevealImmediately } from './reduced-motion.ts';

/** The hook's whole contact with the browser, narrow so a test needs no `IntersectionObserver`. */
export interface RevealHost {
  /** Calls `onIntersecting` the first time `target` is in view. Returns the stop function. */
  observe(target: Element, threshold: number, onIntersecting: () => void): () => void;
  isDocumentHidden(): boolean;
  onVisibilityChange(listener: () => void): () => void;
}

export interface RevealPlan {
  readonly target: Element;
  readonly reducedMotion: boolean;
  readonly observerAvailable: boolean;
  /** Fraction of the element that must be visible, 0..1. */
  readonly threshold: number;
}

/**
 * Returns the teardown. `onRevealed` is called at most once.
 * `reducedMotion` is checked here too, so a test can assert that reduced motion creates no observer.
 */
export function watchForReveal(plan: RevealPlan, host: RevealHost, onRevealed: () => void): () => void {
  const resolveIfUnobservable = (): boolean => {
    const immediate = shouldRevealImmediately({
      reducedMotion: plan.reducedMotion,
      observerAvailable: plan.observerAvailable,
      documentHidden: host.isDocumentHidden(),
    });
    if (!immediate) return false;
    onRevealed();
    return true;
  };

  if (resolveIfUnobservable()) return () => undefined;

  const stopObserving = host.observe(plan.target, plan.threshold, onRevealed);

  // A backgrounded tab silences the observer with no event when it resumes, so resolve instead.
  const stopWatchingVisibility = host.onVisibilityChange(() => {
    if (resolveIfUnobservable()) stopObserving();
  });

  return () => {
    stopWatchingVisibility();
    stopObserving();
  };
}

/** Nothing here runs at import time, so a server import is safe. */
export const BROWSER_REVEAL_HOST: RevealHost = {
  observe(target, threshold, onIntersecting) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // Stop before calling back, or a second entry arrives while React is still rendering.
          observer.unobserve(entry.target);
          observer.disconnect();
          onIntersecting();
          break;
        }
      },
      { threshold },
    );
    observer.observe(target);
    return () => observer.disconnect();
  },
  isDocumentHidden() {
    return document.hidden;
  },
  onVisibilityChange(listener) {
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
};
