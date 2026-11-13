/**
 * Reproduces the equity figures `docs/VERIFICATION.md` §8 publishes, by enumeration: AA-vs-KK at
 * 81.946% over 36 suit configurations, `AKs` vs `22` at 49.89% over 24, `AKo` vs `QQ` at 43.24%
 * over 72. `enumerateHeadsUp` is a second, longhand implementation (nested loops, one reused
 * seven-card buffer), so agreement with `exactEquity` is not circular. It runs one preflop
 * configuration (C(48,5) = 1,712,304 boards) in 166 ms against `exactEquity`'s 263 ms, which keeps
 * the 132-configuration sweep at about 21 s inside the package's own suite.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Card,
  cardsToString,
  evaluate,
  type HandScore,
  parseCards,
  remainingDeck,
} from '@prl/poker-engine';
import { combineMonteCarlo, exactEquity, monteCarloEquity } from '../src/equity.ts';
import { type Combo, combosOfClass, exactRange, makeHandClass } from '../src/ranges.ts';

/**
 * Hero's pot share against one opponent over every remaining five-card board. A board where both
 * hands score the same is worth half a pot. AA against KK chops on 1.16% of boards.
 */
function enumerateHeadsUp(hero: readonly Card[], villain: readonly Card[]): number {
  const deck = remainingDeck([...hero, ...villain]);
  const n = deck.length;
  const heroHand: Card[] = [hero[0] as Card, hero[1] as Card, 0, 0, 0, 0, 0];
  const villainHand: Card[] = [villain[0] as Card, villain[1] as Card, 0, 0, 0, 0, 0];
  let share = 0;
  let boards = 0;

  for (let a = 0; a < n; a++) {
    heroHand[2] = villainHand[2] = deck[a] as Card;
    for (let b = a + 1; b < n; b++) {
      heroHand[3] = villainHand[3] = deck[b] as Card;
      for (let c = b + 1; c < n; c++) {
        heroHand[4] = villainHand[4] = deck[c] as Card;
        for (let d = c + 1; d < n; d++) {
          heroHand[5] = villainHand[5] = deck[d] as Card;
          for (let e = d + 1; e < n; e++) {
            heroHand[6] = villainHand[6] = deck[e] as Card;
            const heroScore: HandScore = evaluate(heroHand);
            const villainScore: HandScore = evaluate(villainHand);
            share += heroScore > villainScore ? 1 : heroScore === villainScore ? 0.5 : 0;
            boards += 1;
          }
        }
      }
    }
  }

  // A sweep of nothing is not a pass. C(48,5) is the only right count for a preflop heads-up spot.
  assert.equal(boards, 1_712_304, 'C(48,5) boards must have been dealt, or this figure is not an average');
  return share / boards;
}

interface Configuration {
  readonly hero: Combo;
  readonly villain: Combo;
  readonly equity: number;
}

/** Every legal (hero combo, villain combo) pair. The two classes never share a rank here. */
function sweepConfigurations(heroCombos: readonly Combo[], villainCombos: readonly Combo[]): Configuration[] {
  const out: Configuration[] = [];
  for (const hero of heroCombos) {
    for (const villain of villainCombos) {
      out.push({ hero, villain, equity: enumerateHeadsUp(hero, villain) });
    }
  }
  return out;
}

function averageOf(configurations: readonly Configuration[]): number {
  return configurations.reduce((sum, one) => sum + one.equity, 0) / configurations.length;
}

function extremeOf(configurations: readonly Configuration[], direction: 'min' | 'max'): Configuration {
  const first = configurations[0];
  assert.ok(first !== undefined, 'no configurations were swept');
  return configurations.reduce(
    (best, one) => ((direction === 'min' ? one.equity < best.equity : one.equity > best.equity) ? one : best),
    first,
  );
}

/**
 * The distinct equity values in a sweep, with how many configurations produced each. Suits are
 * interchangeable, so configurations that differ by a suit relabelling must have bit-identical
 * equity. Any suit-dependent evaluator bug splits a class and changes these counts. Keyed on the
 * raw float because the equality is exact.
 */
