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
 * The three fields the layering rule actually reads off a seat.
 *
 * `SeatState` satisfies this structurally, so every existing caller is unaffected. It
 * exists because `contestablePotFor` below has to ask the same question about a
 * *hypothetical* table — the one that exists a moment after hero calls — and building a
 * whole `SeatState` (hole cards, `lastActedAtBetLevel`, `isAllInThisHand`) to ask it
 * would mean inventing five fields the answer does not depend on. Widening the parameter
 * is the alternative to a second copy of the layering rule, and a second copy of this
 * rule is exactly what the Coach's mispriced side pot was.
 */
export interface PotContributor {
  readonly seat: SeatIndex;
  readonly committedTotal: number;
  readonly status: SeatStatus;
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
export function buildPotLayers(seats: readonly PotContributor[]): PotLayers {
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

  const contested = (seat: PotContributor): number => Math.min(seat.committedTotal, contestableCap);
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
  /** Every seat with chips in this hand, folded ones included — their chips stay in the middle. */
  readonly seats: readonly StreetContribution[];
  readonly heroSeat: SeatIndex;
  /**
   * What hero is about to put in, **already capped at hero's stack** — the engine's own
   * `amountToCall`. Passing an uncapped figure describes a call hero cannot make and
   * produces a pot hero cannot reach.
   */
  readonly callAmount: number;
  /** Everything in the middle right now, across every street, hero's pending call excluded. */
  readonly potTotal: number;
}

export interface ContestablePot {
  /** `input.potTotal`, echoed so a caller can print both halves without re-deriving either. */
  readonly potTotal: number;
  /** The part of `potTotal` hero could win by calling. Equal to `potTotal` in the ordinary spot. */
  readonly contestable: number;
  /** `potTotal - contestable`: the side pot(s) hero's stack does not reach. Usually 0. */
  readonly uncontestable: number;
}

/**
 * How much of the middle hero could actually win, when hero is all-in for less than the
 * bet in front of them.
 *
 * ## The defect this exists to close
 *
 * A learner all-in for less than the bet facing them was being priced against the whole
 * middle. Measured, heads-up at 5/10 with hero holding 40 and villain shoving 310: the
 * engine reported `potTotal 320, amountToCall 30` and laid out its own layers as an
 * 80-chip main pot both seats can win and a 270-chip side pot only villain can. The Coach
 * quoted "10.7 to 1, so you need 8.6%" against that 320. The true price is 30 into an
 * 80-chip pot — 1.67 to 1, 37.5% — so the requirement was understated 4.4x and a losing
 * call was published at +82.8 chips. `test/invariants.test.ts` plays 4,000 random hands at
 * 2-6 seats and mixed depths and finds 5,793 decision points with a call the engine capped,
 * 5,650 of them leaving chips beyond hero's reach — the worst understating the equity a call
 * needs by 271x.
 *
 * ## Why it is a sum over opponents, not one subtraction
 *
 * Three-handed with hero capped at 40, opponent A all-in for 100 and opponent B all-in for
 * 300, the chips above hero's reach are 60 from A *and* 260 from B. There are two side
 * pots, and subtracting only the largest bet's excess leaves the other opponent's on the
 * table. The layering below sums them because that is what layering does.
 *
 * ## Why this street's commitments are enough
 *
 * Only the current street can hold chips above hero's reach. A seat that is *to act* has
 * matched the closing level of every completed street — that is what being still in the
 * hand means — so no earlier-street contribution can sit above hero's total, and
 * `potTotal` carries all of it as contestable. A hero who could not match an earlier
 * street is all-in already and is never asked to act again. So the layering runs over
 * `committedThisStreet` and the carried-in money is added back whole.
 *
 * ## Implementation note
 *
 * `buildPotLayers` is asked rather than a formula written out here, on the table as it
 * would stand a moment after hero calls. The eligibility rule — folded seats contribute
 * chips and win nothing, a layer belongs to the seats that reached its cap — has exactly
 * one implementation, and the Coach reads it rather than owning a second one.
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

  // The table one moment after hero calls. Hero's own call is what decides which layers
  // hero reaches, so it has to be in the commitment the layering sees.
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
  // `heroEligible` counts hero's own call, which is not yet in the middle. Every caller
  // here reports a pot "before hero's call" and would double-count it otherwise.
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

/**
 * Throws unless the pot layers plus the returns account for exactly the chips
 * committed. This is the conservation invariant: a side-pot bug silently creates
 * or destroys chips, and there is no other symptom.
 */
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
