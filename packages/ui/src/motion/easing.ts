/**
 * Count-up arithmetic, React-free so `test/motion.test.ts` can run it.
 * The count-up evaluates the real `--prl-ease-standard` curve so it eases like the CSS around it.
 * Newton-Raphson inverts x for a progress, with bisection as a guaranteed fallback.
 */

import { EASE_STANDARD_CONTROL_POINTS } from './tokens.ts';

/** Enough for double precision on a well-behaved curve; the fallback catches the rest. */
const NEWTON_ITERATIONS = 8;
const BISECTION_ITERATIONS = 24;
const EPSILON = 1e-7;

/** `B(s) = 3(1-s)^2 s a1 + 3(1-s) s^2 a2 + s^3`, outer control points 0 and 1. */
function component(a1: number, a2: number, s: number): number {
  const inverse = 1 - s;
  return 3 * inverse * inverse * s * a1 + 3 * inverse * s * s * a2 + s * s * s;
}

/** `dB/ds = 3 a1 (1-s)(1-3s) + 3 a2 s(2-3s) + 3 s^2`. */
function slope(a1: number, a2: number, s: number): number {
  const inverse = 1 - s;
  return 3 * a1 * inverse * (1 - 3 * s) + 3 * a2 * s * (2 - 3 * s) + 3 * s * s;
}

function solveParameter(x1: number, x2: number, x: number): number {
  let guess = x;
  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const error = component(x1, x2, guess) - x;
    if (Math.abs(error) < EPSILON) return guess;
    const gradient = slope(x1, x2, guess);
    // A vanishing gradient would send the step to infinity, so hand over to bisection.
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

/** Both ends are exact, so the last frame lands on the target. Non-finite progress means finished. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (progress: number) => number {
  return (progress: number): number => {
    if (!Number.isFinite(progress)) return 1;
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    return component(y1, y2, solveParameter(x1, x2, progress));
  };
}

/** Mirrors `--prl-ease-standard`. */
export const easeStandard = cubicBezier(...EASE_STANDARD_CONTROL_POINTS);

/**
 * Endpoints by identity, because `from + (to - from) * 1` can settle on `41.199999999999996`.
 * `NaN` resolves to `to`, so the DOM never shows NaN.
 */
export function interpolate(from: number, to: number, t: number): number {
  if (Number.isNaN(t) || t >= 1) return to;
  if (t <= 0) return from;
  return from + (to - from) * t;
}

/** A duration of zero or less is already done, so `durationMs: 0` asks for no animation. */
export function progress(elapsedMs: number, durationMs: number): number {
  if (!Number.isFinite(elapsedMs) || !Number.isFinite(durationMs)) return 1;
  if (durationMs <= 0) return 1;
  if (elapsedMs <= 0) return 0;
  if (elapsedMs >= durationMs) return 1;
  return elapsedMs / durationMs;
}
