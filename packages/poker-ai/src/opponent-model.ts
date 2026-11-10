/**
 * What a seat has been *seen* to do, and what a policy is allowed to conclude from it.
 *
 * This is the file that gives `traits.exploitativeAdaptation` something to act on. It is
 * also the easiest place in the whole feature to accidentally cheat, so most of the design
 * below is about making cheating unrepresentable rather than merely absent.
 *
 * ## 1. The input types are the information boundary
 *
 * Two entry points take data in, and neither of them *can* carry a hidden card:
 *
 *   - `observeHandComplete` takes a **`PlayerView`, never a `HandState`**. This is the
 *     single most important line in the file. `PlayerView` is the output of
 *     `redactFor(state, { viewerSeat })`, and its `result.showdowns` list holds exactly the
 *     hands that were actually turned over. A hand that ends when everybody folds produces
 *     an empty showdown list, so nothing is recorded — which is correct, and a serious leak
 *     if gotten wrong: knowing whether a folder was bluffing is the information the game is
 *     played over. Taking a `HandState` here would hand this module the deck, the deck
 *     cursor, the commitment salts and every seat's hole cards, and the only thing between
 *     that and a cheating opponent model would be a reviewer's attention.
 *
 *   - `observeAction` takes a `PublicActionEvent`, which has no card field. Not "a field
 *     callers are asked not to fill" — no field at all. The event is built by whatever
 *     drives the match, which on the server legitimately holds the whole `HandState`; the
 *     point is that a privileged builder still has nowhere to put a secret. Every field on
 *     it (who acted, on which street, what it cost, what the pot was, whether a raise was
 *     legal) is something every seat at a real table can see.
 *
 * `test/opponent-model.test.ts` asserts the fold-out case directly, and asserts that two
 * different seats' views of the same hand produce identical observations — which is what
 * "public information only" actually means, and is a stronger claim than any type gives.
 *
 * The trap that was specifically avoided: `SeatView.holeCards` is **not** the source of
 * showdown hands. It is non-null for the recipient's own seat at all times, so building
 * `showdownHands` from `view.seats` would quietly record the observer's own cards on every
 * hand, including hands that never reached a showdown. The cards come from
 * `view.result.showdowns`, which the engine populates only for seats that showed.
 *
 * ## 2. Immutable updates, because observations are shared
 *
 * One `OpponentObservations` is attached to a match and read by several policies during the
 * same hand. Shared mutable counters would produce cross-contamination that is very hard to
 * trace: seat 3's policy increments a counter, seat 4's policy sees a different table than
 * the one it was handed, and the bug reproduces only under a particular seating order. So
 * every function here returns a new object, every update rebuilds the `Map`, and what comes
 * back is `Object.freeze`d so a caller that tries to mutate shared state fails at the point
 * of the mistake rather than somewhere downstream.
 *
 * `Object.freeze` on a `Map` does not block `map.set`, so the freeze is not the guarantee —
 * rebuilding is. The freeze catches the other half (pushing onto `betSizeSamples`, patching
 * a counter) and costs nothing at these sizes. `OpponentModel` at the bottom of the file is
 * the one mutable thing here, and it is a handle that swaps whole snapshots, not a mutable
 * counter.
 *
 * ## 3. Bounded memory, because a session is long
 *
 * `betSizeSamples` and `showdownHands` are bounded windows: newest last, oldest dropped at
 * the cap. An unbounded history is a slow memory leak that only shows up in the sessions
 * you most want to work — a learner playing a few hundred hands against six seats. The caps
 * are 64 and 32, and each says on itself why that number and what the cap costs.
 *
 * ## 4. Per-hand counters versus per-action counters
 *
 * `vpip` is a share of *hands*, not of actions. A seat that calls preflop and then calls
 * again facing a 3-bet has entered one pot, not two. So the two kinds of counter are moved
 * by different functions, and the split is a feature rather than an accident:
 *
 *   - The four per-hand counters (`handsSeen`, `handsVoluntarilyEntered`, `preflopRaises`,
 *     `showdownsReached`) are moved by `observeHandComplete`, which derives them from
 *     `view.actions` — the public action log the view already carries. It needs nothing
 *     else, so **a caller that only ever hands over completed views still gets correct
 *     entry statistics.**
 *   - The per-action counters (`bets` … `timesFacingBet`, `betSizeSamples`) are moved by
 *     `observeAction`, because they need the price and the pot at the moment of the action,
 *     which the log does not carry and which a caller has for free at decision time.
 *
 * A caller that provides only views therefore gets entry statistics and *zero* aggression
 * statistics — which is honest degradation. The alternative was to reconstruct the price and
 * the legality of a raise by replaying the log against a copy of the betting rules, and a
 * second implementation of `mayRaise` that drifts from `betting.ts` would be worse than an
 * absent statistic in every way.
 *
 * The denominator for `vpip` and `pfr` is **hands in which this seat was seen to act before
 * the flop**, not hands dealt. `stats.ts` explains the trap at length and it applies
 * unchanged here: the button rotates, a seat in the blinds frequently never gets a turn, and
 * dividing by hands dealt blends the seat's entry threshold with the rate at which the table
 * denied it a decision.
 *
 * ## 5. A small sample is the lesson, not an inconvenience
 *
 * The whole app teaches that a small sample says very little, so this module must not
 * pretend to know things after twelve hands. Three mechanisms, in increasing strength:
 *
 *   - `derivedStats` returns **`null`** below `MINIMUM_HANDS_FOR_STATS` (20). At 20 hands
 *     the 95% half-width on any frequency is already ±0.22, so the interval is wider than
 *     the entire span of styles the profile set contains (VPIP 0.15 to 0.50). A number there
 *     could only mislead, and `null` says "unknown" in the type rather than in a footnote.
 *   - `reliability` bands the sample: `insufficient` / `indicative` / `reasonable`. There is
 *     deliberately no band above `reasonable`. Counting public actions never earns "certain".
 *   - `readWeight` multiplies `exploitativeAdaptation` by a reliability weight, and **both**
 *     channels out of this module go through it: `exploitAdjustments` for the multipliers and
 *     `estimateRange` for the assumed range. An `insufficient` sample therefore produces
 *     exactly neutral multipliers *and* exactly the neutral range, however high
 *     `exploitativeAdaptation` is. The learner still sees the frequencies and the interval —
 *     that is the teaching moment — but the model does not act on them. Gating one channel
 *     and not the other is the failure this is written down to prevent: the range is the
 *     larger of the two effects, because a decision is priced against it.
 *
 * ## 6. What this model is not
 *
 * It is frequency counting. There is no prior, no posterior and no per-statistic uncertainty
 * model; the confidence half-width is the worst-case binomial interval at p = 0.5 over the
 * observed hand count, conservative and deliberately one number so nobody reads the
 * narrowest of seven intervals. `estimateRange` maps one tightness number onto a
 * top-percentage slice of a *computed* strength ordering (`topPercentRange` in
 * `@prl/poker-math`, measured from all-in equity against a random hand, never transcribed
 * from a published chart). It knows nothing about board texture, and it does not remove
 * hands an earlier line rules out. Every figure it produces carries that in `assumptions`.
 *
 * Nothing in this file scores a decision, and nothing in it describes a person. The
 * learner-facing strings are third-person statements about the model and go through
 * `assertNoImpersonation` at generation time, not in a test.
 */

import { cardToString, type PlayerView } from '@prl/poker-engine';
import { type ParsedRange, topPercentRange } from '@prl/poker-math';
import { assertNoImpersonation } from './labelling.ts';
import { normalTwoSidedCriticalValue } from './stats.ts';

