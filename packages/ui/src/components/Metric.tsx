'use client';

/**
 * A labelled figure, the component the whole design leans on.
 * `label` is required, because a bare "1,240" could be a pot, a stack or an EV. The value uses tabular
 * figures so a counting number does not jitter (§3.3). The unit is its own element at label size.
 * A delta always has an explicit sign, a direction word and a glyph, so colour is never the only cue
 * (WCAG 1.4.1).
 * With `countUp` the visible figure is `aria-hidden` and interpolates, while a polite live region holds
 * the real value from the first render, so a screen reader hears it once and never the numbers on the
 * way. Not a `<dl>`, because six one-item lists in a row are six "list, one item" preambles.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatChips, formatOdds, formatPoints, formatUnits, NOT_AVAILABLE } from '../format.ts';
import { useCountUp } from '../motion/useCountUp.ts';
import { NOT_A_PROBABILITY, normaliseProbability } from '../probability.ts';

export type MetricFormat = 'number' | 'percent' | 'units' | 'points' | 'odds';
export type MetricSize = 'sm' | 'md' | 'lg' | 'hero';
export type MetricTone = 'neutral' | 'favourable' | 'adverse' | 'caution' | 'info';
export type MetricDeltaDirection = 'up' | 'down' | 'flat';

export interface MetricDelta {
  /** Magnitude in the metric's own units. Its sign is used only if `direction` is absent. */
  readonly value: number;
  readonly label: string;
  readonly direction?: MetricDeltaDirection;
}

export interface MetricProps {
  readonly label: string;
  /**
   * A fraction in 0..1 for `percent`, otherwise the figure itself. A `percent` outside 0..1 renders as
   * `not a probability` rather than as 160%. A non-finite value renders the dash, meaning absent.
   */
  readonly value: number;
  readonly format?: MetricFormat;
  readonly decimals?: number;
  /** `null` renders no unit at all. */
  readonly unit?: string | null;
  /** A pre-formatted interval such as `"± 0.4 points"`. A sampled figure must pass one (§6.2). */
  readonly interval?: string;
  readonly note?: string;
  readonly delta?: MetricDelta;
  readonly tone?: MetricTone;
  readonly size?: MetricSize;
  readonly countUp?: boolean;
  readonly className?: string;
}

const DEFAULT_DECIMALS: Readonly<Record<MetricFormat, number>> = {
  number: 0,
  percent: 1,
  units: 0,
  points: 1,
  odds: 1,
};

/**
 * A function rather than a map, because "units" and "points" have a singular and a constant rendered
 * "1 units". The rendered body decides, as in `formatUnits`, so `1.0` is still "unit".
 */
function defaultUnit(format: MetricFormat, text: string): string | null {
  switch (format) {
    case 'percent':
      return '%';
    case 'units':
      return isOne(text) ? 'unit' : 'units';
    case 'points':
      return isOne(text) ? 'point' : 'points';
    default:
      return null;
  }
}

/** Grouped digits and a sign are stripped, as `format.ts` does. */
function isOne(text: string): boolean {
  return Math.abs(Number(text.replaceAll(',', ''))) === 1;
}

const DIRECTION_GLYPH: Readonly<Record<MetricDeltaDirection, string>> = {
  up: '▲',
  down: '▼',
  flat: '=',
};

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

const SIZE_CLASS: Readonly<Record<MetricSize, string>> = {
  sm: 'prl-metric--sm',
  md: 'prl-metric--md',
  lg: 'prl-metric--lg',
  hero: 'prl-metric--hero',
};

/** No unit attached. `percent` multiplies here because its `%` is a separate element. */
function valueText(value: number, format: MetricFormat, decimals: number): string {
  if (format === 'odds') return formatOdds(value, { decimals });
  if (format === 'percent') {
    const normalised = normaliseProbability(value);
    if (normalised === null) {
      return Number.isFinite(value) ? NOT_A_PROBABILITY : formatChips(value, { decimals });
    }
    return formatChips(normalised * 100, { decimals });
  }
  return formatChips(value, { decimals });
}

/**
 * No unit beside `NOT_AVAILABLE` or `NOT_A_PROBABILITY`, because a dash plus "units" reads as a quantity.
 * A unit the caller passed is used as given and never conjugated.
 */
function unitFor(props: FigureProps, text: string): string | null {
  if (text === NOT_AVAILABLE || text === NOT_A_PROBABILITY) return null;
  return props.unit === undefined ? defaultUnit(props.format, text) : props.unit;
}

interface ResolvedDelta {
  readonly direction: MetricDeltaDirection;
  readonly text: string;
}

/**
 * `direction` wins over the sign of `value`. A magnitude that rounds to zero becomes `flat`, so 0.0004
 * never renders as `+0.0 points`.
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
  /** `null` means no unit. `undefined` means the format's unit, which depends on the rendered figure. */
  readonly unit: string | null | undefined;
  readonly interval: string | undefined;
}

function spokenFigure(props: FigureProps, text: string): string {
  const parts = [`${props.label}:`, text];
  if (props.unit !== null && props.unit !== undefined) parts.push(props.unit);
  if (props.interval !== undefined) parts.push(props.interval);
  return parts.join(' ');
}

interface AsideProps {
  readonly text: string | null | undefined;
  /** True on the counting figure, where the live region already says all of this. */
  readonly hidden: boolean;
  readonly variant: 'unit' | 'interval';
}

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
      <Aside text={unitFor(props, text)} hidden={false} variant="unit" />
      <Aside text={props.interval} hidden={false} variant="interval" />
    </span>
  );
}

function CountedFigure(props: FigureProps): ReactElement {
  const shown = useCountUp(props.value);
  const animated = valueText(shown, props.format, props.decimals);
  const real = valueText(props.value, props.format, props.decimals);
  const unit = unitFor(props, real);
  return (
    <span className="prl-metric__figure">
      <span className="prl-metric__value prl-count" aria-hidden="true">
        {animated}
      </span>
      <Aside text={unit} hidden={true} variant="unit" />
      <Aside text={props.interval} hidden={true} variant="interval" />
      <span className="prl-visually-hidden" aria-live="polite" aria-atomic="true">
        {spokenFigure({ ...props, unit }, real)}
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
    unit,
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
