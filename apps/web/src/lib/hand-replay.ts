/**
 * Reconstructs a finished hand, decision by decision, as a sequence of `PlayerView`s.
 * Runs on the server and ships plain data, so the engine never enters the client bundle.
 * The review payload lacks the viewer seat, the blinds, the button and the forced bets, so each is
 * recovered below. The pot readout always uses the server's `potBefore`, and
 * `potDerivationDisagrees` flags any step where the reconstruction disagrees with it.
 */

import type { CoachReport, HandReviewDecision, HandReviewResponse } from '@prl/contracts';
import type { PlayerView, SeatStatus, SeatView, Street } from '@prl/poker-engine';
import { orderFrom, parseCards, positionLabels } from '@prl/poker-engine';

const BOARD_LENGTH: Readonly<Record<string, number>> = { preflop: 0, flop: 3, turn: 4, river: 5 };

const BETTING_STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];

export interface ReplayStep {
  readonly index: number;
  /** The decision this step is positioned *before*, or null for the terminal frame. */
  readonly decision: HandReviewDecision | null;
  readonly view: PlayerView;
  readonly isViewerDecision: boolean;
  readonly analysis: CoachReport | null;
}

export interface ReplayStreet {
  readonly key: string;
  readonly label: string;
  readonly position: number;
  readonly stepIndexes: readonly number[];
}

export interface HandReplay {
  readonly steps: readonly ReplayStep[];
  readonly streets: readonly ReplayStreet[];
  /** Null for a hand the reader did not play a seat in. */
  readonly viewerSeat: number | null;
  readonly seatNames: Readonly<Record<number, string>>;
  /** Surfaced on screen, because a silent disagreement makes every stack in the replay suspect. */
  readonly potDerivationDisagrees: boolean;
  /** True when the forced-bet recovery had to split a remainder between several winning seats. */
  readonly forcedBetsApproximate: boolean;
}

interface Tally {
  stack: number;
  committedThisStreet: number;
  committedTotal: number;
  folded: boolean;
  readonly dealtIn: boolean;
}

function narrowStreet(street: string): Street {
  return BETTING_STREETS.find((candidate) => candidate === street) ?? 'preflop';
}

function parseNotation(cards: readonly string[] | null): readonly number[] | null {
  if (cards === null) return null;
  try {
    return parseCards(cards.join(' '));
  } catch {
    return null;
  }
}

function holePair(cards: readonly string[] | null): readonly [number, number] | null {
  const parsed = parseNotation(cards);
  if (parsed === null) return null;
  const [first, second] = parsed;
  if (first === undefined || second === undefined) return null;
  return [first, second];
}

/**
 * Most reliable first: the seat owning an analysed decision (only the reader's are analysed), the
 * single human seat, then the seat whose net matches `heroNet`. Null makes it a spectator view.
 */
function findViewerSeat(review: HandReviewResponse): number | null {
  for (const decision of review.decisions) {
    if (decision.analysis !== null) return decision.seat;
  }
  const humans = review.seats.filter((seat) => !seat.isBot);
  const only = humans[0];
  if (humans.length === 1 && only !== undefined) return only.seat;
  if (review.hand.heroNet !== null) {
    const byNet = review.seats.filter((seat) => seat.net === review.hand.heroNet);
    const single = byNet[0];
    if (byNet.length === 1 && single !== undefined) return single.seat;
  }
  return null;
}

interface ForcedBets {
  readonly bySeat: ReadonlyMap<number, number>;
  readonly approximate: boolean;
}

