/**
 * The sentences a table's events are narrated in, for the screen reader and the "How the hand ended" list.
 * Every action names its player, using the name captured at the deal (the chair may change hands
 * between hands). A seat with no captured name counts from one, never zero.
 * Verbs come only from `NARRATED_VERBS` in `@prl/contracts`, because `inSecondPerson` on the page
 * matches the same table to say "You fold".
 */

import { ALL_THEY_HAD, NARRATED_VERBS, NOBODY_MATCHED, unmatchedPartOf } from '@prl/contracts';
import type {
  ForcedBet,
  HandResult,
  LoggedAction,
  PotAward,
  SeatIndex,
  SeatShowdown,
} from '@prl/poker-engine';

export type NameOf = (seat: SeatIndex) => string;

/** `en-GB` grouping ("1,529") to match the web client's `units()` in the same live region. */
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

/**
 * One sentence per award, with a side pot's unmatched part given back rather than won. That part is
 * not a pot either, so it does not turn "the pot" into "the main pot".
 */
export function awardSentences(result: Pick<HandResult, 'pots' | 'awards'>, nameOf: NameOf): string[] {
  const unmatched = new Map(result.pots.map((pot) => [pot.index, unmatchedPartOf(pot, result.pots)]));
  const potCount = result.pots.filter((pot) => pot.amount > (unmatched.get(pot.index) ?? 0)).length;
  const sentences: string[] = [];
  for (const award of result.awards) {
    const back = Math.min(award.amount, unmatched.get(award.potIndex) ?? 0);
    if (back > 0) {
      sentences.push(
        `${nameOf(award.seat)} ${NARRATED_VERBS.getBack.third} ${amount(back)} ${NOBODY_MATCHED}.`,
      );
    }
    if (award.amount > back)
      sentences.push(awardSentence({ ...award, amount: award.amount - back }, potCount, nameOf));
  }
  return sentences;
}

export const NO_CHIPS_CHANGED_HANDS = 'No chips changed hands.';
