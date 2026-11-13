/**
 * Number-to-text formatting for every figure the UI shows.
 *
 * Grouping is hand-rolled, not `Intl.NumberFormat`, because the default locale differs between the
 * Node and browser renders (a hydration mismatch) and ICU output drifts between Node versions.
 * Signs are ASCII `+`/`-`, because several screen readers announce U+2212 as nothing.
 * Equities and probabilities are fractions in 0..1. A field already scaled says so in its name
 * (`errorPoints`) and goes through `formatPoints`. A points value sent to `formatPercent` showed "3,600.0%".
 * Nothing here clamps. An impossible number is shown as is, so the bug that produced it stays visible.
 */

import { sprBandFor } from '@prl/poker-math';

/** Every component that renders this pairs it with real text, because a lone em dash is ambiguous. */
export const NOT_AVAILABLE = '—';

export class FormatError extends Error {
  override readonly name = 'FormatError';
}

/** A loop rather than a lookahead regex, which is catastrophic on very long inputs. */
function groupThousands(digits: string): string {
  const groups: string[] = [];
  let remaining = digits;
  while (remaining.length > 3) {
    groups.unshift(remaining.slice(-3));
    remaining = remaining.slice(0, -3);
  }
  groups.unshift(remaining);
  return groups.join(',');
}

/** `toFixed` plus grouping. Anything that rounds to zero loses its sign, so `-0 units` never shows. */
function formatFixed(value: number, decimals: number): string {
  const rounded = value.toFixed(decimals);
  const unsigned = rounded.startsWith('-') ? rounded.slice(1) : rounded;
  const isNegative = rounded.startsWith('-') && Number(rounded) !== 0;
  const dot = unsigned.indexOf('.');
  const whole = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fraction = dot === -1 ? '' : unsigned.slice(dot);
  return `${isNegative ? '-' : ''}${groupThousands(whole)}${fraction}`;
}

function trimTrailingZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

function assertNumber(value: number, what: string): void {
  if (typeof value !== 'number') throw new FormatError(`${what} must be a number`);
}

function isRenderable(value: number): boolean {
  return Number.isFinite(value);
}

export interface PercentOptions {
  /** One by default. Equity is not precise to two. */
  readonly decimals?: number;
  readonly signed?: boolean;
}