/** `-net - paid` is exact for a seat that won nothing. Winners share the rest of the first `potBefore`. */
function recoverForcedBets(review: HandReviewResponse): ForcedBets {
  const paid = new Map<number, number>();
  for (const seat of review.seats) paid.set(seat.seat, 0);
  for (const decision of review.decisions) {
    paid.set(decision.seat, (paid.get(decision.seat) ?? 0) + decision.amountPaid);
  }

  const first = review.decisions[0];
  const postedTotal = first === undefined ? 0 : first.potBefore;

  const bySeat = new Map<number, number>();
  const unresolved: number[] = [];
  let attributed = 0;
  for (const seat of review.seats) {
    const derived = -seat.net - (paid.get(seat.seat) ?? 0);
    if (derived >= 0) {
      bySeat.set(seat.seat, derived);
      attributed += derived;
    } else {
      unresolved.push(seat.seat);
    }
  }

  const remainder = Math.max(0, postedTotal - attributed);
  if (unresolved.length === 0) return { bySeat, approximate: false };
  // Several winners means a split pot, where an equal split is approximate, so it is flagged.
  const share = Math.floor(remainder / unresolved.length);
  for (const seat of unresolved) bySeat.set(seat, share);
  return { bySeat, approximate: unresolved.length > 1 };
}

/** `smallBlindSeat` is null for a dead small blind, spelled as `HandState.smallBlindSeat` spells it. */
interface BlindSeats {
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;
}

/** `orderFrom` returns an occupied `from` LAST, so the element before it is the previous dealt seat. */
function previousDealt(from: number, maxSeats: number, dealt: readonly number[]): number | null {
  const orbit = orderFrom(from, maxSeats, dealt);
  if (orbit[orbit.length - 1] !== from) return null;
  return orbit[orbit.length - 2] ?? null;
}

/**
 * Read off who opened the action, because under the dead-button rule `button + 1` and `button + 2`
 * are not the blinds. Preflop opens on the seat after the big blind (heads-up, on the button), so
 * the big blind is the dealt seat before the first decision. Null with no preflop decision to read.
 */
function recoverBlindSeats(
  forced: ReadonlyMap<number, number>,
  dealt: readonly number[],
  maxSeats: number,
  first: HandReviewDecision | undefined,
): BlindSeats | null {
  if (dealt.length < 2 || first === undefined || first.street !== 'preflop') return null;
  const bigBlindSeat = previousDealt(first.seat, maxSeats, dealt);
  if (bigBlindSeat === null) return null;
  const candidate = previousDealt(bigBlindSeat, maxSeats, dealt);
  // A seat that posted nothing is not a small blind. The small blind was dead.
  const posted = candidate === null ? 0 : (forced.get(candidate) ?? 0);
  return { smallBlindSeat: posted > 0 ? candidate : null, bigBlindSeat };
}

/**
 * Read from the seats that posted, because with a dead small blind there is only one forced bet and
 * sorting would report a 5/10 hand as 10/10. A dead small blind reads as 0.
 */
function recoverBlindAmounts(
  forced: ReadonlyMap<number, number>,
  blinds: BlindSeats | null,
): { small: number; big: number } {
  if (blinds !== null) {
    const small = blinds.smallBlindSeat === null ? 0 : (forced.get(blinds.smallBlindSeat) ?? 0);
    return { small, big: forced.get(blinds.bigBlindSeat) ?? 0 };
  }
  const positive = [...forced.values()].filter((amount) => amount > 0).sort((a, b) => a - b);
  const smallest = positive[0];
  const largest = positive[positive.length - 1];
  if (smallest === undefined || largest === undefined) return { small: 0, big: 0 };
  return { small: smallest, big: largest };
}

/**
 * Heads-up the button is the small blind. Otherwise it is the dealt seat before the small blind, or
 * before the big blind when the small blind is dead. A dead button cannot be told apart in this
 * payload. With no decisions to anchor on it falls back to who posted what, ties to the lowest seat.
 */
function recoverButtonSeat(
  review: HandReviewResponse,
  forced: ReadonlyMap<number, number>,
  dealt: readonly number[],
  maxSeats: number,
  blinds: BlindSeats | null,
): number {
  if (blinds !== null) {
    const fromBlinds =
      dealt.length === 2
        ? blinds.smallBlindSeat
        : previousDealt(blinds.smallBlindSeat ?? blinds.bigBlindSeat, maxSeats, dealt);
    if (fromBlinds !== null) return fromBlinds;
  }

  const seated = review.seats.filter((seat) => seat.startingStack > 0);
  const zeroPosters = seated.filter((seat) => (forced.get(seat.seat) ?? 0) === 0);
  const onlyZero = zeroPosters[0];
  if (zeroPosters.length === 1 && onlyZero !== undefined) return onlyZero.seat;
  const sorted = [...seated].sort(
    (a, b) => (forced.get(a.seat) ?? 0) - (forced.get(b.seat) ?? 0) || a.seat - b.seat,
  );
  return sorted[0]?.seat ?? 0;
}

