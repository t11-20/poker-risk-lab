/**
 * The JS mirror of the motion tokens in `tokens.css`, because `requestAnimationFrame` needs numbers
 * and a custom property does not resolve during SSR. Change both together (design system §5).
 */

/** Mirrors `--prl-dur-count: 900ms`. The count-up is the only JS-driven animation. */
export const COUNT_DURATION_MS = 900;

/** Mirrors `--prl-ease-standard: cubic-bezier(0.62, 0.14, 0.12, 1)`, as control points for `easing.ts`. */
export const EASE_STANDARD_CONTROL_POINTS = [0.62, 0.14, 0.12, 1] as const;

/** 1%, from §5.2. A smaller change only makes a settled figure look unsettled. */
export const MIN_COUNT_UP_CHANGE = 0.01;