export class ObservationError extends Error {
  override readonly name = 'ObservationError';
}

// ---------------------------------------------------------------------------
// Bounds, bands and reference points — all named, all justified
// ---------------------------------------------------------------------------

/**
 * How many bet sizes are kept per seat.
 *
 * 64 is enough for the mean to mean something: the standard error of a mean over 64 samples
 * is an eighth of the per-sample spread, which separates "this seat bets a third of the pot"
 * from "this seat bets three quarters of it" comfortably. It is also small enough that six
 * seats hold at most 384 numbers no matter how long the session runs.
 *
 * The cap has a consequence worth stating rather than discovering: the average is a
 * **window** average over recent sizing, not a lifetime one. For an opponent model that is
 * the more useful statistic anyway — a seat that changed gear fifty hands ago should read as
 * its current gear — but `averageBetSizeAsPotFraction` says so in its own assumptions.
 */
export const BET_SIZE_SAMPLE_CAP = 64;

/**
 * How many shown-down hands are kept per seat.
 *
 * Showdowns are rare — a seat shows maybe one hand in four or five — so 32 covers something
 * like 150 hands of history, which is past the point where `reliability` reaches
 * `reasonable`. Each entry is two short strings, so the worst case for a six-seat table is a
 * few hundred small strings.
 */
export const SHOWDOWN_HAND_CAP = 32;

/**
 * Below this many observed hands, `derivedStats` returns `null` rather than a frequency.
 *
 * At n = 20 the 95% half-width at the worst case p = 0.5 is 1.96 x 0.5 / sqrt(20) = 0.219.
 * The profile set spans VPIP 0.15 to 0.50, a range of 0.35 — narrower than the 0.44-wide
 * interval a 20-hand sample carries. So below 20 hands every observed frequency is
 * consistent with every style in the game, and returning a number would be inventing a read.
 * Twelve hands, the figure the brief calls out, is comfortably inside this floor.
 */
export const MINIMUM_HANDS_FOR_STATS = 20;

/**
 * At 40 hands the half-width falls to 0.155, so the interval (0.31 wide) finally fits inside
 * the 0.35 span of styles and the extremes become separable. That is what `indicative`
 * means: tight can be told from loose, and nothing finer.
 */
export const INDICATIVE_MINIMUM_HANDS = 40;

/**
 * At 150 hands the half-width is 0.080, so two styles about 0.16 apart are separable —
 * roughly the gap between neighbouring profiles rather than opposite ones. That is what
 * `reasonable` means. It is the top band on purpose: there is no `certain`.
 */
export const REASONABLE_MINIMUM_HANDS = 150;

export const RELIABILITY_LEVELS = ['insufficient', 'indicative', 'reasonable'] as const;

/** How much of a read the sample size supports. Never rises above `reasonable`. */
export type Reliability = (typeof RELIABILITY_LEVELS)[number];

/**
 * How much of the raw adjustment survives at each band.
 *
 * `insufficient` is 0 rather than "a little", because a little of a meaningless number is
 * still meaningless, and a model that leans on a 25-hand sample is exactly the mistake this
 * app exists to teach against.
 */
const RELIABILITY_WEIGHT: Readonly<Record<Reliability, number>> = {
  insufficient: 0,
  indicative: 0.5,
  reasonable: 1,
};

/** 1.959963…, the 95% multiplier. Shared with `stats.ts` so the two agree exactly. */
const Z_95 = normalTwoSidedCriticalValue(0.05);

/**
 * The tightness assumed when there is no usable sample: `baselineTraits().vpip` of 0.25,
 * expressed as tightness. Using the baseline profile's own entry rate keeps the neutral
 * assumption consistent with the rest of the package rather than inventing a second one.
 */
const NEUTRAL_TIGHTNESS = 0.75;

/** Reference points the raw exploit signals are measured against. */
const NEUTRAL_FOLD_TO_BET = 0.45;
const NEUTRAL_AGGRESSION = 0.5;
const NEUTRAL_SHOWDOWN_RATE = 0.28;
const NEUTRAL_LIMP_RATE = 0.08;

// ---------------------------------------------------------------------------
// What goes in: public actions only
// ---------------------------------------------------------------------------

export const OBSERVABLE_STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export type ObservableStreet = (typeof OBSERVABLE_STREETS)[number];

export const OBSERVABLE_ACTIONS = ['fold', 'check', 'call', 'bet', 'raise'] as const;
export type ObservableAction = (typeof OBSERVABLE_ACTIONS)[number];

/**
 * One action, as everybody at the table saw it.
 *
 * There is deliberately no field for a card, a deck, a cursor or a salt. That is the whole
 * security property of this module: the builder of these events may hold privileged state,
 * and still has nowhere to put a secret.
 *
 * The fields are unioned rather than loosely typed as `string` because a caller constructing
 * an event already holds the engine's own `BettingStreet` and `ActionType`, which are these
 * exact unions — so the stronger type costs nothing and buys exhaustiveness.
 * (`estimateRange` goes the other way, and says why on its own signature.)
 */
export interface PublicActionEvent {
  /** Which hand this action belongs to, so a hand cannot be counted twice. */
  readonly handId: string;
  readonly seat: number;
  readonly street: ObservableStreet;
  readonly action: ObservableAction;
  /**
   * Chips this seat had to add to match the bet, 0 when checking was free. Only its sign is
   * consumed — "was this seat facing a bet" — so a builder that cannot cap it at the seat's
   * stack may leave it uncapped.
   */
  readonly toCall: number;
  /** Total pot before the action, including this street's commitments. */
  readonly potBefore: number;
  /** Chips this action actually moved from stack to pot. */
  readonly amountPaid: number;
  /** True when the preflop bet level was above the big blind, i.e. facing a raise. */
  readonly facingPreflopRaise: boolean;
  /**
   * True when the engine offered this seat a bet or a raise. It is the denominator of the
   * 3-bet rate, and it is not the same as "the seat had chips": after a short all-in
   * `mayRaise` is false and re-raising is genuinely unavailable, so counting that turn as a
   * declined 3-bet opportunity would understate the seat's 3-bet frequency. Read it off
   * `view.legalActions` or `legalActions(state, seat)`; never guess it.
   */
  readonly raiseWasAvailable: boolean;
}

// ---------------------------------------------------------------------------
// What is accumulated
// ---------------------------------------------------------------------------

/** One hand a seat actually turned over, with the public fact of who drove the betting. */
export interface ShownHand {
  readonly cards: readonly string[];
  readonly wasAggressor: boolean;
}

/**
 * Counters over PUBLIC actions only. There is deliberately no field for a card, except
 * `showdownHands`, which holds only hands that were actually turned over.
 *
 * Which counters move when: see §4 of the module comment. In short, `observeHandComplete`
 * moves the four per-hand counters and appends to `showdownHands`; `observeAction` moves
 * everything else.
 */
