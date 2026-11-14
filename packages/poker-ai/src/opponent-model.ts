/**
 * What a seat has been seen to do, and what a policy may conclude from it. This gives
 * `traits.exploitativeAdaptation` something to act on, and the input types make cheating unrepresentable.
 *
 * `observeHandComplete` takes a `PlayerView`, never a `HandState`. Shown hands come from
 * `view.result.showdowns`, never `SeatView.holeCards`, which always holds the observer's own cards. A
 * fold-out records nothing. `observeAction` takes a `PublicActionEvent`, which has no card field.
 * Tests assert two seats' views of one hand produce identical observations.
 *
 * Several policies read one `OpponentObservations`, so every update rebuilds and freezes. Rebuilding is
 * the guarantee because `Object.freeze` does not block `Map.set`. Windows are capped at 64 bet sizes and
 * 32 shown hands.
 * `observeHandComplete` moves the per-hand counters from `view.actions`. `observeAction` moves the
 * per-action counters, which need the price at decision time. A caller with only views gets zero
 * aggression stats rather than a second copy of `mayRaise`. The `vpip`/`pfr` denominator is hands where
 * the seat acted preflop, not hands dealt (see `stats.ts`).
 *
 * `derivedStats` is null below 20 hands, `reliability` never goes above `reasonable`, and `readWeight`
 * gates both `exploitAdjustments` and `estimateRange`, so an `insufficient` sample is exactly neutral.
 * This is frequency counting with no prior. The half-width is the worst-case binomial at p = 0.5.
 * `estimateRange` slices the computed `topPercentRange` ordering and ignores board texture.
 */

import { cardToString, type PlayerView } from '@prl/poker-engine';
import { type ParsedRange, topPercentRange } from '@prl/poker-math';
import { assertNoImpersonation } from './labelling.ts';
import { normalTwoSidedCriticalValue } from './stats.ts';

export class ObservationError extends Error {
  override readonly name = 'ObservationError';
}

/**
 * 64 samples give a standard error of an eighth of the spread, and six seats hold at most 384 numbers.
 * The average is over this recent window, not the lifetime.
 */
export const BET_SIZE_SAMPLE_CAP = 64;

/** A seat shows about one hand in four or five, so 32 covers about 150 hands of history. */
export const SHOWDOWN_HAND_CAP = 32;

/**
 * At n = 20 the worst-case 95% half-width is 1.96 x 0.5 / sqrt(20) = 0.219. The interval is wider
 * than the 0.35 VPIP span of the profile set, so any figure below this would be invented.
 */
export const MINIMUM_HANDS_FOR_STATS = 20;

/** Half-width 0.155. Tight can be told from loose, and nothing finer. */
export const INDICATIVE_MINIMUM_HANDS = 40;

/** Half-width 0.080. Profiles about 0.16 apart separate. The top band on purpose. */
export const REASONABLE_MINIMUM_HANDS = 150;

export const RELIABILITY_LEVELS = ['insufficient', 'indicative', 'reasonable'] as const;

export type Reliability = (typeof RELIABILITY_LEVELS)[number];

/** `insufficient` is 0, because a little of a meaningless number is still meaningless. */
const RELIABILITY_WEIGHT: Readonly<Record<Reliability, number>> = {
  insufficient: 0,
  indicative: 0.5,
  reasonable: 1,
};

/** Shared with `stats.ts` so the two agree exactly. */
const Z_95 = normalTwoSidedCriticalValue(0.05);

/** `baselineTraits().vpip` of 0.25, expressed as tightness. */
const NEUTRAL_TIGHTNESS = 0.75;

/** Reference points the raw exploit signals are measured against. */
const NEUTRAL_FOLD_TO_BET = 0.45;
const NEUTRAL_AGGRESSION = 0.5;
const NEUTRAL_SHOWDOWN_RATE = 0.28;
const NEUTRAL_LIMP_RATE = 0.08;

export const OBSERVABLE_STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export type ObservableStreet = (typeof OBSERVABLE_STREETS)[number];

export const OBSERVABLE_ACTIONS = ['fold', 'check', 'call', 'bet', 'raise'] as const;
export type ObservableAction = (typeof OBSERVABLE_ACTIONS)[number];

