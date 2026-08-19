/**
 * Side pots and pot awarding.
 *
 * ## Building the layers
 *
 * Every seat's `committedTotal` — including folded seats, whose chips stay in the
 * middle — defines a set of distinct contribution levels. Sort them ascending and
 * each adjacent gap forms one pot layer:
 *
 *     layer amount = Σ over seats of (min(committed, level) - min(committed, previousLevel))
 *
 * A seat is eligible for a layer if it is still holding cards AND its
 * `committedTotal` reaches that layer's cap. Folded seats contribute chips but are
 * eligible for nothing, which is exactly how a real table works.
 *
 * The uncalled-bet case needs no special handling: if one seat bet more than
 * anyone matched, the top layer has that seat as its only eligible player, so it
 * is awarded straight back. That is the same thing as returning the uncalled
 * portion, and it falls out of the general algorithm rather than being a branch.
 *
 * ## Odd chips
 *
 * A pot that does not divide evenly among winners leaves a remainder. The house
 * rule used here is the standard one: extra chips go to the winner closest to the
 * left of the button (i.e. first in position order starting from button+1). This
 * is deterministic — never random — so a hand replays identically.
 *
 * ## The invariant that matters
 *
 * Chips are conserved. `assertPotsBalance` checks that the layers sum to the total
 * committed, and `awardPots` checks that awards sum to the pot total. Both are
 * asserted in tests over randomised all-in situations, because a side-pot bug
 * silently creates or destroys chips and is otherwise very hard to notice.
 */

import type { Card } from './cards.ts';
import { describeScore, evaluate, type HandScore } from './evaluate.ts';
import type { Pot, PotAward, SeatIndex, SeatShowdown, SeatState } from './types.ts';

export class PotError extends Error {
  override readonly name = 'PotError';
}

/** Chips no live player could contest, handed back to whoever put them in. */
export interface UncontestedReturn {
  readonly seat: SeatIndex;
  readonly amount: number;
}

export interface PotLayers {
  readonly pots: readonly Pot[];
  /**
   * Chips above the highest amount any live player committed. Nobody still
   * holding cards can win them, so they go back to their contributor. This is
   * what a dealer does with the uncalled part of a bet.
   */
  readonly returns: readonly UncontestedReturn[];
}

/**
 * Builds the pot layers from the seats' total commitments.
 *
 * Contributions are first capped at the highest amount any *live* seat committed.
 * Anything above that cap could not be won by anyone and is returned to its
 * contributor rather than sitting in an unwinnable layer.
 *
 * That cap is what makes this function total. Without it, a state where the
 * single largest contributor has folded produces a layer with no eligible seats,
 * and the awarding step has nowhere to put the chips.
 *
 * The short-blind fold against a shorter all-in big blind *is* legal play: the
 * unmatched part of the blind is an uncalled bet, and TDA / Robert’s Rules return
 * uncalled chips to the player who put them in. Returning that excess is the
 * dealer procedure, not a consolation for an illegal fold. A fold still forfeits
 * every chip that *was* matched.
 *
 * @param seats every seat that put chips in this hand, folded or not
 */
