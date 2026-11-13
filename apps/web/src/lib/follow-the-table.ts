/**
 * How far to move the page so a reader who can size a bet can reach the sizer, on a narrow column.
 *
 * ## The defect this exists for (audit at 6b3886e, M1)
 *
 * Below 46rem of column the action row sticks to the bottom of the viewport inside its own bar
 * (`styles/play.css` section 3.1), and `useFollowTheTable` in `app/play/LiveTable.tsx` brought the
 * buttons in by their nearest edge — which stops as soon as the row can stick. The bar's sizer sits
 * ABOVE the row in flow, so at that scroll position the stuck row was painted straight over it.
 * Measured at 390x844 on the live table, both themes, at every decision with a raise legal: row at
 * 611..780, presets at 619..713 and the slider at 723..767 under it, the number field under the
 * Coach's peek; `elementFromPoint` at the centre of ⅓ pot, ½ pot, Pot and All in returned Fold, ⅔ pot
 * returned Call, and a real tap on the ½-pot preset sent `{"type":"raise","to":20}`. Reproduced on
 * this branch before the change: two of two decisions, every preset hit a button.
 *
 * ## What it does instead
 *
 * The region that matters is the street line and the price strip, the reader's cards and the board
 * (`HandGlance`, which the bar draws between the price and the sizer on a narrow column), the sizer,
 * and the row where it sits IN FLOW — read off the top of the note that follows it, because the
 * row's own box is wherever it is stuck. If that region fits between the root's scroll padding (the
 * sticky header above, the Coach peek below), it is brought in by its nearest edge, exactly as the
 * buttons were: the row then sits at its own place under the sizer, where it is not stuck and covers
 * nothing.
 *
 * If it does not fit, what has to stay is the glance and everything under it — the cards, the
 * sizer, the row. When those fit, the row goes to the bottom edge in flow, and the street line goes
 * off the top, wholly under the header rather than cut in half by it. At 390x844 the view is 672px
 * (the root's scroll padding is 92px, the header's 77 and a step of air; 80px below), the bar from
 * its top edge to the row's flow bottom is 668px with the glance, and a one-line street line and
 * its gap add 33px, so this is the 390x844 case at every decision. When even the glance down to the
 * row does not fit — a short phone like 360x640 — the glance's top goes to the top edge, then
 * presets and slider, and the row sticks over the readout at the bottom of the sizer rather than
 * over the controls. Without a glance (900px and up, where the HUD above the bar holds the cards) the
 * sizer's top is what is kept.
 *
 * ## The trade, and the defect it used to make
 *
 * The reader's own plate and the board are above this region, and at 390x844 they go off the top to
 * make room: measured on this branch before the glance, plate at -174..46 and board at -303..-203.
 * The first version of this follow stopped there, and a learner sized every bet without being able
 * to see what they held or what it had to beat — scrolling up to look took the sizer away instead.
 * The glance is the cards and the board brought down to the controls, and keeping it on screen is
 * now the first thing the scroll is for; the street line, which narrates, is the first thing given
 * up.
 *
 * Pure, and in its own file, so `node --test` drives it with the rectangles the browser measured.
 */

/** Viewport coordinates, as `getBoundingClientRect` gives them. */
export interface SizerGeometry {
  /** The top of the first thing in the band worth keeping: the street line, else the bar. */
  readonly regionTop: number;
  /**
   * The top of the reader's cards and the board in the bar (`HandGlance`), or null where the band
   * does not draw them. What the scroll keeps on screen above everything else when it has to choose.
   */
  readonly handTop: number | null;
  /** The sizer's top edge. */
  readonly sizerTop: number;
  /** The sizer's bottom edge. */
  readonly sizerBottom: number;
  /** Where the row sits when it is NOT stuck: the top of the block after it. */
  readonly rowFlowBottom: number;
  /** The row's box as painted, stuck or not. */
  readonly rowTop: number;
  /** The bottom of the street line, or null where there is none: what is given up first. */
  readonly streetBottom: number | null;
  /** The sticky header's bottom edge: what paints over the page above `viewTop`'s step of air. */
  readonly coverBottom: number;
  /** The root's `scroll-padding-block-start`: the bottom of the sticky header, and a step of air. */
  readonly viewTop: number;
  /** The viewport height less the root's `scroll-padding-block-end`: the top of the Coach peek. */
  readonly viewBottom: number;
}

