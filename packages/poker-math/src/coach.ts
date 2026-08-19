/**
 * The Coach: everything shown at a decision point, assembled from the pure maths.
 *
 * This is the product. Every other module here computes one figure; this one puts them
 * side by side so a learner can see *why* a decision is what it is rather than being
 * told what to do.
 *
 * ## Three rules the type system enforces, so a reviewer does not have to
 *
 * 1. **`assumptions` is never empty.** A number without its assumptions is a guess
 *    dressed as a fact. `buildCoachReport` throws rather than return an empty list.
 * 2. **`uncertainty` always states the method**, and for a sampled figure always
 *    carries the interval. An exact enumeration reports `confidenceInterval: null` —
 *    not a fabricated zero, because "no sampling error" and "zero error" are different
 *    claims.
 * 3. **There is no way to say "correct".** `CoachSuggestion` has fields for an action,
 *    a size *range*, a confidence that may be `'low'`, a reason, and a non-empty
 *    `whatWouldChangeIt`. It has no field capable of expressing certainty, so the UI
 *    cannot render one even by accident.
 * 4. **Every size it can emit is one the table would accept.** `CoachInput` carries
 *    hero's own street commitment, and optionally the engine's own minimum, because
 *    without them a legal `to` is not computable and the Coach was reduced to guessing
 *    one. A panel that recommends an action the server rejects has taught a learner
 *    something false about the rules on top of whatever it said about the maths.
 * 5. **Every ACTION it can emit is one the engine offers.** The size being legal is not
 *    the same claim as the action being available. `CoachInput.legalActions` carries the
 *    engine's own list and nothing outside it is published. A caller that has no
 *    `HandState` to ask gets `deriveLegalActions` instead — the betting rules a described
 *    spot *does* determine, chief among them that `bet`/`raise` is withheld when no
 *    opponent has chips behind. What the absent case never means again is "everything is
 *    permitted": that reading is what let four of the five surfaces publish raises the
 *    table refuses, and the filter now has no branch that can express it.
 * 5a. **No candidate costs more than hero can put in.** `assertAffordable` checks every
 *    published row against `heroStack` — chips BEHIND — and every total against
 *    `heroCommittedThisStreet + heroStack`. Both are invariants of the arithmetic above
 *    rather than clamps applied after the fact, which is why a violation is a loud
 *    `CoachError` and not a silently corrected figure.
 * 6. **A free check is never ranked below a fold.** `evOfCheck` prices a check at
 *    `equity x pot` rather than at a hard-coded zero, ties are broken against giving up
 *    the hand, and `buildSuggestion` asserts the ordering rather than trusting it.
 *
 * ## Units on this contract
 *
 * Every probability that leaves this file is a FRACTION in 0..1 — `heroEquity`,
 * `breakEvenEquity`, `potShareIfCalled`, `foldEquityAssumed` and `ruleOfThumb.estimate`
 * — and the UI multiplies by 100 to render it. Percentage POINTS appear only in fields
 * whose names say so (`errorPoints`, `confidenceHalfWidthPoints`). `ruleOfThumb.estimate`
 * was the one exception, publishing 36 where every neighbour published 0.36, and the
 * panel rendered it as "3,600.0%".
 *
 * ## What the Coach deliberately does not do
 *
 * It does not solve the spot. It evaluates the actions available against one stated
 * range assumption, with no future-street modelling beyond an explicit fold-equity
 * parameter, and it says so in the limitations. A learner who takes these numbers as
 * "the answer" has been taught the wrong lesson, so the output is shaped to make that
 * reading hard.
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
import { type Card, DECK_SIZE } from '@prl/poker-engine';
import { type EquityResult, type EquitySpec, equity } from './equity.ts';
import { evOfBet, evOfCall, evOfCheck, evOfFold, evOfRaise, requiredFoldEquity } from './ev.ts';
import { chips, percent } from './format.ts';
import {
  maximumOutsForRuleOf24,
  potOdds,
  priceLaidByBet,
  probabilityOfHitting,
  ruleOf24Accuracy,
} from './odds.ts';
import { computeOuts, DEFAULT_AHEAD_THRESHOLD, type OutsResult } from './outs.ts';
import { exactRange, type ParsedRange } from './ranges.ts';
import { effectiveStack, type SizingOption, sizingLadder, stackToPotRatio } from './stacks.ts';

export class CoachError extends Error {
  override readonly name = 'CoachError';
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/** The five things a seat can do. Identical to `ActionCandidate['action']` by design. */
export type CoachAction = ActionCandidate['action'];

/**
 * The part of a spot that determines which action *kinds* the betting rules allow.
 *
 * A subset of `CoachInput` by design, so `deriveLegalActions(input)` type-checks and a
 * caller that has these four numbers and nothing else can ask the same question.
 */
export interface DescribedSpot {
  /** What hero must add to continue. 0 when hero can check. */
  readonly toCall: number;
  /** Chips hero has ALREADY put out on this street. */
  readonly heroCommittedThisStreet: number;
  /** Chips hero has BEHIND — remaining, not counting anything already committed. */
  readonly heroStack: number;
  /** Chips BEHIND for each opponent still in the hand, one entry per opponent. */
  readonly opponentStacks: readonly number[];
}

/**
 * A described spot, plus the two things that fix a legal *size* rather than a legal action.
 *
 * Separate from `DescribedSpot` because the two questions have different inputs and different
 * answers: which action kinds the rules allow needs neither the stakes nor the engine's `minTo`,
 * and `deriveLegalActions` should not start asking for figures it does not read. `CoachInput`
 * satisfies this structurally, so the Coach's own floor and a caller holding only these six
 * numbers are answered by the same function.
 */
export interface SizedSpot extends DescribedSpot {
  readonly bigBlind: number;
  /** The engine's own `minTo` when there is a `HandState` to read it from. See `CoachInput`. */
  readonly minimumRaiseTo?: number;
}

