/**
 * Reconstructing a finished hand, decision by decision, as a sequence of `PlayerView`s.
 *
 * ## Why the replay is derived on the server and shipped as data
 *
 * `HandReplay` is a client component — it owns the scrub position — but the reconstruction below is
 * pure and needs `@prl/poker-engine` for card parsing and position labels. Importing the engine
 * into a client component would put the shuffler, the commitment and `HandState` one careless
 * `import` away from the browser bundle. So the pages call this on the server and hand the finished
 * views down as props: the client component receives plain data and can address none of the engine.
 *
 * (`CommitmentVerifier` is the one deliberate exception. It has to run `verifyDeckReveal` in the
 * browser, which is the whole point of it, and that is stated in its own header.)
 *
 * ## What the review payload does and does not carry
 *
 * `HandReviewResponse` was designed for the analysis, not for a table, and three things a
 * `PlayerView` needs are simply not in it. Each is derived below, and each derivation is stated
 * because a reader of a replay is entitled to know which figures are the server's and which are
 * this module's arithmetic:
 *
 *  1. **Which seat is the viewer.** There is no `isSelf` on `HandReviewSeat` and no `viewerSeat` on
 *     the response. It is recovered from the rule the builder itself follows — only the requesting
 *     user's own decisions are analysed — so the seat that owns an analysed decision is the viewer.
 *     Two fallbacks follow for the case where none of their decisions got a report.
 *  2. **The blinds, and the button.** No `TableConfig`, no `buttonSeat`. Both are recovered from
 *     the forced bets, which are themselves recovered as described below.
 *  3. **The forced bets.** No row exists for them: `prl.hand_actions` holds voluntary actions only.
 *     But `seats[].net` plus `amountPaid` pins them down. For any seat that did not win chips,
 *     `-net - paid` IS that seat's forced bet, exactly. The seats that did win are the remainder of
 *     `decisions[0].potBefore`, which is the server's own figure for what was in the middle before
 *     anybody acted. With one winner — every hand that is not a split pot — the recovery is exact.
 *
 * All three would be better fixed in the contract, and that is reported rather than worked around
 * permanently. Until then the derivations are exact for every hand this app can produce, and the
 * one figure that could drift is checked rather than trusted: `potDerivationDisagrees` compares the
 * reconstructed pot against the server's `potBefore` at every step, and the replay says so on
 * screen if they ever differ.
 *
 * ## What the pot readout uses
 *
 * The server's `decisions[k].potBefore`, always — it comes from the engine's own running total.
 * The reconstruction is used only for the per-seat stacks and street commitments, which have no
 * server-side equivalent. Where a figure exists on the wire, this module does not recompute it.
 *
 * Pure and server-safe: no state, no effects, no `window`.
 */

import type { CoachReport, HandReviewDecision, HandReviewResponse } from '@prl/contracts';
import type { PlayerView, SeatStatus, SeatView, Street } from '@prl/poker-engine';
import { parseCards, positionLabels } from '@prl/poker-engine';

/** Board cards in play on each betting street. */
const BOARD_LENGTH: Readonly<Record<string, number>> = { preflop: 0, flop: 3, turn: 4, river: 5 };

/** The betting streets, in order. Anything outside this list is not a decision point. */
const BETTING_STREETS: readonly Street[] = ['preflop', 'flop', 'turn', 'river'];

export interface ReplayStep {
  /** 0-based position in the timeline. */
  readonly index: number;
  /** The decision this step is positioned *before*, or null for the terminal frame. */
  readonly decision: HandReviewDecision | null;
  /** The table as it stood at this point. */
  readonly view: PlayerView;
  /** True when the decision belongs to the reader, which is the only case with an analysis. */
  readonly isViewerDecision: boolean;
  /** The analysis for this decision, or null. Lifted out so the timeline can mark which steps have one. */
  readonly analysis: CoachReport | null;
}

