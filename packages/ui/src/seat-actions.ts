/**
 * What each seat last did on the street being played, as the few words its plate shows.
 *
 * ## The defect this exists for
 *
 * The server narrates every action — "Patient Technician 1 raises to 124" — and that sentence went
 * to exactly one place: the table's polite live region, which is a 1x1 box. A seat plate showed only
 * the seat's STATUS ("in the hand", "folded", "all in"), so a sighted reader watching five bots act
 * saw stacks change and chips move with nothing saying who raised, who called, or what the price in
 * front of them was made of. Measured on the live table: every opponent read "in the hand" through a
 * whole preflop of two calls and a raise.
 *
 * ## Where it comes from
 *
 * `PlayerView.actions`, the hand's own public action log, which every `state` frame already carries
 * whole — so this is derived from data the client has, never guessed, and a reload draws the same
 * words. Only the street in progress counts: the log keeps earlier streets (a turn frame still holds
 * the preflop calls), and a plate that said "called 10" on the turn about a preflop call would be
 * describing a price that no longer exists. A new street therefore starts every plate blank again.
 *
 * ## The amount on a call is the seat's own commitment
 *
 * Read off the seat (`committedThisStreet`), not off the log's `betLevelAfter`. The engine keeps the
 * bet level where it was when a caller commits less than it (`applyAction` in
 * `packages/poker-engine/src/machine.ts`: `betLevel = max(state.betLevel, committedThisStreet)`), so
 * the level is the price, not what this seat matched. Labelled from the level, a 30-unit stack
 * calling a 100 raise read "called 100" on the plate of a seat with 30 in front of it. Found in
 * review on PR #27. Only a seat's LAST action this street is labelled, and nothing but its own
 * actions moves its commitment within a street, so the seat's current figure is exactly what that
 * action left it at.
 *
 * Plain `.ts` rather than inside `Seat.tsx` so `node --test` can import it without a JSX transform.
 */

import { formatChips } from './format.ts';
import type { PlayerView } from './view-types.ts';

type LoggedAction = PlayerView['actions'][number];
type SeatView = PlayerView['seats'][number];

/**
 * The words for one logged action.
 *
 * `committed` is what the seat had in front of it on that street once the action was taken, and it
 * is the amount a call is worded with; `allIn` says the action left the seat with nothing behind.
 * The caller supplies both because only the caller knows which street it is describing: the plates
 * read them off the seat, which is right for the street in progress, and `street-summary.ts` rebuilds
 * them from the log, which is right for any street.
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
      // What the seat now has in front of it, not the chips this action moved: a big blind
      // completing pays 5 to call 10, and "called 5" would contradict the price everybody else at
      // the table just saw. Not the bet level either: a short all-in call matches less than the
      // level (see the header).
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
  // Said, because it is why a call can be smaller than the price: the seat had nothing more to put in.
  const putChipsIn = action.type === 'call' || action.type === 'bet' || action.type === 'raise';
  if (putChipsIn && allIn) words = `${words}, all in`;
  // The server's act, not the player's, and the plate says so — without naming a cause, because the
  // log cannot. `wasAutomatic` is set both for a clock that ran out and for the fold the server makes
  // for a seat whose player stood up mid-hand (`runAutomaticActions` in `apps/api/src/rooms/table.ts`),
  // and this said "folded, timed out" about a reader who had pressed "Stand up" (review on PR #27).
  // Only the `seatTimedOut` event tells the two apart, and a plate drawn from the view must read the
  // same after a reload, when no event is there to ask. The narration and the reader's own notice,
  // which do see the events, say "the clock ran out" when it did.
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
  // The last entry per seat first, then its words: the seat's commitment describes only its last
  // action, so an earlier one must never be worded from it.
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
