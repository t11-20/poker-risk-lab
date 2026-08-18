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
 *
 * ## The button is derived from the blinds, not the other way round
 *
 * `assignBlinds` reads the blinds off the button, which is correct for ONE hand
 * and wrong for a sequence of them the moment the roster changes between hands.
 * Deriving the blinds from the button means the blinds move whenever the button
 * moves, and the button moves by "next occupied seat" — so seating a player
 * between the button and the blinds drags the whole assignment backwards onto
 * players who have already paid. Measured over 40 hands with a join/leave
 * schedule, that charged six players the big blind twice in a row and let one
 * player skip it (`docs/audit/poker-correctness.md`, P1-1). Two consecutive big
 * blinds cost a player `2 × BB` where the rules charge `BB + SB`.
 *
 * The dead-button rule states it the other way round, and `advanceBlindRotation`
 * below is that rule:
 *
 *   1. The BIG BLIND advances by exactly one live player per hand. It is the
 *      only position that is guaranteed to be occupied, and it is the anchor.
 *   2. The small blind falls where the big blind was. If nobody live is in that
 *      chair it is DEAD — nobody posts it, and it is not moved onto the next
 *      player, because that player has already paid it.
 *   3. The button falls where the small blind was. If nobody live is in that
 *      chair the button is DEAD: it sits in an empty seat for one hand.
 *
 * A dead small blind and a dead button are legitimate, expected outcomes of the
 * rule, not degenerate states — which is why `BlindRotation` carries the small
 * blind as `SeatIndex | null` and lets the button name a seat nobody occupies.
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

// ---------------------------------------------------------------------------
// The dead-button rule
// ---------------------------------------------------------------------------

/**
 * Where the three blind positions sit, as SEATS rather than as players.
 *
 * This is the state one hand hands to the next, and it is deliberately three
 * plain seat indices with no notion of who is in them: the small blind and the
 * button are positions the rotation passes through whether or not anybody is
 * sitting there, and forgetting a position because it happened to be empty for
 * one hand is exactly how the rotation loses its place.
 */
export interface BlindPositions {
  readonly buttonSeat: SeatIndex;
  readonly smallBlindSeat: SeatIndex;
  readonly bigBlindSeat: SeatIndex;
}

/** One hand's blinds, resolved against who is actually being dealt in. */
export interface BlindRotation {
  /** The positions to carry into the next hand. */
  readonly positions: BlindPositions;
  /** Where the button sits. Not necessarily occupied — see `buttonIsDead`. */
  readonly buttonSeat: SeatIndex;
  /** Who posts the small blind, or null when it is dead and nobody posts it. */
  readonly smallBlindSeat: SeatIndex | null;
  /** Who posts the big blind. Always a seat that is being dealt in. */
  readonly bigBlindSeat: SeatIndex;
  /** The seats to deal this hand, ascending. */
  readonly dealtIn: readonly SeatIndex[];
  /** True when the button sits in a seat nobody is playing from. */
  readonly buttonIsDead: boolean;
  readonly isHeadsUp: boolean;
}

/**
 * The blinds for the first hand of a fresh rotation.
 *
 * The standard derivation from a button, which is the right one exactly once:
 * when there is no previous hand there is nobody who has already paid, so
 * nothing can be charged twice. Every subsequent hand goes through
 * `advanceBlindRotation`.
 */
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
  /** The previous hand's positions. */
  readonly previous: BlindPositions;
  readonly maxSeats: number;
  /**
   * Every seat in the blind rotation: seated, with chips, and not on the way
   * out. This includes players who still owe a blind, because the whole point of
   * owing one is that the rotation eventually reaches them and collects it.
   */
  readonly entrants: readonly SeatIndex[];
  /**
   * Seats that owe a blind and are therefore not dealt in yet. The seat the big
   * blind lands on is removed from this set by the rotation itself: the big
   * blind reaching a waiting player IS the moment their wait ends.
   */
  readonly awaitingBigBlind?: readonly SeatIndex[];
}

