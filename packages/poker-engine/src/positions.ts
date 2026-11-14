/**
 * Positions, blinds and action order. Seat arithmetic uses occupied seats only, so gaps work.
 *
 *   3+ players:  SB = button + 1, BB = button + 2, first preflop = button + 3,
 *                first on later streets = button + 1.
 *   heads-up:    the button posts the small blind, acts first preflop and last after.
 *
 * Across hands the blinds follow the dead-button rule (`advanceBlindRotation`). The big blind
 * advances one live player per hand, the small blind falls where the big blind was, and the button
 * falls where the small blind was. Either may be dead (an empty chair). Deriving blinds from the
 * button instead charged six players the big blind twice in 40 hands
 * (`docs/audit/poker-correctness.md`, P1-1).
 */

import type { SeatIndex, SeatState } from './types.ts';

export class PositionError extends Error {
  override readonly name = 'PositionError';
}

export type PositionLabel = 'BTN' | 'SB' | 'BB' | 'UTG' | 'UTG+1' | 'MP' | 'HJ' | 'CO' | 'BTN/SB';

export function dealtSeats(seats: readonly SeatState[]): SeatIndex[] {
  return seats
    .filter((seat) => seat.status !== 'sittingOut')
    .map((seat) => seat.seat)
    .sort((a, b) => a - b);
}

/**
 * Occupied seats clockwise starting at the seat after `from`. A full lap, so an occupied `from`
 * comes back LAST. Callers that want "everyone except `from`" must filter it out themselves.
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
 * The three blind positions as seats, carried from one hand to the next. A position stays recorded
 * even when its chair is empty, or the rotation loses its place.
 */
export interface BlindPositions {
  readonly buttonSeat: SeatIndex;
  readonly smallBlindSeat: SeatIndex;
  readonly bigBlindSeat: SeatIndex;
}

export interface BlindRotation {
  readonly positions: BlindPositions;
  /** Where the button sits. Not necessarily occupied, see `buttonIsDead`. */
  readonly buttonSeat: SeatIndex;
  /** Who posts the small blind, or null when it is dead and nobody posts it. */
  readonly smallBlindSeat: SeatIndex | null;
  /** Who posts the big blind. Always a seat that is being dealt in. */
  readonly bigBlindSeat: SeatIndex;
  readonly dealtIn: readonly SeatIndex[];
  readonly buttonIsDead: boolean;
  readonly isHeadsUp: boolean;
}

/** The blinds for the first hand of a rotation. Every later hand goes through `advanceBlindRotation`. */
export function seedBlindRotation(
  buttonSeat: SeatIndex,
  maxSeats: number,
  dealtIn: readonly SeatIndex[],
): BlindRotation {
  const { smallBlindSeat, bigBlindSeat, isHeadsUp } = assignBlinds(buttonSeat, maxSeats, dealtIn);
  return {
    positions: { buttonSeat, smallBlindSeat, bigBlindSeat },
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    dealtIn: [...dealtIn].sort((a, b) => a - b),
    buttonIsDead: false,
    isHeadsUp,
  };
}

export interface AdvanceBlindRotationInput {
  readonly previous: BlindPositions;
  readonly maxSeats: number;
  /** Seats in the blind rotation, including players who still owe a blind. */
  readonly entrants: readonly SeatIndex[];
  /** Seats that owe a blind and are not dealt in yet. The big blind landing on one ends its wait. */
  readonly awaitingBigBlind?: readonly SeatIndex[];
}

/**
 * The next hand's blinds under the dead-button rule. The big blind advances first, then heads-up
 * gives the other seat both the button and the small blind. Shifting positions blindly would split
 * them across two players at a two-handed table.
 */
