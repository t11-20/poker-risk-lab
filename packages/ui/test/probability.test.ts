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
