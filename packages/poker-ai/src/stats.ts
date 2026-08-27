/**
 * Measuring what the profiles actually did, and testing whether two of them differ.
 *
 * ## Why this file exists
 *
 * "Twelve distinct styles" is a claim on a card until something measures it. `traits.ts`
 * declares what each profile is *supposed* to do; this module turns a run of simulated
 * hands into the same quantities, so the declaration can be checked rather than trusted.
 * When the two disagree, that is a defect in the model and it gets reported — see
 * `compareToDeclared`, and `ProfileStatsResponse.divergences` on the wire, which exists
 * precisely so a mismatch is surfaced to a learner instead of hidden.
 *
 * ## The denominators are the whole design
 *
 * Every rate here is a ratio, and choosing the wrong denominator is how a statistic
 * quietly measures something other than what it is named after. The trap worth naming:
 *
 * A hand-history tracker computes VPIP over **hands dealt**. That is right for a tracker,
 * because it is describing a session. It is wrong here. The button rotates every hand, and
 * a seat in the blinds frequently never gets a turn — heads-up, when the button folds
 * preflop the big blind never acts at all. Divide by hands dealt and the resulting figure
 * is a blend of the policy's entry threshold and the rate at which the table denied it a
 * decision. Compare *that* to `traits.vpip` and the test measures button rotation.
 *
 * So the denominator for `vpip` and `pfr` is **preflop decisions offered**: hands in which
 * this seat was to act at least once before the flop. A seat that never got to act cannot
 * have declined to enter. Every other rate below states its denominator on the field, for
 * the same reason.
 *
 * ## The same trap one level up: the CONDITION is part of the quantity
 *
 * Choosing the right denominator is not enough if the two sides of a comparison are
 * conditioned on different things. Two of the sixteen traits are declared on a condition,
 * and for a long time this file compared them against unconditional rates:
 *
 * `aggressionFrequency` is declared as the rate "when aggression is available **and its hand
 * assessment is neutral**". Measured unconditionally it came out below the declared value on
 * all twelve profiles — mean signed error -0.095 over 8,000 hands each — and that was read as
 * a modelling bias. It is not one. About 60% of the postflop turns on which aggression is
 * legal are air, and on air the model bets at `bluffFrequency`, which every profile declares
 * far below its `aggressionFrequency`; an average over both has to land between them. It
 * cannot land on the higher one: at an air share of 0.6, reaching a declared 0.74
 * unconditionally while honouring a declared bluff frequency of 0.46 would require betting
 * 1.19 of the non-air hands. Six of the twelve profiles are unreachable in exactly that way,
 * so the old comparison was not merely wrong about the model, it was **unsatisfiable** —
 * against a `bluffFrequency` axis in this same list that passes. Measured on the condition it
 * is declared on, the mean signed error is -0.004 with the misses scattered on both sides.
 *
 * The same argument applies once more inside that condition, and it is worth following to the
 * end. The aggressive line's alternative is the PASSIVE line — check or call. Folding is
 * neither, and how readily this model folds is `foldToPressure`, a separate declared trait with
 * its own row in `OBSERVABLE_AXES`. Counting folds in the aggression denominator therefore
 * measures a blend of two traits and reads low exactly where the other trait is high: worth
 * 0.03 of the rate on average and 0.045 on `disciplined-specialist`, whose `foldToPressure` of
 * 0.76 is the highest in the set. The policy's own arithmetic says the same thing — the
 * aggressive weight is set to the PASSIVE weight times the trait's odds, so the identity that
 * makes the realised rate equal the declared trait normalises over {passive, aggressive}.
 *
 * `threeBetTendency` is declared as a multiplier on the range the model would merely call
 * with, not as a frequency at all. Comparing it against the observed 3-bet frequency compares
 * a knob against a rate whose ceiling is a different declared number: a 3-bet requires
 * entering the pot, so the realised 3-bet frequency is bounded above by the entry rate, and a
 * profile declaring `vpip` 0.15 cannot re-raise 44% of the openings it faces without
 * contradicting the other figure on its own card. The multiplier's only frequency is
 * `threeBetRaiseShare` in `policy.ts` — the share of the openings it plays back at that it
 * re-raises rather than flat-calls — and that is what is measured here.
 *
 * Neither correction moved a tolerance and neither changed a decision. What changed is which
 * quantity is placed next to which; the aggression tolerance is the same 0.18 it always was,
 * and the 3-bet tolerance was **narrowed** from 0.30 to 0.15 because a like-for-like
 * comparison no longer needs the slack that a knob-against-a-rate comparison did.
 *
 * ## Two-proportion z-test, derived
 *
 * Testing whether two profiles enter pots at genuinely different rates is a comparison of
 * two binomial proportions. Under the null hypothesis the two rates are equal, so the best
 * estimate of the common rate is the **pooled** proportion — combine the successes and the
 * trials rather than averaging the two rates:
 *
 *     p = (x1 + x2) / (n1 + n2)
 *
 * A sample proportion has variance `p(1-p)/n`. The two samples are independent, so the
 * variance of their difference is the sum, and the standard error is its square root:
 *
 *     se = sqrt( p(1-p)/n1 + p(1-p)/n2 ) = sqrt( p(1-p) (1/n1 + 1/n2) )
 *     z  = (p1 - p2) / se
 *
 * Pooling matters: using each sample's own variance instead is the two-sample *interval*
 * formula, not the test, and it is systematically the wrong denominator under the null.
 *
 * `z` is then compared against a two-sided normal critical value, and that value comes from
 * `normalQuantile` in `@prl/poker-math` — a workspace package this one already depends on.
 * No statistics library was added, and none will be.
 *
 * It is worth saying why the inverse normal is *not* reimplemented here, because there was a
 * version of this file that did. `@prl/poker-math/variance` carries Acklam's rational
 * approximation with a relative error below 1.15e-9. A local reimplementation — bisection on
 * the Abramowitz & Stegun tail formula, whose own error bound is 7.5e-8 — lands about 3e-5
 * away in `z` at alpha = 0.001, which is *visible in the fourth decimal place* against the
 * published table value of 3.2905. Two implementations of one function is two things to get
 * right; the more accurate one that already exists wins.
 *
 * ## Nothing here scores a decision
 *
 * `netChips` and `bbPer100` are results. Every other field is a frequency. No function in
 * this file combines the two, and none of them produces a verdict — a profile that lost
 * chips over 20,000 hands is not thereby playing badly, and this module must never be the
 * place that quietly implies otherwise. Decision quality is computed from EV before the
 * run-out is known, and it lives elsewhere.
 */

