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
 *
 * ## Whose verbs
 *
 * `NARRATED_VERBS` in `@prl/contracts`, and only those. Every sentence here is broadcast to every
 * socket in the room, so the reader hears their own hand under their dealt name; the page puts the
 * sentences that open on that name into the second person ("You fold", "You win 1,529 from the pot.")
 * with `inSecondPerson`, which reads the same table. A verb written here as a literal would be one
 * the page cannot recognise, and the reader would be named in the third person again.
 */

import { ALL_THEY_HAD, NARRATED_VERBS } from '@prl/contracts';
import type { ForcedBet, LoggedAction, PotAward, SeatIndex, SeatShowdown } from '@prl/poker-engine';

export type NameOf = (seat: SeatIndex) => string;

/**
 * An amount as a reader sees it, grouped.
 *
 * These were `String(amount)`, so the result line under the table read "Patient Technician 1 wins
 * 1529 from the pot." and "Disciplined Specialist wins 1975 from the main pot." (audit at 308fadf,
 * both from the socket log), beside seat plates and a pot that `formatUnits` in `@prl/ui` prints
 * grouped. `en-GB` because that is the grouping the web client's own `units()` uses for the
 * sentences it writes into the same live region, so one announcement cannot mix "1,529" and "1529".
 */
const GROUPED = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function amount(value: number): string {
  return GROUPED.format(value);
}

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
        `${nameOf(bet.seat)} ${NARRATED_VERBS.post.third} ${FORCED_BET[bet.kind]}, ${amount(bet.amount)}` +
        `${bet.wasShort ? `, ${ALL_THEY_HAD.third}` : ''}.`,
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
      return NARRATED_VERBS.fold.third;
    case 'check':
      return NARRATED_VERBS.check.third;
    case 'call':
      return `${NARRATED_VERBS.call.third} ${amount(logged.amountPaid)}`;
    case 'bet':
      return `${NARRATED_VERBS.bet.third} ${amount(action.to)}`;
    case 'raise':
      return `${NARRATED_VERBS.raise.third} ${amount(action.to)}`;
    default:
      return NARRATED_VERBS.act.third;
  }
}

export function showdownSentence(showdown: SeatShowdown, nameOf: NameOf): string {
  return `${nameOf(showdown.seat)} ${NARRATED_VERBS.show.third} ${showdown.description}.`;
}

/** `potCount` decides whether pot 0 is "the pot" or "the main pot": a main pot implies a side one. */
export function awardSentence(award: PotAward, potCount: number, nameOf: NameOf): string {
  const pot =
    potCount <= 1 ? 'the pot' : award.potIndex === 0 ? 'the main pot' : `side pot ${award.potIndex}`;
  return `${nameOf(award.seat)} ${NARRATED_VERBS.win.third} ${amount(award.amount)} from ${pot}${award.wasSplit ? ', split' : ''}.`;
}

export const NO_CHIPS_CHANGED_HANDS = 'No chips changed hands.';
