/**
 * The Coach assembles everything shown at a decision point from the pure maths, so a learner sees why.
 * Invariants it enforces:
 * 1. `assumptions` is never empty. `buildCoachReport` throws instead.
 * 2. `uncertainty` always states the method. Exact enumeration reports `confidenceInterval: null`,
 *    because "no sampling error" and "zero error" are different claims.
 * 3. `CoachSuggestion` has no field that can express "correct", so the UI cannot render one.
 * 4. Every size it emits is one the table would accept.
 * 5. Every action it emits is one the engine offers. Absent `legalActions` falls back to
 *    `deriveLegalActions`, never to "everything is permitted".
 * 5a. No candidate costs more than `heroStack`. `assertAffordable` throws a `CoachError` on a violation.
 * 6. A free check never ranks below a fold. `evOfCheck` is `equity x pot`, and ties go against folding.
 * Every probability that leaves this file is a fraction in 0..1. Percentage points appear only in fields
 * named for them (`errorPoints`, `confidenceHalfWidthPoints`).
 * It does not solve the spot. It evaluates the available actions against one stated range assumption.
 */

import type {
  ActionCandidate,
  CoachReport,
  CoachSuggestion,
  EquitySummary,
  OutsBreakdown,
  PotOddsSummary,
  StackContext,
  UncertaintyNote,
} from '@prl/contracts';
import { buildPotLayers, type Card, type PotContributor, type SeatIndex } from '@prl/poker-engine';
import { continuingRange, rankAgainstBoard } from './calling-range.ts';
import { restsOnAssumedFoldEquity } from './consistency.ts';
import { type EquityResult, type EquitySpec, equity, exactEquity } from './equity.ts';
import {
  breakEvenFoldRate,
  evOfBet,
  evOfCall,
  evOfCheck,
  evOfFold,
  evOfRaise,
  foldRateReaching,
} from './ev.ts';
import { chips, frac, percent, signedChips } from './format.ts';
import {
  maximumOutsForRuleOf24,
  potOdds,
  priceLaidByBet,
  probabilityOfHitting,
  ruleOf24Accuracy,
} from './odds.ts';
import { computeOuts, type OutsResult } from './outs.ts';
import { exactRange, type ParsedRange } from './ranges.ts';
import { effectiveStack, type SizingOption, sizingOptionAt, stackToPotRatio } from './stacks.ts';
import {
  type OfferedSize,
  offeredSizes,
  presetTo,
  type SizingContext,
  TABLE_SIZING_PRESETS,
} from './table-sizing.ts';

export class CoachError extends Error {
  override readonly name = 'CoachError';
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/** The five things a seat can do. Identical to `ActionCandidate['action']` by design. */
export type CoachAction = ActionCandidate['action'];

/** One opponent still in the hand, on the same reading as hero's `heroStack` and commitment. */
export interface OpponentStack {
  /** Chips BEHIND, not counting `committedThisStreet`. 0 when all in. */
  readonly behind: number;
  /** Chips ALREADY put out on this street, which may be less than the bet level. */
  readonly committedThisStreet: number;
  /**
   * Chips of the pot, before hero acts, this seat can win at showdown. The whole pot for a seat with
   * chips behind. Less for a seat all in for less than others put in. Seat-state callers use
   * `opponentStackAt`. Absent, it is the pot less every other seat's chips this street above this one's,
   * which is exact for an all-in made this street with no folded seat above it.
   */
  readonly winnable?: number;
}

/** The part of a spot that fixes which action kinds are legal. `CoachInput` satisfies it structurally. */
export interface DescribedSpot {
  /** What hero must add to continue. 0 when hero can check. */
  readonly toCall: number;
  /** Chips hero has ALREADY put out on this street. */
  readonly heroCommittedThisStreet: number;
  /** Chips hero has BEHIND, not counting anything already committed. */
  readonly heroStack: number;
  /** One entry per opponent still in the hand. */
  readonly opponentStacks: readonly OpponentStack[];
}

/** A described spot plus what fixes a legal size, kept apart so `deriveLegalActions` reads only its four. */
export interface SizedSpot extends DescribedSpot {
  readonly bigBlind: number;
  /** The engine's own `minTo` when there is a `HandState` to read it from. See `CoachInput`. */
  readonly minimumRaiseTo?: number;
}

/**
 * The actions the betting rules allow in a described spot. The engine's `legalActions` is the authority
 * wherever a `HandState` exists. This serves the calculator, Scenario Lab, hand review and profile
 * comparison, which have none.
 * - `fold` always. `check` when `toCall === 0`, else `call`.
 * - `bet`/`raise` only when some opponent has chips behind, or fold equity would be charged against an
 *   opponent who cannot fold.
 * - `bet` when the bet level is 0, else `raise`. A big blind in a limped pot cannot bet.
 * - Only when `maxTo > betLevel`, so a short stack may still shove below the minimum.
 * `mayRaise` (a short all-in does not reopen the action) cannot be derived, so this can be too generous
 * in that one case. It is never stricter than the engine.
 */
export function deriveLegalActions(spot: DescribedSpot): readonly CoachAction[] {
  const actions: CoachAction[] = ['fold'];
  actions.push(spot.toCall === 0 ? 'check' : 'call');

  const someOpponentCanAnswer = spot.opponentStacks.some((opponent) => opponent.behind > 0);
  if (someOpponentCanAnswer && maximumTo(spot) > betLevelOf(spot)) {
    actions.push(betLevelOf(spot) === 0 ? 'bet' : 'raise');
  }
  return actions;
}

/** A described spot plus the pot, kept apart from `DescribedSpot` for the same reason as `SizedSpot`. */
export interface PricedSpot extends DescribedSpot {
  /** Chips in the middle, excluding hero's pending call. */
  readonly pot: number;
}

/**
 * The pot hero can win in a described spot. `contestablePotFor` in `@prl/poker-engine` is the authority
 * wherever seat states exist.
 * It removes `toCall - heroStack`, the part of the bet hero's stack cannot cover. Exact heads-up.
 * Multiway it can leave a second opponent's excess in the pot, but it never subtracts chips within
 * hero's reach.
 */
export function deriveContestablePot(spot: PricedSpot): number {
  const beyondReach = Math.max(0, spot.toCall - spot.heroStack);
  return Math.max(0, spot.pot - beyondReach);
}

/** The street level after calling. Named once because it reads like `maximumTo` at a glance. */
function betLevelOf(spot: Pick<DescribedSpot, 'toCall' | 'heroCommittedThisStreet'>): number {
  return spot.heroCommittedThisStreet + spot.toCall;
}

/**
 * For a described spot with no per-seat record of the street: each opponent has put in the bet hero
 * faces. Exact heads-up, where the one opponent made or matched it. Multiway it is an assumption.
 */
export function opponentsAtBetLevel(
  spot: Pick<DescribedSpot, 'toCall' | 'heroCommittedThisStreet'>,
  behind: readonly number[],
): readonly OpponentStack[] {
  const committedThisStreet = betLevelOf(spot);
  return behind.map((chips) => ({ behind: chips, committedThisStreet }));
}

/**
 * One seat of a real table as an `OpponentStack`. An all-in seat's `winnable` is the engine's own
 * layering, folded seats included. A seat with chips behind is left to the default, because mid-street
 * the layers cut it out of chips it can still call for.
 */
export function opponentStackAt(
  seats: readonly (PotContributor & { readonly stack: number; readonly committedThisStreet: number })[],
  seat: SeatIndex,
): OpponentStack {
  const entry = seats.find((candidate) => candidate.seat === seat);
  if (entry === undefined) throw new CoachError(`seat ${seat} is not at the table`);
  const stack = { behind: entry.stack, committedThisStreet: entry.committedThisStreet };
  if (entry.stack > 0) return stack;
  let winnable = 0;
  for (const pot of buildPotLayers(seats).pots) if (pot.eligibleSeats.includes(seat)) winnable += pot.amount;
  return { ...stack, winnable };
}

/**
 * The engine's `maxTo`, which every published size is clamped to. Exported so code that accepts a size
 * from a learner holds it to the same figure. `heroStack` is chips behind, so this is a total.
 */
export function maximumTo(spot: DescribedSpot): number {
  return spot.heroCommittedThisStreet + spot.heroStack;
}

export interface CoachInput {
  readonly heroCards: readonly Card[];
  readonly board: readonly Card[];
  readonly street: Street;
  /** One entry per opponent still in the hand. */
  readonly opponents: readonly { readonly label: string; readonly range: ParsedRange }[];
  /** Chips in the middle, excluding hero's pending call. Every chip, contestable or not. */
  readonly pot: number;
  /**
   * The part of `pot` hero could win. It differs from `pot` when hero is all-in for less than the bet,
   * because hero cannot win the uncovered part. Heads-up at 5/10, hero calling 40 into a
   * 310 shove was priced at +82.8 chips. The truth is 30 into 80, 37.5%, -4.2. `invariants.test.ts` in
   * the engine finds 5,650 such spots in 4,000 random hands.
   * Required, because a default of `pot` is the defect. Seat-state callers use `contestablePotFor`, and
   * described spots use `deriveContestablePot`. `validate` refuses a value above `pot`, and any
   * subtraction while `toCall < heroStack`.
   */
  readonly contestablePot: number;
  /** What hero must add to continue. 0 when hero can check. */
  readonly toCall: number;
  /**
   * Chips hero has ALREADY put out on this street (a blind, a raised bet, a limp). Required, because the
   * engine's `to` is a total, `heroCommittedThisStreet + toCall + raiseBy`. 0 in the usual postflop case.
   */
  readonly heroCommittedThisStreet: number;
  /**
   * Chips hero has BEHIND, not counting `heroCommittedThisStreet` or earlier streets. Hero's street total
   * is `heroCommittedThisStreet + heroStack`, and no candidate may cost more than `heroStack`.
   */
  readonly heroStack: number;
  /** Each opponent still in the hand, on the same reading. */
  readonly opponentStacks: readonly OpponentStack[];
  readonly bigBlind: number;
  /**
   * The engine's `minTo` for a bet or raise here. Absent for callers with no hand state, and the Coach
   * then derives a floor never below the engine's (`minimumAggressiveTo`). Present, it is the authority.
   */
  readonly minimumRaiseTo?: number;
  /**
   * The action kinds the engine offers here, `legalActions(state, seat).map(entry => entry.type)`.
   * Nothing outside it is published. The engine also withholds a raise after a short all-in
   * (`mayRaise`) and offers nothing once betting closes, which a described spot cannot show.
   * Absent means there is no engine to ask, and `deriveLegalActions` answers. It never means everything
   * is permitted (ADR 0003).
   * Optional so a direct caller still gets the conservative derivation. An empty array is rejected.
   */
  readonly legalActions?: readonly CoachAction[];
  /**
   * How often a bet or raise is assumed to win uncontested. An input, so it is reported as an assumption.
   * Stated, it is the one rate for every size. Absent, a bet or raise after the flop against one opponent
   * with chips behind is priced against the hands that continue against its size (`continuingFor`).
   */
  readonly assumedFoldEquity?: number;
  /**
   * The stated range is already what continues against a bet of any size, as when a scenario says the
   * opponent does not fold. No row is then priced against part of it.
   */
  readonly wholeRangeContinues?: boolean;
  /** Caps Monte Carlo work when the exact path does not fit. */
  readonly samples?: number;
  readonly seed?: number;
}

const DEFAULT_ASSUMED_FOLD_EQUITY = 0.35;

function validate(input: CoachInput): void {
  if (input.heroCards.length !== 2) {
    throw new CoachError(`hero must hold exactly 2 cards, received ${input.heroCards.length}`);
  }
  const expectedBoard = { preflop: 0, flop: 3, turn: 4, river: 5 }[input.street];
  if (input.board.length !== expectedBoard) {
    throw new CoachError(
      `street "${input.street}" needs ${expectedBoard} board cards, received ${input.board.length}`,
    );
  }
  if (input.opponents.length < 1 || input.opponents.length > 5) {
    throw new CoachError(`the Coach handles 1 to 5 opponents, received ${input.opponents.length}`);
  }
  for (const value of [
    input.pot,
    input.contestablePot,
    input.toCall,
    input.heroStack,
    input.bigBlind,
    input.heroCommittedThisStreet,
    ...input.opponentStacks.flatMap((opponent) => [opponent.behind, opponent.committedThisStreet]),
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new CoachError(
        'pot, contestablePot, toCall, heroStack, bigBlind, heroCommittedThisStreet and every ' +
          "opponent's chips must be non-negative integers",
      );
    }
  }
  if (input.bigBlind === 0) throw new CoachError('bigBlind must be positive');
  // Checked both ways, because a wrong caller publishes a wrong price rather than an error.
  if (input.contestablePot > input.pot) {
    throw new CoachError(
      `contestablePot ${input.contestablePot} is above the ${input.pot} in the middle — it is the ` +
        'part of the pot hero can win, never a pot of its own',
    );
  }
  // Hero is shut out of chips only by failing to cover the bet. A subtraction here means a caller
  // priced this spot with another spot's side pot.
  if (input.toCall < input.heroStack && input.contestablePot !== input.pot) {
    throw new CoachError(
      `contestablePot ${input.contestablePot} is below the ${input.pot} in the middle while hero can ` +
        `cover the ${input.toCall} owed out of ${input.heroStack} behind. A hero who is not all-in ` +
        'for less leaves nothing above their reach, so there is no side pot to subtract.',
    );
  }
  // A minimum at or below the bet level is most likely an increment passed where a total was wanted.
  const betLevel = betLevelOf(input);
  const minimum = input.minimumRaiseTo;
  if (minimum !== undefined) {
    if (!Number.isInteger(minimum) || minimum <= betLevel) {
      throw new CoachError(
        `minimumRaiseTo must be a whole number of chips above the current bet level of ${betLevel}, ` +
          `received ${minimum} — it is a total commitment for the street, not an increment`,
      );
    }
  }
  if (input.toCall > input.heroStack) {
    // Not an error. A short stack's call is capped at the stack, as the engine does.
  }
  const legal = input.legalActions;
  if (legal !== undefined) {
    if (legal.length === 0) {
      throw new CoachError(
        'the engine offers no legal action at this decision point, so there is nothing to analyse — ' +
          "betting is closed for the hand, or it is not hero's turn. Do not ask for a report here; a " +
          'report whose every candidate is illegal is worse than no report.',
      );
    }
    // A list that disagrees with `toCall` is stale, and filtering against it would drop hero's real
    // option. Both directions are errors.
    if (input.toCall === 0 && legal.includes('call')) {
      throw new CoachError(
        'legalActions offers "call" with nothing to call — the action list and the spot describe ' +
          'different decision points',
      );
    }
    if (input.toCall > 0 && legal.includes('check')) {
      throw new CoachError(
        `legalActions offers "check" while ${input.toCall} is owed — the action list and the spot ` +
          'describe different decision points',
      );
    }
  }
  validateWinnable(input);
  const all = [...input.heroCards, ...input.board];
  if (new Set(all).size !== all.length) throw new CoachError('hero cards and board contain a duplicate');
  const foldEquity = input.assumedFoldEquity;
  if (foldEquity !== undefined && (foldEquity < 0 || foldEquity > 1)) {
    throw new CoachError(`assumedFoldEquity must be between 0 and 1, received ${foldEquity}`);
  }
}

function validateWinnable(input: CoachInput): void {
  for (const opponent of input.opponentStacks) {
    const winnable = opponent.winnable;
    if (winnable === undefined) continue;
    if (!Number.isInteger(winnable) || winnable < 0 || winnable > input.pot) {
      throw new CoachError(
        `an opponent's winnable must be whole chips no more than the pot, received ${winnable} with ` +
          `${input.pot} in the middle — a figure above the ${input.pot} counts chips that are not there`,
      );
    }
    if (opponent.behind > 0 && winnable !== input.pot) {
      throw new CoachError(
        `an opponent with ${opponent.behind} behind can match any bet, so it can win all ${input.pot} in ` +
          `the middle, not ${winnable}`,
      );
    }
  }
  // An all-in seat wins only some pots, so each stack must name the range that plays for them.
  if (
    input.opponentStacks.some((opponent) => opponent.behind === 0) &&
    input.opponentStacks.length !== input.opponents.length
  ) {
    throw new CoachError(
      `${input.opponentStacks.length} opponent stacks but ${input.opponents.length} ranges: with an ` +
        'opponent all in, the Coach needs one range per opponent to price the pots each can win',
    );
  }
}

/** Why the rule of 2 and 4 does not apply, or `null` when it does. Each kind gets its own sentence. */
export type RuleOfThumbRefusal =
  | { readonly kind: 'no-cards-to-come' }
  | { readonly kind: 'already-ahead'; readonly equityNow: number }
  | { readonly kind: 'no-clean-outs'; readonly dirty: number }
  | { readonly kind: 'not-a-probability'; readonly cleanOuts: number; readonly ceiling: number };

export function ruleOfThumbRefusalFor(
  outs: OutsResult | null,
  cardsToCome: 1 | 2 | null,
): RuleOfThumbRefusal | null {
  if (outs === null || cardsToCome === null) return { kind: 'no-cards-to-come' };
  // "Drawing" uses the threshold `computeOuts` uses for an out, read from `outs.refusal` so a moved
  // `aheadThreshold` cannot split them.
  if (outs.refusal !== null) {
    return { kind: 'already-ahead', equityNow: outs.refusal.equityNow };
  }
  if (outs.cleanCount === 0) return { kind: 'no-clean-outs', dirty: outs.dirtyCount };
  const ceiling = maximumOutsForRuleOf24(cardsToCome);
  if (outs.cleanCount > ceiling) {
    return { kind: 'not-a-probability', cleanOuts: outs.cleanCount, ceiling };
  }
  return null;
}

/**
 * The rule-of-2-and-4 figure, published as a fraction in 0..1. `ruleOf24` returns points in
 * `estimatePercent`, this converts once, and `assertProbabilityFraction` refuses anything else, so 36
 * can never render as "3,600.0%".
 * It counts clean outs only, as the shortcut's own explanation says.
 * It is compared with `probabilityOfHitting`, not equity, so `errorPoints` is the shortcut's error alone.
 * `unseen` is `outs.cardsConsidered`, the set the outs were counted from. Deriving 47 from the street
 * against a known hand (45 cards) reversed the error's sign. 9s8s on 7s6d2c against AhAd showed the
 * shortcut's 32% overstating by 0.55, when it understates `1 - (37/45)(36/44)` = 32.727% by 0.73.
 * `cardsConsidered` is at least 45 on the flop and 44 on the turn. A single-combo range removes two
 * cards and skips none, and a wider one removes none and skips at most two. So the guards in
 * `probabilityOfHitting` on `unseen` cannot fire from here.
 */
function buildRuleOfThumb(outs: OutsResult, cardsToCome: 1 | 2): NonNullable<EquitySummary['ruleOfThumb']> {
  // The set the outs were counted from, not 47 derived from the street.
  const unseen = outs.cardsConsidered;
  const exact = probabilityOfHitting(outs.cleanCount, unseen, cardsToCome);
  const accuracy = ruleOf24Accuracy(outs.cleanCount, cardsToCome, exact.probability);

  // The single conversion from percentage points to the fraction the contract carries.
  const estimateAsFraction = accuracy.estimate.estimatePercent / 100;
  assertProbabilityFraction(estimateAsFraction, 'the rule-of-2-and-4 estimate');

  return {
    estimate: estimateAsFraction,
    errorPoints: accuracy.errorPoints,
    note:
      `${accuracy.estimate.explanation} ${accuracy.verdict} ` +
      `The comparison is against the exact chance of one of those ${outs.cleanCount} clean cards ` +
      `arriving (${exact.derivation}), not against your equity: hitting and winning are different ` +
      `questions, and ${outs.dirtyCount === 0 ? 'the dirty-out count is zero here only because every out is clean' : `the ${outs.dirtyCount} dirty outs are exactly the gap between them`}. ` +
      'The shortcut is an approximation and this is its error, stated rather than hidden.',
  };
}

/**
 * The rule-of-2-and-4 figure, or `null` where the shortcut means nothing. The only way outside this file
 * to compute it, because multiplying total outs gives figures like 47 x 4 = 188%.
 */
export function ruleOfThumbFor(
  outs: OutsResult | null,
  cardsToCome: 1 | 2 | null,
): EquitySummary['ruleOfThumb'] {
  if (outs === null || cardsToCome === null) return null;
  if (ruleOfThumbRefusalFor(outs, cardsToCome) !== null) return null;
  return buildRuleOfThumb(outs, cardsToCome);
}

/** A probability outside 0..1 is a bug in this file, and it throws instead of reaching a panel. */
function assertProbabilityFraction(value: number, what: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CoachError(
      `${what} must be a fraction between 0 and 1, computed ${value}. It is published as a fraction ` +
        'because every probability on this contract is, and the UI multiplies by 100 to render it.',
    );
  }
}