import { LEGEND_TRAIT_KEYS, type LegendTraitAxis, type ProfileObservedStats } from '@prl/contracts';
import { type Card, rankIndexOf, rankMaskOf, straightHigh, suitIndexOf } from '@prl/poker-engine';
import { normalQuantile } from '@prl/poker-math';
import { assertNoImpersonation } from './labelling.ts';
import { isNeutralAssessment, threeBetRaiseShare } from './policy.ts';
import { requireProfile } from './profiles.ts';
import {
  preferredPotFraction,
  TRAIT_DESCRIPTIONS,
  TRAIT_KEYS,
  TRAIT_LABELS,
  type TraitKey,
  type Traits,
} from './traits.ts';

export class StatsError extends Error {
  override readonly name = 'StatsError';
}

// ---------------------------------------------------------------------------
// The normal critical value
// ---------------------------------------------------------------------------

/**
 * The two-sided critical value for a significance level: the `z` with `Phi(z) = 1 - alpha/2`.
 *
 * A thin wrapper, and deliberately so. All it adds to `normalQuantile` is the two-sided
 * convention — that a test at alpha splits the rejection region between both tails, so the
 * quantile wanted is `1 - alpha/2` and not `1 - alpha`. Writing that conversion once, in a
 * function whose name says "two-sided", is the point: `normalQuantile(1 - alpha)` at a call
 * site is a one-character-looking mistake that halves every significance claim in the suite.
 *
 * `test/stats.test.ts` pins the conventional levels against published table values —
 * 1.9600, 2.5758, 3.2905 — plus the interquartile point 0.6745, which sits in a completely
 * different part of the curve and so would catch an approximation calibrated only in the tail.
 */
export function normalTwoSidedCriticalValue(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new StatsError(`alpha must be strictly between 0 and 1, received ${String(alpha)}`);
  }
  return normalQuantile(1 - alpha / 2);
}

/** 1.959963…, the multiplier for a 95% interval. Computed rather than typed in. */
const Z_95 = normalTwoSidedCriticalValue(0.05);

// ---------------------------------------------------------------------------
// What a simulated seat produced
// ---------------------------------------------------------------------------

/**
 * The raw counts behind every rate.
 *
 * Carried alongside the rates because a rate cannot be tested. A two-proportion z-test
 * needs successes and trials; recovering them from a rounded frequency is guesswork, and
 * the whole point of this module is that the significance claims are checkable.
 */
export interface SeatSimulationCounts {
  /** Hands in which this seat was to act at least once preflop. */
  readonly preflopOpportunities: number;
  /** Of those, hands in which it voluntarily put chips in preflop. */
  readonly voluntaryEntries: number;
  /** Of those, hands in which it bet or raised preflop. */
  readonly preflopRaiseHands: number;
  /** Preflop turns facing a raise above the big blind, with a re-raise legal. */
  readonly threeBetOpportunities: number;
  /** Of those, turns on which it re-raised. */
  readonly threeBets: number;
  /**
   * Of those, the ones that were this seat's FIRST voluntary preflop decision of the hand.
   *
   * The narrower denominator that `threeBetTendency` actually describes. The trait moves the
   * raising share of the preflop *entry* decision, which happens once per hand; a later turn —
   * facing a four-bet after opening — is priced on equity instead and is not gated by the
   * trait at all, so pooling the two measures a blend of one thing the trait controls and one
   * it does not.
   */
  readonly threeBetEntryOpportunities: number;
  /** Of those, turns on which it entered the pot at all: called or re-raised. */
  readonly threeBetEntries: number;
  /** Of those entries, the ones that were a re-raise rather than a flat call. */
  readonly threeBetEntryRaises: number;
  /** Postflop turns on which a bet or a raise was legally available. */
  readonly aggressionOpportunities: number;
  /** Of those, turns on which it bet or raised. */
  readonly aggressiveActions: number;
  /**
   * Of those, the ones on which the model's own assessment was neutral.
   *
   * "Neutral" is `NEUTRAL_ASSESSMENT_BAND` in `policy.ts` — the band in which the hand-read
   * term of the aggressive weight is exactly 1 — so this file and the policy cannot drift
   * apart about what the word means. Zero when the harness was driven by a stand-in that
   * published no assessment; a rate over an empty denominator reads as 0 and is reported next
   * to its count, never smoothed.
   */
  readonly neutralAggressionOpportunities: number;
  /**
   * Of those, turns on which it folded — removed from the rate's denominator.
   *
   * Folding is neither the aggressive line nor the passive one, and it is governed by
   * `foldToPressure`, which is a declared trait with its own axis in this same list. Leaving
   * folds in would make the aggression axis measure a blend of two traits, which is the exact
   * category of error this file was corrected for. It is also what the policy's own arithmetic
   * says: `scoreAggression` sets the aggressive weight to the PASSIVE weight times the trait's
   * odds, so the identity that makes the realised rate equal the declared trait normalises over
   * {passive, aggressive} and not over {fold, passive, aggressive}.
   *
   * Measured, the difference is worth 0.03 of the rate on average and 0.045 on the profile with
   * the highest `foldToPressure` — one-sided downward on all twelve, and largest exactly where
   * that trait is largest.
   */
  readonly neutralFolds: number;
  /** Of those, turns on which it bet or raised. */
  readonly neutralAggressiveActions: number;
  /** Postflop turns where aggression was available AND the holding was air. */
  readonly airAggressionOpportunities: number;
  /** Of those, turns on which it bet or raised anyway. */
  readonly airAggressiveActions: number;
  /** Turns, any street, facing a non-zero amount to call. */
  readonly facingBetDecisions: number;
  /** Of those, turns on which it folded. */
  readonly foldsFacingBet: number;
  /** Hands in which it still held cards when the flop was dealt. */
  readonly flopsSeen: number;
  /** Hands in which it actually showed its hand at showdown. */
  readonly showdownsReached: number;
  /** Postflop bets and raises whose size went into the sizing average. */
  readonly sizedActions: number;
  /**
   * Of those, the ones that were an OPENING bet rather than a raise.
   *
   * Kept separate because the two are not the same measurement, and pooling them is how a
   * sizing statistic quietly stops measuring sizing. `preferredPotFraction` describes the
   * fraction of the pot a profile likes to *bet*. A raise's `chips added` is the call plus the
   * increment, so on the same pot a raise scores far above the fraction the profile chose —
   * mechanically, not stylistically. `averageBetSizeAsPotFraction` pools both, because that is
   * what a hand-history tracker reports and what a learner will compare against; the
   * declared-versus-observed axis uses the opening bets alone, because that is the quantity the
   * trait is about.
   */
  readonly openingBets: number;
  /** Every turn this seat took, all streets. Sanity check on the harness. */
  readonly decisions: number;
}

