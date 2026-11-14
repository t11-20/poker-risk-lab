/**
 * The decision engine. One situation in, a probability distribution over the engine's legal actions
 * out, and one action sampled from it (ADR 0012). See `docs/AI-LEGENDS.md` §5-§7.
 *
 * `PolicyInput` takes a redacted `PlayerView` plus this seat's two cards, never `HandState`, so the
 * deck, the salts and other seats' hole cards are unrepresentable (ADR 0003). `readSituation` is the
 * only reader of the view and reads no hole-card field, so `test/no-hidden-information.test.ts` can
 * assert that no read path ends in `holeCards`.
 *
 * Candidates come only from `view.legalActions`. Sizes are clamped to each action's `minTo`/`maxTo`
 * and rounded, and the engine re-validates (ADR 0002).
 *
 * Noise mixes the scores with a uniform distribution over the plausible actions:
 *
 *     p_final(a) = (1 - noise) x p_score(a) + noise / plausibleCount
 *
 * A fold when checking is free, or facing a bet with near-certain equity, is not plausible and stays
 * at 0. On a preflop entry decision the mixture runs within the entering and non-entering groups, so
 * the declared `vpip` survives it (see `entryProbabilities`).
 *
 * `vpip` is honoured by a logistic threshold at `1 - vpip` on `preflopClassPercentile`, which is
 * uniform over dealt hands. `pfrShareOfVpip` splits what enters, so PFR = vpip x pfrShareOfVpip.
 * `positionalVpipMultiplier` averages 1 across seats and the price factor only tightens, so realised
 * VPIP sits at or a little below the card. In a limped big blind only a raise counts as entering.
 *
 * Reads come from `opponent-model.ts` through `rangeFor`, `adjustmentsFor` and `statsFor`. The first
 * two always receive `adaptationWeight(input)`, so no unscaled read can move a decision. Before the
 * range was gated, swapping reads at `educational` changed 209 of 1,050 paired decisions. Multiway,
 * reads are taken against one primary opponent.
 *
 * `assertNoImpersonation` runs on every learner-facing string before `decide` returns. Nothing here
 * sees a run-out, so nothing grades a decision by its result.
 */

import {
  type Action,
  type Card,
  type LegalAction,
  orderFrom,
  type PlayerView,
  type RandomSource,
  type SeatIndex,
} from '@prl/poker-engine';
import {
  effectiveStack,
  evOfCall,
  type ParsedRange,
  parseRange,
  potOdds,
  priceLaidByBet,
  requiredFoldEquity,
  stackToPotRatio,
} from '@prl/poker-math';
import {
  assessPostflop,
  assessPreflop,
  preflopClassPercentile,
  type StrengthAssessment,
} from './hand-strength.ts';
import { assertNoImpersonation } from './labelling.ts';
import type { DifficultySettings } from './profiles.ts';
import {
  positionalVpipMultiplier,
  preferredPotFraction,
  stackDepthCommitmentMultiplier,
  TRAIT_LABELS,
  type TraitKey,
  type Traits,
} from './traits.ts';

export class PolicyError extends Error {
  override readonly name = 'PolicyError';
}

/** The public frequencies this policy reads about one seat. `DerivedSeatStats` satisfies it. */
export interface ObservedSeatRead {
  readonly seat: number;
  readonly handsSeen: number;
  readonly vpip: number;
  readonly aggressionFrequency: number;
  readonly foldToBetFrequency: number;
  /** Worst-case 95% half-width over the observed hand count, so a small sample shows as one. */
  readonly confidenceHalfWidth: number;
  /** The observer's own band: `insufficient`, `indicative` or `reasonable`. Never "certain". */
  readonly reliability: string;
}

/**
 * Multipliers on this model's own tendencies, 1 being neutral. Multipliers rather than replacements,
 * so a profile keeps its style and leans on what it has seen.
 */
export interface ObservedAdjustments {
  readonly bluffMore: number;
  readonly valueBetThinner: number;
  readonly foldMore: number;
  readonly sizeUp: number;
  readonly isolateMore: number;
}

/** The opponent read this policy consumes. `OpponentModel` satisfies it structurally. */
export interface PolicyObservations {
  /** Null below the observer's own minimum sample: unknown, said in the type. */
  statsFor(seat: number): ObservedSeatRead | null;
  /** The assumed continuing range, already scaled by `adaptation` and by the sample's reliability. */
  rangeFor(seat: number, street: string, facingAction: string, adaptation: number): ParsedRange;
  /** Multipliers, already scaled by `adaptation` and by the sample's reliability. */
  adjustmentsFor(seat: number, adaptation: number): ObservedAdjustments;
}

/** EXACTLY what a policy may see. Deliberately not `HandState`. */
export interface PolicyInput {
  /** Already redacted for this seat by `redactFor`. */
  readonly view: PlayerView;
  readonly holeCards: readonly [Card, Card];
  readonly seat: SeatIndex;
  readonly traits: Traits;
  readonly difficulty: DifficultySettings;
  readonly observations: PolicyObservations;
  /** Injected. `Math.random` is banned in this package and asserted absent. */
  readonly random: RandomSource;
}

export interface WeightedAction {
  /** An engine `Action`, built from one entry of `view.legalActions` and nothing else. */
  readonly action: Action;
  /** Pre-normalisation score. 0 means the model does not consider this action here. */
  readonly weight: number;
  /** Normalised, after the difficulty noise mixture. Sums to 1 across the set. */
  readonly probability: number;
  /** Why this action got this weight. Third person, about the model. */
  readonly rationale: string;
}

export interface DrivingTrait {
  readonly key: TraitKey;
  readonly label: string;
  readonly value: number;
}

export interface PolicyDecision {
  /** The sampled action. Guaranteed to be one the engine offered, with an integer size. */
  readonly action: Action;
  /** One entry per legal action, in the engine's own order. */
  readonly distribution: readonly WeightedAction[];
  readonly strength: StrengthAssessment;
  readonly drivingTraits: readonly DrivingTrait[];
  /** Concrete counterfactuals: what a different position, depth or price would have done. */
  readonly whatChangedIt: readonly string[];
  /** The headline sentence. Third person, about the model. */
  readonly modelPreference: string;
}

// Tuning constants are design parameters, not measurements.

/** Steepness of the price response. An 11-point edge over break-even doubles the odds ratio. */
const PRICE_SENSITIVITY = 9;

/** Width of the preflop entry logistic, in percentile points. Symmetric about the threshold. */
const ENTRY_SOFTNESS = 0.04;

/** How much a large call, as a share of the stack, tightens the entry threshold. */
const ENTRY_PRICE_SPAN = 0.6;

const FOLD_BASE = 0.35;
const FOLD_TRAIT_SPAN = 1.3;
const FOLD_PRICE_SPAN = 0.6;
const FOLD_SURVIVAL_SPAN = 0.5;
const RISK_BASE = 0.7;
const RISK_SPAN = 0.6;

