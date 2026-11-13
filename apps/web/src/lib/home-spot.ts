/**
 * The hand on the home page, priced from the deck on every render, never from a literal.
 * The opponent's hand is face up, so the equity is exact with no interval to explain.
 */

import { parseCards } from '@prl/poker-engine';
import { exactEquity, exactRange, potOdds } from '@prl/poker-math';

export interface HomeSpot {
  readonly yours: readonly number[];
  readonly theirs: readonly number[];
  readonly board: readonly number[];
  readonly pot: number;
  readonly toCall: number;
  /** Break-even share of the pot, 0..1. */
  readonly need: number;
  /** Exact equity, ties counted as half, 0..1. */
  readonly have: number;
  /** Outright wins and splits, 0..1. */
  readonly win: number;
  readonly tie: number;
  /** Turn-and-river runouts counted. */
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