/**
 * The actions the betting rules allow in a spot that has been *described* rather than
 * dealt. **A derivation, and the engine is the authority wherever a `HandState` exists.**
 *
 * Read that sentence as a rule about callers, not as a disclaimer. `legalActions(state,
 * seat)` in `@prl/poker-engine` is this codebase's single definition of legality; anyone
 * holding a `HandState`, or a `PlayerView` carrying the engine's own list, passes that
 * and this function is not involved. It exists for the surfaces that genuinely have no
 * hand state — the ad-hoc calculator, the Scenario Lab, the hand review rebuilt from
 * stored rows, the profile comparison — because the alternative those callers used to
 * get was no filter at all.
 *
 * ## What is derived, and from which rule
 *
 * - **`fold`** is always offered. The engine offers it at every decision point, including
 *   the one where checking is free — where it attaches a note saying so rather than
 *   hiding it.
 * - **`check` exactly when `toCall === 0`, `call` exactly when `toCall > 0`.** The engine
 *   splits on `amountToCall`; this splits on the same quantity.
 * - **`bet`/`raise` only when some opponent still has chips behind.** This is the rule
 *   that was being violated. `legalActions` withholds aggression unless
 *   `state.seats.some(other => other.status === 'active' && other.stack > 0)`: a bet
 *   nobody can call is simply returned, so there is nothing to size and nothing to price.
 *   Pricing one anyway is worse than useless — the fold-equity term charges an opponent
 *   with no chips behind a 35% chance of folding, which is a probability of an event that
 *   cannot happen.
 * - **`bet` when the bet level is zero, `raise` otherwise**, which is the engine's own
 *   test (`state.betLevel === 0`) rather than a test on `toCall`: a big blind facing a
 *   limped pot owes nothing and still cannot *bet*, because their own blind is a live bet.
 * - **and only when hero can actually get past the level in force**: `maxTo > betLevel`,
 *   with `maxTo = heroCommittedThisStreet + heroStack`, the same comparison `legalActions`
 *   makes. A short stack that cannot reach the minimum may still shove, which is why the
 *   test is against the bet level and not against the minimum.
 *
 * ## What cannot be derived, and what that costs
 *
 * `mayRaise` — the rule that a short all-in below the minimum does not reopen the action
 * to a seat that has already acted at that level — depends on `lastFullRaiseBetLevel` and
 * `lastActedAtBetLevel`, neither of which survives into a description of a spot. So this
 * function can be too generous by exactly that one case, and a caller that can supply the
 * engine's list should. It is never too generous in the case this fix is about, and it is
 * never *stricter* than the engine either, so nothing legal is withheld from a learner.
 */
export function deriveLegalActions(spot: DescribedSpot): readonly CoachAction[] {
  const actions: CoachAction[] = ['fold'];
  actions.push(spot.toCall === 0 ? 'check' : 'call');

  const someOpponentCanAnswer = spot.opponentStacks.some((stack) => stack > 0);
  if (someOpponentCanAnswer && maximumTo(spot) > betLevelOf(spot)) {
    actions.push(betLevelOf(spot) === 0 ? 'bet' : 'raise');
  }
  return actions;
}

/**
 * The level in force on this street: what hero would have out there after calling.
 *
 * One expression, named once, because three separate places compare a size against it and
 * `heroCommittedThisStreet + toCall` written out by hand is indistinguishable from
 * `heroCommittedThisStreet + heroStack` at a glance.
 */
function betLevelOf(spot: DescribedSpot): number {
  return spot.heroCommittedThisStreet + spot.toCall;
}

