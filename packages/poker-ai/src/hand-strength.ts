/**
 * How a policy reads its own hand cheaply enough to run inside a live hand.
 *
 * Exact enumeration costs 10^5 to 10^11 evaluations, so nothing here calls `equity()`, `exactEquity`
 * or `computeOuts`. Every result reports its method and sample count.
 *
 * Preflop uses the computed 169-class `strengthTable()`. Against `n` opponents equity is scaled by
 * `1/(n+1) x (2 x equityHeadsUp) ^ (n ^ 0.4)`, exact at n = 1. Measured against 40,000-sample Monte
 * Carlo (seed 4242, 18 classes, 2 to 5 opponents) gives mean error 2.3 points, worst 6.9. It overrates
 * medium pairs multiway and underrates big pairs and suited connectors. Entry decisions use
 * `preflopClassPercentile`, which has no scaling. The scaled figure only feeds price comparisons.
 *
 * Postflop draws one seed from the injected `RandomSource` for `monteCarloEquity`, so a hand replays.
 * `outs` counts category improvements, not clean outs. `relativeStrength` is measured within the
 * model's continuing range preflop and against the assumed opponent range postflop.
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
  /**
   * 0..1 percentile. Preflop, within the range this profile would continue with (0 means outside it).
   * Postflop, the share of the assumed opponent range this holding beats now, ties counted as half.
   */
  readonly relativeStrength: number;
  /** True when the hand is mostly drawing rather than made. Always false preflop. */
  readonly isDraw: boolean;
  /** Cards to come that would lift the made-hand category. Not clean outs. 0 preflop and on the river. */
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
  /** Combination-weighted share of all 1,326 dealt hands this class is at least as strong as, 0..1. */
  readonly percentileAmongAllHands: number;
}

/** Live-decision sample bounds. The ceiling is the `expert` budget. The floor keeps the read above noise. */
const MIN_POSTFLOP_SAMPLES = 200;
const MAX_POSTFLOP_SAMPLES = 12_000;

const MAX_SEED = 2 ** 31 - 1;

/** Measured error is in the module comment. */
const MULTIWAY_EXPONENT = 0.4;

/** Equity is never reported as certain either way: a bounded estimate cannot support that. */
const MIN_EQUITY = 0.001;
const MAX_EQUITY = 0.999;

/** Sampling half-width at 200 samples is about 3.5 points, so noise alone does not flip the draw flag. */
const DRAW_EQUITY_MARGIN = 0.08;

/** A draw needs somewhere to go: fewer than three improving cards is not a draw. */
const MIN_DRAW_OUTS = 3;

/** Label to entry, so a preflop decision is a hash lookup rather than a 169-entry scan. */
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
 * The unscaled, unstyled percentile. The declared `vpip` is a threshold on it, so mixing in the style's
 * own range width would make entry frequency depend on itself.
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
    percentileAmongAllHands: clamp01(1 - entry.cumulativePercent / 100),
  };
}

/** Equity against `opponents` uniformly random hands. An approximation, exact at `opponents === 1`. */
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
 * `traits.vpip` sets the continuing range width, and `relativeStrength` is the holding's position in
 * it. A hand outside the range reports 0.
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

  const relativeStrength = width <= 0 ? 0 : clamp01((strength.percentileAmongAllHands - (1 - width)) / width);

  return {
    equity: scaleEquityForOpponents(strength.equityVsRandom, opponents),
    relativeStrength,
    // Preflop every hand still needs five cards, so "drawing" does not describe anything yet.
    isDraw: false,
    outs: 0,
    madeHandCategory: null,
    method: 'preflop-table',
    samples: table.samplesPerClass,
  };
}

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
    // The equity margin over showdown standing is what separates a draw from a weak made hand.
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
 * The share of the range this hand beats at showdown now, ties counted half. One `evaluate` per
 * combination. It ignores cards to come, which is what lets it spot a draw next to `equity`.
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
 * Unseen cards that lift the made-hand category. It ignores whether the improved hand wins and
 * improvement within a category.
 */
function countCategoryImprovements(combo: Combo, board: readonly Card[], currentCategory: number): number {
  const known: Card[] = [...combo, ...board];
  let improving = 0;
  for (const card of remainingDeck(known)) {
    if (categoryOf(evaluate([...known, card])) > currentCategory) improving += 1;
  }
  return improving;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A sampled estimate cannot support certainty. */
function clampEquity(value: number): number {
  if (!Number.isFinite(value)) {
    throw new HandStrengthError(`equity came back non-finite (${value})`);
  }
  return Math.min(MAX_EQUITY, Math.max(MIN_EQUITY, value));
}