export interface SeatObservations {
  readonly seat: number;
  /**
   * Hands in which this seat was seen to act before the flop. NOT hands dealt: a seat that
   * never got a turn cannot have declined to enter, and counting those hands would measure
   * button rotation instead of the seat's entry threshold.
   */
  readonly handsSeen: number;
  /**
   * Of those, hands in which it called, bet or raised preflop. Checking the big-blind option
   * is not entering: those chips were forced in.
   */
  readonly handsVoluntarilyEntered: number;
  /**
   * Of those, hands in which it bet or raised preflop. A **hand** count, not an action count
   * — the name is ambiguous and this is the reading that keeps `pfr <= vpip` true by
   * construction. Preflop raise *actions* are inside `bets` and `raises`.
   */
  readonly preflopRaises: number;
  readonly threeBets: number;
  readonly threeBetOpportunities: number;
  readonly bets: number;
  readonly raises: number;
  readonly calls: number;
  readonly checks: number;
  readonly folds: number;
  readonly foldsFacingBet: number;
  readonly timesFacingBet: number;
  readonly showdownsReached: number;
  /** Bet sizes seen, as pot fractions. Bounded window of `BET_SIZE_SAMPLE_CAP`, newest last. */
  readonly betSizeSamples: readonly number[];
  /**
   * Only hands actually SHOWN at showdown. Never inferred, never peeked. Bounded window of
   * `SHOWDOWN_HAND_CAP`, newest last.
   */
  readonly showdownHands: readonly ShownHand[];
}

/**
 * Which hand is being observed, and whether it has been folded into the counters.
 *
 * Carries no card and no per-seat state — an id and a flag. It exists so that a hand cannot
 * be counted twice and so that a caller feeding actions out of order gets an error rather
 * than a quietly wrong denominator. Double counting is the one bug here that corrupts every
 * rate at once while looking completely normal.
 */
export interface HandProgress {
  readonly handId: string;
  readonly completed: boolean;
}

export interface OpponentObservations {
  readonly bySeat: ReadonlyMap<number, SeatObservations>;
  /** Hands folded into the counters by `observeHandComplete`. Per-seat counts are `handsSeen`. */
  readonly handsObserved: number;
  readonly currentHand: HandProgress | null;
}

export function emptyObservations(): OpponentObservations {
  return freezeObservations({ bySeat: new Map(), handsObserved: 0, currentHand: null });
}

function freezeObservations(observations: OpponentObservations): OpponentObservations {
  if (observations.currentHand !== null) Object.freeze(observations.currentHand);
  return Object.freeze(observations);
}

/**
 * Freezes a seat record and everything reachable inside it.
 *
 * Cheap at these sizes (at most 64 numbers and 32 two-string entries) and worth it: a policy
 * that tries to push a sample onto a shared window throws at the push instead of corrupting
 * another policy's view of the table.
 */
function freezeSeat(seat: SeatObservations): SeatObservations {
  Object.freeze(seat.betSizeSamples);
  for (const entry of seat.showdownHands) {
    Object.freeze(entry.cards);
    Object.freeze(entry);
  }
  Object.freeze(seat.showdownHands);
  return Object.freeze(seat);
}

function emptySeatObservations(seat: number): SeatObservations {
  return freezeSeat({
    seat,
    handsSeen: 0,
    handsVoluntarilyEntered: 0,
    preflopRaises: 0,
    threeBets: 0,
    threeBetOpportunities: 0,
    bets: 0,
    raises: 0,
    calls: 0,
    checks: 0,
    folds: 0,
    foldsFacingBet: 0,
    timesFacingBet: 0,
    showdownsReached: 0,
    betSizeSamples: [],
    showdownHands: [],
  });
}

/**
 * Appends to a bounded window, dropping the oldest entry at the cap.
 *
 * Not a true ring buffer, and calling it one would mislead: a ring buffer exists to avoid
 * reallocating, and every update here allocates anyway because the structure is immutable
 * (§2). What is preserved is the property that actually matters — the length never exceeds
 * `cap`, whatever the session length.
 */
function pushBounded<T>(window: readonly T[], value: T, cap: number): readonly T[] {
  if (cap < 1) throw new ObservationError(`a bounded window needs a cap of at least 1, received ${cap}`);
  if (window.length < cap) return [...window, value];
  return [...window.slice(window.length - cap + 1), value];
}

// ---------------------------------------------------------------------------
// Observing
// ---------------------------------------------------------------------------

function assertNonNegativeNumber(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new ObservationError(`${field} must be a non-negative finite number, received ${String(value)}`);
  }
}

function validateEvent(event: PublicActionEvent): void {
  if (event.handId === '') throw new ObservationError('a public action event needs a handId');
  if (!Number.isInteger(event.seat) || event.seat < 0) {
    throw new ObservationError(`seat must be a non-negative integer, received ${String(event.seat)}`);
  }
  if (!OBSERVABLE_STREETS.includes(event.street)) {
    throw new ObservationError(
      `street must be one of ${OBSERVABLE_STREETS.join(', ')}, received "${String(event.street)}" — ` +
        'showdown and complete carry no action to observe',
    );
  }
  if (!OBSERVABLE_ACTIONS.includes(event.action)) {
    throw new ObservationError(
      `action must be one of ${OBSERVABLE_ACTIONS.join(', ')}, received "${String(event.action)}"`,
    );
  }
  assertNonNegativeNumber(event.toCall, 'toCall');
  assertNonNegativeNumber(event.potBefore, 'potBefore');
  assertNonNegativeNumber(event.amountPaid, 'amountPaid');
}

/**
 * Checks that this event belongs to a hand that is still open.
 *
 * Rejecting rather than silently reopening a finished hand is the point: re-observing a hand
 * doubles every per-action counter it contributed to, which is invisible in review and shows
 * up as a model that is confidently wrong about every opponent.
 */
function assertHandIsOpen(observations: OpponentObservations, handId: string): void {
  const current = observations.currentHand;
  if (current === null || current.handId !== handId) return;
  if (current.completed) {
    throw new ObservationError(
      `hand ${handId} was already folded into the counters by observeHandComplete, so observing ` +
        'another of its actions would double-count every rate it contributed to',
    );
  }
}

function applyEventToSeat(previous: SeatObservations, event: PublicActionEvent): SeatObservations {
  const aggressive = event.action === 'bet' || event.action === 'raise';
  const facingBet = event.toCall > 0;
  // A 3-bet opportunity needs both halves: facing a raise, and a re-raise actually legal.
  const threeBetSpot = event.street === 'preflop' && event.facingPreflopRaise && event.raiseWasAvailable;
  const sized = aggressive && event.potBefore > 0;
  return freezeSeat({
    seat: previous.seat,
    handsSeen: previous.handsSeen,
    handsVoluntarilyEntered: previous.handsVoluntarilyEntered,
    preflopRaises: previous.preflopRaises,
    threeBets: previous.threeBets + (threeBetSpot && aggressive ? 1 : 0),
    threeBetOpportunities: previous.threeBetOpportunities + (threeBetSpot ? 1 : 0),
    bets: previous.bets + (event.action === 'bet' ? 1 : 0),
    raises: previous.raises + (event.action === 'raise' ? 1 : 0),
    calls: previous.calls + (event.action === 'call' ? 1 : 0),
    checks: previous.checks + (event.action === 'check' ? 1 : 0),
    folds: previous.folds + (event.action === 'fold' ? 1 : 0),
    foldsFacingBet: previous.foldsFacingBet + (facingBet && event.action === 'fold' ? 1 : 0),
    timesFacingBet: previous.timesFacingBet + (facingBet ? 1 : 0),
    showdownsReached: previous.showdownsReached,
    betSizeSamples: sized
      ? pushBounded(previous.betSizeSamples, event.amountPaid / event.potBefore, BET_SIZE_SAMPLE_CAP)
      : previous.betSizeSamples,
    showdownHands: previous.showdownHands,
  });
}