/**
 * The largest street total hero can reach: everything already out plus everything behind.
 *
 * The engine's `maxTo`, and the ceiling every published size is clamped to. Exported because
 * the ceiling is not only a fact about what the Coach may *publish*: whoever accepts a size
 * from a learner has to hold it to the same figure, and a second hand-written
 * `heroCommittedThisStreet + heroStack` somewhere else is how the two drift apart.
 *
 * Note which stack this is. `heroStack` is chips BEHIND, so this is a total, not a doubling of
 * anything hero has already committed.
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
  /** Chips in the middle, excluding hero's pending call. */
  readonly pot: number;
  /** What hero must add to continue. 0 when hero can check. */
  readonly toCall: number;
  /**
   * Chips hero has ALREADY put out on this street — a posted blind, an earlier bet on
   * this street that has since been raised, a limp.
   *
   * Required, and required for a reason. The engine's `to` is a seat's *total* street
   * commitment, so a raise's total is `heroCommittedThisStreet + toCall + raiseBy`.
   * Without this field that total is not computable, and the Coach used to guess it as
   * `toCall + raiseBy` — which is right only when hero has nothing out there yet, and
   * silently publishes a size the table would reject the rest of the time. Making the
   * caller state it is the difference between a report that is correct by construction
   * and one that is correct when the caller happens to have pre-adjusted its inputs.
   *
   * It is 0 in the ordinary postflop case: hero has not acted on this street and faces
   * a bet.
   */
  readonly heroCommittedThisStreet: number;
  /**
   * Chips hero has BEHIND: what is left to put in, not counting
   * `heroCommittedThisStreet` and not counting anything carried in from earlier streets.
   *
   * Spelled out because two invariants read it and a reviewer has already misread it
   * once. Hero's whole street total is `heroCommittedThisStreet + heroStack` — the
   * `maxTo` every size is clamped to — and no candidate may cost more than `heroStack`
   * on its own. Read this as a starting stack instead and both of those become
   * double-counts.
   */
  readonly heroStack: number;
  /** Chips BEHIND for each opponent still in the hand, on the same reading. */
  readonly opponentStacks: readonly number[];
  readonly bigBlind: number;
  /**
   * The engine's own minimum legal total for a bet or raise here — `legalActions`'
   * `minTo`, equivalently `minimumRaiseTo(state)`.
   *
   * Optional because two callers legitimately have no hand state: the ad-hoc
   * calculator describes a spot rather than a table, and a profile comparison
   * reconstructs one. When it is absent the Coach derives a floor from the betting
   * rules that is never below the engine's — see `minimumAggressiveTo`. When it is
   * present the engine is the single authority and no derivation happens at all.
   */
  readonly minimumRaiseTo?: number;
  /**
   * The action *kinds* the engine says hero may take at this exact decision point —
   * `legalActions(state, seat).map(entry => entry.type)`.
   *
   * The Coach may publish nothing outside this set. Legality is not a property of the
   * pot and the price alone: the engine withholds `bet`/`raise` when no opponent has
   * chips behind (nobody could call it), and again when the last increase was a short
   * all-in and hero has already acted at that level (`mayRaise`), and it returns an empty
   * list altogether once betting is closed for the hand. The old `if (maxRaiseBy > 0)`
   * guard could see none of them, and published raises the table refuses — measured: a
   * spot where every live opponent was all-in, the engine offering `fold, call`, and the
   * Coach recommending "raise to 80-100" as its highest-EV line.
   *
   * Of those three, the first is recoverable from a described spot and the other two are
   * not, which is what `deriveLegalActions` does and does not claim. Pass this whenever
   * there is a `HandState` or a `PlayerView` to read it from; the derivation is the
   * fallback for callers that have neither, not an equal alternative.
   *
   * ## Absent means "there is no engine to ask", never "everything is permitted"
   *
   * This field used to be filtered with `input.legalActions === undefined ||
   * input.legalActions.includes(action)`, so an absent list disabled the guard
   * completely. `CoachTask` — the wire type behind the Scenario Lab, the hand review,
   * the profile comparison and `POST /math/coach` — had no field to put one in, so four
   * of the five surfaces analysed with the guard off. Measured on the shipped Scenario
   * Lab: two scenarios headlined an all-in raise, at `reasonable` confidence, priced
   * with 35% fold equity against an opponent holding no chips behind and therefore
   * unable to fold. A guard that is skipped whenever it is not handed its input is not a
   * guard, and it inverts ADR 0003, which exists to make this class of type fail closed.
   *
   * So absence is now answered by `deriveLegalActions`, which applies the betting rules a
   * described spot does determine — including the one that was being violated. There is
   * no code path left that treats an action as permitted merely because nobody said
   * otherwise.
   *
   * Every caller now supplies one: the live table from the engine's own
   * `legalActions(state, seat)`, and the four describing callers — the Scenario Lab, the
   * hand review, `POST /math/coach` and the profile comparison — from
   * `deriveLegalActions`. `CoachTask.legalActions` is required, so the wire cannot lose it.
   *
   * It stays optional *here* deliberately, and the distinction matters: absence is
   * answered by `deriveLegalActions`, which is conservative, not permissive. Making the
   * field required would move the failure to compile time for first-party callers while
   * removing the safety net for anyone constructing an input directly — and it would
   * delete the two tests that prove the absent case still withholds a raise nobody could
   * call. A guard that holds when its input is missing is worth more than a signature
   * that forbids the input from being missing.
   *
   * An empty array is rejected rather than producing an empty report: when the engine
   * offers nothing there is no decision to analyse, and a report whose every candidate
   * is illegal teaches worse than no report at all.
   */
  readonly legalActions?: readonly CoachAction[];
  /**
   * How often hero's aggressive line is assumed to win uncontested. Used only for the
   * bet/raise candidates, and reported as an assumption because it is an input, not a
   * measurement — nothing here can know how often a real opponent folds.
   */
  readonly assumedFoldEquity?: number;
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
    input.toCall,
    input.heroStack,
    input.bigBlind,
    input.heroCommittedThisStreet,
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new CoachError(
        'pot, toCall, heroStack, bigBlind and heroCommittedThisStreet must be non-negative integers',
      );
    }
  }
  if (input.bigBlind === 0) throw new CoachError('bigBlind must be positive');
  // A supplied minimum has to be a total in the same "raise to" units the engine uses,
  // and any legal raise is strictly above the level in force. A figure at or below it
  // is not a stricter floor, it is a different quantity — most likely an increment
  // passed where a total was wanted, which would put every emitted size below the
  // minimum again.
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
    // Not an error — a short stack facing a bigger bet is normal. The call is simply
    // capped at the stack, which is what the engine does too.
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
    // A list that disagrees with `toCall` is a caller that has paired a stale action
    // list with a fresh spot (or the reverse). Silently filtering against it would
    // drop the one candidate hero actually has, so it is an error rather than a
    // preference. Both directions are checked because both have to be wrong for a
    // mismatch to be harmless, and neither is.
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
  const all = [...input.heroCards, ...input.board];
  if (new Set(all).size !== all.length) throw new CoachError('hero cards and board contain a duplicate');
  const foldEquity = input.assumedFoldEquity;
  if (foldEquity !== undefined && (foldEquity < 0 || foldEquity > 1)) {
    throw new CoachError(`assumedFoldEquity must be between 0 and 1, received ${foldEquity}`);
  }
}

/**
 * Why the rule of 2 and 4 does not apply here, or `null` when it does.
 *
 * Three separate ways the shortcut stops meaning anything, kept apart because each one
 * gets a different sentence in front of the learner. It is a shortcut for *a draw with
 * clean outs still to come*, and every clause below is one of those words failing.
 */
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
  // "Drawing" is defined with the same yardstick `computeOuts` uses to decide whether a
  // CARD is an out: a card counts once it puts hero at or above `aheadThreshold`. A hand
  // already there does not need one. Using one threshold for both halves is what stops
  // the two definitions drifting into contradiction — the state the panel was in, where
  // a hand with 45 "outs" was 100% to win and the shortcut called it 180%.
  if (outs.equityNow >= DEFAULT_AHEAD_THRESHOLD) {
    return { kind: 'already-ahead', equityNow: outs.equityNow };
  }
  if (outs.cleanCount === 0) return { kind: 'no-clean-outs', dirty: outs.dirtyCount };
  const ceiling = maximumOutsForRuleOf24(cardsToCome);
  if (outs.cleanCount > ceiling) {
    return { kind: 'not-a-probability', cleanOuts: outs.cleanCount, ceiling };
  }
  return null;
}

