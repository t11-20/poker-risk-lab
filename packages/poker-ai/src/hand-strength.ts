/**
 * How a policy reads its own hand, cheaply enough to do it inside a live hand.
 *
 * ## Why this file is separate from the policy, and why it is allowed to be coarse
 *
 * A policy runs several times per street at a table where a bot action has to land in tens
 * of milliseconds. Exact enumeration of a hand against a range is the honest calculation and
 * it is what the Coach shows a learner, but it is 10^5 to 10^11 hand evaluations
 * (`@prl/poker-math/equity`), which is a Coach panel's budget and not a decision's. So this
 * module answers the same questions with two bounded methods, and every result says which
 * one it used and how many samples were behind it. A number without its method is a claim,
 * not a result.
 *
 * Nothing here calls `equity()` (which may fall through to exact enumeration), `exactEquity`
 * or `computeOuts`. `computeOuts` is the honest out count and it runs a fresh equity
 * calculation for each of the ~45 cards that can come — perfect for the Coach, ruinous
 * inside a decision loop. The cheap substitute below is named for what it actually counts.
 *
 * ## Preflop: the computed 169-class table, not a chart
 *
 * `strengthTable()` from `@prl/poker-math/hand-ranking` measures every starting-hand class
 * by one narrow question — all-in, heads-up, against a hand drawn uniformly from the rest of
 * the deck — and it is *computed*, so its provenance can be shown to a learner. A published
 * preflop chart would be somebody else's material with numbers nobody here can check.
 *
 * That table costs a few seconds to build and is memoised once per process by the maths
 * package. This module adds a second, tiny memo: a label to entry map, so a preflop
 * assessment is a hash lookup rather than a 169-entry scan on every decision.
 *
 * ## The opponent-count scaling IS an approximation, and here is its measured error
 *
 * The table's figure is heads-up. Against `n` opponents this module uses
 *
 *     equity(n) = 1/(n+1) x (2 x equityHeadsUp) ^ (n ^ 0.4)
 *
 * which has three properties worth stating. At `n = 1` the exponent is exactly 1 and the
 * formula returns the table's figure unchanged, so heads-up is not approximated at all. A
 * hand with 50% heads-up equity maps to exactly `1/(n+1)`, the fair share, for every `n`. And
 * it is monotone in the heads-up figure, so it never reorders two hands.
 *
 * It is still an approximation, and the error is not uniform. Checked against 40,000-sample
 * Monte Carlo (seed 4242) over 18 representative classes at two to five opponents: mean
 * absolute error 2.3 percentage points, worst case 6.9 points. The direction is systematic
 * and worth knowing: it **overrates medium pairs** multiway (88 against five opponents comes
 * out 30.8% against a true 23.9%, because a coin-flip hand loses value fast as opponents are
 * added) and **underrates the biggest pairs and suited connectors** (AA against three
 * opponents comes out 57.0% against a true 63.6%; 76s runs about 4 points low). Multiway
 * equity is not a one-parameter function of heads-up equity, and no single exponent will make
 * it one.
 *
 * The policy's preflop *entry* decision does not depend on this number at all — it thresholds
 * `preflopClassPercentile`, which comes straight from the table's ranks and carries no
 * multiway approximation. The scaled equity is used for price comparisons, where a 2 to 7
 * point error is smaller than the difficulty noise the policy adds on purpose.
 *
 * ## Postflop: bounded Monte Carlo with an injected seed
 *
 * `monteCarloEquity` takes a seed, not a generator, so `assessPostflop` draws ONE integer
 * from the injected `RandomSource` and hands it over. Same policy input plus same seed gives
 * the same assessment, which is what makes a hand replayable; different seeds give slightly
 * different assessments, which is the sampling error that ADR 0012 and `docs/AI-LEGENDS.md`
 * L8 name and accept rather than hide. The sample count is clamped to a live-hand budget and
 * the number actually run is reported, so a clamp shows up in the output instead of being
 * silent.
 *
 * ## Two fields whose names would otherwise mislead
 *
 * **`outs` counts category improvements, not clean outs.** An unseen card is counted when it
 * lifts the model's own made-hand category. It does not check whether the improved hand
 * wins: the king that pairs an ace-high holding also hands a king-high range trips, and it is
 * counted here anyway. Dirty outs are a real distinction and `computeOuts` draws it properly;
 * this count exists to tell a made hand from a drawing one, and the policy never prices a
 * call off it. The price comes from `equity`.
 *
 * **`relativeStrength` is a percentile, and which population it is measured against depends
 * on the street.** Preflop it is measured within the range the model would continue with,
 * which is what "how strong is this hand for a style that plays this many hands" means.
 * Postflop the model's own continuing range is not in this function's input, so it is
 * measured against the assumed opponent continuing range: the share of the hands actually in
 * front of it that its current made hand beats at showdown, ties counted half. Both are
 * stated on the field. A single number silently swapping populations between streets would be
 * the kind of defect that survives review, so it is written down twice.
 */