/** Records one public action. Returns a new object; the input is untouched. */
export function observeAction(
  observations: OpponentObservations,
  event: PublicActionEvent,
): OpponentObservations {
  validateEvent(event);
  assertHandIsOpen(observations, event.handId);

  const bySeat = new Map(observations.bySeat);
  const previous = bySeat.get(event.seat) ?? emptySeatObservations(event.seat);
  bySeat.set(event.seat, applyEventToSeat(previous, event));

  return freezeObservations({
    bySeat,
    handsObserved: observations.handsObserved,
    currentHand: { handId: event.handId, completed: false },
  });
}

/**
 * Which seat made the last bet or raise of the hand, or null if it was checked down.
 *
 * Public: read off the action log every seat can see. Used only to label a shown hand as the
 * aggressor's, which is what makes a showdown record teach anything — "this seat showed that
 * after driving the betting three streets" is a lesson; a bare pair of cards is not.
 */
function lastAggressorSeat(view: PlayerView): number | null {
  let seat: number | null = null;
  for (const logged of view.actions) {
    if (logged.action.type === 'bet' || logged.action.type === 'raise') seat = logged.seat;
  }
  return seat;
}

/** The three per-hand facts, derived from the public action log and nothing else. */
interface PreflopLatch {
  readonly enteredVoluntarily: boolean;
  readonly raisedPreflop: boolean;
}

function preflopLatches(view: PlayerView): ReadonlyMap<number, PreflopLatch> {
  const latches = new Map<number, PreflopLatch>();
  for (const logged of view.actions) {
    if (logged.street !== 'preflop') continue;
    const type = logged.action.type;
    const aggressive = type === 'bet' || type === 'raise';
    const previous = latches.get(logged.seat);
    latches.set(logged.seat, {
      // Calling, betting and raising are voluntary. Checking the big-blind option is not.
      enteredVoluntarily: (previous?.enteredVoluntarily ?? false) || aggressive || type === 'call',
      raisedPreflop: (previous?.raisedPreflop ?? false) || aggressive,
    });
  }
  return latches;
}

function assertHandNotAlreadyComplete(observations: OpponentObservations, handId: string): void {
  const current = observations.currentHand;
  if (current !== null && current.handId === handId && current.completed) {
    throw new ObservationError(
      `hand ${handId} has already been folded into the counters; completing it twice would ` +
        'double-count its hands, its showdowns and its shown cards',
    );
  }
}

/**
 * Folds a finished hand into the counters.
 *
 * **Takes a `PlayerView`, not a `HandState`, and that is the reason it exists in this
 * shape.** A `PlayerView` has already been through `redactFor`, so hole cards are present
 * only for seats that actually showed at a completed showdown — plus the recipient's own,
 * which this function never reads (see §1). A `HandState` would carry the deck, the deck
 * cursor, the commitment salts and every seat's cards, and an opponent model that can reach
 * them is an opponent model that cheats. A hand that ends by folding has an empty
 * `result.showdowns`, so it records no showdown hands at all.
 */
export function observeHandComplete(
  observations: OpponentObservations,
  view: PlayerView,
): OpponentObservations {
  if (view.street !== 'complete') {
    throw new ObservationError(
      `observeHandComplete needs a completed hand, received street "${view.street}"; folding a hand ` +
        'in early would count a seat as having entered a pot it may yet fold',
    );
  }
  assertHandNotAlreadyComplete(observations, view.handId);

  const aggressorSeat = lastAggressorSeat(view);
  const bySeat = new Map(observations.bySeat);

  for (const [seat, latch] of preflopLatches(view)) {
    const previous = bySeat.get(seat) ?? emptySeatObservations(seat);
    bySeat.set(
      seat,
      freezeSeat({
        ...previous,
        handsSeen: previous.handsSeen + 1,
        handsVoluntarilyEntered: previous.handsVoluntarilyEntered + (latch.enteredVoluntarily ? 1 : 0),
        preflopRaises: previous.preflopRaises + (latch.raisedPreflop ? 1 : 0),
      }),
    );
  }

  // The ONLY source of cards in this module. `result.showdowns` is the engine's list of hands
  // that were actually turned over; it is empty when everybody folded.
  for (const showdown of view.result?.showdowns ?? []) {
    const previous = bySeat.get(showdown.seat) ?? emptySeatObservations(showdown.seat);
    const shown: ShownHand = {
      cards: showdown.holeCards.map((card) => cardToString(card)),
      wasAggressor: showdown.seat === aggressorSeat,
    };
    bySeat.set(
      showdown.seat,
      freezeSeat({
        ...previous,
        showdownsReached: previous.showdownsReached + 1,
        showdownHands: pushBounded(previous.showdownHands, shown, SHOWDOWN_HAND_CAP),
      }),
    );
  }

  return freezeObservations({
    bySeat,
    handsObserved: observations.handsObserved + 1,
    currentHand: { handId: view.handId, completed: true },
  });
}

// ---------------------------------------------------------------------------
// Derived frequencies
// ---------------------------------------------------------------------------

/**
 * Frequencies for one seat, with the sample size attached to every one of them.
 *
 * Denominators, because a frequency without one is not a measurement:
 *
 * | field                       | numerator                    | denominator                     |
 * |-----------------------------|------------------------------|---------------------------------|
 * | vpip                        | hands entered voluntarily    | `handsSeen`                     |
 * | pfr                         | hands bet or raised preflop  | `handsSeen`                     |
 * | threeBetFrequency           | preflop re-raises            | turns facing a raise with a
 *                                                                re-raise legal                   |
 * | aggressionFrequency         | bets + raises                | bets + raises + calls + folds   |
 * | foldToBetFrequency          | folds facing a bet           | turns facing a bet              |
 * | wentToShowdown              | hands shown down             | `handsSeen`                     |
 * | averageBetSizeAsPotFraction | Σ (chips added / pot before) | sizes in the bounded window     |
 */
export interface DerivedSeatStats {
  readonly seat: number;
  readonly handsSeen: number;
  /** Every action recorded for this seat, all streets. A sanity check on the caller. */
  readonly actionsObserved: number;
  readonly vpip: number;
  readonly pfr: number;
  readonly threeBetFrequency: number;
  /**
   * The conventional aggression frequency: (bets + raises) / (bets + raises + calls +
   * folds). Checks are excluded, which is the convention and also the honest choice here — a
   * public observer cannot tell a check made with a monster from one made with air, and
   * `checks` is still carried raw on `SeatObservations` for anyone who wants it. Note this is
   * NOT the same quantity as `SeatSimulationStats.aggressionFrequency` in `stats.ts`, which
   * divides by turns where the engine offered aggression — a denominator only a privileged
   * observer has.
   */
  readonly aggressionFrequency: number;
  readonly foldToBetFrequency: number;
  /**
   * Shown-down hands over `handsSeen`. A hand-history tracker divides by hands that saw a
   * flop, which reads higher; a public observer cannot always tell who saw one, because an
   * all-in seat sees a flop without acting. Clamped to 1 for the same reason: a seat can
   * reach a showdown in a hand where it never acted preflop.
   */
  readonly wentToShowdown: number;
  readonly averageBetSizeAsPotFraction: number;
  /**
   * 0 plays every hand, 1 plays none. Exactly `1 - vpip`, so it carries no information vpip
   * does not — it exists because tightness is the direction `estimateRange` reasons in, and
   * an invertible definition means nothing is lost on the round trip.
   */
  readonly tightness: number;
  /**
   * Half-width of a 95% interval on a frequency over `handsSeen` observations, at the worst
   * case p = 0.5. Deliberately conservative and deliberately one number: a per-field
   * interval would invite reading the narrowest one.
   */
  readonly confidenceHalfWidth: number;
  readonly reliability: Reliability;
  /** Learner-facing, third person about the model. Checked at generation time. */
  readonly sampleNote: string;
  readonly assumptions: readonly string[];
}

