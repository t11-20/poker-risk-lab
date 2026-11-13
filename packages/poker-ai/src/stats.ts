/**
 * Measures what the profiles did in simulation and tests whether two of them differ. `traits.ts`
 * declares each profile, and `compareToDeclared` checks the declaration against a run.
 *
 * Every rate states its denominator. `vpip` and `pfr` are over preflop decisions offered, not hands
 * dealt, because a blind seat often never acts and that would measure button rotation.
 *
 * A trait is compared on the condition it is declared on. `aggressionFrequency` is measured on a
 * neutral assessment, with folds left to `foldToPressure`. Unconditionally the mean signed error was
 * -0.095 and six profiles could not reach their card. Conditioned, it is -0.004. `threeBetTendency`
 * is a multiplier, so it is compared through `threeBetRaiseShare`.
 *
 * The z-test pools the samples, because under the null the two rates are equal:
 *
 *     p = (x1 + x2) / (n1 + n2),   se = sqrt(p(1-p) (1/n1 + 1/n2)),   z = (p1 - p2) / se
 *
 * The critical value comes from `normalQuantile` in `@prl/poker-math` (Acklam, relative error below
 * 1.15e-9). `netChips` and `bbPer100` are results. Nothing here scores a decision.
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

/**
 * The two-sided critical value, the `z` with `Phi(z) = 1 - alpha/2`. Writing `normalQuantile(1 - alpha)`
 * by mistake halves every significance claim. Pinned against 1.9600, 2.5758, 3.2905 and 0.6745.
 */
export function normalTwoSidedCriticalValue(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new StatsError(`alpha must be strictly between 0 and 1, received ${String(alpha)}`);
  }
  return normalQuantile(1 - alpha / 2);
}

/** 1.959963…, the multiplier for a 95% interval. Computed rather than typed in. */
const Z_95 = normalTwoSidedCriticalValue(0.05);

/** Raw counts behind every rate, because a z-test needs successes and trials, not a rounded rate. */
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
   * Of those, the seat's first voluntary preflop decision. `threeBetTendency` gates only that entry
   * decision. A later turn facing a four-bet is priced on equity.
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
   * Of those, the turns with a neutral assessment (`NEUTRAL_ASSESSMENT_BAND` in `policy.ts`). Zero
   * when a stand-in published no assessment.
   */
  readonly neutralAggressionOpportunities: number;
  /**
   * Of those, turns on which it folded. Removed from the rate's denominator, because folding is
   * `foldToPressure` and `scoreAggression` normalises over passive and aggressive only. Leaving folds
   * in read 0.03 low on average and 0.045 low on the highest-`foldToPressure` profile.
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
  /**
   * Turns facing a bet OTHER than the preflop entry decision: the ones `scoreFold` prices, and so
   * the only ones `foldToPressure` can move. See `pricedFoldToBetFrequency`.
   */
  readonly pricedFacingBetDecisions: number;
  /** Of those, turns on which it folded. */
  readonly pricedFoldsFacingBet: number;
  /** Hands in which it still held cards when the flop was dealt. */
  readonly flopsSeen: number;
  /** Hands in which it actually showed its hand at showdown. */
  readonly showdownsReached: number;
  /** Postflop bets and raises whose size went into the sizing average. */
  readonly sizedActions: number;
  /**
   * Of those, the OPENING bets. A raise also pays the call, so it scores above the chosen fraction.
   * The trait axis uses opening bets only. `averageBetSizeAsPotFraction` pools both, like a tracker.
   */
  readonly openingBets: number;
  /** Every turn this seat took, all streets. Sanity check on the harness. */
  readonly decisions: number;
}

/**
 * One seat's behaviour across a run, with each field's denominator:
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
 * | pricedFoldToBetFrequency     | folds facing a bet               | those turns, less the        |
 *                                                                     preflop entry decision      |
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
   * The share of entered openings it re-raised rather than flat-called, which the trait comparison
   * uses. `threeBetFrequency` is the unconditional tracker rate.
   */
  readonly threeBetShareOfEntries: number;
  readonly aggressionFrequency: number;
  /** `aggressionFrequency` on a neutral assessment, the quantity the card declares. */
  readonly neutralAggressionFrequency: number;
  readonly bluffFrequency: number;
  readonly wentToShowdown: number;
  readonly foldToBetFrequency: number;
  /**
   * Folds facing a bet, excluding the preflop entry decision, which `decide` gives to the `vpip` plan.
   * `foldToBetFrequency` includes it and ranked the profiles in reverse `vpip` order (rho -1.000 over
   * 8,000 hands, 2026-11-11). Printed by the simulation suite and asserted by nothing.
   */
  readonly pricedFoldToBetFrequency: number;
  readonly averageBetSizeAsPotFraction: number;
  /** The same average over OPENING bets only, the quantity `betSizingPreference` declares. */
  readonly averageOpeningBetAsPotFraction: number;
  readonly netChips: number;
  readonly bbPer100: number;
  /**
   * 95% half-width over `handsDealt` at the worst case p = 0.5. One conservative number, so a learner
   * sees how little a small sample says.
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
   * The model's own relative-strength assessment, 0..1, or null when it published none.
   * `holdingIsAir` cannot stand in, because air is a showdown classification and neutral is a read.
   */
  readonly assessedRelativeStrength: number | null;
}