export function buildPotLayers(seats: readonly SeatState[]): PotLayers {
  const contributors = seats.filter((seat) => seat.committedTotal > 0);
  if (contributors.length === 0) return { pots: [], returns: [] };

  const live = seats.filter((seat) => seat.status === 'active' || seat.status === 'allIn');
  if (live.length === 0) {
    // No live players at all: everything goes back where it came from.
    return {
      pots: [],
      returns: contributors.map((seat) => ({ seat: seat.seat, amount: seat.committedTotal })),
    };
  }
  const contestableCap = live.reduce((highest, seat) => Math.max(highest, seat.committedTotal), 0);

  const returns: UncontestedReturn[] = [];
  for (const seat of contributors) {
    const excess = seat.committedTotal - contestableCap;
    if (excess > 0) returns.push({ seat: seat.seat, amount: excess });
  }

  const contested = (seat: SeatState): number => Math.min(seat.committedTotal, contestableCap);
  const levels = [...new Set(contributors.map(contested))].filter((level) => level > 0).sort((a, b) => a - b);

  const pots: Pot[] = [];
  let previousLevel = 0;
  for (const level of levels) {
    let amount = 0;
    for (const seat of contributors) {
      amount += Math.min(contested(seat), level) - Math.min(contested(seat), previousLevel);
    }
    // Seats still holding cards that reached this cap can win this layer.
    const eligibleSeats = live
      .filter((seat) => contested(seat) >= level)
      .map((seat) => seat.seat)
      .sort((a, b) => a - b);

    if (amount > 0) {
      if (eligibleSeats.length === 0) {
        throw new PotError(
          `internal: layer at cap ${level} has no eligible seats despite the contestable cap`,
        );
      }
      pots.push({ amount, eligibleSeats, capPerSeat: level, index: pots.length });
    }
    previousLevel = level;
  }

  // Merge adjacent layers with identical eligibility. Without this, a table where
  // three players are all-in for different amounts but all remain eligible would
  // report three pots that always pay the same person — technically correct but
  // confusing to display and to reason about.
  const merged: Pot[] = [];
  for (const pot of pots) {
    const last = merged[merged.length - 1];
    if (last !== undefined && sameSeats(last.eligibleSeats, pot.eligibleSeats)) {
      merged[merged.length - 1] = {
        amount: last.amount + pot.amount,
        eligibleSeats: last.eligibleSeats,
        capPerSeat: pot.capPerSeat,
        index: last.index,
      };
      continue;
    }
    merged.push({ ...pot, index: merged.length });
  }

  const layers: PotLayers = { pots: merged, returns };
  assertPotsBalance(seats, layers);
  return layers;
}

/** Convenience wrapper for callers that only need the contested pots. */
export function buildPots(seats: readonly SeatState[]): Pot[] {
  return [...buildPotLayers(seats).pots];
}

function sameSeats(a: readonly SeatIndex[], b: readonly SeatIndex[]): boolean {
  if (a.length !== b.length) return false;
  for (const [index, value] of a.entries()) {
    if (b[index] !== value) return false;
  }
  return true;
}

/**
 * Throws unless the pot layers plus the returns account for exactly the chips
 * committed. This is the conservation invariant: a side-pot bug silently creates
 * or destroys chips, and there is no other symptom.
 */
export function assertPotsBalance(seats: readonly SeatState[], layers: PotLayers): void {
  const committed = seats.reduce((sum, seat) => sum + seat.committedTotal, 0);
  const inPots = layers.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const returned = layers.returns.reduce((sum, entry) => sum + entry.amount, 0);
  if (committed !== inPots + returned) {
    throw new PotError(
      `pot layers total ${inPots} + ${returned} returned, but seats committed ${committed} — chips were created or destroyed`,
    );
  }
}

/**
 * Position order starting immediately left of the button. Used for odd-chip
 * assignment and for first-to-act ordering.
 */
export function seatOrderFromButton(
  buttonSeat: SeatIndex,
  maxSeats: number,
  seats: readonly SeatIndex[],
): SeatIndex[] {
  const ordered: SeatIndex[] = [];
  for (let step = 1; step <= maxSeats; step++) {
    const candidate = (buttonSeat + step) % maxSeats;
    if (seats.includes(candidate)) ordered.push(candidate);
  }
  return ordered;
}

/** The five cards that make a hand, for highlighting in review. */
export function bestFiveCards(cards: readonly Card[]): Card[] {
  if (cards.length < 5 || cards.length > 7) {
    throw new PotError(`bestFiveCards needs 5 to 7 cards, received ${cards.length}`);
  }
  let bestScore = -1;
  let best: Card[] = [];
  const chooseFive = (start: number, picked: Card[]): void => {
    if (picked.length === 5) {
      const score = evaluate(picked);
      if (score > bestScore) {
        bestScore = score;
        best = [...picked];
      }
      return;
    }
    for (let i = start; i < cards.length; i++) {
      const card = cards[i];
      if (card === undefined) continue;
      picked.push(card);
      chooseFive(i + 1, picked);
      picked.pop();
    }
  };
  chooseFive(0, []);
  return best;
}

