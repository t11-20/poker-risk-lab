/**
 * The part of an opponent's range that continues against a bet, so a bet can be priced against the
 * hands that call it rather than against the whole range. Hands are ranked by how they stand on the
 * board, never against hero's cards, because an opponent decides from their own hand.
 */

import { allDistinct, type Card, evaluate } from '@prl/poker-engine';
import { strengthTable } from './hand-ranking.ts';
import { type Combo, classOfCombo, type ParsedRange } from './ranges.ts';

export class CallingRangeError extends Error {
  override readonly name = 'CallingRangeError';
}

/** A range's live combos, strongest first, each beside the strength it was ranked by. */
export interface BoardStrengthOrder {
  readonly source: ParsedRange;
  readonly combos: readonly Combo[];
  readonly strengths: readonly number[];
}

export interface ContinuingRange {
  /** The share of the live combos asked for, before ties at the boundary are added. */
  readonly share: number;
  readonly range: ParsedRange;
}

/**
 * After the flop the bots' continue rate stayed within 12 points of pot / (pot + risk / 2) from half the
 * pot to twice it, where the textbook pot / (pot + risk) ran up to 25 points low.
 */
const RISK_WEIGHT = 0.5;

/** `pot` is the contestable pot before hero acts, `risk` everything hero's line puts in, the call included. */
export function continuingShare(pot: number, risk: number): number {
  if (!Number.isFinite(pot) || pot <= 0) throw new CallingRangeError(`pot must be positive, received ${pot}`);
  if (!Number.isFinite(risk) || risk < 0) {
    throw new CallingRangeError(`risk must be zero or more, received ${risk}`);
  }
  return pot / (pot + RISK_WEIGHT * risk);
}

/**
 * Before the flop a hand's strength is its class's equity against a random hand. After it, the made
 * hand as the board stands, so a draw ranks by its high card.
 */
export function rankAgainstBoard(
  range: ParsedRange,
  board: readonly Card[],
  dead: readonly Card[],
): BoardStrengthOrder {
  if (!allDistinct([...board, ...dead])) {
    throw new CallingRangeError('the board and the dead cards must be distinct cards');
  }
  const seen = new Set<Card>([...board, ...dead]);
  const live = range.combos.filter((combo) => !seen.has(combo[0]) && !seen.has(combo[1]));
  if (live.length === 0) {
    throw new CallingRangeError(`every combination in "${range.notation}" uses a card already seen`);
  }
  const preflop = board.length === 0 ? new Map(strengthTable().entries.map((e) => [e.label, e])) : null;
  const strengthOf = (combo: Combo): number => {
    if (preflop === null) return evaluate([combo[0], combo[1], ...board]);
    const label = classOfCombo(combo).label;
    const entry = preflop.get(label);
    if (entry === undefined) throw new CallingRangeError(`the strength table has no class ${label}`);
    return entry.equityVsRandom;
  };
  const ranked = live
    .map((combo) => ({ combo, strength: strengthOf(combo) }))
    .sort((a, b) => b.strength - a.strength);
  return {
    source: range,
    combos: ranked.map((entry) => entry.combo),
    strengths: ranked.map((entry) => entry.strength),
  };
}

/**
 * The strongest share of the order, and every combo tied with the weakest of them, so the set never
 * depends on the order the range was written in. At least the strongest hand always continues.
 */
export function continuingRange(order: BoardStrengthOrder, pot: number, risk: number): ContinuingRange {
  const share = continuingShare(pot, risk);
  // 0.56 x 25 is 14.000000000000002, which would admit the next strength group. The share is above
  // zero, so the floor of 1 binds only when the share is under 1e-9 of a combo.
  const wanted = Math.max(1, Math.ceil(share * order.combos.length - 1e-9));
  const floor = order.strengths[wanted - 1];
  let count = wanted;
  while (count < order.combos.length && order.strengths[count] === floor) count += 1;
  const combos = order.combos.slice(0, count);
  const classes = [
    ...new Map(combos.map((combo) => [classOfCombo(combo).label, classOfCombo(combo)])).values(),
  ];
  return {
    share,
    range: {
      notation: `the strongest ${count} of ${order.combos.length} in ${order.source.notation}`,
      classes,
      combos,
      fractionOfAllHands: count / 1326,
    },
  };
}