function buildEquitySummary(
  result: EquityResult,
  outs: OutsResult | null,
  cardsToCome: 1 | 2 | null,
): EquitySummary {
  const hero = result.players[0];
  if (hero === undefined) throw new CoachError('equity result has no hero');

  // Shown with its actual error, and only where it has one.
  const ruleOfThumb = ruleOfThumbFor(outs, cardsToCome);

  return {
    heroEquity: hero.equity,
    method: result.method,
    trials: result.trials,
    confidenceHalfWidthPoints: result.confidence?.halfWidthPoints ?? null,
    ruleOfThumb,
    perPlayer: result.players.map((player) => ({
      label: player.label,
      equity: player.equity,
      win: player.win,
      tie: player.tie,
    })),
  };
}

function buildOutsBreakdown(outs: OutsResult | null): OutsBreakdown | null {
  if (outs === null) return null;
  return {
    clean: outs.cleanCount,
    dirty: outs.dirtyCount,
    total: outs.totalOuts,
    cleanCards: outs.clean.map((outcome) => outcome.label),
    dirtyCards: outs.dirty.map((outcome) => outcome.label),
    explanation: outs.explanation,
  };
}

/**
 * As the side-pots quiz teaches it: chips past hero's cap are a side pot only when a second opponent
 * can still contest them. Otherwise they are the bettor's own, returned uncalled.
 */
function outOfReachOf(input: CoachInput): CoachReport['outOfReach'] {
  if (input.pot <= input.contestablePot) return undefined;
  const cap = input.heroCommittedThisStreet + Math.min(input.toCall, input.heroStack);
  const reaching = input.opponentStacks.filter((seat) => seat.committedThisStreet + seat.behind > cap);
  return reaching.length >= 2 ? 'side-pot' : 'uncalled';
}

/** A price read off the whole middle would overstate what hero can win, so the chips past hero's cap are named. */
function outOfReachNote(
  pot: number,
  contestablePot: number,
  toCall: number,
  outOfReach: CoachReport['outOfReach'],
): string {
  const beyondReach = pot - contestablePot;
  if (beyondReach <= 0) return '';
  const what =
    outOfReach === 'uncalled'
      ? 'the part of the bet you cannot match, which goes back to the bettor uncalled'
      : 'a side pot you are not in';
  return (
    ` There are ${chips(pot)} in the middle, but you are all-in for less than the bet in front of ` +
    `you: ${chips(beyondReach)} of it is ${what}, because your ` +
    `${chips(toCall)} does not reach that far. The price above is against the ${chips(contestablePot)} ` +
    'you can actually win. Calling cannot win the rest of the middle no matter which hand is best.'
  );
}

/**
 * Chooses the whole sentence by direction, so a shortfall never reads "You clear that with 0.0% equity".
 */
function describePriceGap(heroEquity: number, breakEvenEquity: number): string {
  const points = (Math.abs(heroEquity - breakEvenEquity) * 100).toFixed(1);
  const equity = (heroEquity * 100).toFixed(1);
  return heroEquity >= breakEvenEquity
    ? `You clear that with ${equity}% equity, a ${points} point surplus.`
    : `You do not clear that: ${equity}% equity is ${points} points short of it.`;
}

