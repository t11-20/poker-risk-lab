/**
 * `@prl/ui` — the shared React components and native CSS for the web client.
 *
 * ## Consumed as source, not as a build
 *
 * `apps/web` lists this package in Next.js's `transpilePackages`, so what ships is the
 * `.ts`/`.tsx` in `src/`. There is no `dist/`, no bundler config here, and no build step
 * to forget before a change shows up in the dev server. That is why:
 *
 *  - relative imports carry their real extension (`./cards.ts`, `./PlayingCard.tsx`) —
 *    that is what lets Node and Next resolve them without a resolver plugin;
 *  - `'use client'` lives at the top of the individual component files that need it, so
 *    the client boundary is per component rather than swallowing the whole package;
 *  - the stylesheet is imported separately (`import '@prl/ui/styles.css'`), because CSS
 *    has to reach the document, not the module graph of a component.
 *
 * ## What is deliberately not here
 *
 * No data fetching, no WebSocket, no router, no global state. Every component in this
 * package is a function of its props. That keeps the hidden-information boundary intact
 * (nothing here can ask for a card it was not given) and it is what makes the components
 * usable in a lesson, in a scenario, in a live table and in hand review without three
 * variants of each.
 */

// -- Design system -----------------------------------------------------------
// The stylesheet is NOT re-exported from here. `import '@prl/ui/styles.css'` in the app's
// root layout: a CSS side effect inside a component barrel would be pulled in (or tree-
// shaken out) unpredictably depending on which component a page happens to import.

// -- Pure helpers ------------------------------------------------------------
export {
  type BetBounds,
  clampBetTo,
  presetTotal,
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
  isCardValue,
  listCardNames,
  parseCardText,
  SUIT_KEYS,
  type SuitKey,
} from './cards.ts';
// -- Components --------------------------------------------------------------
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
// -- Motion ------------------------------------------------------------------
// The hooks plus the pure decisions behind them, so anything outside this package that has to
// judge whether to animate asks the same question and gets the same answer.
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
// -- The render-boundary "is this an outs count?" guard ----------------------
// Exported for the same reason the probability guard below is: the rule ("a count is only called
// outs where a card could be one") belongs to every surface that shows one, and a second copy of
// `equity < 0.5` in `apps/web` is exactly the drift this package exists to prevent.
export { ALREADY_AHEAD_EQUITY, countsAsOuts } from './outs-count.ts';
// -- The render-boundary probability guard -----------------------------------
// Exported, not kept private to the components, because the rule it encodes ("a probability that
// is not a probability is never drawn") belongs to every surface that renders one — including the
// app's own pages. A second, subtly different copy of `value >= 0 && value <= 1` somewhere in
// `apps/web` would be exactly the drift this package exists to prevent.
export {
  formatProbability,
  isProbabilityDifference,
  isProbabilityFraction,
  isProbabilityPoints,
  NOT_A_PROBABILITY,
} from './probability.ts';
// -- Chart geometry ----------------------------------------------------------
// Pure, deterministic, and exported because the next polar chart should reuse these rather
// than re-derive the trigonometry with a different idea of where zero is.
//
// The whole public surface of `radar.ts` is here, deliberately. A partial re-export is the
// failure mode this barrel exists to prevent: a caller who can reach `RADAR_VIEWBOX` but not
// `radarViewBox` widens the window by hand, and one who cannot reach `RADAR_LABEL_GUTTER`
// picks their own number for the label margin — at which point two charts in the same app
// disagree about where the frame is. Either the module is reusable or it is not.
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
// -- Table types, projected out of the wire contract -------------------------
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
