/**
 * Wire types for the "Play a Legend" learning mode.
 * `ProfileDisclosureDto.disclaimers` is required and non-empty, so no profile serialises without the
 * framing that it is an educational simulation. Commentary is typed as `modelPreference`, so no field
 * can hold what a person was thinking. `HandComparison` keeps `chipResult` apart from
 * `decisionQuality`, which comes from the maths before the run-out is known.
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
  /** Required and never empty. The UI renders these with the profile. */
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

export interface CreateLegendMatchRequest {
  /** One profile id for heads-up, up to five for a table. */
  readonly profileIds: readonly string[];
  readonly difficulty: LegendDifficulty;
  readonly startingStack: number;
  readonly smallBlind: number;
  readonly bigBlind: number;
  readonly ante?: number;
  /** Fixes the deal so a session is reproducible. Without it the deal comes from the CSPRNG. */
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

/**
 * Why the model chose what it chose. Every string describes the model, never a person's mental
 * state, and `@prl/poker-ai/labelling` rejects such text.
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
  /** The policy's probability for each action before sampling, since styles are not scripted. */
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
  /** A qualitative band, never a grade, because a score would imply more certainty than the model has. */
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

  /** Other available actions with their EV, to show the shape of the decision. */
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

  /** Net chips for the learner. The summary never explains this by the quality fields or vice versa. */
  readonly chipResult: number;
  /** Aggregate decision quality, from the maths with no reference to the result. */
  readonly decisionQuality: DecisionQuality;
  /** Present when the result and the decision quality point in opposite directions. */
  readonly outcomeVersusQualityNote: string | null;
  readonly profileId: string;
  readonly disclosure: ProfileDisclosureDto;
}

/**
 * What an `observed` block measured, so simulated figures are never shown as the reader's own play.
 * Optional because `learnFromSummary` does not know where its observations came from. Absent means
 * null, which means unlabelled, and unlabelled figures must not be rendered as anybody's play.
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
   * Frequencies from the learner's own session against this profile. Always null in this build:
   * `room_members.bot_profile` cannot name seven of the twelve profiles, `bluffFrequency` needs cards
   * no observer sees, and the action log has no `raiseWasAvailable` column. Simulated figures are in
   * `ProfileStatsResponse`, because `learnFromSummary` prose says "across N hands you have seen".
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
  /** Sampling error on the frequencies above, so a learner does not over-read a small sample. */
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
   * Axes where the simulation disagrees materially with the declared trait.
   * Render only `note`. Four of the seven axes do not compare a trait with the like-named rate
   * (`aggressionFrequency`, `threeBetTendency`, `pfrShareOfVpip`, `betSizingPreference`), so pairing
   * `declared` with `simulated` is a units error. `describeDivergence` writes `note`, and the raw
   * pair is for auditing.
   */
  readonly divergences: readonly {
    readonly key: LegendTraitKey;
    readonly declared: number;
    readonly observed: number;
    /** One sentence naming both quantities, the tolerance broken, and why the axis is measured that way. */
    readonly note: string;
  }[];
}

/**
 * The most trials `POST /legends/compare` runs per profile. `MAX_COMPARE_TRIALS` in
 * `apps/api/src/rooms/bots.ts` is the authority, and `legend-fixture-figures.test.ts` asserts they
 * are equal. The widest 95% interval on a proportion over 40 trials is about 15 points, and a screen
 * showing these distributions must print that.
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
  /** Distribution over actions across the trials. */
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
  /** What the spread across profiles teaches. Points at the disagreement between styles. */
  readonly takeaway: string;
}