/**
 * One action as everybody at the table saw it. No field can hold a card, deck, cursor or salt, so a
 * privileged builder has nowhere to put a secret.
 */
export interface PublicActionEvent {
  /** Lets a hand be refused if counted twice. */
  readonly handId: string;
  readonly seat: number;
  readonly street: ObservableStreet;
  readonly action: ObservableAction;
  /** Chips needed to match, 0 when checking was free. Only the sign is used, so it may be uncapped. */
  readonly toCall: number;
  /** Total pot before the action, including this street's commitments. */
  readonly potBefore: number;
  /** Chips this action actually moved from stack to pot. */
  readonly amountPaid: number;
  /** True when the preflop bet level was above the big blind, i.e. facing a raise. */
  readonly facingPreflopRaise: boolean;
  /**
   * Whether the engine offered a bet or raise. The 3-bet denominator. After a short all-in `mayRaise` is
   * false, so read it from `legalActions`, never from the stack.
   */
  readonly raiseWasAvailable: boolean;
}

/** One hand a seat actually turned over, with the public fact of who drove the betting. */
export interface ShownHand {
  readonly cards: readonly string[];
  readonly wasAggressor: boolean;
}

/** Counters over public actions only. `showdownHands` holds only hands actually turned over. */
export interface SeatObservations {
  readonly seat: number;
  /** Hands where this seat acted preflop, not hands dealt, so button rotation is not measured. */
  readonly handsSeen: number;
  /** Called, bet or raised preflop. Checking the big-blind option is not entering. */
  readonly handsVoluntarilyEntered: number;
  /** A hand count, not an action count, so `pfr <= vpip` holds by construction. */
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
  /** Pot fractions, newest last, capped at `BET_SIZE_SAMPLE_CAP`. */
  readonly betSizeSamples: readonly number[];
  /** Only hands shown at showdown, newest last, capped at `SHOWDOWN_HAND_CAP`. */
  readonly showdownHands: readonly ShownHand[];
}

/** Lets a hand be refused if counted twice, which would corrupt every rate while looking normal. */
export interface HandProgress {
  readonly handId: string;
  readonly completed: boolean;
}

export interface OpponentObservations {
  readonly bySeat: ReadonlyMap<number, SeatObservations>;
  /** Hands completed by `observeHandComplete`. Per-seat counts are `handsSeen`. */
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

/** Freezing makes a push onto a shared window throw at the push. */
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

/** Appends, dropping the oldest at the cap. Not a ring buffer, since every update allocates anyway. */
function pushBounded<T>(window: readonly T[], value: T, cap: number): readonly T[] {
  if (cap < 1) throw new ObservationError(`a bounded window needs a cap of at least 1, received ${cap}`);
  if (window.length < cap) return [...window, value];
  return [...window.slice(window.length - cap + 1), value];
}

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

/** Refuses to reopen a finished hand, which would double every per-action counter. */
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
  // Facing a raise with a re-raise legal.
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

/** Returns a new object; the input is untouched. */
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

/** The last bettor or raiser from the public log, or null when checked down. Labels a shown hand. */
function lastAggressorSeat(view: PlayerView): number | null {
  let seat: number | null = null;
  for (const logged of view.actions) {
    if (logged.action.type === 'bet' || logged.action.type === 'raise') seat = logged.seat;
  }
  return seat;
}

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
 * Folds a finished hand into the counters. Takes a `PlayerView` so only shown hands are reachable,
 * never the deck, salts or other seats' cards.
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

