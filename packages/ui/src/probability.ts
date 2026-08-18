/**
 * The render boundary's definition of "this number is a probability", and the one
 * formatter that refuses rather than renders when it is not.
 *
 * ## Why this exists at all, given the producer already checks
 *
 * `@prl/poker-math` refuses an impossible probability at source: `coach.ts` returns a
 * typed refusal (`already-ahead`, `no-clean-outs`, `not-a-probability`) instead of a
 * rule-of-2-and-4 figure it cannot stand behind, and `assertProbabilityFraction` *throws*
 * on anything outside 0..1. Its own comment names the bug class it closed — "a hand with
 * 45 'outs' was 100% to win and the shortcut called it 180%".
 *
 * That check protects the *computation*. It does not protect the *page*. A `CoachReport`
 * reaches `CoachPanel` as plain JSON over the wire, and between the two sit a cache, a
 * fixture file, a deserialiser and whatever the next refactor introduces. Fed the stale
 * fixture value `estimate: 1.6`, the panel used to print
 *
 *     "The rule of 2 and 4 estimates 160.0%"
 *
 * — a 160% probability, stated in the app's own authoritative voice, in a product whose
 * entire premise is never being confidently wrong about probability. The computation was
 * right; the presentation layer had no guard at all, so any stale or malformed input
 * reached the learner as fact.
 *
 * So this is defence in depth, and it is deliberately *duplicated* logic. The data layer
 * is the right place to fix a wrong number. This is the place that guarantees a wrong
 * number can never be *read*, whatever went wrong upstream and whoever regresses it next.
 *
 * ## Why a predicate here and not a clamp in `format.ts`
 *
 * `format.ts` says, at length and correctly, that it never rescues a value: a formatter
 * that quietly turned 36 into "36.0%" would have hidden the unit mismatch that produced
 * "3,600.0%" for good, and hiding an impossible number hides the bug that made it. That
 * rule stands. Nothing here changes what `formatPercent` does with a bad input.
 *
 * The difference is who is asking. A *formatter* has no idea whether 1.6 is a probability
 * or a growth rate, so it must render what it is given. A *component* rendering the words
 * "your share of the pot" knows exactly which of the two it has, and can decline. Hence a
 * predicate the caller consults, and a formatter that returns `null` — the caller still has
 * to decide what to say instead, which is the part that needs a human sentence.
 *
 * ## The three ranges, because they are not the same range
 *
 * Conflating them is how a guard ends up rejecting a legitimate figure, which teaches the
 * next reader to remove it:
 *
 *  - a **probability** is a fraction in `0..1` (`heroEquity`, `breakEvenEquity`, `estimate`);
 *  - a **difference of two probabilities** is a fraction in `-1..1` (`equitySurplus`);
 *  - the same difference **already scaled** is in `-100..100` points (`errorPoints`,
 *    `halfWidthPoints`) — a field whose name ends in `Points`, per the contract's convention.
 *
 * Every bound is inclusive: 0, 1, and an error of exactly 100 points are all reachable and
 * all real.
 *
 * Pure, no React, no DOM — so `test/probability.test.ts` can exercise every branch.
 */

import { formatPercent, type PercentOptions } from './format.ts';

/**
 * What a component prints in place of a figure it has refused.
 *
 * Not "—" and not "n/a": both read as *missing*, and the difference matters. A missing
 * figure is a gap in the data; this one arrived, was read, and was rejected. The phrase
 * says which, in three words a learner and a bug reporter both understand.
 */
export const NOT_A_PROBABILITY = 'not a probability';

/**
 * A probability as this codebase carries it: a fraction in 0..1.
 *
 * `Number.isFinite` is the whole numeric test and it does not coerce, so a `null`, a
 * `undefined` or a `"0.36"` that slipped through a wire boundary fails here rather than
 * being compared as a number. `NaN` and both infinities fail with it.
 */
export function isProbabilityFraction(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A difference between two probabilities, still as a fraction: -1..1.
 *
 * `equitySurplus` is the live example — equity minus the break-even equity. It is
 * legitimately negative (a call that is not priced in), which is exactly why it cannot be
 * checked with `isProbabilityFraction`.
 */
export function isProbabilityDifference(value: number): boolean {
  return Number.isFinite(value) && value >= -1 && value <= 1;
}

/**
 * A probability difference that is already scaled into percentage points: -100..100.
 *
 * The contract's naming rule is that a field carrying this unit says so (`errorPoints`,
 * `halfWidthPoints`) and a field with no unit in its name is a fraction. This predicate is
 * for the former; sending a fraction through it would pass every value and check nothing.
 */
export function isProbabilityPoints(value: number): boolean {
  return Number.isFinite(value) && value >= -100 && value <= 100;
}

/**
 * `formatPercent` for a value that has to be a probability, and `null` for one that is not.
 *
 * The `null` is the point. It makes "what do we say instead?" a decision the call site
 * cannot skip — TypeScript will not let a `string | null` be dropped into a template
 * literal without handling the second case — where a clamp or a fallback string would have
 * let the caller carry on as though nothing happened.
 */
export function formatProbability(fraction: number, options: PercentOptions = {}): string | null {
  if (!isProbabilityFraction(fraction)) return null;
  return formatPercent(fraction, options);
}
