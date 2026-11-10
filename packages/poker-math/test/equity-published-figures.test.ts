/**
 * The published equity figures, reproduced by enumeration rather than quoted.
 *
 * `docs/VERIFICATION.md` §8 printed AA-vs-KK at 81.946% averaged over all 36 suit
 * configurations, `AKs` vs `22` at 49.89% over 24, and `AKo` vs `QQ` at 43.24% over 72 —
 * and then §12 admitted, in its own words, that **no test in the tree reproduced any of
 * them**. The closest gated assertion was `apps/api/test/calc.test.ts`, which bounded one
 * configuration to 0.80–0.84. That window is 4 percentage points wide on a figure whose
 * entire spread across all 36 configurations is 1.4 points: an evaluator that had, say,
 * stopped counting the wheel as a straight would still have landed inside it. A document
 * that says "✔" beside a number nothing recomputes is publishing a result somebody
 * obtained once, and this is an app that teaches probability.
 *
 * ## Why the enumerator below is written out longhand instead of calling `exactEquity`
 *
 * §1's principle is that the foundations are checked against ground truth the code has no
 * access to. `enumerateHeadsUp` is a second implementation of the same quantity: five
 * nested loops over the remaining 48 cards, a running pot share, and nothing else — no
 * `Tally`, no `enumerateMatchups` generator, no `Set` of blocked cards, none of the
 * machinery `exactEquity` needs because it also has to serve range-vs-range and three to
 * six players. If both agree on 132 configurations, the agreement is not circular.
 *
 * It is also faster, which is what makes the whole sweep affordable. Measured on the
 * reference machine, one preflop configuration (C(48,5) = 1,712,304 boards, two hands
 * scored per board):
 *
 *     exactEquity                    263 ms
 *     enumerateHeadsUp               166 ms   (and bit-identical: 0.8125548967940273)
 *
 * The difference is the per-board `[...hand, ...pick]` allocation `exactEquity` makes for
 * each player. That is the right trade for a general enumerator and the wrong one for
 * 132 × 1.7M boards, so this file reuses one seven-card buffer per player and pays
 * `exactEquity` only where the point is to tie the two together.
 *
 * ## What this costs and why it is here rather than behind its own gate
 *
 * 132 configurations × ~166 ms ≈ 21 s, plus ~3 s of Monte Carlo. `test:exhaustive` is the
 * precedent for a heavier gate, but adding a seventeenth gate to `verify` is a three-file
 * change that `scripts/release-gate-coverage.mjs` enforces, and this fits inside
 * `packages/poker-math`'s own suite — which `test` already runs — at a cost `node --test`
 * overlaps with the other four files in the package.
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
 * Hero's pot share against one opponent, over every remaining five-card board.
 *
 * Deliberately longhand — see the file header. The one subtlety worth stating: a board on
 * which both hands make the same score is worth **half** a pot, not a win and not a loss.
 * AA against KK chops on 1.16% of boards, so scoring a chop as a loss would move the
 * answer by more than half a point and land it outside every assertion in this file.
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

  // A sweep of nothing is not a pass. C(48,5) is the only right answer for a preflop
  // heads-up spot, and a generator that quietly stopped matching would otherwise return
  // 0/0 = NaN and every `Math.abs(NaN - x) < tolerance` below would be false — which is at
  // least loud. `share / 0` where `share` is also 0 is the shape that is not.
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
 * The distinct equity values in a sweep, with how many configurations produced each.
 *
 * This is the structural half of the check and it is worth more than the average. Suits
 * are interchangeable in hold'em — no suit beats another, and a flush cares only that five
 * cards match — so two configurations that differ by a relabelling of the four suits must
 * have *identical* equity, to the last bit, not merely to some tolerance. The multiplicity
 * profile is therefore forced by combinatorics alone, and an evaluator with any
 * suit-dependent behaviour (a mask built with the wrong shift, a flush check that reads one
 * lane) would split a class and change these counts even if the average survived.
 *
 * Keyed on the raw float, not a rounded string: the equality being asserted is exact.
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
 * The exact values, to seventeen significant figures, produced by the sweep below.
 *
 * Written out rather than rounded because the assertions are tolerance-based and a
 * tolerance around a rounded target is a wider window than it looks. These are also the
 * numbers `docs/VERIFICATION.md` §8 publishes, so if this file and that document ever
 * disagree the document is the one that is wrong.
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
 * How far a swept figure may sit from the constant above.
 *
 * 1e-12, not a percentage-point tolerance. Both sides enumerate the identical set of
 * boards, so the only difference either side may legitimately show is float summation
 * order over 1.7M additions. This is deliberately far tighter than the spread between
 * neighbouring suit configurations (~0.007 in AA-vs-KK, ~0.00002 between the two middle
 * classes of AKo-vs-QQ), which is what makes it able to fail.
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

  // The published figure, to the precision it is published at. Asserted separately from
  // the constants above so that a change to this line has to be a deliberate statement
  // about what the document says, rather than a constant nudged until a test went green.
  assert.equal((average * 100).toFixed(3), '81.946', 'the ~81.9% figure §8 publishes');
  assert.equal((min.equity * 100).toFixed(2), '81.26');
  assert.equal((max.equity * 100).toFixed(2), '82.64');

  // Which configurations they are, because §8 names them and a reader checking by hand
  // needs to be able to reproduce the extremes and not only the mean. The worst case for
  // the aces is the one where the kings hold the two suits the aces do not: those kings
  // have the cleanest run at a flush that the aces cannot match.
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

  // Three classes — no shared suit, one shared suit, both shared — with the multiplicities
  // combinatorics forces: 6 x 1, 6 x 4, 6 x 1. See `multiplicityProfile`.
  assert.deepEqual(multiplicityProfile(configurations), [6, 6, 24]);

  // And a small identity that falls out of it, recorded because it is the reason a reader
  // can sanity-check §8's average against its own stated range in their head: the
  // one-shared-suit class sits exactly halfway between the two extremes, so the mean of
  // all 36 equals the midpoint of the range.
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

  // The teaching point §8 and the lessons both rest on: this really is the coin flip it is
  // described as, in EVERY configuration and not only on average. The pair is a hair ahead.
  for (const one of configurations) {
    assert.ok(
      one.equity > 0.49 && one.equity < 0.51,
      `${label(one.hero)} vs ${label(one.villain)} is ${(one.equity * 100).toFixed(2)}%, not a coin flip`,
    );
  }

  // Two classes: the deuces hold one of AKs's suit, or neither. Twelve configurations each.
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

  // This one is why §8 was rewritten to state averages: the document used to print 42.84%
  // for this matchup, which is the MINIMUM configuration, set beside AA-vs-KK's average.
  // The gap is 0.4 points and it was in the direction that understates AKo.
  assert.ok(
    average - min.equity > 0.004,
    'the average and the minimum are far enough apart that quoting one for the other is an error',
  );

  // Four classes here, not three: the ace's suit and the king's suit are distinguishable
  // (they are different ranks), so "queens hold the ace's suit" and "queens hold the king's
  // suit" are separate cases. They differ by 0.0019 points — the smallest real gap this
  // file measures, and the one a tolerance sloppier than 1e-12 would erase.
  assert.deepEqual(multiplicityProfile(configurations), [12, 12, 24, 24]);
});

test('the production enumerator agrees with the longhand one, bit for bit', () => {
  // The tie between this file's ground truth and the code the app actually runs. Three
  // configurations rather than 132 because `exactEquity` is 60% slower per configuration
  // and the agreement is exact, not statistical: if the two paths agree to the last bit on
  // 1.7M boards three times over, they are computing the same thing.
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
  // The second half of what §12 said nothing reproduced. The tolerance here is NOT a number
  // chosen to make the assertion pass: every bound below is the run's own 95% half-width,
  // 1.96 * sd / sqrt(n), computed by `monteCarloEquity` from the variance it observed. The
  // only free choices are the sample size and the seeds.
  //
  // Seeds are fixed, so this is deterministic — `monteCarloEquity` is contractually
  // reproducible for a given (spec, samples, seed) — and a 95% interval that fails one time
  // in twenty cannot flake a gate here. What the fixed seeds cost is generality, which is
  // why the assertion is about the ENSEMBLE of 200 of them rather than about any one.
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

  // 1. Coverage. A correctly calibrated 95% interval covers the truth about 190 times in
  //    200 (sd 3.1). Measured 2026-08-26: 184. The floor is 175 — three standard deviations
  //    below the mean, so it does not flake if the sampler is fine, and far above what a
  //    biased sampler could reach: an estimator off by a single half-width (0.54 points)
  //    covers roughly 50% of the time, i.e. ~100 of 200.
  assert.ok(
    inside >= 175,
    `only ${inside} of ${SEEDS} 95% intervals contained the exact value ${exact}; expected ~190`,
  );
  assert.ok(inside <= SEEDS, 'coverage cannot exceed the number of runs');

  // 2. No single run is wildly out. Measured worst case 1.66 half-widths (z = 3.26 on 200
  //    draws, which is what 200 draws from a normal looks like). 2.5 half-widths is z = 4.9;
  //    reaching it by chance is a once-in-a-million event per run, so this fires on bias,
  //    not on luck.
  assert.ok(worstRatio < 2.5, `the worst run missed by ${worstRatio.toFixed(2)} half-widths`);

  // 3. The strongest form, and the one that would catch a small systematic bias the
  //    coverage count would not: pool all 200 shards through the production `combineMonteCarlo`
  //    and compare 4,000,000 samples against the enumeration. The pooled interval is ±0.038
  //    points — an order of magnitude tighter than the spread between suit configurations —
  //    and the measured miss on 2026-08-26 was 0.016 points, z = 0.84.
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

  // 4. And the interval is not decoration: it has to shrink as 1/sqrt(n) or it is not an
  //    error bar, it is a constant. Quadrupling the samples must halve it.
  const small = monteCarloEquity(spec, { samples: 20_000, seed: 7 });
  const large = monteCarloEquity(spec, { samples: 80_000, seed: 7 });
  const ratio =
    (small.confidence?.halfWidthPoints ?? Number.NaN) / (large.confidence?.halfWidthPoints ?? Number.NaN);
  assert.ok(
    ratio > 1.9 && ratio < 2.1,
    `quadrupling the samples should halve the interval, ratio was ${ratio}`,
  );
});