const CHECK_BASE = 1;
const CHECK_AGG_SPAN = 0.75;
const CHECK_WEAK_SPAN = 0.5;
const CHECK_TRAP_SPAN = 0.25;

/**
 * How `threeBetTendency` moves the raising share when facing a raise. Neutral at 0.5, so the axis
 * deviates from `pfrShareOfVpip` rather than competing with it. Gentle, because a share pushed to 1
 * would stop a raise-first profile ever flat-calling.
 */
const THREE_BET_BASE = 0.8;
const THREE_BET_SPAN = 0.4;

/**
 * The share of the openings it plays back at that this model re-raises rather than flat-calls. It is
 * the only frequency `threeBetTendency` declares, and `stats.ts` compares against it. Defined here so
 * the policy and the measurement share one expression.
 */
export function threeBetRaiseShare(traits: Traits): number {
  return clamp01(
    clamp01(traits.pfrShareOfVpip) * (THREE_BET_BASE + THREE_BET_SPAN * clamp01(traits.threeBetTendency)),
  );
}

/** How much of the bluff anchor is fold equity rather than the declared bluff frequency. */
const BLUFF_FOLD_EQUITY_SPAN = 0.5;

const CALL_BASE = 0.6;
const CALL_PASSIVE_SPAN = 0.9;
const CALL_DRAW_SPAN = 0.8;
const CALL_PASSIVITY_SPAN = 0.5;

/**
 * Bounds on the odds form `a/(1-a)` of `aggressionFrequency`. Clamping the odds rather than the trait
 * keeps the declared value intact while stopping one axis swamping the product.
 */
const MIN_AGGRESSION_ODDS = 0.05;
const MAX_AGGRESSION_ODDS = 6;

/**
 * Floor under the passive weight the aggressive weight is measured against. Without it a hopeless hand
 * facing a large bet could never bluff-raise, in the one spot where only a bluff wins.
 */
const MIN_PASSIVE_REFERENCE = 0.15;

const AGG_PRESSURE_BASE = 0.7;
const AGG_PRESSURE_SPAN = 0.6;
/** Above this share of the opponent range beaten, a bet is a value bet. */
const VALUE_EDGE = 0.55;
/**
 * Below this share of the opponent range beaten, a bet is a bluff. Between this and `VALUE_EDGE` a
 * hand bets at the declared `aggressionFrequency`.
 */
const BLUFF_CEILING = 0.45;
const SEMI_BLUFF_SPAN = 0.6;

/**
 * The band of relative strength on which `aggressionFrequency` is defined. Inside it `handFactor` in
 * `scoreAggression` is exactly 1, so the realised rate is the trait. Exported so `stats.ts` measures
 * the same band.
 */
export const NEUTRAL_ASSESSMENT_BAND = { low: BLUFF_CEILING, high: VALUE_EDGE } as const;

/** True when a relative-strength assessment sits in `NEUTRAL_ASSESSMENT_BAND`. */
export function isNeutralAssessment(relativeStrength: number): boolean {
  if (!Number.isFinite(relativeStrength)) return false;
  return relativeStrength >= NEUTRAL_ASSESSMENT_BAND.low && relativeStrength <= NEUTRAL_ASSESSMENT_BAND.high;
}

/**
 * Assumed chance ONE opponent folds to a bet, before any read. Multiway it is raised to the opponent
 * count, which treats folds as independent and so undercredits a bluff, the safe direction. Reads
 * move `bluffMore`, not this number.
 */
const BASE_FOLD_PER_OPPONENT = 0.55;
const MIN_FOLD_EQUITY = 0.05;
const MAX_FOLD_EQUITY = 0.9;

/**
 * How far `pressureTendency` moves a bet off the `betSizingPreference` size. Small, because `stats.ts`
 * inverts the measured size through `preferredPotFraction`. At 0.4 the measured preference came back
 * up to 0.26 above declared.
 */
const SIZE_PRESSURE_SPAN = 0.2;

/** A bet that would leave less than this share of the stack behind is made all-in instead. */
const SHOVE_THRESHOLD = 0.8;

/** Resolution of the sampling draw. One in a million is finer than any weight difference. */
const SAMPLE_RESOLUTION = 1_000_000;

/** Reference depths for the stack-depth counterfactual, in big blinds. */
const SHORT_STACK_REFERENCE_BB = 12;
const DEEP_STACK_REFERENCE_BB = 80;

/** The `facingAction` values `opponent-model.ts` accepts, narrowed to what can occur here. */
type FacingActionLabel = 'none' | 'check' | 'bet' | 'raise' | 'threeBet';

interface Situation {
  readonly street: PlayerView['street'];
  readonly board: readonly Card[];
  /** Chips in the middle BEFORE this seat's call. Never includes the call itself. */
  readonly pot: number;
  readonly toCall: number;
  readonly bigBlind: number;
  readonly myStack: number;
  readonly myCommitted: number;
  readonly opponents: number;
  readonly effectiveStackBehind: number;
  readonly effectiveStackBb: number;
  /** 0 for first to act on later streets, 1 for last. See `relativePositionOf`. */
  readonly relativePosition: number;
  readonly positionLabel: string | null;
  /** Money is owed. True for the small blind preflop even when nobody has raised. */
  readonly facingAggression: boolean;
  /**
   * Somebody has VOLUNTARILY bet or raised on this street. The small blind's forced debt is not a
   * raise. Treating it as one applied `threeBetTendency` to opens, up to 6 points of extra PFR.
   */
  readonly facingRaise: boolean;
  readonly facingAction: FacingActionLabel;
  readonly isPreflop: boolean;
  readonly isFirstVoluntaryPreflopDecision: boolean;
  readonly tookLeadPreviousStreet: boolean;
  /** The live opponent whose action is being answered. Never this seat. */
  readonly primaryOpponent: SeatIndex;
  readonly legalActions: readonly LegalAction[];
}

const STREET_ORDER = ['preflop', 'flop', 'turn', 'river', 'showdown', 'complete'] as const;

/**
 * Flattens the view into everything a decision depends on. The only function that touches
 * `input.view`, and it reads no hole-card field, the seat's own included.
 */
