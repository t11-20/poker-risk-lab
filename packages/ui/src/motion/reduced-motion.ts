/**
 * The decisions to animate, as pure predicates, so they are unit-tested and stated once for
 * `useReveal` and `useCountUp`. `usePrefersReducedMotion` supplies the `reducedMotion` input.
 */

import { MIN_COUNT_UP_CHANGE } from './tokens.ts';

/** `reduce` is the only non-default value in the spec. */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

export interface RevealDecision {
  readonly reducedMotion: boolean;
  readonly observerAvailable: boolean;
  /** Omitted on the server, meaning "not known to be hidden", so server and first client render match. */
  readonly documentHidden?: boolean;
}

/**
 * Every input fails towards showing content, because hidden content is worse than a missing animation.
 * A hidden document never delivers `IntersectionObserver` callbacks (measured in Chrome, none in 1.5s
 * for an element fully in view), so a background tab otherwise left every `.prl-reveal` invisible.
 */
export function shouldRevealImmediately(decision: RevealDecision): boolean {
  return decision.reducedMotion || !decision.observerAvailable || decision.documentHidden === true;
}

export interface CountUpDecision {
  readonly from: number;
  readonly to: number;
  readonly reducedMotion: boolean;
  readonly durationMs: number;
  /** Relative change floor, as a fraction. Defaults to `MIN_COUNT_UP_CHANGE` (1%). */
  readonly minChange?: number;
}

/**
 * No for reduced motion (§5.3), no change, a change under 1% (§5.2), a non-finite end (a missing
 * figure must appear at once), or a duration of zero or less.
 * The floor is relative to the larger end. An absolute floor would animate a pot's 6-unit twitch
 * and skip an equity swing from 41% to 45%.
 */
export function shouldCountUp(decision: CountUpDecision): boolean {
  if (decision.reducedMotion) return false;
  if (!Number.isFinite(decision.from) || !Number.isFinite(decision.to)) return false;
  if (!Number.isFinite(decision.durationMs) || decision.durationMs <= 0) return false;
  const change = Math.abs(decision.to - decision.from);
  if (change === 0) return false;
  // Both ends cannot be zero here, because that would have made `change` zero and returned above.
  const scale = Math.max(Math.abs(decision.from), Math.abs(decision.to));
  return change / scale >= (decision.minChange ?? MIN_COUNT_UP_CHANGE);
}
