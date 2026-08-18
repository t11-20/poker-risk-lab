/**
 * The decision engine: one situation in, a probability distribution over the engine's own
 * legal actions out, and one action sampled from it.
 *
 * Read `traits.ts` first for what the sixteen axes mean, `hand-strength.ts` for how a hand is
 * assessed inside a live hand, `opponent-model.ts` for where the reads come from, and
 * `docs/AI-LEGENDS.md` §5-§7 for the pipeline this implements.
 *
 * ## What a policy may see, and why that is a type rather than a rule
 *
 * `PolicyInput` takes a `PlayerView` — the already-redacted view from `redactFor` — plus this
 * seat's own two cards. It deliberately does NOT take `HandState`. There is therefore no
 * `deck`, no `deckCursor`, no `deckSalts` and no other seat's `holeCards` to read: not absent
 * by convention, unrepresentable. This is ADR 0003's fails-open/fails-closed argument applied
 * one layer out. Handing a policy the whole state and trusting it not to look fails open —
 * correct today, one autocomplete away from cheating, and the change that breaks it gets made
 * by somebody with no reason to be thinking about redaction.
 *
 * Two further habits keep the boundary observable rather than merely true:
 *
 *   1. **The view is read in exactly one place.** `readSituation` pulls out every field the
 *      scoring needs and nothing else. Everything downstream works from that flat struct, so
 *      the complete list of what a decision depends on is one function long.
 *   2. **No hole-card field of the view is ever read** — not even this seat's own, which is
 *      legitimately visible there. The seat's cards arrive through `input.holeCards`, so
 *      `test/no-hidden-information.test.ts` can assert the much stronger property that no path
 *      ending in `holeCards` appears in the recorded read set at all. `input.seat` is
 *      cross-checked against `view.viewerSeat` for the same reason: an input assembled from
 *      the wrong seat's view is a bug that should fail loudly rather than play someone else's
 *      cards.
 *
 * ## The engine decides legality; this only proposes
 *
 * Candidates come from `input.view.legalActions` and nowhere else. No code path here can
 * construct an action type the engine did not offer — including the case after a short all-in,
 * where `mayRaise` is false and raising genuinely is not available. Every size is clamped into
 * the `minTo`/`maxTo` of the specific legal action it belongs to and rounded to an integer,
 * because `validateAction` rejects a fractional bet. The engine then re-derives the legal set
 * and re-validates, so a bug here produces a rejected action and an error rather than an
 * illegal game (ADR 0002).
 *
 * ## Probabilistic, not scripted
 *
 * Scores become a distribution and one action is drawn from it with the injected
 * `RandomSource`. The distribution is part of the output, not an implementation detail: a
 * learner should be able to see that the spot had three defensible actions and that the one
 * they watched was sampled from that (ADR 0012).
 *
 * ## Noise, and the one place it is compensated for
 *
 * `difficulty.noise` is applied by mixing the normalised scores with the uniform distribution
 * over the actions the model considers plausible:
 *
 *     p_final(a) = (1 - noise) x p_score(a) + noise / plausibleCount
 *
 * so every plausible action ends up with at least `noise / plausibleCount` probability. Two
 * decisions in that sentence are load-bearing.
 *
 * **"Plausible" excludes exactly one thing: a fold when checking is free.** The engine offers
 * that fold, and `legalActions` says of it "Legal, but checking costs nothing". It is
 * dominated by checking in every situation at every difficulty, and a noise floor exists to
 * keep a style unpredictable, not to make it play worse than any style plays. It stays in the
 * returned distribution at probability 0, so a learner can see it was available and was never
 * chosen, rather than watching a model fold for free one time in twenty.
 *
 * **On a preflop entry decision the mixture runs inside each group, not across the entry.**
 * This is the correction the statistical suite forced, and it is worth stating precisely
 * because the obvious implementation is wrong in a way that only a measurement catches. Mixing
 * across all three legal actions gives an entry probability of
 * `(1 - noise) x target + noise x 2/3`; on the hands *below* the threshold — 85% of them for a
 * 15% profile — `target` is essentially zero, so the floor alone enters 6.7% of them. Solving
 * the split backwards does not rescue it, because the pre-noise probability it asks for is
 * negative and clamps at zero. Measured, that inflated every profile's realised VPIP by 0.05
 * to 0.06: a profile whose card said 15% entered 21% of pots. So the entry decision keeps its
 * declared split exactly and the mixture is applied *within* the entering actions (call versus
 * raise) and within the non-entering ones. Every plausible action still carries a floor of
 * `groupMass x noise / groupSize`, and difficulty still shows up in which continuing action is
 * taken, in the sizing, and in every postflop decision — it just no longer rewrites the one
 * frequency the profile card publishes.
 *
 * ## How the declared preflop frequencies are realised
 *
 * `vpip` is a *frequency*, so it is honoured by thresholding a *percentile*.
 * `preflopClassPercentile` gives the share of dealt hands this holding beats, computed from
 * the 169-class table and weighted by combinations. Because a dealt hand is uniform on that
 * percentile, the rule "enter when the percentile clears `1 - vpip`" enters exactly `vpip` of
 * hands. The threshold is applied through a logistic rather than as a hard cut, so hands just
 * inside it sometimes fold and hands just outside it sometimes enter; the logistic is
 * symmetric about the threshold, so those two errors cancel and the frequency survives.
 *
 * `pfrShareOfVpip` then splits what enters between the aggressive and the passive action, which
 * is what makes the realised PFR equal `vpip x pfrShareOfVpip` — the identity
 * `preflopRaiseFrequency` states in `traits.ts`. That split is itself solved backwards through
 * the within-group mixture, so the declared share survives the noise; the solve clamps only for
 * a share within `noise / 2` of 0 or 1, and says so in `whatChangedIt` when it does.
 *
 * Three honest caveats on the claim. The threshold is multiplied by `positionalVpipMultiplier`,
 * whose mean across seats is exactly 1 — it widens and tightens without moving the average —
 * and by a price factor that only ever tightens, so the realised average sits at or a little
 * below the declared figure and a session spent facing large raises sits further below.
 * `stackDepthCommitmentMultiplier` is deliberately NOT in that product: it is one-sided (1 at
 * 40bb and above, never lower), so including it would widen entry on every short-stacked hand
 * and narrow it on none, which is a bias rather than a style. It applies to the commitment
 * decision instead, which is what the trait says it means. And a *second* preflop decision —
 * facing a re-raise after opening — is priced on equity rather than re-gated, because the hand
 * has already been entered.
 *
 * A big blind with nothing to call is still an entry decision, and the one where the vocabulary
 * matters: checking the option puts nothing in voluntarily, so only a raise counts as entering,
 * and the entering mass there is `vpip x pfrShareOfVpip` rather than `vpip`. That makes the
 * realised entry rate in limped pots dip below the declared VPIP while keeping PFR exactly on
 * it, which is the trade the statistical suite's methodology note anticipates and the tighter of
 * the two constraints to satisfy.
 *
 * ## Where the opponent read enters, and where it deliberately does not
 *
 * `opponent-model.ts` owns the counting, the range estimate and the reliability weighting.
 * This file consumes three of its methods and adds nothing of its own to them:
 *
 *   - `rangeFor(seat, street, facingAction)` is the assumed opponent continuing range. Its
 *     blockers are removed here, because the estimator cannot know this seat's cards and an
 *     opponent cannot hold a card this seat can see.
 *   - `adjustmentsFor(seat, adaptation)` returns five multipliers on this model's own
 *     tendencies, already scaled by `traits.exploitativeAdaptation` *and* by how reliable the
 *     sample is. Passing the adaptation trait in and multiplying by what comes back is the
 *     whole of the adaptation in this file — there is no second, unscaled path where a
 *     twelve-hand read could move a decision.
 *   - `statsFor(seat)` is used only to describe the read in `whatChangedIt`, and it returns
 *     null below the model's own minimum sample, which is reported as "no read yet" rather
 *     than smoothed into a number.
 *
 * Multiway there is no single opponent, so both range and adjustments are taken against one
 * *primary* opponent: whoever last bet or raised on this street, or failing that the live
 * opponent with the most in front of them. That is a documented simplification — it reads the
 * seat whose action is being answered rather than averaging a table.
 *
 * ## Every learner-facing string is checked as it is generated
 *
 * `assertNoImpersonation` runs on every `rationale`, every `whatChangedIt` entry and on
 * `modelPreference` before `decide` returns. Not in a test afterwards: if a generator can emit
 * a string that fails the guard, that is a bug in the generator, and this is where it
 * surfaces. Every template's grammatical subject is *this model* and no profile name is
 * interpolated into any of them, which is the structural control the pattern list backstops
 * (`docs/AI-LEGENDS.md` §3).
 *
 * ## Outcome is never quality
 *
 * Nothing here can see a run-out, so nothing here can be tempted to grade a decision by its
 * result. The distribution and the reasoning are computed from the price, the assessment and
 * the traits, all of which exist before the next card is dealt.
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

/**
 * The public frequencies this policy reads about one seat.
 *
 * Field names and meanings mirror `DerivedSeatStats` in `opponent-model.ts`, which satisfies
 * this interface structurally. Declared here as the narrower shape so that the complete list
 * of opponent facts a decision can depend on is visible in this file — every one of them is a
 * frequency over PUBLIC actions, and no hidden card is involved in producing any of them.
 */
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
 * Multipliers on this model's own tendencies, 1 being neutral on every axis.
 *
 * Mirrors `ExploitAdjustments` in `opponent-model.ts`. They are multipliers rather than
 * replacements on purpose: a profile keeps its style and leans on what it has seen, so an
 * adaptation of 0.3 against a station is still the same model betting slightly thinner.
 */
