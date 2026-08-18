/**
 * The motion primitives, in one place.
 *
 * Three hooks and the pure functions behind them. There is no animation library here and
 * there will not be one: the whole surface is a reveal, a count-up and a preference read,
 * and every other animation in the app is CSS (§5.4 — "prefer `@keyframes` and `transition`
 * over JS"). An animation library would be a dependency, a bundle, and a second easing
 * vocabulary competing with `tokens.css`.
 *
 * The pure modules are exported alongside the hooks on purpose. They are how anything else
 * that needs to *decide* about motion — a page-level boot sequence, a future chart — asks the
 * same question and gets the same answer, instead of re-reading `matchMedia` with a slightly
 * different fallback.
 */

export {
  cubicBezier,
  easeStandard,
  interpolate,
  progress,
} from './easing.ts';
export {
  type CountUpDecision,
  REDUCED_MOTION_QUERY,
  type RevealDecision,
  shouldCountUp,
  shouldRevealImmediately,
} from './reduced-motion.ts';
export {
  COUNT_DURATION_MS,
  EASE_STANDARD_CONTROL_POINTS,
  MIN_COUNT_UP_CHANGE,
} from './tokens.ts';
export { type CountUpOptions, useCountUp } from './useCountUp.ts';
export { usePrefersReducedMotion } from './usePrefersReducedMotion.ts';
export { type RevealOptions, type RevealState, useReveal } from './useReveal.ts';
