/**
 * Hostile input to the Monte Carlo path, and the invariants its results must satisfy. Like every
 * sibling, `monteCarloEquity` throws a typed error on bad input rather than returning NaN or
 * clamping. `samples: Infinity` used to loop forever, and one trial reported a ±0.00 interval, a
 * claim of certainty the exact path avoids by reporting `null`. The HTTP schema already bounds
 * `samples`, so this is library robustness.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import {
  countMatchups,
  EquityError,
  type EquitySpec,
  exactEquity,
  MAX_MONTE_CARLO_SAMPLES,
  MIN_MONTE_CARLO_SAMPLES,
  monteCarloEquity,
} from '../src/equity.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

function spec(): EquitySpec {
  const hero = parseCards('Ah Kh');
  return {
    players: [
      { label: 'hero', range: exactRange(hero) },
      { label: 'villain', range: parseRange('22+, A2s+, KTs+, QJs, A9o+, KQo', hero) },
    ],
    board: [],
  };
}

test('monteCarloEquity refuses a sample count it cannot honour', () => {
  // `Infinity` is in this table because it now returns. It used to hang the runner.
  const cases: readonly [unknown, RegExp][] = [
    [Number.NaN, /whole number of at least 2/],
    [Number.POSITIVE_INFINITY, /whole number of at least 2/],
    [Number.NEGATIVE_INFINITY, /whole number of at least 2/],
    [-5, /whole number of at least 2/],
    [0, /whole number of at least 2/],
    [1, /whole number of at least 2/],
    [0.5, /whole number of at least 2/],
    [1_000.5, /whole number of at least 2/],
    [MAX_MONTE_CARLO_SAMPLES + 1, /must not exceed 5000000/],
  ];

  for (const [samples, pattern] of cases) {
    assert.throws(
      () => monteCarloEquity(spec(), { samples: samples as number }),
      (error: unknown) => {
        assert.ok(error instanceof EquityError, `samples ${String(samples)} should throw an EquityError`);
        assert.match(error.message, pattern);
        // The message names the rejected value.
        assert.match(error.message, new RegExp(String(samples).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
      `samples ${String(samples)} must be rejected`,
    );
  }
});

test('monteCarloEquity refuses a seed it cannot reproduce', () => {
  // Same seed and spec give an identical result, which lets the API shard a run by seed. A fractional
  // or NaN seed cannot hold that contract.
  for (const seed of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => monteCarloEquity(spec(), { samples: 2_000, seed }),
      /seed must be a whole number/,
      `seed ${String(seed)} must be rejected`,
    );
  }
});

test('a Monte Carlo result never carries a NaN figure or a zero-width interval', () => {
  for (const samples of [MIN_MONTE_CARLO_SAMPLES, 4_000]) {
    const result = monteCarloEquity(spec(), { samples, seed: 5 });
    assert.equal(result.method, 'monte-carlo');
    assert.equal(result.trials, samples, 'every requested trial is run, not clamped');

    for (const player of result.players) {
      for (const [field, value] of Object.entries(player)) {
        if (typeof value !== 'number') continue;
        assert.ok(Number.isFinite(value), `${player.label}.${field} is ${value}`);
      }
      assert.ok(player.equity >= 0 && player.equity <= 1, `${player.label} equity out of range`);
    }

    const confidence = result.confidence;
    assert.notEqual(confidence, null, 'a sampled figure must carry its interval');
    assert.ok(Number.isFinite(confidence?.halfWidthPoints ?? Number.NaN));
    assert.ok(
      (confidence?.halfWidthPoints ?? 0) > 0,
      'a sampled interval of exactly zero is a claim of certainty, not a measurement',
    );
  }
});

test('the sample bounds are exported so callers can quote them rather than guess', () => {
  // A caller clamping its own request needs the same bounds this module enforces.
  assert.equal(MIN_MONTE_CARLO_SAMPLES, 2);
  assert.equal(MAX_MONTE_CARLO_SAMPLES, 5_000_000);
  assert.doesNotThrow(() => monteCarloEquity(spec(), { samples: MIN_MONTE_CARLO_SAMPLES }));
});

test('EquityResult.matchups means what its doc comment now says on both paths', () => {
  // Pins the documented meaning of the matchup count. AA against AA: `countMatchups` says 6 legal
  // matchups, while `monteCarloEquity` reports 6 x 6 = 36, the product of range sizes before card
  // conflicts. Exact reports what it enumerated, Monte Carlo an upper bound.
  const aces: EquitySpec = {
    players: [
      { label: 'hero', range: parseRange('AA') },
      { label: 'villain', range: parseRange('AA') },
    ],
    board: parseCards('7h 5c 2d'),
  };

  assert.equal(countMatchups(aces), 6, 'six legal AA-vs-AA matchups, derived by hand and by enumeration');

  const sampled = monteCarloEquity(aces, { samples: 2_000, seed: 11 });
  assert.equal(sampled.method, 'monte-carlo');
  assert.equal(
    sampled.matchups,
    36,
    'the documented UPPER BOUND: 6 combos x 6 combos, conflicts not removed',
  );
  assert.ok(
    sampled.matchups >= countMatchups(aces),
    'an upper bound is only honest if it is actually above the legal count',
  );

  // The exact path reports distinct legal assignments, so the two are not interchangeable.
  const enumerated = exactEquity(aces);
  assert.equal(enumerated.method, 'exact-enumeration');
  assert.equal(enumerated.matchups, 6, 'exact enumeration counts what it dealt out');
  assert.notEqual(enumerated.matchups, sampled.matchups, 'the asymmetry the doc comment now names');
});
