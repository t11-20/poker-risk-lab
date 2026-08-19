/**
 * The render-boundary guard's own boundaries.
 *
 * `coach-panel-render.test.ts` proves the guard works by reading the page a learner would
 * read, which is the assertion that matters. This file is the other half: the predicates
 * themselves, at the values where an off-by-one would either let an impossible figure
 * through or — the more insidious failure — reject a perfectly real one.
 *
 * The second failure is the one to worry about. A guard that refuses a legitimate 100%
 * equity teaches the next reader that it cries wolf, and a guard nobody believes gets
 * deleted. So every endpoint below is asserted as *accepted*: 0 and 1 are both reachable
 * probabilities, an equity surplus of exactly -1 is reachable, and an error of exactly 100
 * points is reachable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatProbability,
  isProbabilityDifference,
  isProbabilityFraction,
  isProbabilityPoints,
  NOT_A_PROBABILITY,
  normaliseProbability,
  normaliseProbabilityDifference,
  normaliseProbabilityPoints,
  PROBABILITY_TOLERANCE,
} from '../src/probability.ts';

/** Values that are not numbers at all but reach a component anyway, past a wire boundary. */
const NOT_NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe('isProbabilityFraction', () => {
  it('accepts every fraction in 0..1, endpoints included', () => {
    for (const value of [0, 0.0001, 1 / 3, 0.3949, 0.9999, 1]) {
      assert.equal(isProbabilityFraction(value), true, `${value} is a probability`);
    }
    // Negative zero is zero. Rejecting it would refuse a legitimately zero equity that
    // happened to arrive from a subtraction.
    assert.equal(isProbabilityFraction(-0), true);
  });

  it('rejects the two shapes the unit error takes', () => {
    // 36 is the old percentage-point unit — "3,600.0%" on a shipped page.
    // 1.6 is the stale fixture value the audit found — "160.0%".
    assert.equal(isProbabilityFraction(36), false);
    assert.equal(isProbabilityFraction(1.6), false);
  });

  it('rejects anything either side of the range, however narrowly', () => {
    assert.equal(isProbabilityFraction(1.0000001), false);
    assert.equal(isProbabilityFraction(-0.0000001), false);
    assert.equal(isProbabilityFraction(-0.5), false);
  });

  it('rejects a value that is not a finite number', () => {
    for (const value of NOT_NUMBERS) {
      assert.equal(isProbabilityFraction(value), false, `${value} is not a probability`);
    }
  });
});

describe('isProbabilityDifference', () => {
  it('accepts -1..1, because a surplus is legitimately negative', () => {
    // `equitySurplus` is equity minus break-even. A call that is not priced in has a negative
    // one, and checking it with `isProbabilityFraction` would refuse every such report.
    for (const value of [-1, -0.4, 0, 0.0616, 1]) {
      assert.equal(isProbabilityDifference(value), true, `${value} is a possible difference`);
    }
  });

  it('rejects a difference wider than the range it is a difference within', () => {
    assert.equal(isProbabilityDifference(-3.2), false);
    assert.equal(isProbabilityDifference(1.0000001), false);
    for (const value of NOT_NUMBERS) assert.equal(isProbabilityDifference(value), false);
  });
});

describe('isProbabilityPoints', () => {
  it('accepts -100..100, the whole span a percentage-point figure can occupy', () => {
    for (const value of [-100, -1.03, 0, 0.35, 1.032377428307, 100]) {
      assert.equal(isProbabilityPoints(value), true, `${value} points is possible`);
    }
  });

  it('rejects an error bar wider than the range it is drawn on', () => {
    // The half-width case: "41.2 % ± 5,000.00 points" is the same untruth as a 160%
    // probability, and carries no `%` sign to be caught by a scan that looks for one.
    assert.equal(isProbabilityPoints(5000), false);
    assert.equal(isProbabilityPoints(-100.0001), false);
    for (const value of NOT_NUMBERS) assert.equal(isProbabilityPoints(value), false);
  });

  it('is not interchangeable with the fraction check, which is the whole point of two names', () => {
    // A fraction sent through the points check passes everything and checks nothing; points
    // sent through the fraction check fail almost everything. Swapping them is a silent bug
    // in both directions, so the asymmetry is asserted rather than assumed.
    assert.equal(isProbabilityPoints(0.36), true);
    assert.equal(isProbabilityFraction(36), false);
  });
});

describe('formatProbability', () => {
  it('formats a real probability exactly as formatPercent does', () => {
    assert.equal(formatProbability(0.36), '36.0%');
    assert.equal(formatProbability(1), '100.0%');
    assert.equal(formatProbability(0), '0.0%');
    assert.equal(formatProbability(0.3949, { decimals: 2 }), '39.49%');
  });

  it('returns null — not a clamped number, not a placeholder string — for anything else', () => {
    // `null` is what makes the second branch impossible to skip at a call site: a
    // `string | null` will not go into a template literal without the caller saying what
    // happens instead. A clamp would have let the caller carry on as though nothing was wrong.
    for (const value of [36, 1.6, -0.5, ...NOT_NUMBERS]) {
      assert.equal(formatProbability(value), null, `${value} must not be formatted`);
    }
  });

  it('names the refusal as a rejection rather than as an absence', () => {
    // "—" and "n/a" both read as missing. This figure was not missing: it arrived, was read,
    // and was refused, and a bug reporter needs to be able to tell those apart.
    assert.equal(NOT_A_PROBABILITY, 'not a probability');
  });
});

