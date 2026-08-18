'use client';

/**
 * A labelled figure: the component the whole design leans on.
 *
 * ```
 * EQUITY                     <- label, --prl-type-label, quiet
 * 41.2 %                     <- value + unit, tabular, the loudest thing on screen
 * + 7.9 points over break-even   <- delta, explicit sign and word
 * exact enumeration          <- note, where the method or caveat lives
 * ```
 *
 * ## Five rules, each of which is a bug if it is dropped
 *
 * 1. **`label` is required.** A bare number is unreadable and unaccountable: "1,240" could be
 *    a pot, a stack or an EV. The type makes the unlabelled case unrepresentable rather than
 *    discouraged.
 * 2. **The value carries tabular figures**, via `.prl-metric__value`. Proportional digits
 *    change width as they change value, so a counting figure jitters sideways — at a table,
 *    a number that moves while you read it is a number you misread (§3.3).
 * 3. **The unit is a separate element beside the value**, never baked into the number's
 *    string, so it can sit at label size and never be mistaken for a digit.
 * 4. **A delta always carries an explicit `+` or `-` in its text, plus a direction word for
 *    assistive tech and a glyph for the eye.** Colour is the last cue added, never the only
 *    one (WCAG 1.4.1). The sign is derived from `direction` when one is given, so a caller
 *    can pass a magnitude and a direction without the two contradicting each other.
 * 5. **Counting up never reaches a screen reader.** See below.
 *
 * ## The count-up's accessibility contract
 *
 * With `countUp`, two nodes carry the figure:
 *
 *  - the visible one is `aria-hidden` and interpolates (`.prl-count`);
 *  - a `.prl-visually-hidden` node inside an `aria-live="polite"` region holds the **real**
 *    value, from the very first render.
 *
 * So a screen reader announces "equity: 41.2 %" once, when it settles — never the eleven
 * wrong numbers on the way there. The unit and the interval join the hidden node and are
 * hidden from the accessibility tree on the visible side, or they would be announced twice.
 *
 * The counting and non-counting figures are separate components rather than one component
 * with a conditional hook, so a static metric neither subscribes to `matchMedia` nor holds
 * animation state. The trade-off is that toggling `countUp` on a mounted metric remounts the
 * figure; `countUp` is a property of the *kind* of figure, so it does not change in practice.
 *
 * ## Why this is not a `<dl>`
 *
 * `StatTile` pairs its label and value in a description list, which is right for one figure in
 * prose. A metric row is six of these side by side, and six one-item description lists is six
 * "list, one item" preambles for a screen-reader user. Here the label immediately precedes the
 * value in reading order, which conveys the same pairing with none of the noise.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatChips, formatOdds, formatPoints, formatUnits } from '../format.ts';
import { useCountUp } from '../motion/useCountUp.ts';

/** How the number is rendered. The value itself is always a raw number. */
export type MetricFormat = 'number' | 'percent' | 'units' | 'points' | 'odds';
export type MetricSize = 'sm' | 'md' | 'lg' | 'hero';
export type MetricTone = 'neutral' | 'favourable' | 'adverse' | 'caution' | 'info';
export type MetricDeltaDirection = 'up' | 'down' | 'flat';

export interface MetricDelta {
  /** Magnitude, in the metric's own units. Its sign is used only if `direction` is absent. */
  readonly value: number;
  /** What the delta is measured against, e.g. "over break-even". */
  readonly label: string;
  readonly direction?: MetricDeltaDirection;
}

export interface MetricProps {
  /** Required: a figure with no label is not a metric. */
  readonly label: string;
  /** A fraction in 0..1 for `percent`; otherwise the figure itself. */
  readonly value: number;
  readonly format?: MetricFormat;
  /** Overrides the format's default precision. */
  readonly decimals?: number;
  /** Overrides the format's unit. `null` renders no unit at all. */
  readonly unit?: string | null;
  /**
   * A pre-formatted interval, e.g. `"± 0.4 points"`. A sampled figure must pass one: a bare
   * Monte Carlo percentage with no interval is the single most misleading thing this UI can
   * draw (§6.2).
   */
  readonly interval?: string;
  /** One line of context: the method, the assumption, the caveat. */
  readonly note?: string;
  readonly delta?: MetricDelta;
  readonly tone?: MetricTone;
  readonly size?: MetricSize;
  /** Interpolate the visible figure when it changes. Off by default. */
  readonly countUp?: boolean;
  readonly className?: string;
}

