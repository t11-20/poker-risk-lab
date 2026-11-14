/**
 * The render boundary's guard for "this number is a probability". The producer refuses impossible
 * values too, but JSON, caches and fixtures sit between, so a stale `estimate: 1.6` would render 160.0%.
 * `formatPercent` still never clamps. A component that knows it holds a probability asks here instead.
 * Three ranges: probability 0..1, difference -1..1, difference in points -100..100. Bounds are inclusive.
 * Pot fractions (bet size over pot, bar widths) can exceed 1 and must not come through here.
 */

import { formatPercent, type PercentOptions } from './format.ts';

/** Not "—" or "n/a", which read as missing. This value arrived and was rejected. */
export const NOT_A_PROBABILITY = 'not a probability';

/** `Number.isFinite` does not coerce, so `null` or `"0.36"` from the wire fails here. */
export function isProbabilityFraction(value: number): boolean {
  return normaliseProbability(value) !== null;
}

/**
 * Float error is around `1e-16`, and the smallest real defect (a stale `1.6`) is off by 0.6.
 * A value within this of a bound snaps to it, because `0.1 + 0.2 + 0.7` is not exactly 1.
 */
export const PROBABILITY_TOLERANCE = 1e-9;

/** `value + 0` turns `-0` into `0`, so `Object.is` comparisons on the result hold. */
function snap(value: number, low: number, high: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < low) return value >= low - PROBABILITY_TOLERANCE ? low : null;
  if (value > high) return value <= high + PROBABILITY_TOLERANCE ? high : null;
  return value + 0;
}

/** The single definition of the domain. Every other check here delegates to it. */
export function normaliseProbability(value: number): number | null {
  return snap(value, 0, 1);
}

export function normaliseProbabilityDifference(value: number): number | null {
  return snap(value, -1, 1);
}

export function normaliseProbabilityPoints(value: number): number | null {
  return snap(value, -100, 100);
}

/** For `equitySurplus`, which is legitimately negative. */
export function isProbabilityDifference(value: number): boolean {
  return normaliseProbabilityDifference(value) !== null;
}

/** For fields named `...Points`. A fraction sent through here passes every value and checks nothing. */
export function isProbabilityPoints(value: number): boolean {
  return normaliseProbabilityPoints(value) !== null;
}

/** `null` for a non-probability, so the type forces the call site to decide what to say instead. */
export function formatProbability(fraction: number, options: PercentOptions = {}): string | null {
  const normalised = normaliseProbability(fraction);
  if (normalised === null) return null;
  // The snapped value, so the output does not depend on how many decimals were asked for.
  return formatPercent(normalised, options);
}