function readSituation(input: PolicyInput): Situation {
  const view = input.view;
  if (view.viewerSeat !== input.seat) {
    throw new PolicyError(
      `the input claims seat ${input.seat} but carries a view redacted for ` +
        `${String(view.viewerSeat)}; a policy must only ever be given its own view`,
    );
  }
  const me = view.seats.find((seat) => seat.seat === input.seat);
  if (me === undefined) {
    throw new PolicyError(`seat ${input.seat} does not appear in the view it was given`);
  }
  if (view.toAct !== input.seat) {
    throw new PolicyError(
      `seat ${input.seat} was asked to decide but the view says it is ${String(view.toAct)}'s turn`,
    );
  }
  const legalActions = view.legalActions;
  if (legalActions.length === 0) {
    throw new PolicyError(`the view offered seat ${input.seat} no legal actions`);
  }

  const liveSeats = view.seats.filter((seat) => seat.status === 'active' || seat.status === 'allIn');
  const liveSeatNumbers = liveSeats.map((seat) => seat.seat);
  const opponents = liveSeats.filter((seat) => seat.seat !== input.seat);
  const bigBlind = view.config.bigBlind;
  const effective =
    opponents.length === 0
      ? me.stack
      : effectiveStack(
          me.stack,
          opponents.map((seat) => seat.stack),
        ).effective;

  const streetIndex = STREET_ORDER.indexOf(view.street);
  const previousStreet = streetIndex > 0 ? STREET_ORDER[streetIndex - 1] : undefined;
  const actionsThisStreet = view.actions.filter((logged) => logged.street === view.street);
  const myActionsThisHand = view.actions.filter((logged) => logged.seat === input.seat);

  return {
    street: view.street,
    board: view.board,
    pot: view.potTotal,
    toCall: view.amountToCall,
    bigBlind,
    myStack: me.stack,
    myCommitted: me.committedThisStreet,
    opponents: Math.max(1, opponents.length),
    effectiveStackBehind: effective,
    effectiveStackBb: effective / bigBlind,
    relativePosition: relativePositionOf(view, input.seat, liveSeatNumbers),
    positionLabel: me.position,
    facingAggression: view.betLevel > me.committedThisStreet,
    facingRaise: actionsThisStreet.some(
      (logged) => logged.action.type === 'bet' || logged.action.type === 'raise',
    ),
    facingAction: facingActionFor(actionsThisStreet, view.street === 'preflop'),
    isPreflop: view.street === 'preflop',
    // The decision `vpip` is a frequency over. A seat that already entered is priced on equity later.
    // A big blind with nothing to call still counts, and there only a raise is an entry.
    isFirstVoluntaryPreflopDecision:
      view.street === 'preflop' && !myActionsThisHand.some((logged) => logged.action.type !== 'fold'),
    tookLeadPreviousStreet:
      previousStreet !== undefined &&
      myActionsThisHand.some(
        (logged) =>
          logged.street === previousStreet &&
          (logged.action.type === 'bet' || logged.action.type === 'raise'),
      ),
    primaryOpponent: primaryOpponentOf(input.seat, opponents, actionsThisStreet),
    legalActions,
  };
}

/**
 * Position among live seats in the POSTFLOP order, 0 first to act and 1 last, even preflop, because
 * acting last on the later streets is the advantage.
 */
function relativePositionOf(view: PlayerView, seat: SeatIndex, liveSeats: readonly SeatIndex[]): number {
  const order = orderFrom(view.buttonSeat, view.config.maxSeats, liveSeats);
  const index = order.indexOf(seat);
  if (index < 0 || order.length <= 1) return 1;
  return index / (order.length - 1);
}

/**
 * The action this seat is answering, in `opponent-model.ts` vocabulary. Preflop the big blind is
 * forced, so the first raise is an open and the second a three-bet. Postflop it is bet, then raise.
 */
function facingActionFor(
  actionsThisStreet: readonly PlayerView['actions'][number][],
  isPreflop: boolean,
): FacingActionLabel {
  const aggressive = actionsThisStreet.filter(
    (logged) => logged.action.type === 'bet' || logged.action.type === 'raise',
  ).length;
  if (aggressive === 0) {
    return actionsThisStreet.some((logged) => logged.action.type === 'check') ? 'check' : 'none';
  }
  if (isPreflop) return aggressive === 1 ? 'raise' : 'threeBet';
  if (aggressive === 1) return 'bet';
  return aggressive === 2 ? 'raise' : 'threeBet';
}

/**
 * The opponent the range and multipliers are taken against. The last bettor or raiser on this street,
 * else the live opponent with the most committed.
 */
function primaryOpponentOf(
  seat: SeatIndex,
  opponents: readonly PlayerView['seats'][number][],
  actionsThisStreet: readonly PlayerView['actions'][number][],
): SeatIndex {
  for (let index = actionsThisStreet.length - 1; index >= 0; index--) {
    const logged = actionsThisStreet[index];
    if (logged === undefined || logged.seat === seat) continue;
    if (logged.action.type !== 'bet' && logged.action.type !== 'raise') continue;
    if (opponents.some((candidate) => candidate.seat === logged.seat)) return logged.seat;
  }
  let best: SeatIndex | null = null;
  let bestCommitted = -1;
  for (const candidate of opponents) {
    if (candidate.committedThisStreet > bestCommitted) {
      bestCommitted = candidate.committedThisStreet;
      best = candidate.seat;
    }
  }
  if (best === null) {
    throw new PolicyError(`seat ${seat} was asked to decide with no live opponent in the view`);
  }
  return best;
}

/** Adaptation actually in force: the trait, switched off entirely at the easiest difficulty. */
function adaptationWeight(input: PolicyInput): number {
  if (!input.difficulty.adaptationEnabled) return 0;
  return clamp01(input.traits.exploitativeAdaptation);
}

/**
 * The assumed opponent continuing range, minus this seat's blockers, which the estimator cannot see.
 * Takes `adaptationWeight(input)` because a range built from watched play is adaptation. At 0, which
 * `educational` always passes, it is the neutral 25% entry range.
 */
function assumedOpponentRange(input: PolicyInput, situation: Situation): ParsedRange {
  const estimated = input.observations.rangeFor(
    situation.primaryOpponent,
    situation.street,
    situation.facingAction,
    adaptationWeight(input),
  );
  const labels = estimated.classes.map((handClass) => handClass.label);
  if (labels.length === 0) {
    throw new PolicyError('the opponent model returned an empty range, which cannot be played against');
  }
  return parseRange(labels.join(', '), [...input.holeCards, ...situation.board]);
}

function assessStrength(input: PolicyInput, situation: Situation): StrengthAssessment {
  if (situation.board.length === 0) {
    return assessPreflop(input.holeCards, situation.opponents, input.traits);
  }
  return assessPostflop({
    holeCards: input.holeCards,
    board: situation.board,
    opponentRange: assumedOpponentRange(input, situation),
    samples: input.difficulty.equitySamples,
    random: input.random,
  });
}

/**
 * Above this equity a fold facing a bet is an error, not a style, so the noise floor does not fund it.
 * Without the bar every profile folded the flop nut flush at the floor rate (up to 0.125 at
 * `educational`), and `foldToPressure` had no effect (spread 0.002 across twelve profiles).
 */
const FOLD_IS_AN_ERROR_ABOVE = 0.9;

interface Candidate {
  readonly legal: LegalAction;
  readonly action: Action;
  /** False for a free fold, or a fold facing a bet with the hand won. See `FOLD_IS_AN_ERROR_ABOVE`. */
  readonly plausible: boolean;
  readonly isAggressive: boolean;
  readonly isPassiveContinue: boolean;
}

