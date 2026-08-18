/**
 * Positions, blinds and action order.
 *
 * Heads-up is not a special case bolted on — it is genuinely a different rule set,
 * and the difference is the single most common source of bugs in Hold'em engines:
 *
 *   3+ players:  small blind = button + 1, big blind = button + 2,
 *                first to act preflop = button + 3 (under the gun),
 *                first to act on every later street = button + 1.
 *
 *   heads-up:    the BUTTON posts the small blind and acts FIRST preflop,
 *                then acts LAST on the flop, turn and river.
 *
 * All seat arithmetic here works on occupied seats only, so a table with gaps
 * (seats 0, 2 and 5 occupied at a six-max table) behaves correctly.
 */

import type { SeatIndex, SeatState } from './types.ts';

export class PositionError extends Error {
  override readonly name = 'PositionError';
}

/** Common position labels, for teaching and for the UI. */
export type PositionLabel = 'BTN' | 'SB' | 'BB' | 'UTG' | 'UTG+1' | 'MP' | 'HJ' | 'CO' | 'BTN/SB';

/** Seats dealt into the hand, in ascending seat order. */
export function dealtSeats(seats: readonly SeatState[]): SeatIndex[] {
  return seats
    .filter((seat) => seat.status !== 'sittingOut')
    .map((seat) => seat.seat)
    .sort((a, b) => a - b);
}

/**
 * Occupied seats ordered clockwise starting at the seat AFTER `from`.
 *
 * `from` need not itself be occupied. When it IS occupied it comes back as the
 * LAST element: the walk runs a full lap (`step = 1..maxSeats`) and at
 * `step === maxSeats` the candidate is `(from + maxSeats) % maxSeats === from`.
 *
 * That is deliberate — "a full orbit starting after `from`" is what three callers
 * want, and all three are correct as written: ante posting and the hole-card deal
 * order must serve the button last, and `seatOrderFromButton` puts the button last
 * in the odd-chip queue. But it means the list is NOT "everyone except `from`", and
 * a caller that wants that must filter `from` out itself. `positionLabels` and
 * `playersLeftToAct` do exactly that.
 *
 * The previous version of this comment claimed `from` was excluded, which is the
 * root cause of the position-label bug fixed in `positionLabels` below.
 */