function statusOf(tally: Tally): SeatStatus {
  if (!tally.dealtIn) return 'sittingOut';
  if (tally.folded) return 'folded';
  if (tally.stack <= 0 && tally.committedTotal > 0) return 'allIn';
  return 'active';
}

interface ViewInput {
  readonly review: HandReviewResponse;
  readonly tallies: ReadonlyMap<number, Tally>;
  readonly street: Street;
  readonly potTotal: number;
  readonly toAct: number | null;
  readonly viewerSeat: number | null;
  readonly buttonSeat: number;
  readonly labels: ReadonlyMap<number, SeatView['position']>;
  readonly blinds: { readonly small: number; readonly big: number };
  readonly maxSeats: number;
  readonly board: readonly number[];
  readonly betLevel: number;
  readonly actionSequence: number;
}

function buildView(input: ViewInput): PlayerView {
  const { review, tallies, street, potTotal, toAct, viewerSeat, buttonSeat, labels } = input;

  const seats: SeatView[] = review.seats.map((seat) => {
    const tally = tallies.get(seat.seat);
    const stack = tally?.stack ?? seat.startingStack;
    const status = tally === undefined ? 'active' : statusOf(tally);
    return {
      seat: seat.seat,
      playerId: `review-seat-${seat.seat}`,
      stack,
      committedThisStreet: tally?.committedThisStreet ?? 0,
      committedTotal: tally?.committedTotal ?? 0,
      status,
      position: labels.get(seat.seat) ?? null,
      // Already redacted by the server. Null stays null for a seat that folded and never showed.
      holeCards: holePair(seat.holeCards),
      isSelf: viewerSeat !== null && seat.seat === viewerSeat,
      isButton: seat.seat === buttonSeat,
      isToAct: toAct !== null && seat.seat === toAct,
    };
  });

  const viewerTally = viewerSeat === null ? undefined : tallies.get(viewerSeat);
  const owed =
    viewerTally === undefined || toAct !== viewerSeat
      ? 0
      : Math.max(0, Math.min(input.betLevel - viewerTally.committedThisStreet, viewerTally.stack));

  const contested = seats.filter((seat) => seat.status !== 'folded' && seat.status !== 'sittingOut');
  const capPerSeat = contested.reduce((highest, seat) => Math.max(highest, seat.committedTotal), 0);

  return {
    handId: review.hand.id,
    roomId: review.hand.roomId,
    handNumber: review.hand.handNumber,
    config: {
      smallBlind: input.blinds.small,
      bigBlind: input.blinds.big,
      // No room is configured with an ante, and a recovery from totals cannot separate one.
      ante: 0,
      maxSeats: input.maxSeats,
      // Not in the review payload and not rendered. Zero is the inert value.
      actionTimeoutSeconds: 0,
    },
    street,
    board: input.board,
    buttonSeat,
    seats,
    toAct,
    betLevel: input.betLevel,
    minimumRaiseTo: input.betLevel + Math.max(input.betLevel, input.blinds.big),
    potTotal,
    // One main pot. Neither the payload nor this reconstruction can tell a side-pot boundary from a
    // short call.
    pots: [{ amount: potTotal, eligibleSeats: contested.map((seat) => seat.seat), capPerSeat, index: 0 }],
    forcedBets: [],
    actions: [],
    actionSequence: input.actionSequence,
    // Empty, so `ActionBar` renders its idle state for a finished hand.
    legalActions: [],
    amountToCall: owed,
    commitmentRoot: review.commitmentRoot,
    commitmentContext: review.commitmentContext,
    // The reveal lives on the response. `HandResult` would need invented scores and awards.
    result: null,
    viewerSeat,
    randomSourceKind: 'csprng',
  };
}

