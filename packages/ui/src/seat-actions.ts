/**
 * What each seat last did this street, as the few words its plate shows. Before this, the narration
 * reached only the 1x1 live region, and every opponent's plate read "in the hand" all preflop.
 * Derived from `PlayerView.actions`, so a reload draws the same words. Only the current street counts.
 * A call is worded with the seat's `committedThisStreet`, not `betLevelAfter`, because a short all-in
 * call matches less than the level (PR #27). Only the last action is labelled, so the figure is exact.
 */

import { formatChips } from './format.ts';
import type { PlayerView } from './view-types.ts';

type LoggedAction = PlayerView['actions'][number];
type SeatView = PlayerView['seats'][number];

/**
 * `committed` is what the seat had in front of it after the action. `allIn` says nothing is behind.
 * The caller supplies both. The plates read the seat, and `street-summary.ts` rebuilds them from the log.
 */
export function actionWords(entry: LoggedAction, committed: number, allIn: boolean): string {
  const { action } = entry;
  let words: string;
  switch (action.type) {
    case 'fold':
      words = 'folded';
      break;
    case 'check':
      words = 'checked';
      break;
    case 'call':
      // The seat's total, not the chips moved. A big blind completing pays 5 to call 10.
      words = `called ${formatChips(committed)}`;
      break;
    case 'bet':
      words = `bet ${formatChips(action.to)}`;
      break;
    case 'raise':
      words = `raised to ${formatChips(action.to)}`;
      break;
    default:
      words = '';
  }
  // Said, because it is why a call can be smaller than the price.
  const putChipsIn = action.type === 'call' || action.type === 'bet' || action.type === 'raise';
  if (putChipsIn && allIn) words = `${words}, all in`;
  // No cause named. `wasAutomatic` covers both a timeout and a stand-up fold, and only the
  // `seatTimedOut` event tells them apart, which is gone after a reload (PR #27).
  return entry.wasAutomatic && words !== '' ? `${words} by the server` : words;
}

function wordsFor(entry: LoggedAction, seat: SeatView | undefined): string {
  // The level only if the seat is somehow missing from the view.
  return actionWords(entry, seat?.committedThisStreet ?? entry.betLevelAfter, seat?.status === 'allIn');
}

/** Seat index to its last action this street. Seats that have not acted this street are absent. */
export function lastActionsThisStreet(
  view: Pick<PlayerView, 'actions' | 'street' | 'seats'>,
): Readonly<Record<number, string>> {
  // Last entry per seat first, because the seat's commitment describes only its last action.
  const last = new Map<number, LoggedAction>();
  for (const entry of view.actions) {
    if (entry.street === view.street) last.set(entry.seat, entry);
  }
  const out: Record<number, string> = {};
  for (const [index, entry] of last) {
    const words = wordsFor(
      entry,
      view.seats.find((seat) => seat.seat === index),
    );
    if (words !== '') out[index] = words;
  }
  return out;
}