/**
 * One seat's behaviour across a simulation run.
 *
 * Field-by-field denominators, since a frequency without one is not a measurement:
 *
 * | field                        | numerator                        | denominator                  |
 * |------------------------------|----------------------------------|------------------------------|
 * | vpip                         | hands entered voluntarily        | preflop decisions offered    |
 * | pfr                          | hands bet or raised preflop      | preflop decisions offered    |
 * | threeBetFrequency            | preflop re-raises                | turns facing a preflop raise |
 * | threeBetShareOfEntries       | entry re-raises facing an open   | entries facing an open       |
 * | aggressionFrequency          | postflop bets and raises         | postflop turns where a bet
 *                                                                     or raise was legal          |
 * | neutralAggressionFrequency   | the same, on a neutral read      | the same, on a neutral read  |
 * | bluffFrequency               | aggressive actions holding air   | those turns, holding air     |
 * | wentToShowdown               | hands shown down                 | hands that saw a flop        |
 * | foldToBetFrequency           | folds facing a bet               | turns facing a bet           |
 * | averageBetSizeAsPotFraction  | Σ (chips added / pot before)     | postflop bets and raises     |
 * | averageOpeningBetAsPotFraction | Σ (chips added / pot before)   | postflop OPENING bets only   |
 */
export interface SeatSimulationStats {
  readonly seat: number;
  readonly profileId: string;
  readonly handsDealt: number;
  readonly vpip: number;
  readonly pfr: number;
  readonly threeBetFrequency: number;
  /**
   * The share of the openings it entered that it re-raised rather than flat-called.
   *
   * The frequency `threeBetTendency` declares, and the one the trait comparison uses. Kept
   * beside `threeBetFrequency` rather than replacing it: the unconditional rate is what a
   * hand-history tracker shows a learner, and both are true statements about different
   * questions. See the module comment for why only one of them can be compared to the card.
   */
  readonly threeBetShareOfEntries: number;
  readonly aggressionFrequency: number;
  /**
   * The same rate over the turns on which the model's own assessment was neutral.
   *
   * The quantity `aggressionFrequency` on the profile card is defined as. `aggressionFrequency`
   * above is the unconditional rate — the tracker statistic — and sits well below it on every
   * profile, because most postflop turns are not neutral and the model bets air at
   * `bluffFrequency` by design. Both are reported; only this one is comparable to the card.
   */
  readonly neutralAggressionFrequency: number;
  readonly bluffFrequency: number;
  readonly wentToShowdown: number;
  readonly foldToBetFrequency: number;
  readonly averageBetSizeAsPotFraction: number;
  /**
   * The same average over OPENING bets only, which is the quantity `betSizingPreference`
   * actually declares. See `SeatSimulationCounts.openingBets` for why the two differ.
   */
  readonly averageOpeningBetAsPotFraction: number;
  readonly netChips: number;
  readonly bbPer100: number;
  /**
   * Half-width of a 95% interval on a frequency measured over `handsDealt` observations,
   * at the worst case p = 0.5. Deliberately conservative and deliberately one number: it
   * exists so a learner reading a 40-hand sample sees how little it says, and a per-field
   * interval would invite reading the narrowest one.
   */
  readonly confidenceHalfWidth: number;
  readonly counts: SeatSimulationCounts;
}

/** Chips a seat put in, and what it was facing, as the harness observed one turn. */
export interface DecisionObservation {
  readonly street: 'preflop' | 'flop' | 'turn' | 'river';
  /** Chips needed to match the current bet. 0 when checking is free. */
  readonly toCall: number;
  /** Total pot before this action, including this street's commitments. */
  readonly potBefore: number;
  /** True when the engine offered a bet or a raise. */
  readonly aggressionAvailable: boolean;
  /** True when the bet level was above the big blind preflop, i.e. facing a raise. */
  readonly facingPreflopRaise: boolean;
  readonly action: 'fold' | 'check' | 'call' | 'bet' | 'raise';
  /** Chips this action moved from stack to pot. */
  readonly cost: number;
  /** True when the seat's two cards made no pair or better with the board. */
  readonly holdingIsAir: boolean;
  /**
   * The acting model's own relative-strength assessment, 0..1, or null when it published none.
   *
   * The observer's own `holdingIsAir` cannot stand in for this. Air is a showdown-value
   * classification made from the cards; "neutral" is a position in the model's read of its
   * hand against the range it assumes it is against, which is the thing
   * `traits.aggressionFrequency` is conditioned on. Null is carried rather than defaulted so
   * that a run driven by a stand-in reports an empty denominator instead of a plausible number
   * measuring something else.
   */
  readonly assessedRelativeStrength: number | null;
}

/** How one hand ended for one seat. */
export interface HandOutcomeObservation {
  /** True when the seat still held cards at the moment the flop was dealt. */
  readonly sawFlop: boolean;
  /** True when the seat's cards were actually shown at showdown. */
  readonly showedDown: boolean;
  /** Net chips for the seat across the hand: winnings minus everything committed. */
  readonly netChips: number;
}

/**
 * A mutable accumulator, one per seat per run.
 *
 * A class rather than a pile of counters threaded through the harness, for the same
 * reason `Tally` in `@prl/poker-math/equity` is a class: the per-hand bookkeeping (did
 * this seat get a turn preflop? did it enter voluntarily?) has to be reset at exactly the
 * right moment, and `beginHand`/`endHand` make the wrong moment a visible mistake rather
 * than a silently wrong denominator.
 *
 * Fields are assigned in the constructor body rather than through parameter properties,
 * which `erasableSyntaxOnly` forbids — that flag is what lets Node run this TypeScript
 * with no build step.
 */
export class SeatObservations {
  readonly seat: number;
  readonly profileId: string;

  handsDealt = 0;
  preflopOpportunities = 0;
  voluntaryEntries = 0;
  preflopRaiseHands = 0;
  threeBetOpportunities = 0;
  threeBets = 0;
  threeBetEntryOpportunities = 0;
  threeBetEntries = 0;
  threeBetEntryRaises = 0;
  aggressionOpportunities = 0;
  aggressiveActions = 0;
  neutralAggressionOpportunities = 0;
  neutralFolds = 0;
  neutralAggressiveActions = 0;
  airAggressionOpportunities = 0;
  airAggressiveActions = 0;
  facingBetDecisions = 0;
  foldsFacingBet = 0;
  flopsSeen = 0;
  showdownsReached = 0;
  sizedActions = 0;
  potFractionSum = 0;
  openingBets = 0;
  openingBetPotFractionSum = 0;
  decisions = 0;
  netChips = 0;

