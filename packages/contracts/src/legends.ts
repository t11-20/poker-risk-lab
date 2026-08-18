/**
 * Wire types for the "Play a Legend" learning mode.
 *
 * ## The shape enforces the guardrails
 *
 * Two things in this file are load-bearing rather than decorative:
 *
 * 1. **`ProfileDisclosureDto.disclaimers` is a required, non-empty array.** There is no
 *    way to serialise a profile without the framing that says it is an educational
 *    simulation and not a real person. A component that renders `displayName` and drops
 *    `disclaimers` is visibly wrong in review rather than quietly non-compliant.
 *
 * 2. **Commentary is `modelPreference`, not `thought`.** Every explanatory string in this
 *    file is named and typed as a statement about *the model's* preference. There is no
 *    field anywhere that could hold "what the player was thinking", because the type
 *    system is a better guardrail than a code-review convention.
 *
 * ## Outcome is never quality
 *
 * `HandComparison` carries `chipResult` and `decisionQuality` as separate, unrelated
 * fields, and `decisionQuality` is computed from the maths before the run-out is known.
 * A play that lost is not marked wrong, and a play that won is not marked right. That
 * separation is the single most important educational property of this feature.
 */

import type { CoachReport } from './api-types.ts';

/** The 16 trait axes, mirrored from `@prl/poker-ai` for the wire. */
export const LEGEND_TRAIT_KEYS = [
  'vpip',
  'pfrShareOfVpip',
  'aggressionFrequency',
  'bluffFrequency',
  'positionSensitivity',
  'threeBetTendency',
  'betSizingPreference',
  'sizingVariance',
  'valueBluffBalance',
  'pressureTendency',
  'stackDepthAdjustment',
  'tournamentOrientation',
  'riskTolerance',
  'exploitativeAdaptation',
  'foldToPressure',
  'barrelPersistence',
] as const;

export type LegendTraitKey = (typeof LEGEND_TRAIT_KEYS)[number];

export type LegendTraits = Readonly<Record<LegendTraitKey, number>>;

export type LegendDifficulty = 'educational' | 'realistic' | 'expert';

/** How opponent names are shown. `archetype` is the production default. */
export type LegendNamingMode = 'archetype' | 'attributed';

export interface ProfileDisclosureDto {
  readonly displayName: string;
  readonly archetypeName: string;
  readonly tagline: string;
  /** True when an attributed name is being shown. */
  readonly attributed: boolean;
  /**
   * Required and never empty. The UI must render these with the profile — see the
   * module comment for why this is a type-level guarantee rather than a convention.
   */
  readonly disclaimers: readonly string[];
  readonly shortLabel: string;
}

export interface LegendTraitAxis {
  readonly key: LegendTraitKey;
  readonly label: string;
  readonly value: number;
  /** Plain-language meaning, written so a high value never reads as "better". */
  readonly description: string;
}

export interface LegendProfileCardDto {
  readonly id: string;
  readonly disclosure: ProfileDisclosureDto;
  readonly traits: LegendTraits;
  /** Ready-to-render radar axes, labels and descriptions included. */
  readonly axes: readonly LegendTraitAxis[];
  readonly learnFrom: readonly string[];
  readonly styleNotes: readonly string[];
  readonly counterStrategy: readonly string[];
  /** An honest sentence about where the parameters came from. */
  readonly modelBasis: string;
  readonly signatureTraits: readonly LegendTraitKey[];
  readonly bestFor: 'heads-up' | 'six-max' | 'both';
}

export interface LegendDifficultyDto {
  readonly id: LegendDifficulty;
  readonly label: string;
  readonly description: string;
  /** Whether the Coach panel is available during play at this difficulty. */
  readonly coachAvailable: boolean;
}

export interface LegendProfilesResponse {
  readonly namingMode: LegendNamingMode;
  readonly profiles: readonly LegendProfileCardDto[];
  readonly difficulties: readonly LegendDifficultyDto[];
  /** Shown once at the top of the selector, above every individual profile. */
  readonly universalDisclaimer: string;
}

// ---------------------------------------------------------------------------
// Starting a match
// ---------------------------------------------------------------------------

