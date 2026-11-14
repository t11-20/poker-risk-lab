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
import type { Card } from '@prl/poker-engine';
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
import { computeOuts, type OutsResult } from './outs.ts';
import { exactRange, type ParsedRange } from './ranges.ts';
import { effectiveStack, type SizingOption, sizingOptionAt, stackToPotRatio } from './stacks.ts';
import { type OfferedSize, offeredSizes } from './table-sizing.ts';

export class CoachError extends Error {
  override readonly name = 'CoachError';
}

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

/** The five things a seat can do. Identical to `ActionCandidate['action']` by design. */
export type CoachAction = ActionCandidate['action'];

/** The part of a spot that fixes which action kinds are legal. `CoachInput` satisfies it structurally. */
export interface DescribedSpot {
  /** What hero must add to continue. 0 when hero can check. */
  readonly toCall: number;
  /** Chips hero has ALREADY put out on this street. */
  readonly heroCommittedThisStreet: number;
  /** Chips hero has BEHIND, not counting anything already committed. */
  readonly heroStack: number;
  /** Chips BEHIND for each opponent still in the hand, one entry per opponent. */
  readonly opponentStacks: readonly number[];
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

  const someOpponentCanAnswer = spot.opponentStacks.some((stack) => stack > 0);
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
function betLevelOf(spot: DescribedSpot): number {
  return spot.heroCommittedThisStreet + spot.toCall;
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
   * because the uncovered part is a side pot hero cannot win. Heads-up at 5/10, hero calling 40 into a
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
  /** Chips BEHIND for each opponent still in the hand, on the same reading. */
  readonly opponentStacks: readonly number[];
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
  /** How often a bet or raise is assumed to win uncontested. An input, so it is reported as an assumption. */
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
    input.contestablePot,
    input.toCall,
    input.heroStack,
    input.bigBlind,
    input.heroCommittedThisStreet,
  ]) {
    if (!Number.isInteger(value) || value < 0) {
      throw new CoachError(
        'pot, contestablePot, toCall, heroStack, bigBlind and heroCommittedThisStreet must be ' +
          'non-negative integers',
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
  const all = [...input.heroCards, ...input.board];
  if (new Set(all).size !== all.length) throw new CoachError('hero cards and board contain a duplicate');
  const foldEquity = input.assumedFoldEquity;
  if (foldEquity !== undefined && (foldEquity < 0 || foldEquity > 1)) {
    throw new CoachError(`assumedFoldEquity must be between 0 and 1, received ${foldEquity}`);
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

/** Names the side pot hero cannot win, or `''` when the whole pot is contestable. Never silent. */
function sidePotNote(pot: number, contestablePot: number, toCall: number): string {
  const beyondReach = pot - contestablePot;
  if (beyondReach <= 0) return '';
  return (
    ` There are ${chips(pot)} in the middle, but you are all-in for less than the bet in front of ` +
    `you: ${chips(beyondReach)} of it is a side pot you are not in, because your ${chips(toCall)} ` +
    `does not reach that far. The price above is against the ${chips(contestablePot)} you can ` +
    'actually win. Calling cannot win the rest of the middle no matter which hand is best.'
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
 * `PotOddsSummary.pot` is the contestable pot, so the price and the pot it is into are the same pot.
 * `CoachReport.potTotal` carries the whole middle beside it.
 */
function buildPotOddsSummary(
  pot: number,
  contestablePot: number,
  toCall: number,
  heroEquity: number,
): PotOddsSummary {
  const odds = potOdds(contestablePot, toCall);
  return {
    pot: contestablePot,
    toCall,
    breakEvenEquity: odds.breakEvenEquity,
    oddsRatio: odds.oddsRatio,
    equitySurplus: heroEquity - odds.breakEvenEquity,
    explanation:
      toCall === 0
        ? 'Nothing to call, so there is no price to beat — checking keeps you in for free.'
        : `${odds.explanation} ${describePriceGap(heroEquity, odds.breakEvenEquity)}` +
          sidePotNote(pot, contestablePot, toCall),
  };
}

function buildStackContext(input: CoachInput): StackContext {
  const effective = effectiveStack(input.heroStack, input.opponentStacks);
  // SPR is undefined with an empty pot, which only happens preflop before blinds.
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
  const share = `${percent(option.fractionOfPot)} of the ${chips(potAfterCall)} that would be in the middle once you call`;
  const shape =
    sizeId === 'allIn'
      ? `Raising by ${chips(option.amount)} puts your whole remaining stack in.`
      : sizeId === 'minimum'
        ? `Raising by ${chips(option.amount)} is the smallest raise the rules allow here: ${share}.`
        : `Raising by ${chips(option.amount)} is the ${SIZE_WORDS[sizeId]} size: ${share}.`;
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

/**
 * Candidate actions with EV relative to folding, which is zero. Sunk chips do not appear.
 * Raising by `r` facing `c` risks `c + r` (`evOfRaise`), and its total is
 * `heroCommittedThisStreet + toCall + r`. The floor itself is offered, because an untouched sizer
 * sends it. Bet versus raise follows the engine's `betLevel === 0`, not `toCall`.
 * Every candidate passes `input.legalActions`, or `deriveLegalActions` when it is absent.
 */
function buildCandidates(input: CoachInput, heroEquity: number, foldEquity: number): ActionCandidate[] {
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
    const check = evOfCheck({ pot, equity: heroEquity });
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
    const call = evOfCall({ pot, toCall: cappedCall, equity: heroEquity });
    candidates.push({
      action: 'call',
      // The street total, matching the engine.
      to: input.heroCommittedThisStreet + cappedCall,
      cost: cappedCall,
      ev: call.ev,
      derivation: call.derivation,
      potShareIfCalled: heroEquity,
    });
  }

  // The increment an all-in would be. The part that matches the bet is not a raise.
  const maxRaiseBy = input.heroStack - input.toCall;
  if (maxRaiseBy > 0 && permitted(isOpening ? 'bet' : 'raise')) {
    // Already clamped at `maximumTo`, because a short all-in is a legal incomplete raise.
    const floorTo = minimumAggressiveTo(input);

    // Sizes are fractions of the pot after the call. For an opening bet that is the pot.
    const potAfterCall = Math.max(1, pot + input.toCall);

    // Exactly the sizes the bar offers, because a sized action is graded only on an exact match.
    // `pot` equals the whole middle here, because `maxRaiseBy > 0` means hero covers the bet.
    // `apps/web/test/lab-sizes-priced.test.ts` asserts the equality.
    const offered = offeredSizes({
      bounds: { min: floorTo, max: maximumTo(input) },
      pot,
      toCall: input.toCall,
      committedThisStreet: input.heroCommittedThisStreet,
    });
    for (const size of offered) {
      const raiseBy = size.to - betLevel;
      if (raiseBy <= 0) continue;
      const isAllIn = raiseBy === maxRaiseBy;

      if (isOpening) {
        const bet = evOfBet({
          pot,
          betSize: raiseBy,
          foldProbability: foldEquity,
          equityWhenCalled: heroEquity,
          callerCanRaise: true,
        });
        const option = sizingOptionAt(potAfterCall, raiseBy, SIZE_WORDS[size.id], isAllIn);
        candidates.push({
          action: 'bet',
          to: raiseBy,
          cost: raiseBy,
          ev: bet.ev,
          derivation: `${bet.derivation} ${betSizeSentence(size.id)}${option.note}`,
          foldEquityAssumed: foldEquity,
          potShareIfCalled: heroEquity,
        });
        continue;
      }

      const raise = evOfRaise({
        pot,
        toCall: input.toCall,
        raiseBy,
        foldProbability: foldEquity,
        equityWhenCalled: heroEquity,
        callerCanRaise: true,
      });
      const option = sizingOptionAt(potAfterCall, raiseBy, SIZE_WORDS[size.id], isAllIn);
      candidates.push({
        action: 'raise',
        to: betLevel + raiseBy,
        cost: raise.risk,
        ev: raise.ev,
        derivation: `${raise.derivation} ${raiseSizingNote(option, size.id, potAfterCall, pot, input.toCall, isAllIn)}`,
        foldEquityAssumed: foldEquity,
        potShareIfCalled: heroEquity,
      });
    }
  }

  assertAffordable(candidates, input);
  return candidates;
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
 * Picks the highest-EV candidate, then weakens the claim when the margin is small against a big blind
 * or the equity interval is wide. It may never conclude fold while checking is free, and asserts so.
 */
function buildSuggestion(
  candidates: readonly ActionCandidate[],
  input: CoachInput,
  equitySummary: EquitySummary,
  outs: OutsResult | null,
): CoachSuggestion {
  const ranked = [...candidates].sort(byExpectedValue);
  const best = ranked[0];
  if (best === undefined) throw new CoachError('no candidate actions were produced');
  // The next-best action, not the next row. Two sizes of one action can price within a chip, which
  // made 12 of 36 Lab scenarios read as indifferent. `sizeRange` reports how close sizes are.
  const second = ranked.find((candidate) => candidate.action !== best.action);

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

  // Only sizes within the one-big-blind margin of the best, so the range holds defensible sizes.
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
  if (marginInBigBlinds < 1) {
    whatWouldChangeIt.push(
      `The gap to the next-best action is only ${margin.toFixed(1)} units, well under a big blind — this is close to indifferent.`,
    );
  }
  if (whatWouldChangeIt.length === 0) {
    whatWouldChangeIt.push('A different assumption about the opponent range would change the numbers.');
  }

  // Capitalised to open the sentence, and in units to match every figure beside it on the panel.
  const actionWord = `${best.action.charAt(0).toUpperCase()}${best.action.slice(1)}`;
  const reason =
    confidence === 'low'
      ? `${actionWord} comes out marginally ahead here, but only just — treat this as close to indifferent rather than as a recommendation.`
      : `${actionWord} has the highest expected value against the stated range, by ${margin.toFixed(1)} units over the next-best action.`;

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
      outs.refusal === null
        ? 'The clean/dirty split for outs uses documented equity thresholds. They are a modelling choice, not a law of the game.'
        : 'The clean/dirty split uses documented equity thresholds, and here it is not a count of outs at all — you are already in front of the same bar a card would have to clear. The thresholds are a modelling choice, not a law of the game.',
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
      notes.push(
        `Do not price this against the ${chips(input.pot)} you can see. You are all-in for less than ` +
          `the bet, so ${chips(beyondReach)} of the middle is a side pot you are not in — it goes to ` +
          'whoever wins it among the players who covered that bet, whatever you are holding. Being ' +
          'short changes the price you are getting, not just the chips you can lose.',
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
  if (stacks.spr < 3) {
    notes.push(
      `At an SPR of ${stacks.spr.toFixed(1)} the stacks are shallow enough that one more bet commits them. Decisions like that are effectively made now rather than later.`,
    );
  } else if (stacks.spr > 10) {
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
  const potOddsSummary = buildPotOddsSummary(input.pot, input.contestablePot, input.toCall, hero.equity);
  const stackContext = buildStackContext(input);
  const foldEquity = input.assumedFoldEquity ?? DEFAULT_ASSUMED_FOLD_EQUITY;
  const candidates = buildCandidates(input, hero.equity, foldEquity);
  const suggestion = buildSuggestion(candidates, input, equitySummary, outs);
  const uncertainty = buildUncertainty(equityResult, input, outs);

  const assumptions = [...equityResult.assumptions];
  if (candidates.some((candidate) => candidate.action === 'bet' || candidate.action === 'raise')) {
    assumptions.push(
      `Bet and raise figures assume the line wins uncontested ${(foldEquity * 100).toFixed(0)}% of the time. That is an assumption, not something measured: the Scenario Lab lets you change it and watch these figures move.`,
    );
    // `contestablePot`, which equals `pot` wherever a bet is on offer.
    const halfPot = Math.max(1, Math.round(input.contestablePot / 2));
    const needed = requiredFoldEquity({
      pot: input.contestablePot,
      betSize: halfPot,
      equityWhenCalled: hero.equity,
    });
    // "Needs 0%" and "needs 120%" both read as mistakes, so each degenerate case says what it means.
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
    // Unreachable, but an empty list would present every figure as unconditional fact.
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
