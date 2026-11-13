/**
 * Variance under a normal model. One block of 100 hands is one step, so N hands is n = N / 100 steps.
 *
 *     expected result    = w * n           means add
 *     standard deviation = s * sqrt(n)     variances add, deviations do not
 *
 * Win rate `w` and deviation `s` are bb/100. Results are bb. The deviation is a measured input,
 * commonly 80-110 bb/100 online. The central limit theorem makes a sum of hands near normal, and
 * `test/variance.test.ts` checks that against a skewed per-hand distribution. Real tails are fatter,
 * so every function returns its `assumptions`. Units here are play chips, so "ruin" is a barrier in a
 * distribution.
 */

export class VarianceError extends Error {
  override readonly name = 'VarianceError';
}

/** 1 / sqrt(2 * pi), the standard normal density's scale factor. */
const INV_SQRT_TWO_PI = 0.3989422804014327;

// Zelen & Severo, Abramowitz & Stegun 26.2.17. Named constants rather than an array so no indexed
// read needs an undefined check under `noUncheckedIndexedAccess`.
const ZS_P = 0.2316419;
const ZS_B1 = 0.31938153;
const ZS_B2 = -0.356563782;
const ZS_B3 = 1.781477937;
const ZS_B4 = -1.821255978;
const ZS_B5 = 1.330274429;

/**
 * The upper tail 1 - Phi(x) for x >= 0, by A&S 26.2.17. Published bound |eps| < 7.5e-8. A sweep over
 * [0, 8] at step 0.0005 measured a worst case of 7.45e-8 near x = 0.72, and the accuracy test pins it.
 * Computing the upper tail keeps relative accuracy for small tail probabilities, which subtracting a
 * lower tail from 1 would lose to cancellation.
 */
function standardNormalUpperTail(x: number): number {
  const t = 1 / (1 + ZS_P * x);
  const density = INV_SQRT_TWO_PI * Math.exp(-0.5 * x * x);
  const polynomial = t * (ZS_B1 + t * (ZS_B2 + t * (ZS_B3 + t * (ZS_B4 + t * ZS_B5))));
  return density * polynomial;
}

/**
 * The standard normal CDF, P(Z <= z), to an absolute error below 7.5e-8. Negative z uses
 * `Phi(-z) = 1 - Phi(z)`, so results are symmetric to rounding. z = 0 returns exactly 0.5, not the
 * approximation's 0.5000000005.
 */
export function normalCdf(z: number): number {
  requireFinite(z, 'z');
  if (z === 0) return 0.5;
  const tail = standardNormalUpperTail(Math.abs(z));
  return z > 0 ? 1 - tail : tail;
}

// Acklam's inverse normal CDF. Published relative error < 1.15e-9 on (0, 1), measured 1.13e-9.
const ACKLAM_SPLIT = 0.02425;
const ACKLAM_A1 = -3.969683028665376e1;
const ACKLAM_A2 = 2.209460984245205e2;
const ACKLAM_A3 = -2.759285104469687e2;
const ACKLAM_A4 = 1.38357751867269e2;
const ACKLAM_A5 = -3.066479806614716e1;
const ACKLAM_A6 = 2.506628277459239;
const ACKLAM_B1 = -5.447609879822406e1;
const ACKLAM_B2 = 1.615858368580409e2;
const ACKLAM_B3 = -1.556989798598866e2;
const ACKLAM_B4 = 6.680131188771972e1;
const ACKLAM_B5 = -1.328068155288572e1;
const ACKLAM_C1 = -7.784894002430293e-3;
const ACKLAM_C2 = -3.223964580411365e-1;
const ACKLAM_C3 = -2.400758277161838;
const ACKLAM_C4 = -2.549732539343734;
const ACKLAM_C5 = 4.374664141464968;
const ACKLAM_C6 = 2.938163982698783;
const ACKLAM_D1 = 7.784695709041462e-3;
const ACKLAM_D2 = 3.224671290700398e-1;
const ACKLAM_D3 = 2.445134137142996;
const ACKLAM_D4 = 3.754408661907416;

