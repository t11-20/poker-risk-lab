/**
 * Whether a sideways-scrolling region is a tab stop: exactly when it can scroll sideways.
 *
 * ## The failure this is written against
 *
 * `/review`'s hand-history table sat in a `<section tabIndex={0}>` so a keyboard reader could bring
 * its right-hand columns into view (axe `scrollable-region-focusable`, WCAG 2.1.1). Below 1024px the
 * rows became stacked cards and the region stopped scrolling — but stayed a tab stop. At 360x640
 * that tab stop is 1,549px tall, and `test:keyboard`'s backwards walk focused it with its top at
 * y=-134 under a bar ending at 129: 263px of a control behind the glass, on a stop that does
 * nothing when focused. On `main`, where the table never became cards, the same walk passes.
 *
 * ## Which way this fails, and why that way
 *
 * Two errors are possible. A region that can scroll and is not focusable leaves a keyboard reader
 * unable to reach the columns at all — a WCAG 2.1.1 failure. A region that cannot scroll and is
 * focusable is one extra tab stop that does nothing. The second is the lesser harm, so it is the
 * default: the server renders the stop, and only a measurement taken in a browser removes it.
 *
 * Equal widths mean nothing is hidden, so they do not count as scrolling. The browser has already
 * rounded both numbers to integers, so an overflow of under a pixel reads as equal and counts as
 * fitting — there is nothing to see past an edge that close.
 */

/** The two numbers the decision reads, so the function is testable without a DOM. */
export interface ScrollBox {
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** Whether there is content past the region's right edge to scroll to. */
export function scrollsSideways(box: ScrollBox): boolean {
  return box.scrollWidth > box.clientWidth;
}

/**
 * The `tabIndex` the region should carry: `0` when it scrolls, otherwise no attribute at all.
 *
 * Absent rather than `-1` on purpose. `-1` still makes the section focusable by a click or a script,
 * and it still matches the `[tabindex]` selectors every keyboard gate in this repo builds its
 * focusable set from — a section that is not a control should not look like one to either.
 */
export function scrollRegionTabIndex(box: ScrollBox): 0 | undefined {
  return scrollsSideways(box) ? 0 : undefined;
}
