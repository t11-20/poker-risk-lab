/**
 * Tests for the variance model. No expectation comes from `src/variance.ts`. Sources are published
 * standard normal values (`(1 + erf(z/√2))/2`), hand arithmetic in comments, closed-form identities,
 * and Monte Carlo on the engine's deterministic generator, the only check that catches a formula that
 * is self-consistently wrong. Every simulated figure is reproducible to the digit.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeterministicRandomForTests, type RandomSource } from '@prl/poker-engine';
import {
  bankrollForRiskTolerance,
  downswingOutlook,
  handsNeededForPrecision,
  normalCdf,
  normalQuantile,
  observedWinRateInterval,
  projectResults,
  riskOfRuin,
  VarianceError,
} from '../src/variance.ts';

function assertClose(actual: number, expected: number, tolerance: number, what: string): void {
  const off = Math.abs(actual - expected);
  assert.ok(
    off <= tolerance,
    `${what}: expected ${expected} ± ${tolerance}, got ${actual} (off by ${off.toExponential(2)})`,
  );
}

/** The accuracy A&S 26.2.17 claims, which is what the CDF tests hold it to. */
const CDF_ERROR_BOUND = 7.5e-8;

test('normalCdf matches published standard normal values inside its stated error bound', () => {
  // Phi(z) = (1 + erf(z / sqrt(2))) / 2, evaluated in double precision by a library erf.
  const known: readonly (readonly [number, number])[] = [
    [-3.0, 0.0013498980316301035],
    [-2.5, 0.006209665325776159],
    [-2.0, 0.02275013194817921],
    [-1.5, 0.06680720126885809],
    [-1.0, 0.15865525393145707],
    [-0.75, 0.2266273523768682],
    [-0.5, 0.30853753872598694],
    [-0.375, 0.35383023332727626],
    [-0.25, 0.4012936743170763],
    [0, 0.5],
    [0.5, 0.691462461274013],
    [1.0, 0.8413447460685429],
    [1.5, 0.9331927987311419],
    [1.96, 0.9750021048517796],
    [2.0, 0.9772498680518208],
    [3.0, 0.9986501019683699],
  ];
  for (const [z, expected] of known) {
    assertClose(normalCdf(z), expected, CDF_ERROR_BOUND, `normalCdf(${z})`);
  }

  assert.equal(normalCdf(0), 0.5, 'zero is special-cased to be exactly one half');
  assertClose(normalCdf(1.96), 0.975, 3e-6, 'the textbook 95% point');
  assertClose(normalCdf(-1.96), 0.025, 3e-6, 'and its mirror');
  assertClose(normalCdf(1), 0.8413447, 1e-7, 'one standard deviation');
  assertClose(normalCdf(2.5758), 0.995, 1e-6, 'the textbook 99% point');
});

test('normalCdf is symmetric, monotone, and stays inside [0, 1]', () => {
  // Phi(-z) = 1 - Phi(z) is checked to floating-point tolerance, because reflection is exact.
  let previous = -1;
  let checked = 0;
  for (let step = -600; step <= 600; step++) {
    const z = step / 100;
    const value = normalCdf(z);
    assertClose(normalCdf(-z), 1 - value, 1e-15, `symmetry at z=${z}`);
    assert.ok(value >= 0 && value <= 1, `normalCdf(${z}) = ${value} escaped [0, 1]`);
    assert.ok(value >= previous, `normalCdf must not decrease: fell at z=${z}`);
    previous = value;
    checked += 1;
  }
  assert.equal(checked, 1201);

  // Phi(-40) is about 1e-350, below what a double holds, so exactly 0 is right.
  assert.equal(normalCdf(-40), 0);
  assert.equal(normalCdf(40), 1);
});

test('normalQuantile matches published critical values', () => {
  // Ground truth from a high-precision inverse CDF. Acklam claims relative error below 1.15e-9.
  const known: readonly (readonly [number, number])[] = [
    [0.5, 0],
    [0.8, 0.8416212335729144],
    [0.9, 1.2815515655446008],
    [0.95, 1.6448536269514715],
    [0.975, 1.9599639845400536],
    [0.995, 2.5758293035489],
    [0.999, 3.090232306167813],
  ];
  for (const [p, expected] of known) {
    assertClose(normalQuantile(p), expected, 1e-8, `normalQuantile(${p})`);
    // The lower half is the exact mirror of the upper half.
    assertClose(normalQuantile(1 - p), -expected, 1e-8, `normalQuantile(${1 - p})`);
  }
  assert.equal(normalQuantile(0.5), 0, 'the median is exactly zero');
});

test('normalQuantile round-trips with normalCdf to the tolerance each direction allows', () => {
  // Limited by normalCdf's 7.5e-8, so 1e-7. A sweep measures a worst case of 7.2e-8.
  for (const p of [0.001, 0.01, 0.025, 0.05, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.95, 0.975, 0.99, 0.999]) {
    assertClose(normalCdf(normalQuantile(p)), p, 1e-7, `cdf(quantile(${p}))`);
  }

  // z in, z out is much looser. The CDF is flat in the tails, so 7.5e-8 in probability is about
  // 7.5e-8 / phi(z) in z, which at z = 3 is 1.7e-5.
  let worst = 0;
  for (let step = -30; step <= 30; step++) {
    const z = step / 10;
    const recovered = normalQuantile(normalCdf(z));
    worst = Math.max(worst, Math.abs(recovered - z));
    assertClose(recovered, z, 5e-5, `quantile(cdf(${z}))`);
  }
  assert.ok(worst > 1e-6, `the tail degradation is real and should be visible, worst was ${worst}`);
  assert.ok(worst < 5e-5, `but bounded, worst was ${worst}`);
});