interface WalkInput {
  readonly review: HandReviewResponse;
  readonly decisions: readonly HandReviewDecision[];
  readonly tallies: Map<number, Tally>;
  readonly street: Street;
  readonly potInMiddle: number;
  readonly betLevel: number;
  readonly board: readonly number[];
  readonly viewerSeat: number | null;
  readonly buttonSeat: number;
  readonly labels: ReadonlyMap<number, SeatView['position']>;
  readonly blinds: { readonly small: number; readonly big: number };
  readonly maxSeats: number;
}

interface WalkResult {
  readonly steps: readonly ReplayStep[];
  readonly street: Street;
  readonly potInMiddle: number;
  readonly disagrees: boolean;
}

/** Snapshots the table before each decision, then mutates `tallies`, so no step shows its own action. */
function walkDecisions(input: WalkInput): WalkResult {
  const { review, decisions, tallies, board, viewerSeat, buttonSeat, labels, blinds, maxSeats } = input;
  const steps: ReplayStep[] = [];
  let street = input.street;
  let potInMiddle = input.potInMiddle;
  let betLevel = input.betLevel;
  let disagrees = false;

  for (const decision of decisions) {
    const nextStreet = narrowStreet(decision.street);
    if (nextStreet !== street) {
      potInMiddle += sweepStreet(tallies);
      betLevel = 0;
      street = nextStreet;
    }

    if (potInMiddle + sumCommitted(tallies) !== decision.potBefore) disagrees = true;

    steps.push({
      index: steps.length,
      decision,
      view: buildView({
        review,
        tallies,
        street,
        // The server's figure, not the reconstruction's.
        potTotal: decision.potBefore,
        toAct: decision.seat,
        viewerSeat,
        buttonSeat,
        labels,
        blinds,
        maxSeats,
        board: board.slice(0, BOARD_LENGTH[street] ?? 0),
        betLevel,
        actionSequence: decision.sequence - 1,
      }),
      isViewerDecision: viewerSeat !== null && decision.seat === viewerSeat,
      analysis: decision.analysis,
    });

    const actor = tallies.get(decision.seat);
    if (actor !== undefined) {
      actor.stack -= decision.amountPaid;
      actor.committedThisStreet += decision.amountPaid;
      actor.committedTotal += decision.amountPaid;
      if (decision.action === 'fold') actor.folded = true;
      betLevel = Math.max(betLevel, actor.committedThisStreet);
    }
  }

  return { steps, street, potInMiddle, disagrees };
}

/**
 * The terminal frame's stacks after the award. A decision list carries what was paid, never what was
 * won, so walked stacks showed the winner at the loser's figure. Uses the server's
 * `startingStack + net`, and only for a completed hand.
 */
function settleTallies(tallies: ReadonlyMap<number, Tally>, review: HandReviewResponse): Map<number, Tally> {
  const settled = new Map<number, Tally>();
  for (const [seat, tally] of tallies) settled.set(seat, { ...tally });
  if (review.hand.completedAt === null) return settled;
  for (const seat of review.seats) {
    const tally = settled.get(seat.seat);
    if (tally === undefined) continue;
    tally.stack = seat.startingStack + seat.net;
  }
  return settled;
}

function sweepStreet(tallies: Map<number, Tally>): number {
  let moved = 0;
  for (const tally of tallies.values()) {
    moved += tally.committedThisStreet;
    tally.committedThisStreet = 0;
  }
  return moved;
}

function sumCommitted(tallies: ReadonlyMap<number, Tally>): number {
  let total = 0;
  for (const tally of tallies.values()) total += tally.committedThisStreet;
  return total;
}

/**
 * The highest seat index plus one, not the seat count. Seat arithmetic is `% maxSeats`, so seats
 * 0, 1 and 3 sized as 3 would leave seat 3 unreachable.
 */
function tableSize(review: HandReviewResponse): number {
  const highest = review.seats.reduce((seat, entry) => Math.max(seat, entry.seat), 0);
  return Math.max(2, Math.min(6, highest + 1));
}