function multiplicityProfile(configurations: readonly Configuration[]): number[] {
  const counts = new Map<number, number>();
  for (const one of configurations) counts.set(one.equity, (counts.get(one.equity) ?? 0) + 1);
  return [...counts.values()].sort((a, b) => a - b);
}

function label(combo: Combo): string {
  return cardsToString([combo[0], combo[1]]).replace(/\s+/g, '');
}

const PAIR_AA = combosOfClass(makeHandClass(12, 12, 'pair'));
const PAIR_KK = combosOfClass(makeHandClass(11, 11, 'pair'));
const PAIR_QQ = combosOfClass(makeHandClass(10, 10, 'pair'));
const PAIR_22 = combosOfClass(makeHandClass(0, 0, 'pair'));
const AK_SUITED = combosOfClass(makeHandClass(12, 11, 'suited'));
const AK_OFFSUIT = combosOfClass(makeHandClass(12, 11, 'offsuit'));

/**
 * The exact values the sweep produces, to seventeen significant figures, because a tolerance around
 * a rounded target is wider than it looks. `docs/VERIFICATION.md` §8 publishes these numbers.
 */
const AA_VS_KK_AVERAGE = 0.8194605046767397;
const AA_VS_KK_MIN = 0.81255489679402726;
const AA_VS_KK_MAX = 0.82636611255945203;
const AKS_VS_22_AVERAGE = 0.49893316256926329;
const AKS_VS_22_MIN = 0.49702389295358768;
const AKS_VS_22_MAX = 0.50084243218493907;
const AKO_VS_QQ_AVERAGE = 0.43242336057148723;
const AKO_VS_QQ_MIN = 0.42835150767620706;
const AKO_VS_QQ_MAX = 0.43649521346676756;

/**
 * 1e-12. Both sides enumerate the same boards, so only float summation order may differ. This is
 * far tighter than the gap between suit configurations (~0.007 in AA-vs-KK, ~0.00002 in AKo-vs-QQ).
 */
const EXACT_TOLERANCE = 1e-12;

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) < EXACT_TOLERANCE,
    `${what}: expected ${expected.toPrecision(17)}, enumerated ${actual.toPrecision(17)}`,
  );
}

test('AA versus KK preflop, over all 36 suit configurations', () => {
  assert.equal(PAIR_AA.length, 6, 'a pair has six combinations');
  assert.equal(PAIR_KK.length, 6);

  const configurations = sweepConfigurations(PAIR_AA, PAIR_KK);
  assert.equal(configurations.length, 36, 'AA and KK share no rank, so all 6 x 6 pairings are legal');

  const average = averageOf(configurations);
  const min = extremeOf(configurations, 'min');
  const max = extremeOf(configurations, 'max');

  assertClose(average, AA_VS_KK_AVERAGE, 'AA vs KK average');
  assertClose(min.equity, AA_VS_KK_MIN, 'AA vs KK minimum');
  assertClose(max.equity, AA_VS_KK_MAX, 'AA vs KK maximum');

  // The figure at the precision §8 publishes it, asserted separately from the constants above.
  assert.equal((average * 100).toFixed(3), '81.946', 'the ~81.9% figure §8 publishes');
  assert.equal((min.equity * 100).toFixed(2), '81.26');
  assert.equal((max.equity * 100).toFixed(2), '82.64');

  // §8 names the extremes. The aces' worst case is kings holding the two suits the aces do not.
  assert.equal(label(min.hero)[1], 'c');
  assert.deepEqual(
    new Set([label(min.villain)[1], label(min.villain)[3]]),
    new Set(['h', 's']),
    'the minimum for AA is AcAd against the kings of the other two suits',
  );
  assert.deepEqual(
    new Set([label(max.villain)[1], label(max.villain)[3]]),
    new Set(['c', 'd']),
    'the maximum for AA is against kings sharing both of its suits',
  );

  // No shared suit, one shared suit, both shared: 6 x 1, 6 x 4, 6 x 1.
  assert.deepEqual(multiplicityProfile(configurations), [6, 6, 24]);

  // The one-shared-suit class sits halfway between the extremes, so the mean is the midpoint.
  assertClose(average, (min.equity + max.equity) / 2, 'the 36-configuration mean is the midpoint');
});