  // The only source of cards in this module. Empty when everybody folded.
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

/**
 * Frequencies for one seat with the sample size attached. Denominators:
 * vpip, pfr and wentToShowdown over `handsSeen`; threeBetFrequency over turns facing a raise with a
 * re-raise legal; aggressionFrequency over bets + raises + calls + folds; foldToBetFrequency over turns
 * facing a bet; averageBetSizeAsPotFraction over the bounded window.
 */
export interface DerivedSeatStats {
  readonly seat: number;
  readonly handsSeen: number;
  /** Every action recorded for this seat, all streets. */
  readonly actionsObserved: number;
  readonly vpip: number;
  readonly pfr: number;
  readonly threeBetFrequency: number;
  /**
   * Checks are excluded by convention, since an observer cannot tell what a check was made with. Not the
   * same as `SeatSimulationStats.aggressionFrequency`, which divides by turns where aggression was offered.
   */
  readonly aggressionFrequency: number;
  readonly foldToBetFrequency: number;
  /**
   * Shown-down hands over `handsSeen`, not over flops seen, because an all-in seat sees a flop without
   * acting. Clamped to 1 because a seat can reach showdown without acting preflop.
   */
  readonly wentToShowdown: number;
  readonly averageBetSizeAsPotFraction: number;
  /** 0 plays every hand, 1 plays none. Exactly `1 - vpip`; `estimateRange` reasons in this direction. */
  readonly tightness: number;
  /** Worst-case 95% half-width at p = 0.5 over `handsSeen`. One number so nobody reads the narrowest. */
  readonly confidenceHalfWidth: number;
  readonly reliability: Reliability;
  /** Learner-facing, about the model. Checked at generation time. */
  readonly sampleNote: string;
  readonly assumptions: readonly string[];
}

/** 0 rather than NaN; the count is reported alongside. */
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
 * Null below `MINIMUM_HANDS_FOR_STATS`, so the caller must handle "unknown". Use `neutralStats` when
 * a value is required.
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
 * Every frequency sits at the exploit reference point, so the result is exactly neutral. Use as
 * `derivedStats(obs, seat) ?? neutralStats(seat)`. `confidenceHalfWidth` is 1, matching `stats.ts`.
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

export const RANGE_STREETS = ['preflop', 'flop', 'turn', 'river'] as const;
export const FACING_ACTIONS = ['none', 'check', 'call', 'bet', 'raise', 'threeBet'] as const;
export type FacingAction = (typeof FACING_ACTIONS)[number];

/** Rounds of betting the range has survived by each street. */
const STREETS_OF_BETTING: Readonly<Record<string, number>> = {
  preflop: 0,
  flop: 1,
  turn: 2,
  river: 3,
};

/**
 * Only the ordering is claimed, narrowest first: 3-bet, raise, bet, check. No chart or solver
 * behind it. `estimateRange` never lets a check widen past the entry range.
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
 * The per-street keep factor is the observed `1 - foldToBetFrequency`, clamped. Below 0.55 a river range
 * is a sixth of entry, more precision than counting supports; above 0.90 it barely narrows.
 */
const MIN_STREET_KEEP = 0.55;
const MAX_STREET_KEEP = 0.9;

/** The top 2%, about the strongest dozen classes. Counting public actions supports nothing narrower. */
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

function assertAdaptation(adaptation: number): void {
  if (!Number.isFinite(adaptation) || adaptation < 0 || adaptation > 1) {
    throw new ObservationError(
      `adaptation must be between 0 and 1, received ${String(adaptation)}; it is a trait value, and a ` +
        'trait quietly clamped from 1.4 makes a profile behave differently from what its card claims',
    );
  }
}

/**
 * The one weight every read is scaled by, `exploitativeAdaptation` (0 at `educational`, see
 * docs/AI-LEGENDS.md §8) times the reliability weight. Both channels into a decision,
 * `exploitAdjustments` and `estimateRange`, go through it.
 */
function readWeight(adaptation: number, reliability: Reliability): number {
  assertAdaptation(adaptation);
  return adaptation * RELIABILITY_WEIGHT[reliability];
}

/** Pulls a frequency towards its neutral reference, where `blend` pulls a multiplier towards 1. */
function towardsObserved(neutral: number, observed: number, weight: number): number {
  return neutral + (observed - neutral) * weight;
}

/**
 * The range to assume for a seat, as a slice of the computed strength ordering.
 * 0. Pull tightness and fold-to-bet from neutral towards observed by `readWeight`. At weight 0 the
 *    result is constant on every street. Neutralising only tightness hides preflop, where
 *    `keep ** 0` is 1; postflop it widens a 25-hand river range 4.4x (56 to 244 combos).
 * 1. Entry percent is `(1 - tightness) * 100`, assuming a seat enters with its strongest hands.
 * 2. Multiply by `keep ** streetsOfBetting`, `keep` being `1 - foldToBet` clamped to [0.55, 0.90].
 * 3. Multiply by the facing-action factor.
 * 4. Never wider than the entry range, so a checked river cannot add hands never played preflop.
 * 5. Clamp to [2%, 100%] and pass to `topPercentRange`.
 * Ignores board texture, earlier-line exclusions, position, stacks and opponent count.
 * `street` and `facingAction` are strings so callers can pass `view.street` without a cast. Valid
 * values are `RANGE_STREETS` and `FACING_ACTIONS`. `adaptation` has no default, so a caller cannot
 * take the raw range by omission.
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

/** Multipliers on the policy's own tendencies, so a profile keeps its style. 1 is neutral. */
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
  /** About the model, checked by `assertNoImpersonation`. */
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
 * Raw signals before weighting. Each is `1 + (observed - reference) * gain`, clamped, because a
 * 40-hand sample proves little. `bluffMore` and `valueBetThinner` mirror one observation on purpose.
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

/** At `weight === 0` this is exactly 1. The clamps in `rawSignals` keep `raw` finite. */
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

/** Largest movement first. */
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
 * Scaled by `readWeight`, so `adaptation` 0 gives exactly neutral multipliers. Null stats return
 * neutral with a note rather than throwing, since the first twenty hands of every match have no read.
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

/**
 * The read a policy consumes, structurally equal to `ObservedTendencies` in `policy.ts`. Excludes
 * the model's own seat. Frequencies are neutral for an `insufficient` sample while `handsObserved`
 * stays true. Sorted by seat, so output does not depend on who acted first.
 */
export interface ObservedSeatTendencies {
  readonly seat: number;
  /** Hands where this seat acted preflop. The `vpip` denominator. */
  readonly handsObserved: number;
  readonly vpip: number;
  readonly aggressionFrequency: number;
  readonly foldToBetFrequency: number;
}

/**
 * A per-seat handle that swaps immutable snapshots. A snapshot already handed out never changes.
 * Fields are assigned in the constructor because `erasableSyntaxOnly` forbids parameter properties.
 */
export class OpponentModel {
  /** Its own actions are observed like anybody else's. */
  readonly ownSeat: number;
  private current: OpponentObservations;

