/**
 * Bet-sizing arithmetic for `ActionBar`, which promises that no out-of-range amount can leave it.
 * It lives outside the component so `test/bet-sizing.test.ts` can run it (JSX has no renderer here).
 * Pure and total, with no throws and no `NaN` escaping, because a throw mid-render takes out the table.
 */

import {
  type BetBounds,
  clampToBounds,
  presetTo,
  type SizingContext,
  type SizingPreset,
  TABLE_SIZING_PRESETS,
} from '@prl/poker-math';
import type { LegalAction } from './view-types.ts';

/**
 * Re-exported from `@prl/poker-math`, because the Coach must price exactly the sizes this sizer offers
 * and a second copy rounded differently (see `packages/poker-math/src/table-sizing.ts`).
 */
export type { BetBounds, SizingContext, SizingPreset };

export interface SizedAction {
  readonly kind: 'bet' | 'raise';
  readonly bounds: BetBounds;
  readonly note: string | null;
}

export const SIZING_PRESETS: readonly SizingPreset[] = TABLE_SIZING_PRESETS;

export const clampBetTo: (value: number, bounds: BetBounds) => number = clampToBounds;

/**
 * Digits with an optional sign and decimal part. No exponent, hex, separators or `Infinity`.
 * `parseInt` read `1e3` as 1, and the browser reported no `badInput`, so the button sent the minimum.
 * A bare `Number()` was rejected as the parser, because it reads `0x20` as 32. Unreadable text is invalid.
 * Decimals pass because the clamp rounds to a whole chip and the readout shows the rounded total.
 */
const PLAIN_AMOUNT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/**
 * The one parser. `resolveDraft` and `isDraftMalformed` both use it, so the field cannot be marked
 * invalid while the button offers an amount read from the same text. `NaN` for anything refused.
 */
export function parseAmount(text: string): number {
  const trimmed = text.trim();
  if (!PLAIN_AMOUNT.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

/** Empty and refused text both resolve to the minimum, so the button never sends `NaN`. */
export function resolveDraft(draft: string | null, bounds: BetBounds): number {
  if (draft === null) return clampBetTo(Number.NaN, bounds);
  return clampBetTo(parseAmount(draft), bounds);
}

export interface BetDraft {
  /** A number input sanitises unparseable text to `''`, so empty does not mean nothing was typed. */
  readonly text: string;
  /** `validity.badInput`, the only signal of unparseable text. Capture it in the change handler. */
  readonly badInput: boolean;
}

/**
 * `badInput`, or non-empty text `parseAmount` refuses (for a browser that keeps it in `value`).
 * An empty field is not malformed, because marking it invalid tells a screen reader clearing was a mistake.
 */
export function isDraftMalformed(draft: BetDraft | null): boolean {
  if (draft === null) return false;
  if (draft.badInput) return true;
  const text = draft.text.trim();
  if (text === '') return false;
  return !Number.isFinite(parseAmount(text));
}

/**
 * A draft carries the bounds it was typed against, because bounds move each street and the text does
 * not. Without it the flop field read `1000` beside a button reading "Bet to 980".
 * A stamp, not an effect, keeps this derivable during render with no reset-on-prop-change.
 */
export interface StampedDraft extends BetDraft {
  readonly bounds: BetBounds;
}

export function sameBounds(left: BetBounds, right: BetBounds): boolean {
  return left.min === right.min && left.max === right.max;
}

/**
 * `null` for a draft typed against other bounds. The stale entry stays in state, because clearing it
 * is a write during render.
 */
export function draftForBounds(draft: StampedDraft | null, bounds: BetBounds): BetDraft | null {
  if (draft === null) return null;
  return sameBounds(draft.bounds, bounds) ? draft : null;
}

/**
 * The typed number when it differs from the amount that will be sent, so the bar can say so while the
 * field has focus. Null for no draft, empty, malformed (own message) or already equal.
 */
export function clampedFrom(draft: BetDraft | null, to: number): number | null {
  if (draft === null || isDraftMalformed(draft)) return null;
  const text = draft.text.trim();
  if (text === '') return null;
  const typed = parseAmount(text);
  return Number.isFinite(typed) && typed !== to ? typed : null;
}

/**
 * Clamped presets can share a total, and marking every match pressed reads as two choices.
 * The last match wins, so "All in" beats "Pot" at the same amount.
 */
export function pressedPreset(context: SizingContext, to: number): SizingPreset['id'] | null {
  let pressed: SizingPreset['id'] | null = null;
  for (const preset of SIZING_PRESETS) {
    if (presetTotal(preset, context) === to) pressed = preset.id;
  }
  return pressed;
}

export const presetTotal: (preset: SizingPreset, context: SizingContext) => number = presetTo;

/** An aggressive action missing a bound is dropped, because an invented maximum is an unbounded sizer. */
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