/**
 * The rule-of-2-and-4 figure, or `null` where the shortcut cannot mean anything.
 *
 * ## Units: this publishes a FRACTION
 *
 * `EquitySummary.ruleOfThumb.estimate` is a probability in 0..1, exactly like
 * `heroEquity`, `breakEvenEquity`, `potShareIfCalled` and every other probability that
 * crosses this contract; `errorPoints` beside it stays in percentage POINTS, as its
 * name says. That boundary used to sit in the other place — the producer emitted 36 and
 * `@prl/ui`'s `formatPercent` multiplied by 100 again — and the shipped panel told
 * learners a flush draw was "3,600.0%". The bug was not the multiplication. It was a
 * field called `estimate`, typed `number`, that could equally have been either, so
 * nothing on either side of the wire was wrong to assume what it assumed.
 *
 * The field name cannot carry the unit (it is declared in `@prl/contracts` and read by
 * fixtures outside this package), so the unit is carried here instead: `ruleOf24`
 * returns POINTS in a field spelled `estimatePercent`, this function converts once,
 * through a named local, and `assertProbabilityFraction` refuses to publish anything
 * outside 0..1. A regression is a loud `CoachError` rather than a four-figure
 * percentage on an authoritative-looking panel.
 *
 * ## Clean outs only
 *
 * The shortcut's own explanation tells the reader to count clean outs only — "a card
 * that improves hero but hands an opponent a better hand at the same time is not an
 * out". The Coach used to pass `totalOuts`, clean plus dirty, and so contradicted the
 * sentence printed directly underneath it. It passes `cleanCount` now.
 *
 * ## What it is compared against
 *
 * The exact figure is `probabilityOfHitting(cleanOuts, unseen, cardsToCome)` — the true
 * chance of one of those same clean cards arriving — not hero's equity. They are
 * different quantities: equity is the chance of *winning*, which differs from the
 * chance of *hitting* by everything the dirty outs and the run-down represent. Measured
 * against equity, `errorPoints` mixed the shortcut's own error with that gap and
 * reported the sum as though the shortcut were responsible for all of it. Against the
 * hit probability it is the shortcut's error and nothing else, which is the figure a
 * learner needs to decide whether to trust it at the table.
 */
function buildRuleOfThumb(outs: OutsResult, cardsToCome: 1 | 2): NonNullable<EquitySummary['ruleOfThumb']> {
  // Cards hero cannot see: 52 less hero's two and the board, and the board length is
  // fixed by the street. 47 on the flop, 46 on the turn — the two counts the shortcut is
  // taught against and the ones `ruleOf24`'s own caveat quotes. Derived from
  // `cardsToCome` rather than taken as a parameter so there is no way to pass the other
  // street's figure.
  const unseen = DECK_SIZE - 2 - (5 - cardsToCome);
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
      `arriving (${exact.derivation}), not against hero's equity: hitting and winning are different ` +
      `questions, and ${outs.dirtyCount === 0 ? 'the dirty-out count is zero here only because every out is clean' : `the ${outs.dirtyCount} dirty outs are exactly the gap between them`}. ` +
      'The shortcut is an approximation and this is its error, stated rather than hidden.',
  };
}

/**
 * The rule-of-2-and-4 figure for a spot, or `null` where the shortcut cannot mean
 * anything. **The only way anything outside this file may compute it.**
 *
 * Exported because there are two producers of this figure — the Coach, and
 * `@prl/content`'s scenario analysis — and they had two copies of the same mistake:
 * both multiplied `totalOuts`, clean plus dirty, by 2 or 4 and published the result
 * whatever it came to. `@prl/content` had a shipped scenario that came out at
 * **47 x 4 = 188%**. One gate, one definition, both callers behind it, so the next
 * producer inherits the fix instead of the bug.
 *
 * `ruleOf24` itself now refuses an out count whose multiple exceeds 100, so a caller
 * that skips this function gets a loud `OddsError` rather than a four-figure percentage.
 * This is the function that turns that refusal into an answer a report can carry.
 */
export function ruleOfThumbFor(
  outs: OutsResult | null,
  cardsToCome: 1 | 2 | null,
): EquitySummary['ruleOfThumb'] {
  if (outs === null || cardsToCome === null) return null;
  if (ruleOfThumbRefusalFor(outs, cardsToCome) !== null) return null;
  return buildRuleOfThumb(outs, cardsToCome);
}

/**
 * The invariant the whole unit boundary rests on. A probability that is not one is a
 * bug in this file, and it says so rather than travelling to a panel.
 */
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

  // The rule of 2/4 is a teaching aid, so show it *with* its actual error rather than
  // presenting the shortcut as if it were the figure — and only where it has one.
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

function buildPotOddsSummary(pot: number, toCall: number, heroEquity: number): PotOddsSummary {
  const odds = potOdds(pot, toCall);
  return {
    pot,
    toCall,
    breakEvenEquity: odds.breakEvenEquity,
    oddsRatio: odds.oddsRatio,
    equitySurplus: heroEquity - odds.breakEvenEquity,
    explanation:
      toCall === 0
        ? 'Nothing to call, so there is no price to beat — checking keeps you in for free.'
        : `${odds.explanation} You clear that with ${(heroEquity * 100).toFixed(1)}% equity, ` +
          `a ${((heroEquity - odds.breakEvenEquity) * 100).toFixed(1)} point ` +
          `${heroEquity >= odds.breakEvenEquity ? 'surplus' : 'shortfall'}.`,
  };
}

function buildStackContext(input: CoachInput): StackContext {
  const effective = effectiveStack(input.heroStack, input.opponentStacks);
  // SPR is undefined with an empty pot; preflop before blinds is the only case, and
  // the Coach is never asked for one there.
  const pot = Math.max(1, input.pot);
  const spr = stackToPotRatio(effective.effective, pot);
  const potSizedPrice = priceLaidByBet(pot, pot);
  return {
    effectiveStack: effective.effective,
    spr: spr.spr,
    potOddsOfferedByPotSizedBet: potSizedPrice.breakEvenEquity,
    explanation: `${effective.explanation} ${spr.explanation} ${spr.implication}`,
  };
}

