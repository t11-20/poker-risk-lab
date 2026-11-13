/**
 * The hand on the home page: one call, priced.
 *
 * The figures are computed here, from the deck, every time the page renders — the same promise the
 * rest of the product makes ("nothing is looked up"), kept on the one page a visitor reads before
 * deciding whether to believe it. A home page that printed "you have 41%" as a literal would be
 * the exact hard-coded odds table the product says it does not contain.
 *
 * The opponent's hand is face up because the example is about the price, not about reading a
 * range: with both hands known the equity is exact, with no interval to explain before the reader
 * has met the word "equity".
 */

import { parseCards } from '@prl/poker-engine';
import { exactEquity, exactRange, potOdds } from '@prl/poker-math';

export interface HomeSpot {
  readonly yours: readonly number[];
  readonly theirs: readonly number[];
  readonly board: readonly number[];
  /** Chips in the middle before your call. */
  readonly pot: number;
  readonly toCall: number;
  /** The share of the pot the call must win back to break even, 0..1. */
  readonly need: number;
  /** Your exact equity from here — wins, plus ties counted as half — 0..1. */
  readonly have: number;
  /** The share of runouts you win outright, and the share you split, 0..1. */
  readonly win: number;
  readonly tie: number;
  /** How many turn-and-river runouts the equity was counted over. */
  readonly runouts: number;
}

const YOURS = 'As Js';
const THEIRS = 'Kh Qc';
const BOARD = 'Ks 7d 2s';
const POT = 120;
const TO_CALL = 40;

export function homeSpot(): HomeSpot {
  const yours = parseCards(YOURS);
  const theirs = parseCards(THEIRS);
  const board = parseCards(BOARD);
  const result = exactEquity({
    players: [
      { label: 'you', range: exactRange(yours) },
      { label: 'them', range: exactRange(theirs) },
    ],
    board,
  });
  const you = result.players[0];
  if (you === undefined) throw new Error('home spot: the equity result has no first player');
  return {
    yours,
    theirs,
    board,
    pot: POT,
    toCall: TO_CALL,
    need: potOdds(POT, TO_CALL).breakEvenEquity,
    have: you.equity,
    win: you.win,
    tie: you.tie,
    runouts: result.trials,
  };
}
