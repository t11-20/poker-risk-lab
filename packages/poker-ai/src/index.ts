/**
 * `@prl/poker-ai` — educational opponent strategy profiles.
 *
 * The package's `exports` map publishes this entry point and nothing else, so this list is
 * the package's whole public surface. It existed only as a promise in `package.json` until
 * now: without this file there is no `dist/index.js`, and `import ... from '@prl/poker-ai'`
 * cannot resolve at all. Added by the rooms/WebSocket work, which is the first consumer.
 *
 * ## Why every export is named rather than `export *`
 *
 * The same reason `@prl/poker-math` gives: a wildcard hides what the package publishes and
 * silently breaks when two modules export the same name. Two of them do here, and writing
 * the list out is what surfaced them:
 *
 *   - **`SeatObservations`** exists twice: an interface in `opponent-model.ts` (the counters
 *     one live table keeps about one seat) and a class in `stats.ts` (the accumulator the
 *     simulation harness fills over thousands of hands). The live-play interface keeps the
 *     bare name because it is the one that crosses into `apps/api`; the simulation class is
 *     published as `SimulationSeatObservations`.
 *   - **`preferredPotFraction`** is defined in `traits.ts` and re-exported by `stats.ts`.
 *     It is published once, from where it is defined.
 *
 * ## What is deliberately NOT exported
 *
 * Nothing is hidden on purpose — every module's own exports are here. What is *absent* is
 * anything that would let a caller feed a policy something it must not see: there is no
 * export that takes a `HandState`, because `PolicyInput` takes a redacted `PlayerView` plus
 * the seat's own two cards, and that boundary is a type rather than a rule (see
 * `policy.ts`).
 */

export {
  type ActionProbability,
  assertModelVoice,
  bestCandidate,
  CommentaryError,
  candidateForAction,
  commentOnDecision,
  explainModelDecision,
  type LearnerFacing,
  learnFromSummary,
  outcomeVersusQualityNote,
  type PolicyDecisionSummary,
  publishCommentary,
  type VoiceContext,
} from './commentary.ts';
export {
  analysisEvaluatedAction,
  bandForShortfall,
  buildHandComparison,
  ComparisonError,
  QUALITY_BANDS_IN_BIG_BLINDS,
  type RecordedDecision,
  scoreDecisionQuality,
} from './comparison.ts';
export {
  assessPostflop,
  assessPreflop,
  HandStrengthError,
  type PostflopAssessmentInput,
  type PreflopClassStrength,
  preflopClassPercentile,
  type StrengthAssessment,
  scaleEquityForOpponents,
} from './hand-strength.ts';
export {
  ATTRIBUTION_DISCLAIMER,
  assertNoImpersonation,
  COURSE_PROFILE_DISCLAIMER,
  findImpersonation,
  type ImpersonationFinding,
  LabellingError,
  type NamingMode,
  type ProfileDisclosure,
  type ProfileNaming,
  profileDisclosure,
  REQUIRED_VOICE,
  resolveNamingMode,
  UNIVERSAL_DISCLAIMER,
} from './labelling.ts';
export {
  BET_SIZE_SAMPLE_CAP,
  createOpponentModel,
  type DerivedSeatStats,
  derivedStats,
  type ExploitAdjustments,
  emptyObservations,
  estimateRange,
  exploitAdjustments,
  FACING_ACTIONS,
  type FacingAction,
  type HandProgress,
  INDICATIVE_MINIMUM_HANDS,
  MINIMUM_HANDS_FOR_STATS,
  neutralStats,
  OBSERVABLE_ACTIONS,
  OBSERVABLE_STREETS,
  type ObservableAction,
  type ObservableStreet,
  ObservationError,
  type ObservedSeatTendencies,
  OpponentModel,
  type OpponentObservations,
  observeAction,
  observeHandComplete,
  type PublicActionEvent,
  RANGE_STREETS,
  REASONABLE_MINIMUM_HANDS,
  RELIABILITY_LEVELS,
  type Reliability,
  reliabilityFor,
  type SeatObservations,
  SHOWDOWN_HAND_CAP,
  type ShownHand,
} from './opponent-model.ts';
export {
  type DrivingTrait,
  decide,
  isNeutralAssessment,
  NEUTRAL_ASSESSMENT_BAND,
  type ObservedAdjustments,
  type ObservedSeatRead,
  type PolicyDecision,
  PolicyError,
  type PolicyInput,
  type PolicyObservations,
  threeBetRaiseShare,
  type WeightedAction,
} from './policy.ts';
export {
  allProfileCards,
  DIFFICULTIES,
  DIFFICULTY_SETTINGS,
  type Difficulty,
  type DifficultySettings,
  expressTraits,
  PROFILES,
  type ProfileCard,
  ProfileError,
  profileById,
  profileCard,
  profileDiversity,
  requireProfile,
  type StrategyProfile,
} from './profiles.ts';
export {
  deriveSeed,
  type ProposedAction,
  SIMULATION_EQUITY_SAMPLES,
  type SimulationConfig,
  SimulationError,
  type SimulationHooks,
  type SimulationResult,
  seatStats,
  simulate,
  simulateHeadsUpAgainstReference,
  simulationDifficultySettings,
} from './simulate.ts';
export {
  averageRanks,
  combineCounts,
  compareToDeclared,
  compareToDeclaredTraits,
  type DecisionObservation,
  describeDivergence,
  type HandOutcomeObservation,
  holdingIsAir,
  inversePreferredPotFraction,
  normalTwoSidedCriticalValue,
  OBSERVABLE_AXES,
  type ObservableAxis,
  observedTraitEstimates,
  type ProportionSample,
  proportionDeviationInSigmas,
  radarAxes,
  rankByObserved,
  // Renamed on the way out: see the module comment for the collision this resolves.
  SeatObservations as SimulationSeatObservations,
  type SeatSimulationCounts,
  type SeatSimulationStats,
  StatsError,
  spearmanRho,
  type TraitDivergence,
  type TwoProportionResult,
  toObservedStats,
  twoProportionZTest,
} from './stats.ts';
export {
  assertValidTraits,
  baselineTraits,
  biggestTraitDifferences,
  makeTraits,
  positionalVpipMultiplier,
  preferredPotFraction,
  preflopRaiseFrequency,
  stackDepthCommitmentMultiplier,
  TRAIT_DESCRIPTIONS,
  TRAIT_KEYS,
  TRAIT_LABELS,
  TraitError,
  type TraitKey,
  type Traits,
  traitDistance,
} from './traits.ts';