/**
 * The smallest total a bet or raise may legally reach here, in the engine's `to` units.
 *
 * When the caller has a hand state it passes the engine's own figure and this returns
 * it unchanged: `legalActions` is the single definition of "legal" and nothing here is
 * entitled to a second opinion.
 *
 * Without one, the floor is derived from the two rules that fix it — and derived so
 * that it can never land *below* the engine's. The engine's minimum is
 *
 *     betLevel + max(lastFullRaiseIncrement, bigBlind)
 *
 * and `lastFullRaiseIncrement` is not knowable from a described spot. But it is always
 * at most `toCall`: hero's own street commitment can never exceed the bet level that
 * was in force before the last complete raise (hero either matched that level or set
 * it), so `increment = betLevel - previousLevel <= betLevel - heroCommitted = toCall`.
 * Substituting `toCall` for the unknown increment therefore gives a floor at or above
 * the real one — legal in every case, and exactly equal in the ordinary one where the
 * bet faced *is* the last raise. On a street where nobody has bet, `betLevel` and
 * `toCall` are both 0 and the expression collapses to one big blind, which is the
 * engine's minimum opening bet.
 *
 * Erring upward is the only safe direction *for what gets published*. A floor that is too
 * low publishes a size the table rejects; a floor that is too high publishes a legal size
 * that is larger than it strictly had to be, and says so in chips a learner can read. Be
 * aware that the direction inverts for a caller that uses this to *refuse* a size — see
 * below.
 *
 * ## The all-in clamp is part of the floor, not part of the caller
 *
 * A stack that cannot reach the minimum may still shove: a short all-in is a legal
 * (incomplete) raise, and `legalActions` allows it for exactly that reason. That clamp used
 * to live at the one call site, which was fine while there was one call site. There is now a
 * second — `apps/api/src/routes/content.ts` holds a learner's submitted size to this same
 * floor before grading it — and a floor whose callers have to remember to clamp it is a floor
 * that will eventually refuse a legal shove.
 *
 * ## What a refusing caller is signing up for
 *
 * The derivation can sit *above* the engine's true minimum, in the one case the derivation
 * names: a spot where the bet hero faces is not itself the last full raise. A caller that
 * refuses everything below this floor therefore refuses, in that case, a size a real table
 * might have accepted. That is the right trade for the Scenario Lab — every spot there is a
 * described one facing a single bet, where the two figures coincide — but it is a refusal
 * with a stated number rather than a silent one, and it must stay that way: quoting the floor
 * back to the learner is what makes the rare over-strict case visible instead of mysterious.
 *
 * `minimumRaiseTo` removes the question entirely, which is why any caller holding a
 * `HandState` should pass it.
 */
export function minimumAggressiveTo(spot: SizedSpot): number {
  const derived = spot.minimumRaiseTo ?? betLevelOf(spot) + Math.max(spot.toCall, spot.bigBlind);
  return Math.min(derived, maximumTo(spot));
}

/**
 * A raise's sizing note.
 *
 * The ladder's own note cannot be used for a raise: it reads "Risks {amount} to win
 * {pot}", which is true of a bet and false of a raise, where the risk also includes
 * the call. Getting that sentence wrong is how a mispriced raise hides in plain sight,
 * so the risk is stated by `evOfRaise` and this note only carries the figures the
 * ladder computed from `odds.ts` — the price the extra chips lay a caller and the
 * defence they demand, both of which are correctly measured against the pot as it
 * stands once hero calls.
 */
function raiseSizingNote(option: SizingOption, potAfterCall: number, isAllIn: boolean): string {
  const shape =
    option.label === 'all-in'
      ? `Raising by ${chips(option.amount)} puts your whole remaining stack in.`
      : `Raising by ${chips(option.amount)} is ${option.label} of the ${chips(potAfterCall)} that would be in the middle once you call.`;
  const allIn = isAllIn && option.label !== 'all-in' ? ' That size is also your whole remaining stack.' : '';
  return (
    `${shape} A caller needs ${percent(option.priceLaidToCaller)} equity to break even on the extra ` +
    `${chips(option.amount)}, and has to continue with ${percent(option.minimumDefenceFrequency)} of ` +
    `their range for a raise of this size not to print automatically.${allIn}`
  );
}

/**
 * Candidate actions with their expected value.
 *
 * EV is measured **relative to folding**, which is defined as zero. Chips already in
 * the pot are sunk and do not appear — including them is the arithmetic form of the
 * sunk-cost fallacy, and it makes every call look better than it is.
 *
 * ## A raise is not a bet, in three places at once
 *
 * The Coach used to price every aggressive line with `evOfBet` and label its total as
 * `toCall + increment`. That is three separate errors sharing one root — pretending
 * the money already on the table is not there:
 *
 *   1. **The EV.** Raising by `r` while facing `c` risks `c + r`, so the figure comes
 *      from `evOfRaise`, not `evOfBet`. Charging only `r` overstates every raise by
 *      `(1 - f) x c x (1 - e)` — most of all when hero is weakest.
 *   2. **The total.** `to` is a seat's whole street commitment, so it is
 *      `heroCommittedThisStreet + toCall + r`. Dropping the first term is what
 *      published raises the table would refuse.
 *   3. **The floor.** A raise must reach a minimum, so ladder rungs below it are not
 *      offered at all. The smallest rung is exactly the one a learner is most likely
 *      to try.
 *
 * Which of a bet and a raise is on offer is decided by the bet level, not by `toCall`:
 * a big blind facing a limped pot owes nothing and still cannot *bet*, because there
 * is already a live bet — their own blind — on the table. `betLevel === 0` is the
 * engine's own test and it is the one used here.
 *
 * ## Legality is asked, never inferred
 *
 * Everything above prices actions correctly. It says nothing about whether they are
 * *available*, and three of the engine's rules are invisible from the pot and the price:
 * no bet or raise when every live opponent is all-in, none when a short all-in has closed
 * the action to a seat that already acted, and no action at all once betting is closed
 * for the hand. So when the caller has a hand state, `input.legalActions` carries the
 * engine's own answer and every candidate below is filtered through it. Without one the
 * filter is `deriveLegalActions` — the betting rules a described spot does determine —
 * and never an unconditional yes.
 */
