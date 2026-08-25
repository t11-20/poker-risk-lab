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
 * The only spelling of an amount this sizer accepts: digits, with an optional sign and an
 * optional decimal part. No exponent, no hex, no numeric separators, no `Infinity`.
 *
 * ## The defect this exists for
 *
 * The sizer parsed with `Number.parseInt(text, 10)`, and `parseInt` stops at the first character
 * it cannot use and returns what it had. So `1e3` is **1**, which then clamps to the minimum —
 * and `validity.badInput` is false, because a number input parses `1e3` perfectly well and holds
 * it in `value`. Both halves of the invalid state therefore said the field was fine.
 *
 * Measured in Chrome 151 on the built app at `/play?state=decision`, raise bounds 70–970: typing
 * `1e3` left `field.value === "1e3"`, `validity.badInput === false`, no `aria-invalid`, no
 * correction rendered — and the commit button read **"Raise to 70"**. `2e2` — a plain way to
 * write 200 — did the same. A learner who typed a shorthand got the minimum bet and was told
 * nothing at all.
 *
 * ## Refused rather than parsed, and why that is the safe direction
 *
 * `Number('1e3')` is 1000 and would have "worked". It also makes `0x20` mean 32, `1_000` mean
 * `NaN`, and every one of those a silent reinterpretation of characters the reader can see. This
 * control's promise is that the amount it will send is the amount on the screen, or that the
 * disagreement is NAMED — so the honest answer to text it cannot read as a plain number is the
 * invalid state it already has, with the correction that already says "Type whole units — or use
 * the slider or a preset above, which always set a legal size."
 *
 * A decimal part is accepted rather than refused because `clampBetTo` already rounds to a whole
 * chip and the readout under the field prints the rounded total, so `200.5` is corrected in
 * public rather than silently. That is a different thing from `1e3`, which was corrected to a
 * number sharing no digits with what was typed.
 */
const PLAIN_AMOUNT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/**
 * The one parser. `resolveDraft` and `isDraftMalformed` must agree about every string, or the
 * field can be marked invalid while the button beside it offers an amount derived from the very
 * same text — so they are two readings of this function rather than two implementations.
 *
 * `NaN` for anything it will not accept, which is exactly what `clampBetTo` already collapses to
 * the minimum. Total: no throws, defined for every string.
 */
export function parseAmount(text: string): number {
  const trimmed = text.trim();
  if (!PLAIN_AMOUNT.test(trimmed)) return Number.NaN;
  return Number(trimmed);
}

/**
 * Parses what the user has typed into an amount that is legal by construction.
 *
 * `null` (nothing typed yet) and unparseable text both resolve to the minimum, so the
 * control always has a legal value to submit — there is no "empty" state in which the
 * button would send `NaN`. Text that is refused resolves to the minimum too, and the field is
 * marked invalid beside it — see `isDraftMalformed`.
 */
export function resolveDraft(draft: string | null, bounds: BetBounds): number {
  if (draft === null) return clampBetTo(Number.NaN, bounds);
  return clampBetTo(parseAmount(draft), bounds);
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
 * `parseAmount` and not a second parser, deliberately: this must agree with `resolveDraft`, or
 * the field could be marked invalid while the commit button beside it offers an amount derived
 * from the very same text. That is also what closes the `1e3` hole — the browser reports nothing
 * wrong with `1e3`, so this is the only check that can, and it can only do so if it refuses the
 * same strings the parser does. See `PLAIN_AMOUNT`.
 */
export function isDraftMalformed(draft: BetDraft | null): boolean {
  if (draft === null) return false;
  if (draft.badInput) return true;
  const text = draft.text.trim();
  if (text === '') return false;
  return !Number.isFinite(parseAmount(text));
}

/**
 * What the reader typed, together with the bounds it was typed against.
 *
 * ## The defect this exists for
 *
 * `ActionBar`'s header claimed that "blur normalises the text back to" the clamped number. That
 * is true at the instant of blur and false a moment later, because the draft outlives the spot it
 * belongs to: the bounds move at every street and the *text* does not.
 *
 * Measured in Chrome 151 at a live table on the built app. Preflop, raise bounds 20–1,000: type
 * `999999`, blur — the field, the slider, the readout and the button all read 1,000, exactly as
 * documented. Call, call, and on the flop the bounds are 10–980 — and the field still reads
 * `1000` while the slider says 980, the readout says "Total commitment this street: 980 units"
 * and the button says "Bet to 980". The field is showing an amount that is now illegal, and it is
 * not marked invalid, because it is not malformed — it is stale.
 *
 * ## Why a stamp rather than an effect
 *
 * `ActionBar`'s whole design is "no effect, no stale state, no reset-on-prop-change dance": the
 * clamp re-runs on render and the value follows. Clearing the draft from an effect would put
 * exactly the dance it refuses back in, and would do it one paint late. Carrying the bounds
 * INSIDE the draft keeps the rule pure and derivable during render: a draft belongs to one set of
 * bounds, and against any other set there is no draft.
 *
 * Bounds are the right identity and not an approximation of one. If they have not moved,
 * `resolveDraft(text, bounds)` is the same number it was, so the field, the slider, the readout
 * and the button all still agree and there is nothing to correct.
 */
export interface StampedDraft extends BetDraft {
  readonly bounds: BetBounds;
}

/** Whether two ranges are the same range. Written out so the rule above has one definition. */
export function sameBounds(left: BetBounds, right: BetBounds): boolean {
  return left.min === right.min && left.max === right.max;
}

/**
 * The draft, but only while it still belongs to `bounds`.
 *
 * `null` for a draft typed against a spot that has since moved, which puts the field back on the
 * clamped value the rest of the sizer is already showing. The stale entry is never read again; it
 * is left in state rather than cleared because clearing it is a write, and a write during render
 * is the thing this shape exists to avoid.
 */
export function draftForBounds(draft: StampedDraft | null, bounds: BetBounds): BetDraft | null {
  if (draft === null) return null;
  return sameBounds(draft.bounds, bounds) ? draft : null;
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