  private handOpen = false;
  private hadPreflopTurn = false;
  private enteredVoluntarily = false;
  private raisedPreflop = false;

  constructor(seat: number, profileId: string) {
    this.seat = seat;
    this.profileId = profileId;
  }

  /** Called once per hand this seat was dealt into, before any of its decisions. */
  beginHand(): void {
    if (this.handOpen) throw new StatsError(`seat ${this.seat}: beginHand called twice without endHand`);
    this.handOpen = true;
    this.hadPreflopTurn = false;
    this.enteredVoluntarily = false;
    this.raisedPreflop = false;
    this.handsDealt += 1;
  }

  /**
   * Called for every turn this seat took, in order.
   *
   * Split by street into two private methods rather than one branch, because the two halves
   * count different things over different denominators and the only thing they share is the
   * fold-facing-a-bet tally at the bottom. Keeping them apart makes it hard to add a counter
   * to the wrong street, which is the mistake that produces a plausible number measuring
   * something other than its name.
   */
  noteDecision(observation: DecisionObservation): void {
    if (!this.handOpen) throw new StatsError(`seat ${this.seat}: noteDecision outside a hand`);
    this.decisions += 1;
    const aggressive = observation.action === 'bet' || observation.action === 'raise';

    if (observation.street === 'preflop') this.notePreflop(observation, aggressive);
    else this.notePostflop(observation, aggressive);

    // Every street: the fold-to-bet rate is about facing a price, wherever that happens.
    if (observation.toCall > 0) {
      this.facingBetDecisions += 1;
      if (observation.action === 'fold') this.foldsFacingBet += 1;
    }
  }

  /** Latches the per-hand preflop facts, and counts 3-bet spots. */
  private notePreflop(observation: DecisionObservation, aggressive: boolean): void {
    this.hadPreflopTurn = true;
    const entering = observation.action === 'call' || aggressive;
    // The seat's first voluntary preflop decision is the one the entry threshold gates, and it
    // is exactly the turn on which nothing voluntary has happened yet. Read before the latch
    // below, because the latch is what ends it.
    const isEntryDecision = !this.enteredVoluntarily;
    // Calling, betting and raising are voluntary. Checking the big blind option is not: the
    // chips were already forced in, so the seat has not chosen to play.
    if (entering) this.enteredVoluntarily = true;
    if (aggressive) this.raisedPreflop = true;
    // A 3-bet spot needs both halves: facing a raise, and a re-raise actually legal. After a
    // short all-in it is not, and counting that turn as a declined re-raise would understate
    // the rate.
    if (observation.facingPreflopRaise && observation.aggressionAvailable) {
      this.threeBetOpportunities += 1;
      if (aggressive) this.threeBets += 1;
      if (isEntryDecision) {
        this.threeBetEntryOpportunities += 1;
        if (entering) {
          this.threeBetEntries += 1;
          if (aggressive) this.threeBetEntryRaises += 1;
        }
      }
    }
  }

  /** Counts postflop aggression, bluffs and bet sizes. */
  private notePostflop(observation: DecisionObservation, aggressive: boolean): void {
    if (observation.aggressionAvailable) {
      this.aggressionOpportunities += 1;
      if (aggressive) this.aggressiveActions += 1;
      const assessed = observation.assessedRelativeStrength;
      if (assessed !== null && isNeutralAssessment(assessed)) {
        this.neutralAggressionOpportunities += 1;
        if (observation.action === 'fold') this.neutralFolds += 1;
        if (aggressive) this.neutralAggressiveActions += 1;
      }
      if (observation.holdingIsAir) {
        this.airAggressionOpportunities += 1;
        if (aggressive) this.airAggressiveActions += 1;
      }
    }
    if (aggressive && observation.potBefore > 0) {
      const fraction = observation.cost / observation.potBefore;
      this.sizedActions += 1;
      this.potFractionSum += fraction;
      // An opening bet costs exactly the fraction of the pot the profile chose. A raise costs
      // that plus the call, so only the bets belong in the trait comparison.
      if (observation.action === 'bet') {
        this.openingBets += 1;
        this.openingBetPotFractionSum += fraction;
      }
    }
  }

  /** Called once per hand this seat was dealt into, after the hand completes. */
  endHand(outcome: HandOutcomeObservation): void {
    if (!this.handOpen) throw new StatsError(`seat ${this.seat}: endHand without beginHand`);
    this.handOpen = false;
    if (this.hadPreflopTurn) {
      this.preflopOpportunities += 1;
      if (this.enteredVoluntarily) this.voluntaryEntries += 1;
      if (this.raisedPreflop) this.preflopRaiseHands += 1;
    }
    if (outcome.sawFlop) this.flopsSeen += 1;
    if (outcome.showedDown) this.showdownsReached += 1;
    this.netChips += outcome.netChips;
  }

  finalise(bigBlind: number): SeatSimulationStats {
    if (this.handOpen) throw new StatsError(`seat ${this.seat}: finalise called mid-hand`);
    if (!Number.isFinite(bigBlind) || bigBlind <= 0) {
      throw new StatsError(`bigBlind must be a positive number, received ${String(bigBlind)}`);
    }
    return {
      seat: this.seat,
      profileId: this.profileId,
      handsDealt: this.handsDealt,
      vpip: ratio(this.voluntaryEntries, this.preflopOpportunities),
      pfr: ratio(this.preflopRaiseHands, this.preflopOpportunities),
      threeBetFrequency: ratio(this.threeBets, this.threeBetOpportunities),
      threeBetShareOfEntries: ratio(this.threeBetEntryRaises, this.threeBetEntries),
      aggressionFrequency: ratio(this.aggressiveActions, this.aggressionOpportunities),
      neutralAggressionFrequency: ratio(
        this.neutralAggressiveActions,
        this.neutralAggressionOpportunities - this.neutralFolds,
      ),
      bluffFrequency: ratio(this.airAggressiveActions, this.airAggressionOpportunities),
      wentToShowdown: ratio(this.showdownsReached, this.flopsSeen),
      foldToBetFrequency: ratio(this.foldsFacingBet, this.facingBetDecisions),
      averageBetSizeAsPotFraction: ratio(this.potFractionSum, this.sizedActions),
      averageOpeningBetAsPotFraction: ratio(this.openingBetPotFractionSum, this.openingBets),
      netChips: this.netChips,
      bbPer100: this.handsDealt === 0 ? 0 : (this.netChips / bigBlind / this.handsDealt) * 100,
      confidenceHalfWidth: this.handsDealt === 0 ? 1 : (Z_95 * 0.5) / Math.sqrt(this.handsDealt),
      counts: {
        preflopOpportunities: this.preflopOpportunities,
        voluntaryEntries: this.voluntaryEntries,
        preflopRaiseHands: this.preflopRaiseHands,
        threeBetOpportunities: this.threeBetOpportunities,
        threeBets: this.threeBets,
        threeBetEntryOpportunities: this.threeBetEntryOpportunities,
        threeBetEntries: this.threeBetEntries,
        threeBetEntryRaises: this.threeBetEntryRaises,
        aggressionOpportunities: this.aggressionOpportunities,
        aggressiveActions: this.aggressiveActions,
        neutralAggressionOpportunities: this.neutralAggressionOpportunities,
        neutralFolds: this.neutralFolds,
        neutralAggressiveActions: this.neutralAggressiveActions,
        airAggressionOpportunities: this.airAggressionOpportunities,
        airAggressiveActions: this.airAggressiveActions,
        facingBetDecisions: this.facingBetDecisions,
        foldsFacingBet: this.foldsFacingBet,
        flopsSeen: this.flopsSeen,
        showdownsReached: this.showdownsReached,
        sizedActions: this.sizedActions,
        openingBets: this.openingBets,
        decisions: this.decisions,
      },
    };
  }
}