export interface ObservedAdjustments {
  readonly bluffMore: number;
  readonly valueBetThinner: number;
  readonly foldMore: number;
  readonly sizeUp: number;
  readonly isolateMore: number;
}

/**
 * The opponent read this policy consumes, expressed as the three questions it asks.
 *
 * `OpponentModel` from `opponent-model.ts` satisfies this structurally, so a caller passes the
 * model straight through. Declaring the *questions* rather than importing the whole model
 * keeps this file's dependency on the read down to three calls, and keeps a future change to
 * the model's internals from silently changing what a decision depends on.
 */
export interface PolicyObservations {
  /** Null below the observer's own minimum sample: unknown, said in the type. */
  statsFor(seat: number): ObservedSeatRead | null;
  /** The assumed continuing range for a seat, as a slice of the computed strength ordering. */
  rangeFor(seat: number, street: string, facingAction: string): ParsedRange;
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

// ---------------------------------------------------------------------------
// Tuning constants
//
// Every one of these is a design parameter, not a measurement. They are named and gathered
// here rather than inlined so that a reviewer can see the whole scoring model on one screen,
// and so a test that asserts a behavioural claim can point at the number responsible.
// ---------------------------------------------------------------------------

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
 * How `threeBetTendency` moves the raising share when facing an actual raise.
 *
 * Neutral at 0.5, which is what makes the axis a deviation from the profile's own
 * `pfrShareOfVpip` rather than a second, competing declaration of it. Deliberately gentle: the
 * share is already high for a raise-first profile, and a multiplier that pushed it to 1 would
 * mean such a profile never flat-called a raise, which is a distortion of the style rather than
 * an expression of it — and it also shows up as realised PFR above the declared figure, because
 * a re-raise is a preflop raise like any other.
 */
const THREE_BET_BASE = 0.8;
const THREE_BET_SPAN = 0.4;

/**
 * The share of the openings it plays back at that this model re-raises rather than flat-calls.
 *
 * Exported because it is the **only** frequency `threeBetTendency` declares, and `stats.ts` has
 * to compare against the same quantity rather than against the trait value itself. The trait is
 * documented in `traits.ts` as a multiplier on the range it would merely call with, so reading
 * it as a 3-bet frequency compares a knob against a rate — and the two are not even on the same
 * range. A profile's realised 3-bet frequency is bounded above by the rate at which it enters
 * pots at all, so `disciplined-specialist`, whose card declares `vpip` 0.15, cannot re-raise 44%
 * of the openings it faces without contradicting the other number on the same card. See the
 * comment above `OBSERVABLE_AXES` in `stats.ts` for the measurement this feeds.
 *
 * Defined here rather than in `stats.ts` so that the mapping the policy applies and the mapping
 * the measurement inverts are one expression, not two that can drift.
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
 * Bounds on the odds form of `aggressionFrequency`.
 *
 * `a/(1-a)` runs away at the ends, and a trait of 0.95 does not mean "bets nineteen times as
 * often as it checks" with any precision worth propagating. Clamping the odds rather than the
 * trait keeps the declared value intact on the profile card while stopping one axis from
 * swamping every other term in the product.
 */
const MIN_AGGRESSION_ODDS = 0.05;
const MAX_AGGRESSION_ODDS = 6;

/**
 * Floor under the passive weight the aggressive weight is measured against.
 *
 * Facing a large bet with a hopeless hand the passive weight goes to nearly zero, and a
 * proportional aggressive weight would go with it — which would mean a bluff-raise could never
 * happen in precisely the spot where a bluff is the only way the hand can win. The floor keeps
 * that line available at a low frequency instead of removing it from the strategy.
 */
const MIN_PASSIVE_REFERENCE = 0.15;

const AGG_PRESSURE_BASE = 0.7;
const AGG_PRESSURE_SPAN = 0.6;
/** Above this share of the opponent range beaten, a bet is a value bet. */
const VALUE_EDGE = 0.55;
/**
 * Below this share of the opponent range beaten, a bet is a bluff.
 *
 * The two edges bracket a middle band that is neither, and a hand landing in it bets at the
 * declared `aggressionFrequency` — which is exactly what that trait is defined as, the rate on a
 * neutral assessment. Below the ceiling the rate slides towards `bluffFrequency`; above the value
 * edge it climbs past both.
 */
const BLUFF_CEILING = 0.45;
const SEMI_BLUFF_SPAN = 0.6;

/**
 * The band of relative strength on which `aggressionFrequency` is defined.
 *
 * Inside it `handFactor` in `scoreAggression` is exactly 1: `airness` is 0 at or above the
 * bluff ceiling and `valueness` is 0 at or below the value edge, so neither anchor is in play
 * and the aggressive weight is the passive weight times the trait's odds — which after
 * normalisation is the trait itself. That is what "when its hand assessment is neutral" in
 * `traits.ts` means, stated as two numbers instead of a phrase.
 *
 * Exported because `stats.ts` measures the declared quantity and cannot invent its own idea of
 * neutral. One definition, used by the thing that acts on it and the thing that measures it.
 */
export const NEUTRAL_ASSESSMENT_BAND = { low: BLUFF_CEILING, high: VALUE_EDGE } as const;

/** True when a relative-strength assessment sits in `NEUTRAL_ASSESSMENT_BAND`. */
export function isNeutralAssessment(relativeStrength: number): boolean {
  if (!Number.isFinite(relativeStrength)) return false;
  return relativeStrength >= NEUTRAL_ASSESSMENT_BAND.low && relativeStrength <= NEUTRAL_ASSESSMENT_BAND.high;
}

/**
 * Assumed chance ONE opponent folds to a bet, before any read.
 *
 * The multiway figure is this raised to the power of the opponent count, which treats
 * opponents as folding independently. They do not — a documented approximation, and it errs
 * towards giving a bluff less credit as the field grows, which is the safe direction. The read
 * does not move this number; it moves `bluffFrequency` through `adjustments.bluffMore`, so
 * there is exactly one path from an observation to a decision.
 */
const BASE_FOLD_PER_OPPONENT = 0.55;
const MIN_FOLD_EQUITY = 0.05;
const MAX_FOLD_EQUITY = 0.9;

/**
 * How far `pressureTendency` moves a bet off the size `betSizingPreference` asks for.
 *
 * Small on purpose. `stats.ts` measures the realised size as chips-added over the pot before
 * the action and inverts it through `preferredPotFraction`, so every multiplier stacked on top
 * of the preferred fraction shows up as a discrepancy against the declared trait — and a raise
 * reads large under that definition anyway, because the call it contains is counted in the
 * chips added. At 0.4 the measured `betSizingPreference` came back up to 0.26 above declared.
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

// ---------------------------------------------------------------------------
// The one place the view is read
// ---------------------------------------------------------------------------

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
   * Somebody has VOLUNTARILY bet or raised on this street.
   *
   * Distinct from `facingAggression`, and the distinction is not pedantic: preflop the small
   * blind owes money to the big blind, which is a forced bet and not aggression. Treating that
   * as a raise makes every routine open look like a re-raise spot, so `threeBetTendency` gets
   * applied to opening decisions — which measured as up to 6 points of extra PFR before the
   * statistical suite caught it.
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
 * Flattens the view into the complete list of things a decision depends on.
 *
 * Deliberately the only function that touches `input.view`. It reads no hole-card field of any
 * seat, including this seat's own — the cards come from `input.holeCards` — so the read set
 * this produces contains no card except the public board.
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
    // The decision `vpip` is a frequency over. A seat that has already acted voluntarily this
    // hand has entered, so a later preflop decision is priced on equity instead of re-gated.
    // A big blind with nothing to call still counts: checking the option enters nothing, so the
    // gate runs there too and only a raise is an entry.
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
 * Where this seat sits in the postflop action order among the seats still holding cards:
 * 0 for first to act, 1 for last.
 *
 * Measured on the POSTFLOP order even preflop, because positional advantage is about acting
 * last on the streets where the money goes in. Heads-up the button acts first preflop and last
 * afterwards, and it is the second fact that makes the button the better seat.
 */
function relativePositionOf(view: PlayerView, seat: SeatIndex, liveSeats: readonly SeatIndex[]): number {
  const order = orderFrom(view.buttonSeat, view.config.maxSeats, liveSeats);
  const index = order.indexOf(seat);
  if (index < 0 || order.length <= 1) return 1;
  return index / (order.length - 1);
}

/**
 * The action this seat is answering, in the vocabulary `opponent-model.ts` uses to narrow a
 * range.
 *
 * Preflop the big blind is a forced bet rather than an action, so the first raise is an *open*
 * and the second is a three-bet; postflop the first aggression is a bet and the second is a
 * raise. Counting aggressive actions and shifting the labels by one street handles both
 * without a special case per street.
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
 * The one opponent the range estimate and the exploit multipliers are taken against.
 *
 * Whoever last bet or raised on this street, because that is the action being answered;
 * failing that, the live opponent with the most committed, which multiway is the one whose
 * range matters most. A documented simplification: reading one seat rather than averaging a
 * table means the read is sharper and occasionally aimed at the wrong player.
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

// ---------------------------------------------------------------------------
// Stage 1: assess
// ---------------------------------------------------------------------------

/** Adaptation actually in force: the trait, switched off entirely at the easiest difficulty. */
function adaptationWeight(input: PolicyInput): number {
  if (!input.difficulty.adaptationEnabled) return 0;
  return clamp01(input.traits.exploitativeAdaptation);
}

/**
 * The assumed opponent continuing range, from the opponent model, with blockers removed.
 *
 * The estimator cannot know this seat's cards, and an opponent cannot hold a card this seat can
 * see. Dropping that step is the commonest range-arithmetic error there is: it inflates the
 * opponent's count of strong combinations, and it inflates it most on exactly the boards where
 * the decision is hardest.
 *
 * The coarseness is the opponent model's and is documented there and in
 * `docs/AI-LEGENDS.md` L5: one tightness number mapped onto a slice of the computed strength
 * ordering, with no knowledge of board texture and no removal of hands an earlier line rules
 * out.
 */
function assumedOpponentRange(input: PolicyInput, situation: Situation): ParsedRange {
  const estimated = input.observations.rangeFor(
    situation.primaryOpponent,
    situation.street,
    situation.facingAction,
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

// ---------------------------------------------------------------------------
// Stage 2: build the candidate set, with sizes
// ---------------------------------------------------------------------------

interface Candidate {
  readonly legal: LegalAction;
  readonly action: Action;
  /** False only for a fold that costs nothing to decline. See the module comment. */
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
          plausible: situation.toCall > 0,
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
 * Picks the size for a bet or a raise, then clamps it into the engine's bounds.
 *
 * "Raise to" semantics throughout: the returned number is the seat's TOTAL commitment for the
 * street, which is what `Action.to` means and what removes the classic ambiguity of "raise
 * 300". The target is built as "call first, then bet a fraction of the pot that call creates",
 * which reduces to plain "a fraction of the pot" for an opening bet.
 *
 * The jitter draw happens for every bet or raise candidate, whether or not it is the action
 * ultimately sampled. That keeps the number of draws a function of the legal action set rather
 * than of the sampling outcome, which is what makes a replay from a seed reproduce exactly.
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

  // A draw in [0, 1), turned into a symmetric jitter of at most +-25% at full variance. One
  // draw per candidate, so the stream advances predictably.
  const draw = input.random.nextInt(SAMPLE_RESOLUTION) / SAMPLE_RESOLUTION;
  const jitter = (draw - 0.5) * 0.5 * variance;

  const fraction =
    preferredPotFraction(traits) *
    (1 + SIZE_PRESSURE_SPAN * (traits.pressureTendency - 0.5)) *
    (1 + 0.5 * (strength.relativeStrength - 0.5) * variance) *
    (1 + jitter) *
    adjustments.sizeUp;

  // The size is what this seat ADDS, as a fraction of the pot in front of it — which is exactly
  // what `preferredPotFraction` declares and exactly what `stats.ts` measures (chips added over
  // the pot before the action). Writing it any other way makes the two disagree by definition:
  // the earlier version added the call on top of a fraction of the post-call pot, so a raise
  // measured about twice its declared fraction and every profile's observed bet sizing came back
  // 0.2 to 0.3 above its card. A raise that comes out below the engine's minimum is clamped up
  // to it, which is the one case where the size is the engine's choice rather than the model's.
  const target = situation.myCommitted + Math.max(0, fraction) * situation.pot;

  // Leaving a token amount behind is worse than committing: it hands the opponent a free shot
  // with no fold equity left to protect against it. Short stacks reach this sooner, which is
  // what `stackDepthCommitmentMultiplier` is for.
  const shoveAt =
    maxTo * (SHOVE_THRESHOLD / stackDepthCommitmentMultiplier(traits, situation.effectiveStackBb));
  const chosen = target >= shoveAt ? maxTo : target;
  return Math.min(maxTo, Math.max(minTo, Math.round(chosen)));
}

// ---------------------------------------------------------------------------
// Stage 3: score
// ---------------------------------------------------------------------------

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
  /**
   * The weight the passive line carries in this spot, floored.
   *
   * The aggressive weight is measured against it — see `scoreAggression` for why that is what
   * makes the realised aggression frequency equal the declared trait rather than approximate it.
   * Filled in by `scoreCandidates` after the passive candidates have been scored, which is why
   * this is a two-pass scoring stage rather than one `map`.
   */
  readonly passiveReference: number;
  /** Present only on a first voluntary preflop decision. */
  readonly entry: EntryPlan | null;
}

/**
 * The preflop entry decision, expressed as the two frequencies the profile card declares.
 *
 * `enteringMass` is a *final* probability, not a score: see `entryProbabilities` for why the
 * noise mixture is applied inside each group rather than across the entry decision.
 */
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
 * The preflop entry plan: a threshold on the percentile, and the split of what enters.
 *
 * Two things this deliberately does NOT multiply the threshold by.
 *
 * `stackDepthCommitmentMultiplier` is left out, even though the aggressive line uses it. Read
 * what that trait says it means: how much short stacks pull the profile towards *committing*,
 * towards getting all-in. It is one-sided — 1 at 40bb and above, never below 1 — so folding it
 * into the entry threshold would widen the realised entry frequency above the declared one on
 * every hand played below 40bb and never narrow it on any hand, which is a bias rather than a
 * style. It belongs on the commitment decision, and that is where it is applied.
 *
 * The price factor is one-sided the other way, and stays: a call that costs a large share of
 * the stack tightens the threshold and nothing widens it. That is a real strategic adjustment
 * with a small aggregate effect (a single big blind against a 100bb stack moves the threshold
 * by 0.6%), and its direction is towards caution rather than towards playing more hands.
 */
function planEntry(context: ScoreContext, candidates: readonly Candidate[]): EntryPlan {
  const { input, situation } = context;
  const traits = input.traits;
  const percentile = preflopClassPercentile(input.holeCards).percentileAmongAllHands;
  const priceFactor =
    1 - ENTRY_PRICE_SPAN * clamp01(situation.toCall / Math.max(1, situation.toCall + situation.myStack));
  const effectiveVpip = Math.min(0.98, Math.max(0.01, traits.vpip * context.positionFactor * priceFactor));
  const targetEntry = logistic((percentile - (1 - effectiveVpip)) / ENTRY_SOFTNESS);

  // Nothing is owed: checking is free, so the only way to enter a pot voluntarily is to raise.
  // A check is not an entry, which is what `stats.ts` counts and what `vpip` declares.
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
  // With nothing owed the only way to enter is to raise, and this model raises the share of the
  // hands it plays that its card declares — so the entering mass in a limped pot is
  // `vpip x pfrShareOfVpip` and the rest checks the option.
  //
  // The alternative, putting the whole entry threshold behind the raise, is worse on both counts.
  // It is worse poker: checking behind with a middling hand in a limped pot is standard, and a
  // profile that raises every hand it would have played never does it. And it is worse measured:
  // it lifts realised PFR by `(1 - pfrShareOfVpip) x vpip` across those spots, which pushed the
  // most raise-happy profile in the set to 0.051 above its declared PFR against a 0.05 tolerance.
  // The cost is that realised VPIP in limped pots falls towards the raising share — the
  // measurement's documented downward bias — and VPIP has the slack to absorb it while PFR does
  // not.
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
 * Scores every candidate, in two passes.
 *
 * The passive line is scored first because the aggressive weight is expressed as a multiple of
 * it: that is what turns `aggressionFrequency` from a number that influences a decision into
 * the frequency the decision actually has. A single pass would need a constant for the
 * aggressive baseline, and a constant is what produced a 0.2 shortfall against every declared
 * value the first time this was measured.
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
 * The first voluntary preflop decision: the declared entry frequency IS the split between
 * entering and not, and `pfrShareOfVpip` splits what enters.
 *
 * Position and price enter through the threshold rather than around it, which is what keeps the
 * realised frequency equal to the declared one rather than merely correlated with it. The
 * weights below are the pre-mixture probabilities; `entryProbabilities` finishes the job.
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

  // The read widens the range this model will value-bet and how thin it will bluff. Both
  // multipliers arrive already scaled by adaptation and by the sample's reliability, so an
  // insufficient sample leaves this arithmetic exactly where it started.
  const valueEdge = clamp01(VALUE_EDGE / Math.max(0.5, adjustments.valueBetThinner));
  const valueness = clamp01((strength.relativeStrength - valueEdge) / Math.max(0.05, 1 - valueEdge));
  const airness = clamp01((BLUFF_CEILING - strength.relativeStrength) / BLUFF_CEILING);
  const aggression = aggressionOdds(traits.aggressionFrequency);

  // Two traits, two anchors, and the interpolation between them is the whole hand read.
  //
  // `aggressionFrequency` is the rate on a NEUTRAL hand and `bluffFrequency` is the rate on a
  // hand that cannot win at showdown, so the aggressive weight has to land on the first when the
  // hand is middling and on the second when it is air. Expressing the air anchor as the RATIO of
  // the two odds is what makes that come out right after normalisation; a term added on top
  // instead made air the most aggressive holding in the range, and the statistical suite measured
  // bluff frequencies up to 0.28 above every declared value.
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
  // A wider swing than `THREE_BET_BASE`/`THREE_BET_SPAN` in `planEntry`, on purpose: this path
  // scores a re-raise against folding on a LATER preflop decision (a four-bet spot, where the
  // hand has already been entered), rather than splitting an entry the threshold has already
  // decided. Postflop the same slot belongs to `pressureTendency`, because re-raising a bet is
  // about how much pressure the style applies and `threeBetTendency` is documented as preflop.
  const reRaiseFactor = situation.facingRaise
    ? situation.isPreflop
      ? 0.5 + traits.threeBetTendency
      : 0.6 + 0.8 * traits.pressureTendency
    : 1;

  // Calibrated against the passive weight rather than against a constant of its own.
  //
  // `aggressionFrequency` is defined as how often the style takes the aggressive line "when
  // aggression is available and its hand assessment is neutral", so on a neutral hand the
  // aggressive weight has to be the passive weight times the trait's ODDS — a/(1-a) — and then
  // the normalisation makes the realised frequency the trait itself, by construction rather
  // than by tuning. The first version of this file used a constant base instead and measured
  // 0.20 to 0.25 below every declared value in the statistical suite, because the value and
  // bluff terms both vanish for a middling hand and nothing was left holding the baseline up.
  //
  // Everything after the odds is a reason to deviate FROM neutral, in both directions, so the
  // identity holds on a neutral assessment and nowhere else. Measured over 8,000 hands per
  // profile, the realised rate inside `NEUTRAL_ASSESSMENT_BAND` sits within sampling error of
  // the declared trait on all twelve profiles (mean signed error -0.004, worst 0.086 against a
  // per-profile sampling half-width of about 0.07), with the misses scattered on both sides.
  //
  // The UNCONDITIONAL postflop rate is a different number and is systematically LOWER — mean
  // signed error -0.095 across the same twelve, and lower on every one of them. That is not a
  // residual: about 60% of the postflop turns on which aggression is legal are air by
  // `holdingIsAir`, and on air this model deliberately bets at `bluffFrequency`, which every
  // profile declares well below its `aggressionFrequency`. Averaging the two rates has to land
  // between them. It cannot land on the higher one: with an air share around 0.6, hitting
  // `reading-pressure-specialist`'s declared 0.74 unconditionally while honouring its declared
  // bluff frequency of 0.46 would need it to bet 1.19 of its non-air hands, and six of the
  // twelve profiles are impossible in the same way. So the unconditional rate is a consequence
  // of two declared traits and a board, not a target — `stats.ts` measures the conditional rate
  // this comment is about, and reports the unconditional one separately.
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

// ---------------------------------------------------------------------------
// Stages 4-6: noise, normalise, sample
// ---------------------------------------------------------------------------

interface Distributed {
  readonly scored: Scored;
  readonly probability: number;
}

/**
 * The noise floor on a preflop entry decision, applied WITHIN each group rather than across the
 * entry decision itself.
 *
 * This is the correction that makes the declared VPIP survive contact with the noise floor, and
 * it is worth writing down why the obvious version does not work. Mixing across all three
 * actions gives entering probability `(1 - noise) x target + noise x 2/3`, and for the hands
 * *below* the threshold — which for a 15% profile is 85% of them — `target` is essentially 0, so
 * the floor alone enters 6.7% of them. Solving the split backwards cannot fix it either,
 * because the pre-noise probability it asks for is negative and clamps at zero. Measured
 * against the statistical suite, that inflated every profile's realised VPIP by 0.05 to 0.06 —
 * a tight profile entering 21% of pots while its card said 15%.
 *
 * So the entry decision keeps its declared split exactly, and the mixture runs inside the
 * entering group (call versus raise) and inside the non-entering group. Every plausible action
 * still has a floor — `groupMass x noise / groupSize` — and difficulty still shows up in which
 * continuing action is taken, in the sizing, and in every postflop decision. What it no longer
 * does is quietly rewrite the one frequency the profile card publishes.
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
    // With only one kind of entering action legal it takes the whole entering mass: a declared
    // split cannot be honoured against an action set that does not contain both sides of it.
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
 * Mixes the normalised scores with the uniform distribution over the plausible actions.
 *
 * Every plausible action therefore ends up above `noise / plausibleCount`, which is the floor
 * the difficulty setting promises. A dominated action stays at exactly 0 — see the module
 * comment for why a floor must not resurrect one.
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
    // With every score at zero there is nothing to prefer, so the uniform part is the whole
    // answer rather than a division by zero.
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
  // Floating-point drift can leave the last sliver unreachable. Falling back to the last
  // action with any probability keeps the sampler total rather than occasionally undefined.
  for (let index = distributed.length - 1; index >= 0; index--) {
    const entry = distributed[index];
    if (entry !== undefined && entry.probability > 0) return entry;
  }
  throw new PolicyError('the distribution carried no action with positive probability');
}

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

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

/**
 * The counterfactuals. Every one names a concrete alternative and computes what it would have
 * done, because "position matters here" teaches nothing a learner could not have guessed.
 */
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

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Turns one situation into one action, plus everything needed to explain it.
 *
 * Deterministic in (input, random stream): the same seed replays the same decision, including
 * the same equity estimate and the same bet size. The order of draws is fixed — the postflop
 * equity seed first, then one jitter per bet or raise candidate, then the sampling draw — so a
 * replay cannot drift by taking a different path through the same generator.
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

  // Checked here, at generation time, not in a test afterwards. A generator that can emit a
  // string which fails this guard is a bug, and this is where it surfaces.
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

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

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

/** A fraction in 0..1 as a percentage with one decimal. */
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