/** The tail branch of Acklam's approximation, in terms of q = sqrt(-2 ln p). */
function acklamTail(q: number): number {
  const numerator =
    ((((ACKLAM_C1 * q + ACKLAM_C2) * q + ACKLAM_C3) * q + ACKLAM_C4) * q + ACKLAM_C5) * q + ACKLAM_C6;
  const denominator = (((ACKLAM_D1 * q + ACKLAM_D2) * q + ACKLAM_D3) * q + ACKLAM_D4) * q + 1;
  return numerator / denominator;
}

/**
 * The standard normal quantile, the z with `normalCdf(z) = p`, by Acklam (relative error < 1.15e-9).
 * It is not refined against `normalCdf`, whose 7.5e-8 error would make it worse. The tests pin the
 * round trips: `normalCdf(normalQuantile(p))` returns p to about 1e-7, and
 * `normalQuantile(normalCdf(z))` returns z to about 2e-5 for |z| <= 3 and worse in the tails.
 */
export function normalQuantile(p: number): number {
  requireFinite(p, 'p');
  if (p <= 0 || p >= 1) {
    throw new VarianceError(
      `normalQuantile needs a probability strictly between 0 and 1, received ${p} ` +
        '(0 and 1 map to minus and plus infinity, which is not a usable answer)',
    );
  }
  if (p < ACKLAM_SPLIT) return acklamTail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - ACKLAM_SPLIT) return -acklamTail(Math.sqrt(-2 * Math.log(1 - p)));
  // Central branch, odd in q = p - 0.5, so p = 0.5 returns exactly 0 and the halves mirror exactly.
  const q = p - 0.5;
  const r = q * q;
  const numerator =
    (((((ACKLAM_A1 * r + ACKLAM_A2) * r + ACKLAM_A3) * r + ACKLAM_A4) * r + ACKLAM_A5) * r + ACKLAM_A6) * q;
  const denominator =
    ((((ACKLAM_B1 * r + ACKLAM_B2) * r + ACKLAM_B3) * r + ACKLAM_B4) * r + ACKLAM_B5) * r + 1;
  return numerator / denominator;
}

function requireFinite(value: number, what: string): number {
  if (!Number.isFinite(value)) {
    throw new VarianceError(`${what} must be a finite number, received ${String(value)}`);
  }
  return value;
}

/** Zero hands has no distribution and half a hand does not exist, so both are refused, not clamped. */
function requireHands(hands: number): number {
  requireFinite(hands, 'hands');
  if (!Number.isInteger(hands)) {
    throw new VarianceError(`hands must be a whole number, received ${hands}`);
  }
  if (hands < 1) {
    throw new VarianceError(`hands must be at least 1, received ${hands}`);
  }
  return hands;
}

function requireWinRate(winRate: number): number {
  return requireFinite(winRate, 'winRateBbPer100');
}

/** A deviation of 0 or less is refused, because every figure divides by it. */
function requireDeviation(deviation: number): number {
  requireFinite(deviation, 'standardDeviationBbPer100');
  if (deviation <= 0) {
    throw new VarianceError(
      `standardDeviationBbPer100 must be greater than 0, received ${deviation} — ` +
        'a result with no spread is not a poker result, and every figure here divides by it',
    );
  }
  return deviation;
}

function requireConfidence(confidence: number): number {
  requireFinite(confidence, 'confidence');
  if (confidence <= 0 || confidence >= 1) {
    throw new VarianceError(
      `confidence must be strictly between 0 and 1, e.g. 0.95 for a 95% interval, received ${confidence}`,
    );
  }
  return confidence;
}

const HANDS_PER_BLOCK = 100;

/** The conventional two-sided 95% multiplier, rounded from 1.959963985. */
const Z_95_CONVENTIONAL = 1.96;

const DEFAULT_CONFIDENCE = 0.95;

/**
 * Default downswing depths, as multiples of the projected result's standard deviation. Fixed bb
 * figures fail, because over 50,000 hands at 90 bb/100 the spread is 2,012 bb and "50 bb down" and
 * "300 bb down" land within a tenth of a deviation of each other.
 */
