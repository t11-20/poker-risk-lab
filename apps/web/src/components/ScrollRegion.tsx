'use client';

/**
 * A named region around a wide table that is a tab stop exactly when it scrolls sideways.
 *
 * The decision and the incident behind it are in `../lib/scroll-region.ts`. What lives here is the
 * measuring, and two choices about it:
 *
 *   - **The first render is focusable, on the server and on the client.** The state starts at
 *     `true` and the DOM is read only in an effect. Reading it during render would make the server
 *     markup and the hydrated markup disagree, and a server that guesses "cannot scroll" is the
 *     WCAG 2.1.1 failure, not the extra tab stop. Where `ResizeObserver` does not exist the region
 *     is measured once and never again, which leaves it in whatever state that one measurement said.
 *   - **It observes the table as well as the region.** A web font arriving widens the table without
 *     resizing the section around it, and a section-only observer would keep the answer it gave in
 *     the fallback face.
 *
 * The region keeps its `<section aria-label>` either way, so a screen reader still finds the table
 * as a named region; only the tab stop comes and goes.
 *
 * There is no `biome-ignore` here, where `/review` used to carry one. `noNoninteractiveTabindex`
 * reports a literal `tabIndex={0}`; this value is a measurement, `0` only while the region scrolls,
 * which is the case CoachPanel's suppression argues for. Biome cannot see the measurement and does
 * not report the expression, so a suppression here would be one with nothing to suppress.
 */

import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { scrollRegionTabIndex } from '../lib/scroll-region.ts';

interface ScrollRegionProps {
  readonly className: string;
  /** The region's accessible name — the thing a tab stop announces, so it is not optional. */
  readonly label: string;
  readonly children: ReactNode;
}

export function ScrollRegion({ className, label, children }: ScrollRegionProps): ReactElement {
  const region = useRef<HTMLElement>(null);
  const [tabIndex, setTabIndex] = useState<0 | undefined>(0);

  useEffect(() => {
    const element = region.current;
    if (element === null) return;
    const measure = (): void => setTabIndex(scrollRegionTabIndex(element));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.firstElementChild !== null) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <section ref={region} className={className} tabIndex={tabIndex} aria-label={label}>
      {children}
    </section>
  );
}
