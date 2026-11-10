/**
 * The sentences a table's events are narrated in: the screen reader's whole account of a hand,
 * and the "How the hand ended" list under the table.
 *
 * ## The defect this module exists for
 *
 * `wireEvents` wrote these inline, for a log rather than a reader. An action was announced as its
 * verb alone, so a screen-reader user at a six-handed table heard "folds", "calls 10", "raises to
 * 40" and was never told by whom. `scripts/ax-assertions.test.mjs` carries the narration of a real
 * Chrome run, and its fold is recorded as the bare word `folds`. The blinds and the result named
 * seats by their zero-based index ("smallBlind 5 from seat 3", "seat 1 wins 35 from pot 0"), when
 * every seat number a learner sees anywhere else counts from one, and the seat plates name the
 * player rather than number them.
 *
 * ## Whose name
 *
 * The name of the player who was DEALT into that seat, captured at the deal. `table.ts` explains
 * why a seat index is not a person: between hands somebody stands and somebody else takes the
 * chair, and the current roster would then put a newcomer's name on the previous player's fold.
 * A seat with no captured name is still counted from one, never from zero.
 */

import type { ForcedBet, LoggedAction, PotAward, SeatIndex, SeatShowdown } from '@prl/poker-engine';

export type NameOf = (seat: SeatIndex) => string;

/** A name lookup over the dealt roster, falling back to the seat's one-based number. */
export function namesFrom(names: ReadonlyMap<SeatIndex, string>): NameOf {
  return (seat) => names.get(seat) ?? `Seat ${String(seat + 1)}`;
}

const FORCED_BET: Readonly<Record<ForcedBet['kind'], string>> = {
  ante: 'an ante',
  smallBlind: 'the small blind',
  bigBlind: 'the big blind',
};

export function forcedBetsSentence(bets: readonly ForcedBet[], nameOf: NameOf): string {
  if (bets.length === 0) return 'No forced bets.';
  return bets
    .map(
      (bet) =>
        `${nameOf(bet.seat)} posts ${FORCED_BET[bet.kind]}, ${String(bet.amount)}` +
        `${bet.wasShort ? ', which is all they had' : ''}.`,
    )
    .join(' ');
}

export function actionSentence(logged: LoggedAction, nameOf: NameOf): string {
  return `${nameOf(logged.seat)} ${verbOf(logged)}`;
}

function verbOf(logged: LoggedAction): string {
  const action = logged.action;
  switch (action.type) {
    case 'fold':
      return 'folds';
    case 'check':
      return 'checks';
    case 'call':
      return `calls ${String(logged.amountPaid)}`;
    case 'bet':
      return `bets to ${String(action.to)}`;
    case 'raise':
      return `raises to ${String(action.to)}`;
    default:
      return 'acts';
  }
}

export function showdownSentence(showdown: SeatShowdown, nameOf: NameOf): string {
  return `${nameOf(showdown.seat)} shows ${showdown.description}.`;
}

/** `potCount` decides whether pot 0 is "the pot" or "the main pot": a main pot implies a side one. */
export function awardSentence(award: PotAward, potCount: number, nameOf: NameOf): string {
  const pot =
    potCount <= 1 ? 'the pot' : award.potIndex === 0 ? 'the main pot' : `side pot ${award.potIndex}`;
  return `${nameOf(award.seat)} wins ${String(award.amount)} from ${pot}${award.wasSplit ? ', split' : ''}.`;
}

export const NO_CHIPS_CHANGED_HANDS = 'No chips changed hands.';