function planCandidates(
  input: PolicyInput,
  situation: Situation,
  strength: StrengthAssessment,
  adjustments: ObservedAdjustments,
): Candidate[] {
  const out: Candidate[] = [];
  for (const legal of situation.legalActions) {
    switch (legal.type) {
      case 'fold':
        out.push({
          legal,
          action: { type: 'fold' },
          plausible: situation.toCall > 0 && strength.equity < FOLD_IS_AN_ERROR_ABOVE,
          isAggressive: false,
          isPassiveContinue: false,
        });
        break;
      case 'check':
        out.push({
          legal,
          action: { type: 'check' },
          plausible: true,
          isAggressive: false,
          isPassiveContinue: true,
        });
        break;
      case 'call':
        out.push({
          legal,
          action: { type: 'call' },
          plausible: true,
          isAggressive: false,
          isPassiveContinue: true,
        });
        break;
      case 'bet':
      case 'raise': {
        const to = chooseSizeTo(legal, input, situation, strength, adjustments);
        out.push({
          legal,
          action: legal.type === 'bet' ? { type: 'bet', to } : { type: 'raise', to },
          plausible: true,
          isAggressive: true,
          isPassiveContinue: false,
        });
        break;
      }
      default:
        throw new PolicyError(`the engine offered an action type this policy cannot score: ${legal.type}`);
    }
  }
  return out;
}

/**
 * The bet or raise size as a "raise to" total, clamped into the engine's bounds. The jitter is drawn
 * for every bet or raise candidate, sampled or not, so a seeded replay reproduces exactly.
 */
function chooseSizeTo(
  legal: LegalAction,
  input: PolicyInput,
  situation: Situation,
  strength: StrengthAssessment,
  adjustments: ObservedAdjustments,
): number {
  const minTo = legal.minTo;
  const maxTo = legal.maxTo;
  if (minTo === undefined || maxTo === undefined) {
    throw new PolicyError(`the engine offered a ${legal.type} with no minTo/maxTo bounds to clamp to`);
  }
  const traits = input.traits;
  const variance = clamp01(traits.sizingVariance);

  // A symmetric jitter of at most +-25% at full variance.
  const draw = input.random.nextInt(SAMPLE_RESOLUTION) / SAMPLE_RESOLUTION;
  const jitter = (draw - 0.5) * 0.5 * variance;

  const fraction =
    preferredPotFraction(traits) *
    (1 + SIZE_PRESSURE_SPAN * (traits.pressureTendency - 0.5)) *
    (1 + 0.5 * (strength.relativeStrength - 0.5) * variance) *
    (1 + jitter) *
    adjustments.sizeUp;

  // The size is what this seat ADDS as a fraction of the pot, which is what `preferredPotFraction`
  // declares and `stats.ts` measures. Adding the call on top read 0.2 to 0.3 above every card.
  const target = situation.myCommitted + Math.max(0, fraction) * situation.pot;

  // Leaving a token amount behind gives a free shot with no fold equity, so commit instead.
  const shoveAt =
    maxTo * (SHOVE_THRESHOLD / stackDepthCommitmentMultiplier(traits, situation.effectiveStackBb));
  const chosen = target >= shoveAt ? maxTo : target;
  return Math.min(maxTo, Math.max(minTo, Math.round(chosen)));
}

interface Influence {
  readonly key: TraitKey;
  /** Signed size of this trait's effect on the weight. The sign says which way it pushed. */
  readonly effect: number;
}

interface Scored {
  readonly candidate: Candidate;
  readonly weight: number;
  readonly rationale: string;
  readonly influences: readonly Influence[];
}

interface ScoreContext {
  readonly input: PolicyInput;
  readonly situation: Situation;
  readonly strength: StrengthAssessment;
  readonly adjustments: ObservedAdjustments;
  readonly breakEvenEquity: number;
  readonly continueAppetite: number;
  readonly foldEquity: number;
  readonly positionFactor: number;
  readonly depthFactor: number;
  /** The floored passive weight, filled in by the second pass of `scoreCandidates`. */
  readonly passiveReference: number;
  /** Present only on a first voluntary preflop decision. */
  readonly entry: EntryPlan | null;
}

/** The preflop entry decision. `enteringMass` is a final probability, not a score. */
interface EntryPlan {
  readonly percentile: number;
  readonly effectiveVpip: number;
  /** Probability of putting money in voluntarily. Equals the declared frequency by design. */
  readonly enteringMass: number;
  /** Share of entries that are a raise, after the within-group noise mixture. */
  readonly raiseShare: number;
  /** The pre-mixture share that produces `raiseShare` once the mixture is applied. */
  readonly preNoiseRaiseShare: number;
  /** True when nothing is owed, so checking is free and only a raise counts as entering. */
  readonly raiseOnlyEnters: boolean;
  /** True when the raise-share compensation had to clamp, which the reasoning then says. */
  readonly clamped: boolean;
}

function buildContext(
  input: PolicyInput,
  situation: Situation,
  strength: StrengthAssessment,
  adjustments: ObservedAdjustments,
): ScoreContext {
  const price = potOdds(situation.pot, situation.toCall);
  return {
    input,
    situation,
    strength,
    adjustments,
    breakEvenEquity: price.breakEvenEquity,
    continueAppetite: logistic((strength.equity - price.breakEvenEquity) * PRICE_SENSITIVITY),
    foldEquity: Math.min(
      MAX_FOLD_EQUITY,
      Math.max(MIN_FOLD_EQUITY, BASE_FOLD_PER_OPPONENT ** situation.opponents),
    ),
    positionFactor: positionalVpipMultiplier(input.traits, situation.relativePosition),
    depthFactor: stackDepthCommitmentMultiplier(input.traits, situation.effectiveStackBb),
    passiveReference: MIN_PASSIVE_REFERENCE,
    entry: null,
  };
}

/** `a/(1-a)`, bounded. See `MIN_AGGRESSION_ODDS` for why the odds are clamped, not the trait. */
function aggressionOdds(aggressionFrequency: number): number {
  const value = clamp01(aggressionFrequency);
  if (value >= 1) return MAX_AGGRESSION_ODDS;
  return Math.min(MAX_AGGRESSION_ODDS, Math.max(MIN_AGGRESSION_ODDS, value / (1 - value)));
}

/**
 * The preflop entry plan. `stackDepthCommitmentMultiplier` stays out because it only widens, which
 * would bias entry above the card below 40bb. The price factor only tightens, and its effect is small.
 */