/** A rate with no observations is 0, not NaN — the count is reported alongside it. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function reliabilityFor(handsSeen: number): Reliability {
  if (handsSeen >= REASONABLE_MINIMUM_HANDS) return 'reasonable';
  if (handsSeen >= INDICATIVE_MINIMUM_HANDS) return 'indicative';
  return 'insufficient';
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function points(value: number): string {
  return `${(value * 100).toFixed(0)} percentage points`;
}

const RELIABILITY_MEANING: Readonly<Record<Reliability, string>> = {
  insufficient: 'too small to act on, so this model holds its adjustments neutral and plays its own game',
  indicative: 'large enough to separate a tight style from a loose one, and nothing finer',
  reasonable: 'large enough to separate neighbouring styles, which is as far as counting actions goes',
};

function buildSampleNote(seat: number, handsSeen: number, halfWidth: number, band: Reliability): string {
  const note =
    handsSeen === 0
      ? `Seat ${seat} has no observed hands, so this model assumes nothing about it beyond the ` +
        'straightforward baseline every profile starts from.'
      : `Seat ${seat} has ${handsSeen} observed hands, so the 95% interval on any frequency below is ` +
        `about plus or minus ${points(halfWidth)} — ${RELIABILITY_MEANING[band]}.`;
  assertNoImpersonation(note, 'derivedStats.sampleNote');
  return note;
}

function buildAssumptions(seat: number): readonly string[] {
  const assumptions = [
    'Every figure here is counted from public actions only: who acted, what it cost, and what was ' +
      'turned over at showdown. No hole card is inferred, and a hand that ended in a fold reveals nothing.',
    `Hands played and preflop raises are shares of the hands in which seat ${seat} was seen to act ` +
      'before the flop, not of hands dealt — a seat that never got a turn cannot have declined to enter.',
    `Average bet size is a mean over the most recent ${BET_SIZE_SAMPLE_CAP} sizes rather than the whole ` +
      'session, so it describes current sizing rather than lifetime sizing.',
    'The interval is the worst-case binomial half-width at p = 0.5 over the observed hand count. It is ' +
      'one number for every frequency on purpose, so the narrowest interval cannot be mistaken for the ' +
      'reliability of the whole picture.',
    'This is frequency counting, not inference: there is no prior, no posterior, and no allowance for a ' +
      'style that changed halfway through the session.',
  ];
  for (const assumption of assumptions) assertNoImpersonation(assumption, 'derivedStats.assumptions');
  return assumptions;
}

/**
 * Frequencies for one seat, or `null` when the sample is too small to say anything.
 *
 * Returning `null` below `MINIMUM_HANDS_FOR_STATS` is the honest answer, not a convenience:
 * at 12 hands every frequency is consistent with every style the game contains, so a number
 * would be a read the data does not support. The caller has to handle "unknown", which is
 * exactly the discipline this app teaches. `neutralStats` is there for callers that must
 * always have something — a policy needs *a* range even on hand one.
 */
export function derivedStats(observations: OpponentObservations, seat: number): DerivedSeatStats | null {
  const seen = observations.bySeat.get(seat);
  if (seen === undefined) return null;
  if (seen.handsSeen < MINIMUM_HANDS_FOR_STATS) return null;

  const aggressiveActions = seen.bets + seen.raises;
  const aggressionDenominator = aggressiveActions + seen.calls + seen.folds;
  const vpip = ratio(seen.handsVoluntarilyEntered, seen.handsSeen);
  const halfWidth = (Z_95 * 0.5) / Math.sqrt(seen.handsSeen);
  const band = reliabilityFor(seen.handsSeen);

  return {
    seat,
    handsSeen: seen.handsSeen,
    actionsObserved: seen.bets + seen.raises + seen.calls + seen.checks + seen.folds,
    vpip,
    pfr: ratio(seen.preflopRaises, seen.handsSeen),
    threeBetFrequency: ratio(seen.threeBets, seen.threeBetOpportunities),
    aggressionFrequency: ratio(aggressiveActions, aggressionDenominator),
    foldToBetFrequency: ratio(seen.foldsFacingBet, seen.timesFacingBet),
    wentToShowdown: clamp(ratio(seen.showdownsReached, seen.handsSeen), 0, 1),
    averageBetSizeAsPotFraction: mean(seen.betSizeSamples),
    tightness: clamp(1 - vpip, 0, 1),
    confidenceHalfWidth: halfWidth,
    reliability: band,
    sampleNote: buildSampleNote(seat, seen.handsSeen, halfWidth, band),
    assumptions: buildAssumptions(seat),
  };
}

/**
 * What to assume about a seat nothing is known about.
 *
 * Every frequency is the reference point the exploit signals are measured against, so it
 * produces exactly neutral adjustments and the baseline 25% entry range. It exists so there
 * is one code path rather than two: a policy calls `derivedStats(obs, seat) ?? neutralStats(seat)`
 * and never branches on whether it has a read. `confidenceHalfWidth` is 1 — the whole range,
 * matching `stats.ts` — because zero observations support zero precision.
 */
export function neutralStats(seat: number): DerivedSeatStats {
  return {
    seat,
    handsSeen: 0,
    actionsObserved: 0,
    vpip: 1 - NEUTRAL_TIGHTNESS,
    pfr: (1 - NEUTRAL_TIGHTNESS) * 0.7,
    threeBetFrequency: 0,
    aggressionFrequency: NEUTRAL_AGGRESSION,
    foldToBetFrequency: NEUTRAL_FOLD_TO_BET,
    wentToShowdown: NEUTRAL_SHOWDOWN_RATE,
    averageBetSizeAsPotFraction: 0,
    tightness: NEUTRAL_TIGHTNESS,
    confidenceHalfWidth: 1,
    reliability: 'insufficient',
    sampleNote: buildSampleNote(seat, 0, 1, 'insufficient'),
    assumptions: buildAssumptions(seat),
  };
}

// ---------------------------------------------------------------------------
// Tightness to a range
// ---------------------------------------------------------------------------

export const RANGE_STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export const FACING_ACTIONS = ['none', 'check', 'call', 'bet', 'raise', 'threeBet'] as const;
export type FacingAction = (typeof FACING_ACTIONS)[number];

/**
 * How many rounds of betting a seat's range has continued through by each street. Preflop is
 * 0: the entry range has survived no postflop betting yet.
 */
const STREETS_OF_BETTING: Readonly<Record<string, number>> = {
  preflop: 0,
  flop: 1,
  turn: 2,
  river: 3,
};

/**
 * How the action a seat has taken moves its estimated range, relative to what it entered
 * with.
 *
 * The only claim these numbers make is the **ordering**: a 3-bet represents a narrower range
 * than a raise, which is narrower than a bet, which is narrower than a check. They are not
 * solver outputs and there is no chart behind them. Checking widens because a check is the
 * cheapest action available and therefore filters a range the least — but see
 * `estimateRange`, which never lets widening carry a range past what the seat entered with.
 */
const FACING_ACTION_MULTIPLIER: Readonly<Record<FacingAction, number>> = {
  none: 1,
  check: 1.3,
  call: 1,
  bet: 0.85,
  raise: 0.6,
  threeBet: 0.4,
};

/**
 * Bounds on how fast a range narrows per street of betting.
 *
 * The per-street keep factor is `1 - foldToBetFrequency`, which is observed rather than
 * assumed: a seat that folds to 40% of the bets it faces keeps roughly 60% of its range each
 * time it continues. It is clamped because the compounding is unforgiving — below 0.55 a
 * river range would be a sixth of the entry range, which is more precision than counting
 * folds can support, and above 0.90 the range would barely narrow at all across three
 * streets of betting.
 */
