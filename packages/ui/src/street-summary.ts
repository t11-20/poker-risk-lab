/**
 * Who did what on the street, as one line for the decision band, because at a decision most plates
 * are off screen (2 of 5 visible at 1440x900, 1 of 5 at 390x844).
 * Until somebody acts on a new street it describes the one that closed, which the blank plates
 * showed for only about 200ms.
 * Call amounts are summed from the log (blinds, not antes, plus `amountPaid`), because on a later
 * street every `committedThisStreet` is 0.
 */

import { actionWords } from './seat-actions.ts';
import type { PlayerView } from './view-types.ts';

type LoggedAction = PlayerView['actions'][number];
type BettingStreet = LoggedAction['street'];

/** The line is a glance, not a hand history. */
export const STREET_SUMMARY_LIMIT = 3;

const STREET_NAME: Readonly<Record<BettingStreet, string>> = {
  preflop: 'Preflop',
  flop: 'On the flop',
  turn: 'On the turn',
  river: 'On the river',
};

const ORDER: readonly BettingStreet[] = ['preflop', 'flop', 'turn', 'river'];

export interface StreetSummary {
  readonly label: string;
  /** False when the street in progress has no actions yet and these are the last street's. */
  readonly current: boolean;
  /** Oldest first: "Nit bet 16", "You called 16". */
  readonly actions: readonly string[];
  /** Earlier actions on the same street left out to keep the line short. */
  readonly earlier: number;
}

/** Null with no actions yet, or once the hand is over (the result says it better). */
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
  // Only a seat's last action can be called "all in", because the status is the seat's status now.
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
