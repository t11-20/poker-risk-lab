/**
 * Who did what on the street, as one short line for the decision band.
 *
 * ## The defect this exists for
 *
 * The plates say what each seat did (`seat-actions.ts`), and at the moment a decision is the
 * reader's most of the plates are off the screen. Measured on the live table at 6b3886e, opponent
 * plates fully visible between the header and the action row at the reader's decision: 2 of 4 or 2
 * of 5 at 1440x900, with "Calling Station: bet 16" at viewport y -147; 1 of 5 at 390x844, with "to
 * continue 78 units" on screen and no bettor in sight; 0 of 2 at a private table. The reader had to
 * scroll away from the buttons, while their clock ran, to find out who had bet.
 *
 * ## And the action that closes a street
 *
 * The plates start every street blank, because a plate that said "called 10" on the turn about a
 * preflop call would describe a price that no longer exists. The cost was that the call or the bet
 * that CLOSED a street was on screen for about 200ms — "called 20" for 207ms and "called 186" for
 * 823ms, against a median of 2.0-4.7s for every other chip (audit at 6b3886e, minor 2). So until
 * somebody acts on the new street this line goes on describing the one that just closed, and says
 * which street that was. The plates are unchanged: their rule is right for a plate.
 *
 * ## The amounts are rebuilt from the log
 *
 * A call is worded with what the seat had in front of it afterwards (see `seat-actions.ts` for why
 * that and neither the chips moved nor the bet level). The plates read that off the seat, which is
 * only right for the street in progress: on the turn every `committedThisStreet` is 0, and the flop's
 * closing call would read "called 0". So it is summed from the log — the seat's blind if this is the
 * preflop (an ante is dead money and is not part of the street's commitment, as in the engine), plus
 * `amountPaid` for each of its actions on the street up to and including this one.
 *
 * Plain `.ts`, like `seat-actions.ts`, so `node --test` can import it without a JSX transform.
 */

import { actionWords } from './seat-actions.ts';
import type { PlayerView } from './view-types.ts';

type LoggedAction = PlayerView['actions'][number];
type BettingStreet = LoggedAction['street'];

/** At most this many actions are named; the line is a glance, not a hand history. */
export const STREET_SUMMARY_LIMIT = 3;

const STREET_NAME: Readonly<Record<BettingStreet, string>> = {
  preflop: 'Preflop',
  flop: 'On the flop',
  turn: 'On the turn',
  river: 'On the river',
};

const ORDER: readonly BettingStreet[] = ['preflop', 'flop', 'turn', 'river'];

export interface StreetSummary {
  /** "On the flop", "Preflop": which street the actions were taken on. */
  readonly label: string;
  /** False when the street in progress has no actions yet and these are the last street's. */
  readonly current: boolean;
  /** One phrase per action, oldest first: "Nit bet 16", "You called 16". */
  readonly actions: readonly string[];
  /** How many earlier actions on the same street were left out to keep the line short. */
  readonly earlier: number;
}

/**
 * The line for this view, or null when there is nothing to say: no actions yet in the hand, or a
 * hand that is over (the result says how it ended, and says it better).
 */
export function streetSummary(
  view: Pick<PlayerView, 'actions' | 'street' | 'seats' | 'forcedBets'>,
  seatNames: Readonly<Record<number, string>> = {},
): StreetSummary | null {
  const position = ORDER.indexOf(view.street as BettingStreet);
  if (position < 0) return null;

  // The street in progress if anybody has acted on it, otherwise the latest one somebody did.
  let street: BettingStreet | null = null;
  for (let index = position; index >= 0 && street === null; index -= 1) {
    const candidate = ORDER[index];
    if (candidate !== undefined && view.actions.some((entry) => entry.street === candidate))
      street = candidate;
  }
  if (street === null) return null;

  const onStreet = view.actions.filter((entry) => entry.street === street);
  const committed = new Map<number, number>();
  if (street === 'preflop') {
    for (const forced of view.forcedBets) {
      if (forced.kind === 'ante') continue;
      committed.set(forced.seat, (committed.get(forced.seat) ?? 0) + forced.amount);
    }
  }
  // The last action each seat took on this street: the only one an "all in" can be said of, since the
  // status it is read from is the seat's status now.
  const lastOf = new Map<number, LoggedAction>();
  for (const entry of onStreet) lastOf.set(entry.seat, entry);

  const phrases: string[] = [];
  for (const entry of onStreet) {
    const after = (committed.get(entry.seat) ?? 0) + entry.amountPaid;
    committed.set(entry.seat, after);
    const seat = view.seats.find((candidate) => candidate.seat === entry.seat);
    const allIn = lastOf.get(entry.seat) === entry && seat?.status === 'allIn';
    const words = actionWords(entry, after, allIn);
    if (words === '') continue;
    const who = seat?.isSelf === true ? 'You' : (seatNames[entry.seat] ?? `Seat ${String(entry.seat + 1)}`);
    phrases.push(`${who} ${words}`);
  }
  if (phrases.length === 0) return null;

  const shown = phrases.slice(-STREET_SUMMARY_LIMIT);
  return {
    label: STREET_NAME[street],
    current: street === view.street,
    actions: shown,
    earlier: phrases.length - shown.length,
  };
}
