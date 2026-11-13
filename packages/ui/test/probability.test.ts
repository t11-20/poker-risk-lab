/**
 * The render-boundary guard's predicates at their boundaries (`coach-panel-render.test.ts` checks the page).
 * A guard that refuses a real figure gets deleted, so every reachable endpoint is asserted as accepted.
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
    // Negative zero arrives from a subtraction and is a real zero equity.
    assert.equal(isProbabilityFraction(-0), true);
  });

  it('rejects the two shapes the unit error takes', () => {
    // 36 is the percentage-point unit error, 1.6 a stale fixture value.
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
    // `equitySurplus` is equity minus break-even, negative for a call that is not priced in.
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
    // A half-width of 5,000 points is the same untruth as a 160% probability, with no `%` to scan for.
    assert.equal(isProbabilityPoints(5000), false);
    assert.equal(isProbabilityPoints(-100.0001), false);
    for (const value of NOT_NUMBERS) assert.equal(isProbabilityPoints(value), false);
  });

  it('is not interchangeable with the fraction check, which is the whole point of two names', () => {
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
    // A `string | null` forces each call site to handle the refusal. A clamp would hide it.
    for (const value of [36, 1.6, -0.5, ...NOT_NUMBERS]) {
      assert.equal(formatProbability(value), null, `${value} must not be formatted`);
    }
  });

  it('names the refusal as a rejection rather than as an absence', () => {
    // "—" reads as missing. This figure arrived and was refused, and a bug reporter must tell them apart.
    assert.equal(NOT_A_PROBABILITY, 'not a probability');
  });
});

/**
 * The domain is defined once, with a floating-point tolerance, and every probability render site uses it.
 * A computed `1 + 1e-16` must not be refused.
 */
describe('the probability domain and its tolerance', () => {
  it('accepts the endpoints and everything between them, unchanged', () => {
    for (const value of [0, -0, 1e-300, 1e-12, 0.5, 1 - 1e-12, 1]) {
      assert.equal(normaliseProbability(value), value + 0, `${value} must pass through unchanged`);
    }
  });

  it('snaps a value a hair outside a bound onto that bound', () => {
    assert.equal(normaliseProbability(1 + Number.EPSILON), 1);
    assert.equal(normaliseProbability(1.0000000000000002), 1);
    assert.equal(normaliseProbability(-1e-17), 0);
    assert.equal(normaliseProbability(1 + PROBABILITY_TOLERANCE), 1, 'the tolerance is inclusive');
    assert.equal(normaliseProbability(-PROBABILITY_TOLERANCE), 0);
  });

  it('refuses anything materially outside, however small "materially" is', () => {
    // Just past the tolerance, which keeps the snap from becoming a clamp.
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
    // The tolerance is a billionth, and the ranges differ by whole factors.
    assert.equal(normaliseProbabilityDifference(-1 - PROBABILITY_TOLERANCE), -1);
    assert.equal(normaliseProbabilityDifference(-1.5), null);
    assert.equal(normaliseProbabilityPoints(100 + PROBABILITY_TOLERANCE), 100);
    assert.equal(normaliseProbabilityPoints(101), null);
    assert.equal(normaliseProbability(36), null);
    assert.equal(normaliseProbabilityPoints(36), 36);
  });

  it('formats the SNAPPED value, so the rendering does not depend on the decimal count', () => {
    // At six decimals only a snapped value prints as an exact hundred percent.
    assert.equal(formatProbability(1 + Number.EPSILON, { decimals: 6 }), '100.000000%');
    assert.equal(formatProbability(-0, { decimals: 6 }), '0.000000%');
    assert.equal(formatProbability(1e-9, { decimals: 1 }), '0.0%');
    assert.equal(formatProbability(1e-9, { decimals: 8 }), '0.00000010%');
  });

  it('agrees with its own predicates at every boundary', () => {
    // Guards against a second, subtly different bound in a predicate.
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
    // `formatPercent` still renders 1.6 as "160.0%", which is right for a growth rate. Probabilities
    // go through `formatProbability` instead.
    assert.equal(formatProbability(1.6), null);
    assert.equal(NOT_A_PROBABILITY, 'not a probability');
  });
});