const DEFAULT_DOWNSWING_MULTIPLES = [0.25, 0.5, 1, 1.5, 2] as const;

/**
 * Rounds to two significant figures, so a threshold reads "500 bb", not "503.1 bb". A non-positive or
 * unrepresentable input comes back unchanged.
 */
function roundToTwoSignificantFigures(value: number): number {
  if (!(value > 0)) return value;
  const magnitude = 10 ** (Math.floor(Math.log10(value)) - 1);
  if (!Number.isFinite(magnitude) || magnitude <= 0) return value;
  const rounded = Math.round(value / magnitude) * magnitude;
  return Number.isFinite(rounded) && rounded > 0 ? rounded : value;
}

/** The step size of the whole model. */
function blocksOf(hands: number): number {
  return hands / HANDS_PER_BLOCK;
}

/** The two-sided multiplier for a confidence level, e.g. 0.95 -> 1.959963985. */
function twoSidedZ(confidence: number): number {
  return normalQuantile(1 - (1 - confidence) / 2);
}

/**
 * P(result < threshold) under the normal model. The public functions reject a zero deviation. The
 * zero branch keeps the helper total by treating the result as a point mass.
 */
function probabilityOfFinishingBelow(threshold: number, expected: number, deviation: number): number {
  if (deviation === 0) return expected < threshold ? 1 : 0;
  return normalCdf((threshold - expected) / deviation);
}

function bb(value: number): string {
  return `${Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)} bb`;
}

/** Big blinds with an explicit sign, so "+300 bb" and "-300 bb" read differently. */
function signedBb(value: number): string {
  return `${value >= 0 ? '+' : ''}${bb(value)}`;
}

function rate(value: number): string {
  return `${value.toFixed(1)} bb/100`;
}

function hands(count: number): string {
  return `${count.toLocaleString('en-US')} hands`;
}

/** An exact 0 means the figure underflowed double precision, so it is labelled rather than shown as 0%. */
function percent(probability: number): string {
  const value = probability * 100;
  if (value === 0) return 'effectively 0% (below what this arithmetic can represent, not impossible)';
  if (value >= 1) return `${value.toFixed(1)}%`;
  if (value >= 0.01) return `${value.toFixed(2)}%`;
  return `${value.toExponential(1)}%`;
}

/** Assumptions shared by every figure that comes out of the normal model. */
function normalModelAssumptions(): string[] {
  return [
    'The win rate and standard deviation given are treated as exact. Both are estimates measured from ' +
      'some sample, and the win rate is by far the harder of the two to pin down — which is what ' +
      'observedWinRateInterval is for.',
    'Results are treated as normally distributed. One hand is nothing like normal, but a sum over ' +
      'thousands of roughly independent hands is close to it. The approximation is weakest in the ' +
      'extreme tails, where real results are fatter than this model says.',
    'Every hand is played at the same stakes, with the same edge, against opposition of the same ' +
      'strength. A real sample spans stake changes, better and worse tables, and a player who is ' +
      'still learning.',
    'Hands are independent of one another: no tilt, no fatigue, no opponents adjusting to you.',
    'Figures are in big blinds. In this app the units are free, valueless and resettable, so nothing ' +
      'here is a statement about money.',
  ];
}

