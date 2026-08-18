/**
 * The reveal's observation, with the browser passed in.
 *
 * Same reasoning as `count-up-driver.ts`, for the same audit finding (A11Y-016): the decision
 * was already pure and already tested (`shouldRevealImmediately`), but nothing exercised what
 * the hook *did* with it. This module is what a test can run — feed it a plan that says the
 * reader asked for reduced motion, and count how many `IntersectionObserver`s get created. The
 * answer has to be none.
 *
 * ## The hidden-document case, which is not theoretical
 *
 * `IntersectionObserver` entries are delivered from the browser's "update the rendering" step,
 * and a hidden document does not run it. Measured in Chrome on this app: with the tab in the
 * background, an element sitting **fully inside** the viewport received no entry in 1.5s, and
 * `document.timeline.currentTime` advanced by 0ms over the same window — so neither the observer
 * nor a CSS animation was going to resolve anything, and every `.prl-reveal` stayed at
 * `opacity: 0`. That is the whole of "I opened it in a new tab and the page was blank".
 *
 * So visibility is checked before observing, and again on `visibilitychange` in case the reader
 * backgrounds the tab while a reveal is still pending. Every path here fails towards *visible
 * content*: a reveal that cannot observe is a reveal that would otherwise hide its children
 * permanently, and a missing animation is a far better outcome than a blank page.
 */

import { shouldRevealImmediately } from './reduced-motion.ts';

/**
 * What `watchForReveal` needs from the browser, as three functions.
 *
 * Narrower than the DOM interfaces it stands for, deliberately: this is the whole of the
 * hook's contact with the outside world, so a reader can see the surface at a glance, and a
 * test can supply it without fabricating an `IntersectionObserver`.
 */
export interface RevealHost {
  /**
   * Begins observing `target`, calling `onIntersecting` the first time it is in view. Returns
   * the function that stops observing.
   */
  observe(target: Element, threshold: number, onIntersecting: () => void): () => void;
  /** Whether the document is hidden right now — a background tab, a prerender. */
  isDocumentHidden(): boolean;
  /** Subscribes to visibility changes. Returns the unsubscribe. */
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
 * Watches for one reveal, or resolves it at once when watching would be pointless.
 *
 * Returns the teardown. `onRevealed` is called at most once.
 *
 * `reducedMotion` is honoured here as well as at the point the hook decides its first render.
 * That is not redundancy for its own sake: it makes this function correct *on its own terms*,
 * which is what lets a test state the accessibility requirement directly — "reduced motion
 * creates no observer" — rather than through the state of a component it cannot mount.
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

  // Visible now, hidden later: the observer goes silent the moment the tab is backgrounded and
  // there is no event to tell us it resumed in time. Resolve instead of gambling.
  const stopWatchingVisibility = host.onVisibilityChange(() => {
    if (resolveIfUnobservable()) stopObserving();
  });

  return () => {
    stopWatchingVisibility();
    stopObserving();
  };
}

/**
 * The real browser, as a `RevealHost`.
 *
 * Kept beside the watcher rather than in the hook so that the hook has no DOM code left in it at
 * all. Nothing here runs at import time, so a server import is safe.
 */
export const BROWSER_REVEAL_HOST: RevealHost = {
  observe(target, threshold, onIntersecting) {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          // Stop before calling back: the reveal is one-shot, and a second entry for the same
          // element would otherwise be delivered while React is still rendering.
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
