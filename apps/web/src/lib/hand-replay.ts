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
 * (`CommitmentVerifier` is the one deliberate exception, through `lib/deck-proof.ts`. It has to run
 * `verifyDeckReveal` in the browser, which is the whole point of it, and that is stated in both of
 * their headers.)
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
 *  2. **The blinds, and the button.** No `TableConfig`, no `buttonSeat`, and — since the
 *     dead-button rule landed — no way to derive either from the other. See the next section.
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
 * ## Positions are recovered, not derived from the button
 *
 * Under the dead-button rule (`packages/poker-engine/src/positions.ts`) the big blind advances by
 * one live player per hand, the small blind may be DEAD — nobody posts it — and the button may sit
 * in an empty chair. `button + 1` and `button + 2` are then simply not the blinds, and a replay
 * that let `positionLabels` derive them badged the big-blind payer 'SB' and a player who posted
 * nothing 'BB'. So the blinds are recovered here and passed to `positionLabels` explicitly, which
 * is the argument it grew for exactly this case:
 *
 *   - the BIG BLIND is read off who opened the action. The server opens preflop betting on the seat
 *     after the big blind (`firstToActPreflopFor`), and heads-up on the button, which is the small
 *     blind — so in both cases the big blind is the dealt seat immediately BEFORE the first
 *     decision. That is exact, and it needs no reference to the button;
 *   - the SMALL BLIND is the dealt seat before the big blind, and it is live only if it actually put
 *     chips in. A dead small blind reads as `null`, not as a seat that posted nothing;
 *   - the BUTTON follows from those: the seat before a live small blind, or — when the small blind
 *     is dead, and the chair it would have sat in is therefore empty — the seat before the big
 *     blind. Both are exact whenever the button itself is live. A DEAD button cannot be recovered
 *     from this payload at all: nothing on the wire distinguishes it from a live one, so the badge
 *     lands on the seat before the blinds. That is the one position this module can still get
 *     wrong, and the fix for it is `buttonSeat` on `HandReviewResponse`.
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
import { orderFrom, parseCards, positionLabels } from '@prl/poker-engine';

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

/**
 * The seats the blinds fell on.
 *
 * `smallBlindSeat` is null for a DEAD small blind — nobody posted it. That is an ordinary outcome
 * of the dead-button rule rather than a missing value, and it is spelled the way the engine spells
 * it (`HandState.smallBlindSeat`) so it can be handed straight to `positionLabels`.
 */
interface BlindSeats {
  readonly smallBlindSeat: number | null;
  readonly bigBlindSeat: number;
}

/**
 * The dealt seat immediately before `from`, clockwise, or null when there is none.
 *
 * `orderFrom` walks a FULL orbit and returns an occupied `from` as its LAST element — its own
 * header says so — which makes the element before that the seat immediately preceding `from`, and a
 * last element that is not `from` means `from` was never dealt in.
 */
function previousDealt(from: number, maxSeats: number, dealt: readonly number[]): number | null {
  const orbit = orderFrom(from, maxSeats, dealt);
  if (orbit[orbit.length - 1] !== from) return null;
  return orbit[orbit.length - 2] ?? null;
}