/**
 * A rate with no observations is 0, not NaN.
 *
 * Zero is honest here in a way NaN is not: it propagates through comparisons and averages
 * as a number, and every rate is reported next to the count it came from, so a reader can
 * see that the denominator was empty. A NaN would poison a Spearman correlation silently.
 */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

// ---------------------------------------------------------------------------
// Air detection: what makes an aggressive action a bluff
// ---------------------------------------------------------------------------

/**
 * True when these two cards make no pair or better with this board.
 *
 * Used to classify an aggressive action as a bluff, so it has to be computable at the
 * moment of the action, before the run-out is known. What it counts, precisely:
 *
 *   - a pocket pair, or a hole card whose rank appears on the board → not air
 *   - a straight or a flush that uses at least one hole card → not air
 *   - anything else, including every draw → air
 *
 * Two deliberate consequences, both stated rather than left to be discovered:
 *
 * 1. **Semi-bluffs count as bluffs.** A nut flush draw firing the flop is air by this
 *    definition, and that is the right reading of `traits.bluffFrequency` — "a hand that
 *    has little chance of winning at showdown". A draw that has not got there has none.
 * 2. **A hand the board makes for everybody is not showdown value.** If the board itself
 *    is a straight or a flush, this seat holds no edge it can bet, so the holding still
 *    counts as air.
 *
 * This is the observer's classification, not the policy's. It reads hole cards, which the
 * policy may only ever see for its own seat — measuring from outside the game is exactly
 * what an observer is for, and nothing here is handed back to a policy.
 */