/** A fraction in 0..1 as a percentage, `0.6237` → `"62.4%"`. A value in points renders 100x too large. */
export function formatPercent(fraction: number, options: PercentOptions = {}): string {
  assertNumber(fraction, 'fraction');
  if (!isRenderable(fraction)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 1;
  const body = formatFixed(fraction * 100, decimals);
  const sign = options.signed === true && !body.startsWith('-') && Number(body.replace(/,/g, '')) !== 0;
  return `${sign ? '+' : ''}${body}%`;
}

/** A difference in percentage points. The word is spelled out because points and percent get confused. */
export function formatPoints(points: number, options: PercentOptions = {}): string {
  assertNumber(points, 'points');
  if (!isRenderable(points)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 1;
  const body = formatFixed(points, decimals);
  const sign = options.signed === true && !body.startsWith('-') && Number(body.replace(/,/g, '')) !== 0;
  const magnitude = Math.abs(Number(body.replace(/,/g, '')));
  return `${sign ? '+' : ''}${body} ${magnitude === 1 ? 'point' : 'points'}`;
}

export interface UnitsOptions {
  readonly decimals?: number;
}

/** No unit word. Only where "units" is in a nearby label. A standalone amount uses `formatUnits`. */
export function formatChips(chips: number, options: UnitsOptions = {}): string {
  assertNumber(chips, 'chips');
  if (!isRenderable(chips)) return NOT_AVAILABLE;
  return formatFixed(chips, options.decimals ?? 0);
}

export function formatUnits(units: number, options: UnitsOptions = {}): string {
  assertNumber(units, 'units');
  if (!isRenderable(units)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 0;
  const body = formatFixed(units, decimals);
  const isOne = Math.abs(Number(body.replace(/,/g, ''))) === 1;
  return `${body} ${isOne ? 'unit' : 'units'}`;
}

/** Zero is unsigned, because `+0` reads as a win. The sign alone tells gain from loss, without colour. */
export function formatSignedUnits(delta: number, options: UnitsOptions = {}): string {
  assertNumber(delta, 'delta');
  if (!isRenderable(delta)) return NOT_AVAILABLE;
  const decimals = options.decimals ?? 0;
  const body = formatFixed(delta, decimals);
  const numeric = Number(body.replace(/,/g, ''));
  const isOne = Math.abs(numeric) === 1;
  const sign = numeric > 0 ? '+' : '';
  return `${sign}${body} ${isOne ? 'unit' : 'units'}`;
}

/**
 * `3.5` → `"3.5 to 1"`. Words, because screen readers announce a colon inconsistently.
 * `null` is a free continuation (the contract's encoding of `pot / 0`). `Infinity` is a bug upstream
 * and renders as not-available.
 */
export function formatOdds(ratio: number | null, options: { readonly decimals?: number } = {}): string {
  if (ratio === null) return 'no cost to continue';
  assertNumber(ratio, 'ratio');
  if (Number.isNaN(ratio)) return NOT_AVAILABLE;
  if (!isRenderable(ratio) || ratio < 0) return NOT_AVAILABLE;
  return `${trimTrailingZeros(formatFixed(ratio, options.decimals ?? 1))} to 1`;
}

export interface ConfidenceIntervalOptions {
  /** As a fraction. `@prl/poker-math` always reports 0.95. */
  readonly level?: number;
  readonly decimals?: number;
}

/**
 * `"62.4% ± 0.8 points (95% interval)"`. A null half-width says the interval is missing, never that
 * the figure is exact, because a Monte Carlo number without its interval is the most misleading output.
 */
export function formatConfidenceInterval(
  fraction: number,
  halfWidthPoints: number | null,
  options: ConfidenceIntervalOptions = {},
): string {
  assertNumber(fraction, 'fraction');
  const decimals = options.decimals ?? 1;
  const centre = formatPercent(fraction, { decimals });
  if (halfWidthPoints === null) return `${centre} (no interval reported)`;
  assertNumber(halfWidthPoints, 'halfWidthPoints');
  if (!isRenderable(halfWidthPoints)) return `${centre} (no interval reported)`;
  const level = options.level ?? 0.95;
  const levelText = isRenderable(level) ? `${trimTrailingZeros(formatFixed(level * 100, 1))}%` : '';
  const spread = formatPoints(Math.abs(halfWidthPoints), { decimals });
  return levelText === '' ? `${centre} ± ${spread}` : `${centre} ± ${spread} (${levelText} interval)`;
}

export const SPR_BANDS = ['unknown', 'committed', 'low', 'medium', 'high', 'deep'] as const;
export type SprBand = (typeof SPR_BANDS)[number];

export interface SprDescription {
  readonly band: SprBand;
  readonly value: number;
  readonly label: string;
  /** Descriptive, never prescriptive. */
  readonly meaning: string;
}

/**
 * The band is also a styling hook (`data-band`), so it is returned rather than parsed from the label.
 * The bands are this app's convention. Each sentence says how much room is left, never what to do.
 */
export function describeSpr(spr: number): SprDescription {
  assertNumber(spr, 'spr');
  if (!isRenderable(spr) || spr < 0) {
    return {
      band: 'unknown',
      value: spr,
      label: 'not defined',
      meaning:
        'SPR is the effective stack divided by the pot, so it has no value until there are chips in the middle.',
    };
  }
  const shown = trimTrailingZeros(formatFixed(spr, 1));
  // The edges come from `@prl/poker-math`, because `CoachPanel` shows this label above that module's
  // prose and separate edges made them disagree on five Lab scenarios. The band names stay local.
  const band = sprBandFor(spr);
  if (band === 'very-low') {
    return {
      band: 'committed',
      value: spr,
      label: `${shown} — committed`,
      meaning:
        'Below 1 the pot is already larger than the stack behind it, so any bet is effectively a decision about the whole stack.',
    };
  }
  if (band === 'low') {
    return {
      band: 'low',
      value: spr,
      label: `${shown} — low`,
      meaning:
        'Between 1 and 3 a bet and a raise puts the stacks in, so the commitment decision usually arrives on this street.',
    };
  }
  if (band === 'medium') {
    return {
      band: 'medium',
      value: spr,
      label: `${shown} — medium`,
      meaning: 'Between 3 and 6 there is room for roughly two streets of betting before the stacks are in.',
    };
  }
  if (band === 'high') {
    return {
      band: 'high',
      value: spr,
      label: `${shown} — high`,
      meaning:
        'Between 6 and 13 several streets of choices remain, so position and implied odds carry more of the decision.',
    };
  }
  return {
    band: 'deep',
    value: spr,
    label: `${shown} — deep`,
    meaning:
      'Above 13 the stacks are deep relative to the pot, so most of the money is still decided on later streets.',
  };
}

/** The design system's numbered motif is fixed-width, so every index pads to the same width. */
const INDEX_DIGITS = 2;

/** 1-based, so `1` → `"01"`. Fractions truncate. A negative keeps its sign, because it is a caller bug. */
export function formatIndex(position: number, options: { readonly digits?: number } = {}): string {
  assertNumber(position, 'position');
  if (!isRenderable(position)) return NOT_AVAILABLE;
  const digits = options.digits ?? INDEX_DIGITS;
  const whole = Math.trunc(position);
  const sign = whole < 0 ? '-' : '';
  return `${sign}${String(Math.abs(whole)).padStart(digits, '0')}`;
}

/** Appends `s` unless `plural` is given. The magnitude picks the form, so `-1` is singular. */
export function pluralise(count: number, singular: string, plural?: string): string {
  assertNumber(count, 'count');
  if (typeof singular !== 'string' || singular === '') {
    throw new FormatError('pluralise needs a non-empty singular noun');
  }
  const many = plural ?? `${singular}s`;
  if (!isRenderable(count)) return `${NOT_AVAILABLE} ${many}`;
  const word = Math.abs(count) === 1 ? singular : many;
  const body = Number.isInteger(count) ? formatFixed(count, 0) : trimTrailingZeros(formatFixed(count, 2));
  return `${body} ${word}`;
}