/**
 * The next hand's blinds under the dead-button rule.
 *
 * Heads-up is resolved after the big blind is placed rather than before, and
 * that ordering is the whole of the two-to-three-handed transition. The big
 * blind advances first, unconditionally, so it alternates correctly however the
 * table shrinks or grows; only then is the other seat given both the button and
 * the small blind, which is the heads-up rule. Shifting the positions blindly
 * would put the button and the small blind on different players at a two-handed
 * table, which is not a legal heads-up hand.
 */
export function advanceBlindRotation(input: AdvanceBlindRotationInput): BlindRotation {
  const { previous, maxSeats, entrants } = input;
  if (entrants.length < 2) {
    throw new PositionError(`need at least 2 seats in the rotation, have ${entrants.length}`);
  }
  const bigBlindSeat = nextOccupied(previous.bigBlindSeat, maxSeats, entrants);

  const waiting = new Set(input.awaitingBigBlind ?? []);
  // The big blind is what discharges the obligation, so the seat it lands on is
  // dealt in by definition. Deleting it here rather than at the call site keeps
  // "who is dealt in" a function of the rotation and nothing else.
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

  // The shift. Both are positions the rotation passes through, so both are
  // recorded even when nobody is sitting in them.
  const smallBlindPosition = previous.bigBlindSeat;
  const buttonPosition = previous.smallBlindSeat;
  return {
    positions: { buttonSeat: buttonPosition, smallBlindSeat: smallBlindPosition, bigBlindSeat },
    buttonSeat: buttonPosition,
    // Dead when the chair is empty or holds somebody who is not in this hand.
    // NOT moved onto the next player: that player paid the small blind last hand
    // and is owed the button, not a second charge.
    smallBlindSeat: dealtIn.includes(smallBlindPosition) ? smallBlindPosition : null,
    bigBlindSeat,
    dealtIn,
    buttonIsDead: !dealtIn.includes(buttonPosition),
    isHeadsUp: false,
  };
}

/**
 * First seat to act preflop, given where the big blind actually fell.
 *
 * Separate from `firstToActPreflop` because under the dead-button rule the big
 * blind is an input rather than something to be re-derived from the button: with
 * a dead button or a dead small blind, `button + 2` is not the big blind and
 * re-deriving would open the action on the wrong seat.
 */
export function firstToActPreflopFor(
  buttonSeat: SeatIndex,
  bigBlindSeat: SeatIndex,
  maxSeats: number,
  occupied: readonly SeatIndex[],
): SeatIndex {
  // Heads-up the button posts the small blind and acts first preflop. The button
  // is never dead heads-up — `advanceBlindRotation` gives both positions to the
  // non-big-blind seat — so this is always an occupied seat.
  if (occupied.length === 2) return buttonSeat;
  return nextOccupied(bigBlindSeat, maxSeats, occupied);
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
  const { bigBlindSeat } = assignBlinds(buttonSeat, maxSeats, occupied);
  return firstToActPreflopFor(buttonSeat, bigBlindSeat, maxSeats, occupied);
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
 *
 * `blinds` is how a hand dealt under the dead-button rule labels itself: the
 * blinds are then facts about the hand rather than something to re-derive, and
 * re-deriving them would put 'SB' on a player who did not post one and 'BTN' on
 * a player who is not on the button. Omit it and this behaves exactly as it
 * always has, deriving from the button and refusing an unoccupied one.
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

  // A dead button and a dead small blind get no label at all, because there is
  // no player to give one to. Writing 'BTN' against an empty chair would put the
  // dealer badge on nobody's seat in every view built from this map.
  if (occupied.includes(buttonSeat)) labels.set(buttonSeat, 'BTN');
  if (smallBlindSeat !== null) labels.set(smallBlindSeat, 'SB');
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