function buildCandidates(input: CoachInput, heroEquity: number, foldEquity: number): ActionCandidate[] {
  const candidates: ActionCandidate[] = [];
  // One list, resolved once, and never an `undefined` short-circuit. The previous form was
  // `input.legalActions === undefined || input.legalActions.includes(action)`, which reads
  // as "the engine has not ruled it out" and behaves as "nobody asked, so yes" — the
  // difference between those two is the whole defect. `deriveLegalActions` answers for the
  // callers with no hand state; see its doc for what it can and cannot establish.
  const legal = input.legalActions ?? deriveLegalActions(input);
  const permitted = (action: CoachAction): boolean => legal.includes(action);

  const betLevel = betLevelOf(input);
  const isOpening = betLevel === 0;

  // Check first, then fold. The order is the ranking's first tiebreak (the sort below
  // is stable), and when both are worth the same — a dead hand in an empty pot — the
  // one that keeps the hand has to be the one that wins the tie.
  if (input.toCall === 0 && permitted('check')) {
    const check = evOfCheck({ pot: input.pot, equity: heroEquity });
    candidates.push({
      action: 'check',
      cost: 0,
      ev: check.ev,
      derivation: check.derivation,
      // No `potShareIfCalled`: nothing is being called, and the UI renders that field
      // as "wins X% of the pot when called", which would be a sentence about an event
      // that cannot happen.
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
    const call = evOfCall({ pot: input.pot, toCall: cappedCall, equity: heroEquity });
    candidates.push({
      action: 'call',
      // The total this street, matching the engine: what is already out there plus
      // what goes in now.
      to: input.heroCommittedThisStreet + cappedCall,
      cost: cappedCall,
      ev: call.ev,
      derivation: call.derivation,
      potShareIfCalled: heroEquity,
    });
  }

  // Aggressive candidates. `maxRaiseBy` is the increment an all-in would be: the whole
  // stack goes out, and the part of it that merely matches the bet is not a raise.
  const maxRaiseBy = input.heroStack - input.toCall;
  if (maxRaiseBy > 0 && permitted(isOpening ? 'bet' : 'raise')) {
    // Already clamped at `maximumTo` by `minimumAggressiveTo`, because a stack that cannot reach
    // the minimum may still shove — a short all-in is a legal (incomplete) raise, and that is
    // the clamp `legalActions` applies. It moved into the floor itself when a second caller
    // appeared that has to hold a learner's submitted size to the same figure.
    const floorTo = minimumAggressiveTo(input);
    const floorRaiseBy = floorTo - betLevel;

    // Sizes are fractions of the pot as it stands *after* the call, which is both how
    // a raise is described at a table and the pot the raise actually lays a price
    // into. For an opening bet there is nothing to call and this is just the pot.
    const potAfterCall = Math.max(1, input.pot + input.toCall);
    const ladder = sizingLadder(potAfterCall, maxRaiseBy);
    // `legalRungs`, not `legal`: this is the set of legal *sizes*, a different question
    // from the set of legal actions resolved at the top of this function, and one name
    // for both is how the two got conflated in the first place.
    const legalRungs = ladder.filter((option) => option.amount >= floorRaiseBy);

    // Three representative sizes rather than the whole ladder: enough to show how the
    // decision moves with size without turning the panel into a table nobody reads.
    // Smallest legal, something in the middle, and the shove — taken from the legal
    // rungs, so no size here is one the table would refuse. The ladder always ends in
    // an all-in rung and an all-in always clears the clamped floor, so this list is
    // never empty.
    const picks = [
      legalRungs[0],
      legalRungs[Math.floor((legalRungs.length - 1) / 2)],
      legalRungs[legalRungs.length - 1],
    ];
    const seen = new Set<number>();
    for (const option of picks) {
      if (option === undefined || option.amount <= 0 || seen.has(option.amount)) continue;
      seen.add(option.amount);
      const raiseBy = option.amount;

      if (isOpening) {
        const bet = evOfBet({
          pot: input.pot,
          betSize: raiseBy,
          foldProbability: foldEquity,
          equityWhenCalled: heroEquity,
          callerCanRaise: true,
        });
        candidates.push({
          action: 'bet',
          to: raiseBy,
          cost: raiseBy,
          ev: bet.ev,
          derivation: `${bet.derivation} ${option.note}`,
          foldEquityAssumed: foldEquity,
          potShareIfCalled: heroEquity,
        });
        continue;
      }

      const raise = evOfRaise({
        pot: input.pot,
        toCall: input.toCall,
        raiseBy,
        foldProbability: foldEquity,
        equityWhenCalled: heroEquity,
        callerCanRaise: true,
      });
      candidates.push({
        action: 'raise',
        to: betLevel + raiseBy,
        cost: raise.risk,
        ev: raise.ev,
        derivation: `${raise.derivation} ${raiseSizingNote(option, potAfterCall, raiseBy === maxRaiseBy)}`,
        foldEquityAssumed: foldEquity,
        potShareIfCalled: heroEquity,
      });
    }
  }

  assertAffordable(candidates, input);
  return candidates;
}

/**
 * No published row may cost more than hero has, or reach a total hero cannot reach.
 *
 * Both figures follow from the arithmetic above — the call is clamped at the stack, an
 * opening bet's ladder is capped at `heroStack`, and a raise's risk is
 * `toCall + raiseBy` with `raiseBy <= heroStack - toCall` — so this asserts rather than
 * clamps. That direction is deliberate. A clamp would quietly publish a *different*
 * action from the one it priced, and the EV, the derivation sentence and the size range
 * would all still describe the size the clamp discarded; a throw says the arithmetic
 * disagrees with itself and stops.
 *
 * ## The two quantities, because they are one word apart
 *
 * `cost` is chips leaving the stack for this action alone, so it is compared against
 * `heroStack` — chips BEHIND. `to` is the seat's whole commitment for the street, so it
 * is compared against `heroCommittedThisStreet + heroStack`, which is the same `maxTo`
 * the engine clamps a size to. Comparing either against the other's ceiling looks almost
 * right and is a double-count in one direction or a needless refusal in the other.
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
 * How a tie on EV is broken. Lower sorts later, so folding is last.
 *
 * Two actions worth the same number of chips are not equally good advice. Folding gives
 * up every future branch of the hand for exactly the same zero that checking pays for
 * keeping them, so on a tie it must lose — and a tie is reachable: `EV(check)` is
 * `equity x pot`, which is 0 for a hand drawing stone dead. Everything else keeps the
 * hand alive and is ranked above a fold on the same reasoning.
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
 * Picks the highest-EV candidate, then deliberately weakens the claim.
 *
 * Confidence is downgraded when the margin between the best and second-best action is
 * small relative to a big blind, or when the equity figure itself was sampled with a
 * wide interval. A decision that is nearly a coin-flip between two actions should not
 * be presented as a recommendation, and this is where that honesty is enforced.
 *
 * One thing this function is not allowed to conclude: **fold, while checking is free**.
 * That is the single action the engine, the lessons and the scenarios all agree can
 * never be right — nothing beats free — and it used to be reachable, because a check
 * was priced at a hard-coded 0 alongside a fold's 0 and a stable sort put fold first.
 * The fix is the arithmetic (`evOfCheck` prices a check at `equity x pot`, which is
 * never below zero) plus the tiebreak above; the assertion at the end is there because
 * an invariant nobody checks is a comment.
 */
function buildSuggestion(
  candidates: readonly ActionCandidate[],
  input: CoachInput,
  equitySummary: EquitySummary,
  outs: OutsResult | null,
): CoachSuggestion {
  const ranked = [...candidates].sort(byExpectedValue);
  const best = ranked[0];
  const second = ranked[1];
  if (best === undefined) throw new CoachError('no candidate actions were produced');

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

  const margin = second === undefined ? Number.POSITIVE_INFINITY : best.ev - second.ev;
  const marginInBigBlinds = margin / input.bigBlind;
  const intervalPoints = equitySummary.confidenceHalfWidthPoints ?? 0;

  let confidence: CoachSuggestion['confidence'] = 'reasonable';
  if (marginInBigBlinds < 0.25 || intervalPoints > 2) confidence = 'low';
  else if (marginInBigBlinds < 1 || intervalPoints > 0.75) confidence = 'moderate';

  // The published range is a range of *defensible* sizes, which is what the words
  // "size range" claim. It used to be the whole sizing ladder for the chosen action,
  // top to bottom — a span whose upper end the Coach itself priced hundreds of chips
  // below its lower end, printed as though anything inside it were fine. A size only
  // belongs here if it is within the same one-big-blind indifference margin used just
  // above to downgrade confidence: near enough to the best that the choice between
  // them is not the decision being taught. Every size in it is a real candidate, so
  // every size in it is one the table would accept.
  const sizeMargin = input.bigBlind;
  const sameActionSizes = candidates
    .filter(
      (candidate) =>
        candidate.action === best.action &&
        candidate.to !== undefined &&
        candidate.ev >= best.ev - sizeMargin,
    )
    .map((candidate) => candidate.to ?? 0)
    .filter((value) => value > 0);

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
    whatWouldChangeIt.push(
      `This assumes the line wins uncontested ${(best.foldEquityAssumed ?? 0) * 100}% of the time. An opponent who folds less often makes it worse.`,
    );
    whatWouldChangeIt.push('Being raised is not modelled here, so treat the figure as optimistic.');
  }
  if (outs !== null && outs.dirtyCount > 0) {
    whatWouldChangeIt.push(
      `${outs.dirtyCount} of your ${outs.totalOuts} outs are dirty — they improve you without making you safe, so counting all of them would overstate your chances.`,
    );
  }
  if (equitySummary.method === 'monte-carlo') {
    whatWouldChangeIt.push(
      `The equity figure is sampled, ±${intervalPoints.toFixed(2)} points at 95% confidence. A close decision could sit either side of that.`,
    );
  }
  if (marginInBigBlinds < 1) {
    whatWouldChangeIt.push(
      `The gap to the next-best action is only ${margin.toFixed(1)} chips, well under a big blind — this is close to indifferent.`,
    );
  }
  if (whatWouldChangeIt.length === 0) {
    whatWouldChangeIt.push('A different assumption about the opponent range would change the numbers.');
  }

  const reason =
    confidence === 'low'
      ? `${best.action} comes out marginally ahead here, but only just — treat this as close to indifferent rather than as a recommendation.`
      : `${best.action} has the highest expected value against the stated range, by ${margin.toFixed(1)} chips over the next-best action.`;

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

function buildUncertainty(result: EquityResult, input: CoachInput, outs: OutsResult | null): UncertaintyNote {
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
      'Against several opponents the analysis assumes all of them see the river, which overstates your risk when some would fold.',
    );
  }
  if (outs !== null) {
    limitations.push(
      'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.',
    );
  }
  limitations.push('No implied odds, reverse implied odds or future-street play are modelled.');

  const summary =
    result.method === 'exact-enumeration'
      ? `Computed exactly by enumerating every remaining board (${result.trials.toLocaleString('en-US')} run-outs). There is no sampling error.`
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

/** "9 cards" / "1 card". Counts read as cards here, not as a bare number. */
function pluralCards(count: number): string {
  return `${count} ${count === 1 ? 'card' : 'cards'}`;
}

/**
 * Why the rule of 2 and 4 is missing from this report, in words a learner can use.
 *
 * Silence would be the second mistake: a panel that simply drops the shortcut teaches
 * nothing about *when* a shortcut stops working, which is the more valuable half of
 * knowing it at all. So every refusal says which word of "a draw with clean outs still
 * to come" failed here.
 */
function refusalNote(refusal: RuleOfThumbRefusal | null): string | null {
  if (refusal === null) return null;
  switch (refusal.kind) {
    case 'no-cards-to-come':
      return null; // Nothing to explain: there is no draw and no outs section either.
    case 'already-ahead':
      return (
        `No rule-of-2-and-4 figure here, deliberately: at ${(refusal.equityNow * 100).toFixed(1)}% you are ` +
        'already ahead, so you are not drawing to anything. The shortcut counts the cards that rescue a ' +
        'hand that is behind; applied to a hand that is already winning it counts cards that change ' +
        'nothing and returns a number that is not a probability of anything.'
      );
    case 'no-clean-outs':
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
): string[] {
  const notes: string[] = [];

  // Both halves of the condition are real. `toCall > 0` is what makes this note worth
  // writing; `oddsRatio !== null` is what makes it *writable*, because a free call has
  // no "X to 1" form at all. The two agree by construction — `buildPotOddsSummary` is
  // handed this same `toCall` — but the null check is what stops a future caller who
  // passes a different pair from rendering "Infinity to 1" or "null to 1" at a learner,
  // which is exactly what the old `oddsRatio.toFixed(1)` on a `number` could do.
  if (input.toCall > 0 && potOddsSummary.oddsRatio !== null) {
    notes.push(
      `The pot is laying you ${potOddsSummary.oddsRatio.toFixed(1)} to 1, so you need ${(potOddsSummary.breakEvenEquity * 100).toFixed(1)}% to break even on a call. That number depends only on the price — not on your cards.`,
    );
  }
  if (outs !== null && outs.dirtyCount > 0) {
    notes.push(
      `Notice the split: ${outs.cleanCount} clean and ${outs.dirtyCount} dirty, out of ${outs.totalOuts} outs in total. ` +
        'A card that improves you is not the same as a card that wins you the hand — an opponent who is behind after it lands can still draw out on the last card.',
    );
    if (outs.cleanCount === 0) {
      notes.push(
        'None of these outs is clean, which is worth sitting with: you can hit and still lose. That is what a redraw costs you, and it is invisible if you only count outs.',
      );
    }
  }
  const ruleOfThumb = equitySummary.ruleOfThumb;
  if (ruleOfThumb !== null && outs !== null) {
    const sign = ruleOfThumb.errorPoints >= 0 ? 'over' : 'under';
    notes.push(
      // `estimate` is a fraction, so it is multiplied here exactly once. Read it as a
      // percentage without the x100 and this sentence says "0% here", which is how a
      // unit error hides in prose rather than in a figure.
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
  if (stacks.spr < 3) {
    notes.push(
      `At an SPR of ${stacks.spr.toFixed(1)} the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.`,
    );
  } else if (stacks.spr > 10) {
    notes.push(
      `At an SPR of ${stacks.spr.toFixed(1)} there is a lot of money left behind, so hands that can keep improving are worth more than their current strength suggests.`,
    );
  }
  if (potOddsSummary.equitySurplus > 0 && potOddsSummary.toCall > 0) {
    notes.push(
      'A profitable call still loses more often than it wins whenever the break-even point is under 50%. Losing this hand would not make the call wrong.',
    );
  }
  return notes;
}

/** Assembles the full report. This is the only function the API and the UI need. */
export function buildCoachReport(input: CoachInput): CoachReport {
  validate(input);

  // `exactRange` rather than a hand-built object. The literal that used to sit here
  // was a second, worse implementation of the same thing: it left `classes` empty (so
  // "AsKh" claimed to belong to no starting-hand class), hard-coded 1326, kept the
  // cards in whatever order the caller passed them, and needed two `as Card`
  // assertions to get past `noUncheckedIndexedAccess`. Ranges have exactly one
  // constructor in this package, and `validate` above has already established that
  // there are two distinct cards for it to accept.
  const heroRange: ParsedRange = exactRange(input.heroCards);

  const spec: EquitySpec = {
    players: [
      { label: 'you', range: heroRange },
      ...input.opponents.map((opponent) => ({ label: opponent.label, range: opponent.range })),
    ],
    board: input.board,
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
  const potOddsSummary = buildPotOddsSummary(input.pot, input.toCall, hero.equity);
  const stackContext = buildStackContext(input);
  const foldEquity = input.assumedFoldEquity ?? DEFAULT_ASSUMED_FOLD_EQUITY;
  const candidates = buildCandidates(input, hero.equity, foldEquity);
  const suggestion = buildSuggestion(candidates, input, equitySummary, outs);
  const uncertainty = buildUncertainty(equityResult, input, outs);

  const assumptions = [...equityResult.assumptions];
  if (candidates.some((candidate) => candidate.action === 'bet' || candidate.action === 'raise')) {
    assumptions.push(
      `Bet and raise figures assume the line wins uncontested ${(foldEquity * 100).toFixed(0)}% of the time. That is an input you can change, not something measured.`,
    );
    const halfPot = Math.max(1, Math.round(input.pot / 2));
    const needed = requiredFoldEquity({ pot: input.pot, betSize: halfPot, equityWhenCalled: hero.equity });
    // The two degenerate cases read badly if stated as a bare percentage: "needs 0%"
    // sounds like a mistake, and "needs 120%" sounds like one too. Say what each
    // actually means.
    if (needed.foldEquityNeeded <= 0) {
      assumptions.push(
        `A half-pot bet of ${halfPot} is already break-even or better here purely on the equity you have when called — it does not need to win uncontested at all.`,
      );
    } else if (needed.foldEquityNeeded >= 1) {
      assumptions.push(
        `A half-pot bet of ${halfPot} cannot break even at any fold frequency with this much equity when called — folding out the whole range still would not be enough.`,
      );
    } else {
      assumptions.push(
        `For a half-pot bet of ${halfPot} to break even here it would need to win uncontested ${(needed.foldEquityNeeded * 100).toFixed(0)}% of the time.`,
      );
    }
  }
  assumptions.push(
    'Expected values are measured against folding, which is treated as zero. Chips already in the pot are spent either way.',
  );

  if (assumptions.length === 0) {
    // Unreachable — equityResult always supplies assumptions — but the invariant is
    // worth asserting rather than trusting, because an empty list would silently
    // present every figure as unconditional fact.
    throw new CoachError('a Coach report must never be produced without assumptions');
  }

  return {
    street: input.street,
    potTotal: input.pot,
    toCall: input.toCall,
    outs: buildOutsBreakdown(outs),
    equity: equitySummary,
    potOdds: potOddsSummary,
    candidates,
    suggestion,
    stackContext,
    assumptions,
    uncertainty,
    teachingNotes: buildTeachingNotes(input, potOddsSummary, equitySummary, outs, stackContext, cardsToCome),
  };
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
