/**
 * The two decisions that make motion in this app safe, as pure predicates.
 *
 * `prefers-reduced-motion` is not a preference about taste. For a reader with vestibular
 * sensitivity a moving figure can cause nausea, and for a reader using a screen reader a
 * counting number is a stream of announcements they cannot stop. So the *decision* to
 * animate is extracted from the hooks that act on it, for two reasons:
 *
 *  1. It can be unit-tested. Hooks cannot be, in this repo — `node --test` runs no
 *     renderer — and "did we correctly decide not to animate" is precisely the logic that
 *     must not regress silently.
 *  2. It is stated once. `useReveal` and `useCountUp` both consult it, and a second copy of
 *     "…or the change is under one percent" is a second copy that can drift.
 *
 * Nothing here touches the DOM, a clock, or React. `usePrefersReducedMotion` supplies the
 * `reducedMotion` input; these functions only judge it.
 */

import { MIN_COUNT_UP_CHANGE } from './tokens.ts';

/**
 * The media query, spelled once.
 *
 * `reduce` is the only non-default value in the specification, so this is the whole test —
 * `no-preference` is simply the absence of a match.
 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface RevealDecision {
  readonly reducedMotion: boolean;
  /** Whether `IntersectionObserver` exists in this environment. */
  readonly observerAvailable: boolean;
  /**
   * Whether the document is currently hidden — a background tab, a minimised or fully
   * occluded window, a prerender. Optional because there is no honest answer on the
   * server; omitting it means "not known to be hidden", which is the value that keeps
   * the server's markup and the client's first render identical.
   */
  readonly documentHidden?: boolean;
}

/**
 * Whether a reveal must resolve to its final state at once rather than on scroll.
 *
 * Every input is a "reveal immediately" case and they all fail in the same direction, which
 * is the important property: content is *shown*. A reveal that cannot observe its element is
 * a reveal that would otherwise leave the element hidden forever, and hidden content is a
 * far worse outcome than a missing animation.
 *
 * ## Why `documentHidden` is one of them — this was a real, reproducible bug
 *
 * `IntersectionObserver` callbacks are delivered from the browser's "update the rendering"
 * step. A hidden document does not run that step, so in a background tab the observer never
 * fires at all — measured in Chrome on this app: an element sitting *fully inside* the
 * viewport got no entry in 1.5s, and `document.timeline.currentTime` did not advance by a
 * single millisecond over the same period. Every `.prl-reveal` therefore stayed at
 * `opacity: 0`, which is exactly what "open the site in a background tab and the page is
 * blank" looks like.
 *
 * A reveal answers "is this new information?". Nobody is looking at a hidden document, so
 * there is no question to answer and nothing to animate: resolve, and let the reader arrive
 * to content rather than to a fade.
 */
export function shouldRevealImmediately(decision: RevealDecision): boolean {
  return decision.reducedMotion || !decision.observerAvailable || decision.documentHidden === true;
}

export interface CountUpDecision {
  /** The figure currently on screen. */
  readonly from: number;
  /** The figure to settle on. */
  readonly to: number;
  readonly reducedMotion: boolean;
  readonly durationMs: number;
  /** Relative change floor, as a fraction. Defaults to `MIN_COUNT_UP_CHANGE` (1%). */
  readonly minChange?: number;
}

/**
 * Whether a figure should count up to its new value, or simply be it.
 *
 * Five ways the answer is no, in order of how often they fire:
 *
 *  - the reader asked for reduced motion (§5.3);
 *  - nothing changed;
 *  - the change is under 1% of the figure (§5.2), so the animation would be noise;
 *  - either end is not a finite number, so there is nothing to interpolate — a missing
 *    figure must appear as "not available" instantly, never counted towards;
 *  - the duration is zero or negative, which is a caller asking for no animation.
 *
 * ## Why the threshold is *relative*
 *
 * "Under 1%" has two readings, and the absolute one is wrong here. This UI shows figures on
 * wildly different scales in the same panel: an equity is a fraction in 0..1, a pot is
 * hundreds of units. An absolute 0.01 floor would animate every 6-unit twitch of a
 * 1,200-unit pot while refusing to animate an equity swing from 41% to 45%, which is the
 * single most meaningful change on the screen. Relative to the larger of the two ends, both
 * behave sensibly, and dividing by the larger end is also what keeps a 0 → 500 change
 * (relative change 1) from dividing by zero.
 */
export function shouldCountUp(decision: CountUpDecision): boolean {
  if (decision.reducedMotion) return false;
  if (!Number.isFinite(decision.from) || !Number.isFinite(decision.to)) return false;
  if (!Number.isFinite(decision.durationMs) || decision.durationMs <= 0) return false;
  const change = Math.abs(decision.to - decision.from);
  if (change === 0) return false;
  // Both ends cannot be zero here: that would have made `change` zero and returned above.
  const scale = Math.max(Math.abs(decision.from), Math.abs(decision.to));
  return change / scale >= (decision.minChange ?? MIN_COUNT_UP_CHANGE);
}