/**
 * The call if every opponent who still owes chips calls too, the world the equity already describes.
 * The call row is the other half: every opponent dealt in, none of their chips. Null when nobody owes
 * chips, when an all-in already prices the call pot by pot or a seat behind could only call all in for
 * less, and when one range stands for several seats, as in the Lab.
 */
interface CallIfTheyCall {
  readonly seats: number;
  readonly pot: number;
  readonly breakEvenEquity: number;
  readonly ev: number;
}

function callIfTheyCall(input: CoachInput, heroEquity: number, split: PotSplit): CallIfTheyCall | null {
  const call = Math.min(input.toCall, input.heroStack);
  if (call === 0 || call < input.toCall || split.allIn.length > 0) return null;
  if (input.opponents.length !== input.opponentStacks.length) return null;
  const level = betLevelOf(input);
  const owes = input.opponentStacks.map((opponent) => Math.max(0, level - opponent.committedThisStreet));
  // A seat that can only call all in for less opens a side pot it cannot win, which one equity misprices.
  if (input.opponentStacks.some((opponent, index) => opponent.behind < (owes[index] ?? 0))) return null;
  const owed = owes.filter((amount) => amount > 0);
  if (owed.length === 0) return null;
  const pot = input.contestablePot + call + owed.reduce((sum, owes) => sum + owes, 0);
  return { seats: owed.length, pot, breakEvenEquity: call / pot, ev: heroEquity * pot - call };
}

/** Not "still to act": a big blind with the option is still to act and owes nothing. */
function yetToMatch(behind: CallIfTheyCall): string {
  return behind.seats === 1
    ? 'the player yet to match the bet'
    : `the ${behind.seats} players yet to match the bet`;
}

function theyCallSentence(behind: CallIfTheyCall): string {
  const who = behind.seats === 1 ? 'is 1 player' : `are ${behind.seats} players`;
  return (
    ` There ${who} after you yet to match the bet: the equity above assumes they all reach showdown, but this price ` +
    `leaves out what they would put in. If they call too, the pot you play for is ${chips(behind.pot)} and a call needs ` +
    `${percent(behind.breakEvenEquity)}. A raise behind you is not modelled, and it can cost the whole call.`
  );
}

/**
 * `PotOddsSummary.pot` is the contestable pot, so the price and the pot it is into are the same pot.
 * `CoachReport.potTotal` carries the whole middle beside it.
 */
function buildPotOddsSummary(
  pot: number,
  contestablePot: number,
  toCall: number,
  heroEquity: number,
  pricedPotByPot: boolean,
  behind: CallIfTheyCall | null,
  outOfReach: CoachReport['outOfReach'],
): PotOddsSummary {
  const odds = potOdds(contestablePot, toCall);
  // Equity against the whole table is not the share of a pot an all-in seat is not in.
  const gap = pricedPotByPot
    ? `Your ${percent(heroEquity)} is against the whole table, but an opponent all in for less splits ` +
      'the middle into pots with different players in them, so it does not price this call. The call ' +
      'row prices each pot against the players in it.'
    : describePriceGap(heroEquity, odds.breakEvenEquity);
  return {
    pot: contestablePot,
    toCall,
    breakEvenEquity: odds.breakEvenEquity,
    oddsRatio: odds.oddsRatio,
    equitySurplus: heroEquity - odds.breakEvenEquity,
    explanation:
      toCall === 0
        ? 'Nothing to call, so there is no price to beat — checking keeps you in for free.'
        : `${odds.explanation} ${gap}${behind === null ? '' : theyCallSentence(behind)}${outOfReachNote(pot, contestablePot, toCall, outOfReach)}`,
  };
}

/**
 * `effectiveStack` for a described spot. A bet hero has not matched still changes hands, so each
 * opponent counts its chips in front of it beyond hero's own. The chips-behind sentence is kept
 * wherever it gives the same figure, and always once every opponent is all in.
 */
export function effectiveStackOf(spot: DescribedSpot): {
  readonly effective: number;
  readonly explanation: string;
} {
  const plain = effectiveStack(
    spot.heroStack,
    spot.opponentStacks.map((opponent) => opponent.behind),
  );
  if (spot.opponentStacks.every((opponent) => opponent.behind === 0)) return plain;
  const reaches = spot.opponentStacks.map((opponent) =>
    Math.max(0, opponent.behind + opponent.committedThisStreet - spot.heroCommittedThisStreet),
  );
  const counted = effectiveStack(spot.heroStack, reaches);
  if (counted.effective === plain.effective) return plain;
  const reach = Math.max(...reaches);
  const deepest = spot.opponentStacks[reaches.indexOf(reach)];
  const ahead = (deepest?.committedThisStreet ?? 0) - spot.heroCommittedThisStreet;
  const behind = chips(deepest?.behind ?? 0);
  const why =
    ahead > 0
      ? `Chips already bet this street are still in play: the deepest opponent has ${behind} behind and ${chips(ahead)} more than you in front of them, so ${chips(reach)} can still come against you. `
      : ahead < 0
        ? `The deepest opponent has ${behind} behind but must put ${chips(-ahead)} of it in just to match you, so ${chips(reach)} can still come against you. `
        : '';
  return { effective: counted.effective, explanation: `${why}${counted.explanation}` };
}

/** True when calling puts in the rest of hero's stack, so no bet can follow it. The panel reads the same. */
export function callIsAllIn(candidates: readonly ActionCandidate[]): boolean {
  return candidates.some((row) => row.action === 'call' && row.allIn === true);
}

function buildStackContext(input: CoachInput, heroCallIsAllIn: boolean): StackContext {
  const effective = effectiveStackOf(input);
  // SPR is undefined with an empty pot, which only happens preflop before blinds.
  const pot = Math.max(1, input.pot);
  const spr = stackToPotRatio(effective.effective, pot);
  const potSizedPrice = priceLaidByBet(pot, pot);
  // At 0, or once hero's call is all in, no bet can follow, so a depth band describing betting to come
  // would not be true.
  return {
    effectiveStack: effective.effective,
    spr: spr.spr,
    potOddsOfferedByPotSizedBet: potSizedPrice.breakEvenEquity,
    explanation:
      effective.effective === 0 || heroCallIsAllIn
        ? effective.explanation
        : `${effective.explanation} ${spr.explanation} ${spr.implication}`,
  };
}

/**
 * The smallest legal bet or raise total, in the engine's `to` units. `minimumRaiseTo` wins when given.
 * Otherwise `betLevel + max(toCall, bigBlind)`. The last full raise increment is unknown but at most
 * `toCall`, because hero matched or set the level before it. So the floor is always legal, and exact
 * when the bet faced is the last raise. Erring upward is the safe direction for what gets published.
 * The all-in clamp lives here because `apps/api/src/routes/content.ts` holds a learner's size to this
 * floor too, and a short shove is legal. A caller refusing below this floor may refuse a size a real
 * table accepts, so it must quote the floor back.
 */
export function minimumAggressiveTo(spot: SizedSpot): number {
  const derived = spot.minimumRaiseTo ?? betLevelOf(spot) + Math.max(spot.toCall, spot.bigBlind);
  return Math.min(derived, maximumTo(spot));
}

/**
 * A raise's sizing note. The ladder's "Risks X to win pot" is false for a raise.
 * Minimum defence is `pot / (pot + c + r)` against the pot before the call. The ladder given
 * `potAfterCall` counts hero's own call as winnings. At pot 150 and toCall 50, a raise to 100 showed
 * 80.0% where the answer is 60.0%. `defenceFrequency` is right for a bet, so it stays as it is.
 */
function raiseSizingNote(
  option: SizingOption,
  raiseBy: number,
  sizeId: OfferedSize['id'],
  potAfterCall: number,
  potBeforeCall: number,
  toCall: number,
  isAllIn: boolean,
): string {
  // MDF = pot / (pot + c + r). The complement of the raiser's break-even bluff frequency,
  // alpha = (c + r) / (pot + c + r).
  const risked = toCall + option.amount;
  const minimumDefence = potBeforeCall / (potBeforeCall + risked);
  const share = `${percent(raiseBy / potAfterCall)} of the ${chips(potAfterCall)} that would be in the middle once you call`;
  const shape =
    sizeId === 'allIn'
      ? `Raising by ${chips(raiseBy)} puts your whole remaining stack in.`
      : sizeId === 'minimum'
        ? `Raising by ${chips(raiseBy)} is the smallest raise the rules allow here: ${share}.`
        : `Raising by ${chips(raiseBy)} is the ${SIZE_WORDS[sizeId]} size: ${share}.`;
  const allIn = isAllIn && sizeId !== 'allIn' ? ' That size is also your whole remaining stack.' : '';
  return (
    `${shape} A caller needs ${percent(option.priceLaidToCaller)} equity to break even on the extra ` +
    `${chips(option.amount)}, and has to continue with ${percent(minimumDefence)} of ` +
    `their range for a raise of this size not to print automatically.${allIn}`
  );
}

/** Named for the button, not the fraction, because presets round and clamp to the floor or the stack. */
const SIZE_WORDS: Readonly<Record<OfferedSize['id'], string>> = {
  minimum: 'minimum',
  third: '⅓-pot',
  half: '½-pot',
  twoThirds: '⅔-pot',
  pot: 'pot-sized',
  allIn: 'all-in',
};

/** The sentence that names a bet's size, ahead of the ladder's note. The note says all-in itself. */
function betSizeSentence(sizeId: OfferedSize['id']): string {
  if (sizeId === 'allIn') return '';
  if (sizeId === 'minimum') return 'This is the smallest bet the rules allow here. ';
  return `This is the ${SIZE_WORDS[sizeId]} size. `;
}

/** The bounds and pot every offered size is built from, shared by the candidates and the ½-pot line. */
function sizingContextFor(input: CoachInput): SizingContext {
  return {
    bounds: { min: minimumAggressiveTo(input), max: maximumTo(input) },
    pot: input.contestablePot,
    toCall: input.toCall,
    committedThisStreet: input.heroCommittedThisStreet,
  };
}

/** Empty unless the size is more than any opponent can match. */
function uncalledSentence(
  kind: 'bet' | 'raise',
  raiseBy: number,
  calledBy: number,
  input: CoachInput,
): string {
  if (calledBy === raiseBy) return '';
  // A seat short of the bet has to spend part of its stack matching it first.
  const limit = input.opponentStacks.some((opponent) => opponent.behind > calledBy)
    ? `No opponent can put more than ${chips(calledBy)} on top of the ${chips(betLevelOf(input))} bet`
    : `No opponent has more than ${chips(calledBy)} behind`;
  return (
    `${limit}, so only ${chips(calledBy)} of the ` +
    `${chips(raiseBy)} ${kind} can be called and the other ${chips(raiseBy - calledBy)} comes back to you. `
  );
}

/**
 * The pots a showdown is played for once an opponent is all in. Each all-in seat caps a layer at what
 * it reached, so the layers nest: the lowest is contested by everyone, the top only by seats with chips
 * behind. With nobody all in there is one pot and every share is hero's equity.
 */
interface PotSplit {
  /** Lowest reach first. `toMatch` is what hero must add before passing the seat's cap. */
  readonly allIn: readonly { readonly index: number; readonly winnable: number; readonly toMatch: number }[];
  readonly live: readonly number[];
  /** Hero's share of a pot contested by these opponents, every opponent still dealt in. */
  readonly share: (group: readonly number[]) => number;
  /**
   * Hero's chips already in that no opponent can match, as when a big blind is all in for less than
   * the small blind. The engine hands them back on a fold as well, so no action gains them. Read as
   * the pot no opponent can win, it also counts a folded seat's chips above the all-in, which a fold
   * returns to that seat: one chip too many when a seat that folded paid an ante the all-in could not.
   */
  readonly returnedAnyway: number;
  /**
   * For a line that costs this much: the share of the range's hands that continue against it, ties at
   * the boundary included, and hero's share against those hands. Null where every size is priced
   * against the whole range at one fold rate.
   */
  readonly continuing: (cost: number) => Continuing | null;
}

interface Continuing {
  readonly share: number;
  readonly equity: number;
}

interface ShowdownPot {
  readonly amount: number;
  readonly share: number;
  /** How many opponents can win it. */
  readonly contesting: number;
}