export interface CreateLegendMatchRequest {
  /** One profile id for heads-up, up to five for a table. */
  readonly profileIds: readonly string[];
  readonly difficulty: LegendDifficulty;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  /**
   * Fixes the deal so a session is reproducible for teaching. Optional; a match without
   * one is dealt from the CSPRNG like any other.
   */
  readonly deterministicSeed?: number;
}

export interface CreateLegendMatchResponse {
  /** The match runs as an ordinary private room, so the table UI is unchanged. */
  readonly roomId: string;
  readonly seats: readonly {
    readonly seat: number;
    readonly profileId: string;
    readonly disclosure: ProfileDisclosureDto;
  }[];
  readonly difficulty: LegendDifficultyDto;
}

// ---------------------------------------------------------------------------
// Post-hand comparison — the educational core of the mode
// ---------------------------------------------------------------------------

/**
 * Why the model chose what it chose.
 *
 * Named `modelPreference` throughout, deliberately. Every string here describes the
 * model. None of them may describe a person's mental state; `@prl/poker-ai/labelling`
 * rejects such text before it can reach this type.
 */
export interface ModelReasoning {
  /** e.g. "this model prefers a larger bet here". Always third-person, always the model. */
  readonly modelPreference: string;
  /** The trait axes that drove this decision, with their values. */
  readonly drivingTraits: readonly {
    readonly key: LegendTraitKey;
    readonly label: string;
    readonly value: number;
  }[];
  /** How the decision would differ at a different position, stack depth, or price. */
  readonly whatChangedIt: readonly string[];
  /**
   * The probability the policy assigned to each action before sampling. Exposed because
   * the styles are probabilistic, not scripted: the same spot does not always produce
   * the same action, and a learner should be able to see that directly.
   */
  readonly actionProbabilities: readonly { readonly action: string; readonly probability: number }[];
}

/** How a decision looked on the maths, computed before the run-out was known. */
export interface DecisionQuality {
  /** Best available EV among the legal actions, in units. */
  readonly bestAvailableEv: number;
  /** EV of the action actually taken. */
  readonly chosenEv: number;
  /** `chosenEv - bestAvailableEv`, so 0 is the best available and negative is a cost. */
  readonly evGivenUp: number;
  /**
   * A qualitative band, because a precise score would imply more certainty than the
   * model has. Never a grade or a mark.
   */
  readonly band: 'consistent-with-analysis' | 'slightly-off' | 'materially-off';
  readonly note: string;
}

export interface ComparedDecision {
  readonly sequence: number;
  readonly street: string;
  readonly potBefore: number;
  readonly toCall: number;

  /** What the learner did. Null when this decision was not theirs. */
  readonly userAction: { readonly action: string; readonly to: number | null } | null;
  /** What the model did, and why. Null when the model was not the actor. */
  readonly modelAction: { readonly action: string; readonly to: number | null } | null;
  readonly modelReasoning: ModelReasoning | null;

  /** The maths at this decision point, computed at review time. */
  readonly analysis: CoachReport | null;

  /**
   * Other actions that were available, with their EV. Lets a learner see the shape of
   * the decision rather than a verdict on it.
   */
  readonly alternatives: readonly {
    readonly action: string;
    readonly to: number | null;
    readonly ev: number;
    readonly note: string;
  }[];

  /** Quality of the learner's decision, from the maths only. */
  readonly userDecisionQuality: DecisionQuality | null;

  /** Decision-by-decision commentary for the replay view. */
  readonly commentary: string;
}

export interface HandComparison {
  readonly handId: string;
  readonly handNumber: number;
  readonly board: readonly string[];
  readonly decisions: readonly ComparedDecision[];

  /**
   * Net chips for the learner. Kept structurally separate from every quality field, and
   * the summary text must never explain one by the other.
   */
  readonly chipResult: number;
  /**
   * The learner's aggregate decision quality across the hand, computed from the maths
   * with no reference to the result.
   */
  readonly decisionQuality: DecisionQuality;
  /**
   * Present whenever the result and the decision quality point in opposite directions —
   * a well-played hand that lost, or a badly-played hand that won. This is the mode's
   * most valuable teaching moment, so it is a first-class field rather than an
   * afterthought.
   */
  readonly outcomeVersusQualityNote: string | null;
  readonly profileId: string;
  readonly disclosure: ProfileDisclosureDto;
}