export function holdingIsAir(holeCards: readonly [Card, Card], board: readonly Card[]): boolean {
  const [first, second] = holeCards;
  const highRank = rankIndexOf(first);
  const lowRank = rankIndexOf(second);
  if (highRank === lowRank) return false;

  const boardMask = rankMaskOf(board);
  if ((boardMask & (1 << highRank)) !== 0) return false;
  if ((boardMask & (1 << lowRank)) !== 0) return false;

  // Flush using a hole card: five or more of one suit, at least one of them held, and the
  // board not already showing five of that suit on its own.
  const boardSuits = [0, 0, 0, 0];
  for (const card of board) {
    const suit = suitIndexOf(card);
    boardSuits[suit] = (boardSuits[suit] ?? 0) + 1;
  }
  for (const card of holeCards) {
    const suit = suitIndexOf(card);
    const onBoard = boardSuits[suit] ?? 0;
    const held = suitIndexOf(first) === suit && suitIndexOf(second) === suit ? 2 : 1;
    if (onBoard < 5 && onBoard + held >= 5) return false;
  }

  // Straight using a hole card: present with the hole cards, absent without them.
  const combinedMask = boardMask | (1 << highRank) | (1 << lowRank);
  if (straightHigh(combinedMask) >= 0 && straightHigh(boardMask) < 0) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Declared versus observed
// ---------------------------------------------------------------------------

/**
 * The wire shape, for the profile card's "what it actually did" panel.
 *
 * Carries the UNCONDITIONAL rates on every axis, which is what a hand-history tracker reports
 * and therefore what a learner can check against their own session. That is deliberately not
 * the same set of numbers `compareToDeclared` uses: `aggressionFrequency` here averages over
 * every postflop turn and will read well below the card's figure, and `threeBetFrequency` here
 * is bounded by how often the model enters a pot at all. The conditional counterparts are on
 * `SeatSimulationStats` and are the ones the declared-versus-observed check compares, because
 * they are the quantities the traits declare. Both are true; they answer different questions,
 * and `ProfileStatsResponse.divergences` exists so the learner sees the second one alongside.
 */
export function toObservedStats(stats: SeatSimulationStats): ProfileObservedStats {
  return {
    handsObserved: stats.handsDealt,
    vpip: stats.vpip,
    pfr: stats.pfr,
    threeBetFrequency: stats.threeBetFrequency,
    aggressionFrequency: stats.aggressionFrequency,
    bluffFrequency: stats.bluffFrequency,
    wentToShowdown: stats.wentToShowdown,
    foldToBetFrequency: stats.foldToBetFrequency,
    averageBetSizeAsPotFraction: stats.averageBetSizeAsPotFraction,
    confidenceHalfWidth: stats.confidenceHalfWidth,
  };
}

/**
 * A trait axis that a simulation can actually measure, with the tolerance that counts as
 * agreement and the reason for it.
 *
 * Only seven of the sixteen axes appear. The other nine — `positionSensitivity`,
 * `sizingVariance`, `riskTolerance` and the rest — are real parameters that change real
 * decisions, but none of them is a frequency, so no single observed rate is the same kind
 * of number. Inventing a mapping for them would produce a table that looked complete and
 * compared nothing. They are tested by their effects (a position-sensitive profile's VPIP
 * differs by seat) rather than by a declared-versus-observed row.
 */
export interface ObservableAxis {
  readonly key: TraitKey;
  readonly declaredFrom: (traits: Traits) => number;
  readonly observedFrom: (stats: SeatSimulationStats) => number;
  /**
   * What the two numbers are, in one clause a learner can read.
   *
   * Required, and rendered in the divergence note, because four of the seven axes do not
   * compare the raw trait against a rate of the same name — `pfrShareOfVpip` is a ratio of two
   * measured rates, `betSizingPreference` is inverted through `preferredPotFraction`,
   * `threeBetTendency` is a multiplier read back through the share it produces, and
   * `aggressionFrequency` is conditioned on a neutral assessment. A sentence that says only
   * "declares X, measured Y" invites the reader to assume the obvious denominator, and
   * assuming the obvious denominator is how this file got two axes wrong.
   */
  readonly quantity: string;
  /** Absolute difference at which the two stop counting as agreeing. */
  readonly tolerance: number;
  /** Why the tolerance is what it is. Rendered in the divergence note. */
  readonly why: string;
}

/**
 * Tolerances, and where they come from.
 *
 * Two sources of slack, kept separate on purpose:
 *
 * **Sampling.** At 8,000 observations the 95% half-width on a proportion is at worst
 * `1.96 x 0.5 / sqrt(8000)` = 0.011. So anything above about 0.02 is not sampling noise.
 * Every tolerance below is larger than that, which means none of them is being used to
 * paper over a small sample — they are all describing how tightly the trait is coupled to
 * the statistic.
 *
 * **Coupling.** `vpip` and `pfrShareOfVpip` are thresholds the policy applies directly, so
 * they should land close. The other five are one step removed from what the policy scores,
 * and the tolerance has to be wide enough to say so honestly. Widening a tolerance to make a
 * test pass is the failure this comment exists to prevent: each number below is justified by
 * the trait's own documentation, and a profile that misses it is reported, not accommodated.
 *
 * **What a tolerance may never absorb: a mismatch of quantity.** Two of these axes used to
 * compare a trait against a rate conditioned differently from the trait's own definition, and
 * the wide tolerances that comparison needed were quietly doing the work of a definition.
 * That is the failure this list is most exposed to, because a plausible number over the wrong
 * condition looks like a small modelling error right up until the sign of the miss is the
 * same on every profile. It was, on both axes, on all twelve — see the module comment for the
 * arithmetic. The correction was to measure the declared quantity: neither tolerance was
 * widened, and the 3-bet one halved.
 */
export const OBSERVABLE_AXES: readonly ObservableAxis[] = [
  {
    key: 'vpip',
    declaredFrom: (traits) => traits.vpip,
    observedFrom: (stats) => stats.vpip,
    quantity: 'the share of the hands it was offered a preflop decision in that it entered voluntarily',
    tolerance: 0.05,
    why: 'the policy applies this trait directly as its preflop entry threshold, so the observed rate should track it closely; the slack covers positional widening and the blind structure, not sampling noise',
  },
  {
    key: 'pfrShareOfVpip',
    declaredFrom: (traits) => traits.pfrShareOfVpip,
    observedFrom: (stats) => (stats.vpip === 0 ? 0 : stats.pfr / stats.vpip),
    quantity: 'the share of the hands it entered that it raised rather than called',
    tolerance: 0.08,
    why: 'a ratio of two measured rates, so it carries both their errors; also shifts when a raise is not legally available',
  },
  {
    key: 'aggressionFrequency',
    declaredFrom: (traits) => traits.aggressionFrequency,
    observedFrom: (stats) => stats.neutralAggressionFrequency,
    quantity:
      'the share of the postflop turns on which it did not fold, a bet or raise was legal, and its own read of its hand was neutral, that it bet or raised rather than checked or called',
    tolerance: 0.18,
    why: 'the trait is the rate on a neutral hand assessment and the aggressive line’s alternative is the passive one, so the measurement conditions on the same band the policy scores against and leaves folding to foldToPressure, which is a declared trait with its own axis here; the slack covers the sampling error on that narrower denominator and the documented reasons a neutral hand still deviates — position, stack depth, pressure, a barrel after taking the lead, and a draw',
  },
  {
    key: 'bluffFrequency',
    declaredFrom: (traits) => traits.bluffFrequency,
    observedFrom: (stats) => stats.bluffFrequency,
    quantity:
      'the share of the postflop turns on which it held air and a bet or raise was legal that it bet or raised',
    tolerance: 0.2,
    why: 'depends on the observer’s definition of air, which counts semi-bluffs as bluffs',
  },
  {
    key: 'threeBetTendency',
    declaredFrom: threeBetRaiseShare,
    observedFrom: (stats) => stats.threeBetShareOfEntries,
    quantity:
      'the share of the openings it played back at that it re-raised rather than flat-called, which is the only frequency this multiplier declares',
    tolerance: 0.15,
    why: 'the trait is a multiplier on the range it would flat-call with, so the comparison runs through threeBetRaiseShare — the one mapping the policy applies — instead of reading a multiplier as a rate whose ceiling is a different declared number; the slack covers the sampling error on a few hundred entries and the exploit multiplier that widens or narrows the isolating range',
  },
  {
    key: 'foldToPressure',
    declaredFrom: (traits) => traits.foldToPressure,
    observedFrom: (stats) => stats.foldToBetFrequency,
    quantity: 'the share of the turns facing a bet, on any street, that it folded',
    tolerance: 0.25,
    why: 'the trait is about giving up a made hand; the observed rate includes every fold to a bet, most of which are hands that never had value. MEASURED 2026-08-27, so the reach of this row is not overstated: across the twelve profiles the declared values span 0.14-0.76 while the observed rate spans only 0.37-0.69, and the 0.25 tolerance is 78% of that observed range — so this row catches a profile that folds wildly unlike its card and very little else. Spearman rho between declared and observed is 0.601, against 1.000 for vpip and 0.937 for aggressionFrequency on the same runs. It is a bound, not a demonstration that the trait drives the behaviour, and it is listed beside two axes that do discriminate',
  },
  {
    key: 'betSizingPreference',
    declaredFrom: (traits) => traits.betSizingPreference,
    observedFrom: (stats) => inversePreferredPotFraction(stats.averageOpeningBetAsPotFraction),
    quantity: 'its mean OPENING bet as a fraction of the pot, read back onto the trait scale',
    tolerance: 0.18,
    why: 'inverted through preferredPotFraction and measured over OPENING bets only, because a raise pays the call as well as the increment and would score above the fraction the profile chose; the slack covers sizes the engine clamped to a minimum bet or an all-in',
  },
];

/**
 * The inverse of `preferredPotFraction`: pot fraction back to a 0..1 trait value.
 *
 * Clamped, because a measured average can land outside the 0.25..1.5 band the trait maps
 * onto — a stack too short to make the preferred size, or a minimum raise that the engine
 * forced upwards. Clamping keeps the comparison on the trait's own scale; the raw fraction
 * is still on `SeatSimulationStats` for anyone who wants it unclamped.
 */
export function inversePreferredPotFraction(potFraction: number): number {
  const raw = (potFraction - 0.25) / 1.25;
  return Math.min(1, Math.max(0, raw));
}

/** What the run measured, on the axes a run can measure. */
export function observedTraitEstimates(
  stats: SeatSimulationStats,
): readonly { readonly key: TraitKey; readonly observed: number }[] {
  return OBSERVABLE_AXES.map((axis) => ({ key: axis.key, observed: axis.observedFrom(stats) }));
}

export interface TraitDivergence {
  readonly key: TraitKey;
  readonly declared: number;
  readonly observed: number;
}

/**
 * Axes where the run disagrees with the profile card by more than the documented
 * tolerance.
 *
 * Compares against the profile's **declared** vector — the numbers on its card — so it is
 * the right check for a `realistic` or `expert` run. An `educational` run mutes every
 * trait towards the baseline by design (`expressTraits`), so divergence there is the
 * feature working, not a defect; pass the muted vector to `compareToDeclaredTraits` if
 * that is what you mean to test.
 *
 * An empty list is the claim "this model behaves the way its card says". That claim is
 * what `test/simulation/profile-differentiation.test.ts` exists to check.
 */
export function compareToDeclared(
  profileId: string,
  stats: SeatSimulationStats,
): { readonly divergences: readonly TraitDivergence[] } {
  return compareToDeclaredTraits(requireProfile(profileId).traits, stats);
}

/** As `compareToDeclared`, against an explicit trait vector (e.g. a muted difficulty). */
export function compareToDeclaredTraits(
  traits: Traits,
  stats: SeatSimulationStats,
): { readonly divergences: readonly TraitDivergence[] } {
  const divergences: TraitDivergence[] = [];
  for (const axis of OBSERVABLE_AXES) {
    const declared = axis.declaredFrom(traits);
    const observed = axis.observedFrom(stats);
    if (Math.abs(declared - observed) > axis.tolerance) {
      divergences.push({ key: axis.key, declared, observed });
    }
  }
  return { divergences };
}

/** A sentence naming a divergence and the tolerance it broke, for the profile card. */
export function describeDivergence(divergence: TraitDivergence): string {
  const axis = OBSERVABLE_AXES.find((candidate) => candidate.key === divergence.key);
  if (axis === undefined) throw new StatsError(`"${divergence.key}" is not a measurable axis`);
  const text =
    `On ${TRAIT_LABELS[divergence.key]}, measured as ${axis.quantity}, this model declares ` +
    `${format(divergence.declared)} and the simulation measured ${format(divergence.observed)}, ` +
    `further apart than the ${format(axis.tolerance)} this axis allows — ${axis.why}.`;
  assertNoImpersonation(text, 'describeDivergence');
  return text;
}

function format(value: number): string {
  return value.toFixed(3);
}

// ---------------------------------------------------------------------------
// The radar view
// ---------------------------------------------------------------------------

/**
 * Every trait as a ready-to-render radar axis, label and plain-language meaning included.
 *
 * Built by iterating the **wire** key list and indexing the trait-keyed records, which is
 * a compile-time proof that every wire key is a trait key. The length check closes the
 * other direction, so the two lists cannot drift apart without something failing loudly
 * rather than a radar chart quietly losing an axis.
 */
export function radarAxes(traits: Traits): readonly LegendTraitAxis[] {
  if (LEGEND_TRAIT_KEYS.length !== TRAIT_KEYS.length) {
    throw new StatsError(
      `the wire trait list has ${LEGEND_TRAIT_KEYS.length} keys and the trait vector has ` +
        `${TRAIT_KEYS.length}; @prl/contracts and traits.ts have drifted apart`,
    );
  }
  return LEGEND_TRAIT_KEYS.map((key) => ({
    key,
    label: TRAIT_LABELS[key],
    value: traits[key],
    description: TRAIT_DESCRIPTIONS[key],
  }));
}

// ---------------------------------------------------------------------------
// Tests of difference
// ---------------------------------------------------------------------------

export interface ProportionSample {
  readonly successes: number;
  readonly trials: number;
}

export interface TwoProportionResult {
  readonly z: number;
  readonly significantAt: (alpha: number) => boolean;
  readonly note: string;
}

/**
 * Two-proportion z-test. See the module comment for the derivation.
 *
 * The degenerate case is handled rather than divided by: when both samples are all
 * successes or all failures the pooled proportion is 0 or 1, the standard error is 0, and
 * there is no test to run. Returning `z = 0` with a note that says so is the honest
 * answer — the alternative is an Infinity that reads as overwhelming significance when in
 * fact the two samples are identical.
 */
export function twoProportionZTest(a: ProportionSample, b: ProportionSample): TwoProportionResult {
  validateSample(a, 'a');
  validateSample(b, 'b');

  const p1 = a.successes / a.trials;
  const p2 = b.successes / b.trials;
  const pooled = (a.successes + b.successes) / (a.trials + b.trials);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / a.trials + 1 / b.trials));

  if (standardError === 0) {
    const note =
      `Both samples are ${pooled === 0 ? 'entirely failures' : 'entirely successes'} ` +
      `(${a.successes}/${a.trials} and ${b.successes}/${b.trials}), so the pooled variance is zero ` +
      'and there is no difference to test.';
    assertNoImpersonation(note, 'twoProportionZTest');
    return { z: 0, significantAt: () => false, note };
  }

  const z = (p1 - p2) / standardError;
  const note =
    `${a.successes}/${a.trials} = ${format(p1)} against ${b.successes}/${b.trials} = ${format(p2)}; ` +
    `pooled ${format(pooled)}, standard error ${standardError.toFixed(5)}, z = ${z.toFixed(3)}. ` +
    'Two-sided, and it assumes the trials within each sample are independent — which holds for ' +
    'separately seeded simulated hands and would not hold for consecutive hands against an ' +
    'adapting opponent.';
  assertNoImpersonation(note, 'twoProportionZTest');

  return {
    z,
    significantAt: (alpha: number): boolean => Math.abs(z) > normalTwoSidedCriticalValue(alpha),
    note,
  };
}