function allInOf(input: CoachInput): PotSplit['allIn'] {
  const allIn: PotSplit['allIn'][number][] = [];
  for (const [index, opponent] of input.opponentStacks.entries()) {
    if (opponent.behind > 0) continue;
    const street = opponent.committedThisStreet;
    const above = [input.heroCommittedThisStreet, ...input.opponentStacks.map((o) => o.committedThisStreet)];
    const derived = input.pot - above.reduce((sum, chips) => sum + Math.max(0, chips - street), 0);
    allIn.push({
      index,
      winnable: opponent.winnable ?? Math.max(0, derived),
      toMatch: Math.max(0, street - input.heroCommittedThisStreet),
    });
  }
  return allIn.sort((a, b) => a.winnable - b.winnable);
}

function liveOf(input: CoachInput): number[] {
  return input.opponentStacks.flatMap((opponent, index) => (opponent.behind > 0 ? [index] : []));
}

/** The groups `potSplitOf` reads a share for, as `EquitySpec.contests` (hero is player 0). */
function contestsFor(input: CoachInput): number[][] {
  const allIn = allInOf(input).map((seat) => seat.index);
  const live = liveOf(input);
  const groups = allIn.flatMap((_seat, j) => [allIn.slice(j), [...live, ...allIn.slice(j)]]);
  const partial = [live, ...groups].filter(
    (group) => allIn.length > 0 && group.length > 0 && group.length < input.opponentStacks.length,
  );
  const unique = new Map(partial.map((group) => [keyOf(group), group]));
  return [...unique.values()].map((group) => group.map((index) => index + 1));
}

/**
 * Narrows only where the bots' continue rate was measured to fit: after the flop, against one opponent.
 * A caller that states the fold rate, or that the whole range continues, has said what calls. Heads-up
 * after the flop is at most 1,326 hands by 990 boards, inside the exact budget, so these shares are
 * enumerated like the equity beside them and carry no sampling interval.
 */
function continuingFor(input: CoachInput, heroEquity: number): PotSplit['continuing'] {
  const [opponent, ...others] = input.opponents;
  const narrows =
    input.street !== 'preflop' &&
    others.length === 0 &&
    input.opponentStacks.length === 1 &&
    input.contestablePot > 0 &&
    input.wholeRangeContinues !== true &&
    input.assumedFoldEquity === undefined;
  if (!narrows || opponent === undefined) return () => null;
  const order = rankAgainstBoard(opponent.range, input.board, input.heroCards);
  const all = order.combos.length;
  // Hero's share summed over the strongest n hands. Every hand meets the same number of boards, so a
  // range's equity is the mean over its hands, and each size costs only the band of hands between it
  // and the nearest count already known. One enumeration per size took the flop against any two
  // cards from 0.7 s to 2.4 s.
  const summed = new Map<number, number>([
    [0, 0],
    [all, all * heroEquity],
  ]);
  const band = (from: number, to: number): number => {
    const players = [
      { label: 'you', range: exactRange(input.heroCards) },
      { label: opponent.label, range: { ...opponent.range, combos: order.combos.slice(from, to) } },
    ];
    return (to - from) * (exactEquity({ players, board: input.board }).players[0]?.equity ?? 0);
  };
  const sumOver = (count: number): number => {
    const known = summed.get(count);
    if (known !== undefined) return known;
    const below = Math.max(...[...summed.keys()].filter((n) => n < count));
    const above = Math.min(...[...summed.keys()].filter((n) => n > count));
    const sum =
      count - below <= above - count
        ? (summed.get(below) ?? 0) + band(below, count)
        : (summed.get(above) ?? 0) - band(count, above);
    summed.set(count, sum);
    return sum;
  };
  return (cost) => {
    // The share is the hands priced as calling, not the share asked for: the rest are the fold rate,
    // so a known hand, or a size every hand ties into, carries no fold credit.
    const count = continuingRange(order, input.contestablePot, cost).range.combos.length;
    if (count === all) return { share: 1, equity: heroEquity };
    // A difference of sums lands a hair outside 0..1 where the true share is exactly 0 or 1.
    return { share: count / all, equity: Math.min(1, Math.max(0, sumOver(count) / count)) };
  };
}

function potSplitOf(input: CoachInput, result: EquityResult, heroEquity: number): PotSplit {
  const measured = new Map(
    contestsFor(input).map((group, i) => [
      keyOf(group.map((player) => player - 1)),
      result.contestShares?.[i],
    ]),
  );
  const allIn = allInOf(input);
  const live = liveOf(input);
  const top = allIn.at(-1);
  return {
    allIn,
    live,
    continuing: continuingFor(input, heroEquity),
    // A seat with chips behind has matched hero, so only a table of all-in seats leaves any over.
    returnedAnyway:
      live.length === 0 && top !== undefined ? Math.max(0, input.contestablePot - top.winnable) : 0,
    share: (group) => {
      if (group.length === 0) return 1;
      if (group.length === input.opponentStacks.length) return heroEquity;
      const share = measured.get(keyOf(group));
      if (share === undefined) throw new CoachError(`internal: no share was measured for ${keyOf(group)}`);
      return share;
    },
  };
}

function keyOf(group: readonly number[]): string {
  return [...group].sort((a, b) => a - b).join(',');
}

/**
 * The pots once hero adds `heroAdds` and, when called, a caller adds `callerAdds`. A fold leaves only
 * the all-in seats, and hero's chips above their caps come back. `value` is net of hero's chips and of
 * `returnedAnyway`, so it is measured against hero folding.
 */
function showdownPots(
  split: PotSplit,
  input: CoachInput,
  heroAdds: number,
  callerAdds: number,
  branch: 'called' | 'folded',
): { readonly pots: readonly ShowdownPot[]; readonly paid: number; readonly value: number } {
  const folded = branch === 'folded';
  const matched = Math.min(heroAdds, Math.max(0, ...split.allIn.map((seat) => seat.toMatch)));
  const paid = folded ? matched : heroAdds;
  const total = input.contestablePot + paid + (folded ? 0 : callerAdds);
  const pots: ShowdownPot[] = [];
  let below = 0;
  let value = 0;
  const add = (top: number, group: readonly number[]): void => {
    const amount = Math.min(top, total) - below;
    if (amount <= 0) return;
    const share = split.share(group);
    pots.push({ amount, share, contesting: group.length });
    value += share * amount;
    below += amount;
  };
  for (const [j, seat] of split.allIn.entries()) {
    const contesting = split.allIn.slice(j).map((entry) => entry.index);
    add(
      seat.winnable + Math.min(heroAdds, seat.toMatch),
      folded ? contesting : [...split.live, ...contesting],
    );
  }
  add(total, folded ? [] : split.live);
  return { pots, paid, value: value - paid - split.returnedAnyway };
}

/** "the 300 main pot at 0% and the 200 side pot at 100%". */
function describePots(pots: readonly ShowdownPot[]): string {
  const named = pots.map((pot, i) => {
    const name = `the ${chips(pot.amount)} ${i === 0 ? 'main' : 'side'} pot`;
    return pot.contesting === 0 ? `${name}, uncontested` : `${name} at ${percent(pot.share)}`;
  });
  return named.length < 2 ? (named[0] ?? 'nothing') : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
}

function allInClause(split: PotSplit): string {
  const count = split.allIn.length;
  return `${count === 1 ? 'One opponent is' : `${count} opponents are`} all in and cannot fold`;
}

/** A check or call priced pot by pot, or null when one pot holds everything and every opponent is in it. */
function layeredShowdown(kind: 'check' | 'call', split: PotSplit, input: CoachInput, heroAdds: number) {
  const { pots, value } = showdownPots(split, input, heroAdds, 0, 'called');
  if (pots.every((pot) => pot.contesting === input.opponentStacks.length)) return null;
  const deductions = [
    ...(heroAdds > 0 ? [`your ${chips(heroAdds)}`] : []),
    ...(split.returnedAnyway > 0 ? [`the ${chips(split.returnedAnyway)} a fold hands back too`] : []),
  ];
  const less = deductions.length > 0 ? `, less ${deductions.join(' and ')}` : '';
  return {
    ev: value,
    derivation:
      `EV(${kind}): you play for ${describePots(pots)}${less}, ${chips(value)} chips. An all-in opponent wins only ` +
      'the chips its stack reached, so each pot is priced against the players in it.',
  };
}

/** A bet or raise against an all-in seat: a fold still leaves the pots it is in to showdown. */
function layeredAggression(
  kind: 'bet' | 'raise',
  split: PotSplit,
  input: CoachInput,
  heroAdds: number,
  callerAdds: number,
  f: number,
) {
  const called = showdownPots(split, input, heroAdds, callerAdds, 'called');
  const folded = showdownPots(split, input, heroAdds, 0, 'folded');
  const ev = f * folded.value + (1 - f) * called.value;
  const matched = folded.paid > 0 ? `, less your ${chips(folded.paid)}` : '';
  return {
    ev,
    derivation:
      `EV(${kind}) = f x [everyone who can fold does] + (1 - f) x [called] = ${frac(f)} x ${signedChips(folded.value)} + ` +
      `${frac(1 - f)} x ${signedChips(called.value)} = ${chips(ev)} chips. ${allInClause(split)}, so a fold ` +
      `still leaves ${describePots(folded.pots)}${matched}: worth ${chips(folded.value)}. Called, you play for ` +
      `${describePots(called.pots)}, less your ${chips(heroAdds)}: ${chips(called.value)}.`,
  };
}

/** What a bet or raise row assumes of a caller: the hands that continue against its cost, or the whole range. */
function assumedFor(split: PotSplit, cost: number, foldEquity: number, heroEquity: number) {
  const continuing = split.continuing(cost);
  if (continuing === null) return { foldEquityAssumed: foldEquity, potShareIfCalled: heroEquity };
  return {
    foldEquityAssumed: 1 - continuing.share,
    potShareIfCalled: continuing.equity,
    continuingShare: continuing.share,
  };
}

/**
 * Candidate actions with EV relative to folding, which is zero. Sunk chips do not appear.
 * Raising by `r` facing `c` risks `c + r` (`evOfRaise`), and its total is
 * `heroCommittedThisStreet + toCall + r`. The floor itself is offered, because an untouched sizer
 * sends it. Bet versus raise follows the engine's `betLevel === 0`, not `toCall`.
 * Every candidate passes `input.legalActions`, or `deriveLegalActions` when it is absent.
 */