export interface ReplayStreet {
  /** `preflop` … `river`, or `settled` for the terminal frame. */
  readonly key: string;
  /** `PREFLOP`, `FLOP`, `SHOWDOWN`, `FOLDED` — what the spine prints. */
  readonly label: string;
  /** 1-based, for the `01 02 03` motif. */
  readonly position: number;
  /** Indexes into `steps`, in order. */
  readonly stepIndexes: readonly number[];
}

export interface HandReplay {
  readonly steps: readonly ReplayStep[];
  readonly streets: readonly ReplayStreet[];
  /** Null for a hand the reader did not play a seat in. */
  readonly viewerSeat: number | null;
  /** Display names by seat, for `PokerTable`. */
  readonly seatNames: Readonly<Record<number, string>>;
  /**
   * True when the reconstructed pot disagreed with the server's `potBefore` at any step. Surfaced
   * on screen rather than swallowed: a silent disagreement means every stack in the replay is
   * suspect, and the reader should know that rather than trust a wrong number.
   */
  readonly potDerivationDisagrees: boolean;
  /** True when the forced-bet recovery had to split a remainder between several winning seats. */
  readonly forcedBetsApproximate: boolean;
}

/** Working per-seat tally, rebuilt from the action log rather than read from anywhere. */
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
 * Which seat belongs to the reader.
 *
 * Preference order, most reliable first: the seat that owns an analysed decision (the builder
 * analyses nobody else's), the single human seat, then the seat whose net matches the summary's
 * `heroNet`. Null when none of the three settles it, which makes the replay a spectator view rather
 * than a wrong one.
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

/** See the header: `-net - paid` is exact for a seat that won nothing; winners take the remainder. */
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
  // One winner is the normal case and the split is then exact. Several winners means a split pot,
  // and dividing the remainder equally is right for a symmetric chop and an approximation
  // otherwise — which is why the flag exists rather than the guess being silent.
  const share = Math.floor(remainder / unresolved.length);
  for (const seat of unresolved) bySeat.set(seat, share);
  return { bySeat, approximate: unresolved.length > 1 };
}

/** Blinds recovered from the forced bets: the smallest positive is the small blind, the largest the big. */
function recoverBlinds(forced: ReadonlyMap<number, number>): { small: number; big: number } {
  const positive = [...forced.values()].filter((amount) => amount > 0).sort((a, b) => a - b);
  const smallest = positive[0];
  const largest = positive[positive.length - 1];
  if (smallest === undefined || largest === undefined) return { small: 0, big: 0 };
  return { small: smallest, big: largest };
}

/**
 * The button, recovered from who posted what.
 *
 * Three or more handed the button posts nothing, so it is the dealt seat with a forced bet of zero.
 * Heads-up both blinds are posted and the button is the small blind, so it is the seat with the
 * smaller one. Ties fall back to the lowest seat index, which affects only the dealer badge and the
 * position labels.
 */
