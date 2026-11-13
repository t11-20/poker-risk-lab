/**
 * The sizes a seat is offered at the table, and the one rounding rule they are built with.
 * `ActionBar` renders `TABLE_SIZING_PRESETS` through `presetTo`, and `buildCoachReport` prices
 * exactly `offeredSizes`. The Lab grades a size by exact match, so the bar and the Coach must agree
 * (they once differed in 23 of 31 scenarios). Every function is total and never throws, because a
 * throw mid-render takes out the table.
 */

/** The inclusive range of total street commitments the table will accept. */
export interface BetBounds {
  readonly min: number;
  readonly max: number;
}

export interface SizingContext {
  readonly bounds: BetBounds;
  /** Everything in the middle, this street included, before hero's pending call. */
  readonly pot: number;
  /** What hero must add to continue. Zero when nothing is owed. */
  readonly toCall: number;
  /** This seat's commitment so far this street. */
  readonly committedThisStreet: number;
}

export interface SizingPreset {
  readonly id: 'third' | 'half' | 'twoThirds' | 'pot' | 'allIn';
  /** Shown on the button. */
  readonly label: string;
  /** Fraction of the pot-after-call, or `null` for "everything you have". */
  readonly fraction: number | null;
}

/**
 * The preset sizes, as a fraction of the pot after the call:
 *
 *     total = committedThisStreet + toCall + round(fraction × (pot + toCall))
 *
 * With nothing to call this is a plain fraction-of-pot bet. The UI prints this definition next to
 * the buttons, because "pot-sized raise" has several meanings.
 */
export const TABLE_SIZING_PRESETS: readonly SizingPreset[] = [
  { id: 'third', label: '⅓ pot', fraction: 1 / 3 },
  { id: 'half', label: '½ pot', fraction: 0.5 },
  { id: 'twoThirds', label: '⅔ pot', fraction: 2 / 3 },
  { id: 'pot', label: 'Pot', fraction: 1 },
  { id: 'allIn', label: 'All in', fraction: null },
];

/**
 * Rounds to a whole chip and pins into `[min, max]`. A non-finite value and an inverted range both
 * return `min`. Rounding happens before the pin, so a value outside a bound cannot round back out.
 */
export function clampToBounds(value: number, bounds: BetBounds): number {
  if (!Number.isFinite(bounds.min)) return 0;
  if (!Number.isFinite(value)) return bounds.min;
  if (!Number.isFinite(bounds.max) || bounds.max < bounds.min) return bounds.min;
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

/**
 * The total a preset resolves to, clamped into the legal range. The fraction is rounded to the
 * nearest chip, once, here. `sizingLadder` floors instead, and the offered button must match the
 * priced row exactly.
 */
export function presetTo(preset: SizingPreset, context: SizingContext): number {
  const { bounds, pot, toCall, committedThisStreet } = context;
  if (preset.fraction === null) return clampToBounds(bounds.max, bounds);
  const raw = committedThisStreet + toCall + Math.round(preset.fraction * (pot + toCall));
  return clampToBounds(raw, bounds);
}

/** One size the table offers, and which control offers it. */
export interface OfferedSize {
  /** `'minimum'` is the floor, which is what an untouched sizer sends. */
  readonly id: 'minimum' | SizingPreset['id'];
  readonly to: number;
}

/**
 * Every size the `ActionBar` can produce without typing or dragging, deduplicated and ascending.
 * The floor and the shove are added first, so when a preset clamps onto one of them it keeps the
 * plain name. A "⅔ pot" clamped to the whole stack is the all-in.
 */
export function offeredSizes(context: SizingContext): readonly OfferedSize[] {
  const sizes: OfferedSize[] = [];
  const seen = new Set<number>();
  const add = (id: OfferedSize['id'], to: number): void => {
    if (seen.has(to)) return;
    seen.add(to);
    sizes.push({ id, to });
  };
  add('minimum', clampToBounds(context.bounds.min, context.bounds));
  add('allIn', clampToBounds(context.bounds.max, context.bounds));
  for (const preset of TABLE_SIZING_PRESETS) add(preset.id, presetTo(preset, context));
  return sizes.sort((left, right) => left.to - right.to);
}

/**
 * The priced sizes either side of an unpriced `to`, so a refusal can name them. `below` is the
 * largest priced size under `to` and `above` the smallest over it. Either is `null` when none exists.
 */
export function nearestPricedSizes(
  to: number,
  priced: readonly number[],
): { readonly below: number | null; readonly above: number | null } {
  let below: number | null = null;
  let above: number | null = null;
  for (const size of priced) {
    if (size < to && (below === null || size > below)) below = size;
    if (size > to && (above === null || size < above)) above = size;
  }
  return { below, above };
}