export interface HandOutcomeObservation {
  /** True when the seat still held cards at the moment the flop was dealt. */
  readonly sawFlop: boolean;
  /** True when the seat's cards were actually shown at showdown. */
  readonly showedDown: boolean;
  /** Net chips for the seat across the hand: winnings minus everything committed. */
  readonly netChips: number;
}

/**
 * One accumulator per seat per run. `beginHand` and `endHand` make the per-hand resets explicit.
 * Fields are assigned in the constructor because `erasableSyntaxOnly` forbids parameter properties.
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
  pricedFacingBetDecisions = 0;
  pricedFoldsFacingBet = 0;
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

  /** Called for every turn this seat took, in order. */
  noteDecision(observation: DecisionObservation): void {
    if (!this.handOpen) throw new StatsError(`seat ${this.seat}: noteDecision outside a hand`);
    this.decisions += 1;
    const aggressive = observation.action === 'bet' || observation.action === 'raise';
    // Read before `notePreflop`, whose latch ends the entry decision.
    const isEntryDecision = observation.street === 'preflop' && !this.enteredVoluntarily;

    if (observation.street === 'preflop') this.notePreflop(observation, aggressive);
    else this.notePostflop(observation, aggressive);

    // Every street: the fold-to-bet rate is about facing a price, wherever that happens.
    if (observation.toCall > 0) {
      this.facingBetDecisions += 1;
      if (observation.action === 'fold') this.foldsFacingBet += 1;
      if (!isEntryDecision) {
        this.pricedFacingBetDecisions += 1;
        if (observation.action === 'fold') this.pricedFoldsFacingBet += 1;
      }
    }
  }

  private notePreflop(observation: DecisionObservation, aggressive: boolean): void {
    this.hadPreflopTurn = true;
    const entering = observation.action === 'call' || aggressive;
    // The first voluntary preflop decision is the entry decision. Read before the latch below.
    const isEntryDecision = !this.enteredVoluntarily;
    // Checking the big blind option is not voluntary, because those chips were forced in.
    if (entering) this.enteredVoluntarily = true;
    if (aggressive) this.raisedPreflop = true;
    // A 3-bet spot needs a re-raise to be legal. After a short all-in it is not.
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
      pricedFoldToBetFrequency: ratio(this.pricedFoldsFacingBet, this.pricedFacingBetDecisions),
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
        pricedFacingBetDecisions: this.pricedFacingBetDecisions,
        pricedFoldsFacingBet: this.pricedFoldsFacingBet,
        flopsSeen: this.flopsSeen,
        showdownsReached: this.showdownsReached,
        sizedActions: this.sizedActions,
        openingBets: this.openingBets,
        decisions: this.decisions,
      },
    };
  }
}

/** An empty denominator gives 0, not NaN, because NaN would silently poison a Spearman correlation. */
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * True when these two cards make no pair or better with this board. Not air means a pocket pair, a
 * hole card paired on the board, or a straight or flush that uses a hole card. Semi-bluffs therefore
 * count as bluffs, and a straight or flush the board makes alone is still air.
 * This is the observer's classification. It reads hole cards and is never handed to a policy.
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

/**
 * The wire shape for the profile card. It carries the unconditional tracker rates, which a learner
 * can check against their own session. `compareToDeclared` uses the conditional rates instead.
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
 * A trait axis a simulation can measure. Seven of the sixteen appear. The others are not frequencies,
 * so they are tested by their effects instead.
 */