function recoverButtonSeat(review: HandReviewResponse, forced: ReadonlyMap<number, number>): number {
  const dealt = review.seats.filter((seat) => seat.startingStack > 0);
  const zeroPosters = dealt.filter((seat) => (forced.get(seat.seat) ?? 0) === 0);
  const onlyZero = zeroPosters[0];
  if (zeroPosters.length === 1 && onlyZero !== undefined) return onlyZero.seat;
  const sorted = [...dealt].sort(
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
      // Opaque ids never leave the server, and `PokerTable` takes names from `seatNames` instead.
      playerId: `review-seat-${seat.seat}`,
      stack,
      committedThisStreet: tally?.committedThisStreet ?? 0,
      committedTotal: tally?.committedTotal ?? 0,
      status,
      position: labels.get(seat.seat) ?? null,
      // Straight through from the server. `holeCards` is already the redacted value: null means
      // "you are not entitled to see these", and it stays null for a seat that folded and never
      // showed, even now the hand is over.
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
      // Antes are not separable from blinds in a recovery based on totals, and no room in this app
      // is configured with one. A hand that had one would show its ante folded into the blinds.
      ante: 0,
      maxSeats: Math.max(2, Math.min(6, review.seats.length)),
      // Not carried by the review payload and not rendered. Zero is the inert value; a plausible
      // 30 would be a number somebody could mistake for a fact.
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
    // One main pot. Side pots need the engine's own layering over live seat state, and neither the
    // review payload nor this reconstruction can distinguish a layer boundary from a short call.
    // Every seat's contribution is still visible on its own plate.
    pots: [{ amount: potTotal, eligibleSeats: contested.map((seat) => seat.seat), capPerSeat, index: 0 }],
    forcedBets: [],
    actions: [],
    actionSequence: input.actionSequence,
    // A replay is read-only. An empty list is what makes `ActionBar` render its idle state, and it
    // is the honest value: nobody is being asked to act in a hand that finished.
    legalActions: [],
    amountToCall: owed,
    commitmentRoot: review.commitmentRoot,
    commitmentContext: review.commitmentContext,
    // The reveal lives on the response, not in here: `HandResult` also wants showdown scores and pot
    // awards, and inventing them to fill a field nothing reads would be inventing a result.
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
}

interface WalkResult {
  readonly steps: readonly ReplayStep[];
  readonly street: Street;
  readonly potInMiddle: number;
  /** True if the reconstruction and the server's `potBefore` ever disagreed. */
  readonly disagrees: boolean;
}

/**
 * Walks the action log, snapshotting the table *before* each decision.
 *
 * Split out of `buildHandReplay` because it is the only part with mutable state, and keeping that
 * state inside one function makes the invariant checkable by reading: `tallies` is mutated after a
 * snapshot is taken, never before, so no step can show a stack that already includes the action the
 * reader is about to watch.
 */
function walkDecisions(input: WalkInput): WalkResult {
  const { review, decisions, tallies, board, viewerSeat, buttonSeat, labels, blinds } = input;
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
        // The server's figure, not the reconstruction's. See the header.
        potTotal: decision.potBefore,
        toAct: decision.seat,
        viewerSeat,
        buttonSeat,
        labels,
        blinds,
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

/** Sweeps the finished street's bets into the middle and returns what moved. */
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

/** Builds the whole replay. Never throws: a hand it cannot read produces a replay with no steps. */
export function buildHandReplay(review: HandReviewResponse): HandReplay {
  const decisions = [...review.decisions].sort((a, b) => a.sequence - b.sequence);
  const viewerSeat = findViewerSeat(review);
  const forced = recoverForcedBets(review);
  const blinds = recoverBlinds(forced.bySeat);
  const buttonSeat = recoverButtonSeat(review, forced.bySeat);
  const board = parseNotation(review.hand.board) ?? [];

  const seatNames: Record<number, string> = {};
  for (const seat of review.seats) seatNames[seat.seat] = seat.displayName;

  const occupied = review.seats.filter((seat) => seat.startingStack > 0).map((seat) => seat.seat);
  // Typed as the seat view's own `position` union rather than `string`, so no cast is needed where
  // it is read: `positionLabels` returns exactly that union, and the empty fallback adopts it.
  let labels: ReadonlyMap<number, SeatView['position']>;
  try {
    labels =
      occupied.length >= 2
        ? positionLabels(buttonSeat, Math.max(2, Math.min(6, review.seats.length)), occupied)
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
  });
  const steps: ReplayStep[] = [...walk.steps];
  const disagrees = walk.disagrees;
  potInMiddle = walk.potInMiddle;

  // The terminal frame. Worth a step of its own: it is the only place the reader sees the final
  // stacks, and a replay that stops at the last decision never shows what the hand cost.
  potInMiddle += sweepStreet(tallies);
  const terminalStreet: Street = review.hand.completedAt === null ? walk.street : 'complete';
  steps.push({
    index: steps.length,
    decision: null,
    view: buildView({
      review,
      tallies,
      street: terminalStreet,
      potTotal: review.hand.potTotal,
      toAct: null,
      viewerSeat,
      buttonSeat,
      labels,
      blinds,
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

/** Groups the steps into the spine's street blocks, in the order they occurred. */
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