/** Whether the row is painted over the sizer: the case where a tap on a preset lands on a button. */
export function rowCoversSizer(geometry: Pick<SizerGeometry, 'rowTop' | 'sizerBottom'>): boolean {
  return geometry.rowTop < geometry.sizerBottom;
}

/** Pixels to scroll by (positive is down the page), or 0 when the sizer and the row are both usable. */
export function sizerFollowDelta(geometry: SizerGeometry): number {
  const { regionTop, handTop, sizerTop, streetBottom, coverBottom, rowFlowBottom, viewTop, viewBottom } =
    geometry;
  const covered = rowCoversSizer(geometry);
  if (!covered && regionTop >= viewTop && rowFlowBottom <= viewBottom) return 0;
  const room = viewBottom - viewTop;
  if (rowFlowBottom - regionTop <= room) {
    return regionTop < viewTop ? regionTop - viewTop : rowFlowBottom - viewBottom;
  }
  const keep = handTop ?? sizerTop;
  // The cards down to the row fit: the row in flow at the bottom edge, the street line given up —
  // and given up whole. The row at the bottom edge alone left the line's last 7px showing between the
  // header and the bar at 390x844 (street 63..84 under a header ending at 77): half a line of text,
  // which reads as a rendering fault rather than as a page scrolled. The step of air under the
  // header is where it showed, and the row has room to go up by that much.
  const toBottom = rowFlowBottom - viewBottom;
  if (keep - toBottom < viewTop) return keep - viewTop;
  const whole = streetBottom === null ? toBottom : Math.max(toBottom, streetBottom - coverBottom);
  return keep - whole >= viewTop ? whole : toBottom;
}

/**
 * How far to move the page, when the decision is not the reader's, so the table is on screen again.
 *
 * ## Why this exists
 *
 * The sizer region above takes the reader's own plate and the board off the top of a phone, and once
 * they have acted the band collapses to a line or two under the header — so the page was left on that
 * line with the whole table above it, and the reader had to scroll up to watch the hand they were in.
 * Measured at 390x844 on this branch before this rule: after a call, the band at 92..204, the reader's
 * plate at -146..55 and the board at -223..-179; when the call ended the hand, the result went in
 * above the band at -157..-21; and the next deal, finding the short band already in view, left it
 * there, so every hand after the first was watched from below.
 *
 * So when the decision is over, a hand has settled or a hand is dealt that is not yet theirs to act
 * in, and the table is NOT on screen, the band is brought in by its bottom edge: the table is above
 * it, and the result too when there is one. Only when the band fits — during a decision it does not,
 * which is why the decision is followed differently (see `useFollowTheTable`) — and never when any of
 * the reader's plate is already on screen, so a reader who is watching is not moved by a pixel.
 */
export interface WatchGeometry {
  readonly bandTop: number;
  readonly bandBottom: number;
  /** The reader's own plate, or the table's last block when they hold none: what "watching" sees. */
  readonly tableBottom: number;
  readonly viewTop: number;
  readonly viewBottom: number;
  /**
   * True on the edge where a hand is dealt. Only then is a band BELOW the view brought up: the reader
   * pressed Deal at the top of the page and is waiting for the table. At the end of their decision or
   * of the hand, a reader who has scrolled up has done so on purpose, and the end of the hand used to
   * leave the page where it was — it still does for them.
   */
  readonly dealt: boolean;
}

/** Pixels to scroll by (negative is up the page), or 0 to leave the page where it is. */
export function watchDelta(geometry: WatchGeometry): number {
  const { bandTop, bandBottom, tableBottom, viewTop, viewBottom, dealt } = geometry;
  // Taller than the view: by its nearest edge, if it is below on a deal, and otherwise left alone.
  if (bandBottom - bandTop > viewBottom - viewTop) {
    return dealt && bandTop > viewBottom ? bandTop - viewTop : 0;
  }
  // Below the view on a deal — the reader pressed Deal at the top of the page: up by its bottom edge.
  if (bandBottom > viewBottom) return dealt ? bandBottom - viewBottom : 0;
  // The table has gone off the top: the band to the bottom edge, and the table back above it.
  if (tableBottom <= viewTop) return bandBottom - viewBottom;
  return 0;
}
