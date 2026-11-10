/**
 * The one rule for whether a numeric quiz answer is inside its stated tolerance.
 *
 * It lived in `apps/web/src/lib/quiz-tolerance.ts`, and the web used it only for its OWN comparison
 * — the fallback shown when the server has not answered. The server's verdict wins whenever it
 * answers (`resolvedVerdict` in `apps/web/src/lib/quiz-attempts.ts`), and the API graded with the
 * plain `Math.abs(answer - value) <= tolerance` this function exists to replace. So the defect the
 * comment below describes was fixed on the path learners almost never see and live on the one they
 * do: `spr-q2` marks 3.2 against 3 with a stated tolerance of 0.2 WRONG, because
 * `Math.abs(3.2 - 3)` is 0.20000000000000018. Here, so the API, the web and the chat bot grade with
 * one definition.
 */

/**
 * The band an answer has to fall in, as the two numbers that define it.
 *
 * A structural subset of `ExpectedAnswer` in `apps/web/src/lib/learn-calculations.ts`, which satisfies it — the
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