function planEntry(context: ScoreContext, candidates: readonly Candidate[]): EntryPlan {
  const { input, situation } = context;
  const traits = input.traits;
  const percentile = preflopClassPercentile(input.holeCards).percentileAmongAllHands;
  const priceFactor =
    1 - ENTRY_PRICE_SPAN * clamp01(situation.toCall / Math.max(1, situation.toCall + situation.myStack));
  const effectiveVpip = Math.min(0.98, Math.max(0.01, traits.vpip * context.positionFactor * priceFactor));
  const targetEntry = logistic((percentile - (1 - effectiveVpip)) / ENTRY_SOFTNESS);

  // With nothing owed, only a raise is a voluntary entry, which is what `vpip` declares.
  const raiseOnlyEnters = situation.toCall === 0;
  const raiseShare = clamp01(
    (situation.facingRaise ? threeBetRaiseShare(traits) : clamp01(traits.pfrShareOfVpip)) *
      context.adjustments.isolateMore,
  );
  const noise = clamp01(input.difficulty.noise);
  const rawPreNoise = noise >= 1 ? raiseShare : (raiseShare - noise / 2) / (1 - noise);
  const preNoiseRaiseShare = clamp01(rawPreNoise);

  const entering = candidates.filter(
    (candidate) => candidate.plausible && (raiseOnlyEnters ? candidate.isAggressive : !isFold(candidate)),
  );
  // With nothing owed the entering mass is `vpip x pfrShareOfVpip` and the rest checks the option.
  // Putting the whole threshold behind the raise lifted the most raise-happy profile's PFR 0.051 over
  // its card against a 0.05 tolerance. VPIP has the slack to absorb the dip, and PFR does not.
  const enteringMass = entering.length === 0 ? 0 : raiseOnlyEnters ? targetEntry * raiseShare : targetEntry;

  return {
    percentile,
    effectiveVpip,
    enteringMass,
    raiseShare,
    preNoiseRaiseShare,
    raiseOnlyEnters,
    clamped: Math.abs(rawPreNoise - preNoiseRaiseShare) > 1e-12,
  };
}

/**
 * Scores every candidate in two passes. The passive line goes first because the aggressive weight is a
 * multiple of it. A constant aggressive baseline measured 0.2 short of every declared value.
 */
function scoreCandidates(context: ScoreContext, candidates: readonly Candidate[]): Scored[] {
  const scored = new Map<Candidate, Scored>();
  for (const candidate of candidates) {
    if (!candidate.plausible) scored.set(candidate, scoreDominatedFold(candidate));
    else if (context.entry !== null) scored.set(candidate, scoreEntry(context, context.entry, candidate));
    else if (isFold(candidate)) scored.set(candidate, scoreFold(context, candidate));
    else if (!candidate.isAggressive) scored.set(candidate, scorePassiveContinue(context, candidate));
  }

  let passive = 0;
  for (const candidate of candidates) {
    if (!candidate.isPassiveContinue) continue;
    passive += scored.get(candidate)?.weight ?? 0;
  }
  const withReference: ScoreContext = {
    ...context,
    passiveReference: Math.max(MIN_PASSIVE_REFERENCE, passive),
  };

  return candidates.map((candidate) => {
    const already = scored.get(candidate);
    if (already !== undefined) return already;
    return scoreAggression(withReference, candidate);
  });
}

function scoreDominatedFold(candidate: Candidate): Scored {
  return {
    candidate,
    weight: 0,
    rationale:
      'This model gives folding no weight here because checking is free: the engine offers the fold, ' +
      'and giving up a hand that costs nothing to keep can only lose whatever equity it has. It is ' +
      'listed at zero rather than hidden so the whole legal set stays visible.',
    influences: [],
  };
}

/** True when taking this action is what a tracker counts as voluntarily entering the pot. */
function entersPot(candidate: Candidate, entry: EntryPlan): boolean {
  if (!candidate.plausible) return false;
  if (candidate.action.type === 'fold' || candidate.action.type === 'check') return false;
  return entry.raiseOnlyEnters ? candidate.isAggressive : true;
}

/**
 * The first voluntary preflop decision. The declared entry frequency is the split between entering and
 * not, and `pfrShareOfVpip` splits what enters. `entryProbabilities` applies the noise.
 */
function scoreEntry(context: ScoreContext, entry: EntryPlan, candidate: Candidate): Scored {
  const traits = context.input.traits;
  const percentileText = `${pct(entry.percentile)} of hands`;
  const thresholdText = `the top ${pct(entry.effectiveVpip)} of hands`;

  if (!entersPot(candidate, entry)) {
    return {
      candidate,
      weight: 1 - entry.enteringMass,
      rationale:
        `This model plays ${thresholdText} from this seat at this price, and this holding beats ` +
        `${percentileText}, so the entry threshold leaves ${pct(1 - entry.enteringMass)} of the weight on ` +
        `${entry.raiseOnlyEnters ? 'checking the option, which puts nothing in voluntarily' : 'folding'}. ` +
        'The threshold is applied through a curve rather than a hard cut, so hands either side of it are ' +
        'sometimes played and sometimes not.',
      influences: [
        { key: 'vpip', effect: -(1 - entry.enteringMass) },
        { key: 'positionSensitivity', effect: context.positionFactor - 1 },
      ],
    };
  }

  const weight =
    entry.enteringMass * (candidate.isAggressive ? entry.preNoiseRaiseShare : 1 - entry.preNoiseRaiseShare);

  return {
    candidate,
    weight,
    rationale: candidate.isAggressive
      ? `This model raises ${pct(traits.pfrShareOfVpip)} of the hands it enters` +
        `${
          context.situation.facingRaise
            ? `, adjusted by a re-raise tendency of ${num(traits.threeBetTendency)}`
            : ''
        }, and this holding beats ${percentileText} against an entry threshold of ${thresholdText}.`
      : `This model takes the passive route with ${pct(1 - traits.pfrShareOfVpip)} of the hands it ` +
        `enters, and this holding beats ${percentileText} against an entry threshold of ${thresholdText}.`,
    influences: candidate.isAggressive
      ? [
          { key: 'pfrShareOfVpip', effect: entry.raiseShare },
          { key: 'vpip', effect: entry.enteringMass },
          {
            key: 'threeBetTendency',
            effect: context.situation.facingRaise ? traits.threeBetTendency : 0,
          },
        ]
      : [
          { key: 'pfrShareOfVpip', effect: -(1 - entry.raiseShare) },
          { key: 'vpip', effect: entry.enteringMass },
        ],
  };
}

function scoreFold(context: ScoreContext, candidate: Candidate): Scored {
  const { situation, strength, input } = context;
  const traits = input.traits;
  const commitmentShare = clamp01(situation.toCall / Math.max(1, situation.toCall + situation.myStack));
  const priceSteepness = clamp01(situation.toCall / Math.max(situation.bigBlind, situation.pot) / 2);
  const survival = 1 + FOLD_SURVIVAL_SPAN * traits.tournamentOrientation * commitmentShare;
  const risk = RISK_BASE + RISK_SPAN * traits.riskTolerance;
  const weight =
    ((1 - context.continueAppetite) *
      (FOLD_BASE + FOLD_TRAIT_SPAN * traits.foldToPressure) *
      (1 + FOLD_PRICE_SPAN * priceSteepness) *
      survival *
      context.adjustments.foldMore) /
    risk;

  return {
    candidate,
    weight,
    rationale:
      `Calling ${num(situation.toCall)} into ${num(situation.pot)} breaks even at ` +
      `${pct(context.breakEvenEquity)} equity and this model assesses its own hand at ` +
      `${pct(strength.equity)}, so the price ` +
      `${strength.equity >= context.breakEvenEquity ? 'is met and folding is a minority line' : 'is not met'}. ` +
      `Its fold-to-pressure setting of ${num(traits.foldToPressure)} and risk appetite of ` +
      `${num(traits.riskTolerance)} decide how much of the remaining weight folding takes.`,
    influences: [
      { key: 'foldToPressure', effect: (1 - context.continueAppetite) * traits.foldToPressure },
      { key: 'riskTolerance', effect: -(1 - context.continueAppetite) * traits.riskTolerance },
      { key: 'tournamentOrientation', effect: survival - 1 },
      { key: 'exploitativeAdaptation', effect: context.adjustments.foldMore - 1 },
    ],
  };
}