/** One decimal for anything derived, none for whole chips. */
const DEFAULT_DECIMALS: Readonly<Record<MetricFormat, number>> = {
  number: 0,
  percent: 1,
  units: 0,
  points: 1,
  odds: 1,
};

/**
 * `odds` and `number` have no unit of their own — `formatOdds` already says "to 1", and a
 * bare count's unit is whatever the label says it is.
 */
const DEFAULT_UNIT: Readonly<Record<MetricFormat, string | null>> = {
  number: null,
  percent: '%',
  units: 'units',
  points: 'points',
  odds: null,
};

/** Shape, not colour. Redundant with the sign in the text, which is the point. */
const DIRECTION_GLYPH: Readonly<Record<MetricDeltaDirection, string>> = {
  up: '▲',
  down: '▼',
  flat: '=',
};

/** The word an assistive technology hears in place of the glyph. */
const DIRECTION_WORD: Readonly<Record<MetricDeltaDirection, string>> = {
  up: 'up',
  down: 'down',
  flat: 'no change',
};

const DIRECTION_SIGN: Readonly<Record<MetricDeltaDirection, string>> = {
  up: '+',
  down: '-',
  flat: '',
};

/**
 * Sizes get a modifier class as well as `data-size`. The class matches the convention the rest
 * of the package already uses (`.prl-card--sm`), and the attribute is what a stylesheet
 * selecting on state finds convenient. Both name the same thing; neither is load-bearing on
 * its own.
 */
const SIZE_CLASS: Readonly<Record<MetricSize, string>> = {
  sm: 'prl-metric--sm',
  md: 'prl-metric--md',
  lg: 'prl-metric--lg',
  hero: 'prl-metric--hero',
};

/**
 * The figure as text, with no unit attached.
 *
 * `percent` multiplies here rather than using `formatPercent`, because the `%` belongs to its
 * own element at label size — a metric shows `41.2` and `%` as two things, not one string.
 */
function valueText(value: number, format: MetricFormat, decimals: number): string {
  if (format === 'odds') return formatOdds(value, { decimals });
  if (format === 'percent') return formatChips(value * 100, { decimals });
  return formatChips(value, { decimals });
}

interface ResolvedDelta {
  readonly direction: MetricDeltaDirection;
  /** `"+7.9 points"` — sign in the text, unit word included. */
  readonly text: string;
}

/**
 * Resolves a delta into a direction and a signed string.
 *
 * Two details worth keeping:
 *
 *  - `direction` wins over the sign of `value`, so `{ value: 0.079, direction: 'down' }` reads
 *    as `-7.9 points`. A caller thinking in magnitudes and a caller thinking in signed
 *    differences both get a truthful line.
 *  - a magnitude that **rounds** to zero at the chosen precision becomes `flat`. Otherwise a
 *    delta of 0.0004 would render as `+0.0 points`, which claims a change that the figure
 *    beside it does not show — the same trap `format.ts` closes for negative zero.
 */
function resolveDelta(delta: MetricDelta, format: MetricFormat, decimals: number): ResolvedDelta {
  const signed = Number.isFinite(delta.value) ? delta.value : 0;
  const magnitude = Math.abs(signed);
  const scaled = format === 'percent' ? magnitude * 100 : magnitude;
  const stated = delta.direction ?? (signed > 0 ? 'up' : signed < 0 ? 'down' : 'flat');
  const direction = Number(scaled.toFixed(decimals)) === 0 ? 'flat' : stated;

  let figure: string;
  if (format === 'percent' || format === 'points') figure = formatPoints(scaled, { decimals });
  else if (format === 'units') figure = formatUnits(magnitude, { decimals });
  else figure = formatChips(magnitude, { decimals });

  return { direction, text: `${DIRECTION_SIGN[direction]}${figure}` };
}

