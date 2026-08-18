/**
 * `@prl/poker-math` — pure poker probability and decision maths.
 *
 * Outs, equity (exact when it fits, bounded Monte Carlo when it does not), the price
 * of a call, expected value, stack depth, variance and tournament equity. No I/O, no
 * clock, no global mutable state, and no randomness that is not seeded and stated —
 * which is what lets the API shard a calculation across workers and lets a lesson
 * quote a figure that every learner reproduces exactly.
 *
 * ## Why every export is named here rather than `export *`
 *
 * This file is the package's contract, and a contract has to be reviewable. Ten
 * `export *` lines would be shorter and would hide three things worth seeing: what
 * the surface actually is, that nothing internal leaks into it, and that no two
 * modules export the same name. Written out, adding an export is a visible change in
 * a diff and a helper that was meant to stay private cannot escape by accident.
 *
 * The package's `exports` map publishes this entry point only, so this list is the
 * whole of what any other package can reach — a deep import of `dist/odds.js` is
 * blocked. Anything missing from here is unreachable, however public it looks in its
 * own file.
 *
 * ## What is deliberately NOT exported
 *
 * `src/format.ts`. It turns numbers into the sentences a learner reads, which is a
 * presentation detail of the explanation strings and not something another package
 * should build a figure on.
 *
 * ## Every error class is exported
 *
 * `OddsError`, `EquityError`, `OutsError` and the rest are part of the API, not
 * implementation detail. A caller that has to match on a message string instead of a
 * class has been handed a contract that breaks the next time someone improves the
 * wording — and these messages get improved often, because they are teaching text.
 *
 * ## Ordering
 *
 * Modules in alphabetical order, names alphabetical within each module, exactly as
 * `@prl/poker-engine` does it. The order carries no meaning; keeping it mechanical is
 * what stops a merge from producing two of anything.
 */

export {
  buildCoachReport,
  type CoachAction,
  CoachError,
  type CoachInput,
  type DescribedSpot,
  deriveLegalActions,
  type RuleOfThumbRefusal,
  ruleOfThumbFor,
  ruleOfThumbRefusalFor,
  type Street,
  summariseCoachReport,
} from './coach.ts';
export {
  bestCandidate,
  bestMeasuredCandidate,
  CONSISTENCY_MARGIN_BIG_BLINDS,
  type ConsistencyAction,
  ConsistencyError,
  type ConsistencyInput,
  type ConsistencyVerdict,
  candidateFor,
  consistencyMarginUnits,
  defensibleActions,
  isDefensible,
  judgeConsistency,
} from './consistency.ts';
export {
  choose,
  combineMonteCarlo,
  countMatchups,
  type EquityConfidence,
  EquityError,
  type EquityOptions,
  type EquityPlayer,
  type EquityResult,
  type EquitySpec,
  equity,
  estimateExactWork,
  exactEquity,
  heroEquity,
  MAX_MONTE_CARLO_SAMPLES,
  MIN_MONTE_CARLO_SAMPLES,
  monteCarloEquity,
  type PlayerEquity,
  showdownScores,
} from './equity.ts';
export {
  breakEvenBluffFrequency,
  type EvBreakdown,
  EvError,
  type EvTerm,
  evOfBet,
  evOfCall,
  evOfCheck,
  evOfFold,
  evOfRaise,
  evOfSemiBluff,
  requiredFoldEquity,
} from './ev.ts';
export {
  computeStrengthTable,
  type HandClassStrength,
  HandRankingError,
  type StrengthTable,
  strengthOf,
  strengthTable,
  topPercentRange,
} from './hand-ranking.ts';
export {
  type IcmDecision,
  IcmError,
  type IcmResult,
  icmEquity,
  icmVsChipEv,
  MAX_ICM_PLAYERS,
  type PushFoldResult,
  pushFoldChipEv,
} from './icm.ts';
export {
  type DefenceFrequency,
  defenceFrequency,
  type HitProbability,
  type ImpliedOdds,
  impliedOdds,
  maximumOutsForRuleOf24,
  OddsError,
  type PotOdds,
  potOdds,
  priceLaidByBet,
  probabilityOfHitting,
  type ReverseImpliedOdds,
  type RuleOfThumbAccuracy,
  type RuleOfThumbEstimate,
  reverseImpliedOdds,
  ruleOf24,
  ruleOf24Accuracy,
} from './odds.ts';
export {
  type CardOutcome,
  computeOuts,
  DEFAULT_AHEAD_THRESHOLD,
  DEFAULT_CLEAN_THRESHOLD,
  type OutClassification,
  OutsError,
  type OutsInput,
  type OutsResult,
  outsSummaryFor,
} from './outs.ts';
export {
  allHandClasses,
  type ClassShape,
  type Combo,
  classOfCombo,
  comboCountOf,
  combosOfClass,
  comboToString,
  exactRange,
  type HandClass,
  makeHandClass,
  type ParsedRange,
  parseRange,
  RangeParseError,
} from './ranges.ts';
export {
  commitmentThreshold,
  effectiveStack,
  mRatio,
  type SizingOption,
  type SprBand,
  type SprResult,
  StackError,
  sizingLadder,
  stackInBigBlinds,
  stackToPotRatio,
} from './stacks.ts';
export {
  bankrollForRiskTolerance,
  type DownswingOutlook,
  downswingOutlook,
  handsNeededForPrecision,
  normalCdf,
  normalQuantile,
  type ObservedWinRateInterval,
  observedWinRateInterval,
  projectResults,
  type RiskOfRuin,
  riskOfRuin,
  VarianceError,
  type WinRateProjection,
} from './variance.ts';