function scorePassiveContinue(context: ScoreContext, candidate: Candidate): Scored {
  const { situation, strength, input } = context;
  const traits = input.traits;
  if (situation.toCall === 0) return scoreCheck(context, candidate);

  const spr = stackToPotRatio(situation.effectiveStackBehind, Math.max(1, situation.pot)).spr;
  const drawRoom = clamp01(spr / 6);
  const weight =
    context.continueAppetite *
    (CALL_BASE + CALL_PASSIVE_SPAN * (1 - traits.pfrShareOfVpip)) *
    (1 + (strength.isDraw ? CALL_DRAW_SPAN * drawRoom : 0)) *
    (1 + CALL_PASSIVITY_SPAN * (1 - traits.aggressionFrequency));
  const callEv = evOfCall({ pot: situation.pot, toCall: situation.toCall, equity: strength.equity }).ev;

  return {
    candidate,
    weight,
    rationale:
      `At ${pct(strength.equity)} assessed equity against a break-even of ${pct(context.breakEvenEquity)}, ` +
      `calling ${num(situation.toCall)} is worth ${signed(callEv)} units on this model's own assessment. ` +
      (strength.isDraw
        ? `The hand is still drawing with ${num(strength.outs)} cards that would improve its category, and ` +
          `there are ${num(spr)} pots behind to be paid from if one arrives. `
        : '') +
      `A style that raises ${pct(traits.pfrShareOfVpip)} of what it plays leaves the rest of its ` +
      'continuing weight on the passive line.',
    influences: [
      { key: 'pfrShareOfVpip', effect: -(1 - traits.pfrShareOfVpip) },
      { key: 'aggressionFrequency', effect: -(1 - traits.aggressionFrequency) * CALL_PASSIVITY_SPAN },
      { key: 'riskTolerance', effect: strength.isDraw ? drawRoom * CALL_DRAW_SPAN : 0 },
    ],
  };
}

function scoreCheck(context: ScoreContext, candidate: Candidate): Scored {
  const traits = context.input.traits;
  const strength = context.strength;
  const weight =
    CHECK_BASE * (1 - CHECK_AGG_SPAN * traits.aggressionFrequency) +
    CHECK_WEAK_SPAN * (1 - strength.relativeStrength) * (1 - traits.bluffFrequency) +
    CHECK_TRAP_SPAN * strength.relativeStrength * (1 - traits.aggressionFrequency);

  return {
    candidate,
    weight,
    rationale:
      `Checking costs nothing and keeps the pot at ${num(context.situation.pot)}. This model bets or ` +
      `raises ${pct(traits.aggressionFrequency)} of the time when aggression is available, and it ` +
      `currently beats ${pct(strength.relativeStrength)} of the range it assumes it is against, so the ` +
      'passive line takes the weight its aggression setting leaves behind.',
    influences: [
      { key: 'aggressionFrequency', effect: -traits.aggressionFrequency * CHECK_AGG_SPAN },
      { key: 'bluffFrequency', effect: -(1 - strength.relativeStrength) * traits.bluffFrequency },
    ],
  };
}

function scoreAggression(context: ScoreContext, candidate: Candidate): Scored {
  const { situation, strength, input, adjustments } = context;
  const traits = input.traits;
  const to = 'to' in candidate.action ? candidate.action.to : 0;
  const betSize = Math.max(1, to - situation.myCommitted);

  // Both multipliers arrive scaled by adaptation and reliability, so a thin sample changes nothing.
  const valueEdge = clamp01(VALUE_EDGE / Math.max(0.5, adjustments.valueBetThinner));
  const valueness = clamp01((strength.relativeStrength - valueEdge) / Math.max(0.05, 1 - valueEdge));
  const airness = clamp01((BLUFF_CEILING - strength.relativeStrength) / BLUFF_CEILING);
  const aggression = aggressionOdds(traits.aggressionFrequency);

  // `aggressionFrequency` anchors a neutral hand and `bluffFrequency` anchors air. The air anchor is
  // the RATIO of the two odds. Adding a term instead measured bluffs up to 0.28 above every card.
  const bluffAnchor =
    (aggressionOdds(clamp01(traits.bluffFrequency * adjustments.bluffMore)) / aggression) *
    (1 - BLUFF_FOLD_EQUITY_SPAN + BLUFF_FOLD_EQUITY_SPAN * (context.foldEquity / BASE_FOLD_PER_OPPONENT)) *
    (1.5 - traits.valueBluffBalance);
  const valueAnchor = 1 + valueness * (0.5 + traits.valueBluffBalance);
  const semiBluffTerm = strength.isDraw
    ? SEMI_BLUFF_SPAN * (0.4 + traits.bluffFrequency) * context.foldEquity
    : 0;
  const handFactor = airness * bluffAnchor + (1 - airness) * valueAnchor + semiBluffTerm;
  const barrelFactor = situation.tookLeadPreviousStreet ? 0.5 + traits.barrelPersistence : 1;
  // Wider than the `planEntry` swing because this scores a later preflop re-raise against folding.
  // Postflop the slot belongs to `pressureTendency`, since `threeBetTendency` is preflop only.
  const reRaiseFactor = situation.facingRaise
    ? situation.isPreflop
      ? 0.5 + traits.threeBetTendency
      : 0.6 + 0.8 * traits.pressureTendency
    : 1;

  // On a neutral hand the aggressive weight is the passive weight times the trait's odds a/(1-a), so
  // normalisation makes the realised rate the trait. Every later factor deviates from neutral. Over
  // 8,000 hands per profile the neutral-band rate has mean signed error -0.004. The unconditional
  // rate is lower by design, because about 60% of aggression spots are air and air bets at
  // `bluffFrequency`. `stats.ts` measures the conditional rate.
  const weight =
    context.passiveReference *
    aggression *
    handFactor *
    context.positionFactor *
    context.depthFactor *
    (AGG_PRESSURE_BASE + AGG_PRESSURE_SPAN * traits.pressureTendency) *
    barrelFactor *
    reRaiseFactor;

  const price = priceLaidByBet(situation.pot, betSize);
  const needed = requiredFoldEquity({
    pot: situation.pot,
    betSize,
    equityWhenCalled: strength.equity,
  }).foldEquityNeeded;

  return {
    candidate,
    weight,
    rationale:
      `A ${candidate.legal.type} to ${num(to)} risks ${num(betSize)} into ${num(situation.pot)}, laying a ` +
      `caller ${pct(price.breakEvenEquity)} and needing folds ${pct(needed)} of the time to break even ` +
      `against an assumed fold frequency of ${pct(context.foldEquity)} across ` +
      `${num(situation.opponents)} opponent${situation.opponents === 1 ? '' : 's'}. ` +
      (valueness > airness
        ? `It beats ${pct(strength.relativeStrength)} of the range it assumes it is against, so the weight ` +
          'here is value. '
        : `It beats only ${pct(strength.relativeStrength)} of that range, so the weight here comes from ` +
          'fold equity rather than from showdown value. ') +
      `Aggression ${num(traits.aggressionFrequency)}, bet size ${num(traits.betSizingPreference)} and ` +
      `pressure ${num(traits.pressureTendency)} set the rest.`,
    influences: [
      { key: 'aggressionFrequency', effect: aggression },
      { key: 'bluffFrequency', effect: airness * bluffAnchor + semiBluffTerm },
      { key: 'valueBluffBalance', effect: valueness * (0.5 + traits.valueBluffBalance) },
      { key: 'pressureTendency', effect: AGG_PRESSURE_SPAN * traits.pressureTendency },
      { key: 'positionSensitivity', effect: context.positionFactor - 1 },
      { key: 'stackDepthAdjustment', effect: context.depthFactor - 1 },
      { key: 'barrelPersistence', effect: barrelFactor - 1 },
      {
        key: 'exploitativeAdaptation',
        effect: adjustments.bluffMore - 1 + (adjustments.valueBetThinner - 1),
      },
    ],
  };
}

