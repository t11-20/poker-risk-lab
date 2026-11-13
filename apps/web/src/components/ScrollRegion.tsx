'use client';

/**
 * A named region around a wide table that is a tab stop exactly when it scrolls sideways. The
 * reasoning is in `../lib/scroll-region.ts`. The first render is focusable on server and client,
 * because guessing "cannot scroll" is the WCAG 2.1.1 failure. The table is observed as well as the
 * region, because a late web font widens the table alone. Biome does not report the computed
 * `tabIndex` expression, so no suppression is needed.
 */

import { type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { scrollRegionTabIndex } from '../lib/scroll-region.ts';

interface ScrollRegionProps {
  readonly className: string;
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