function validateSample(sample: ProportionSample, which: string): void {
  if (!Number.isInteger(sample.trials) || sample.trials < 1) {
    throw new StatsError(`sample ${which} needs at least 1 trial, received ${String(sample.trials)}`);
  }
  if (!Number.isInteger(sample.successes) || sample.successes < 0) {
    throw new StatsError(
      `sample ${which} needs a non-negative whole number of successes, received ${String(sample.successes)}`,
    );
  }
  if (sample.successes > sample.trials) {
    throw new StatsError(`sample ${which} has ${sample.successes} successes in only ${sample.trials} trials`);
  }
}

/**
 * How far an observed proportion sits from an expected one, in standard errors.
 *
 * The expected proportion is treated as known rather than estimated, so the standard
 * error is `sqrt(p(1-p)/n)` with `p` the expectation — this is a goodness-of-fit check
 * against a policy's own declared probability, not a comparison of two samples. Used by
 * the "not scripted" test to check that a sampled action distribution matches the
 * distribution the policy said it was sampling from.
 */
export function proportionDeviationInSigmas(successes: number, trials: number, expected: number): number {
  validateSample({ successes, trials }, 'observed');
  if (!Number.isFinite(expected) || expected < 0 || expected > 1) {
    throw new StatsError(`expected must be a probability, received ${String(expected)}`);
  }
  if (expected === 0 || expected === 1) {
    // A degenerate expectation has no standard error. Either the observation matches it
    // exactly or it contradicts it outright, so report 0 or Infinity rather than NaN.
    const matches = successes === (expected === 0 ? 0 : trials);
    return matches ? 0 : Number.POSITIVE_INFINITY;
  }
  const standardError = Math.sqrt((expected * (1 - expected)) / trials);
  return Math.abs(successes / trials - expected) / standardError;
}

