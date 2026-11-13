/**
 * Side pots and pot awarding.
 *
 * Each distinct `committedTotal` (folded seats included) is a level, and each gap between levels is
 * a layer:
 *
 *     layer amount = Σ over seats of (min(committed, level) - min(committed, previousLevel))
 *
 * A seat is eligible for a layer if it still holds cards and reached the layer's cap. Folded seats
 * contribute and win nothing. Odd chips go to the winner nearest the button's left, never randomly,
 * so a hand replays identically. Chips are conserved, and `assertPotsBalance` and `awardPots` both
 * assert it, because a side-pot bug has no other symptom.
 */

import type { Card } from './cards.ts';
import { describeScore, evaluate, type HandScore } from './evaluate.ts';
import type { Pot, PotAward, SeatIndex, SeatShowdown, SeatState, SeatStatus } from './types.ts';

export class PotError extends Error {
  override readonly name = 'PotError';
}

/** Chips no live player could contest, handed back to whoever put them in. */
export interface UncontestedReturn {
  readonly seat: SeatIndex;
  readonly amount: number;
}

/**
 * The three fields the layering rule reads. `SeatState` satisfies it. `contestablePotFor` passes a
 * hypothetical table through it instead of keeping a second copy of the layering rule.
 */
export interface PotContributor {
  readonly seat: SeatIndex;
  readonly committedTotal: number;
  readonly status: SeatStatus;
}

export interface PotLayers {
  readonly pots: readonly Pot[];
  /** Chips above the highest live commitment. Nobody can win them, so they go back (an uncalled bet). */
  readonly returns: readonly UncontestedReturn[];
}

/**
 * Builds the pot layers from total commitments. Contributions are capped at the highest live
 * commitment and the excess is returned, so a folded top contributor never leaves a layer with no
 * eligible seat. A short blind folding to a shorter all-in big blind gets its unmatched part back
 * under TDA and Robert's Rules. Matched chips are forfeited.
 *
 * @param seats every seat that put chips in this hand, folded or not
 */
