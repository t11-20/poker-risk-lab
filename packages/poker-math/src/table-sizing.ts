/**
 * The sizes a seat is offered at the table, and the one rounding rule they are built with.
 *
 * ## Why this lives here and not in `@prl/ui`
 *
 * It did live in `@prl/ui` (`bet-sizing.ts`), and the Coach priced a different set of sizes with a
 * different rounding rule. The `ActionBar` offered the minimum raise as its default plus ⅓, ½, ⅔
 * and pot presets rounded to the nearest chip; the Coach priced three rungs of its own sizing
 * ladder — the smallest ladder rung at or above the floor, a middle one, and the shove — each
 * rounded DOWN. The Scenario Lab grades a learner's size by exact match against the priced rows,
 * so the two lists had to agree and nothing joined them. Measured over the 36 bundled scenarios at
 * commit 308fadf: of the 31 that offer a bet or a raise, the bar's default was unpriced in 23; on
 * `eq-second-pair-vs-wide-range` the ⅔-pot preset was 207 and the priced row 206, one chip apart
 * by rounding alone; and on `eq-flush-draw-turn-small-bet` the best row, "Raise to 67", was a size
 * no preset could reach. A learner pressed a button the product offered and was told "this
 * analysis did not price that size".
 *
 * So the sizes are defined once, here, and both sides read them: `ActionBar` renders its presets
 * from `TABLE_SIZING_PRESETS` through `presetTo` (re-exported by `@prl/ui` under its old names),
 * and `buildCoachReport` prices exactly `offeredSizes` — the default plus every preset. This
 * package is the one both can import: `@prl/ui` already depends on it, and it has no I/O.
 *
 * Everything here is pure and total: no throws, no `NaN` escaping, defined for every finite and
 * non-finite input. A formatter that throws mid-render takes out the table around it.
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
 * The preset sizes, as a fraction of the pot **after** the call:
 *
 *     total = committedThisStreet + toCall + round(fraction × (pot + toCall))
 *
 * With nothing to call that reduces to a plain fraction-of-pot bet. Facing a bet it is the
 * standard pot-sized-raise construction — match the bet first, then bet a fraction of what is then
 * in the middle. That definition is printed next to the buttons in the UI, because "pot-sized
 * raise" means at least three different things in the wild and a learner should not have to
 * reverse-engineer which one a button implements.
 */
export const TABLE_SIZING_PRESETS: readonly SizingPreset[] = [
  { id: 'third', label: '⅓ pot', fraction: 1 / 3 },
  { id: 'half', label: '½ pot', fraction: 0.5 },
  { id: 'twoThirds', label: '⅔ pot', fraction: 2 / 3 },
  { id: 'pot', label: 'Pot', fraction: 1 },
  { id: 'allIn', label: 'All in', fraction: null },
];

/**
 * Rounds to a whole chip and pins into `[min, max]`.
 *
 * Total by construction, and every branch is deliberate:
 *
 *  - non-finite in (`NaN` from an empty or half-typed field, `Infinity` from nothing sensible at
 *    all) collapses to `min`, which is always a legal amount;
 *  - an inverted or impossible range (`max < min`, which the server should never send but which a
 *    bug upstream could) also collapses to `min` rather than returning something between two
 *    contradictory bounds;
 *  - rounding happens BEFORE the pin, so a value just outside a bound cannot round its way back
 *    out again.
 */
export function clampToBounds(value: number, bounds: BetBounds): number {
  if (!Number.isFinite(bounds.min)) return 0;
  if (!Number.isFinite(value)) return bounds.min;
  if (!Number.isFinite(bounds.max) || bounds.max < bounds.min) return bounds.min;
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

/**
 * The total a preset resolves to, already clamped into the legal range.
 *
 * **The one rounding rule.** The fraction of the pot is rounded to the NEAREST chip, once, here.
 * The Coach's ladder floors instead (`sizingLadder` in `./stacks.ts`), which is right for a ladder
 * that has to stay inside the fraction its label claims and wrong for a size a learner is offered,
 * because the button and the priced row then differ by a chip — 207 against 206, measured above.
 * Neither direction is more correct than the other; what is incorrect is having two.
 */
export function presetTo(preset: SizingPreset, context: SizingContext): number {
  const { bounds, pot, toCall, committedThisStreet } = context;
  if (preset.fraction === null) return clampToBounds(bounds.max, bounds);
  const raw = committedThisStreet + toCall + Math.round(preset.fraction * (pot + toCall));
  return clampToBounds(raw, bounds);
}

/** One size the table offers, and which control offers it. */
export interface OfferedSize {
  /** `'minimum'` is the sizer's default — the floor, which is what an untouched sizer sends. */
  readonly id: 'minimum' | SizingPreset['id'];
  /** The total street commitment. */
  readonly to: number;
}

/**
 * Every size the `ActionBar` can produce without the learner typing or dragging: its default and
 * each preset, deduplicated and in ascending order.
 *
 * The default is the floor because that is what an untouched sizer sends — `resolveDraft(null,
 * bounds)` is `bounds.min`. On a short stack several presets clamp onto the same total, which is
 * correct and is why this list can be as short as one entry. When they do, the floor and the shove
 * keep their own names — they are added first — because a "⅔ pot" preset clamped up to the whole
 * stack IS the all-in, and naming it after a fraction it no longer is would put a false sentence
 * in the Coach's derivation.
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
 * The priced sizes either side of one the analysis did not price, so a refusal can say where the
 * priced ones are instead of only that this one is not among them.
 *
 * `below` is the largest priced size under `to`, `above` the smallest over it; either is `null`
 * when nothing priced lies on that side.
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
