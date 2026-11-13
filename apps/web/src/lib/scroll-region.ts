/**
 * Whether a sideways-scrolling region is a tab stop: exactly when it can scroll sideways. A scrolling
 * region that is not focusable fails WCAG 2.1.1, and a still one that is focusable is a dead tab stop
 * (1,549px tall on `/review` at 360x640). The dead stop is the lesser harm, so the server renders it
 * and only a browser measurement removes it. Integer widths, so sub-pixel overflow counts as fitting.
 */

/** The two numbers the decision reads, so the function is testable without a DOM. */
export interface ScrollBox {
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

export function scrollsSideways(box: ScrollBox): boolean {
  return box.scrollWidth > box.clientWidth;
}

/** Absent, not `-1`, which is still focusable by click and matches the keyboard gates' `[tabindex]`. */
export function scrollRegionTabIndex(box: ScrollBox): 0 | undefined {
  return scrollsSideways(box) ? 0 : undefined;
}
