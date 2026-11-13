/**
 * A computed strength ordering of the 169 starting-hand classes, so "the top 15%" has a checkable meaning
 * instead of one copied from a published chart. Strength is all-in, heads-up equity against a uniformly
 * random hand. That is not playability, and every consumer gets `assumptions` saying so.
 * One combo per class is exact, because relabelling suits is a bijection on opponents and run-outs.
 * Every class uses the same seed (common random numbers), so the differences an ordering depends on
 * share their noise and the structural tests hold at a small sample count.
 */

import type { Card } from '@prl/poker-engine';
import { monteCarloEquity } from './equity.ts';
import { allHandClasses, combosOfClass, exactRange, type ParsedRange, parseRange } from './ranges.ts';

export class HandRankingError extends Error {
  override readonly name = 'HandRankingError';
}

export interface HandClassStrength {
  /** Canonical class label: "AA", "AKs", "72o". */
  readonly label: string;
  /** Estimated pot share all-in, heads-up, against a uniformly random hand. */
  readonly equityVsRandom: number;
  /** 1 = strongest. Every class has a distinct rank. */
  readonly rank: number;
  /** Percent of the 1,326 combos held by this class and every stronger one, weighted by combos. */
  readonly cumulativePercent: number;
}

export interface StrengthTable {
  readonly method: 'monte-carlo-vs-random';
  readonly samplesPerClass: number;
  readonly seed: number;
  /** All 169 classes, strongest first. */
  readonly entries: readonly HandClassStrength[];
  readonly assumptions: readonly string[];
}

/**
 * 95% interval of ±0.49 points (AA) to ±0.68 points (near a coin flip), which resolves everything but
 * neighbours in the weak tail. The 169-class table takes a little over three seconds on a laptop.
 */
const DEFAULT_SAMPLES_PER_CLASS = 20_000;

/** Fixed so the table and every `topPercent` range are reproducible. */
const DEFAULT_SEED = 20_260_817;

/** The floor keeps the ordering from being near arbitrary. The ceiling bounds work in a request handler. */
const MIN_SAMPLES_PER_CLASS = 200;
const MAX_SAMPLES_PER_CLASS = 200_000;

/** 13 pairs x 6 + 78 suited x 4 + 78 offsuit x 12 = 1326. */
const TOTAL_COMBOS = 1326;

const EXPECTED_CLASS_COUNT = 169;

