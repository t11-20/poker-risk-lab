'use client';

/**
 * What a screen reader is told when the app navigates without loading a document.
 *
 * Next's `AppRouterAnnouncer` does announce route changes, but from a shadow root that some screen
 * readers and every light-DOM audit miss, with `role="alert"` (assertive), and only when the title
 * changes. So this polite light-DOM region replaces it, and the mount effect removes the framework's
 * element. If this component fails to mount, the framework's announcer survives.
 *
 * It announces the new `<title>` once it lands (up to `TITLE_SETTLE_MS`), says nothing on first load
 * or when the title is unchanged, never moves focus, and does not read `useSearchParams`, which would
 * opt every page into client rendering.
 */

import { usePathname } from 'next/navigation';
import { type ReactElement, useEffect, useRef, useState } from 'react';

/** Exported so `test/route-announcer.test.ts` pins it against the installed Next. */
export const FRAMEWORK_ANNOUNCER_ELEMENT = 'next-route-announcer';

/** Covers a route whose metadata lands in a later commit. Long enough for a slow one, not a stale one. */
const TITLE_SETTLE_MS = 2_000;

/** The document's title right now, with the same `<h1>` fallback the framework uses for an empty one. */
function currentTitle(): string {
  const title = document.title.trim();
  if (title.length > 0) return title;
  const heading = document.querySelector('h1');
  return (heading?.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

export function RouteAnnouncer(): ReactElement {
  const pathname = usePathname();
  const [announcement, setAnnouncement] = useState('');
  /** The title already announced. `null` until the first run, which makes the initial load silent. */
  const spoken = useRef<string | null>(null);

  // Stands down the framework's announcer after each commit. A timeout, because React runs the
  // ancestor `AppRouter`'s mount effect, which creates it, after this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the TRIGGER, not a value this effect reads. Without it the stand-down runs once on mount and never again, and any commit that re-created the element would leave two announcers speaking.
  useEffect(() => {
    const timer = setTimeout(() => {
      document.getElementsByTagName(FRAMEWORK_ANNOUNCER_ELEMENT)[0]?.remove();
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the TRIGGER, not a value this effect reads — what it reads is `document.title`, which the router updates in the same commit. Removing it means the announcement fires once, on the first load, and never on a navigation.
  useEffect(() => {
    /** True when there is nothing left to wait for, because it has been announced, or it never will be. */
    const settle = (title: string): boolean => {
      if (title.length === 0) return false;
      const previous = spoken.current;
      // The first run records and says nothing, because the screen reader reads a fresh load itself.
      if (previous === null) {
        spoken.current = title;
        return true;
      }
      // The new route's title is not in `<head>` yet, so keep watching.
      if (previous === title) return false;
      spoken.current = title;
      setAnnouncement(title);
      return true;
    };

    if (settle(currentTitle())) return undefined;

    // React replaces the title node rather than editing it, so watch the subtree and child list.
    const head = document.head;
    const observer = new MutationObserver(() => {
      if (settle(currentTitle())) observer.disconnect();
    });
    observer.observe(head, { childList: true, subtree: true, characterData: true });
    const giveUp = setTimeout(() => observer.disconnect(), TITLE_SETTLE_MS);
    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
    };
  }, [pathname]);

  /** Mounted empty from the first render, because a region that arrives with its text is missed. */
  return (
    <div
      aria-atomic="true"
      aria-live="polite"
      className="prl-live-region"
      data-prl-route-announcer="true"
      role="status"
    >
      {announcement}
    </div>
  );
}