/**
 * Spearman's rank correlation, with ties handled properly.
 *
 * Implemented as the Pearson correlation of the two rank vectors, not as the textbook
 * shortcut `1 - 6 Σd² / (n³ - n)`. The shortcut is only correct when there are no ties;
 * with tied ranks it is wrong, and the amount it is wrong by depends on how many ties
 * there are, which is the worst possible failure mode for a number a test asserts on.
 * Averaging tied ranks and correlating handles both cases with one code path.
 *
 * @returns rho in [-1, 1]. Zero when either vector is constant, since a vector with no
 *          spread has no ordering to correlate — reported as 0 rather than NaN.
 */
export function spearmanRho(first: readonly number[], second: readonly number[]): number {
  if (first.length !== second.length) {
    throw new StatsError(
      `spearmanRho needs equal-length inputs, received ${first.length} and ${second.length}`,
    );
  }
  if (first.length < 2) throw new StatsError('spearmanRho needs at least 2 observations');

  const ranksA = averageRanks(first);
  const ranksB = averageRanks(second);
  const n = ranksA.length;
  const meanA = ranksA.reduce((sum, value) => sum + value, 0) / n;
  const meanB = ranksB.reduce((sum, value) => sum + value, 0) / n;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let index = 0; index < n; index++) {
    const a = (ranksA[index] ?? 0) - meanA;
    const b = (ranksB[index] ?? 0) - meanB;
    covariance += a * b;
    varianceA += a * a;
    varianceB += b * b;
  }
  if (varianceA === 0 || varianceB === 0) return 0;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/** Ranks, 1-based, with tied values sharing the average of the ranks they span. */
export function averageRanks(values: readonly number[]): number[] {
  const order = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);
  const ranks = new Array<number>(values.length).fill(0);
  let position = 0;
  while (position < order.length) {
    let end = position + 1;
    const current = order[position];
    if (current === undefined) break;
    while (end < order.length && order[end]?.value === current.value) end += 1;
    // Ranks are 1-based, so the span [position, end) covers ranks position+1 .. end.
    const averageRank = (position + 1 + end) / 2;
    for (let cursor = position; cursor < end; cursor++) {
      const entry = order[cursor];
      if (entry !== undefined) ranks[entry.index] = averageRank;
    }
    position = end;
  }
  return ranks;
}

/**
 * Profiles ordered by one observed statistic, strongest first, for the ordering test.
 *
 * Returns the values alongside the ids so a failing assertion can print the table that
 * produced it rather than just a correlation coefficient.
 */
export function rankByObserved(
  stats: readonly SeatSimulationStats[],
  pick: (entry: SeatSimulationStats) => number,
): readonly { readonly profileId: string; readonly value: number }[] {
  return stats
    .map((entry) => ({ profileId: entry.profileId, value: pick(entry) }))
    .sort((left, right) => right.value - left.value);
}

/**
 * Sums several runs of the same seat into one, for combining shards of a simulation.
 *
 * The zeroed accumulator is written out field by field rather than assembled through an index
 * signature. It costs the same lines the old version spent reading them back out with `?? 0`,
 * and it buys a compile error when a counter is added to `SeatSimulationCounts` and forgotten
 * here — where the previous shape combined a missing counter to a silent zero, which is the
 * worst available failure for a function whose entire job is to add things up.
 */
export function combineCounts(counts: readonly SeatSimulationCounts[]): SeatSimulationCounts {
  const total: Record<keyof SeatSimulationCounts, number> = {
    preflopOpportunities: 0,
    voluntaryEntries: 0,
    preflopRaiseHands: 0,
    threeBetOpportunities: 0,
    threeBets: 0,
    threeBetEntryOpportunities: 0,
    threeBetEntries: 0,
    threeBetEntryRaises: 0,
    aggressionOpportunities: 0,
    aggressiveActions: 0,
    neutralAggressionOpportunities: 0,
    neutralFolds: 0,
    neutralAggressiveActions: 0,
    airAggressionOpportunities: 0,
    airAggressiveActions: 0,
    facingBetDecisions: 0,
    foldsFacingBet: 0,
    flopsSeen: 0,
    showdownsReached: 0,
    sizedActions: 0,
    openingBets: 0,
    decisions: 0,
  };
  for (const entry of counts) {
    for (const key of COUNT_KEYS) total[key] += entry[key];
  }
  return total;
}

const COUNT_KEYS = [
  'preflopOpportunities',
  'voluntaryEntries',
  'preflopRaiseHands',
  'threeBetOpportunities',
  'threeBets',
  'threeBetEntryOpportunities',
  'threeBetEntries',
  'threeBetEntryRaises',
  'aggressionOpportunities',
  'aggressiveActions',
  'neutralAggressionOpportunities',
  'neutralFolds',
  'neutralAggressiveActions',
  'airAggressionOpportunities',
  'airAggressiveActions',
  'facingBetDecisions',
  'foldsFacingBet',
  'flopsSeen',
  'showdownsReached',
  'sizedActions',
  'openingBets',
  'decisions',
] as const satisfies readonly (keyof SeatSimulationCounts)[];

/** The pot fraction a trait vector prefers, re-exported so callers need one import. */
export { preferredPotFraction };
