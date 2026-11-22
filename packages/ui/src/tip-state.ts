/**
 * What `Tip` does with each input, apart from the DOM so `node --test` can drive it (ADR 0008).
 * Click, tap, Enter and Space all reach a native `<button>` as one `click`, so they are one `press`.
 * Hover only ever peeks: it never pins, so a tip that depends on hover cannot exist.
 */

/** `peek` is shown by a hovering mouse and goes when it leaves. `pinned` stays until dismissed. */
export type TipState = 'closed' | 'peek' | 'pinned';

export type TipEvent =
  | { readonly type: 'press' }
  | { readonly type: 'hover-start' }
  | { readonly type: 'hover-end' }
  | { readonly type: 'escape' }
  | { readonly type: 'outside' }
  | { readonly type: 'focus-left' }
  | { readonly type: 'viewport-moved' };

export function nextTipState(state: TipState, event: TipEvent): TipState {
  switch (event.type) {
    case 'press':
      return state === 'pinned' ? 'closed' : 'pinned';
    case 'hover-start':
      return state === 'closed' ? 'peek' : state;
    case 'hover-end':
      return state === 'peek' ? 'closed' : state;
    default:
      return 'closed';
  }
}

/** A finger also fires `pointerenter`, and a hybrid laptop can report hover for its touchscreen. */
export function countsAsHover(pointerType: string, deviceCanHover: boolean): boolean {
  return pointerType === 'mouse' && deviceCanHover;
}

export interface TipBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface TipPlacementInput {
  /** The `?` button. */
  readonly anchor: TipBox;
  /** What the tip explains, with the button. The bubble never overlaps it. */
  readonly subject: TipBox;
  readonly size: { readonly width: number; readonly height: number };
  readonly viewport: { readonly width: number; readonly height: number };
  /** Clear space kept between the bubble and the viewport's edge. */
  readonly gutter: number;
  /** Space between the subject and the bubble. */
  readonly gap: number;
}

export interface TipPlacement {
  readonly x: number;
  readonly y: number;
  readonly side: 'above' | 'below';
}

/**
 * Viewport coordinates for the bubble. It starts at the button and is pushed back inside the gutter,
 * so a button at the right edge of a 360px screen opens leftwards rather than off the glass.
 * It goes on the side of the subject nearer the button, and flips when that side has no room.
 */
export function placeTip(input: TipPlacementInput): TipPlacement {
  const { anchor, subject, size, viewport, gutter, gap } = input;
  const rightmost = viewport.width - gutter - size.width;
  const x = Math.max(gutter, Math.min(anchor.left, rightmost));

  const below = subject.bottom + gap;
  const above = subject.top - gap - size.height;
  const fitsBelow = below + size.height <= viewport.height - gutter;
  const fitsAbove = above >= gutter;
  const nearerTop = anchor.top - subject.top < subject.bottom - anchor.bottom;

  let side: TipPlacement['side'];
  if (nearerTop) side = fitsAbove || !fitsBelow ? 'above' : 'below';
  else side = fitsBelow || !fitsAbove ? 'below' : 'above';
  // Neither fits: the roomier side, so the sentence is cut by the least.
  if (!fitsAbove && !fitsBelow) side = subject.top > viewport.height - subject.bottom ? 'above' : 'below';

  return { x, y: side === 'below' ? below : above, side };
}