import {
  type Card,
  categoryOf,
  evaluate,
  HAND_CATEGORY,
  type RandomSource,
  remainingDeck,
} from '@prl/poker-engine';
import {
  type Combo,
  classOfCombo,
  exactRange,
  type HandClassStrength,
  monteCarloEquity,
  type ParsedRange,
  strengthTable,
} from '@prl/poker-math';
import type { Traits } from './traits.ts';

export class HandStrengthError extends Error {
  override readonly name = 'HandStrengthError';
}

export interface StrengthAssessment {
  /** 0..1 equity against the assumed opponent range. */
  readonly equity: number;
  /**
   * 0..1 percentile. Preflop: within the range this profile would continue with, so 0 means
   * "outside that range" and 1 means "the top of it". Postflop: the share of the assumed
   * opponent continuing range that this holding currently beats at showdown, ties counted as
   * half. See the module comment for why the population changes with the street.
   */
  readonly relativeStrength: number;
  /** True when the hand is mostly drawing rather than made. Always false preflop. */
  readonly isDraw: boolean;
  /**
   * Cards still to come that would lift the made-hand CATEGORY. Not clean outs — see the
   * module comment. 0 preflop and on the river, where there is nothing to count.
   */
  readonly outs: number;
  /** `HAND_CATEGORY` value of the current made hand, or null when no board is out yet. */
  readonly madeHandCategory: number | null;
  readonly method: 'preflop-table' | 'monte-carlo';
  /** Samples behind `equity`: the table's per-class count, or the trials actually run. */
  readonly samples: number;
}

/** What the computed table says about one starting-hand class, with no scaling applied. */
export interface PreflopClassStrength {
  /** Canonical class label: "AA", "AKs", "72o". */
  readonly label: string;
  /** 1 = strongest of the 169 classes. */
  readonly rank: number;
  /** Heads-up pot share all-in against a uniformly random hand. */
  readonly equityVsRandom: number;
  /**
   * Share of all 1,326 dealt combinations this class is at least as strong as, 0..1.
   * Combination-weighted, so 0.9955 for AA means "stronger than 99.55% of hands dealt",
   * not "stronger than 99.55% of the 169 labels".
   */
  readonly percentileAmongAllHands: number;
}

/**
 * Sample bounds for a live decision.
 *
 * The ceiling is the `expert` difficulty's budget from `DIFFICULTY_SETTINGS`. A caller asking
 * for more is asking to spend a latency budget that is not theirs to spend, so the request is
 * clamped and the clamped figure is reported in `samples`. The floor keeps an assessment from
 * being so noisy that the action it produces is effectively a coin toss dressed up as a read.
 */
const MIN_POSTFLOP_SAMPLES = 200;
const MAX_POSTFLOP_SAMPLES = 12_000;

/** `monteCarloEquity` wants an integer seed; this is the largest one worth drawing. */
const MAX_SEED = 2 ** 31 - 1;

/** The exponent in the opponent-count scaling. See the module comment for its measured error. */
const MULTIWAY_EXPONENT = 0.4;

/** Equity is never reported as certain either way: a bounded estimate cannot support that. */
const MIN_EQUITY = 0.001;
const MAX_EQUITY = 0.999;

/**
 * How far equity has to exceed the current made-hand standing before the hand counts as
 * drawing. Eight points is wide enough that ordinary sampling noise at 200 samples (a half
 * width of about 3.5 points) does not flip the flag on its own.
 */
const DRAW_EQUITY_MARGIN = 0.08;

/** A draw needs somewhere to go: fewer than three improving cards is not a draw. */
const MIN_DRAW_OUTS = 3;

// ---------------------------------------------------------------------------
// The preflop table, and the one memo this module keeps
// ---------------------------------------------------------------------------

/**
 * Label to entry, built once.
 *
 * `strengthTable()` is already memoised in the maths package, so this cache changes neither
 * the answer nor when the table is computed — it only turns a 169-entry linear scan into a
 * hash lookup, which matters because a six-max hand asks for one on every preflop decision.
 */
let memoisedByLabel: Map<string, HandClassStrength> | null = null;

function tableByLabel(): Map<string, HandClassStrength> {
  if (memoisedByLabel === null) {
    const built = new Map<string, HandClassStrength>();
    for (const entry of strengthTable().entries) built.set(entry.label, entry);
    memoisedByLabel = built;
  }
  return memoisedByLabel;
}