const MIN_STREET_KEEP = 0.55;
const MAX_STREET_KEEP = 0.9;

/**
 * The narrowest range this model will claim: the top 2%, around the strongest dozen classes.
 * Narrowing past that from frequency counting alone would assert a read no count of public
 * actions supports.
 */
const MIN_RANGE_PERCENT = 2;

function streetsOfBettingFor(street: string): number {
  const found = STREETS_OF_BETTING[street];
  if (found === undefined) {
    throw new ObservationError(
      `street must be one of ${RANGE_STREETS.join(', ')}, received "${street}" — a range cannot be ` +
        'estimated for showdown or for a completed hand',
    );
  }
  return found;
}

function facingMultiplierFor(facingAction: string): number {
  for (const candidate of FACING_ACTIONS) {
    if (candidate === facingAction) return FACING_ACTION_MULTIPLIER[candidate];
  }
  throw new ObservationError(
    `facingAction must be one of ${FACING_ACTIONS.join(', ')}, received "${facingAction}"`,
  );
}

// ---------------------------------------------------------------------------
// How much of a read is allowed to reach a decision, in one place
// ---------------------------------------------------------------------------

function assertAdaptation(adaptation: number): void {
  if (!Number.isFinite(adaptation) || adaptation < 0 || adaptation > 1) {
    throw new ObservationError(
      `adaptation must be between 0 and 1, received ${String(adaptation)}; it is a trait value, and a ` +
        'trait quietly clamped from 1.4 makes a profile behave differently from what its card claims',
    );
  }
}

/**
 * The single weight every read is scaled by, so there is exactly one answer to "how much of
 * what this model has watched reaches this decision".
 *
 * Two gates, multiplied, and both have to be here rather than at one call site:
 *   - `adaptation` is the profile's own `exploitativeAdaptation`, which `expressTraits` forces
 *     to 0 at the `educational` difficulty. A profile designed to play its own game regardless
 *     is unaffected by anything observed, and `docs/AI-LEGENDS.md` §8 says so on the card.
 *   - `RELIABILITY_WEIGHT` gates on the sample: an `insufficient` one contributes nothing
 *     however adaptive the profile is, because a little of a meaningless number is still
 *     meaningless.
 *
 * Both `exploitAdjustments` and `estimateRange` go through this function. That is the whole
 * point of it existing: the two are the *only* channels from the opponent model into a
 * decision, and when only one of them was gated, `educational` — where the card promises
 * "adaptation is off entirely" — still tracked what the learner had been doing, through the
 * assumed range.
 */
function readWeight(adaptation: number, reliability: Reliability): number {
  assertAdaptation(adaptation);
  return adaptation * RELIABILITY_WEIGHT[reliability];
}

/**
 * `weight` of the way from the neutral assumption to what was observed.
 *
 * The mirror of `blend`, which pulls a *multiplier* towards 1. This one pulls a *frequency*
 * towards its neutral reference, because a frequency's "no read" value is the baseline
 * profile's own number rather than 1.
 */
function towardsObserved(neutral: number, observed: number, weight: number): number {
  return neutral + (observed - neutral) * weight;
}

/**
 * The range to assume for a seat, as a slice of the computed strength ordering.
 *
 * ## The mapping, in full
 *
 * 0. **Weight the read.** `adaptation * RELIABILITY_WEIGHT[reliability]`, the same product
 *    `exploitAdjustments` gates on, and computed by the same `readWeight`. Both observed
 *    quantities below are pulled that far from the neutral assumption towards what was
 *    actually counted, so at weight 0 every step runs on the baseline profile's own numbers
 *    and the result is a constant. This is step 0 rather than a footnote because a range *is*
 *    an adaptation: it is the single largest thing a read changes about a decision, since
 *    `assessPostflop` prices relative strength, equity and the value/bluff split against it.
 *    Scaling only the multipliers in `exploitAdjustments` and leaving this path raw is
 *    exactly the second, unscaled path `policy.ts` promises does not exist — and it made
 *    `educational`, where `adaptationEnabled` is false, track the learner anyway.
 * 1. **Entry range from tightness.** `tightness` is `1 - vpip`, so `(1 - tightness) * 100`
 *    is the seat's weighted VPIP as a percentage of hands — and a percentage of hands is
 *    exactly what `topPercentRange` consumes. The assumption being made, and it is a real
 *    one: that a seat entering 30% of hands enters with its *strongest* 30%, not a random
 *    30%.
 * 2. **Narrow by street.** Multiply by `keep ** streetsOfBetting`, where `keep` is
 *    `1 - foldToBetFrequency` clamped to [0.55, 0.90]. Observed, not assumed: a seat that
 *    folds often narrows fast, and a station barely narrows.
 * 3. **Adjust by the action faced.** A check widens, a bet narrows, a raise narrows more, a
 *    3-bet most. Ordering only — see `FACING_ACTION_MULTIPLIER`.
 * 4. **Never wider than the entry range.** A seat's range on a later street is a *subset* of
 *    the range it entered with, so step 3 can walk back towards the entry range but never
 *    past it. Missing this is the obvious bug: a 1.3x widening on a checked river would
 *    otherwise credit the seat with hands it never played preflop.
 * 5. **Clamp to [2%, 100%]** and hand the percentage to `topPercentRange`, which orders the
 *    169 starting-hand classes by measured all-in equity against a random hand. That
 *    ordering is computed in `@prl/poker-math`, never transcribed from a published chart.
 *
 * An `insufficient` sample is ignored entirely, on **every** street: `RELIABILITY_WEIGHT` is
 * 0 there, so step 0 leaves tightness at `NEUTRAL_TIGHTNESS` — the baseline profile's own 25%
 * entry rate — *and* fold-to-bet at `NEUTRAL_FOLD_TO_BET`, and a 25-hand sample cannot move
 * the range. Neutralising only tightness is not enough and the failure hides preflop: there
 * `streetsOfBetting` is 0, `keep ** 0` is 1, and a test that only checks preflop passes
 * whatever `keep` holds. Postflop the same untouched `keep` was raised to the power of the
 * street, and a 25-hand seat observed folding to nothing widened the assumed river range from
 * the neutral 56 combos (4.22% of hands) to 244 (18.40%) — 4.4x, from a sample this comment
 * has always said is ignored.
 *
 * What this ignores, and it is a lot: board texture, the hands the seat's earlier line rules
 * out, position, stack depth and the number of opponents. It is one number mapped onto one
 * slice, and `DerivedSeatStats.assumptions` travels with every figure derived from it.
 *
 * `street` and `facingAction` are `string` rather than unions on purpose. Callers pass
 * `view.street`, which is a `Street` including `showdown` and `complete`, or a wire field
 * typed as `string`; a union here would push a cast onto every call site, whereas one
 * validated lookup gives a good error instead of a silently wrong answer. The accepted
 * values are exported as `RANGE_STREETS` and `FACING_ACTIONS` for callers that want to be
 * exhaustive.
 *
 * `adaptation` is required rather than defaulted for the same reason `exploitAdjustments`
 * requires it: a default would let a caller take the observed range by forgetting to say how
 * adaptive it is, which is the bug this parameter exists to make impossible.
 */
