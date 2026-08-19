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
 * ## Floating point, and why the bounds are not `<= 1` on the nose
 *
 * A bare `value <= 1` is the wrong domain for a number that was *computed*. Equity comes out
 * of a Monte Carlo division, a rule-of-thumb estimate out of a multiplication, and a set of
 * policy weights out of a normalisation — and `0.1 + 0.2 + 0.7` is `0.9999999999999999`,
 * while a normalisation over the same three can land on `1.0000000000000002`. Neither is an
 * impossible probability. Both would be refused by an exact bound, and a guard that refuses
 * correct figures is a guard somebody deletes within the month.
 *
 * So the domain is `[-TOLERANCE, 1 + TOLERANCE]` and `normaliseProbability` SNAPS a value
 * inside it to the real bound. That is not the clamp `format.ts` refuses to do: the tolerance
 * is one part in a billion, which is smaller than any unit error, any stale-fixture error and
 * any percent/fraction mix-up can possibly be. `1.6` is still refused. `36` is still refused.
 * `1 + 1e-16` renders as `100.0%`, which is what it means.
 *
 * ## What "enforced at the data boundary" means here
 *
 * This module is the *definition* of the domain. Enforcing it is the job of whoever reads a
 * value: a component that has a probability calls `formatProbability`, gets `null` for one
 * that is not, and has to say something. What it must not do is hand the raw number to
 * `formatPercent` — which will faithfully print `160.0%`, because a formatter cannot know
 * which of the two it was given. Every render site in this repo that holds a value the
 * contract types as a probability goes through here; the ones that hold a *pot fraction* (a
 * bet size as a share of the pot, a bar's width) deliberately do not, because those are
 * legitimately greater than 1 and refusing them would be the same conflation in reverse.
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
  return normaliseProbability(value) !== null;
}

/**
 * How far outside a bound a computed value may land and still be that bound.
 *
 * One part in a billion. Chosen to be enormous next to accumulated floating-point error — a few
 * ULPs at this magnitude is around `1e-16` — and minute next to every real defect this guard
 * exists to catch: a percent-for-fraction mix-up is off by a factor of 100, a stale fixture that
 * said `1.6` is off by 0.6, and an impossible rule-of-thumb estimate is off by whole multiples.
 * Nothing in that gap is a number anybody could be misled by.
 */
export const PROBABILITY_TOLERANCE = 1e-9;

/**
 * `value` snapped to `[low, high]` when it is within tolerance, or null when it is outside.
 *
 * `value + 0` on the way out normalises negative zero. `-0` is a legitimate result of subtracting
 * two equal equities and it is the same probability as `0`, but it is not `Object.is`-equal to it,
 * so a caller comparing the returned value would find `normaliseProbability(-0) !== 0` and have a
 * genuinely puzzling afternoon.
 */
function snap(value: number, low: number, high: number): number | null {
  if (!Number.isFinite(value)) return null;
  if (value < low) return value >= low - PROBABILITY_TOLERANCE ? low : null;
  if (value > high) return value <= high + PROBABILITY_TOLERANCE ? high : null;
  return value + 0;
}

/**
 * A probability as a number in `0..1`, or null when the value is not one.
 *
 * The single definition of the domain, and the function every other check here delegates to. A
 * value a hair outside a bound comes back AS that bound, so a caller never has to decide whether
 * `1.0000000000000002` was arithmetic or a bug — it was arithmetic, and it is 1.
 */
export function normaliseProbability(value: number): number | null {
  return snap(value, 0, 1);
}

/** The same, for a difference of two probabilities: `-1..1`. */
export function normaliseProbabilityDifference(value: number): number | null {
  return snap(value, -1, 1);
}

/** The same, for a difference already scaled into percentage points: `-100..100`. */
export function normaliseProbabilityPoints(value: number): number | null {
  return snap(value, -100, 100);
}

/**
 * A difference between two probabilities, still as a fraction: -1..1.
 *
 * `equitySurplus` is the live example — equity minus the break-even equity. It is
 * legitimately negative (a call that is not priced in), which is exactly why it cannot be
 * checked with `isProbabilityFraction`.
 */
export function isProbabilityDifference(value: number): boolean {
  return normaliseProbabilityDifference(value) !== null;
}

/**
 * A probability difference that is already scaled into percentage points: -100..100.
 *
 * The contract's naming rule is that a field carrying this unit says so (`errorPoints`,
 * `halfWidthPoints`) and a field with no unit in its name is a fraction. This predicate is
 * for the former; sending a fraction through it would pass every value and check nothing.
 */
export function isProbabilityPoints(value: number): boolean {
  return normaliseProbabilityPoints(value) !== null;
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
  const normalised = normaliseProbability(fraction);
  if (normalised === null) return null;
  // The SNAPPED value is formatted, not the original. `1 + 1e-16` would print as `100.0%` either
  // way at one decimal place, but at three it would not, and a figure that renders differently
  // depending on how many decimals were asked for is a figure nobody can reason about.
  return formatPercent(normalised, options);
}