function buildCandidates(
  input: CoachInput,
  heroEquity: number,
  foldEquity: number,
  split: PotSplit,
): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  // Resolved once, so an absent `legalActions` can never short-circuit to "permitted".
  const legal = input.legalActions ?? deriveLegalActions(input);
  const permitted = (action: CoachAction): boolean => legal.includes(action);

  const betLevel = betLevelOf(input);
  const isOpening = betLevel === 0;

  // Every EV uses `contestablePot`, never `pot`. See `CoachInput.contestablePot`.
  const pot = input.contestablePot;

  // Check before fold. The sort is stable, so on a tie the line that keeps the hand wins.
  if (input.toCall === 0 && permitted('check')) {
    const check = layeredShowdown('check', split, input, 0) ?? evOfCheck({ pot, equity: heroEquity });
    candidates.push({
      action: 'check',
      cost: 0,
      ev: check.ev,
      derivation: check.derivation,
      // No `potShareIfCalled`, because nothing is called.
    });
  }

  if (permitted('fold')) {
    const fold = evOfFold();
    candidates.push({
      action: 'fold',
      cost: 0,
      ev: fold.ev,
      derivation: `${fold.derivation} Everything already in the pot is spent either way, so folding is the zero point every other action is measured against.`,
    });
  }

  if (input.toCall > 0 && permitted('call')) {
    const cappedCall = Math.min(input.toCall, input.heroStack);
    const layered = layeredShowdown('call', split, input, cappedCall);
    const call = layered ?? evOfCall({ pot, toCall: cappedCall, equity: heroEquity });
    candidates.push({
      action: 'call',
      // The street total, matching the engine.
      to: input.heroCommittedThisStreet + cappedCall,
      cost: cappedCall,
      ev: call.ev,
      derivation: call.derivation,
      // Several pots have several shares, so none is published.
      ...(layered === null ? { potShareIfCalled: heroEquity } : {}),
    });
  }

  // The increment an all-in would be. The part that matches the bet is not a raise.
  const maxRaiseBy = input.heroStack - input.toCall;
  // The most a caller can add above the bet: its street total less the bet level. At 0 every chip
  // of a raise comes back, so the call row already prices it.
  const callable = Math.max(
    0,
    ...input.opponentStacks.map((opponent) => opponent.committedThisStreet + opponent.behind - betLevel),
  );
  if (maxRaiseBy > 0 && callable > 0 && permitted(isOpening ? 'bet' : 'raise')) {
    // Sizes are fractions of the pot after the call. For an opening bet that is the pot.
    const potAfterCall = Math.max(1, pot + input.toCall);

    // Exactly the sizes the bar offers, because a sized action is graded only on an exact match.
    // `pot` equals the whole middle here, because `maxRaiseBy > 0` means hero covers the bet.
    // `apps/web/test/lab-sizes-priced.test.ts` asserts the equality.
    for (const size of offeredSizes(sizingContextFor(input))) {
      const raiseBy = size.to - betLevel;
      if (raiseBy <= 0) continue;
      const isAllIn = raiseBy === maxRaiseBy;
      // Kept as a row because the bar offers it, but priced on what can be called.
      const calledBy = Math.min(raiseBy, callable);
      const option = sizingOptionAt(potAfterCall, calledBy, SIZE_WORDS[size.id], calledBy === maxRaiseBy);

      // The sizing notes assume a fold wins the pot, which is false while a seat is all in.
      if (split.allIn.length > 0) {
        const kind = isOpening ? 'bet' : 'raise';
        const cost = input.toCall + calledBy;
        const layered = layeredAggression(kind, split, input, cost, calledBy, foldEquity);
        const extra = isOpening ? betSizeSentence(size.id) : '';
        candidates.push({
          action: kind,
          to: betLevel + raiseBy,
          cost,
          ev: layered.ev,
          derivation:
            `${layered.derivation} ${extra}${uncalledSentence(kind, raiseBy, calledBy, input)}`.trimEnd(),
          foldEquityAssumed: foldEquity,
        });
        continue;
      }

      const assumed = assumedFor(split, input.toCall + calledBy, foldEquity, heroEquity);
      const priced = {
        foldProbability: assumed.foldEquityAssumed,
        equityWhenCalled: assumed.potShareIfCalled,
        callerCanRaise: true,
      };

      if (isOpening) {
        const bet = evOfBet({ pot, betSize: calledBy, ...priced });
        candidates.push({
          action: 'bet',
          to: raiseBy,
          cost: calledBy,
          ev: bet.ev,
          derivation: `${bet.derivation} ${betSizeSentence(size.id)}${uncalledSentence('bet', raiseBy, calledBy, input)}${option.note}`,
          ...assumed,
        });
        continue;
      }

      const raise = evOfRaise({ pot, toCall: input.toCall, raiseBy: calledBy, ...priced });
      candidates.push({
        action: 'raise',
        to: betLevel + raiseBy,
        cost: raise.risk,
        ev: raise.ev,
        derivation: `${raise.derivation} ${uncalledSentence('raise', raiseBy, calledBy, input)}${raiseSizingNote(option, raiseBy, size.id, potAfterCall, pot, input.toCall, isAllIn)}`,
        ...assumed,
      });
    }
  }

  // Not priced as a raise row, because one tied with the call would outrank it (`TIEBREAK_RANK`).
  if (maxRaiseBy > 0 && callable === 0 && !isOpening && permitted('raise')) {
    const at = candidates.findIndex((candidate) => candidate.action === 'call');
    const call = candidates[at];
    if (call !== undefined) {
      candidates[at] = {
        ...call,
        derivation:
          `${call.derivation} The table offers a raise, but no opponent can put in a chip above the ` +
          `${chips(betLevel)} bet, so a raise plays exactly as a call: every chip above it comes back.`,
      };
    }
  }

  // The engine's `allInAtMax` holds at `maxTo`, so a row says all in exactly where its button does.
  const maxTo = maximumTo(input);
  const flagged = candidates.map((row) => (row.to === maxTo ? { ...row, allIn: true as const } : row));
  assertAffordable(flagged, input);
  return flagged;
}

/**
 * Asserts rather than clamps, because a clamp would publish a different action from the one priced.
 * `cost` is chips leaving the stack, compared with `heroStack`. `to` is the street total, compared
 * with `maximumTo`.
 */
function assertAffordable(candidates: readonly ActionCandidate[], input: CoachInput): void {
  const maxTo = maximumTo(input);
  for (const candidate of candidates) {
    if (candidate.cost > input.heroStack) {
      throw new CoachError(
        `internal: the ${candidate.action} candidate costs ${candidate.cost} but hero has only ` +
          `${input.heroStack} behind. A published row must be one hero could actually pay for.`,
      );
    }
    if (candidate.to !== undefined && candidate.to > maxTo) {
      throw new CoachError(
        `internal: the ${candidate.action} candidate reaches a street total of ${candidate.to}, above ` +
          `hero's maximum of ${maxTo} (${input.heroCommittedThisStreet} already out plus ` +
          `${input.heroStack} behind).`,
      );
    }
  }
}

/**
 * Lower sorts later, so folding is last. A tie is reachable because `EV(check)` is 0 for a dead hand,
 * and folding gives up the hand for the same zero.
 */
const TIEBREAK_RANK: Readonly<Record<CoachAction, number>> = {
  raise: 4,
  bet: 4,
  call: 3,
  check: 2,
  fold: 1,
};

/** EV descending, ties broken so that giving up the hand never wins one. */
function byExpectedValue(left: ActionCandidate, right: ActionCandidate): number {
  if (right.ev !== left.ev) return right.ev - left.ev;
  return TIEBREAK_RANK[right.action] - TIEBREAK_RANK[left.action];
}

/**
 * A bet or raise row's EV at a fold rate of 0 and of 1. EV is linear in f between them. `whenCalled` is
 * the row as priced. `calledAtWorst` is the lower of that and the whole range calling, which a row has
 * to beat checking or calling on, so pricing against part of the range never adds a reading.
 */
function branchesOf(row: ActionCandidate, input: CoachInput, split: PotSplit) {
  const called = (shares: PotSplit) =>
    showdownPots(shares, input, row.cost, row.cost - input.toCall, 'called').value;
  const continuing = split.continuing(row.cost);
  const byAll = called(split);
  const whenCalled = continuing === null ? byAll : called({ ...split, share: () => continuing.equity });
  return {
    whenCalled,
    byAll,
    calledAtWorst: Math.min(whenCalled, byAll),
    byCallers: continuing !== null && whenCalled <= byAll,
    whenFolded: showdownPots(split, input, row.cost, 0, 'folded').value,
  };
}

/**
 * Names the row the reading set aside and what overtaking the reading would take: a fold rate below the
 * assumed one, or, where the fold rate is the hands that do not call, what those that do are worth.
 */
function foldRateNote(row: ActionCandidate, reading: ActionCandidate, input: CoachInput, split: PotSplit) {
  const { whenCalled, calledAtWorst, whenFolded } = branchesOf(row, input, split);
  // Not behind when called, so it was set aside for its size, and that note says so.
  if (calledAtWorst >= reading.ev) return '';
  const line = row.action === 'bet' ? `Betting ${row.to}` : `Raising to ${row.to}`;
  if (whenCalled >= reading.ev) {
    return (
      ` ${line} shows a higher figure only if the weaker hands fold as assumed. Called by the whole ` +
      `range it is behind ${reading.action}ing.`
    );
  }
  const narrowed = row.continuingShare !== undefined && row.continuingShare < 1;
  const shown =
    ` ${line} shows a higher figure only because it assumes ` +
    (narrowed
      ? `the weakest ${shareOf(1 - (row.continuingShare ?? 1))} of the range folds to it, `
      : `they fold ${shareOf(row.foldEquityAssumed ?? 0)} of the time, `) +
    'which nothing here measures.';
  if (narrowed) {
    const [worth, bar] = [whenCalled.toFixed(1), reading.ev.toFixed(1)];
    const value =
      whenCalled < 0 ? `it loses ${(-whenCalled).toFixed(1)} units` : `it is worth ${worth} units`;
    const behind =
      reading.ev === 0
        ? `, where ${lineName(reading)} loses nothing`
        : `, ${worth === bar ? 'a fraction of a unit ' : ''}behind ${lineName(reading)}'s ${bar}`;
    return `${shown} Called only by the strongest ${shareOf(row.continuingShare)} of the range, ${value}${behind}.`;
  }
  const needed = foldRateReaching(reading.ev, whenFolded, whenCalled);
  return `${shown} It beats ${reading.action}ing only if they fold more than ${percent(needed)} of the time.`;
}

/**
 * Empty unless the reading is priced against part of the range. Eligibility put its value called by
 * that part at or above `bar`, the best line that needs no fold, so a shortfall here is a defect.
 */
function aheadOfCallersNote(
  best: ActionCandidate,
  bar: { readonly name: string; readonly ev: number },
  input: CoachInput,
  split: PotSplit,
): string {
  const share = best.continuingShare;
  if (share === undefined || share >= 1) return '';
  const ahead = branchesOf(best, input, split).whenCalled - bar.ev;
  if (ahead < 0) {
    throw new CoachError(`internal: ${lineName(best)} is the reading but is ${-ahead} behind ${bar.name}.`);
  }
  const by = ahead.toFixed(1) === '0.0' ? 'no less than' : `${ahead.toFixed(1)} units more than`;
  return ` Called only by the strongest ${shareOf(share)} of the range, ${lineName(best)} is still worth ${by} ${bar.name}.`;
}

/** Why a row cannot be the reading. Either way the margin counts it as always called. */
type SetAside = 'fold-rate' | 'above-pot';

/**
 * Past the pot, a size every hand calls reads each added chip as profit, and one priced against the hands
 * that continue rests on how often a size that large is assumed to be called. An all-in up to twice the
 * pot is kept, because a pot-sized bet would commit the stack just the same.
 */
function abovePot(row: ActionCandidate, input: CoachInput, times = row.allIn === true ? 2 : 1): boolean {
  if (row.action !== 'bet' && row.action !== 'raise') return false;
  return row.cost - input.toCall > times * (input.contestablePot + input.toCall);
}

function setAsideFor(
  row: ActionCandidate,
  input: CoachInput,
  split: PotSplit,
  measuredBest: number,
): SetAside | null {
  if (restsOnAssumedFoldEquity(row) && branchesOf(row, input, split).calledAtWorst < measuredBest) {
    return 'fold-rate';
  }
  return abovePot(row, input) ? 'above-pot' : null;
}

/** Empty unless a row above pot reads higher on the table than the reading does, or is the reading. */
function abovePotNote(
  ranked: readonly ActionCandidate[],
  best: ActionCandidate,
  setAside: ReadonlyMap<ActionCandidate, SetAside>,
  input: CoachInput,
): string {
  if (abovePot(best, input, 1)) {
    const kind = best.action === 'bet' ? 'bet' : 'raise';
    const kept = ` ${capitalised(lineName(best))} is more than the pot. It is kept because a pot-sized ${kind} would leave under a third of the pot behind, but its figure `;
    return best.continuingShare === undefined
      ? `${kept}assumes the whole range calls any size, and a real opponent folds more of the hands you beat as the size grows.`
      : `${kept}rests on how often a ${kind} that large is assumed to be called.`;
  }
  const shown = ranked.find((row) => setAside.get(row) === 'above-pot');
  if (shown === undefined || shown.ev <= best.ev) return '';
  const kind = shown.action === 'bet' ? 'bet' : 'raise';
  const limit = `the reading goes no higher than a pot-sized ${kind}, or all in when that is at most twice the pot.`;
  if (shown.continuingShare !== undefined) {
    return ` ${capitalised(lineName(shown))} shows a higher figure, but it rests on how often a ${kind} that large is assumed to be called, so ${limit}`;
  }
  return (
    ` ${capitalised(lineName(shown))} shows a higher figure only because every figure here assumes the ` +
    `whole range calls any size, so past a pot-sized ${kind} each extra unit reads as profit. A real ` +
    `opponent folds more of the hands you beat as the size grows, so ${limit}`
  );
}