// ---------------------------------------------------------------------------
// "What can I learn from this player?"
// ---------------------------------------------------------------------------

/**
 * What an `observed` block actually measured — the label that makes it not a fabrication.
 *
 * This exists because the difference is the whole point. "This model entered 32% of pots" is a
 * true and useful sentence about a simulation and a false one about a session that never
 * happened, and once the numbers are on screen the two are indistinguishable. A page shipped
 * claiming "Measured over 128 hands of your own play" over constants; the fix is not better copy
 * but a field that makes the claim checkable, so a screen cannot render the figures without
 * having been handed the statement of what they are.
 *
 * Optional rather than required, and for a stated reason: `learnFromSummary` in `@prl/poker-ai`
 * builds this response and knows nothing about where its caller got the observations, so a
 * required field would force a producer to invent an answer. Absent means the same as null —
 * unlabelled — and an unlabelled `observed` must not be rendered as anybody's play.
 */
export type ObservedBasis =
  | {
      readonly kind: 'your-play';
      /** How many of the reader's own hands the frequencies were measured over. */
      readonly handsObserved: number;
    }
  | {
      readonly kind: 'simulation';
      /** The setting the model was expressed at while it played. */
      readonly difficulty: LegendDifficulty;
      /** The opponent it played against. Heads-up, so a style is not blended with a table. */
      readonly referenceProfileId: string;
      readonly referenceName: string;
      /** The whole run reproduces from this integer. */
      readonly seed: number;
    };

export interface LearnFromProfileResponse {
  readonly profileId: string;
  readonly disclosure: ProfileDisclosureDto;
  readonly learnFrom: readonly string[];
  readonly counterStrategy: readonly string[];
  /**
   * Observed frequencies from the learner's own session against this profile, so the declared
   * traits can be checked against what actually happened. Null until enough hands have been
   * played to say anything.
   *
   * Still null in this build, and the reasons are recorded rather than hidden, because "null"
   * and "we never wired it up" look identical from here:
   *
   *  - `room_members.bot_profile` accepts five legacy names plus `unknown`, so the durable rows
   *    cannot say which of the twelve profiles sat in a seat for seven of them;
   *  - `ProfileObservedStats.bluffFrequency` asks whether a bet was made with a hand that could
   *    not win, which no observer on the other side of the table can see;
   *  - `@prl/poker-ai`'s observer needs `raiseWasAvailable` per turn and says never to guess it;
   *    the persisted action log has no column for it.
   *
   * What a large deterministic simulation of the model did IS measurable and is served, under a
   * name that says so, by `ProfileStatsResponse`. It is not put here, because the prose
   * `learnFromSummary` generates from this field says "across N hands you have seen", and that
   * sentence is false about a simulation.
   */
  readonly observed: ProfileObservedStats | null;
  /** What `observed` measured. Absent or null means unlabelled, which means do not render it. */
  readonly observedBasis?: ObservedBasis | null;
  /** How this profile contrasts with others, on the axes where they differ most. */
  readonly contrasts: readonly {
    readonly otherProfileId: string;
    readonly otherDisplayName: string;
    readonly differences: readonly {
      readonly key: LegendTraitKey;
      readonly label: string;
      readonly delta: number;
    }[];
  }[];
}

/** Frequencies measured from simulated or played hands, not declared traits. */
export interface ProfileObservedStats {
  readonly handsObserved: number;
  readonly vpip: number;
  readonly pfr: number;
  readonly threeBetFrequency: number;
  readonly aggressionFrequency: number;
  readonly bluffFrequency: number;
  readonly wentToShowdown: number;
  readonly foldToBetFrequency: number;
  readonly averageBetSizeAsPotFraction: number;
  /**
   * Sampling error on the frequencies above, so a learner does not over-read 40 hands.
   * Present because the whole app teaches that a small sample says little.
   */
  readonly confidenceHalfWidth: number;
}