export interface ShowdownInput {
  readonly seats: readonly SeatState[];
  readonly board: readonly Card[];
  readonly buttonSeat: SeatIndex;
  readonly maxSeats: number;
}

/** Evaluates every seat still holding cards. */
export function computeShowdowns(input: ShowdownInput): SeatShowdown[] {
  const out: SeatShowdown[] = [];
  for (const seat of input.seats) {
    if (seat.status !== 'active' && seat.status !== 'allIn') continue;
    if (seat.holeCards === null) {
      throw new PotError(`seat ${seat.seat} reached showdown without hole cards`);
    }
    const all = [...seat.holeCards, ...input.board];
    if (all.length !== 7) {
      throw new PotError(`seat ${seat.seat} has ${all.length} cards at showdown, expected 7`);
    }
    const score = evaluate(all);
    out.push({
      seat: seat.seat,
      playerId: seat.playerId,
      holeCards: seat.holeCards,
      score,
      description: describeScore(score),
      bestFive: bestFiveCards(all),
    });
  }
  return out;
}

export interface AwardInput {
  readonly pots: readonly Pot[];
  readonly scores: ReadonlyMap<SeatIndex, HandScore>;
  readonly seats: readonly SeatState[];
  readonly buttonSeat: SeatIndex;
  readonly maxSeats: number;
}

/**
 * Awards every pot to the best eligible hand, splitting ties and distributing odd
 * chips left of the button.
 */
export function awardPots(input: AwardInput): PotAward[] {
  const awards: PotAward[] = [];
  const playerIdBySeat = new Map(input.seats.map((seat) => [seat.seat, seat.playerId]));

  for (const pot of input.pots) {
    if (pot.eligibleSeats.length === 0) {
      throw new PotError(`pot ${pot.index} of ${pot.amount} has no eligible seats`);
    }

    let bestScore = -1;
    for (const seat of pot.eligibleSeats) {
      const score = input.scores.get(seat);
      if (score === undefined) continue;
      if (score > bestScore) bestScore = score;
    }
    // No scores at all means the hand ended by folding: the single remaining
    // eligible seat takes it without showing.
    const winners =
      bestScore < 0
        ? [...pot.eligibleSeats]
        : pot.eligibleSeats.filter((seat) => input.scores.get(seat) === bestScore);

    if (winners.length === 0) throw new PotError(`pot ${pot.index} resolved to no winner`);

    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;
    // `remainder` is strictly less than `winners.length`, so each of the first
    // `remainder` winners in button order gets exactly one extra chip. Handling
    // it this way makes the distribution obviously total and obviously terminating.
    const oddChipOrder = seatOrderFromButton(input.buttonSeat, input.maxSeats, winners);
    const getsOddChip = new Set(oddChipOrder.slice(0, remainder));

    for (const seat of winners) {
      const playerId = playerIdBySeat.get(seat);
      if (playerId === undefined) throw new PotError(`winner seat ${seat} has no player`);
      const oddChips = getsOddChip.has(seat) ? 1 : 0;
      awards.push({
        potIndex: pot.index,
        amount: share + oddChips,
        seat,
        playerId,
        wasSplit: winners.length > 1,
        oddChips,
      });
    }
  }

  const awarded = awards.reduce((sum, award) => sum + award.amount, 0);
  const potTotal = input.pots.reduce((sum, pot) => sum + pot.amount, 0);
  if (awarded !== potTotal) {
    throw new PotError(`awarded ${awarded} but pots held ${potTotal} — chips were created or destroyed`);
  }
  return awards;
}