test('AKs versus 22 preflop, over all 24 suit configurations', () => {
  assert.equal(AK_SUITED.length, 4, 'a suited class has four combinations');

  const configurations = sweepConfigurations(AK_SUITED, PAIR_22);
  assert.equal(configurations.length, 24);

  const average = averageOf(configurations);
  const min = extremeOf(configurations, 'min');
  const max = extremeOf(configurations, 'max');

  assertClose(average, AKS_VS_22_AVERAGE, 'AKs vs 22 average');
  assertClose(min.equity, AKS_VS_22_MIN, 'AKs vs 22 minimum');
  assertClose(max.equity, AKS_VS_22_MAX, 'AKs vs 22 maximum');

  assert.equal((average * 100).toFixed(2), '49.89', 'the figure §8 publishes');
  assert.equal((min.equity * 100).toFixed(2), '49.70');
  assert.equal((max.equity * 100).toFixed(2), '50.08');

  // A coin flip in every configuration, not only on average. The pair is a hair ahead.
  for (const one of configurations) {
    assert.ok(
      one.equity > 0.49 && one.equity < 0.51,
      `${label(one.hero)} vs ${label(one.villain)} is ${(one.equity * 100).toFixed(2)}%, not a coin flip`,
    );
  }

  // The deuces hold one of AKs's suits, or neither. Twelve configurations each.
  assert.deepEqual(multiplicityProfile(configurations), [12, 12]);
});

test('AKo versus QQ preflop, over all 72 suit configurations', () => {
  assert.equal(AK_OFFSUIT.length, 12, 'an offsuit class has twelve combinations');

  const configurations = sweepConfigurations(AK_OFFSUIT, PAIR_QQ);
  assert.equal(configurations.length, 72);

  const average = averageOf(configurations);
  const min = extremeOf(configurations, 'min');
  const max = extremeOf(configurations, 'max');

  assertClose(average, AKO_VS_QQ_AVERAGE, 'AKo vs QQ average');
  assertClose(min.equity, AKO_VS_QQ_MIN, 'AKo vs QQ minimum');
  assertClose(max.equity, AKO_VS_QQ_MAX, 'AKo vs QQ maximum');

  assert.equal((average * 100).toFixed(2), '43.24', 'the figure §8 publishes');
  assert.equal((min.equity * 100).toFixed(2), '42.84');
  assert.equal((max.equity * 100).toFixed(2), '43.65');

  // §8 states averages. 42.84% is the minimum configuration, 0.4 points below the average.
  assert.ok(
    average - min.equity > 0.004,
    'the average and the minimum are far enough apart that quoting one for the other is an error',
  );

  // Four classes, because the ace's suit and the king's suit are distinguishable. Two classes differ
  // by 0.0019 points, which a tolerance looser than 1e-12 would erase.
  assert.deepEqual(multiplicityProfile(configurations), [12, 12, 24, 24]);
});

test('the production enumerator agrees with the longhand one, bit for bit', () => {
  // Ties this file's ground truth to the code the app runs. Three configurations, because the
  // agreement is exact and `exactEquity` is slower.
  const pairs: readonly [string, string][] = [
    ['AhAs', 'KdKc'],
    ['AcKc', '2d2h'],
    ['AcKd', 'QhQs'],
  ];

  for (const [heroText, villainText] of pairs) {
    const hero = parseCards(heroText);
    const villain = parseCards(villainText);
    const longhand = enumerateHeadsUp(hero, villain);
    const production = exactEquity({
      players: [
        { label: 'hero', range: exactRange(hero) },
        { label: 'villain', range: exactRange(villain) },
      ],
      board: [],
    });
    const heroShare = production.players[0]?.equity;
    assert.equal(production.method, 'exact-enumeration');
    assert.equal(production.trials, 1_712_304, 'both paths must have dealt the same boards');
    assert.equal(production.matchups, 1, 'two exact hands are one matchup');
    assert.equal(
      heroShare,
      longhand,
      `${heroText} vs ${villainText}: exactEquity says ${String(heroShare)}, longhand says ${longhand}`,
    );
  }
});

