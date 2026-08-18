/**
 * The JS mirror of the motion tokens — the only numbers in this package that also exist
 * in `tokens.css`.
 *
 * ## Why a mirror exists at all
 *
 * The house rule is that no component carries a raw duration or easing literal: every
 * value comes from a `--prl-*` token. One animation cannot honour that, and it is the one
 * animation the design system explicitly asks for in JS — the metric count-up (§5.2).
 * `requestAnimationFrame` needs a duration as a *number* and an easing curve as a
 * *function*, and a CSS custom property is neither: it is a string that only resolves once
 * an element is in a document, which is exactly not true during server rendering.
 *
 * So the values are duplicated here, deliberately, in one file, with the token they mirror
 * named on each. Anything else in this package that wants a duration must use CSS.
 *
 * If a token changes, change it here too. `docs/frontend-design-system.md` §5 records this
 * mirror so the duplication is a documented decision rather than a discovered surprise.
 */

/** Mirrors `--prl-dur-count: 900ms`. The count-up is the only JS-driven animation. */
export const COUNT_DURATION_MS = 900;

/**
 * Mirrors `--prl-ease-standard: cubic-bezier(0.62, 0.14, 0.12, 1)` — the signature curve:
 * fast out, long settle. Held as its four control-point coordinates because
 * `easing.ts` evaluates the curve rather than handing it to CSS.
 */
export const EASE_STANDARD_CONTROL_POINTS = [0.62, 0.14, 0.12, 1] as const;

/**
 * The smallest relative change worth animating, as a fraction: 1%.
 *
 * §5.2 requires count-up to be skipped "for changes under 1%". Below that the animation is
 * shorter than the reader's saccade and all it does is make a settled figure look unsettled
 * — the opposite of what motion is for here. `reduced-motion.ts` applies it.
 */
export const MIN_COUNT_UP_CHANGE = 0.01;