/** Builds the whole replay. Never throws: a hand it cannot read produces a replay with no steps. */
export function buildHandReplay(review: HandReviewResponse): HandReplay {
  const decisions = [...review.decisions].sort((a, b) => a.sequence - b.sequence);
  const viewerSeat = findViewerSeat(review);
  const forced = recoverForcedBets(review);
  const board = parseNotation(review.hand.board) ?? [];
  const maxSeats = tableSize(review);

  const seatNames: Record<number, string> = {};
  for (const seat of review.seats) seatNames[seat.seat] = seat.displayName;
  // The reader's seat is "You", matching the timeline. `Seat` appends no marker to it.
  if (viewerSeat !== null) seatNames[viewerSeat] = 'You';

  const occupied = review.seats
    .filter((seat) => seat.startingStack > 0)
    .map((seat) => seat.seat)
    .sort((a, b) => a - b);
  const blindSeats = recoverBlindSeats(forced.bySeat, occupied, maxSeats, decisions[0]);
  const blinds = recoverBlindAmounts(forced.bySeat, blindSeats);
  const buttonSeat = recoverButtonSeat(review, forced.bySeat, occupied, maxSeats, blindSeats);

  // Blinds are passed in because deriving them from the button is wrong under the dead-button rule
  // and throws on a button in an empty chair.
  let labels: ReadonlyMap<number, SeatView['position']>;
  try {
    labels =
      occupied.length >= 2
        ? positionLabels(buttonSeat, maxSeats, occupied, blindSeats ?? undefined)
        : new Map();
  } catch {
    labels = new Map();
  }

  const tallies = new Map<number, Tally>();
  for (const seat of review.seats) {
    const posted = forced.bySeat.get(seat.seat) ?? 0;
    tallies.set(seat.seat, {
      stack: seat.startingStack - posted,
      committedThisStreet: posted,
      committedTotal: posted,
      folded: false,
      dealtIn: seat.startingStack > 0,
    });
  }

  const street: Street = decisions[0] === undefined ? 'preflop' : narrowStreet(decisions[0].street);
  let potInMiddle = 0;
  let betLevel = 0;
  for (const tally of tallies.values()) betLevel = Math.max(betLevel, tally.committedThisStreet);

  const walk = walkDecisions({
    review,
    decisions,
    tallies,
    street,
    potInMiddle,
    betLevel,
    board,
    viewerSeat,
    buttonSeat,
    labels,
    blinds,
    maxSeats,
  });
  const steps: ReplayStep[] = [...walk.steps];
  const disagrees = walk.disagrees;
  potInMiddle = walk.potInMiddle;

  // The terminal frame is the only place the reader sees the final stacks, settled by `settleTallies`.
  potInMiddle += sweepStreet(tallies);
  const terminalStreet: Street = review.hand.completedAt === null ? walk.street : 'complete';
  steps.push({
    index: steps.length,
    decision: null,
    view: buildView({
      review,
      tallies: settleTallies(tallies, review),
      street: terminalStreet,
      potTotal: review.hand.potTotal,
      toAct: null,
      viewerSeat,
      buttonSeat,
      labels,
      blinds,
      maxSeats,
      board,
      betLevel: 0,
      actionSequence: decisions.length,
    }),
    isViewerDecision: false,
    analysis: null,
  });

  return {
    steps,
    streets: groupStreets(steps, review),
    viewerSeat,
    seatNames,
    potDerivationDisagrees: disagrees,
    forcedBetsApproximate: forced.approximate,
  };
}

function groupStreets(steps: readonly ReplayStep[], review: HandReviewResponse): readonly ReplayStreet[] {
  const groups: { key: string; label: string; stepIndexes: number[] }[] = [];
  const terminalLabel =
    review.hand.completedAt === null ? 'IN PROGRESS' : review.hand.endedByFold ? 'FOLDED OUT' : 'SHOWDOWN';

  for (const step of steps) {
    const key = step.decision === null ? 'settled' : narrowStreet(step.decision.street);
    const label = step.decision === null ? terminalLabel : key.toUpperCase();
    const last = groups[groups.length - 1];
    if (last !== undefined && last.key === key) {
      last.stepIndexes.push(step.index);
      continue;
    }
    groups.push({ key, label, stepIndexes: [step.index] });
  }

  return groups.map((group, position) => ({
    key: group.key,
    label: group.label,
    position: position + 1,
    stepIndexes: group.stepIndexes,
  }));
}
