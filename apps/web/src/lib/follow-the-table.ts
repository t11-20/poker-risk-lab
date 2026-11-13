/**
 * How far to scroll so a reader can reach the bet sizer on a narrow column. Below 46rem the action row
 * sticks to the viewport bottom, and following it by its nearest edge painted it over the sizer, so a
 * tap on a preset hit a button (390x844).
 * The kept region runs from the street line to the row's in-flow bottom. When it does not fit, the
 * street line goes first and `HandGlance` (cards and board) stays, because sizing a bet without seeing
 * the cards was the first version's defect. Pure, so `node --test` drives it with measured rectangles.
 */

/** Viewport coordinates, as `getBoundingClientRect` gives them. */
export interface SizerGeometry {
  /** The top of the first thing in the band worth keeping: the street line, else the bar. */
  readonly regionTop: number;
  /** The top of `HandGlance`, or null where it is not drawn. Kept above everything else. */
  readonly handTop: number | null;
  readonly sizerTop: number;
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
  // The cards down to the row fit. Drop the street line whole, because a 7px sliver of it under the
  // header read as a rendering fault.
  const toBottom = rowFlowBottom - viewBottom;
  if (keep - toBottom < viewTop) return keep - viewTop;
  const whole = streetBottom === null ? toBottom : Math.max(toBottom, streetBottom - coverBottom);
  return keep - whole >= viewTop ? whole : toBottom;
}

/**
 * Scroll for when the decision is not the reader's, so the table is on screen again. When the table
 * is off the top and the band fits, the band goes to the bottom edge with the table above it. A reader
 * with any of their plate on screen is not moved.
 */
export interface WatchGeometry {
  readonly bandTop: number;
  readonly bandBottom: number;
  /** The reader's own plate, or the table's last block when they hold none: what "watching" sees. */
  readonly tableBottom: number;
  readonly viewTop: number;
  readonly viewBottom: number;
  /** True when a hand is dealt. Only then is a band BELOW the view brought up. */
  readonly dealt: boolean;
}

/** Pixels to scroll by (negative is up the page), or 0 to leave the page where it is. */
export function watchDelta(geometry: WatchGeometry): number {
  const { bandTop, bandBottom, tableBottom, viewTop, viewBottom, dealt } = geometry;
  if (bandBottom - bandTop > viewBottom - viewTop) {
    return dealt && bandTop > viewBottom ? bandTop - viewTop : 0;
  }
  // The reader pressed Deal at the top of the page.
  if (bandBottom > viewBottom) return dealt ? bandBottom - viewBottom : 0;
  if (tableBottom <= viewTop) return bandBottom - viewBottom;
  return 0;
}