function requireTwoCards(cards: readonly Card[], where: string): Combo {
  if (cards.length !== 2) {
    throw new HandStrengthError(`${where} needs exactly 2 hole cards, received ${cards.length}`);
  }
  const [first, second] = cards;
  if (first === undefined || second === undefined) {
    throw new HandStrengthError(`${where} received a hole card list with a hole in it`);
  }
  if (first === second) {
    throw new HandStrengthError(`${where} received the same card twice (${first})`);
  }
  return [first, second] as const;
}

/**
 * What the computed table says about this holding, before any style or opponent count enters.
 *
 * Separate from `assessPreflop` because the policy needs the unscaled, un-styled percentile:
 * it is what the declared `vpip` is a threshold on, and mixing a style's own range width into
 * it would make the entry frequency depend on itself.
 */
export function preflopClassPercentile(holeCards: readonly Card[]): PreflopClassStrength {
  const combo = requireTwoCards(holeCards, 'preflopClassPercentile');
  const label = classOfCombo(combo).label;
  const entry = tableByLabel().get(label);
  if (entry === undefined) {
    throw new HandStrengthError(`the strength table has no entry for class "${label}"`);
  }
  return {
    label,
    rank: entry.rank,
    equityVsRandom: entry.equityVsRandom,
    // `cumulativePercent` counts this class and every stronger one, so the share of hands
    // this class beats is what is left below it.
    percentileAmongAllHands: clamp01(1 - entry.cumulativePercent / 100),
  };
}

/**
 * Equity against `opponents` hands drawn uniformly at random.
 *
 * An approximation, with its measured error stated in the module comment. Exact at
 * `opponents === 1` by construction.
 */
export function scaleEquityForOpponents(headsUpEquity: number, opponents: number): number {
  if (!Number.isFinite(headsUpEquity) || headsUpEquity < 0 || headsUpEquity > 1) {
    throw new HandStrengthError(`headsUpEquity must be a probability in 0..1, received ${headsUpEquity}`);
  }
  if (!Number.isInteger(opponents) || opponents < 1) {
    throw new HandStrengthError(`opponents must be an integer of at least 1, received ${opponents}`);
  }
  if (opponents === 1) return clampEquity(headsUpEquity);
  const exponent = opponents ** MULTIWAY_EXPONENT;
  return clampEquity((1 / (opponents + 1)) * (2 * headsUpEquity) ** exponent);
}

/**
 * The preflop assessment.
 *
 * `traits` is used for exactly one thing: `traits.vpip` is the width of the range this style
 * would continue with, and `relativeStrength` is this holding's position inside that range.
 * A hand outside it reports 0 — the policy gates entry on `preflopClassPercentile`, which
 * keeps its resolution below the threshold, so nothing depends on resolution this field has
 * thrown away.
 *
 * @param opponents how many opponents are still to be beaten, at least 1
 */
export function assessPreflop(
  holeCards: readonly Card[],
  opponents: number,
  traits: Traits,
): StrengthAssessment {
  const combo = requireTwoCards(holeCards, 'assessPreflop');
  const table = strengthTable();
  const strength = preflopClassPercentile(combo);
  const width = clamp01(traits.vpip);

  // Position inside the continuing range: 0 at its bottom edge, 1 at the top of the deck.
  // A zero-width range would divide by zero; a style that plays nothing has no "inside".
  const relativeStrength = width <= 0 ? 0 : clamp01((strength.percentileAmongAllHands - (1 - width)) / width);

  return {
    equity: scaleEquityForOpponents(strength.equityVsRandom, opponents),
    relativeStrength,
    // Preflop every hand still needs five cards, so "drawing rather than made" does not yet
    // describe anything. The field is about a postflop hand whose value is in the cards to
    // come, and claiming it preflop would make it mean two things.
    isDraw: false,
    outs: 0,
    madeHandCategory: null,
    method: 'preflop-table',
    samples: table.samplesPerClass,
  };
}

// ---------------------------------------------------------------------------
// Postflop
// ---------------------------------------------------------------------------

export interface PostflopAssessmentInput {
  readonly holeCards: readonly Card[];
  /** 3, 4 or 5 community cards. */
  readonly board: readonly Card[];
  /** The range this policy assumes it is up against, blockers already removed. */
  readonly opponentRange: ParsedRange;
  /** Requested trials. Clamped to the live-hand budget; the result reports what was run. */
  readonly samples: number;
  /** Injected, never `Math.random`. One integer is drawn from it to seed the sampler. */
  readonly random: RandomSource;
}

