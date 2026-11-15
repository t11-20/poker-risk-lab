/**
 * How far to scroll so a reader can reach the bet sizer on a narrow column. Below 46rem the action row
 * sticks to the viewport bottom, and following it by its nearest edge paints it over the sizer, so a
 * tap on a preset hits a button (390x844).
 * The kept region runs from the street line to the row's in-flow bottom. When it does not fit, the
 * street line goes first, then the row's place in flow, so it sticks over the sizer's readout. The price
 * and `HandGlance` (cards and board) stay while the sizer's controls clear the stuck row, because a bet
 * must not be sized without seeing the price and the cards. Pure, so `node --test` drives it with
 * measured rectangles.
 */

/** Viewport coordinates, as `getBoundingClientRect` gives them. */
export interface SizerGeometry {
  /** The top of the first thing in the band worth keeping: the street line, else the bar. */
  readonly regionTop: number;
  /** The top of the price row (pot and price to continue), or null where it is not drawn. */
  readonly priceTop: number | null;
  /** The top of `HandGlance`, or null where it is not drawn. */
  readonly handTop: number | null;
  readonly sizerTop: number;
  readonly sizerBottom: number;
  /** The bottom of the sizer's slider and number field: what the stuck row must never cover. */
  readonly controlsBottom: number;
  /** Where the row's top is painted while it is stuck. */
  readonly rowStuckTop: number;
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
  const { regionTop, priceTop, handTop, sizerTop, streetBottom, coverBottom, rowFlowBottom } = geometry;
  const { controlsBottom, rowStuckTop, viewTop, viewBottom } = geometry;
  const covered = rowCoversSizer(geometry);
  if (!covered && regionTop >= viewTop && rowFlowBottom <= viewBottom) return 0;
  const room = viewBottom - viewTop;
  if (rowFlowBottom - regionTop <= room) {
    return regionTop < viewTop ? regionTop - viewTop : rowFlowBottom - viewBottom;
  }
  // The highest block that can sit at the top edge with the controls still clear of the stuck row.
  const keep =
    [priceTop, handTop].find((top) => top !== null && controlsBottom - (top - viewTop) <= rowStuckTop) ??
    sizerTop;
  // The cards down to the row fit. Drop the street line whole, because a 7px sliver of it under the
  // header reads as a rendering fault.
  const toBottom = rowFlowBottom - viewBottom;
  if (keep - toBottom < viewTop) return keep - viewTop;
  const whole = streetBottom === null ? toBottom : Math.max(toBottom, streetBottom - coverBottom);
  return keep - whole >= viewTop ? whole : toBottom;
}

/**
 * Scroll for when the decision is not the reader's, so the table is on screen again. When the table
 * is off the top and the band fits, the band goes to the bottom edge with the table above it. A reader
 * with any of their plate on screen is not moved, except at the end of a hand: the result arrives above
 * the band and pushes the deal control off the bottom.
 */
export interface WatchGeometry {
  readonly bandTop: number;
  readonly bandBottom: number;
  /** The reader's own plate, or the table's last block when they hold none: what "watching" sees. */
  readonly tableBottom: number;
  readonly viewTop: number;
  readonly viewBottom: number;
  /** A deal, or a hand's end for a reader at or below their plate, brings up a band below the view. */
  readonly edge: 'dealt' | 'decided' | 'complete';
}

/** Pixels to scroll by (negative is up the page), or 0 to leave the page where it is. */
export function watchDelta(geometry: WatchGeometry): number {
  const { bandTop, bandBottom, tableBottom, viewTop, viewBottom, edge } = geometry;
  if (bandBottom - bandTop > viewBottom - viewTop) {
    return edge === 'dealt' && bandTop > viewBottom ? bandTop - viewTop : 0;
  }
  // A reader who scrolled above their plate is left there when the hand ends.
  const follows = edge === 'dealt' || (edge === 'complete' && tableBottom <= viewBottom);
  if (bandBottom > viewBottom) return follows ? bandBottom - viewBottom : 0;
  if (tableBottom <= viewTop) return bandBottom - viewBottom;
  return 0;
}
