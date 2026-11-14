/**
 * `@prl/ui`, consumed as source through Next's `transpilePackages`, so there is no build step.
 * Relative imports carry their real extension, and `'use client'` is per component file.
 * Every component is a function of its props (no fetching, sockets, router or global state), so
 * nothing here can ask for a card it was not given.
 * The stylesheet is not re-exported. Import `@prl/ui/styles.css` in the root layout, because a CSS
 * side effect in a barrel is pulled in or tree-shaken unpredictably.
 */

export {
  type BetBounds,
  clampBetTo,
  clampedFrom,
  presetTotal,
  pressedPreset,
  resolveDraft,
  resolveSizedAction,
  SIZING_PRESETS,
  type SizedAction,
  type SizingContext,
  type SizingPreset,
} from './bet-sizing.ts';
export {
  type CardDescription,
  type CardValue,
  describeCard,
  handAndBoardName,
  isCardValue,
  listCardNames,
  parseCardText,
  SUIT_KEYS,
  type SuitKey,
} from './cards.ts';
export { ActionBar, type ActionBarProps } from './components/ActionBar.tsx';
export {
  AssumptionList,
  type AssumptionListProps,
  type HeadingLevel,
} from './components/AssumptionList.tsx';
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './components/Button.tsx';
export { Callout, type CalloutProps, type CalloutTone } from './components/Callout.tsx';
export { type CardEntry, CardRow, type CardRowProps } from './components/CardRow.tsx';
export { Chip, type ChipProps, type ChipTone } from './components/Chip.tsx';
export { CoachPanel, type CoachPanelProps } from './components/CoachPanel.tsx';
export { EquityBar, type EquityBarPlayer, type EquityBarProps } from './components/EquityBar.tsx';
export { Formula, type FormulaProps } from './components/Formula.tsx';
export { HandGlance, type HandGlanceProps } from './components/HandGlance.tsx';
export {
  Metric,
  type MetricDelta,
  type MetricDeltaDirection,
  type MetricFormat,
  type MetricProps,
  type MetricSize,
  type MetricTone,
} from './components/Metric.tsx';
export { Panel, type PanelProps, type PanelTone } from './components/Panel.tsx';
export { type CardSize, PlayingCard, type PlayingCardProps } from './components/PlayingCard.tsx';
export { PokerTable, type PokerTableProps } from './components/PokerTable.tsx';
export { PotDisplay, type PotDisplayProps } from './components/PotDisplay.tsx';
export { type RadarAxisLabels, RadarChart, type RadarChartProps } from './components/RadarChart.tsx';
export { Reveal, type RevealProps } from './components/Reveal.tsx';
export { Seat, type SeatProps, seatRingPosition } from './components/Seat.tsx';
export { StatTile, type StatTileProps, type StatTone } from './components/StatTile.tsx';
export { type TurnClock, TurnTimer, type TurnTimerProps } from './components/TurnTimer.tsx';
export { UncertaintyNote, type UncertaintyNoteProps } from './components/UncertaintyNote.tsx';
export { UNITS_EXPLANATION, UnitsBadge, type UnitsBadgeProps } from './components/UnitsBadge.tsx';
export { cx, type StyleWithVars } from './cx.ts';
export { useChangeWatch, useFocusOnChange } from './focus-on-change.ts';
export { browserAbandonedFocus, useFocusRescue } from './focus-rescue.ts';
export {
  type ConfidenceIntervalOptions,
  describeSpr,
  FormatError,
  formatChips,
  formatConfidenceInterval,
  formatIndex,
  formatOdds,
  formatPercent,
  formatPoints,
  formatSignedUnits,
  formatUnits,
  NOT_AVAILABLE,
  type PercentOptions,
  pluralise,
  SPR_BANDS,
  type SprBand,
  type SprDescription,
  type UnitsOptions,
} from './format.ts';
export { type Keyed, withKeys } from './keys.ts';
export {
  BROWSER_REVEAL_HOST,
  COUNT_DURATION_MS,
  type CountUpDecision,
  type CountUpOptions,
  createReducedMotionStore,
  cubicBezier,
  driveCountUp,
  EASE_STANDARD_CONTROL_POINTS,
  easeStandard,
  type FrameClock,
  interpolate,
  type MediaQueryHost,
  MIN_COUNT_UP_CHANGE,
  progress,
  REDUCED_MOTION_QUERY,
  type ReducedMotionQuery,
  type ReducedMotionStore,
  type RevealDecision,
  type RevealHost,
  type RevealOptions,
  type RevealPlan,
  type RevealState,
  shouldCountUp,
  shouldRevealImmediately,
  useCountUp,
  usePrefersReducedMotion,
  useReveal,
  watchForReveal,
} from './motion/index.ts';
// The render-boundary guards are exported so `apps/web` never keeps a second, drifting copy.
export { ALREADY_AHEAD_EQUITY, countsAsOuts } from './outs-count.ts';
export {
  formatProbability,
  isProbabilityDifference,
  isProbabilityFraction,
  isProbabilityPoints,
  NOT_A_PROBABILITY,
  normaliseProbability,
  normaliseProbabilityDifference,
  normaliseProbabilityPoints,
  PROBABILITY_TOLERANCE,
} from './probability.ts';
// All of `radar.ts`, because a partial re-export makes callers hand-roll the frame and gutter.
export {
  axisAngle,
  axisLabelAnchor,
  axisMarker,
  clampUnit,
  polarPoint,
  polygonPoints,
  RADAR_CENTRE,
  RADAR_DEFAULT_GEOMETRY,
  RADAR_LABEL_GUTTER,
  RADAR_LABEL_RADIUS,
  RADAR_RADIUS,
  RADAR_RING_FRACTIONS,
  RADAR_VIEWBOX,
  type RadarAxisValue,
  type RadarGeometry,
  type RadarPoint,
  radarViewBox,
  ringPoints,
  roundCoordinate,
  summariseAxes,
} from './radar.ts';
export { lastActionsThisStreet } from './seat-actions.ts';
export { latestAction, STREET_SUMMARY_LIMIT, type StreetSummary, streetSummary } from './street-summary.ts';
export type {
  ActionName,
  LegalAction,
  PlayerView,
  PotLayer,
  SeatStatus,
  SeatView,
  Street,
  TableAction,
} from './view-types.ts';
