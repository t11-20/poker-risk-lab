/**
 * Renders a numeric question's unit and tolerance. A tolerance is not a figure in its unit, so
 * `tolerance: 0.5` in `cards` must not print as "within 1", which overstates what is accepted.
 */

import type { QuizQuestion } from '@prl/contracts';

/** Derived from the contract, never restated as a union. */
export type QuizUnit = Extract<QuizQuestion, { kind: 'numeric' }>['unit'];

export const QUIZ_UNIT_WORDS: Readonly<Record<QuizUnit, string>> = {
  percent: '%',
  chips: 'units',
  ratio: 'to 1',
  count: 'cards',
  hands: 'hands',
};

/** A count is never fractional. */
export const QUIZ_UNIT_DECIMALS: Readonly<Record<QuizUnit, number>> = {
  percent: 1,
  chips: 1,
  ratio: 1,
  count: 0,
  hands: 0,
};

/**
 * The unit's decimals, plus one when the tolerance needs it. Never more, so `0.0333…` is not printed
 * to six places. `statedTolerance` is what keeps the band from being widened.
 */
export function toleranceDecimals(tolerance: number, unitDecimals: number): number {
  const scaled = Math.abs(tolerance) * 10 ** unitDecimals;
  if (!Number.isFinite(scaled)) return unitDecimals;
  // Rounded first, so floating point cannot report 0.2 × 10 as 1.9999999996.
  return Number.isInteger(Math.round(scaled * 1e6) / 1e6) ? unitDecimals : unitDecimals + 1;
}

/** The same rounding `formatChips` applies, as a number, so a test can compare it with the grader. */
export function statedTolerance(tolerance: number, unitDecimals: number): number {
  return Number(tolerance.toFixed(toleranceDecimals(tolerance, unitDecimals)));
}

export { type ToleranceBand, withinTolerance } from '@prl/contracts';