export function estimateRange(
  stats: DerivedSeatStats,
  street: string,
  facingAction: string,
  adaptation: number,
): ParsedRange {
  const streets = streetsOfBettingFor(street);
  const multiplier = facingMultiplierFor(facingAction);
  const weight = readWeight(adaptation, stats.reliability);

  const tightness = towardsObserved(NEUTRAL_TIGHTNESS, stats.tightness, weight);
  const foldToBet = towardsObserved(NEUTRAL_FOLD_TO_BET, stats.foldToBetFrequency, weight);

  const entryPercent = clamp((1 - tightness) * 100, MIN_RANGE_PERCENT, 100);
  const keep = clamp(1 - foldToBet, MIN_STREET_KEEP, MAX_STREET_KEEP);
  const narrowed = entryPercent * keep ** streets * multiplier;

  return topPercentRange(clamp(Math.min(narrowed, entryPercent), MIN_RANGE_PERCENT, 100));
}

// ---------------------------------------------------------------------------
// Turning a read into multipliers the policy applies
// ---------------------------------------------------------------------------

/**
 * Multipliers on the policy's own tendencies. 1 is neutral everywhere.
 *
 * They are multipliers rather than replacements so a profile keeps its own style while
 * leaning on what it has seen: an adaptation of 0.3 against a station is still the same
 * model, betting slightly thinner.
 */
export interface ExploitAdjustments {
  /** Scales `traits.bluffFrequency`. Above 1 against a seat that folds to bets. */
  readonly bluffMore: number;
  /** Widens the range this model will value-bet. Above 1 against a seat that calls too much. */
  readonly valueBetThinner: number;
  /** Scales how readily this model folds. Above 1 against a seat whose bets represent strength. */
  readonly foldMore: number;
  /** Scales bet size. Above 1 against a seat that pays off larger bets. */
  readonly sizeUp: number;
  /** Scales raising rather than calling. Above 1 against a seat that enters wide and passively. */
  readonly isolateMore: number;
  /** Third person about the model. Generated through `assertNoImpersonation`. */
  readonly note: string;
}

interface RawSignals {
  readonly bluffMore: number;
  readonly valueBetThinner: number;
  readonly foldMore: number;
  readonly sizeUp: number;
  readonly isolateMore: number;
}

/**
 * The raw signals, before `adaptation` and reliability scale them.
 *
 * Each is `1 + (observed - reference) * gain`, clamped. The clamps are the honest part: a
 * seat that folded to every bet in a 40-hand sample has not proved it folds to everything, so
 * the multiplier stops well short of what the raw arithmetic would give.
 *
 * `bluffMore` and `valueBetThinner` are deliberate mirror images of one observation. That is
 * not double counting: against a seat that calls too often, the two things to change are
 * *which hands get bluffed* and *which hands get value-bet*, and they move in opposite
 * directions. `sizeUp` reads the same station from a third angle — how much it pays — which
 * is why it blends fold-to-bet with the showdown rate rather than repeating either.
 */
function rawSignals(stats: DerivedSeatStats): RawSignals {
  const foldGap = stats.foldToBetFrequency - NEUTRAL_FOLD_TO_BET;
  const stationScore =
    (NEUTRAL_FOLD_TO_BET - stats.foldToBetFrequency) * 0.5 +
    (stats.wentToShowdown - NEUTRAL_SHOWDOWN_RATE) * 0.5;
  // Hands entered without raising: limps and cold-calls, the shape that invites isolation.
  const limpRate = Math.max(0, stats.vpip - stats.pfr);
  // A tight, measured seat's bets represent strength; a loose, relentless seat's do not.
  const betStrength = stats.tightness - NEUTRAL_TIGHTNESS - (stats.aggressionFrequency - NEUTRAL_AGGRESSION);

  return {
    bluffMore: clamp(1 + foldGap * 1.2, 0.5, 1.6),
    valueBetThinner: clamp(1 - foldGap * 1.2, 0.5, 1.6),
    foldMore: clamp(1 + betStrength * 0.8, 0.6, 1.5),
    sizeUp: clamp(1 + stationScore, 0.7, 1.4),
    isolateMore: clamp(1 + (limpRate - NEUTRAL_LIMP_RATE) * 1.5, 0.7, 1.6),
  };
}

/**
 * Scales one raw signal.
 *
 * At `weight === 0` this returns exactly 1: `(raw - 1) * 0` is 0 or -0 for any finite raw,
 * and `1 + -0` is 1. The clamps in `rawSignals` are what guarantee finiteness, which is why a
 * profile with `exploitativeAdaptation` 0 gets multipliers neutral to the bit rather than
 * neutral to a tolerance.
 */
function blend(raw: number, weight: number): number {
  return 1 + (raw - 1) * weight;
}

function neutralAdjustments(note: string): ExploitAdjustments {
  assertNoImpersonation(note, 'exploitAdjustments.note');
  return { bluffMore: 1, valueBetThinner: 1, foldMore: 1, sizeUp: 1, isolateMore: 1, note };
}

function neutralNote(stats: DerivedSeatStats | null, adaptation: number): string {
  if (stats === null) {
    return (
      'This model has no usable sample on that seat yet, so it plays its own strategy unchanged. ' +
      `Fewer than ${MINIMUM_HANDS_FOR_STATS} observed hands is not a sample: every frequency it could ` +
      'quote would be consistent with almost any style.'
    );
  }
  if (adaptation === 0) {
    return (
      'This model does not adapt: its adaptation trait is 0, so every multiplier is exactly neutral ' +
      `and the strategy it brings to seat ${stats.seat} is the strategy it brings to everyone.`
    );
  }
  return (
    `This model holds its adjustments neutral against seat ${stats.seat}: ${stats.handsSeen} observed ` +
    `hands leave a 95% interval of about plus or minus ${points(stats.confidenceHalfWidth)} on every ` +
    'frequency, which is wider than the gap between the styles it would be choosing between.'
  );
}

/** The clauses that explain an applied adjustment, largest movement first. */
function adjustmentClauses(stats: DerivedSeatStats, applied: RawSignals): readonly string[] {
  const foldedTo = percent(stats.foldToBetFrequency);
  const entered = percent(stats.vpip);
  const candidates = [
    {
      distance: Math.abs(applied.bluffMore - 1),
      text:
        `bluffing ${applied.bluffMore > 1 ? 'more' : 'less'} often, because that seat folded to ` +
        `${foldedTo} of the bets it faced`,
    },
    {
      distance: Math.abs(applied.valueBetThinner - 1),
      text:
        `value-betting ${applied.valueBetThinner > 1 ? 'thinner' : 'tighter'}, which is the same ` +
        'observation from the other side',
    },
    {
      distance: Math.abs(applied.foldMore - 1),
      text:
        `folding ${applied.foldMore > 1 ? 'more' : 'less'} to that seat's aggression, which arrives ` +
        `on ${percent(stats.aggressionFrequency)} of its actions from a ${entered} range of hands`,
    },
    {
      distance: Math.abs(applied.sizeUp - 1),
      text:
        `sizing ${applied.sizeUp > 1 ? 'up' : 'down'}, because that seat reached a showdown in ` +
        `${percent(stats.wentToShowdown)} of the hands it played`,
    },
    {
      distance: Math.abs(applied.isolateMore - 1),
      text:
        `raising rather than calling ${applied.isolateMore > 1 ? 'more' : 'less'} often, because it ` +
        `entered ${entered} of hands and raised only ${percent(stats.pfr)}`,
    },
  ];
  return candidates
    .filter((candidate) => candidate.distance >= 0.01)
    .sort((left, right) => right.distance - left.distance)
    .slice(0, 3)
    .map((candidate) => candidate.text);
}