export function buildPotLayers(seats: readonly PotContributor[]): PotLayers {
  const contributors = seats.filter((seat) => seat.committedTotal > 0);
  if (contributors.length === 0) return { pots: [], returns: [] };

  const live = seats.filter((seat) => seat.status === 'active' || seat.status === 'allIn');
  if (live.length === 0) {
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

  const contested = (seat: PotContributor): number => Math.min(seat.committedTotal, contestableCap);
  const levels = [...new Set(contributors.map(contested))].filter((level) => level > 0).sort((a, b) => a - b);

  const pots: Pot[] = [];
  let previousLevel = 0;
  for (const level of levels) {
    let amount = 0;
    for (const seat of contributors) {
      amount += Math.min(contested(seat), level) - Math.min(contested(seat), previousLevel);
    }
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

  // Merge adjacent layers with identical eligibility, so the display does not show three pots that
  // always pay the same seat.
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

export function buildPots(seats: readonly PotContributor[]): Pot[] {
  return [...buildPotLayers(seats).pots];
}

/** One seat's stake in the street being priced. `SeatState` and `SeatView` both satisfy it. */
export interface StreetContribution {
  readonly seat: SeatIndex;
  readonly committedThisStreet: number;
  readonly status: SeatStatus;
}

export interface ContestablePotInput {
  /** Every seat with chips in this hand, folded ones included. */
  readonly seats: readonly StreetContribution[];
  readonly heroSeat: SeatIndex;
  /** What hero is about to put in, already capped at hero's stack (the engine's `amountToCall`). */
  readonly callAmount: number;
  /** Everything in the middle right now, across every street, hero's pending call excluded. */
  readonly potTotal: number;
}

export interface ContestablePot {
  /** `input.potTotal`, echoed. */
  readonly potTotal: number;
  /** The part of `potTotal` hero could win by calling. Equal to `potTotal` in the ordinary spot. */
  readonly contestable: number;
  /** `potTotal - contestable`: the side pot(s) hero's stack does not reach. Usually 0. */
  readonly uncontestable: number;
}

/**
 * How much of the middle hero could win when all-in for less than the bet faced. Pricing against
 * the whole middle understated the needed equity. Heads-up 5/10, hero with 40 facing a shove of 310,
 * the Coach quoted 8.6% against a pot of 320 when the true need was 37.5% (30 into 80).
 * `test/invariants.test.ts` found the worst case understated by 271x.
 *
 * The excess is summed across opponents, since each all-in above hero makes its own side pot. Only
 * the current street can hold chips above hero's reach, because a seat to act has matched every
 * earlier street. So layering runs over `committedThisStreet` and earlier streets count whole. The
 * layering itself is `buildPotLayers` on the table as it stands right after hero calls.
 */
export function contestablePotFor(input: ContestablePotInput): ContestablePot {
  const hero = input.seats.find((seat) => seat.seat === input.heroSeat);
  if (hero === undefined) {
    throw new PotError(`seat ${input.heroSeat} is not among the seats supplied, so it has no pot share`);
  }
  if (hero.status !== 'active' && hero.status !== 'allIn') {
    throw new PotError(`seat ${input.heroSeat} is ${hero.status} and can win nothing; there is no price`);
  }
  if (!Number.isInteger(input.callAmount) || input.callAmount < 0) {
    throw new PotError(`callAmount must be a non-negative whole number of chips, got ${input.callAmount}`);
  }
  const streetTotal = input.seats.reduce((sum, seat) => sum + seat.committedThisStreet, 0);
  if (!Number.isInteger(input.potTotal) || input.potTotal < streetTotal) {
    throw new PotError(
      `potTotal ${input.potTotal} is below the ${streetTotal} committed on this street alone — it is ` +
        "everything in the middle across every street, excluding hero's pending call",
    );
  }

  // The table right after hero calls. Hero's call decides which layers hero reaches.
  const afterCall: PotContributor[] = input.seats.map((seat) => ({
    seat: seat.seat,
    committedTotal: seat.committedThisStreet + (seat.seat === input.heroSeat ? input.callAmount : 0),
    status: seat.status,
  }));
  const layers = buildPotLayers(afterCall);

  let heroEligible = 0;
  for (const pot of layers.pots) {
    if (pot.eligibleSeats.includes(input.heroSeat)) heroEligible += pot.amount;
  }
  // `heroEligible` includes hero's own call, which callers exclude from the pot.
  const contestableThisStreet = heroEligible - input.callAmount;
  const uncontestable = streetTotal - contestableThisStreet;
  const contestable = input.potTotal - uncontestable;

  if (uncontestable < 0 || contestable < 0 || contestable > input.potTotal) {
    throw new PotError(
      `internal: seat ${input.heroSeat} can contest ${contestable} of ${input.potTotal} with ` +
        `${uncontestable} beyond reach — the three do not describe one pot`,
    );
  }
  return { potTotal: input.potTotal, contestable, uncontestable };
}

function sameSeats(a: readonly SeatIndex[], b: readonly SeatIndex[]): boolean {
  if (a.length !== b.length) return false;
  for (const [index, value] of a.entries()) {
    if (b[index] !== value) return false;
  }
  return true;
}

/** Throws unless the layers plus the returns equal the chips committed. */
export function assertPotsBalance(seats: readonly PotContributor[], layers: PotLayers): void {
  const committed = seats.reduce((sum, seat) => sum + seat.committedTotal, 0);
  const inPots = layers.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const returned = layers.returns.reduce((sum, entry) => sum + entry.amount, 0);
  if (committed !== inPots + returned) {
    throw new PotError(
      `pot layers total ${inPots} + ${returned} returned, but seats committed ${committed} — chips were created or destroyed`,
    );
  }
}

/** Seats in order starting left of the button. Used for odd chips and first-to-act. */
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
    // No scores means the hand ended by a fold, and the one eligible seat takes it unseen.
    const winners =
      bestScore < 0
        ? [...pot.eligibleSeats]
        : pot.eligibleSeats.filter((seat) => input.scores.get(seat) === bestScore);

    if (winners.length === 0) throw new PotError(`pot ${pot.index} resolved to no winner`);

    const share = Math.floor(pot.amount / winners.length);
    const remainder = pot.amount - share * winners.length;
    // `remainder` < `winners.length`, so the first `remainder` winners in button order get one each.
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