/**
 * Which seats posted the blinds. See the header for why this is read rather than derived.
 *
 * Null when the payload carries no anchor to read it from — no decisions, or a first decision that
 * is not preflop — in which case the callers below fall back to what the forced bets alone say.
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
  // Posted nothing means the small blind was dead: the chair it belongs in is empty, and the dealt
  // seat before the big blind is somebody else — the button, usually. It is NOT a small blind that
  // happens to have paid zero, and labelling it 'SB' is the bug this recovery exists to stop.
  const posted = candidate === null ? 0 : (forced.get(candidate) ?? 0);
  return { smallBlindSeat: posted > 0 ? candidate : null, bigBlindSeat };
}

/**
 * The blind amounts for the replay's `TableConfig`.
 *
 * Taken from the seats that posted them rather than from the sorted list of forced bets, because
 * with a dead small blind there is only ONE forced bet and "smallest positive, largest positive"
 * then reports the big blind as both — a hand played 5/10 rendered as a 10/10 game. A dead small
 * blind has no amount to report, so it reads as the inert 0 rather than as a plausible figure a
 * learner could mistake for the table's stakes.
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
 * The button, from the blinds where they are known and from who posted what where they are not.
 *
 * The blinds are the reliable route: heads-up the button IS the small blind, and otherwise the
 * button is the dealt seat before the small blind — or, when the small blind is dead and its chair
 * is therefore empty, the dealt seat before the big blind. The dead-button rule guarantees no dealt
 * seat sits between the button and the small blind, so both readings are exact whenever the button
 * is live; a dead button is not distinguishable here at all (see the header).
 *
 * The fallback is the older reading and stays for the hands with no decisions to anchor on: three
 * or more handed the button posts nothing, heads-up it posts the smaller blind. Ties fall back to
 * the lowest seat index, which affects only the dealer badge and the position labels.
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
      maxSeats: input.maxSeats,
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
  readonly maxSeats: number;
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
        // The server's figure, not the reconstruction's. See the header.
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
 * Settles the tallies for the terminal frame: every seat's stack AFTER the pot has been awarded.
 *
 * ## The defect this exists for
 *
 * `Tally.stack` is only ever `startingStack − posted − Σ amountPaid`. It goes down as the hand is
 * walked and nothing ever puts anything back, because a decision list carries what was *paid* and
 * never what was *won*. The terminal frame therefore drew every seat's stack at the moment before
 * the pot moved — and the comment above it said, and still says, that this frame "is the only
 * place the reader sees the final stacks".
 *
 * Measured on `/review/hand-0042` in Chrome 151, walking to Step 11 of 11 through the product's own
 * "Next decision" button: the winner's plate read `STACK 245`, the loser's plate read `STACK 245`,
 * `StepMetrics` read `YOUR STACK 245 UNITS`, and on the same screen the page head read
 * `NET TO YOU +765 units GAINED` and the result row read `You +765 units GAINED`. The reader began
 * the hand with 1,000, won 765, and was shown 245 — the same figure as the seat they beat.
 *
 * `HandReviewSeat.net` is the server's own settled figure and is already on the wire (it is what
 * `ResultRow` prints), so the final stack is `startingStack + net` and is not reconstructed here.
 * It is applied only when the hand actually completed: an abandoned hand has no award to add, and
 * `net` for one would describe a settlement that never happened.
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

/**
 * How many chairs the table has, as the seat arithmetic needs it.
 *
 * The HIGHEST seat index in the hand plus one, not the NUMBER of seats. Every walk round the table
 * is `(seat + step) % maxSeats`, so a table sized by the count can never reach a seat above it: a
 * hand at seats 0, 1 and 3 sized as 3 leaves seat 3 unreachable, and `positionLabels` then labels
 * two of the three players and silently drops the rest of the orbit. A player leaving a six-max
 * table does not make the table smaller.
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

  const occupied = review.seats
    .filter((seat) => seat.startingStack > 0)
    .map((seat) => seat.seat)
    .sort((a, b) => a - b);
  const blindSeats = recoverBlindSeats(forced.bySeat, occupied, maxSeats, decisions[0]);
  const blinds = recoverBlindAmounts(forced.bySeat, blindSeats);
  const buttonSeat = recoverButtonSeat(review, forced.bySeat, occupied, maxSeats, blindSeats);

  // Typed as the seat view's own `position` union rather than `string`, so no cast is needed where
  // it is read: `positionLabels` returns exactly that union, and the empty fallback adopts it.
  //
  // The blinds are passed in rather than left to be derived. Deriving them from the button is only
  // right while the button determines them, which the dead-button rule ended — and it is also the
  // one path that throws, on a button sitting in an empty chair.
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

  // The terminal frame. Worth a step of its own: it is the only place the reader sees the final
  // stacks, and a replay that stops at the last decision never shows what the hand cost.
  //
  // `settleTallies` is what makes that sentence true — see its header for the measurement. The
  // walked tallies are the stacks BEFORE the pot was awarded, and drawing them here showed a
  // winner sitting at the same figure as the seat they had just beaten.
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
