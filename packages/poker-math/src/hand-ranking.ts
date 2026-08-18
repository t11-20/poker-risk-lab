/**
 * A *computed* strength ordering of the 169 starting-hand classes.
 *
 * `ranges.ts` can express "the top 15% of hands", and that phrase is meaningless
 * without an ordering. The obvious way to get one is to copy a published preflop
 * chart. This file deliberately does not: a chart is somebody else's material, its
 * provenance cannot be shown to a learner, and the numbers on it cannot be checked.
 * So the ordering is measured here, from first principles, by one narrow question:
 *
 *     all-in, heads-up, against a hand drawn uniformly from the rest of the deck,
 *     what share of the pot does this class win?
 *
 * That question has a single right answer, this package can compute it, and a test
 * can check it against structural facts (a pair beats its offsuit namesake; suited
 * beats offsuit) rather than against a table nobody can audit.
 *
 * ## What this ordering is NOT
 *
 * All-in equity is not playability, and the UI must never let the two be confused.
 * 22 beats AKo in an all-in more often than it loses, and is still much the worse
 * hand to take into a deep-stacked pot: it flops a set one time in eight and is
 * otherwise almost unplayable, whereas AKo flops something usable constantly. The
 * ordering below is a defensible answer to a narrow question, not a ranking of how
 * good hands are. Every consumer gets `assumptions` saying so.
 *
 * ## One representative combination per class
 *
 * AsAh, AsAd, AsAc, AhAd, AhAc and AdAc are all "AA", and their exact equity
 * against a random hand is *identical* — relabelling the suits is a bijection on
 * the remaining 1,225 opposing combinations and on every run-out, and hand strength
 * does not depend on which suit is which. So measuring one combination per class is
 * not an approximation of the exact figure; it is the exact figure, and it saves a
 * factor of up to twelve.
 *
 * The residual approximation is the sampling, not the representative: Monte Carlo
 * draws a finite set of run-outs, which are not suit-symmetric, so a different
 * representative would land a fraction of a point away. That noise is small next to
 * the gaps between distant classes and comparable to the gaps between neighbouring
 * ones, which is why the tail of the table reorders slightly with the sample count.
 *
 * ## Why every class is measured with the SAME seed
 *
 * Common random numbers. Each class is sampled from an identically seeded stream, so
 * the classes share their run-out draws instead of each getting independent noise.
 * The absolute equities are no more accurate for it, but the *differences* between
 * classes — the only thing an ordering depends on — are far more reliable at a given
 * sample count, because the shared component of the error cancels. This is what lets
 * the structural checks in the tests hold at a sample count small enough to run in a
 * test suite.
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
  /**
   * Share of all 1,326 two-card combinations held by this class and every stronger
   * one, as a percentage. Weighted by combinations, not by labels — see below.
   */
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
 * 20,000 samples per class is a deliberate compromise. It puts the 95% interval on a
 * class between ±0.49 points (AA, where the outcome is nearly certain and the variance
 * is low) and ±0.68 points (a hand near a coin flip against random, where it is
 * highest). That resolves every distinction worth drawing except neighbouring classes
 * in the weak tail, and the whole 169-class table takes a little over three seconds on
 * a laptop. Raising the count buys accuracy as the square root of the extra work, and
 * the tail ordering it would settle is not a distinction any learner should act on.
 */
const DEFAULT_SAMPLES_PER_CLASS = 20_000;

/** Fixed so the table — and therefore every `topPercent` range — is reproducible. */
const DEFAULT_SEED = 20_260_817;

/**
 * Bounds on the sample count. The floor keeps a caller from asking for a table so
 * noisy that the ordering is close to arbitrary; the ceiling keeps a single call from
 * turning into minutes of work in a request handler.
 */
const MIN_SAMPLES_PER_CLASS = 200;
const MAX_SAMPLES_PER_CLASS = 200_000;

/** 13 pairs x 6 + 78 suited x 4 + 78 offsuit x 12 = 1326. */
const TOTAL_COMBOS = 1326;

const EXPECTED_CLASS_COUNT = 169;

/**
 * Measures every class and returns them strongest first.
 *
 * Pure apart from the memo in `strengthTable()`: the result is a function of
 * `samplesPerClass` and `seed` alone, and the same arguments always give a
 * bit-identical table.
 */
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
    // The opponent's range is every hand EXCEPT the two cards hero holds. Passing
    // hero's cards as blockers is what makes "uniformly random" mean uniform over
    // the 1,225 combinations actually available, and it removes the need for the
    // sampler to reject illegal matchups — so every trial does useful work.
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

  // Strongest first. The tie-break on `canonicalIndex` is not decoration: two
  // classes CAN sample to the same equity, and a comparator that returns 0 would
  // leave their order up to the sort implementation. Breaking on the canonical
  // order (high card descending, then low card, suited before offsuit) makes the
  // ordering total and reproducible without relying on sort stability.
  measured.sort((a, b) =>
    b.equityVsRandom === a.equityVsRandom
      ? a.canonicalIndex - b.canonicalIndex
      : b.equityVsRandom - a.equityVsRandom,
  );

  const entries: HandClassStrength[] = [];
  let combosSoFar = 0;
  for (const [index, item] of measured.entries()) {
    // Weighted by combinations, NOT by class count. A pair is 6 of the 1,326
    // combinations and an offsuit class is 12, so the 169 labels are not equally
    // likely and treating them as if they were makes a top-percentage mean the wrong
    // thing. Concretely: 1% of the labels is AA alone, but AA is only 0.45% of the
    // hands you are actually dealt, so the top 1% of DEALS is AA, KK and QQ.
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
        'against a hand drawn uniformly from the 1,225 combinations hero does not hold.',
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
 * The default table, computed once per process.
 *
 * The rest of this package is pure in the strict sense — no cached state anywhere.
 * This one memo is the exception and it is worth being explicit about why it is
 * safe: `strengthTable()` takes no arguments, so it is a constant function, and the
 * cache can only ever hand back the value the call would have produced anyway. It
 * changes when the work happens, never what the answer is. The default table costs a
 * few seconds, `topPercentRange` needs it, and a request handler cannot afford to
 * rebuild it per call.
 *
 * Callers that want a table with different parameters call `computeStrengthTable`
 * directly and get no caching, which keeps the cache from ever being keyed on
 * something a caller could vary.
 */
let memoisedDefaultTable: StrengthTable | null = null;

export function strengthTable(): StrengthTable {
  memoisedDefaultTable ??= computeStrengthTable();
  return memoisedDefaultTable;
}

/**
 * The strongest classes covering at least `percent` of all dealt hands.
 *
 * Classes are taken in rank order until the cumulative share reaches the target,
 * *including* the class that crosses it — so the returned range covers at least the
 * requested share rather than stopping just short of it. Because the classes come in
 * lumps of 6, 4 or 12 combinations, an exact hit is usually impossible; the range's
 * own `fractionOfAllHands` reports what was actually covered.
 *
 * The result is built by handing the labels to `parseRange`, so range construction
 * has exactly one code path. A second builder that assembled combinations directly
 * would be one more place for a blocker bug or a combination-count bug to hide.
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