test('normalCdf and normalQuantile refuse input they cannot answer for', () => {
  assert.throws(() => normalCdf(Number.NaN), { name: 'VarianceError', message: /finite/ });
  assert.throws(() => normalCdf(Number.POSITIVE_INFINITY), { name: 'VarianceError', message: /finite/ });
  assert.throws(() => normalQuantile(0), { name: 'VarianceError', message: /strictly between 0 and 1/ });
  assert.throws(() => normalQuantile(1), { name: 'VarianceError', message: /strictly between 0 and 1/ });
  assert.throws(() => normalQuantile(-0.1), { name: 'VarianceError', message: /strictly between 0 and 1/ });
  assert.throws(() => normalQuantile(1.5), { name: 'VarianceError', message: /strictly between 0 and 1/ });
  assert.throws(() => normalQuantile(Number.NaN), { name: 'VarianceError', message: /finite/ });
  assert.ok(new VarianceError('x') instanceof Error, 'VarianceError is a real Error subclass');
  assert.equal(new VarianceError('x').name, 'VarianceError');
});

test('projectResults scales the mean with the sample and the deviation with its square root', () => {
  // 10,000 hands is 100 blocks of 100.
  //   expected = 5 bb/100 * 100 blocks             = 500 bb
  //   deviation = 100 bb/100 * sqrt(100 blocks)    = 1000 bb
  //   interval = 500 +/- 1.96 * 1000               = [-1460, 2460]
  //   P(loss)  = Phi((0 - 500) / 1000) = Phi(-0.5) = 0.30853753872598694
  const projection = projectResults({ hands: 10_000, winRateBbPer100: 5, standardDeviationBbPer100: 100 });
  assert.equal(projection.expectedBb, 500);
  assert.equal(projection.standardDeviationBb, 1000);
  assert.equal(projection.interval95.lowerBb, -1460);
  assert.equal(projection.interval95.upperBb, 2460);
  assertClose(projection.probabilityOfLoss, 0.30853753872598694, CDF_ERROR_BOUND, 'P(loss) = Phi(-0.5)');

  assert.equal(
    (projection.interval95.lowerBb + projection.interval95.upperBb) / 2,
    projection.expectedBb,
    'the interval is centred on the expectation',
  );
  assert.equal(projection.interval95.upperBb - projection.interval95.lowerBb, 2 * 1.96 * 1000);

  // Inputs are echoed unchanged, so a rendered figure cannot drift from what produced it.
  assert.equal(projection.hands, 10_000);
  assert.equal(projection.winRateBbPer100, 5);
  assert.equal(projection.standardDeviationBbPer100, 100);
});

test('doubling the hands doubles the expectation and multiplies the deviation by sqrt(2)', () => {
  const short = projectResults({ hands: 25_000, winRateBbPer100: 4, standardDeviationBbPer100: 90 });
  const long = projectResults({ hands: 50_000, winRateBbPer100: 4, standardDeviationBbPer100: 90 });

  // 4 bb/100 over 250 and 500 blocks: 1000 bb and 2000 bb, exactly.
  assert.equal(short.expectedBb, 1000);
  assert.equal(long.expectedBb, 2000);
  assert.equal(long.expectedBb, 2 * short.expectedBb, 'means add, so the mean is linear in the sample');

  // Variances add, so twice the hands is twice the variance. Asserted on the variances.
  const shortVariance = short.standardDeviationBb ** 2;
  const longVariance = long.standardDeviationBb ** 2;
  assertClose(longVariance / shortVariance, 2, 1e-12, 'variance doubles');
  assertClose(long.standardDeviationBb / short.standardDeviationBb, Math.SQRT2, 1e-15, 'deviation × √2');

  // Twice the edge but only 1.41 times the noise, so a losing sample gets less likely.
  assert.ok(
    long.probabilityOfLoss < short.probabilityOfLoss,
    'more hands must make a losing sample less likely for a winning player',
  );
});

test('a break-even player finishes below zero exactly half the time, whatever the sample', () => {
  for (const handCount of [100, 5_000, 1_000_000]) {
    const projection = projectResults({
      hands: handCount,
      winRateBbPer100: 0,
      standardDeviationBbPer100: 85,
    });
    assert.equal(projection.expectedBb, 0);
    // Phi(0) = 0.5 at every sample size. Hands buy information, not a better outcome from a zero edge.
    assert.equal(projection.probabilityOfLoss, 0.5, `at ${handCount} hands`);
  }
});

test('probabilityOfLoss shrinks with the sample but stays uncomfortably large for a long time', () => {
  // A 2 bb/100 winner with a 90 bb/100 deviation:
  //   10,000 hands  -> mean 200, sd 900,   z = -0.2222
  //   100,000 hands -> mean 2000, sd 2846, z = -0.7027
  const sample = [1_000, 10_000, 100_000, 1_000_000].map((handCount) =>
    projectResults({ hands: handCount, winRateBbPer100: 2, standardDeviationBbPer100: 90 }),
  );
  let previous = 1;
  for (const projection of sample) {
    assert.ok(projection.probabilityOfLoss < previous, 'losing must get less likely as the sample grows');
    previous = projection.probabilityOfLoss;
  }
  const tenThousand = sample.at(1);
  assert.ok(tenThousand !== undefined);
  assertClose(tenThousand.probabilityOfLoss, normalCdf(-200 / 900), 1e-15, 'hand-derived z at 10k hands');
  assert.ok(
    tenThousand.probabilityOfLoss > 0.4,
    'after 10,000 hands a real winner is still down more than 40% of the time — the lesson of the module',
  );
});