export interface ProfileStatsResponse {
  readonly profileId: string;
  readonly disclosure: ProfileDisclosureDto;
  /** What the profile declares. */
  readonly declaredTraits: LegendTraits;
  /** What a large deterministic simulation actually produced. */
  readonly simulated: ProfileObservedStats;
  readonly simulationHands: number;
  readonly simulationSeed: number;
  /** The setting the model was expressed at. `divergences` is only meaningful against this. */
  readonly simulationDifficulty: LegendDifficulty;
  /** Who it played. Heads-up, so an observed rate is not a blend of the whole table's behaviour. */
  readonly referenceProfileId: string;
  readonly referenceName: string;
  /**
   * Axes where the simulation disagrees materially with the declared trait. Surfaced
   * rather than hidden: a model whose behaviour does not match its own card is a defect,
   * and showing it is how it gets fixed.
   *
   * ## `note` is the only safe thing to render, and that is not a style preference
   *
   * Four of the seven measurable axes do not compare a trait against a rate of the same name:
   * `aggressionFrequency` is declared on a NEUTRAL hand assessment, `threeBetTendency` is a
   * multiplier read back through the share it produces, `pfrShareOfVpip` is a ratio of two
   * measured rates, and `betSizingPreference` is inverted through `preferredPotFraction`. A
   * consumer that paired `declared` against the like-named field of `simulated` would be
   * comparing two different quantities and would print "this model is not behaving the way its
   * card describes" under every profile, permanently — a false accusation produced by a units
   * error, and the exact defect `@prl/poker-ai/stats` was corrected for.
   *
   * So the sentence is authored server-side by `describeDivergence`, which names the quantity it
   * is talking about, and the raw pair is carried for anyone auditing the figure rather than for
   * a UI to recombine.
   */
  readonly divergences: readonly {
    readonly key: LegendTraitKey;
    readonly declared: number;
    readonly observed: number;
    /** One sentence naming both quantities, the tolerance broken, and why the axis is measured that way. */
    readonly note: string;
  }[];
}

// ---------------------------------------------------------------------------
// Scenario mode: the same spot against several profiles
// ---------------------------------------------------------------------------

/**
 * The most trials `POST /legends/compare` will run per profile.
 *
 * On the wire because a client has to know it. The compare screen asked for 400 against a schema
 * whose maximum is 40, so every request it could ever have made was `invalid_request` before it
 * reached a handler — a second, independent reason that screen showed a bundled sample, sitting
 * behind the first one and invisible while the first one held.
 *
 * `MAX_COMPARE_TRIALS` in `apps/api/src/rooms/bots.ts` is the authority: it is what the schema and
 * the clamp are built from. This is the copy a client compiles against, and
 * `apps/api/test/legend-fixture-figures.test.ts` asserts the two are equal, so they cannot drift.
 *
 * Forty is a coarse sample, deliberately: the widest 95% interval on a proportion over forty
 * trials is about 15 points. A screen showing these distributions has to print that.
 */
export const MAX_COMPARE_TRIALS = 40;

export interface CompareProfilesRequest {
  /** A Scenario Lab scenario id, or an ad-hoc situation. */
  readonly scenarioId?: string;
  readonly situation?: {
    readonly heroCards: string;
    readonly board?: string;
    readonly pot: number;
    readonly toCall: number;
    readonly heroStack: number;
    readonly opponentStack: number;
    readonly bigBlind: number;
    readonly street: 'preflop' | 'flop' | 'turn' | 'river';
  };
  readonly profileIds: readonly string[];
  readonly difficulty: LegendDifficulty;
  /** Trials per profile, since the policies are probabilistic. */
  readonly trials?: number;
}

export interface ProfileComparisonEntry {
  readonly profileId: string;
  readonly disclosure: ProfileDisclosureDto;
  /** Distribution over actions across the trials — these styles are not scripted. */
  readonly actionDistribution: readonly {
    readonly action: string;
    readonly probability: number;
    readonly medianSizeToPotFraction: number | null;
  }[];
  readonly modalAction: string;
  readonly reasoning: ModelReasoning;
}

export interface CompareProfilesResponse {
  /** The maths for the situation, identical for every profile. */
  readonly analysis: CoachReport;
  readonly entries: readonly ProfileComparisonEntry[];
  readonly trials: number;
  /**
   * What the spread across profiles teaches. Written to point at the *disagreement*,
   * because two strong styles differing on the same spot is the lesson.
   */
  readonly takeaway: string;
}
