/** The one rule for whether a numeric quiz answer is inside its tolerance, shared by API, web and bot. */

/** A structural subset of `ExpectedAnswer` in `apps/web/src/lib/learn-calculations.ts`. */
export interface ToleranceBand {
  readonly value: number;
  readonly tolerance: number;
}

/**
 * Slack so binary floating point cannot narrow the stated tolerance. Scaled by magnitude, because
 * double spacing near 3 is about 4.4e-16 and near 3,000 a thousand times that. Eight ulps because
 * `value` is several roundings deep. At a value of 1,000 the slack is 1.8e-12.
 */
const TOLERANCE_SLACK_ULPS = 8;

/**
 * Whether an answer falls inside the stated tolerance, inclusive at the boundary.
 * Plain `Math.abs(answer - value) <= tolerance` refuses some exact-boundary answers, because
 * `|3.2 - 3.0|` is 0.20000000000000018. The band is widened by the arithmetic error and nothing more.
 */
export function withinTolerance(answer: number, expected: ToleranceBand): boolean {
  if (!Number.isFinite(answer)) return false;
  const tolerance = Math.abs(expected.tolerance);
  const difference = Math.abs(answer - expected.value);
  if (difference <= tolerance) return true;
  const scale = Math.max(1, Math.abs(answer), Math.abs(expected.value), tolerance);
  return difference <= tolerance + TOLERANCE_SLACK_ULPS * Number.EPSILON * scale;
}
