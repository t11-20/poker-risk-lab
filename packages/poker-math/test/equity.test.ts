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
  equity,
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

test('a contest reports the first player its share of a pot only that group plays for', () => {
  // KQ on Ks 9d 5c 2h 2s beats queens and loses to aces. Each group's share is 0 or 1, ties split.
  const board = parseCards('Ks 9d 5c 2h 2s');
  const contests = [[1, 2], [2], [1], [3], [2, 3]];
  const players = [
    { label: 'hero', range: exactRange(parseCards('Kc Qh')) },
    { label: 'aces', range: exactRange(parseCards('As Ah')) },
    { label: 'queens', range: exactRange(parseCards('Qc Qd')) },
    { label: 'the same hand', range: exactRange(parseCards('Kd Qs')) },
  ];
  const exact = exactEquity({ players, board, contests });
  assert.deepEqual(exact.contestShares, [0, 1, 0, 0.5, 0.5]);
  const sampled = monteCarloEquity({ players, board, contests }, { samples: 50, seed: 3 });
  assert.deepEqual(sampled.contestShares, [0, 1, 0, 0.5, 0.5]);
  assert.equal(exactEquity({ players, board }).contestShares, undefined, 'absent unless asked for');
  assert.throws(() => exactEquity({ players, board, contests: [[0]] }), /index 1 to 3/);
});

test('an exact count is stated as showdowns, which a complete board has with no board to come (REGRESSION)', () => {
  const hero = parseCards('Ac Kd');
  const river = exactEquity({
    players: [
      { label: 'hero', range: exactRange(hero) },
      { label: 'villain', range: parseRange('QQ, JJ', hero) },
    ],
    board: parseCards('Th 9d 8c 7s 2h'),
  });
  assert.equal(river.trials, 12, 'six queens and six jacks, one showdown each');
  assert.ok(
    river.assumptions.includes(
      'Computed by enumerating every showdown the ranges allow — there is no sampling error.',
    ),
    river.assumptions.join('\n'),
  );
  assert.ok(!river.assumptions.some((note) => /remaining board/u.test(note)));
});

test('the method is chosen at the budget exactly, counting matchups only as far as the budget needs', () => {
  // AA against AA on a flop: 6 legal matchups, each meeting C(45, 2) = 990 run-outs, so 5,940 boards.
  const aces: EquitySpec = {
    players: [
      { label: 'hero', range: parseRange('AA') },
      { label: 'villain', range: parseRange('AA') },
    ],
    board: parseCards('7h 5c 2d'),
  };
  assert.equal(equity(aces, { maxExactWork: 5_940 }).method, 'exact-enumeration');
  assert.equal(equity(aces, { maxExactWork: 5_939, samples: 2_000, seed: 3 }).method, 'monte-carlo');

  // Five wide preflop ranges hold millions of matchups. Deciding against them stops one past the cap.
  const wide = parseRange('22+, A2s+, K2s+, Q2s+, J2s+, A2o+, K2o+, Q2o+, J2o+');
  const crowd: EquitySpec = {
    players: ['hero', 'a', 'b', 'c', 'd'].map((label) => ({ label, range: wide })),
    board: [],
  };
  assert.equal(countMatchups(crowd, 1_000), 1_001);
  assert.equal(equity(crowd, { samples: 2_000, seed: 3 }).method, 'monte-carlo');
});

test('a budget that cannot bound the count is refused before any counting', () => {
  // The budget sets where counting stops, so NaN or Infinity would enumerate every matchup there is.
  const random = parseRange('random');
  const three: EquitySpec = {
    players: ['hero', 'a', 'b'].map((label) => ({ label, range: random })),
    board: [],
  };
  for (const maxExactWork of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.throws(() => equity(three, { maxExactWork, samples: 2_000 }), EquityError, String(maxExactWork));
  }
});

test('equity refuses a spec it cannot price, and says which part', () => {
  const board = parseCards('Ah Kd 7c');
  const hero = { label: 'you', range: exactRange(parseCards('Qs Qh')) };
  const villain = { label: 'the opponent', range: parseRange('JJ+', [...board, ...parseCards('Qs Qh')]) };
  const refusals: readonly [string, EquitySpec, RegExp][] = [
    ['one player', { players: [hero], board }, /at least 2 players, received 1/u],
    [
      'seven players',
      { players: Array.from({ length: 7 }, () => hero), board },
      /at most 6 players, received 7/u,
    ],
    [
      'a two-card board',
      { players: [hero, villain], board: parseCards('Ah Kd') },
      /0, 3, 4 or 5 cards, received 2/u,
    ],
    [
      'a dead card on the board',
      { players: [hero, villain], board, deadCards: parseCards('7c') },
      /board and dead cards contain a duplicate/u,
    ],
    [
      'a range the board empties',
      { players: [hero, { label: 'the opponent', range: { ...villain.range, combos: [] } }], board },
      /"the opponent" has no possible hands/u,
    ],
    ['a contest naming hero', { players: [hero, villain], board, contests: [[0]] }, /index 1 to 1/u],
    ['a contest past the last player', { players: [hero, villain], board, contests: [[2]] }, /index 1 to 1/u],
  ];
  for (const [what, spec, message] of refusals) {
    assert.throws(
      () => equity(spec),
      (error: unknown) => error instanceof EquityError && message.test(error.message),
      what,
    );
  }
});