export interface WinRateProjection {
  readonly hands: number;
  readonly winRateBbPer100: number;
  readonly standardDeviationBbPer100: number;
  readonly expectedBb: number;
  readonly standardDeviationBb: number;
  readonly interval95: { readonly lowerBb: number; readonly upperBb: number };
  readonly probabilityOfLoss: number;
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

/** What an edge and a deviation imply for N hands. Expected bb is linear in N, the deviation is sqrt(N). */
export function projectResults(input: {
  hands: number;
  winRateBbPer100: number;
  standardDeviationBbPer100: number;
}): WinRateProjection {
  const handCount = requireHands(input.hands);
  const winRate = requireWinRate(input.winRateBbPer100);
  const deviation = requireDeviation(input.standardDeviationBbPer100);

  const blocks = blocksOf(handCount);
  const expectedBb = winRate * blocks;
  const standardDeviationBb = deviation * Math.sqrt(blocks);
  const lowerBb = expectedBb - Z_95_CONVENTIONAL * standardDeviationBb;
  const upperBb = expectedBb + Z_95_CONVENTIONAL * standardDeviationBb;
  const probabilityOfLoss = probabilityOfFinishingBelow(0, expectedBb, standardDeviationBb);

  const explanation = [
    `Over ${hands(handCount)} — ${blocks.toLocaleString('en-US')} blocks of 100 — an edge of`,
    `${rate(winRate)} projects to ${signedBb(expectedBb)}, with a standard deviation of`,
    `${bb(standardDeviationBb)}.`,
    `The expectation scales with the number of hands (${blocks.toLocaleString('en-US')} ×`,
    `${rate(winRate)}) but the spread scales with its square root (√${blocks.toLocaleString('en-US')} ×`,
    `${rate(deviation)}), because variances add and deviations do not.`,
    `A 95% interval runs from ${signedBb(lowerBb)} to ${signedBb(upperBb)}:`,
    `${percent(probabilityOfLoss)} of samples this long finish below break-even even though every`,
    'decision in them was profitable.',
  ].join(' ');

  return {
    hands: handCount,
    winRateBbPer100: winRate,
    standardDeviationBbPer100: deviation,
    expectedBb,
    standardDeviationBb,
    interval95: { lowerBb, upperBb },
    probabilityOfLoss,
    explanation,
    assumptions: [
      ...normalModelAssumptions(),
      'The 95% interval uses the conventional multiplier 1.96, which is 1.959963985 rounded. It ' +
        'covers the middle 95% of samples, so 2.5% finish above the top of it and 2.5% below the bottom.',
      'This describes where a sample of this length ENDS. It says nothing about the worst point along ' +
        'the way, which is deeper — see downswingOutlook.',
    ],
  };
}

export interface ObservedWinRateInterval {
  readonly hands: number;
  readonly observedBbPer100: number;
  readonly standardDeviationBbPer100: number;
  readonly halfWidthBbPer100: number;
  readonly lowerBbPer100: number;
  readonly upperBbPer100: number;
  readonly intervalIncludesZero: boolean;
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

/**
 * The confidence interval around an observed win rate, `halfWidth = z * deviation / sqrt(N / 100)`.
 * The observed rate is a mean of N/100 blocks, so its standard error is `deviation / sqrt(n)`.
 * `intervalIncludesZero` true means the sample is consistent with a losing player.
 */
export function observedWinRateInterval(input: {
  hands: number;
  observedBbPer100: number;
  standardDeviationBbPer100: number;
  confidence?: number;
}): ObservedWinRateInterval {
  const handCount = requireHands(input.hands);
  const observed = requireFinite(input.observedBbPer100, 'observedBbPer100');
  const deviation = requireDeviation(input.standardDeviationBbPer100);
  const confidence = requireConfidence(input.confidence ?? DEFAULT_CONFIDENCE);

  const blocks = blocksOf(handCount);
  const z = twoSidedZ(confidence);
  const halfWidthBbPer100 = (z * deviation) / Math.sqrt(blocks);
  const lowerBbPer100 = observed - halfWidthBbPer100;
  const upperBbPer100 = observed + halfWidthBbPer100;
  const intervalIncludesZero = lowerBbPer100 <= 0 && upperBbPer100 >= 0;

  const noiseRatio =
    observed === 0
      ? 'the observed rate is exactly zero, so there is no signal at all to weigh that noise against'
      : `one 100-hand block is ${Math.abs(deviation / observed).toFixed(0)} times noisier than the rate ` +
        'being measured';

  const explanation = [
    `Over ${hands(handCount)} the observed rate is ${rate(observed)}.`,
    `With a standard deviation of ${rate(deviation)}, ${noiseRatio};`,
    `averaging ${blocks.toLocaleString('en-US')} blocks cuts that noise by √${blocks.toLocaleString('en-US')},`,
    `which leaves a ${(confidence * 100).toFixed(0)}% interval of ±${halfWidthBbPer100.toFixed(1)} bb/100:`,
    `from ${rate(lowerBbPer100)} to ${rate(upperBbPer100)}.`,
    intervalIncludesZero
      ? 'The interval includes zero, so this sample on its own cannot tell a winning player from a losing one.'
      : 'The interval excludes zero, so this sample is hard to explain by luck alone — though it still ' +
        'assumes the conditions never changed across it.',
  ].join(' ');

  return {
    hands: handCount,
    observedBbPer100: observed,
    standardDeviationBbPer100: deviation,
    halfWidthBbPer100,
    lowerBbPer100,
    upperBbPer100,
    intervalIncludesZero,
    explanation,
    assumptions: [
      ...normalModelAssumptions(),
      `The multiplier is z = ${z.toFixed(6)}, the two-sided ${(confidence * 100).toFixed(0)}% normal ` +
        'quantile. It assumes the standard deviation is known rather than estimated from the same ' +
        'sample; treating it as known makes the interval slightly narrower than it should be, which ' +
        'is negligible over thousands of hands and would not be over a few hundred.',
      'The interval describes the procedure, not this one sample: intervals built this way contain the ' +
        `true rate ${(confidence * 100).toFixed(0)}% of the time. It is not a ` +
        `${(confidence * 100).toFixed(0)}% chance that the true rate is in this particular one.`,
      'It assumes the sample is the whole record, chosen in advance. Picking your best stretch, or ' +
        'stopping once the number looked good, invalidates it completely.',
    ],
  };
}

/**
 * Hands needed to measure a win rate to a half-width, `N = 100 * (z * deviation / halfWidth)^2`.
 * Rounded up, because rounding down would miss the requested precision.
 */
export function handsNeededForPrecision(input: {
  standardDeviationBbPer100: number;
  desiredHalfWidthBbPer100: number;
  confidence?: number;
}): { readonly hands: number; readonly explanation: string } {
  const deviation = requireDeviation(input.standardDeviationBbPer100);
  const halfWidth = requireFinite(input.desiredHalfWidthBbPer100, 'desiredHalfWidthBbPer100');
  if (halfWidth <= 0) {
    throw new VarianceError(
      `desiredHalfWidthBbPer100 must be greater than 0, received ${halfWidth} — ` +
        'a half-width of 0 means measuring a win rate exactly, which takes infinitely many hands',
    );
  }
  const confidence = requireConfidence(input.confidence ?? DEFAULT_CONFIDENCE);

  const z = twoSidedZ(confidence);
  const ratio = (z * deviation) / halfWidth;
  const handCount = Math.ceil(HANDS_PER_BLOCK * ratio * ratio);

  const explanation = [
    `Measuring a win rate to ±${halfWidth.toFixed(1)} bb/100 at`,
    `${(confidence * 100).toFixed(0)}% confidence, with a standard deviation of ${rate(deviation)},`,
    `needs ${hands(handCount)}: N = 100 × (z × sd / halfWidth)² = 100 × (${z.toFixed(6)} ×`,
    `${deviation.toFixed(1)} / ${halfWidth.toFixed(1)})², rounded up.`,
    'The square is the part worth remembering: halving the half-width multiplies the hands by four,',
    'and a standard deviation 10% higher costs 21% more hands.',
  ].join(' ');

  return { hands: handCount, explanation };
}

export interface RiskOfRuin {
  readonly bankrollBb: number;
  readonly winRateBbPer100: number;
  readonly standardDeviationBbPer100: number;
  readonly probability: number;
  readonly formula: string;
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

/** The assumptions behind the diffusion approximation. */
function riskOfRuinAssumptions(): string[] {
  return [
    'The edge is constant: the same win rate for every hand, forever.',
    'The stakes never change. No moving up when things go well, no dropping down when they do not — ' +
      'and dropping down is exactly what a real player does to survive, which is why this figure is ' +
      'pessimistic about anyone sensible.',
    'Nothing is ever added to or taken out of the bankroll: no deposits, no withdrawals, no cashing out.',
    'Results are normally distributed. Real tails are fatter, which pushes true ruin above this number ' +
      'in a way the formula cannot see.',
    'The time horizon is infinite: you keep playing indefinitely. This is why the answer does not ' +
      'depend on a number of hands, and why it is always at least as large as the risk over any finite ' +
      'stretch.',
    'Ruin means the bankroll reaching zero at any point, not ending below zero. It is an absorbing ' +
      'barrier — reaching it once counts, however well things were going before.',
    'This is an approximation, not a law. It models a lumpy sequence of hands as smooth Brownian ' +
      'motion. A real bankroll faces stake changes, table selection, rake changes, a skill level that ' +
      'moves, and tails fatter than a normal distribution has.',
    'In this app the units are free, valueless and resettable, so "ruin" is a barrier in a ' +
      'distribution, never a financial event.',
  ];
}

/**
 * The diffusion approximation to the risk of ever going broke.
 *
 *     P(ruin) = exp(-2 * bankroll * winRate / deviation^2)     for winRate > 0
 *     P(ruin) = 1                                              for winRate <= 0
 *
 * A walk with zero drift is recurrent, so without an edge ruin is certain. `formula` on the result
 * carries the derivation and the unit cancellation.
 */
export function riskOfRuin(input: {
  bankrollBb: number;
  winRateBbPer100: number;
  standardDeviationBbPer100: number;
}): RiskOfRuin {
  const bankrollBb = requireFinite(input.bankrollBb, 'bankrollBb');
  if (bankrollBb <= 0) {
    throw new VarianceError(
      `bankrollBb must be greater than 0, received ${bankrollBb} — ` +
        'a bankroll of zero is already ruined, and a negative bankroll is not a bankroll',
    );
  }
  const winRate = requireWinRate(input.winRateBbPer100);
  const deviation = requireDeviation(input.standardDeviationBbPer100);

  const exponent = (-2 * bankrollBb * winRate) / (deviation * deviation);
  const probability = winRate <= 0 ? 1 : Math.exp(exponent);

  const formula =
    winRate <= 0
      ? [
          'P(ruin) = 1 whenever the win rate is not positive.',
          'Model the bankroll as a random walk: one block of 100 hands is one step, with drift equal to',
          `the win rate (${rate(winRate)}) and variance equal to the standard deviation squared`,
          `(${(deviation * deviation).toFixed(0)} bb²).`,
          'A walk with zero drift is recurrent — over infinite time it reaches every level, including',
          'zero — and a negative drift takes it there directly. No bankroll survives forever without an',
          'edge, so no bankroll size appears in the answer.',
        ].join(' ')
      : [
          'P(ruin) = exp(-2 × bankroll × winRate / sd²) =',
          `exp(-2 × ${bankrollBb.toFixed(0)} × ${winRate.toFixed(1)} / ${deviation.toFixed(1)}²) =`,
          `exp(${exponent.toFixed(4)}) = ${percent(probability)}.`,
          'Derivation: treat one block of 100 hands as one time step, so the drift per step is the win',
          `rate (${rate(winRate)}) and the variance per step is the standard deviation squared`,
          `(${(deviation * deviation).toFixed(0)} bb² per 100 hands).`,
          'For Brownian motion with drift µ and variance rate σ², started a distance B above an',
          'absorbing barrier, the probability of ever touching the barrier is exp(-2µB/σ²).',
          'Substituting µ = winRate and σ² = sd² gives the formula above.',
          'The units cancel: winRate is bb per 100 hands and sd² is bb² per 100 hands, so winRate/sd²',
          'is per bb, and multiplying by a bankroll in bb leaves a dimensionless number. Choose a',
          'different block length and both drift and variance scale by the same factor, so the answer',
          'never depends on the block length — only on the ratio of edge to variance per big blind of',
          'bankroll.',
        ].join(' ');

  const explanation =
    winRate <= 0
      ? [
          `With a win rate of ${rate(winRate)} there is no edge to outrun the swings, so a bankroll of`,
          `${bb(bankrollBb)} is certain to reach zero given enough hands.`,
          'The size of the bankroll changes how long it takes, not whether it happens.',
        ].join(' ')
      : [
          `For a bankroll of ${bb(bankrollBb)} at ${rate(winRate)}, with a standard deviation of`,
          `${rate(deviation)}, the chance of ever reaching zero is ${percent(probability)} — for a player`,
          'who never changes stakes and never stops.',
          'Two things about the shape of that formula are worth more than the number itself: the',
          'bankroll enters through an exponential, so each extra chunk of bankroll cuts the risk by a',
          'constant factor, and the standard deviation enters squared, so noise costs far more than a',
          'small edge buys.',
        ].join(' ');

  return {
    bankrollBb,
    winRateBbPer100: winRate,
    standardDeviationBbPer100: deviation,
    probability,
    formula,
    explanation,
    assumptions: riskOfRuinAssumptions(),
  };
}

/**
 * The bankroll that holds the risk of ruin at a target, `B = sd^2 * ln(1 / target) / (2 * winRate)`.
 * A target of 0 and a win rate of 0 or less are refused, because no finite bankroll answers them.
 */
export function bankrollForRiskTolerance(input: {
  targetRiskOfRuin: number;
  winRateBbPer100: number;
  standardDeviationBbPer100: number;
}): { readonly bankrollBb: number; readonly explanation: string; readonly assumptions: readonly string[] } {
  const target = requireFinite(input.targetRiskOfRuin, 'targetRiskOfRuin');
  if (target <= 0) {
    throw new VarianceError(
      `targetRiskOfRuin must be greater than 0, received ${target} — ` +
        'a zero chance of ruin needs an infinite bankroll, since the risk falls exponentially with ' +
        'bankroll but never reaches zero',
    );
  }
  if (target >= 1) {
    throw new VarianceError(
      `targetRiskOfRuin must be below 1, received ${target} — ` +
        'a target of 1 or more is satisfied by any bankroll at all, so there is nothing to compute',
    );
  }
  const winRate = requireWinRate(input.winRateBbPer100);
  const deviation = requireDeviation(input.standardDeviationBbPer100);
  if (winRate <= 0) {
    throw new VarianceError(
      `winRateBbPer100 must be greater than 0 to size a bankroll, received ${winRate} — ` +
        'without an edge the risk of ruin is 1 at every bankroll, so no finite bankroll meets a target ' +
        'below 1',
    );
  }

  const bankrollBb = (deviation * deviation * Math.log(1 / target)) / (2 * winRate);

  const explanation = [
    `Holding the risk of ruin at ${percent(target)} with a win rate of ${rate(winRate)} and a standard`,
    `deviation of ${rate(deviation)} takes ${bb(bankrollBb)} behind you:`,
    `bankroll = sd² × ln(1 / target) / (2 × winRate) = ${(deviation * deviation).toFixed(0)} ×`,
    `${Math.log(1 / target).toFixed(4)} / ${(2 * winRate).toFixed(1)}.`,
    'The shape matters more than the number. The requirement grows with the SQUARE of the standard',
    'deviation, so a game 10% noisier needs 21% more bankroll, while it grows only with the LOGARITHM',
    'of the safety you ask for — going from a 5% target to 1% needs about 54% more bankroll',
    '(ln 100 / ln 20). And it falls with the edge, so improving is the cheapest way to need less.',
  ].join(' ');

  return {
    bankrollBb,
    explanation,
    assumptions: [
      ...riskOfRuinAssumptions(),
      'This inverts the same approximation, so it inherits every assumption above. It is a starting ' +
        'point for a conversation about caution, not a threshold that makes anything safe.',
    ],
  };
}

export interface DownswingOutlook {
  readonly hands: number;
  readonly winRateBbPer100: number;
  readonly standardDeviationBbPer100: number;
  readonly probabilityOfBeingDown: number;
  readonly probabilityOfDownswingAtLeast: readonly { readonly bb: number; readonly probability: number }[];
  readonly explanation: string;
  readonly assumptions: readonly string[];
}

/**
 * The distribution of the result after N hands, `P(at least X bb down) = Phi((-X - expected) / sd)`.
 * This is the endpoint only. Being X bb down at some point during the run is strictly more likely,
 * and the explanation and assumptions say so.
 */
export function downswingOutlook(input: {
  hands: number;
  winRateBbPer100: number;
  standardDeviationBbPer100: number;
  thresholdsBb?: readonly number[];
}): DownswingOutlook {
  const handCount = requireHands(input.hands);
  const winRate = requireWinRate(input.winRateBbPer100);
  const deviation = requireDeviation(input.standardDeviationBbPer100);
  const blocks = blocksOf(handCount);
  const expectedBb = winRate * blocks;
  const standardDeviationBb = deviation * Math.sqrt(blocks);
  const usingDefaults = input.thresholdsBb === undefined;
  const requested =
    input.thresholdsBb ??
    DEFAULT_DOWNSWING_MULTIPLES.map((multiple) =>
      roundToTwoSignificantFigures(multiple * standardDeviationBb),
    );
  if (requested.length === 0) {
    throw new VarianceError('thresholdsBb must contain at least one threshold, received an empty list');
  }
  for (const threshold of requested) {
    requireFinite(threshold, 'thresholdsBb entry');
    if (threshold <= 0) {
      throw new VarianceError(
        `every thresholdsBb entry must be greater than 0, received ${threshold} — ` +
          'a threshold is a depth in big blinds below break-even, so it is stated as a positive number',
      );
    }
  }
  // Ascending with duplicates collapsed, so the learner's table has no repeated rows. The input list is
  // not mutated.
  const thresholds = [...new Set(requested)].sort((left, right) => left - right);

  const probabilityOfBeingDown = probabilityOfFinishingBelow(0, expectedBb, standardDeviationBb);
  const probabilityOfDownswingAtLeast = thresholds.map((threshold) => ({
    bb: threshold,
    probability: probabilityOfFinishingBelow(-threshold, expectedBb, standardDeviationBb),
  }));

  const deepest = probabilityOfDownswingAtLeast[probabilityOfDownswingAtLeast.length - 1];
  const deepestNote =
    deepest === undefined
      ? ''
      : ` Finishing at least ${bb(deepest.bb)} down happens in ${percent(deepest.probability)} of them.`;

  const explanation = [
    `After ${hands(handCount)} at ${rate(winRate)} the model expects ${signedBb(expectedBb)} with a`,
    `standard deviation of ${bb(standardDeviationBb)}, so ${percent(probabilityOfBeingDown)} of samples`,
    `this long finish below break-even.${deepestNote}`,
    'Every figure here is where a sample ENDS. The chance of being that far down at some point along',
    'the way is strictly higher — a run has thousands of chances to be at its worst and one chance to',
    'finish there — so treat these as a floor on how bad a stretch can look, not a ceiling.',
  ].join(' ');

  return {
    hands: handCount,
    winRateBbPer100: winRate,
    standardDeviationBbPer100: deviation,
    probabilityOfBeingDown,
    probabilityOfDownswingAtLeast,
    explanation,
    assumptions: [
      ...normalModelAssumptions(),
      'Each probability is for the result after exactly this many hands, not for the deepest point ' +
        'reached during them. The deepest point is worse, and the gap grows with the length of the ' +
        'sample.',
      'Thresholds are depths below break-even in big blinds, reported in ascending order with ' +
        'duplicates collapsed. A deeper threshold is always at most as likely as a shallower one.',
      usingDefaults
        ? 'No thresholds were given, so these are a quarter, a half, one, one and a half and two ' +
          `standard deviations of the projected result (${bb(standardDeviationBb)}), rounded to two ` +
          'significant figures. Reading a downswing in units of the noise is more informative than ' +
          'reading it in round numbers, which is why the default is scaled rather than fixed.'
        : 'The thresholds are the ones the caller asked for, so nothing here implies they are the ' +
          'interesting depths for this sample.',
      'A downswing at this depth says nothing about whether the decisions inside it were good. That is ' +
        'the point of the exercise: judge the decisions on their reasoning, not on the graph.',
    ],
  };
}
