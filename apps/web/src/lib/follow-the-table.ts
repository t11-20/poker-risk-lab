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
 * The region that matters is the street line and the price strip, the sizer, and the row where it
 * sits IN FLOW — read off the top of the note that follows it, because the row's own box is wherever
 * it is stuck. If that region fits between the root's scroll padding (the sticky header above, the
 * Coach peek below), it is brought in by its nearest edge, exactly as the buttons were: the row then
 * sits at its own place under the sizer, where it is not stuck and covers nothing. If it does not fit
 * — measured at 390x844 it is 611px of the 687px available, 664px with a street line, so this is a
 * short phone like 360x640 — the sizer's top goes to the top edge, presets and slider first, and the
 * row sticks over the readout at the bottom of the sizer rather than over the controls.
 *
 * The reader's own plate and the board are above this region, and at 390x844 they go off the top to
 * make room. That is the trade: the sizer is the thing that has to be usable at this moment, the
 * street line names who bet, and the stuck row brings the buttons back the moment the reader scrolls
 * up to look at their cards.
 *
 * Pure, and in its own file, so `node --test` drives it with the rectangles the browser measured.
 */

/** Viewport coordinates, as `getBoundingClientRect` gives them. */
export interface SizerGeometry {
  /** The top of the first thing in the band worth keeping: the street line, else the bar. */
  readonly regionTop: number;
  /** The sizer's top edge. */
  readonly sizerTop: number;
  /** The sizer's bottom edge. */
  readonly sizerBottom: number;
  /** Where the row sits when it is NOT stuck: the top of the block after it. */
  readonly rowFlowBottom: number;
  /** The row's box as painted, stuck or not. */
  readonly rowTop: number;
  /** The root's `scroll-padding-block-start`: the bottom of the sticky header. */
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
  const { regionTop, sizerTop, rowFlowBottom, viewTop, viewBottom } = geometry;
  const covered = rowCoversSizer(geometry);
  if (!covered && regionTop >= viewTop && rowFlowBottom <= viewBottom) return 0;
  if (rowFlowBottom - regionTop <= viewBottom - viewTop) {
    return regionTop < viewTop ? regionTop - viewTop : rowFlowBottom - viewBottom;
  }
  return sizerTop - viewTop;
}