  constructor(ownSeat: number) {
    if (!Number.isInteger(ownSeat) || ownSeat < 0) {
      throw new ObservationError(`ownSeat must be a non-negative integer, received ${String(ownSeat)}`);
    }
    this.ownSeat = ownSeat;
    this.current = emptyObservations();
  }

  /** Safe to hand to a policy. Nothing can mutate it afterwards. */
  get snapshot(): OpponentObservations {
    return this.current;
  }

  observeAction(event: PublicActionEvent): void {
    this.current = observeAction(this.current, event);
  }

  /** Folds a completed hand in. The only source of entry frequencies. */
  observe(view: PlayerView): void {
    this.current = observeHandComplete(this.current, view);
  }

  statsFor(seat: number): DerivedSeatStats | null {
    return derivedStats(this.current, seat);
  }

  /**
   * Falls back to neutral for the whole `insufficient` band (below 40 hands), not just the
   * null floor at 20, because the band is what every consumer gates on.
   */
  statsOrNeutralFor(seat: number): DerivedSeatStats {
    const stats = this.statsFor(seat);
    if (stats === null || stats.reliability === 'insufficient') return neutralStats(seat);
    return stats;
  }

  /** `adaptation` is required, as on `adjustmentsFor`, so neither channel can be taken unscaled. */
  rangeFor(seat: number, street: string, facingAction: string, adaptation: number): ParsedRange {
    return estimateRange(this.statsOrNeutralFor(seat), street, facingAction, adaptation);
  }

  adjustmentsFor(seat: number, adaptation: number): ExploitAdjustments {
    return exploitAdjustments(this.statsFor(seat), adaptation);
  }

  /** Every seat but this one. See `ObservedSeatTendencies`. */
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
