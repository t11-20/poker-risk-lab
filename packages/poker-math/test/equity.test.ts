/**
 * Hostile input to the Monte Carlo path, and the invariants its results must satisfy.
 *
 * `monteCarloEquity` was the one entry point in this package that validated nothing.
 * Every sibling — `probabilityOfHitting`, `potOdds`, `computeOuts`, `icmEquity`,
 * `riskOfRuin` — throws a typed error on `NaN`, `Infinity`, negative and out-of-range
 * input, and `odds.ts` states the rule in its header: "Nothing here returns NaN, and
 * nothing is silently clamped." The sampler broke both halves of that sentence:
 *
 *   * `samples: NaN` ran zero trials and returned an equity of `NaN` with a `NaN`
 *     interval — a number-shaped nothing, presented as a measurement.
 *   * `samples: Infinity` entered an unbounded synchronous loop. No timer, no deadline
 *     and no worker-pool watchdog on the same thread can interrupt that; the process has
 *     to be killed.
 *   * `samples: 0`, `-5` and `0.4` were silently clamped to a single trial, and a single
 *     trial reports a **±0.00-point** 95% interval, because the sample standard deviation
 *     of one observation is zero. That is a claim of certainty from one sample, in a
 *     package whose exact path deliberately reports `null` rather than a fabricated zero
 *     precisely so that claim cannot be made.
 *
 * The HTTP surface was never the exposure — `schemas.ts` bounds `samples` to
 * [1000, 500000] and JSON cannot carry `NaN` — so this is a library-robustness fix, and
 * the tests are written from the caller's side: what does it do when handed a bad value.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '@prl/poker-engine';
import {
  EquityError,
  type EquitySpec,
  MAX_MONTE_CARLO_SAMPLES,
  MIN_MONTE_CARLO_SAMPLES,
  monteCarloEquity,
} from '../src/equity.ts';
import { exactRange, parseRange } from '../src/ranges.ts';

/** A wide preflop spot, so the sampler has real work to do when it does run. */
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
  // `Infinity` is deliberately in this table. Before the fix it could not be tested at
  // all: the call never returned, so a test that made it would hang the runner rather
  // than fail it. That it is now an ordinary assertion is the fix.
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
        // The message has to name the value it rejected, or a caller passing a variable
        // has to go looking for which of its inputs was the bad one.
        assert.match(error.message, new RegExp(String(samples).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      },
      `samples ${String(samples)} must be rejected`,
    );
  }
});

test('monteCarloEquity refuses a seed it cannot reproduce', () => {
  // "Same seed + same spec ⇒ identical result" is the documented contract and the reason
  // the API can shard a run across threads by seed. A fractional or NaN seed is not a
  // value that contract can hold for.
  for (const seed of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => monteCarloEquity(spec(), { samples: 2_000, seed }),
      /seed must be a whole number/,
      `seed ${String(seed)} must be rejected`,
    );
  }
});

test('a Monte Carlo result never carries a NaN figure or a zero-width interval', () => {
  // The invariant the validation exists to protect. Two sample counts: the smallest the
  // function will now accept, and a realistic one.
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
  // Both constants are part of the contract: `MIN` is why a one-trial run is refused and
  // `MAX` is why an unbounded one is. A caller clamping its own request needs the same
  // numbers this module enforces, and there is exactly one place they live.
  assert.equal(MIN_MONTE_CARLO_SAMPLES, 2);
  assert.equal(MAX_MONTE_CARLO_SAMPLES, 5_000_000);
  assert.doesNotThrow(() => monteCarloEquity(spec(), { samples: MIN_MONTE_CARLO_SAMPLES }));
});