export function assessPostflop(input: PostflopAssessmentInput): StrengthAssessment {
  const combo = requireTwoCards(input.holeCards, 'assessPostflop');
  const board = validateBoard(input.board, combo);
  const legalCombos = legalOpponentCombos(input.opponentRange, [...combo, ...board]);
  if (legalCombos.length === 0) {
    throw new HandStrengthError(
      `every combination in the assumed opponent range "${input.opponentRange.notation}" uses a card ` +
        'this seat can already see, so the range cannot exist behind the board — widen it',
    );
  }
  if (!Number.isFinite(input.samples) || input.samples <= 0) {
    throw new HandStrengthError(`samples must be a positive number, received ${input.samples}`);
  }

  const samples = Math.min(MAX_POSTFLOP_SAMPLES, Math.max(MIN_POSTFLOP_SAMPLES, Math.floor(input.samples)));
  const seed = input.random.nextInt(MAX_SEED);
  const result = monteCarloEquity(
    {
      players: [
        { label: 'this model', range: exactRange(combo) },
        { label: 'the assumed opponent continuing range', range: input.opponentRange },
      ],
      board,
    },
    { samples, seed },
  );
  const own = result.players[0];
  if (own === undefined) throw new HandStrengthError('the equity result carried no players');

  const heroScore = evaluate([...combo, ...board]);
  const standing = showdownStanding(heroScore, legalCombos, board);
  const category = categoryOf(heroScore);
  const outs = board.length === 5 ? 0 : countCategoryImprovements(combo, board, category);
  const equity = clampEquity(own.equity);

  return {
    equity,
    relativeStrength: standing,
    // Drawing means three things at once, and all three have to hold: there is a card to
    // come, the made hand is no better than one pair, and the equity is materially above
    // what the hand is worth at showdown right now. The third clause is what separates a
    // draw from a weak made hand that is simply behind.
    isDraw:
      board.length < 5 &&
      category <= HAND_CATEGORY.pair &&
      outs >= MIN_DRAW_OUTS &&
      equity > standing + DRAW_EQUITY_MARGIN,
    outs,
    madeHandCategory: category,
    method: 'monte-carlo',
    samples: result.trials,
  };
}

function validateBoard(board: readonly Card[], combo: Combo): readonly Card[] {
  if (board.length !== 3 && board.length !== 4 && board.length !== 5) {
    throw new HandStrengthError(
      `assessPostflop needs a board of 3, 4 or 5 cards, received ${board.length}. Preflop is ` +
        'assessPreflop, which uses the computed class table instead of sampling.',
    );
  }
  const seen = new Set<Card>(board);
  if (seen.size !== board.length) {
    throw new HandStrengthError('the board contains a duplicate card');
  }
  if (seen.has(combo[0]) || seen.has(combo[1])) {
    throw new HandStrengthError('a hole card also appears on the board');
  }
  return board;
}

/** Range combinations that can still exist behind the cards this seat can see. */
function legalOpponentCombos(range: ParsedRange, known: readonly Card[]): readonly Combo[] {
  const blocked = new Set<Card>(known);
  const out: Combo[] = [];
  for (const combo of range.combos) {
    if (blocked.has(combo[0]) || blocked.has(combo[1])) continue;
    out.push(combo);
  }
  return out;
}

/**
 * The share of the range in front of this hand that it currently beats, ties counted half.
 *
 * One `evaluate` per combination — a few hundred integer evaluations, which is the reason
 * this can run inside a decision while an equity enumeration cannot. It is deliberately a
 * *showdown-now* figure: it ignores the cards to come, which is exactly what makes it
 * complementary to `equity` and what makes the two together able to spot a draw.
 */
function showdownStanding(heroScore: number, combos: readonly Combo[], board: readonly Card[]): number {
  let beaten = 0;
  let tied = 0;
  for (const combo of combos) {
    const score = evaluate([combo[0], combo[1], ...board]);
    if (heroScore > score) beaten += 1;
    else if (heroScore === score) tied += 1;
  }
  return clamp01((beaten + tied / 2) / combos.length);
}

/**
 * Unseen cards that would lift the made-hand category.
 *
 * Counts self-improvement only, and says so on the field it fills. It does not ask whether
 * the improved hand wins, and it does not count improvement *within* a category — a card
 * that turns top pair into a better two pair counts, a card that only improves a kicker does
 * not. Both limits are deliberate: this is the cheap test that tells a draw from a made
 * hand, not a substitute for `computeOuts`.
 */
function countCategoryImprovements(combo: Combo, board: readonly Card[], currentCategory: number): number {
  const known: Card[] = [...combo, ...board];
  let improving = 0;
  for (const card of remainingDeck(known)) {
    if (categoryOf(evaluate([...known, card])) > currentCategory) improving += 1;
  }
  return improving;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Equity is bounded away from 0 and 1: a sampled estimate cannot support certainty. */
function clampEquity(value: number): number {
  if (!Number.isFinite(value)) {
    throw new HandStrengthError(`equity came back non-finite (${value})`);
  }
  return Math.min(MAX_EQUITY, Math.max(MIN_EQUITY, value));
}
