/**
 * How a numeric question's unit and its tolerance are rendered — and why they are not the same
 * question.
 *
 * ## The defect this module exists for
 *
 * `QUIZ_UNIT_DECIMALS` answers "how many decimals is a FIGURE in this unit worth showing". For
 * `count` and `hands` that is zero, because a count is never fractional. The hint under the numeric
 * field used that same number for the TOLERANCE, and a tolerance is a different quantity: it is
 * routinely a fraction of the unit it is expressed in. `counting-outs-q4` declares `tolerance: 0.5`
 * and `(0.5).toFixed(0)` is `"1"`, so the field said
 *
 *     "Anything within 1 cards of the computed figure is accepted."
 *
 * Measured on `/learn/counting-outs` in Chrome 151, stepped through to the numeric question with
 * the API up. `withinTolerance` applies `|answer − expected| <= 0.5`, so only the exact integer is
 * accepted. A learner who answered 8 to an answer of 9 did precisely what the field told them was
 * allowed and was refused. Rounding a figure is a presentation choice; rounding the RULE a figure
 * is checked against, outwards, is a false statement about what will be accepted.
 *
 * ## Why this is a leaf module
 *
 * Nothing is imported here except a type, which is erased. `lib/learn-calculations.ts` — where this
 * belongs by subject — imports runtime values from `@prl/ui`, whose entry point re-exports `.tsx`,
 * and Node's type stripping cannot load a `.tsx` under `node --test` (`ERR_UNKNOWN_FILE_EXTENSION`).
 * So no test in this app has ever been able to import that module, and the rule this file states is
 * exactly the sort that has to be checked against the questions that actually ship. Same shape and
 * same reason as `lib/session-cookie-names.ts` and `lib/age-gate.ts`.
 *
 * `learn-calculations.ts` re-exports both maps below, so every existing import site is unchanged
 * and there is still only one definition of each.
 */

import type { QuizQuestion } from '@prl/contracts';

/** The unit a numeric question declares. Derived from the contract, never restated as a union. */
export type QuizUnit = Extract<QuizQuestion, { kind: 'numeric' }>['unit'];

/** The unit word shown beside a numeric input and its expected value. */
export const QUIZ_UNIT_WORDS: Readonly<Record<QuizUnit, string>> = {
  percent: '%',
  chips: 'units',
  ratio: 'to 1',
  count: 'cards',
  hands: 'hands',
};

/** How many decimals a FIGURE in this unit is worth showing. A count is never fractional. */
export const QUIZ_UNIT_DECIMALS: Readonly<Record<QuizUnit, number>> = {
  percent: 1,
  chips: 1,
  ratio: 1,
  count: 0,
  hands: 0,
};

/**
 * How many decimals the TOLERANCE needs, which is at least as many as the unit and sometimes one
 * more.
 *
 * One more and not "as many as it takes": a tolerance is a band a person is meant to work inside,
 * and `0.05` shown as `0.05` is useful where `0.0333…` shown to six places is noise. The band is
 * still never widened — `statedTolerance` below is what holds that line, and a question whose
 * tolerance cannot be stated truthfully at one extra decimal is caught there rather than here.
 */
export function toleranceDecimals(tolerance: number, unitDecimals: number): number {
  const scaled = Math.abs(tolerance) * 10 ** unitDecimals;
  if (!Number.isFinite(scaled)) return unitDecimals;
  // Rounded before the integer test so binary floating point cannot report 0.2 × 10 as 1.9999999996
  // and add a decimal nobody needs.
  return Number.isInteger(Math.round(scaled * 1e6) / 1e6) ? unitDecimals : unitDecimals + 1;
}

/**
 * The number a reader is actually shown, as a number.
 *
 * The rendered string goes through `formatChips`, which is `toFixed` plus thousands separators, so
 * this is the same rounding without the formatting — which is what lets a test compare what the
 * field CLAIMS against what the grader allows, rather than comparing one string with another.
 */
export function statedTolerance(tolerance: number, unitDecimals: number): number {
  return Number(tolerance.toFixed(toleranceDecimals(tolerance, unitDecimals)));
}

/**
 * The band an answer has to fall in, as the two numbers that define it.
 *
 * A structural subset of `ExpectedAnswer` in `lib/learn-calculations.ts`, which satisfies it — the
 * rest of that type is the figure and the whole calculation it came from, and neither is part of
 * this decision.
 */
export interface ToleranceBand {
  readonly value: number;
  readonly tolerance: number;
}

/**
 * Slack added to the stated tolerance so that binary floating point cannot narrow it.
 *
 * Scaled by the magnitude of the numbers being compared, because that is how the error scales: the
 * gap between representable doubles near a value of 3 is about 4.4e-16, and near 3,000 it is a
 * thousand times that. A fixed epsilon would be far too small for a pot in the thousands and
 * needlessly large for a percentage.
 *
 * Eight ulps rather than one. `answer - value` is already the difference of two rounded quantities,
 * and `value` itself arrives from a chain of arithmetic in `computeCalculation`, so the error at
 * this point is several roundings deep rather than one. Eight is still far below anything a learner
 * could type: at a value of 1,000 it is 1.8e-12 units.
 */
const TOLERANCE_SLACK_ULPS = 8;

/**
 * Whether an answer falls inside the question's stated tolerance. Inclusive at the boundary.
 *
 * ## The defect this exists for
 *
 * `Math.abs(answer - expected.value) <= tolerance` refuses an answer at exactly the stated
 * tolerance for some magnitudes, because the subtraction is not exact:
 *
 *     |3.2 − 3.0| = 0.20000000000000018   >  0.2   →  refused
 *     |2.2 − 2.0| = 0.20000000000000018   >  0.2   →  refused
 *     |4.2 − 4.0| = 0.20000000000000018   >  0.2   →  refused
 *     |8.2 − 8.0| = 0.1999999999999993    <= 0.2   →  accepted
 *     |1.2 − 1.0| = 0.19999999999999996   <= 0.2   →  accepted
 *
 * Whether a learner is accepted therefore depends on the binary representation of the expected
 * value, which is not a property of anything they were taught. And the field **states the
 * tolerance** — `formatTolerance` prints it underneath, at enough precision to be true, precisely
 * so that a learner can work to it. A field that states a rule and applies a slightly tighter one
 * is the same class of defect as the hint that stated a rule twice as wide, which is the reason
 * this module exists at all.
 *
 * The stated band is widened by the size of the arithmetic error and by nothing more: the accepted
 * band must BE the stated band, not a comfortable superset of it.
 */
export function withinTolerance(answer: number, expected: ToleranceBand): boolean {
  if (!Number.isFinite(answer)) return false;
  const tolerance = Math.abs(expected.tolerance);
  const difference = Math.abs(answer - expected.value);
  if (difference <= tolerance) return true;
  const scale = Math.max(1, Math.abs(answer), Math.abs(expected.value), tolerance);
  return difference <= tolerance + TOLERANCE_SLACK_ULPS * Number.EPSILON * scale;
}