/** Pure apart from the memo in `strengthTable()`. Same arguments give a bit-identical table. */
export function computeStrengthTable(
  options: { samplesPerClass?: number; seed?: number } = {},
): StrengthTable {
  const samplesPerClass = options.samplesPerClass ?? DEFAULT_SAMPLES_PER_CLASS;
  const seed = options.seed ?? DEFAULT_SEED;
  if (!Number.isInteger(samplesPerClass)) {
    throw new HandRankingError(`samplesPerClass must be an integer, received ${samplesPerClass}`);
  }
  if (samplesPerClass < MIN_SAMPLES_PER_CLASS || samplesPerClass > MAX_SAMPLES_PER_CLASS) {
    throw new HandRankingError(
      `samplesPerClass must be between ${MIN_SAMPLES_PER_CLASS} and ${MAX_SAMPLES_PER_CLASS}, ` +
        `received ${samplesPerClass}`,
    );
  }
  if (!Number.isInteger(seed)) {
    throw new HandRankingError(`seed must be an integer so the table is reproducible, received ${seed}`);
  }

  const classes = allHandClasses();
  if (classes.length !== EXPECTED_CLASS_COUNT) {
    throw new HandRankingError(
      `expected ${EXPECTED_CLASS_COUNT} starting-hand classes, ranges.ts produced ${classes.length}`,
    );
  }

  const measured = classes.map((handClass, canonicalIndex) => {
    const representative = combosOfClass(handClass)[0];
    if (representative === undefined) {
      throw new HandRankingError(`class ${handClass.label} produced no combinations`);
    }
    const heroCards: readonly Card[] = representative;
    // Hero's cards as blockers make "random" uniform over the 1,225 available combos with no rejection.
    const result = monteCarloEquity(
      {
        players: [
          { label: handClass.label, range: exactRange(heroCards) },
          { label: 'a uniformly random hand', range: parseRange('random', heroCards) },
        ],
        board: [],
      },
      { samples: samplesPerClass, seed },
    );
    const hero = result.players[0];
    if (hero === undefined) throw new HandRankingError('equity result carried no players');
    return { handClass, canonicalIndex, equityVsRandom: hero.equity };
  });

  // The canonical-index tie-break makes the order total when two classes sample to the same equity.
  measured.sort((a, b) =>
    b.equityVsRandom === a.equityVsRandom
      ? a.canonicalIndex - b.canonicalIndex
      : b.equityVsRandom - a.equityVsRandom,
  );

  const entries: HandClassStrength[] = [];
  let combosSoFar = 0;
  for (const [index, item] of measured.entries()) {
    // Weighted by combos, not labels. AA is 1% of the 169 labels but 0.45% of deals.
    combosSoFar += item.handClass.comboCount;
    entries.push({
      label: item.handClass.label,
      equityVsRandom: item.equityVsRandom,
      rank: index + 1,
      cumulativePercent: (combosSoFar / TOTAL_COMBOS) * 100,
    });
  }
  if (combosSoFar !== TOTAL_COMBOS) {
    throw new HandRankingError(
      `the 169 classes should cover all ${TOTAL_COMBOS} combinations, covered ${combosSoFar}`,
    );
  }

  return {
    method: 'monte-carlo-vs-random',
    samplesPerClass,
    seed,
    entries,
    assumptions: [
      `Each figure is estimated from ${samplesPerClass.toLocaleString('en-US')} sampled run-outs, not from ` +
        'exhaustive enumeration, so each carries a fraction of a percentage point of sampling noise.',
      'Strength here means exactly one thing: the share of the pot the class wins all-in and heads-up ' +
        'against a hand drawn uniformly from the 1,225 combinations you do not hold.',
      'Position, stack depth, the number of opponents and postflop playability are not modelled at all. ' +
        'All-in equity is not playability: 22 beats AKo in an all-in more often than it loses, and is ' +
        'still the harder hand to play for a deep stack.',
      'One representative combination is measured per class. Relabelling suits leaves the exact equity ' +
        'unchanged, so this costs nothing beyond the sampling noise already stated.',
      'Cumulative percentages weight each class by how many of the 1,326 combinations it holds (6 for a ' +
        'pair, 4 suited, 12 offsuit), so "the top 15%" means 15% of hands dealt, not 15% of the 169 labels.',
      'The ordering is computed here rather than taken from any published chart, and it is not a claim ' +
        'about how any of these hands should be played.',
      'Neighbouring classes in the weak tail sit within the sampling noise of each other, so their ' +
        'relative order is not meaningful and should not be shown as if it were.',
    ],
  };
}

/**
 * The package's only cached state. Safe because `strengthTable()` takes no arguments, so the memo
 * changes when the work happens, never the answer. The table costs a few seconds per build.
 */
let memoisedDefaultTable: StrengthTable | null = null;

export function strengthTable(): StrengthTable {
  memoisedDefaultTable ??= computeStrengthTable();
  return memoisedDefaultTable;
}

/**
 * The strongest classes covering at least `percent` of dealt hands, including the class that crosses it.
 * Classes come in lumps of 6, 4 or 12 combos, so `fractionOfAllHands` reports what was covered.
 * Built through `parseRange` so range construction has one code path.
 */
export function topPercentRange(percent: number): ParsedRange {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) {
    throw new HandRankingError(`percent must be a finite number, received ${String(percent)}`);
  }
  if (percent <= 0 || percent > 100) {
    throw new HandRankingError(`percent must be greater than 0 and at most 100, received ${percent}`);
  }

  const table = strengthTable();
  const labels: string[] = [];
  for (const entry of table.entries) {
    labels.push(entry.label);
    if (entry.cumulativePercent >= percent) break;
  }
  if (labels.length === 0) {
    throw new HandRankingError('the strength table is empty, so no top-percentage range can be built');
  }
  return parseRange(labels.join(', '));
}

/** The measured entry for one class label, or `null` if the label is not a class. */
export function strengthOf(label: string, table: StrengthTable = strengthTable()): HandClassStrength | null {
  for (const entry of table.entries) {
    if (entry.label === label) return entry;
  }
  return null;
}