export function orderFrom(from: SeatIndex, maxSeats: number, occupied: readonly SeatIndex[]): SeatIndex[] {
  if (maxSeats <= 0) throw new PositionError('maxSeats must be positive');
  const out: SeatIndex[] = [];
  for (let step = 1; step <= maxSeats; step++) {
    const candidate = (from + step) % maxSeats;
    if (occupied.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** The next occupied seat clockwise from `from`, exclusive. */
export function nextOccupied(from: SeatIndex, maxSeats: number, occupied: readonly SeatIndex[]): SeatIndex {
  const [next] = orderFrom(from, maxSeats, occupied);
  if (next === undefined) throw new PositionError('no occupied seats');
  return next;
}

export interface BlindAssignment {
  readonly smallBlindSeat: SeatIndex;
  readonly bigBlindSeat: SeatIndex;
  readonly isHeadsUp: boolean;
}

export function assignBlinds(
  buttonSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): BlindAssignment {
  if (occupied.length < 2) throw new PositionError(`need at least 2 players, have ${occupied.length}`);
  if (!occupied.includes(buttonSeat)) {
    throw new PositionError(`button seat ${buttonSeat} is not occupied`);
  }

  if (occupied.length === 2) {
    // Heads-up: the button IS the small blind.
    const other = orderFrom(buttonSeat, maxSeats, occupied)[0];
    if (other === undefined) throw new PositionError('heads-up table has no second seat');
    return { smallBlindSeat: buttonSeat, bigBlindSeat: other, isHeadsUp: true };
  }

  const order = orderFrom(buttonSeat, maxSeats, occupied);
  const smallBlindSeat = order[0];
  const bigBlindSeat = order[1];
  if (smallBlindSeat === undefined || bigBlindSeat === undefined) {
    throw new PositionError('could not assign blinds');
  }
  return { smallBlindSeat, bigBlindSeat, isHeadsUp: false };
}

/**
 * First seat to act preflop: the seat after the big blind, which heads-up means
 * the button (the small blind).
 */
export function firstToActPreflop(
  buttonSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): SeatIndex {
  const { bigBlindSeat, isHeadsUp } = assignBlinds(buttonSeat, maxSeats, occupied);
  if (isHeadsUp) return buttonSeat;
  return nextOccupied(bigBlindSeat, maxSeats, occupied);
}

/**
 * First seat to act on the flop, turn and river: the first occupied seat left of
 * the button. Heads-up that is the big blind, which is the correct reversal.
 */
export function firstToActPostflop(
  buttonSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): SeatIndex {
  return nextOccupied(buttonSeat, maxSeats, occupied);
}

/**
 * Human-readable position labels, assigned from the button backwards so that the
 * names always mean the same thing relative to the blinds regardless of table size.
 *
 * Two anchors fix every name: UTG is always the first seat after the big blind, and
 * CO is always the last seat before the button. Everything in between is filled from
 * the button backwards, which is why a name like HJ appears only once the table is
 * big enough to need it. The complete maps (button at seat 0, no gaps) are:
 *
 *   2 handed:  BTN/SB, BB                          (the button IS the small blind)
 *   3 handed:  BTN, SB, BB
 *   4 handed:  BTN, SB, BB, CO
 *   5 handed:  BTN, SB, BB, UTG, CO
 *   6 handed:  BTN, SB, BB, UTG, HJ, CO
 */
export function positionLabels(
  buttonSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): Map<SeatIndex, PositionLabel> {
  const labels = new Map<SeatIndex, PositionLabel>();
  const { smallBlindSeat, bigBlindSeat, isHeadsUp } = assignBlinds(buttonSeat, maxSeats, occupied);

  if (isHeadsUp) {
    labels.set(buttonSeat, 'BTN/SB');
    labels.set(bigBlindSeat, 'BB');
    return labels;
  }

  labels.set(buttonSeat, 'BTN');
  labels.set(smallBlindSeat, 'SB');
  labels.set(bigBlindSeat, 'BB');

  // Remaining seats, from under the gun round to the cutoff.
  //
  // `orderFrom` walks a FULL orbit, so its output also contains the small blind, the
  // button, and (last of all) the big blind it started from. All three are already
  // labelled above, so all three must be filtered out. Filtering only the button —
  // the original bug — left SB and BB in the list, and since `labels.set` overwrites,
  // the small blind was relabelled 'UTG' or 'CO' and the big blind 'CO' or 'MP': at
  // three or more handed, 'SB' and 'BB' were never emitted at all.
  const rest = orderFrom(bigBlindSeat, maxSeats, occupied).filter(
    (seat) => seat !== buttonSeat && seat !== smallBlindSeat && seat !== bigBlindSeat,
  );
  const names: PositionLabel[] =
    rest.length === 1
      ? ['CO']
      : rest.length === 2
        ? ['UTG', 'CO']
        : rest.length === 3
          ? ['UTG', 'HJ', 'CO']
          : ['UTG', 'UTG+1', 'HJ', 'CO'];
  for (const [index, seat] of rest.entries()) {
    const name = names[index] ?? 'MP';
    labels.set(seat, name);
  }
  return labels;
}

/**
 * How many seats will act after this one on the current street, given who is
 * still in. This is the concrete meaning of "position": more players left to act
 * means more ways to be wrong.
 */
export function playersLeftToAct(
  seat: SeatIndex,
  maxSeats: number,
  activeSeats: readonly SeatIndex[],
): number {
  return orderFrom(seat, maxSeats, activeSeats).filter((candidate) => candidate !== seat).length;
}
