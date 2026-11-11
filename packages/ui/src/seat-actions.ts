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
 * Plain `.ts` rather than inside `Seat.tsx` so `node --test` can import it without a JSX transform.
 */

import { formatChips } from './format.ts';
import type { PlayerView } from './view-types.ts';

type LoggedAction = PlayerView['actions'][number];

function wordsFor(entry: LoggedAction): string {
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
      // The level matched, not the chips moved: a big blind completing pays 5 to call 10, and
      // "called 5" would contradict the price everybody else at the table just saw.
      words = `called ${formatChips(entry.betLevelAfter)}`;
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
  // A timeout is the server's act, not the player's, and the plate says so — it is the only
  // visible trace of a clock running out at somebody else's seat.
  return entry.wasAutomatic && words !== '' ? `${words}, timed out` : words;
}

/** Seat index to its last action this street. Seats that have not acted this street are absent. */
export function lastActionsThisStreet(
  view: Pick<PlayerView, 'actions' | 'street'>,
): Readonly<Record<number, string>> {
  const out: Record<number, string> = {};
  for (const entry of view.actions) {
    if (entry.street !== view.street) continue;
    const words = wordsFor(entry);
    if (words !== '') out[entry.seat] = words;
  }
  return out;
}