function describeAdjustment(stats: DerivedSeatStats, applied: RawSignals): string {
  const clauses = adjustmentClauses(stats, applied);
  const body =
    clauses.length === 0
      ? 'nothing it has counted moves any multiplier far enough to change a decision'
      : clauses.join('; ');
  const note =
    `This model adjusts against seat ${stats.seat} from ${stats.handsSeen} observed hands ` +
    `(${stats.reliability} sample, 95% interval about plus or minus ` +
    `${points(stats.confidenceHalfWidth)}): ${body}. Every figure comes from public actions only, and ` +
    'none of it is a claim about which cards that seat held.';
  assertNoImpersonation(note, 'exploitAdjustments.note');
  return note;
}

/**
 * The multipliers a policy applies, scaled so that a profile with `adaptation` 0 gets exactly
 * neutral ones.
 *
 * The two gates are `readWeight`'s, and `estimateRange` is scaled by the same call: adaptation
 * off means neutral multipliers *and* the neutral range, which is what makes "adaptation is
 * off entirely" a statement about behaviour rather than about one of the two paths.
 *
 * `null` stats (no seat, or fewer than `MINIMUM_HANDS_FOR_STATS` hands) return neutral with a
 * note saying why, rather than throwing: "not enough seen yet" is a normal state for the
 * first twenty hands of every match, not an error.
 */
export function exploitAdjustments(stats: DerivedSeatStats | null, adaptation: number): ExploitAdjustments {
  assertAdaptation(adaptation);
  if (stats === null) return neutralAdjustments(neutralNote(null, adaptation));

  const weight = readWeight(adaptation, stats.reliability);
  if (weight === 0) return neutralAdjustments(neutralNote(stats, adaptation));

  const raw = rawSignals(stats);
  const applied: RawSignals = {
    bluffMore: blend(raw.bluffMore, weight),
    valueBetThinner: blend(raw.valueBetThinner, weight),
    foldMore: blend(raw.foldMore, weight),
    sizeUp: blend(raw.sizeUp, weight),
    isolateMore: blend(raw.isolateMore, weight),
  };
  return { ...applied, note: describeAdjustment(stats, applied) };
}

// ---------------------------------------------------------------------------
// A handle, for callers that would rather not thread a snapshot
// ---------------------------------------------------------------------------

/**
 * The narrow read a policy consumes, one entry per opponent.
 *
 * This is the shape `policy.ts` declares as `ObservedTendencies`, kept structural rather than
 * imported so the two modules do not depend on each other. Three properties of this list are
 * deliberate and easy to get wrong:
 *
 *   1. **The model's own seat is excluded.** A model that adapted to its own frequencies would
 *      be adapting to itself, which is why `createOpponentModel` takes a seat at all.
 *   2. **Frequencies are neutral for any seat whose sample is `insufficient`**, while
 *      `handsObserved` still reports the true count. A policy that forgets to check the count
 *      therefore cannot lean on a 12-hand read. For a *display* surface use `statsFor`, which
 *      returns `null` and carries a `sampleNote` saying why.
 *   3. **Sorted by seat.** `Map` iteration follows insertion order, which depends on who acted
 *      first, so an unsorted list would make a policy's output depend on something that is not
 *      part of the situation.
 */
export interface ObservedSeatTendencies {
  readonly seat: number;
  /** Hands in which this seat was seen to act before the flop. The denominator of `vpip`. */
  readonly handsObserved: number;
  readonly vpip: number;
  readonly aggressionFrequency: number;
  readonly foldToBetFrequency: number;
}

/**
 * A per-seat handle that holds the current immutable snapshot and swaps it on each
 * observation.
 *
 * The pure functions above are the authority; this is a convenience for the match runner and
 * the simulation harness, which own one of these per seat and would otherwise thread a
 * snapshot through every call. The distinction that keeps §2 true: the *snapshot* is never
 * mutated, so a snapshot already handed to a policy stays exactly as that policy received it.
 * Only the handle's pointer moves.
 *
 * Fields are assigned in the constructor body rather than through parameter properties, which
 * `erasableSyntaxOnly` forbids — that flag is what lets Node run this TypeScript with no
 * build step.
 */
export class OpponentModel {
  /** The seat this handle belongs to. Its own actions are observed like anybody else's. */
  readonly ownSeat: number;
  private current: OpponentObservations;

  constructor(ownSeat: number) {
    if (!Number.isInteger(ownSeat) || ownSeat < 0) {
      throw new ObservationError(`ownSeat must be a non-negative integer, received ${String(ownSeat)}`);
    }
    this.ownSeat = ownSeat;
    this.current = emptyObservations();
  }

  /** The current snapshot. Safe to hand to a policy: nothing can mutate it afterwards. */
  get snapshot(): OpponentObservations {
    return this.current;
  }

  /** Records one public action. */
  observeAction(event: PublicActionEvent): void {
    this.current = observeAction(this.current, event);
  }

  /**
   * Folds a completed hand in, from the redacted view this seat is entitled to. Named
   * `observe` because it is the one call a runner cannot skip: everything a model knows about
   * entry frequencies comes from here.
   */
  observe(view: PlayerView): void {
    this.current = observeHandComplete(this.current, view);
  }

  statsFor(seat: number): DerivedSeatStats | null {
    return derivedStats(this.current, seat);
  }

  /**
   * Frequencies for a seat, falling back to the neutral assumption rather than `null`, for
   * the callers that must always have something to reason with.
   *
   * The fallback covers the whole `insufficient` band, not just the `null` floor. Those are
   * two different thresholds — `derivedStats` returns `null` below `MINIMUM_HANDS_FOR_STATS`
   * (20), while `insufficient` runs to `INDICATIVE_MINIMUM_HANDS` (40) — and a `?? neutral`
   * that only caught the first handed back raw frequencies for a 20-to-39-hand sample, which
   * is precisely the read `ObservedSeatTendencies` promises a caller cannot lean on. The band
   * is the authority here because it is the one every other consumer of a read gates on.
   */
  statsOrNeutralFor(seat: number): DerivedSeatStats {
    const stats = this.statsFor(seat);
    if (stats === null || stats.reliability === 'insufficient') return neutralStats(seat);
    return stats;
  }

  /**
   * The assumed continuing range for a seat, scaled by this model's own adaptation trait.
   *
   * `adaptation` is required for the same reason it is on `adjustmentsFor`: these are the two
   * channels out of the opponent model, and a caller that could take one of them without
   * stating its adaptation would reintroduce exactly the unscaled path this parameter closed.
   */
  rangeFor(seat: number, street: string, facingAction: string, adaptation: number): ParsedRange {
    return estimateRange(this.statsOrNeutralFor(seat), street, facingAction, adaptation);
  }

  adjustmentsFor(seat: number, adaptation: number): ExploitAdjustments {
    return exploitAdjustments(this.statsFor(seat), adaptation);
  }

  /** Every seat but this one, as the narrow read a policy consumes. See `ObservedSeatTendencies`. */
  get opponents(): readonly ObservedSeatTendencies[] {
    const out: ObservedSeatTendencies[] = [];
    for (const seen of this.current.bySeat.values()) {
      if (seen.seat === this.ownSeat) continue;
      const stats = this.statsOrNeutralFor(seen.seat);
      out.push({
        seat: seen.seat,
        handsObserved: seen.handsSeen,
        vpip: stats.vpip,
        aggressionFrequency: stats.aggressionFrequency,
        foldToBetFrequency: stats.foldToBetFrequency,
      });
    }
    return out.sort((left, right) => left.seat - right.seat);
  }
}

export function createOpponentModel(ownSeat: number): OpponentModel {
  return new OpponentModel(ownSeat);
}
