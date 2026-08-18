/**
 * The count-up's arithmetic: a cubic-bézier evaluator, linear interpolation, and elapsed
 * time to progress.
 *
 * ## Why these are here and not inside the hook
 *
 * `node --test` cannot run JSX or hooks in this repo (no renderer dependency, by policy),
 * so anything worth testing has to live in a module that imports no React. That is not a
 * concession: interpolation and easing are the parts that can be *wrong* in a way nobody
 * notices — a count-up that overshoots, an ease that returns NaN at t=0, a final frame that
 * lands on 41.199999 instead of 41.2. Each of those is asserted in `test/motion.test.ts`.
 *
 * ## Why a bézier solver rather than a hand-rolled ease
 *
 * The design system names one signature curve (`--prl-ease-standard`) and uses it for every
 * transition in the app. A JS count-up that eased differently from the CSS around it would
 * read as a different system. Evaluating the actual curve is ~30 lines and removes the
 * question entirely.
 *
 * A CSS `cubic-bezier(x1, y1, x2, y2)` is a bézier from (0,0) to (1,1) with those two
 * control points. It is a *parametric* curve, so drawing it for a given progress means
 * inverting it: find the parameter `s` where the x-component equals the progress, then read
 * the y-component at that `s`. Newton-Raphson converges in a handful of steps for a curve
 * that is monotonic in x (which any legal CSS curve is), and bisection is kept as a
 * guaranteed fallback for the pathological case rather than trusting the derivative.
 *
 * Everything here is pure and deterministic: same input, same output, no clock, no DOM.
 */

import { EASE_STANDARD_CONTROL_POINTS } from './tokens.ts';

/** Enough for double precision on a well-behaved curve; the fallback catches the rest. */
const NEWTON_ITERATIONS = 8;
const BISECTION_ITERATIONS = 24;
const EPSILON = 1e-7;

/**
 * One component of a cubic bézier whose outer control points are 0 and 1.
 *
 * `B(s) = 3(1-s)^2 s a1 + 3(1-s) s^2 a2 + s^3`
 */
function component(a1: number, a2: number, s: number): number {
  const inverse = 1 - s;
  return 3 * inverse * inverse * s * a1 + 3 * inverse * s * s * a2 + s * s * s;
}

/**
 * `dB/ds` for the same component.
 *
 * `3 a1 (1-s)(1-3s) + 3 a2 s(2-3s) + 3 s^2` — which is `3 a1` at s=0 and `3(1 - a2)` at
 * s=1, the two slopes CSS authors think of as the curve's "ends".
 */
function slope(a1: number, a2: number, s: number): number {
  const inverse = 1 - s;
  return 3 * a1 * inverse * (1 - 3 * s) + 3 * a2 * s * (2 - 3 * s) + 3 * s * s;
}

/** Finds the curve parameter whose x-component is `x`. */
function solveParameter(x1: number, x2: number, x: number): number {
  let guess = x;
  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const error = component(x1, x2, guess) - x;
    if (Math.abs(error) < EPSILON) return guess;
    const gradient = slope(x1, x2, guess);
    // A flat or vanishing gradient would send Newton's step to infinity. Hand over to
    // bisection instead of producing a wild parameter.
    if (Math.abs(gradient) < EPSILON) break;
    guess -= error / gradient;
  }

  let low = 0;
  let high = 1;
  let middle = x;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    middle = (low + high) / 2;
    const value = component(x1, x2, middle);
    if (Math.abs(value - x) < EPSILON) return middle;
    if (value < x) low = middle;
    else high = middle;
  }
  return middle;
}

/**
 * Builds an easing function from four CSS control-point coordinates.
 *
 * The returned function maps progress in 0..1 to eased progress in 0..1, pinning both
 * ends exactly: `f(0) === 0` and `f(1) === 1` are returned without touching the solver, so
 * a count-up's last frame lands on its target rather than near it. A non-finite input is
 * treated as "finished" — a NaN progress must never become a NaN on screen.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  return (progress: number): number => {
    if (!Number.isFinite(progress)) return 1;
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    return component(y1, y2, solveParameter(x1, x2, progress));
  };
}

/** The app's signature curve, evaluated in JS. Mirrors `--prl-ease-standard`. */
export const easeStandard = cubicBezier(...EASE_STANDARD_CONTROL_POINTS);

/**
 * Linear interpolation with exact endpoints.
 *
 * `t <= 0` returns `from` and `t >= 1` returns `to` *by identity*, not by arithmetic. That
 * matters more than it looks: `from + (to - from) * 1` is not always exactly `to` in binary
 * floating point, and a metric that settles on `41.199999999999996` renders one wrong digit
 * at two decimals. A non-finite `t` also resolves to `to`, for the same reason as above —
 * the DOM never shows NaN because a frame arrived with a strange timestamp.
 */
export function interpolate(from: number, to: number, t: number): number {
  if (Number.isNaN(t) || t >= 1) return to;
  if (t <= 0) return from;
  return from + (to - from) * t;
}

/**
 * Elapsed milliseconds as progress in 0..1.
 *
 * A zero or negative duration is "already done" rather than a division by zero, which is
 * what makes `durationMs: 0` a legitimate way for a caller to ask for no animation.
 */
export function progress(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs)) return 1;
  if (durationMs <= 0) return 1;
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  return elapsedMs / durationMs;
}