export interface ObservableAxis {
  readonly key: TraitKey;
  readonly declaredFrom: (traits: Traits) => number;
  readonly observedFrom: (stats: SeatSimulationStats) => number;
  /**
   * What the two numbers are, in one clause a learner can read. Required because four axes do not
   * compare the trait against a rate of the same name.
   */
  readonly quantity: string;
  /** Absolute difference at which the two stop counting as agreeing. */
  readonly tolerance: number;
  /** Why the tolerance is what it is. Rendered in the divergence note. */
  readonly why: string;
}

/**
 * At 8,000 observations the worst-case 95% half-width is 1.96 x 0.5 / sqrt(8000) = 0.011, so each
 * tolerance describes how tightly the trait couples to the statistic, not sampling noise. `vpip` and
 * `pfrShareOfVpip` are applied directly and land close. A tolerance never absorbs a mismatch of
 * quantity, and a profile that misses is reported, not accommodated.
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
    why: 'a bound on hand selection, not a measurement of this trait. MEASURED 2026-11-11 on the simulation suite’s 8,000-hand sweep: the observed rate ranks the twelve profiles in exactly the reverse order of their observed vpip, because every hand has a preflop entry decision facing a bet, the policy decides it from vpip, and foldToPressure never touches it. Spearman rho against the declared trait is 0.599. On the turns the trait does act on (pricedFoldToBetFrequency) rho is 0.361 and the observed rates span 0.165-0.301 against declared 0.14-0.76, so the trait is a weight on folding rather than a frequency, and the 0.25 band could not hold on that rate. calling-station, declared lowest at 0.14, folds the second-most there, at 0.275: continueAppetite is the same function of equity for every profile, so a hand below the price folds whatever this trait says, and the profiles that fold least are the aggressive ones, which raise instead. The row is kept so a profile folding wildly unlike every other still fails',
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
 * The inverse of `preferredPotFraction`, clamped to 0..1 because a measured average can fall outside
 * the 0.25..1.5 band (short stacks, forced minimum raises).
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
 * Axes where the run disagrees with the declared card by more than the tolerance, for `realistic` or
 * `expert` runs. An `educational` run mutes traits by design, so pass the muted vector to
 * `compareToDeclaredTraits`.
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

/**
 * Every trait as a radar axis. Iterating the wire keys proves each is a trait key at compile time,
 * and the length check covers the other direction.
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
 * Two-proportion z-test with a pooled proportion. When the standard error is 0 it returns `z = 0`
 * with a note, not an Infinity that would read as overwhelming significance.
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
 * Goodness of fit against a known expected proportion, in standard errors `sqrt(p(1-p)/n)`. The
 * "not scripted" test checks sampled actions against the declared distribution with it.
 */
export function proportionDeviationInSigmas(successes: number, trials: number, expected: number): number {
  validateSample({ successes, trials }, 'observed');
  if (!Number.isFinite(expected) || expected < 0 || expected > 1) {
    throw new StatsError(`expected must be a probability, received ${String(expected)}`);
  }
  if (expected === 0 || expected === 1) {
    // A degenerate expectation has no standard error, so report 0 or Infinity rather than NaN.
    const matches = successes === (expected === 0 ? 0 : trials);
    return matches ? 0 : Number.POSITIVE_INFINITY;
  }
  const standardError = Math.sqrt((expected * (1 - expected)) / trials);
  return Math.abs(successes / trials - expected) / standardError;
}

/**
 * Spearman's rho as the Pearson correlation of average ranks, because the `1 - 6 Σd² / (n³ - n)`
 * shortcut is wrong with ties. Returns 0 when either vector is constant.
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

/** Profiles ordered by one observed statistic, strongest first, with values for failure output. */
export function rankByObserved(
  stats: readonly SeatSimulationStats[],
  pick: (entry: SeatSimulationStats) => number,
): readonly { readonly profileId: string; readonly value: number }[] {
  return stats
    .map((entry) => ({ profileId: entry.profileId, value: pick(entry) }))
    .sort((left, right) => right.value - left.value);
}

/**
 * Sums several runs of the same seat. The zeroed accumulator is written out so a new counter in
 * `SeatSimulationCounts` is a compile error here, not a silent zero.
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
    pricedFacingBetDecisions: 0,
    pricedFoldsFacingBet: 0,
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
  'pricedFacingBetDecisions',
  'pricedFoldsFacingBet',
  'flopsSeen',
  'showdownsReached',
  'sizedActions',
  'openingBets',
  'decisions',
] as const satisfies readonly (keyof SeatSimulationCounts)[];

/** The pot fraction a trait vector prefers, re-exported so callers need one import. */
export { preferredPotFraction };