interface Distributed {
  readonly scored: Scored;
  readonly probability: number;
}

/**
 * The noise floor on a preflop entry decision, applied WITHIN each group. Mixing across the entry put
 * a floor of noise x 2/3 under hands below the threshold and inflated every profile's VPIP by 0.05 to
 * 0.06. Each plausible action still gets `groupMass x noise / groupSize`.
 */
function entryProbabilities(entry: EntryPlan, scored: readonly Scored[], noise: number): Distributed[] {
  const entering = scored.filter((item) => entersPot(item.candidate, entry));
  const others = scored.filter((item) => item.candidate.plausible && !entersPot(item.candidate, entry));
  const mass = entering.length === 0 ? 0 : entry.enteringMass;
  const mix = clamp01(noise);
  const withinEntering = entering.length === 0 ? 0 : 1 / entering.length;
  const aggressive = entering.filter((item) => item.candidate.isAggressive).length;
  const passive = entering.length - aggressive;

  return scored.map((item) => {
    if (!item.candidate.plausible) return { scored: item, probability: 0 };
    if (!entersPot(item.candidate, entry)) {
      return { scored: item, probability: others.length === 0 ? 0 : (1 - mass) / others.length };
    }
    // With one kind of entering action legal, it takes the whole entering mass.
    const share =
      aggressive === 0 || passive === 0
        ? withinEntering
        : item.candidate.isAggressive
          ? entry.preNoiseRaiseShare / aggressive
          : (1 - entry.preNoiseRaiseShare) / passive;
    return { scored: item, probability: mass * ((1 - mix) * share + mix * withinEntering) };
  });
}

/**
 * Mixes the normalised scores with the uniform distribution over plausible actions, so each sits above
 * `noise / plausibleCount`. A dominated action stays at exactly 0.
 */
function distribute(scored: readonly Scored[], noise: number): Distributed[] {
  const plausible = scored.filter((entry) => entry.candidate.plausible);
  if (plausible.length === 0) {
    throw new PolicyError('every legal action was marked implausible, which cannot happen');
  }
  const total = plausible.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  const mix = clamp01(noise);
  const uniform = 1 / plausible.length;

  return scored.map((entry) => {
    if (!entry.candidate.plausible) return { scored: entry, probability: 0 };
    // All scores zero means nothing to prefer, so the uniform part is the whole answer.
    const share = total === 0 ? uniform : Math.max(0, entry.weight) / total;
    return { scored: entry, probability: (1 - mix) * share + mix * uniform };
  });
}

function sampleFrom(distributed: readonly Distributed[], random: RandomSource): Distributed {
  const draw = random.nextInt(SAMPLE_RESOLUTION) / SAMPLE_RESOLUTION;
  let cumulative = 0;
  for (const entry of distributed) {
    cumulative += entry.probability;
    if (draw < cumulative) return entry;
  }
  // Floating-point drift can leave the last sliver unreachable, so fall back to the last live action.
  for (let index = distributed.length - 1; index >= 0; index--) {
    const entry = distributed[index];
    if (entry !== undefined && entry.probability > 0) return entry;
  }
  throw new PolicyError('the distribution carried no action with positive probability');
}

function drivingTraitsFor(scored: Scored, traits: Traits): DrivingTrait[] {
  const totals = new Map<TraitKey, number>();
  for (const influence of scored.influences) {
    if (influence.effect === 0) continue;
    totals.set(influence.key, (totals.get(influence.key) ?? 0) + influence.effect);
  }
  const ranked = [...totals.entries()]
    .sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))
    .slice(0, 3)
    .map(([key]) => ({ key, label: TRAIT_LABELS[key], value: traits[key] }));
  // A decision always has something driving it; an empty list would render as a blank panel.
  if (ranked.length === 0) {
    return [
      {
        key: 'aggressionFrequency',
        label: TRAIT_LABELS.aggressionFrequency,
        value: traits.aggressionFrequency,
      },
    ];
  }
  return ranked;
}

/** The position counterfactual: what the worst and best seat would have done instead. */
function positionCounterfactual(context: ScoreContext): string {
  const traits = context.input.traits;
  const worst = positionalVpipMultiplier(traits, 0);
  const best = positionalVpipMultiplier(traits, 1);
  const entry = context.entry;
  if (entry !== null) {
    const base = entry.effectiveVpip / context.positionFactor;
    return (
      'Position: acting first on later streets rather than from this seat would move the entry ' +
      `threshold from the top ${pct(entry.effectiveVpip)} of hands to the top ` +
      `${pct(Math.min(0.98, base * worst))}, and acting last would move it to the top ` +
      `${pct(Math.min(0.98, base * best))}. This holding beats ${pct(entry.percentile)} of hands.`
    );
  }
  return (
    `Position: its positional multiplier on the aggressive line is ${num(context.positionFactor)} from ` +
    `this seat, against ${num(worst)} first to act and ${num(best)} last to act, on a ` +
    `position-sensitivity setting of ${num(traits.positionSensitivity)}.`
  );
}