interface FigureProps {
  readonly label: string;
  readonly value: number;
  readonly format: MetricFormat;
  readonly decimals: number;
  readonly unit: string | null;
  readonly interval: string | undefined;
}

/** What a screen reader hears: the label, the real figure, its unit and its interval. */
function spokenFigure(props: FigureProps, text: string): string {
  const parts = [`${props.label}:`, text];
  if (props.unit !== null) parts.push(props.unit);
  if (props.interval !== undefined) parts.push(props.interval);
  return parts.join(' ');
}

interface AsideProps {
  readonly text: string | null | undefined;
  /** True on the counting figure, where the live region already says all of this. */
  readonly hidden: boolean;
  readonly variant: 'unit' | 'interval';
}

/**
 * The unit and the interval share a shape: label-sized text beside the value, present or
 * absent, and hidden from the accessibility tree exactly when the live region duplicates it.
 */
function Aside(props: AsideProps): ReactElement | null {
  if (props.text === null || props.text === undefined) return null;
  const className =
    props.variant === 'unit' ? 'prl-metric__unit prl-label' : 'prl-metric__interval prl-label';
  return (
    <span className={className} aria-hidden={props.hidden ? 'true' : undefined}>
      {props.text}
    </span>
  );
}

function StaticFigure(props: FigureProps): ReactElement {
  const text = valueText(props.value, props.format, props.decimals);
  return (
    <span className="prl-metric__figure">
      <span className="prl-metric__value">{text}</span>
      <Aside text={props.unit} hidden={false} variant="unit" />
      <Aside text={props.interval} hidden={false} variant="interval" />
    </span>
  );
}

/**
 * The counting variant. The visible number is decoration over a real value that is already in
 * the DOM — see the module comment.
 */
function CountedFigure(props: FigureProps): ReactElement {
  const shown = useCountUp(props.value);
  const animated = valueText(shown, props.format, props.decimals);
  const real = valueText(props.value, props.format, props.decimals);
  return (
    <span className="prl-metric__figure">
      <span className="prl-metric__value prl-count" aria-hidden="true">
        {animated}
      </span>
      <Aside text={props.unit} hidden={true} variant="unit" />
      <Aside text={props.interval} hidden={true} variant="interval" />
      <span className="prl-visually-hidden" aria-live="polite" aria-atomic="true">
        {spokenFigure(props, real)}
      </span>
    </span>
  );
}

export function Metric(props: MetricProps): ReactElement {
  const {
    label,
    value,
    format = 'number',
    decimals = DEFAULT_DECIMALS[format],
    unit,
    interval,
    note,
    delta,
    tone = 'neutral',
    size = 'md',
    countUp = false,
    className,
  } = props;

  const figure: FigureProps = {
    label,
    value,
    format,
    decimals,
    unit: unit === undefined ? DEFAULT_UNIT[format] : unit,
    interval,
  };
  const resolvedDelta = delta === undefined ? null : resolveDelta(delta, format, decimals);

  return (
    <div className={cx('prl-metric', SIZE_CLASS[size], className)} data-size={size} data-tone={tone}>
      <span className="prl-metric__label prl-label">{label}</span>
      {countUp ? <CountedFigure {...figure} /> : <StaticFigure {...figure} />}
      {resolvedDelta === null || delta === undefined ? null : (
        <p className="prl-metric__delta" data-direction={resolvedDelta.direction}>
          <span className="prl-metric__delta-glyph" aria-hidden="true">
            {DIRECTION_GLYPH[resolvedDelta.direction]}
          </span>
          <span className="prl-visually-hidden">{`${DIRECTION_WORD[resolvedDelta.direction]}, `}</span>
          <span className="prl-metric__delta-value">{resolvedDelta.text}</span>
          <span className="prl-metric__delta-label">{delta.label}</span>
        </p>
      )}
      {note === undefined ? null : <p className="prl-metric__note">{note}</p>}
    </div>
  );
}