interface Rival {
  readonly row: ActionCandidate;
  /** True for a row set aside, which is measured at what it is worth called (`calledAtWorst`). */
  readonly alwaysCalled: boolean;
  /** True when that is against the hands that continue, not the whole range. */
  readonly byCallers: boolean;
  readonly value: number;
}

/**
 * The best other action. A row set aside still competes at its always-called value, so the margin is
 * not measured to a line that only the fold rate put behind. The next-best action, not the next row:
 * two sizes of one action can price within a chip, which made 12 of 36 Lab scenarios read as indifferent.
 */
function rivalOf(
  ranked: readonly ActionCandidate[],
  eligible: readonly ActionCandidate[],
  best: ActionCandidate,
  input: CoachInput,
  split: PotSplit,
): Rival | undefined {
  let found: Rival | undefined;
  for (const row of ranked) {
    if (row.action === best.action) continue;
    const called = eligible.includes(row) ? null : branchesOf(row, input, split);
    const value = called?.calledAtWorst ?? row.ev;
    if (found === undefined || value > found.value) {
      found = { row, alwaysCalled: called !== null, byCallers: called?.byCallers === true, value };
    }
  }
  return found;
}

/** Named, because the table shows a set-aside row at its fold-rate figure, not the one measured to. */
function nameOfRival(rival: Rival | undefined): string {
  if (rival === undefined) return 'the next-best action';
  const counted = rival.byCallers ? 'against the hands that call it' : 'as always called';
  return `${lineName(rival.row)}${rival.alwaysCalled ? ` (counted ${counted})` : ''}`;
}

/** Empty unless the highest row of another action sits above the rival on the table only by the fold rate. */
function readsCloserNote(
  ranked: readonly ActionCandidate[],
  best: ActionCandidate,
  rival: Rival | undefined,
) {
  const shown = ranked.find((c) => c.action !== best.action);
  if (shown === undefined || rival === undefined || shown === rival.row || shown.ev <= rival.value) return '';
  const closer = ` ${capitalised(lineName(shown))} reads closer on the table only because it assumes`;
  // Priced against the hands that continue, the fold rate is who does not call, not a separate guess.
  if (shown.continuingShare !== undefined && shown.continuingShare < 1) {
    return `${closer} the weakest ${shareOf(1 - shown.continuingShare)} of the range folds to it.`;
  }
  return `${closer} they fold ${((shown.foldEquityAssumed ?? 0) * 100).toFixed(0)}% of the time.`;
}

/**
 * A row's EV under `split`, at its fold rate unless counted as always called. A check or call adds no
 * opponent chips, so it never goes through `branchesOf`, which reads a short call as a negative raise.
 */
function valueUnder(row: ActionCandidate, alwaysCalled: boolean, input: CoachInput, split: PotSplit): number {
  if (row.action === 'fold') return 0;
  if (row.action === 'check' || row.action === 'call') {
    return showdownPots(split, input, row.cost, 0, 'called').value;
  }
  const { whenCalled, calledAtWorst, whenFolded } = branchesOf(row, input, split);
  if (alwaysCalled) return calledAtWorst;
  const f = row.foldEquityAssumed ?? 0;
  return f * whenFolded + (1 - f) * whenCalled;
}

/** The interval is read by repricing rows, so a row it would reprice differently is refused. */
function assertRepriced(candidates: readonly ActionCandidate[], input: CoachInput, split: PotSplit): void {
  for (const row of candidates) {
    const repriced = valueUnder(row, false, input, split);
    if (Math.abs(repriced - row.ev) > 1e-9 * Math.max(1, Math.abs(row.ev))) {
      throw new CoachError(
        `internal: the ${row.action} row is worth ${row.ev} but reprices to ${repriced} at the same equity.`,
      );
    }
  }
}

/**
 * Only a size past the pot is set aside while still ahead of the reading when called. The reading is then
 * the cap's, so it says that in place of a margin below zero. Null everywhere else.
 */
function cappedAheadOf(
  best: ActionCandidate,
  rival: Rival | undefined,
  margin: number,
  setAside: ReadonlyMap<ActionCandidate, SetAside>,
): string | null {
  if (margin >= 0 || rival === undefined || setAside.get(rival.row) !== 'above-pot') return null;
  return (
    `${capitalised(best.action)} is the reading only because ${lineName(rival.row)} is more than the pot. ` +
    `${capitalised(nameOfRival(rival))} comes out ahead by ${(-margin).toFixed(1)} units — treat this as ` +
    'close rather than as a recommendation.'
  );
}

/** Empty at a big blind or more, and where the reading already says the other line is ahead. */
function closeGapNotes(margin: number, bigBlind: number, rivalName: string, cappedAhead: string | null) {
  if (margin >= bigBlind || cappedAhead !== null) return [];
  return [
    `The gap to ${rivalName} is ${onlyUnits(margin)}, well under a big blind — this is close to indifferent.`,
  ];
}

/** `intervalPoints` is 0 when no other line overtakes the reading inside the interval. */
function confidenceFor(marginInBigBlinds: number, intervalPoints: number): CoachSuggestion['confidence'] {
  if (marginInBigBlinds < 0.25 || intervalPoints > 2) return 'low';
  if (marginInBigBlinds < 1 || intervalPoints > 0.75) return 'moderate';
  return 'reasonable';
}

interface Overtaker extends Rival {
  readonly end: 'low' | 'high';
  readonly ahead: number;
}

/**
 * The other line furthest ahead of the reading at either end of the sampled interval, with every
 * share moved by the half-width and held inside 0..1. Every EV is linear in the shares, and lines
 * move at different rates, so any of them can overtake, not only the runner-up.
 */
function overtakerOf(
  ranked: readonly ActionCandidate[],
  eligible: readonly ActionCandidate[],
  best: ActionCandidate,
  input: CoachInput,
  split: PotSplit,
  halfWidthPoints: number,
): Overtaker | undefined {
  let found: Overtaker | undefined;
  for (const end of ['low', 'high'] as const) {
    const by = (end === 'low' ? -halfWidthPoints : halfWidthPoints) / 100;
    const shifted: PotSplit = {
      ...split,
      share: (group) => (group.length === 0 ? 1 : Math.min(1, Math.max(0, split.share(group) + by))),
    };
    const reading = valueUnder(best, false, input, shifted);
    for (const row of ranked) {
      if (row.action === best.action) continue;
      const alwaysCalled = !eligible.includes(row);
      const value = valueUnder(row, alwaysCalled, input, shifted);
      if (value > reading && (found === undefined || value - reading > found.ahead)) {
        const byCallers = alwaysCalled && branchesOf(row, input, shifted).byCallers;
        found = { row, alwaysCalled, byCallers, value, end, ahead: value - reading };
      }
    }
  }
  return found;
}

/** A row as the reading names it: "calling", "raising to 88". */
function lineName(row: ActionCandidate): string {
  if (row.action === 'bet') return `betting ${chips(row.to ?? row.cost)}`;
  if (row.action === 'raise') return `raising to ${chips(row.to ?? row.cost)}`;
  return { fold: 'folding', check: 'checking', call: 'calling' }[row.action];
}