/** The price counterfactual: the same hand at half the price, or facing one. */
function priceCounterfactual(context: ScoreContext): string {
  const { situation, strength } = context;
  if (situation.toCall > 0) {
    const halved = potOdds(situation.pot, Math.max(1, Math.round(situation.toCall / 2)));
    return (
      `Price: this call needs ${pct(context.breakEvenEquity)} equity and the assessment is ` +
      `${pct(strength.equity)}. At half the price it would need ${pct(halved.breakEvenEquity)}, which ` +
      `the same assessment ${strength.equity >= halved.breakEvenEquity ? 'clears' : 'still does not clear'}.`
    );
  }
  const facing = Math.max(1, Math.round(situation.pot / 2));
  const price = priceLaidByBet(situation.pot, facing);
  return (
    `Price: nothing is owed, so continuing is free. Facing a half-pot bet of ${num(facing)} it would ` +
    `need ${pct(price.breakEvenEquity)} equity against an assessment of ${pct(strength.equity)}.`
  );
}

/** The opponent-read counterfactual, including the honest "no sample yet" case. */
function readCounterfactual(context: ScoreContext): string {
  const { input, situation, adjustments } = context;
  const read = input.observations.statsFor(situation.primaryOpponent);
  const adaptation = adaptationWeight(input);
  if (read === null || adaptation === 0) {
    return (
      'Opponent read: nothing this model is willing to act on yet, so every multiplier from the ' +
      `observation model stays at 1 and the unread assumption of ${pct(BASE_FOLD_PER_OPPONENT)} per ` +
      'opponent folding stands. A small sample is treated as no read rather than a weak one.' +
      (adaptation === 0 ? ' Adaptation is switched off at this difficulty in any case.' : '')
    );
  }
  return (
    `Opponent read: over ${num(read.handsSeen)} observed hands seat ${num(read.seat)} has folded to ` +
    `${pct(read.foldToBetFrequency)} of bets and entered ${pct(read.vpip)} of pots, at a ` +
    `${read.reliability} sample with a half-width of ${pct(read.confidenceHalfWidth)}. Scaled by an ` +
    `adaptation setting of ${num(input.traits.exploitativeAdaptation)} that becomes a bluff multiplier ` +
    `of ${num(adjustments.bluffMore)}, a thin-value multiplier of ${num(adjustments.valueBetThinner)} ` +
    `and a fold multiplier of ${num(adjustments.foldMore)}.`
  );
}

/** Counterfactuals name a concrete alternative and compute what it would have done. */
function whatChangedItFor(context: ScoreContext, chosen: Scored): string[] {
  const { input, situation } = context;
  const traits = input.traits;
  const out: string[] = [positionCounterfactual(context)];

  const reference = situation.effectiveStackBb > 40 ? SHORT_STACK_REFERENCE_BB : DEEP_STACK_REFERENCE_BB;
  out.push(
    `Stack depth: at ${num(situation.effectiveStackBb)} big blinds effective its commitment multiplier ` +
      `is ${num(context.depthFactor)}; at ${num(reference)} big blinds it would be ` +
      `${num(stackDepthCommitmentMultiplier(traits, reference))}, on a stack-depth setting of ` +
      `${num(traits.stackDepthAdjustment)}.`,
  );
  out.push(priceCounterfactual(context));
  out.push(readCounterfactual(context));

  if (context.entry?.clamped === true) {
    out.push(
      `Difficulty: at a noise setting of ${num(input.difficulty.noise)} the floor inside the entering ` +
        `actions is wider than the gap between this profile's raising share of ` +
        `${pct(context.entry.raiseShare)} and an even split, so the realised split here lands closer to ` +
        'even than the card says. The entry frequency itself is unaffected.',
    );
  }

  if (chosen.candidate.isAggressive) {
    out.push(
      `Sizing: its bet-size preference of ${num(traits.betSizingPreference)} maps to ` +
        `${num(preferredPotFraction(traits))} of the pot before adjustment, and a sizing-variance ` +
        `setting of ${num(traits.sizingVariance)} decides how far a given bet moves off that.`,
    );
  }

  return out;
}

function modelPreferenceFor(context: ScoreContext, chosen: Distributed): string {
  const action = chosen.scored.candidate.action;
  const strength = context.strength;
  const described =
    action.type === 'bet' || action.type === 'raise' ? `${action.type} to ${num(action.to)}` : action.type;
  const method =
    strength.method === 'monte-carlo'
      ? `${num(strength.samples)} sampled run-outs`
      : `the computed 169-class table at ${num(strength.samples)} samples per class`;
  return (
    `This model prefers to ${described} here, with ${pct(chosen.probability)} of its weight on that ` +
    `action: it assesses ${pct(strength.equity)} equity from ${method}, the price asks ` +
    `${pct(context.breakEvenEquity)}, and it beats ${pct(strength.relativeStrength)} of the range it ` +
    'assumes it is against. The rest of the weight sits on the other actions listed, which is what ' +
    'makes this a style rather than a script.'
  );
}

/**
 * Turns one situation into one action plus its explanation. Deterministic in (input, random stream).
 * Draws happen in a fixed order (equity seed, one jitter per bet or raise candidate, the sample), so a
 * replay cannot drift.
 */
export function decide(input: PolicyInput): PolicyDecision {
  const situation = readSituation(input);
  const adjustments = input.observations.adjustmentsFor(situation.primaryOpponent, adaptationWeight(input));
  const strength = assessStrength(input, situation);
  const candidates = planCandidates(input, situation, strength, adjustments);

  const base = buildContext(input, situation, strength, adjustments);
  const context: ScoreContext = situation.isFirstVoluntaryPreflopDecision
    ? { ...base, entry: planEntry(base, candidates) }
    : base;

  const scored = scoreCandidates(context, candidates);
  const distributed =
    context.entry === null
      ? distribute(scored, input.difficulty.noise)
      : entryProbabilities(context.entry, scored, input.difficulty.noise);
  const chosen = sampleFrom(distributed, input.random);

  const distribution: WeightedAction[] = distributed.map((entry) => ({
    action: entry.scored.candidate.action,
    weight: Math.max(0, entry.scored.weight),
    probability: entry.probability,
    rationale: entry.scored.rationale,
  }));

  const whatChangedIt = whatChangedItFor(context, chosen.scored);
  const modelPreference = modelPreferenceFor(context, chosen);

  // Checked at generation time, so a generator that emits a bad string fails here.
  for (const [index, entry] of distribution.entries()) {
    assertNoImpersonation(entry.rationale, `policy rationale for ${entry.action.type} (${index})`);
  }
  for (const [index, note] of whatChangedIt.entries()) {
    assertNoImpersonation(note, `policy whatChangedIt[${index}]`);
  }
  assertNoImpersonation(modelPreference, 'policy modelPreference');

  return {
    action: chosen.scored.candidate.action,
    distribution,
    strength,
    drivingTraits: drivingTraitsFor(chosen.scored, input.traits),
    whatChangedIt,
    modelPreference,
  };
}

function isFold(candidate: Candidate): boolean {
  return candidate.action.type === 'fold';
}

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/** A plain number, without inventing precision that was never supplied. */
function num(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function signed(value: number): string {
  return value >= 0 ? `+${num(value)}` : num(value);
}