// ---------------------------------------------------------------------------
// The domain itself: every boundary, and the two sides of the tolerance
// ---------------------------------------------------------------------------

/**
 * Added after the release audit left "impossible probability" PARTIAL: the Coach was guarded and
 * `formatPercent` was not, so any probability-typed value that reached a render site directly
 * still printed as an impossible percentage. The fix defined the domain once, with a stated
 * floating-point tolerance, and moved every probability render site onto it.
 *
 * These are the cases the audit named — below zero, zero, near zero, one, a hair over one, well
 * over one, and the non-finite values — plus the case a naive fix gets wrong in the other
 * direction: a legitimately computed `1 + 1e-16` must NOT be refused, because refusing correct
 * figures is how a guard loses its credibility and then its place in the codebase.
 */
describe('the probability domain and its tolerance', () => {
  it('accepts the endpoints and everything between them, unchanged', () => {
    for (const value of [0, -0, 1e-300, 1e-12, 0.5, 1 - 1e-12, 1]) {
      assert.equal(normaliseProbability(value), value + 0, `${value} must pass through unchanged`);
    }
  });

  it('snaps a value a hair outside a bound onto that bound', () => {
    // The arithmetic that produces these is ordinary: a Monte Carlo division, a normalisation over
    // a set of weights, a subtraction of two nearly equal numbers.
    assert.equal(normaliseProbability(1 + Number.EPSILON), 1);
    assert.equal(normaliseProbability(1.0000000000000002), 1);
    assert.equal(normaliseProbability(-1e-17), 0);
    assert.equal(normaliseProbability(1 + PROBABILITY_TOLERANCE), 1, 'the tolerance is inclusive');
    assert.equal(normaliseProbability(-PROBABILITY_TOLERANCE), 0);
  });

  it('refuses anything materially outside, however small "materially" is', () => {
    // Just past the tolerance. This is the assertion that keeps the snap from becoming a clamp.
    assert.equal(normaliseProbability(1 + PROBABILITY_TOLERANCE * 10), null);
    assert.equal(normaliseProbability(-PROBABILITY_TOLERANCE * 10), null);
    assert.equal(normaliseProbability(1.0000001), null);
    assert.equal(normaliseProbability(1.6), null, 'the stale fixture value the audit found');
    assert.equal(normaliseProbability(36), null, 'the percentage-point unit error');
    assert.equal(normaliseProbability(-0.5), null);
  });

  it('refuses every non-finite value', () => {
    for (const value of NOT_NUMBERS) {
      assert.equal(normaliseProbability(value), null, `${value} is not a probability`);
      assert.equal(normaliseProbabilityDifference(value), null);
      assert.equal(normaliseProbabilityPoints(value), null);
    }
  });

  it('keeps the three ranges apart, tolerance and all', () => {
    // The tolerance must not be a way to smuggle a value from one range into another: it is a
    // billionth, and the ranges differ by whole factors.
    assert.equal(normaliseProbabilityDifference(-1 - PROBABILITY_TOLERANCE), -1);
    assert.equal(normaliseProbabilityDifference(-1.5), null);
    assert.equal(normaliseProbabilityPoints(100 + PROBABILITY_TOLERANCE), 100);
    assert.equal(normaliseProbabilityPoints(101), null);
    // A fraction is not points and points are not a fraction, which is why there are three names.
    assert.equal(normaliseProbability(36), null);
    assert.equal(normaliseProbabilityPoints(36), 36);
  });

  it('formats the SNAPPED value, so the rendering does not depend on the decimal count', () => {
    // `1 + 1e-16` at one decimal place prints as 100.0% either way. At six it would print as
    // 100.000000% only if the snap happened first, and a figure that changes meaning with the
    // precision asked for is one nobody can reason about.
    assert.equal(formatProbability(1 + Number.EPSILON, { decimals: 6 }), '100.000000%');
    assert.equal(formatProbability(-0, { decimals: 6 }), '0.000000%');
    // Near-zero is a real probability and prints as one, rounded — not refused, and not "0".
    assert.equal(formatProbability(1e-9, { decimals: 1 }), '0.0%');
    assert.equal(formatProbability(1e-9, { decimals: 8 }), '0.00000010%');
  });

  it('agrees with its own predicates at every boundary', () => {
    // The predicates delegate to the normalisers, so this is a guard against somebody
    // reintroducing a second, subtly different bound in one of them.
    for (const value of [
      0,
      1,
      1 + PROBABILITY_TOLERANCE,
      1 + PROBABILITY_TOLERANCE * 10,
      -PROBABILITY_TOLERANCE,
      1.6,
      36,
      Number.NaN,
    ]) {
      assert.equal(
        isProbabilityFraction(value),
        normaliseProbability(value) !== null,
        `isProbabilityFraction and normaliseProbability disagree about ${value}`,
      );
      assert.equal(isProbabilityDifference(value), normaliseProbabilityDifference(value) !== null);
      assert.equal(isProbabilityPoints(value), normaliseProbabilityPoints(value) !== null);
    }
  });

  it('leaves formatPercent alone, because a formatter cannot know what it was given', () => {
    // Restating the boundary the audit asked to be preserved. `formatPercent` still renders 1.6 as
    // "160.0%" and that is correct behaviour for a function that might have been handed a growth
    // rate. The fix is that no probability-typed value is handed to it any more — enforced by the
    // render sites, and asserted here so the two rules are written down next to each other.
    assert.equal(formatProbability(1.6), null);
    assert.equal(NOT_A_PROBABILITY, 'not a probability');
  });
});