export function advanceBlindRotation(input: AdvanceBlindRotationInput): BlindRotation {
  const { previous, maxSeats, entrants } = input;
  if (entrants.length < 2) {
    throw new PositionError(`need at least 2 seats in the rotation, have ${entrants.length}`);
  }
  const bigBlindSeat = nextOccupied(previous.bigBlindSeat, maxSeats, entrants);

  const waiting = new Set(input.awaitingBigBlind ?? []);
  waiting.delete(bigBlindSeat);
  const dealtIn = entrants.filter((seat) => !waiting.has(seat)).sort((a, b) => a - b);
  if (dealtIn.length < 2) {
    throw new PositionError(`need at least 2 seats dealt in, have ${dealtIn.length}`);
  }

  if (dealtIn.length === 2) {
    const other = dealtIn.find((seat) => seat !== bigBlindSeat);
    if (other === undefined) throw new PositionError('heads-up rotation has no second seat');
    return {
      positions: { buttonSeat: other, smallBlindSeat: other, bigBlindSeat },
      buttonSeat: other,
      smallBlindSeat: other,
      bigBlindSeat,
      dealtIn,
      buttonIsDead: false,
      isHeadsUp: true,
    };
  }

  const smallBlindPosition = previous.bigBlindSeat;
  const buttonPosition = previous.smallBlindSeat;
  return {
    positions: { buttonSeat: buttonPosition, smallBlindSeat: smallBlindPosition, bigBlindSeat },
    buttonSeat: buttonPosition,
    // A dead small blind is not moved onto the next player, who paid it last hand.
    smallBlindSeat: dealtIn.includes(smallBlindPosition) ? smallBlindPosition : null,
    bigBlindSeat,
    dealtIn,
    buttonIsDead: !dealtIn.includes(buttonPosition),
    isHeadsUp: false,
  };
}

/**
 * First seat to act preflop, given where the big blind actually fell. With a dead button or dead
 * small blind, `button + 2` is not the big blind.
 */
export function firstToActPreflopFor(
  buttonSeat: SeatIndex,
  bigBlindSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): SeatIndex {
  // Heads-up the button is never dead, so this is an occupied seat.
  if (occupied.length === 2) return buttonSeat;
  return nextOccupied(bigBlindSeat, maxSeats, occupied);
}

/** First seat to act preflop. Heads-up that is the button (the small blind). */
export function firstToActPreflop(
  buttonSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): SeatIndex {
  const { bigBlindSeat } = assignBlinds(buttonSeat, maxSeats, occupied);
  return firstToActPreflopFor(buttonSeat, bigBlindSeat, maxSeats, occupied);
}

/** First seat to act after the flop. Heads-up that is the big blind. */
export function firstToActPostflop(
  buttonSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): SeatIndex {
  return nextOccupied(buttonSeat, maxSeats, occupied);
}

/**
 * Position labels. UTG is the first seat after the big blind, CO the last before the button, and
 * the rest fill from the button backwards (button at 0, no gaps):
 *
 *   2 handed:  BTN/SB, BB
 *   3 handed:  BTN, SB, BB
 *   4 handed:  BTN, SB, BB, CO
 *   5 handed:  BTN, SB, BB, UTG, CO
 *   6 handed:  BTN, SB, BB, UTG, HJ, CO
 *
 * Pass `blinds` for a hand dealt under the dead-button rule. Re-deriving them from the button would
 * label the wrong players.
 */
export function positionLabels(
  buttonSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
  blinds?: { readonly smallBlindSeat: SeatIndex | null; readonly bigBlindSeat: SeatIndex },
): Map<SeatIndex, PositionLabel> {
  const labels = new Map<SeatIndex, PositionLabel>();
  const { smallBlindSeat, bigBlindSeat, isHeadsUp } =
    blinds === undefined
      ? assignBlinds(buttonSeat, maxSeats, occupied)
      : { ...blinds, isHeadsUp: occupied.length === 2 };

  if (isHeadsUp) {
    labels.set(buttonSeat, 'BTN/SB');
    labels.set(bigBlindSeat, 'BB');
    return labels;
  }

  // A dead button or dead small blind gets no label, so no badge lands on an empty chair.
  if (occupied.includes(buttonSeat)) labels.set(buttonSeat, 'BTN');
  if (smallBlindSeat !== null) labels.set(smallBlindSeat, 'SB');
  labels.set(bigBlindSeat, 'BB');

  // `orderFrom` walks a full orbit, so the button and both blinds must be filtered out. Otherwise
  // `labels.set` overwrites them and 'SB' and 'BB' never appear at three or more handed.
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

export function playersLeftToAct(
  seat: SeatIndex,
  maxSeats: number,
  activeSeats: readonly SeatIndex[],
): number {
  return orderFrom(seat, maxSeats, activeSeats).filter((candidate) => candidate !== seat).length;
}