test('projectResults rejects impossible inputs instead of returning NaN', () => {
  const ok = { hands: 1_000, winRateBbPer100: 3, standardDeviationBbPer100: 90 };
  assert.throws(() => projectResults({ ...ok, hands: -1 }), { name: 'VarianceError', message: /at least 1/ });
  assert.throws(() => projectResults({ ...ok, hands: 0 }), { name: 'VarianceError', message: /at least 1/ });
  assert.throws(() => projectResults({ ...ok, hands: 10.5 }), {
    name: 'VarianceError',
    message: /whole number/,
  });
  assert.throws(() => projectResults({ ...ok, hands: Number.NaN }), {
    name: 'VarianceError',
    message: /finite/,
  });
  assert.throws(() => projectResults({ ...ok, standardDeviationBbPer100: 0 }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => projectResults({ ...ok, standardDeviationBbPer100: -90 }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => projectResults({ ...ok, standardDeviationBbPer100: Number.POSITIVE_INFINITY }), {
    name: 'VarianceError',
    message: /finite/,
  });
  assert.throws(() => projectResults({ ...ok, winRateBbPer100: Number.NaN }), {
    name: 'VarianceError',
    message: /finite/,
  });
  // Losing players exist, so a negative win rate is valid input.
  assert.ok(projectResults({ ...ok, winRateBbPer100: -5 }).expectedBb < 0);
});

test('observedWinRateInterval is the standard error of a mean of 100-hand blocks', () => {
  // 10,000 hands is 100 blocks, so sqrt(100) = 10 and
  //   halfWidth = 1.9599639845 * 100 / 10 = 19.599639845 bb/100
  //   interval  = 5 +/- 19.5996 = [-14.5996, 24.5996]
  const interval = observedWinRateInterval({
    hands: 10_000,
    observedBbPer100: 5,
    standardDeviationBbPer100: 100,
  });
  assertClose(interval.halfWidthBbPer100, 19.5996398454, 1e-7, 'half width');
  assertClose(interval.lowerBbPer100, -14.5996398454, 1e-7, 'lower bound');
  assertClose(interval.upperBbPer100, 24.5996398454, 1e-7, 'upper bound');
  assert.equal(interval.intervalIncludesZero, true, 'a 5 bb/100 read over 10k hands proves nothing');

  // Four times the hands halves the half-width.
  const fourTimes = observedWinRateInterval({
    hands: 40_000,
    observedBbPer100: 5,
    standardDeviationBbPer100: 100,
  });
  assertClose(
    fourTimes.halfWidthBbPer100,
    interval.halfWidthBbPer100 / 2,
    1e-12,
    'quarter noise, half width',
  );

  // 40,000 hands at 10 bb/100 gives +/- 9.8, which clears zero.
  const clear = observedWinRateInterval({
    hands: 40_000,
    observedBbPer100: 10,
    standardDeviationBbPer100: 100,
  });
  assert.equal(clear.intervalIncludesZero, false);
  assert.ok(clear.lowerBbPer100 > 0);
});

test('a higher confidence level widens the interval, and the multiplier is the normal quantile', () => {
  const base = { hands: 50_000, observedBbPer100: 3, standardDeviationBbPer100: 95 };
  const ninety = observedWinRateInterval({ ...base, confidence: 0.9 });
  const ninetyFive = observedWinRateInterval({ ...base, confidence: 0.95 });
  const ninetyNine = observedWinRateInterval({ ...base, confidence: 0.99 });
  assert.ok(ninety.halfWidthBbPer100 < ninetyFive.halfWidthBbPer100);
  assert.ok(ninetyFive.halfWidthBbPer100 < ninetyNine.halfWidthBbPer100);

  // The ratio of half-widths is 2.5758293035 / 1.6448536270. Tolerance 1e-8 because each z carries
  // up to 1.15e-9 relative error.
  assertClose(
    ninetyNine.halfWidthBbPer100 / ninety.halfWidthBbPer100,
    2.5758293035489 / 1.6448536269514715,
    1e-8,
    'half-widths scale with z',
  );
  // 0.95 is the default.
  assert.equal(observedWinRateInterval(base).halfWidthBbPer100, ninetyFive.halfWidthBbPer100);

  assert.throws(() => observedWinRateInterval({ ...base, confidence: 0 }), {
    name: 'VarianceError',
    message: /strictly between 0 and 1/,
  });
  assert.throws(() => observedWinRateInterval({ ...base, confidence: 1 }), {
    name: 'VarianceError',
    message: /strictly between 0 and 1/,
  });
  assert.throws(() => observedWinRateInterval({ ...base, hands: -5 }), {
    name: 'VarianceError',
    message: /at least 1/,
  });
  assert.throws(() => observedWinRateInterval({ ...base, observedBbPer100: Number.NaN }), {
    name: 'VarianceError',
    message: /finite/,
  });
});

test('handsNeededForPrecision round-trips through observedWinRateInterval', () => {
  // Round trip. The interval at the returned sample size must be at least as precise as asked, and
  // one hand fewer must miss it.
  for (const deviation of [70, 90, 110]) {
    for (const target of [0.5, 1, 2, 5]) {
      for (const confidence of [0.9, 0.95, 0.99]) {
        const needed = handsNeededForPrecision({
          standardDeviationBbPer100: deviation,
          desiredHalfWidthBbPer100: target,
          confidence,
        });
        assert.ok(Number.isInteger(needed.hands), 'a hand count must be a whole number');
        const achieved = observedWinRateInterval({
          hands: needed.hands,
          observedBbPer100: 0,
          standardDeviationBbPer100: deviation,
          confidence,
        }).halfWidthBbPer100;
        assert.ok(
          achieved <= target + 1e-12,
          `sd ${deviation}, target ${target}, confidence ${confidence}: got ${achieved}`,
        );
        if (needed.hands > 1) {
          const oneFewer = observedWinRateInterval({
            hands: needed.hands - 1,
            observedBbPer100: 0,
            standardDeviationBbPer100: deviation,
            confidence,
          }).halfWidthBbPer100;
          assert.ok(oneFewer > achieved, 'fewer hands must be less precise');
        }
      }
    }
  }

  //   N = 100 * (1.9599639845 * 100 / 19.6)^2 = 100 * 9.99981625^2
  //     = 9,999.63, which rounds up to 10,000
  const exact = handsNeededForPrecision({
    standardDeviationBbPer100: 100,
    desiredHalfWidthBbPer100: 19.6,
  });
  assert.equal(exact.hands, 10_000);
});

test('handsNeededForPrecision quadruples when the precision demand doubles', () => {
  const coarse = handsNeededForPrecision({
    standardDeviationBbPer100: 90,
    desiredHalfWidthBbPer100: 2,
  });
  const fine = handsNeededForPrecision({
    standardDeviationBbPer100: 90,
    desiredHalfWidthBbPer100: 1,
  });
  // N grows with the square of the ratio, so 4x. Rounding up shifts each by at most one hand.
  assertClose(fine.hands, 4 * coarse.hands, 4, 'four times the hands for twice the precision');

  // 100 * (1.9599639845 * 90 / 1)^2 = 3,111,581.8 -> 3,111,582.
  assert.equal(fine.hands, 3_111_582);

  assert.throws(
    () => handsNeededForPrecision({ standardDeviationBbPer100: 90, desiredHalfWidthBbPer100: 0 }),
    { name: 'VarianceError', message: /greater than 0/ },
  );
  assert.throws(
    () => handsNeededForPrecision({ standardDeviationBbPer100: 90, desiredHalfWidthBbPer100: -1 }),
    { name: 'VarianceError', message: /greater than 0/ },
  );
  assert.throws(
    () => handsNeededForPrecision({ standardDeviationBbPer100: 0, desiredHalfWidthBbPer100: 1 }),
    { name: 'VarianceError', message: /greater than 0/ },
  );
  assert.throws(
    () =>
      handsNeededForPrecision({
        standardDeviationBbPer100: 90,
        desiredHalfWidthBbPer100: Number.POSITIVE_INFINITY,
      }),
    { name: 'VarianceError', message: /finite/ },
  );
});

test('riskOfRuin matches the closed form at a point chosen to be exact', () => {
  // The bankroll that makes the exponent exactly -ln(2), so the answer is exactly one half:
  //   B = ln2 * sd^2 / (2w) = 0.69314718056 * 10000 / 4 = 1732.8679513998632
  const bankrollBb = 1732.8679513998632;
  const result = riskOfRuin({ bankrollBb, winRateBbPer100: 2, standardDeviationBbPer100: 100 });
  assertClose(result.probability, 0.5, 1e-12, 'exponent of -ln 2 gives exactly one half');

  // The exponent -1 gives 1/e:  B = sd^2 / (2w) = 10000 / 4 = 2500
  const oneOverE = riskOfRuin({ bankrollBb: 2500, winRateBbPer100: 2, standardDeviationBbPer100: 100 });
  assertClose(oneOverE.probability, 1 / Math.E, 1e-12, 'exponent of -1 gives 1/e');

  assert.equal(result.bankrollBb, bankrollBb, 'inputs are echoed for display');
  assert.match(result.formula, /exp\(-2 × bankroll × winRate \/ sd²\)/, 'the formula is stated, not implied');
  assert.match(result.formula, /never depends on the block length/, 'the unit cancellation is derived');
});

test('doubling the bankroll squares the risk of ruin', () => {
  // To lose 2B you lose B, then B again from a barrier that moved with you, so the probability
  // squares. This needs no reference value.
  for (const bankrollBb of [50, 200, 1_000, 5_000]) {
    for (const winRateBbPer100 of [0.5, 2, 8]) {
      const single = riskOfRuin({ bankrollBb, winRateBbPer100, standardDeviationBbPer100: 95 });
      const doubled = riskOfRuin({
        bankrollBb: bankrollBb * 2,
        winRateBbPer100,
        standardDeviationBbPer100: 95,
      });
      assertClose(
        doubled.probability,
        single.probability ** 2,
        1e-12,
        `P(2B) = P(B)^2 at B=${bankrollBb}, w=${winRateBbPer100}`,
      );
    }
  }
});

test('riskOfRuin is certain without an edge, and strictly between 0 and 1 with one', () => {
  for (const winRateBbPer100 of [-10, -1, 0]) {
    const doomed = riskOfRuin({ bankrollBb: 10_000, winRateBbPer100, standardDeviationBbPer100: 90 });
    assert.equal(doomed.probability, 1, `a win rate of ${winRateBbPer100} is ruin with certainty`);
    assert.match(doomed.formula, /P\(ruin\) = 1/, 'and says why');
    assert.match(doomed.explanation, /no edge|no bankroll|certain/i);
  }
  for (const bankrollBb of [1, 100, 10_000]) {
    const probability = riskOfRuin({
      bankrollBb,
      winRateBbPer100: 3,
      standardDeviationBbPer100: 90,
    }).probability;
    assert.ok(probability > 0 && probability < 1, `expected (0,1), got ${probability} at ${bankrollBb} bb`);
  }
});

test('riskOfRuin moves the right way with each input', () => {
  const base = { bankrollBb: 1_000, winRateBbPer100: 3, standardDeviationBbPer100: 90 };
  const probability = (over: Partial<typeof base>): number => riskOfRuin({ ...base, ...over }).probability;

  // Monotone decreasing in bankroll.
  let previous = 1;
  for (const bankrollBb of [100, 500, 1_000, 2_000, 10_000]) {
    const value = probability({ bankrollBb });
    assert.ok(value < previous, `more bankroll must lower risk, failed at ${bankrollBb}`);
    previous = value;
  }
  // Monotone decreasing in win rate.
  previous = 1;
  for (const winRateBbPer100 of [0.25, 1, 3, 6, 12]) {
    const value = probability({ winRateBbPer100 });
    assert.ok(value < previous, `more edge must lower risk, failed at ${winRateBbPer100}`);
    previous = value;
  }
  // Monotone increasing in deviation.
  previous = 0;
  for (const standardDeviationBbPer100 of [40, 70, 90, 130, 200]) {
    const value = probability({ standardDeviationBbPer100 });
    assert.ok(value > previous, `more noise must raise risk, failed at ${standardDeviationBbPer100}`);
    previous = value;
  }
});

test('riskOfRuin states the assumptions that make it fragile', () => {
  // The figure is only honest when its assumptions are shown.
  const result = riskOfRuin({ bankrollBb: 2_000, winRateBbPer100: 2, standardDeviationBbPer100: 95 });
  const text = result.assumptions.join(' ').toLowerCase();
  for (const required of [
    'constant',
    'stakes',
    'withdraw',
    'normal',
    'infinite',
    'zero',
    'approximation',
    'resettable',
  ]) {
    assert.ok(text.includes(required), `assumptions must mention "${required}"`);
  }
  assert.ok(result.assumptions.length >= 6, 'the list is load-bearing, not decorative');
  assert.ok(result.explanation.length > 0);
});

test('riskOfRuin rejects impossible inputs', () => {
  const ok = { bankrollBb: 1_000, winRateBbPer100: 2, standardDeviationBbPer100: 90 };
  assert.throws(() => riskOfRuin({ ...ok, bankrollBb: 0 }), {
    name: 'VarianceError',
    message: /already ruined/,
  });
  assert.throws(() => riskOfRuin({ ...ok, bankrollBb: -100 }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => riskOfRuin({ ...ok, bankrollBb: Number.NaN }), {
    name: 'VarianceError',
    message: /finite/,
  });
  assert.throws(() => riskOfRuin({ ...ok, standardDeviationBbPer100: 0 }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => riskOfRuin({ ...ok, winRateBbPer100: Number.POSITIVE_INFINITY }), {
    name: 'VarianceError',
    message: /finite/,
  });
});

test('bankrollForRiskTolerance round-trips through riskOfRuin to within 1e-6', () => {
  let checked = 0;
  for (const targetRiskOfRuin of [0.5, 0.2, 0.1, 0.05, 0.01, 0.005, 0.001, 1e-6]) {
    for (const winRateBbPer100 of [0.5, 1, 2, 5, 10]) {
      for (const standardDeviationBbPer100 of [60, 90, 120]) {
        const sized = bankrollForRiskTolerance({
          targetRiskOfRuin,
          winRateBbPer100,
          standardDeviationBbPer100,
        });
        assert.ok(sized.bankrollBb > 0, 'a bankroll requirement must be positive');
        const achieved = riskOfRuin({
          bankrollBb: sized.bankrollBb,
          winRateBbPer100,
          standardDeviationBbPer100,
        }).probability;
        assertClose(
          achieved,
          targetRiskOfRuin,
          1e-6 * Math.max(1, targetRiskOfRuin),
          `round trip at target ${targetRiskOfRuin}, w ${winRateBbPer100}, sd ${standardDeviationBbPer100}`,
        );
        checked += 1;
      }
    }
  }
  assert.equal(checked, 8 * 5 * 3);
});

test('bankrollForRiskTolerance matches the hand-derived requirement and refuses the impossible', () => {
  // sd^2 * ln(1/target) / (2w) with sd 100, w 2, target 0.05
  //   = 10000 * 2.995732273553991 / 4 = 7489.330683884978
  const sized = bankrollForRiskTolerance({
    targetRiskOfRuin: 0.05,
    winRateBbPer100: 2,
    standardDeviationBbPer100: 100,
  });
  assertClose(sized.bankrollBb, 7489.330683884978, 1e-9, 'closed-form bankroll');

  // Quadratic in the deviation, only logarithmic in the safety asked for.
  const noisier = bankrollForRiskTolerance({
    targetRiskOfRuin: 0.05,
    winRateBbPer100: 2,
    standardDeviationBbPer100: 110,
  });
  assertClose(noisier.bankrollBb / sized.bankrollBb, 1.21, 1e-12, '10% more noise costs 21% more bankroll');
  const safer = bankrollForRiskTolerance({
    targetRiskOfRuin: 0.01,
    winRateBbPer100: 2,
    standardDeviationBbPer100: 100,
  });
  assertClose(
    safer.bankrollBb / sized.bankrollBb,
    Math.log(100) / Math.log(20),
    1e-12,
    '5% to 1% costs ln100/ln20',
  );

  const base = { targetRiskOfRuin: 0.05, winRateBbPer100: 2, standardDeviationBbPer100: 100 };
  // Zero risk needs an infinite bankroll, so it throws instead of returning Infinity.
  assert.throws(() => bankrollForRiskTolerance({ ...base, targetRiskOfRuin: 0 }), {
    name: 'VarianceError',
    message: /infinite bankroll/,
  });
  assert.throws(() => bankrollForRiskTolerance({ ...base, targetRiskOfRuin: -0.1 }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => bankrollForRiskTolerance({ ...base, targetRiskOfRuin: 1 }), {
    name: 'VarianceError',
    message: /below 1/,
  });
  assert.throws(() => bankrollForRiskTolerance({ ...base, targetRiskOfRuin: 2 }), {
    name: 'VarianceError',
    message: /below 1/,
  });
  assert.throws(() => bankrollForRiskTolerance({ ...base, targetRiskOfRuin: Number.NaN }), {
    name: 'VarianceError',
    message: /finite/,
  });
  // Without an edge no finite bankroll works.
  assert.throws(() => bankrollForRiskTolerance({ ...base, winRateBbPer100: 0 }), {
    name: 'VarianceError',
    message: /without an edge/,
  });
  assert.throws(() => bankrollForRiskTolerance({ ...base, winRateBbPer100: -2 }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => bankrollForRiskTolerance({ ...base, standardDeviationBbPer100: 0 }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
});

test('downswingOutlook matches hand-derived normal probabilities', () => {
  // 10,000 hands at 3 bb/100 with an 80 bb/100 deviation: mean 300 bb, sd 800 bb.
  //   100 bb down: z = (-100 - 300) / 800 = -0.5   -> 0.30853753872598694
  //   300 bb down: z = (-300 - 300) / 800 = -0.75  -> 0.2266273523768682
  //   500 bb down: z = (-500 - 300) / 800 = -1.0   -> 0.15865525393145707
  //   1300 bb down: z = (-1300 - 300) / 800 = -2.0 -> 0.02275013194817921
  // and being down at all is z = -300/800 = -0.375 -> 0.35383023332727626
  const outlook = downswingOutlook({
    hands: 10_000,
    winRateBbPer100: 3,
    standardDeviationBbPer100: 80,
    thresholdsBb: [100, 300, 500, 1300],
  });
  assertClose(outlook.probabilityOfBeingDown, 0.35383023332727626, CDF_ERROR_BOUND, 'P(down at all)');
  const expected = new Map([
    [100, 0.30853753872598694],
    [300, 0.2266273523768682],
    [500, 0.15865525393145707],
    [1300, 0.02275013194817921],
  ]);
  assert.equal(outlook.probabilityOfDownswingAtLeast.length, 4);
  for (const entry of outlook.probabilityOfDownswingAtLeast) {
    const target = expected.get(entry.bb);
    assert.ok(target !== undefined, `unexpected threshold ${entry.bb}`);
    assertClose(entry.probability, target, CDF_ERROR_BOUND, `P(at least ${entry.bb} bb down)`);
  }

  // Same model as projectResults.
  const projection = projectResults({ hands: 10_000, winRateBbPer100: 3, standardDeviationBbPer100: 80 });
  assert.equal(outlook.probabilityOfBeingDown, projection.probabilityOfLoss);
});

test('downswing probabilities fall with depth, and thresholds come back sorted and deduplicated', () => {
  const outlook = downswingOutlook({
    hands: 50_000,
    winRateBbPer100: 2,
    standardDeviationBbPer100: 100,
    thresholdsBb: [500, 100, 2_000, 100, 1_000],
  });
  assert.deepEqual(
    outlook.probabilityOfDownswingAtLeast.map((entry) => entry.bb),
    [100, 500, 1_000, 2_000],
  );
  let previous = 1;
  for (const entry of outlook.probabilityOfDownswingAtLeast) {
    assert.ok(entry.probability < previous, `deeper must be less likely, failed at ${entry.bb}`);
    assert.ok(entry.probability > 0);
    previous = entry.probability;
  }
  assert.ok(outlook.probabilityOfBeingDown > previous);

  // Default thresholds are multiples of the projected deviation, rounded to two significant figures.
  // 100 blocks at 90 bb/100 is a 900 bb deviation, so 225, 450, 900, 1350, 1800 -> 230, 450, 900, 1400, 1800.
  const defaults = downswingOutlook({ hands: 10_000, winRateBbPer100: 2, standardDeviationBbPer100: 90 });
  assert.deepEqual(
    defaults.probabilityOfDownswingAtLeast.map((entry) => entry.bb),
    [230, 450, 900, 1400, 1800],
    'defaults scale with the noise instead of clumping at round bankroll figures',
  );
  assert.ok(
    defaults.probabilityOfDownswingAtLeast.every((entry) => entry.bb > 0),
    'thresholds are depths, stated positive',
  );
  // The shallowest and deepest default rows must be far apart.
  const shallowest = defaults.probabilityOfDownswingAtLeast.at(0);
  const deepest = defaults.probabilityOfDownswingAtLeast.at(-1);
  assert.ok(shallowest !== undefined && deepest !== undefined);
  assert.ok(
    shallowest.probability > 10 * deepest.probability,
    `the default table must span a real range, got ${shallowest.probability} to ${deepest.probability}`,
  );
  assert.ok(
    defaults.assumptions.some((note) => note.includes('standard deviations of the projected result')),
    'and it has to say that is what it did',
  );
  // An end-of-sample figure understates the worst dip, so the caveat must be in the text.
  assert.match(defaults.explanation, /END|ends/);
  assert.ok(defaults.assumptions.some((note) => note.includes('deepest point')));
});

test('downswingOutlook rejects thresholds that are not depths', () => {
  const ok = { hands: 10_000, winRateBbPer100: 2, standardDeviationBbPer100: 90 };
  assert.throws(() => downswingOutlook({ ...ok, thresholdsBb: [] }), {
    name: 'VarianceError',
    message: /at least one threshold/,
  });
  assert.throws(() => downswingOutlook({ ...ok, thresholdsBb: [100, 0] }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => downswingOutlook({ ...ok, thresholdsBb: [-200] }), {
    name: 'VarianceError',
    message: /greater than 0/,
  });
  assert.throws(() => downswingOutlook({ ...ok, thresholdsBb: [Number.NaN] }), {
    name: 'VarianceError',
    message: /finite/,
  });
  assert.throws(() => downswingOutlook({ ...ok, hands: 0 }), {
    name: 'VarianceError',
    message: /at least 1/,
  });
  const input = [500, 100];
  downswingOutlook({ ...ok, thresholdsBb: input });
  assert.deepEqual(input, [500, 100]);
});

test('every figure ships with an explanation and its assumptions', () => {
  // No number without the words that qualify it.
  const projection = projectResults({ hands: 10_000, winRateBbPer100: 3, standardDeviationBbPer100: 90 });
  const interval = observedWinRateInterval({
    hands: 10_000,
    observedBbPer100: 3,
    standardDeviationBbPer100: 90,
  });
  const precision = handsNeededForPrecision({
    standardDeviationBbPer100: 90,
    desiredHalfWidthBbPer100: 1,
  });
  const ruin = riskOfRuin({ bankrollBb: 2_000, winRateBbPer100: 3, standardDeviationBbPer100: 90 });
  const sizing = bankrollForRiskTolerance({
    targetRiskOfRuin: 0.05,
    winRateBbPer100: 3,
    standardDeviationBbPer100: 90,
  });
  const outlook = downswingOutlook({ hands: 10_000, winRateBbPer100: 3, standardDeviationBbPer100: 90 });

  for (const [what, explanation] of [
    ['projectResults', projection.explanation],
    ['observedWinRateInterval', interval.explanation],
    ['handsNeededForPrecision', precision.explanation],
    ['riskOfRuin', ruin.explanation],
    ['bankrollForRiskTolerance', sizing.explanation],
    ['downswingOutlook', outlook.explanation],
  ] as const) {
    assert.ok(explanation.length > 80, `${what} needs a real explanation, got "${explanation}"`);
  }
  for (const [what, assumptions] of [
    ['projectResults', projection.assumptions],
    ['observedWinRateInterval', interval.assumptions],
    ['riskOfRuin', ruin.assumptions],
    ['bankrollForRiskTolerance', sizing.assumptions],
    ['downswingOutlook', outlook.assumptions],
  ] as const) {
    assert.ok(assumptions.length >= 5, `${what} must list its assumptions, got ${assumptions.length}`);
    for (const note of assumptions) assert.ok(note.length > 20, `${what} has a stub assumption: "${note}"`);
  }
});

/**
 * A uniform draw in (0, 1) from the engine's integer generator. 2^26 buckets, offset by half a
 * bucket so the value is never 0 or 1. Box–Muller takes its logarithm.
 */
function unitInterval(random: RandomSource): number {
  return (random.nextInt(2 ** 26) + 0.5) / 2 ** 26;
}

/** Standard normal draws by Box–Muller. The spare normal of each pair is kept. */
function standardNormalDraws(random: RandomSource): () => number {
  let spare: number | null = null;
  return (): number => {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    const radius = Math.sqrt(-2 * Math.log(unitInterval(random)));
    const angle = 2 * Math.PI * unitInterval(random);
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
}

test('simulation: the fraction of losing runs matches probabilityOfLoss', () => {
  // 10,000 hands at 3 bb/100 with an 80 bb/100 deviation. Each trial draws 100 normal block results,
  // so this checks the scaling and the CDF, not the central limit theorem. The next test does that.
  const handCount = 10_000;
  const winRate = 3;
  const deviation = 80;
  const trials = 20_000;
  const projection = projectResults({
    hands: handCount,
    winRateBbPer100: winRate,
    standardDeviationBbPer100: deviation,
  });
  const outlook = downswingOutlook({
    hands: handCount,
    winRateBbPer100: winRate,
    standardDeviationBbPer100: deviation,
    thresholdsBb: [200, 500, 1_000],
  });
  const buckets = outlook.probabilityOfDownswingAtLeast.map((entry) => ({
    bb: entry.bb,
    model: entry.probability,
    hits: 0,
  }));

  const nextNormal = standardNormalDraws(createDeterministicRandomForTests(20240817));
  let losing = 0;
  let sum = 0;
  let sumOfSquares = 0;
  for (let trial = 0; trial < trials; trial++) {
    let total = 0;
    for (let block = 0; block < handCount / 100; block++) total += winRate + deviation * nextNormal();
    if (total < 0) losing += 1;
    for (const bucket of buckets) if (total <= -bucket.bb) bucket.hits += 1;
    sum += total;
    sumOfSquares += total * total;
  }

  // Standard error at p ~ 0.354 over 20,000 trials is 0.0034, so 0.015 is about 4.4 of them.
  // This seed gives 0.35025 against 0.35383.
  assertClose(losing / trials, projection.probabilityOfLoss, 0.015, 'fraction of losing runs');

  const empiricalMean = sum / trials;
  const empiricalDeviation = Math.sqrt(sumOfSquares / trials - empiricalMean * empiricalMean);
  assertClose(empiricalMean, projection.expectedBb, 25, 'empirical mean (4 standard errors is 22.6)');
  assertClose(empiricalDeviation / projection.standardDeviationBb, 1, 0.03, 'empirical deviation, to 3%');

  for (const bucket of buckets) {
    assertClose(bucket.hits / trials, bucket.model, 0.015, `fraction at least ${bucket.bb} bb down`);
  }
});

test('simulation: a deliberately lumpy per-hand result still matches, which is the CLT doing the work', () => {
  // Per-hand results from a skewed three-point distribution, in units of the per-hand deviation:
  //
  //   Y = -0.5 with probability 0.75,  +1.0 with probability 0.20,  +3.5 with 0.05
  //
  //   E[Y]   = 0.75*(-0.5) + 0.20*(1.0) + 0.05*(3.5)     = -0.375 + 0.2 + 0.175 = 0
  //   E[Y^2] = 0.75*(0.25) + 0.20*(1.0) + 0.05*(12.25)   = 0.1875 + 0.2 + 0.6125 = 1
  //
  // E[Y^3] = 2.25. A hand is `winRate/100 + (deviation/10) * Y`, so 100 hands carry mean w and
  // variance s^2. The sum over 10,000 hands still matches the normal model, by the central limit theorem.
  const handCount = 10_000;
  const winRate = 3;
  const deviation = 80;
  const trials = 4_000;
  const perHandMean = winRate / 100;
  const perHandDeviation = deviation / 10;
  const projection = projectResults({
    hands: handCount,
    winRateBbPer100: winRate,
    standardDeviationBbPer100: deviation,
  });

  const random = createDeterministicRandomForTests(991);
  let losing = 0;
  let sum = 0;
  let sumOfSquares = 0;
  for (let trial = 0; trial < trials; trial++) {
    let total = 0;
    for (let hand = 0; hand < handCount; hand++) {
      // 10,000 buckets, so the three probabilities are exact.
      const draw = random.nextInt(10_000);
      const y = draw < 7_500 ? -0.5 : draw < 9_500 ? 1 : 3.5;
      total += perHandMean + perHandDeviation * y;
    }
    if (total < 0) losing += 1;
    sum += total;
    sumOfSquares += total * total;
  }

  // 4,000 trials at p ~ 0.354 gives a standard error of 0.0076, and 0.03 is four of them. This seed
  // gives 0.36450. The skew of the sum is 0.0225, an Edgeworth correction of about 0.001.
  assertClose(losing / trials, projection.probabilityOfLoss, 0.03, 'fraction of losing runs, lumpy hands');

  const empiricalMean = sum / trials;
  const empiricalDeviation = Math.sqrt(sumOfSquares / trials - empiricalMean * empiricalMean);
  assertClose(empiricalMean, projection.expectedBb, 45, 'empirical mean (a standard error is 12.6)');
  assertClose(empiricalDeviation / projection.standardDeviationBb, 1, 0.05, 'empirical deviation, to 5%');
});

test('simulation: ruin over a finite horizon lands below the infinite-horizon closed form', () => {
  // 200 bb behind a 2 bb/100 winner with an 80 bb/100 deviation, over 20,000 hands. Ruin is the running
  // total reaching -200 bb, checked after every hand. Two ground truths:
  //
  //  1. Infinite horizon, exp(-2*200*2/6400) = exp(-0.125) = 0.882497. The simulation must come out
  //     below it because it stops at 20,000 hands.
  //
  //  2. Finite-horizon first passage for Brownian motion with drift,
  //
  //       P = Phi((-B - uT)/(s*sqrt(T))) + exp(-2uB/s^2) * Phi((-B + uT)/(s*sqrt(T)))
  //
  //     with 100-hand blocks: u = 2, s = 80, T = 200, B = 200, giving 0.801104. The discrete walk sits
  //     just under it, because it can dip below the barrier between checks and recover unseen.
  const bankrollBb = 200;
  const winRate = 2;
  const deviation = 80;
  const handCount = 20_000;
  const trials = 3_000;

  const infiniteHorizon = riskOfRuin({
    bankrollBb,
    winRateBbPer100: winRate,
    standardDeviationBbPer100: deviation,
  });
  assertClose(infiniteHorizon.probability, Math.exp(-0.125), 1e-15, 'exp(-2*200*2/6400)');
  assertClose(infiniteHorizon.probability, 0.8824969025845955, 1e-12, 'published value of exp(-1/8)');

  const blocks = handCount / 100;
  const spread = deviation * Math.sqrt(blocks);
  const finiteHorizon =
    normalCdf((-bankrollBb - winRate * blocks) / spread) +
    Math.exp((-2 * winRate * bankrollBb) / (deviation * deviation)) *
      normalCdf((-bankrollBb + winRate * blocks) / spread);
  assertClose(finiteHorizon, 0.801104304634688, 1e-6, 'first-passage formula, evaluated independently');

  const nextNormal = standardNormalDraws(createDeterministicRandomForTests(4242));
  const perHandMean = winRate / 100;
  const perHandDeviation = deviation / 10;
  let ruined = 0;
  for (let trial = 0; trial < trials; trial++) {
    let total = 0;
    for (let hand = 0; hand < handCount; hand++) {
      total += perHandMean + perHandDeviation * nextNormal();
      if (total <= -bankrollBb) {
        ruined += 1;
        break;
      }
    }
  }
  const empirical = ruined / trials;

  // 3,000 trials at p ~ 0.80 has a standard error of 0.0073, so 0.03 is four. This seed gives 0.79633.
  assertClose(empirical, finiteHorizon, 0.03, 'simulated ruin vs the first-passage formula');

  // Strictly lower than the infinite-horizon figure, by more than sampling error.
  assert.ok(
    empirical < infiniteHorizon.probability,
    `a finite horizon cannot exceed an infinite one: ${empirical} vs ${infiniteHorizon.probability}`,
  );
  assert.ok(
    infiniteHorizon.probability - empirical > 0.03,
    'and the gap should be clearly bigger than sampling error',
  );
  // Same ballpark, because most of the eventual ruin happens within 20,000 hands.
  assert.ok(empirical > 0.6, `ruin should still be common here, got ${empirical}`);
});