function capitalised(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The unbroken run of the reading's sizes, by size, that are eligible and within a big blind of it. The
 * calling set narrows in steps, so a middle size can be set aside while a larger one is not, and a run
 * that skipped it would publish a range that includes it. Sizes with one cost put the same chips at
 * risk, the rest coming back uncalled, so only the smallest of them counts.
 */
function defensibleSizes(
  ranked: readonly ActionCandidate[],
  eligible: readonly ActionCandidate[],
  best: ActionCandidate,
  margin: number,
): number[] {
  const sized = ranked
    .filter((row) => row.action === best.action && row.to !== undefined && row.to > 0)
    .sort((left, right) => (left.to ?? 0) - (right.to ?? 0))
    .filter((row, index, rows) => rows.findIndex((other) => other.cost === row.cost) === index);
  const fits = (row: ActionCandidate | undefined) =>
    row !== undefined && eligible.includes(row) && row.ev >= best.ev - margin;
  const start = sized.findIndex((row) => row.cost === best.cost);
  if (start === -1 || !fits(sized[start])) return [];
  let low = start;
  let high = start;
  while (fits(sized[low - 1])) low -= 1;
  while (fits(sized[high + 1])) high += 1;
  return sized.slice(low, high + 1).map((row) => row.to ?? 0);
}

/**
 * The fold rate a bet or raise reading assumes, and which way a different rate moves it. Priced against
 * the hands that continue, the rate is who calls, so the figure with every hand calling is given instead.
 */
function foldRateCaveat(best: ActionCandidate, input: CoachInput, split: PotSplit): string {
  const folds = best.foldEquityAssumed ?? 0;
  const { whenCalled, whenFolded, byAll } = branchesOf(best, input, split);
  if (best.continuingShare !== undefined && best.continuingShare < 1) {
    const size = `${best.action === 'bet' ? 'a bet of' : 'a raise to'} ${chips(best.to ?? best.cost)}`;
    const [all, priced] = [byAll.toFixed(1), best.ev.toFixed(1)];
    return (
      `This assumes ${size} is called by the strongest ${shareOf(best.continuingShare)} of the stated ` +
      'range as the board stands and the rest fold. If the whole range called, it would be worth ' +
      `${all === priced ? 'the same' : `${all} units instead of ${priced}`}.`
    );
  }
  // EV is linear in the fold rate, so the sign of folded minus called is the whole direction.
  if (folds === 0) {
    // Nobody can fold less often than never, so the direction is said from the other side.
    const assumed = 'This assumes the line is called every time.';
    if (whenFolded > whenCalled) return `${assumed} An opponent who sometimes folds makes it better.`;
    if (whenFolded < whenCalled) {
      return `${assumed} Here a fold is worth less to you than a call, so an opponent who sometimes folds makes it worse.`;
    }
    return `${assumed} Here a fold and a call are worth the same to you, so how often they fold makes no difference.`;
  }
  const rate = `${percent(folds)} of the time`;
  const assumed =
    split.allIn.length === 0
      ? `This assumes the line wins uncontested ${rate}.`
      : `This assumes everyone who can still fold does so ${rate}.`;
  if (whenFolded > whenCalled) return `${assumed} An opponent who folds less often makes it worse.`;
  if (whenFolded < whenCalled) {
    return `${assumed} Here a fold is worth less to you than a call, so an opponent who folds more often makes it worse.`;
  }
  return `${assumed} Here a fold and a call are worth the same to you, so how often they fold makes no difference.`;
}

/** What a call or fold reading leaves out about the seats still to act. */
function seatsBehindNotes(
  action: CoachAction,
  toCall: number,
  behind: CallIfTheyCall | null,
  heroEquity: number,
): string[] {
  if (behind === null) return [];
  if (action === 'call') {
    return [
      `A raise from anyone still to act is not modelled. A call that is raised and then folded loses the ${chips(toCall)} it put in.`,
    ];
  }
  if (action !== 'fold' || behind.ev <= 0) return [];
  return [
    `If ${yetToMatch(behind)} call too, a call needs only ${percent(behind.breakEvenEquity)}, which your ` +
      `${percent(heroEquity)} clears. A raise behind you would cut the other way.`,
  ];
}

/**
 * Picks the highest-EV candidate that is ahead without the assumed fold rate, then weakens the claim
 * when the margin is small against a big blind or a wide equity interval could close it. It may never
 * conclude fold while checking is free, and asserts so.
 */
function buildSuggestion(
  candidates: readonly ActionCandidate[],
  input: CoachInput,
  equitySummary: EquitySummary,
  outs: OutsResult | null,
  split: PotSplit,
  behind: CallIfTheyCall | null,
): CoachSuggestion {
  const ranked = [...candidates].sort(byExpectedValue);
  const top = ranked[0];
  if (top === undefined) throw new CoachError('no candidate actions were produced');
  // The rows the Lab's verdict measures a fold against, plus any bet or raise that beats them even
  // when always called. The fold rate is an input, so a line ahead only because of it is not a reading.
  // A size the whole range calls carries no fold rate and is still a bet, so it is not the bar: a bet
  // priced against part of the range has to beat the best check or call when called, as before.
  const measured = candidates.filter((c) => !restsOnAssumedFoldEquity(c) && c.continuingShare === undefined);
  const measuredBest = Math.max(0, ...measured.map((c) => c.ev));
  const barRow = measured.find((c) => c.ev === measuredBest);
  const setAsideBy = new Map<ActionCandidate, SetAside>();
  for (const c of ranked) {
    const why = setAsideFor(c, input, split, measuredBest);
    if (why !== null) setAsideBy.set(c, why);
  }
  const eligible = ranked.filter((c) => !setAsideBy.has(c));
  const best = eligible[0] ?? top;
  const rival = rivalOf(ranked, eligible, best, input, split);
  const runnerUp = rival?.value ?? Number.NEGATIVE_INFINITY;
  const rivalName = nameOfRival(rival);

  if (input.toCall === 0) {
    const foldRank = ranked.findIndex((candidate) => candidate.action === 'fold');
    const checkRank = ranked.findIndex((candidate) => candidate.action === 'check');
    if (foldRank !== -1 && checkRank !== -1 && foldRank < checkRank) {
      throw new CoachError(
        'internal: fold was ranked above check with nothing to call. Checking is free and keeps the ' +
          'hand, so it can never be worse than folding; a ranking that says otherwise is a defect in ' +
          'the EV of one of them, not a close decision.',
      );
    }
  }

  const margin = best.ev - runnerUp;
  const marginInBigBlinds = margin / input.bigBlind;
  const cappedAhead = cappedAheadOf(best, rival, margin, setAsideBy);
  const intervalPoints = equitySummary.confidenceHalfWidthPoints ?? 0;

  assertRepriced(candidates, input, split);
  const overtaker = overtakerOf(ranked, eligible, best, input, split, intervalPoints);
  const smallMargin = marginInBigBlinds < 0.25;
  let confidence = confidenceFor(marginInBigBlinds, overtaker === undefined ? 0 : intervalPoints);
  // The call row is the least a call is worth if nobody raises, so a fold it loses only there is open.
  const openBehind = best.action === 'fold' && behind !== null && behind.ev > 0 ? behind : null;
  if (openBehind !== null) confidence = 'low';

  const sameActionSizes = defensibleSizes(ranked, eligible, best, input.bigBlind);

  const whatWouldChangeIt: string[] = [];
  if (best.action === 'call' || best.action === 'fold') {
    whatWouldChangeIt.push('A wider opponent range would raise your equity and can flip a fold into a call.');
    whatWouldChangeIt.push('A narrower, stronger range does the opposite.');
  }
  if (best.action === 'check') {
    whatWouldChangeIt.push(
      'Nothing about the opponent range can make folding better than this: checking costs nothing and keeps the hand, so it is never behind a fold. What the range changes is whether betting would beat checking.',
    );
  }
  if (best.action === 'bet' || best.action === 'raise') {
    whatWouldChangeIt.push(foldRateCaveat(best, input, split));
    whatWouldChangeIt.push('Being raised is not modelled here, so treat the figure as optimistic.');
  }
  if (outs !== null && outs.dirtyCount > 0) {
    // "N of your M outs" is false when `refusal` is set, because there are no outs (see `outs.ts`).
    whatWouldChangeIt.push(
      outs.refusal === null
        ? `${outs.dirtyCount} of your ${outs.totalOuts} outs are dirty — they improve you without making you safe, so counting all of them would overstate your chances.`
        : `${outs.dirtyCount} of the ${outs.cleanCount + outs.dirtyCount} cards that keep you in front leave a way to lose — they are not outs, because you are not drawing, but they are the cards a river can still take the pot back with.`,
    );
  }
  if (equitySummary.method === 'monte-carlo') {
    whatWouldChangeIt.push(
      `The equity figure is sampled, ±${intervalPoints.toFixed(2)} points at 95% confidence. A close decision could sit either side of that.`,
    );
  }
  whatWouldChangeIt.push(...seatsBehindNotes(best.action, input.toCall, behind, equitySummary.heroEquity));
  whatWouldChangeIt.push(...closeGapNotes(margin, input.bigBlind, rivalName, cappedAhead));
  if (whatWouldChangeIt.length === 0) {
    whatWouldChangeIt.push('A different assumption about the opponent range would change the numbers.');
  }

  // Capitalised to open the sentence, and in units to match every figure beside it on the panel.
  const actionWord = `${best.action.charAt(0).toUpperCase()}${best.action.slice(1)}`;
  const setAside = best.action === top.action ? '' : foldRateNote(top, best, input, split);
  const against =
    setAside === '' ? 'against the stated range' : 'of the lines that do not rely on an assumed fold rate';
  const byMargin =
    openBehind !== null
      ? `${actionWord} has the highest expected value ${against}, by ${margin.toFixed(1)} units over ${rivalName}, but the price leaves out what ${yetToMatch(openBehind)} would put in — treat this as close rather than as a recommendation.`
      : confidence === 'low' && smallMargin
        ? `${actionWord} comes out ahead of ${rivalName} by ${onlyUnits(margin)}, under a quarter of a big blind — treat this as close to indifferent rather than as a recommendation.`
        : confidence === 'low' && overtaker !== undefined
          ? `${actionWord} has the highest expected value ${against}, by ${margin.toFixed(1)} units over ${rivalName}, but the equity is sampled to ±${intervalPoints.toFixed(2)} points, and at the ${overtaker.end} end ${nameOfRival(overtaker)} comes out ahead by ${overtaker.ahead.toFixed(1)} units — treat this as close rather than as a recommendation.`
          : `${actionWord} has the highest expected value ${against}, by ${margin.toFixed(1)} units over ${rivalName}.`;
  const bar = { name: barRow === undefined ? 'folding' : lineName(barRow), ev: measuredBest };
  const reason =
    (cappedAhead ?? byMargin) +
    aheadOfCallersNote(best, bar, input, split) +
    (setAside === '' ? readsCloserNote(ranked, best, rival) : setAside) +
    abovePotNote(ranked, best, setAsideBy, input);

  return {
    action: best.action,
    ...(sameActionSizes.length > 0
      ? { sizeRange: { min: Math.min(...sameActionSizes), max: Math.max(...sameActionSizes) } }
      : {}),
    confidence,
    reason,
    whatWouldChangeIt,
  };
}

function buildUncertainty(
  result: EquityResult,
  input: CoachInput,
  outs: OutsResult | null,
  behind: CallIfTheyCall | null,
): UncertaintyNote {
  const limitations: string[] = [
    'This is raw equity: the hand is treated as running to the river with no further betting. Real hands have more streets and more decisions.',
    'Every hand in the opponent range is weighted equally. Real opponents do not play every hand in a range the same way.',
  ];
  if (result.method === 'monte-carlo') {
    limitations.push(
      `Equity was estimated from ${result.trials.toLocaleString('en-US')} sampled run-outs, not enumerated exhaustively.`,
    );
  }
  if (input.opponents.length > 1) {
    limitations.push(
      behind === null
        ? 'Against several opponents the analysis assumes all of them see the river, which overstates your risk when some would fold.'
        : `Against several opponents the equity assumes all of them see the river, but the price leaves out what ${yetToMatch(behind)} would put in. Together that is the least a call is worth if nobody raises; a raise behind you, which is not modelled, can cost the whole call.`,
    );
  }
  if (outs !== null) {
    limitations.push(
      outs.refusal === null
        ? 'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.'
        : 'The clean/dirty split uses documented equity thresholds, and here it is not a count of outs at all — you are already in front of the same bar a card would have to clear. The thresholds are a modelling choice, not a law of the game.',
    );
  }
  limitations.push('No implied odds, reverse implied odds or future-street play are modelled.');

  const summary =
    result.method === 'exact-enumeration'
      ? `Computed exactly over ${enumeratedOver(input)} (${result.trials.toLocaleString('en-US')} ${result.trials === 1 ? 'showdown' : 'showdowns'}). There is no sampling error.`
      : `Estimated by sampling ${result.trials.toLocaleString('en-US')} run-outs. The 95% confidence interval is ±${(result.confidence?.halfWidthPoints ?? 0).toFixed(2)} percentage points.`;

  return {
    method: result.method,
    summary,
    confidenceInterval:
      result.confidence === null
        ? null
        : { level: result.confidence.level, halfWidthPoints: result.confidence.halfWidthPoints },
    limitations,
  };
}

/** What an exact count runs over: every opponent hand, times every board still to come before the river. */
function enumeratedOver(input: CoachInput): string {
  const hands =
    input.opponents.length === 1
      ? 'every hand the opponent range allows'
      : 'every combination of hands the opponent ranges allow';
  return input.street === 'river' ? hands : `${hands} and every board still to come`;
}

/** "9 cards" / "1 card". Counts read as cards here, not as a bare number. */
function pluralCards(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

/** Why the rule of 2 and 4 is missing, naming which part of "a draw with clean outs to come" failed. */
function refusalNote(refusal: RuleOfThumbRefusal | null): string | null {
  if (refusal === null) return null;
  switch (refusal.kind) {
    case 'no-cards-to-come':
      return null; // No draw and no outs section, so nothing to explain.
    case 'already-ahead':
      return (
        `No rule-of-2-and-4 figure here, deliberately: at ${(refusal.equityNow * 100).toFixed(1)}% you are ` +
        'already ahead, so you are not drawing to anything. The shortcut counts the cards that rescue a ' +
        'hand that is behind; applied to a hand that is already winning it counts cards that change ' +
        'nothing and returns a number that is not a probability of anything.'
      );
    case 'no-clean-outs':
      if (refusal.dirty === 0) {
        return 'No rule-of-2-and-4 figure here: no card that can come puts you in front, so there are no outs to count.';
      }
      return (
        `No rule-of-2-and-4 figure here: none of your ${pluralCards(refusal.dirty)} of outs ${refusal.dirty === 1 ? 'is' : 'are'} clean. ` +
        'The shortcut is only ever applied to clean outs, because a card that improves you and improves ' +
        'them at the same time is not a card you can count on winning with — multiplying it by 4 prices ' +
        'a win you may not get.'
      );
    case 'not-a-probability':
      return (
        `No rule-of-2-and-4 figure here: ${pluralCards(refusal.cleanOuts)} of clean outs is past the ` +
        `${refusal.ceiling} the shortcut can handle. Multiplying takes it above 100%, and a probability ` +
        'above 100% is not a rounding error, it is the shortcut being used where it has no meaning.'
      );
    default:
      return null;
  }
}

function buildTeachingNotes(
  input: CoachInput,
  potOddsSummary: PotOddsSummary,
  equitySummary: EquitySummary,
  outs: OutsResult | null,
  stacks: StackContext,
  cardsToCome: 1 | 2 | null,
  heroCallIsAllIn: boolean,
): string[] {
  const notes: string[] = [];

  // `oddsRatio !== null` keeps a future caller from rendering "Infinity to 1" at a learner.
  if (input.toCall > 0 && potOddsSummary.oddsRatio !== null) {
    // Ratio and pot come from one summary, so an all-in-for-less hero is priced on the pot they can win.
    const beyondReach = input.pot - input.contestablePot;
    // Only where the pots differ, so ordinary spots carry no qualification.
    const againstWhat = beyondReach > 0 ? ` on the ${chips(potOddsSummary.pot)} you can win` : '';
    notes.push(
      `The pot is laying you ${potOddsSummary.oddsRatio.toFixed(1)} to 1${againstWhat}, so you need ${(potOddsSummary.breakEvenEquity * 100).toFixed(1)}% to break even on a call. That number depends only on the price — not on your cards.`,
    );
    if (beyondReach > 0) {
      const goesTo =
        outOfReachOf(input) === 'uncalled'
          ? 'the part of the bet you cannot match. It goes back to the bettor uncalled'
          : 'a side pot you are not in — it goes to whoever wins it among the players who covered that bet';
      notes.push(
        `Do not price this against the ${chips(input.pot)} you can see. You are all-in for less than ` +
          `the bet, so ${chips(beyondReach)} of the middle is ${goesTo}, whatever you are holding. ` +
          'Being short changes the price you are getting, not just the chips you can lose.',
      );
    }
  }
  // Two wordings, because with `refusal` set there is no outs count to split. See `outs.ts`.
  if (outs !== null && outs.dirtyCount > 0) {
    notes.push(
      outs.refusal === null
        ? `Notice the split: ${outs.cleanCount} clean and ${outs.dirtyCount} dirty, out of ${outs.totalOuts} outs in total. ` +
            'A card that improves you is not the same as a card that wins you the hand — an opponent who is behind after it lands can still draw out on the last card.'
        : `Notice the split: ${outs.cleanCount} clean and ${outs.dirtyCount} dirty — and notice that neither figure is a number of outs. ` +
            `You are in front already at ${(outs.equityNow * 100).toFixed(1)}%, so no card here rescues anything: these are the cards that keep you in front, and the ${outs.dirtyCount} dirty ones leave the river a way to take it back.`,
    );
    if (outs.cleanCount === 0) {
      notes.push(
        outs.refusal === null
          ? 'None of these outs is clean, which is worth sitting with: you can hit and still lose. That is what a redraw costs you, and it is invisible if you only count outs.'
          : 'Not one of those cards is clean, which is worth sitting with: every card that can come leaves somebody live to beat you. Being in front is not the same as being safe, and the difference is invisible if you only count cards.',
      );
    }
  }
  const ruleOfThumb = equitySummary.ruleOfThumb;
  if (ruleOfThumb !== null && outs !== null) {
    const sign = ruleOfThumb.errorPoints >= 0 ? 'over' : 'under';
    notes.push(
      // `estimate` is a fraction, multiplied here exactly once.
      `The rule of 2 and 4 gives ${(ruleOfThumb.estimate * 100).toFixed(0)}% on your ` +
        `${pluralCards(outs.cleanCount)} of clean outs, ${sign}stating the exact chance of hitting one ` +
        `of them by ${Math.abs(ruleOfThumb.errorPoints).toFixed(1)} points. Your equity here is ` +
        `${(equitySummary.heroEquity * 100).toFixed(1)}%, which is a different question again: hitting ` +
        'is not the same as winning.',
    );
  } else {
    const refusal = ruleOfThumbRefusalFor(outs, cardsToCome);
    const withheld = refusalNote(refusal);
    if (withheld !== null) notes.push(withheld);
  }
  // Both notes describe betting still to come, which an all-in call leaves none of.
  const bettingToCome = stacks.effectiveStack > 0 && !heroCallIsAllIn;
  if (bettingToCome && stacks.spr < 3) {
    notes.push(
      `At an SPR of ${stacks.spr.toFixed(1)} the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.`,
    );
  } else if (bettingToCome && stacks.spr > 10) {
    notes.push(
      `At an SPR of ${stacks.spr.toFixed(1)} there is a lot of money left behind, so hands that can keep improving are worth more than their current strength suggests.`,
    );
  }
  // Keyed to hero's equity under 50%, the only case where a profitable call loses more often than it
  // wins. Keyed to `equitySurplus > 0` alone, it was false on 15 of the 23 Lab scenarios it fired on.
  if (potOddsSummary.equitySurplus > 0 && potOddsSummary.toCall > 0 && equitySummary.heroEquity < 0.5) {
    notes.push(
      'A profitable call can still lose more often than it wins: you are under 50% here and the price is lower than that. Losing this hand would not make the call wrong.',
    );
  }
  return notes;
}

/** Assembles the full report. This is the only function the API and the UI need. */
export function buildCoachReport(input: CoachInput): CoachReport {
  validate(input);

  // `exactRange`, not a range literal. The literal that sat here left `classes` empty, hard-coded 1326
  // and kept the caller's card order. `validate` has already checked the two cards.
  const heroRange: ParsedRange = exactRange(input.heroCards);

  const spec: EquitySpec = {
    players: [
      { label: 'you', range: heroRange },
      ...input.opponents.map((opponent) => ({ label: opponent.label, range: opponent.range })),
    ],
    board: input.board,
    contests: contestsFor(input),
  };

  const equityResult = equity(spec, {
    ...(input.samples === undefined ? {} : { samples: input.samples }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
  });
  const hero = equityResult.players[0];
  if (hero === undefined) throw new CoachError('equity result has no hero');

  // Outs only make sense with cards still to come and a single opponent to be ahead of.
  const cardsToCome: 1 | 2 | null = input.street === 'flop' ? 2 : input.street === 'turn' ? 1 : null;
  let outs: OutsResult | null = null;
  const firstOpponent = input.opponents[0];
  if (cardsToCome !== null && input.opponents.length === 1 && firstOpponent !== undefined) {
    outs = computeOuts({
      heroCards: input.heroCards,
      board: input.board,
      opponent: firstOpponent.range,
    });
  }

  const equitySummary = buildEquitySummary(equityResult, outs, cardsToCome);
  const split = potSplitOf(input, equityResult, hero.equity);
  const behind = callIfTheyCall(input, hero.equity, split);
  const cappedCall = Math.min(input.toCall, input.heroStack);
  const outOfReach = outOfReachOf(input);
  const potOddsSummary = buildPotOddsSummary(
    input.pot,
    input.contestablePot,
    input.toCall,
    hero.equity,
    input.toCall > 0 && layeredShowdown('call', split, input, cappedCall) !== null,
    behind,
    outOfReach,
  );
  const foldEquity = input.assumedFoldEquity ?? DEFAULT_ASSUMED_FOLD_EQUITY;
  const candidates = buildCandidates(input, hero.equity, foldEquity, split);
  const heroCallIsAllIn = callIsAllIn(candidates);
  const stackContext = buildStackContext(input, heroCallIsAllIn);
  const suggestion = buildSuggestion(candidates, input, equitySummary, outs, split, behind);
  const uncertainty = buildUncertainty(equityResult, input, outs, behind);

  const assumptions = [...equityResult.assumptions];
  if (candidates.some((candidate) => candidate.action === 'bet' || candidate.action === 'raise')) {
    const rate = `${(foldEquity * 100).toFixed(0)}% of the time`;
    assumptions.push(
      candidates.some((candidate) => candidate.continuingShare !== undefined)
        ? continuingAssumption(candidates)
        : (split.allIn.length > 0
            ? `Bet and raise figures assume everyone who can still fold does so ${rate}. ${allInClause(split)}, so even then the pot they are in goes to showdown.`
            : `Bet and raise figures assume the line wins uncontested ${rate}.`) +
            ' That is an assumption, not something measured: the Scenario Lab lets you change it and watch these figures move.',
    );
    assumptions.push(halfPotBreakEven(input, candidates, split));
  }
  assumptions.push(
    'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
  );

  if (assumptions.length === 0) {
    // Unreachable, but an empty list would present every figure as unconditional fact.
    throw new CoachError('a Coach report must never be produced without assumptions');
  }

  return {
    street: input.street,
    potTotal: input.pot,
    ...(outOfReach === undefined ? {} : { outOfReach }),
    toCall: input.toCall,
    outs: buildOutsBreakdown(outs),
    equity: equitySummary,
    potOdds: potOddsSummary,
    candidates,
    suggestion,
    stackContext,
    assumptions,
    uncertainty,
    teachingNotes: buildTeachingNotes(
      input,
      potOddsSummary,
      equitySummary,
      outs,
      stackContext,
      cardsToCome,
      heroCallIsAllIn,
    ),
  };
}

/** What the rows priced against the hands that continue assume, said so that it holds when none of them folds. */
function continuingAssumption(candidates: readonly ActionCandidate[]): string {
  return candidates.some((candidate) => restsOnAssumedFoldEquity(candidate))
    ? 'Bet and raise figures assume a call comes from the strongest hands in the stated range as the board stands and that the rest fold, more of them the larger the size. Those are assumptions, not something measured.'
    : 'Bet and raise figures assume the whole stated range calls every size here, so none of them rests on a fold. That is an assumption, not something measured.';
}

/**
 * The break-even fold rate of the size the ½-pot button sends, read off its priced row so it inherits
 * the call inside a raise and the cap at what can be called.
 */
function halfPotBreakEven(
  input: CoachInput,
  candidates: readonly ActionCandidate[],
  split: PotSplit,
): string {
  const half = TABLE_SIZING_PRESETS.find((preset) => preset.id === 'half');
  const to = half === undefined ? undefined : presetTo(half, sizingContextFor(input));
  const row = candidates.find(
    (candidate) => candidate.to === to && candidate.foldEquityAssumed !== undefined,
  );
  if (row === undefined) throw new CoachError(`internal: the ½-pot size ${to} has no priced row`);
  const { whenCalled, whenFolded } = branchesOf(row, input, split);
  const breakEven = breakEvenFoldRate(whenFolded, whenCalled);
  const line = `The ½-pot ${row.action === 'bet' ? `bet of ${to}` : `raise to ${to}`} risks ${chips(row.cost)}`;
  const layered = split.allIn.length > 0;
  const size = layered
    ? `${line}. ${allInClause(split)}, so everyone else folding is worth ${chips(whenFolded)} to you, not the ${chips(input.contestablePot)} in the middle.`
    : `${line} to win ${chips(input.contestablePot)}.`;
  // "Needs 0%" and "needs 100%" both read as mistakes, so each degenerate case says what it means.
  switch (breakEven.kind) {
    case 'always':
      return `${size} It is already break-even or better purely on the equity you have when called — it does not need ${layered ? 'anyone to fold' : 'to win uncontested'} at all.`;
    case 'never':
      return `${size} It cannot break even at any fold frequency with this much equity when called — folding out the whole range still would not be enough.`;
    case 'at-most':
      return `${size} It breaks even when called, but a fold is worth less to you than a call, so it stops breaking even once everyone who can fold does fold more than ${percentOfTime(breakEven.rate)}.`;
    case 'at-least': {
      if (layered) {
        return `${size} To break even everyone who can fold would need to fold ${percentOfTime(breakEven.rate)}.`;
      }
      // The lesson's bet / (pot + bet) is this line at zero equity, so a learner can reconcile the two.
      const lesson = `${chips(row.cost)} / (${chips(input.contestablePot)} + ${chips(row.cost)})`;
      const share = row.potShareIfCalled ?? split.share(split.live);
      const needs = `${size} To break even it would need to win uncontested ${percentOfTime(breakEven.rate)}`;
      if (share === 0) return `${needs}: with no equity when called, that is ${lesson}.`;
      const bluff = row.cost / (input.contestablePot + row.cost);
      return (
        `${needs}, counting the ${percent(share)} equity you have when called. With no equity when called ` +
        `it would need ${lesson} = ${(bluff * 100).toFixed(0)}%.`
      );
    }
  }
}

function percentOfTime(rate: number): string {
  return `${(rate * 100).toFixed(0)}% of the time`;
}

/** A small gap in units, said as under 0.05 where one decimal would print it as nothing at all. */
function onlyUnits(margin: number): string {
  return Math.abs(margin) < 0.05 ? 'under 0.05 units' : `only ${margin.toFixed(1)} units`;
}

/** Whole percents, except where that would round part of the range to all of it or none. */
function shareOf(share: number): string {
  const whole = (share * 100).toFixed(0);
  return (whole === '100' || whole === '0') && share > 0 && share < 1 ? percent(share) : `${whole}%`;
}

/** A compact summary for logs and hand-review lists. Never shown as the whole story. */
export function summariseCoachReport(report: CoachReport): string {
  const equityText = `${(report.equity.heroEquity * 100).toFixed(1)}%`;
  const interval =
    report.equity.confidenceHalfWidthPoints === null
      ? ' (exact)'
      : ` (±${report.equity.confidenceHalfWidthPoints.toFixed(2)}pts)`;
  const needs = report.toCall > 0 ? `, needs ${(report.potOdds.breakEvenEquity * 100).toFixed(1)}%` : '';
  return `${equityText}${interval}${needs} → suggests ${report.suggestion.action} (${report.suggestion.confidence} confidence)`;
}
