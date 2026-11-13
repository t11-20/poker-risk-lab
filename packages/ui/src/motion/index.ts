/**
 * The motion primitives. No animation library, because everything else is CSS (§5.4).
 * The pure decisions are exported so other callers ask the same question as the hooks.
 */

export { driveCountUp, type FrameClock } from './count-up-driver.ts';
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
  BROWSER_REVEAL_HOST,
  type RevealHost,
  type RevealPlan,
  watchForReveal,
} from './reveal-watcher.ts';
export {
  COUNT_DURATION_MS,
  EASE_STANDARD_CONTROL_POINTS,
  MIN_COUNT_UP_CHANGE,
} from './tokens.ts';
export { type CountUpOptions, useCountUp } from './useCountUp.ts';
export {
  createReducedMotionStore,
  type MediaQueryHost,
  type ReducedMotionQuery,
  type ReducedMotionStore,
  usePrefersReducedMotion,
} from './usePrefersReducedMotion.ts';
export { type RevealOptions, type RevealState, useReveal } from './useReveal.ts';