test('Monte Carlo agrees with exact enumeration, inside an interval derived from the sample size', () => {
  // Every bound below is the run's own 95% half-width, 1.96 * sd / sqrt(n), from `monteCarloEquity`.
  // Seeds are fixed, so this is deterministic, and the assertions are about the ensemble of 200 runs.
  const hero = parseCards('AhAs');
  const villain = parseCards('KdKc');
  const spec = {
    players: [
      { label: 'hero', range: exactRange(hero) },
      { label: 'villain', range: exactRange(villain) },
    ],
    board: [],
  };

  const exact = enumerateHeadsUp(hero, villain);
  assertClose(exact, AA_VS_KK_MIN, 'the reference value the sampler is measured against');

  const SEEDS = 200;
  const SAMPLES = 20_000;
  const shards = [];
  let inside = 0;
  let worstRatio = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const run = monteCarloEquity(spec, { samples: SAMPLES, seed });
    assert.equal(run.method, 'monte-carlo');
    assert.equal(run.trials, SAMPLES);
    const halfWidth = run.confidence?.halfWidthPoints;
    assert.ok(halfWidth !== undefined && halfWidth > 0, 'a sampled figure must carry a positive interval');
    const errorPoints = Math.abs((run.players[0]?.equity ?? Number.NaN) - exact) * 100;
    if (errorPoints <= halfWidth) inside += 1;
    worstRatio = Math.max(worstRatio, errorPoints / halfWidth);
    shards.push(run);
  }
  assert.equal(shards.length, SEEDS, 'a sweep of nothing is not a pass');

  // 1. Coverage. A calibrated 95% interval covers the truth about 190 times in 200 (sd 3.1). Measured
  //    2026-08-26: 184. The floor of 175 is three sd below the mean. An estimator off by one half-width
  //    covers about 100 of 200.
  assert.ok(
    inside >= 175,
    `only ${inside} of ${SEEDS} 95% intervals contained the exact value ${exact}; expected ~190`,
  );
  assert.ok(inside <= SEEDS, 'coverage cannot exceed the number of runs');

  // 2. No single run is wildly out. Measured worst case 1.66 half-widths. 2.5 is z = 4.9, about one in
  //    a million per run, so this fires on bias, not luck.
  assert.ok(worstRatio < 2.5, `the worst run missed by ${worstRatio.toFixed(2)} half-widths`);

  // 3. Pool all 200 shards through `combineMonteCarlo` and compare 4,000,000 samples against the
  //    enumeration. The pooled interval is ±0.038 points. Measured miss on 2026-08-26 was 0.016, z = 0.84.
  const pooled = combineMonteCarlo(shards);
  assert.equal(pooled.trials, SEEDS * SAMPLES);
  const pooledHalfWidth = pooled.confidence?.halfWidthPoints ?? Number.NaN;
  assert.ok(pooledHalfWidth < 0.05, `the pooled interval should be tiny, got ±${pooledHalfWidth}`);
  const pooledErrorPoints = Math.abs((pooled.players[0]?.equity ?? Number.NaN) - exact) * 100;
  assert.ok(
    pooledErrorPoints <= pooledHalfWidth,
    `4,000,000 samples landed ${pooledErrorPoints.toFixed(4)} points from the exact ` +
      `${(exact * 100).toFixed(4)}%, outside its own ±${pooledHalfWidth.toFixed(4)}-point interval`,
  );

  // 4. The interval shrinks as 1/sqrt(n). Quadrupling the samples halves it.
  const small = monteCarloEquity(spec, { samples: 20_000, seed: 7 });
  const large = monteCarloEquity(spec, { samples: 80_000, seed: 7 });
  const ratio =
    (small.confidence?.halfWidthPoints ?? Number.NaN) / (large.confidence?.halfWidthPoints ?? Number.NaN);
  assert.ok(
    ratio > 1.9 && ratio < 2.1,
    `quadrupling the samples should halve the interval, ratio was ${ratio}`,
  );
});
