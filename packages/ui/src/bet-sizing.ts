/**
 * Bet-sizing arithmetic for `ActionBar`.
 *
 * ## Why this is its own module
 *
 * `ActionBar`'s central promise is that **no out-of-range amount can leave it**. The server
 * re-validates every action against `legalActions()` and would reject an illegal one anyway,
 * but a learner meeting a rejection they could not have predicted is a teaching failure, so
 * the illegal value has to be unreachable in the control itself.
 *
 * That promise is arithmetic, and arithmetic can be tested. JSX cannot be run under
 * `node:test` in this repo (no renderer, and adding one is a dependency this project will
 * not take), so anything left inside the component is verified only by reading it. Pulling
 * the clamp and the preset maths out here means the one invariant that actually matters gets
 * `test/bet-sizing.test.ts` instead of a comment claiming it holds.
 *
 * Everything here is pure and total: no throws, no `NaN` escaping, defined for every finite
 * and non-finite input. A formatter that throws mid-render takes out the table around it.
 */

import type { LegalAction } from './view-types.ts';

/** The inclusive range of total street commitments the server will accept. */
export interface BetBounds {
  readonly min: number;
  readonly max: number;
}

/** The aggressive action, narrowed to the two kinds that take a size. */
export interface SizedAction {
  readonly kind: 'bet' | 'raise';
  readonly bounds: BetBounds;
  /** The engine's plain-language note, or null when it sent none. */
  readonly note: string | null;
}

export interface SizingContext {
  readonly bounds: BetBounds;
  /** `PlayerView.potTotal` — everything in the middle, this street included. */
  readonly pot: number;
  /** `PlayerView.amountToCall`. Zero when nothing is owed. */
  readonly toCall: number;
  /** This seat's commitment so far this street. */
  readonly committedThisStreet: number;
}

export interface SizingPreset {
  readonly id: string;
  /** Shown on the button. */
  readonly label: string;
  /** Fraction of the pot-after-call, or `null` for "everything you have". */
  readonly fraction: number | null;
}

/**
 * The preset sizes, as a fraction of the pot **after** the call:
 *
 *     total = committedThisStreet + toCall + fraction × (pot + toCall)
 *
 * With nothing to call that reduces to a plain fraction-of-pot bet. Facing a bet it is the
 * standard pot-sized-raise construction — match the bet first, then bet a fraction of what
 * is then in the middle. That definition is printed next to the buttons in the UI, because
 * "pot-sized raise" means at least three different things in the wild and a learner should
 * not have to reverse-engineer which one a button implements.
 */
export const SIZING_PRESETS: readonly SizingPreset[] = [
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
 *  - non-finite in (`NaN` from an empty or half-typed field, `Infinity` from nothing
 *    sensible at all) collapses to `min`, which is always a legal amount;
 *  - an inverted or impossible range (`max < min`, which the server should never send but
 *    which a bug upstream could) also collapses to `min` rather than returning something
 *    between two contradictory bounds;
 *  - rounding happens BEFORE the pin, so a value just outside a bound cannot round its way
 *    back out again.
 */
export function clampBetTo(value: number, bounds: BetBounds): number {
  if (!Number.isFinite(bounds.min)) return 0;
  if (!Number.isFinite(value)) return bounds.min;
  if (!Number.isFinite(bounds.max) || bounds.max < bounds.min) return bounds.min;
  return Math.min(Math.max(Math.round(value), bounds.min), bounds.max);
}

/**
 * Parses what the user has typed into an amount that is legal by construction.
 *
 * `null` (nothing typed yet) and unparseable text both resolve to the minimum, so the
 * control always has a legal value to submit — there is no "empty" state in which the
 * button would send `NaN`.
 */
export function resolveDraft(draft: string | null, bounds: BetBounds): number {
  if (draft === null) return clampBetTo(Number.NaN, bounds);
  return clampBetTo(Number.parseInt(draft, 10), bounds);
}

/**
 * What the reader has typed into the sizer's number field.
 *
 * Two fields rather than one string, because on an `<input type="number">` the text and the
 * browser's opinion of it are genuinely two facts and only one of them is readable from `value`.
 */
export interface BetDraft {
  /**
   * The field's `value`.
   *
   * **Empty does not mean "nothing typed".** A number input sanitises anything it could not
   * parse to the empty string: type `one third` and the characters stay on screen while
   * `event.target.value` is `''`. So this string alone cannot distinguish a cleared field from
   * a field full of letters, which is why the flag below exists.
   */
  readonly text: string;
  /**
   * `event.target.validity.badInput` — the browser is holding characters it could not parse.
   *
   * The ONLY platform signal that unparseable text is present. It has to be captured in the
   * change handler and carried, because nothing about the value can be re-derived into it later.
   */
  readonly badInput: boolean;
}

/**
 * Whether the field is holding something the sizer cannot use, and should therefore be marked
 * invalid.
 *
 * Two conditions, because there are two ways to get non-numeric text into the field, and the
 * first one is invisible in `text`:
 *
 *  - `badInput`: the browser parsed nothing and reported so;
 *  - non-empty text that does not resolve to a number, for a browser that keeps the characters
 *    in `value` instead of sanitising them. Stated rather than relied upon — today's browsers
 *    take the first branch — because "the field looked fine while holding letters" is not a
 *    defect worth inheriting from a platform detail.
 *
 * An EMPTY field is not malformed: nothing has been typed, `resolveDraft` falls back to the
 * minimum, and marking a blank field invalid would tell a screen reader the reader had made a
 * mistake by clearing it.
 *
 * `Number.parseInt` and not `Number`, deliberately: this must agree with `resolveDraft`, or the
 * field could be marked invalid while the commit button beside it offers an amount derived from
 * the very same text.
 */
export function isDraftMalformed(draft: BetDraft | null): boolean {
  if (draft === null) return false;
  if (draft.badInput) return true;
  const text = draft.text.trim();
  if (text === '') return false;
  return !Number.isFinite(Number.parseInt(text, 10));
}

/** The total a preset resolves to, already clamped into the legal range. */
export function presetTotal(preset: SizingPreset, context: SizingContext): number {
  const { bounds, pot, toCall, committedThisStreet } = context;
  if (preset.fraction === null) return clampBetTo(bounds.max, bounds);
  const raw = committedThisStreet + toCall + Math.round(preset.fraction * (pot + toCall));
  return clampBetTo(raw, bounds);
}

/**
 * Finds the bet or raise in a legal-action list, with usable bounds.
 *
 * An aggressive action missing either bound is **dropped**, not guessed at. An unbounded
 * sizer is precisely the thing this module exists to prevent, and rendering a slider with an
 * invented maximum would let a client propose an amount the server never offered.
 */
export function resolveSizedAction(legalActions: readonly LegalAction[]): SizedAction | null {
  for (const action of legalActions) {
    if (action.type !== 'bet' && action.type !== 'raise') continue;
    const { minTo, maxTo } = action;
    if (minTo === undefined || maxTo === undefined) continue;
    if (!Number.isFinite(minTo) || !Number.isFinite(maxTo)) continue;
    return { kind: action.type, bounds: { min: minTo, max: maxTo }, note: action.note ?? null };
  }
  return null;
}
