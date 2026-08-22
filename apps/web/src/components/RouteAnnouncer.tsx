'use client';

/**
 * What a screen reader is told when the app navigates without loading a document.
 *
 * ## The premise, checked rather than assumed
 *
 * The obvious version of this file's justification — "nothing announces a client navigation" — is
 * false in this app, and it was worth ten minutes of a real browser to find that out before writing
 * a line. Next 16.3.0 ships `AppRouterAnnouncer`
 * (`next/dist/client/components/app-router-announcer.js`), the App Router mounts it unconditionally,
 * and it works: driving Chrome 151 over the DevTools Protocol against a production `next start` of
 * this app and clicking a real `<Link>` from `/` to `/learn`, the framework's announcer went from
 * `""` to `"Learn — Poker Risk Lab"` within 300ms, and stayed empty on the initial load. So the
 * route change IS announced today.
 *
 * Three things about *how* it is announced are the actual defects, and they are why this file
 * exists:
 *
 *  1. **It lives in a shadow root.** The framework appends `<next-route-announcer>` to `<body>`,
 *     attaches an open shadow root, and puts the live region inside it — explicitly "to avoid any
 *     potential CSS bleed". A live region inside a shadow tree is not announced by every
 *     screen-reader/browser pair (Safari with VoiceOver has the longest history of dropping them),
 *     and it is invisible to every tool that walks the light DOM, this repo's `a11y-audit.mjs`
 *     included. That is how a previous audit of this app came within one shadow-root inspection of
 *     filing "route change not announced" as a real finding.
 *  2. **It is assertive.** `role="alert"` plus `aria-live="assertive"` interrupts whatever the
 *     reader was in the middle of, on every navigation. Arriving at a page is not an emergency, and
 *     an app that interrupts on every link makes its reader stop trusting interruptions.
 *  3. **It announces only when `document.title` changed**, which is correct as far as it goes and
 *     silently does nothing when two routes share a title.
 *
 * ## So this replaces it rather than joining it
 *
 * Two live regions announcing the same sentence is worse than one announcing it badly: the reader
 * hears the page title twice, once interrupting and once not. The mount effect below therefore
 * removes the framework's host element, and this polite, light-DOM region becomes the single place
 * a route change is announced.
 *
 * Removing it is safe in both directions. The framework's own cleanup is guarded by
 * `container?.isConnected`, so it tolerates the node already being gone; and its announcement state
 * is written through a `createPortal` into the (now detached) node, which is inert rather than an
 * error. Most importantly the removal happens *inside this component's effect*, so a build where
 * this component fails to mount keeps the framework's announcer rather than losing both.
 *
 * ## Why the removal is deferred by a timeout, and not done inline
 *
 * React runs a child's effects before its parent's. `AppRouterAnnouncer` is rendered by `AppRouter`,
 * which is an ancestor of everything in the app, so on the first commit its mount effect — the one
 * that creates the element — runs *after* this component's. An inline `remove()` would find nothing
 * and the element would be created a moment later. A `setTimeout(0)` puts the removal after the
 * whole commit, which is the only ordering that works on the first paint as well as on every
 * navigation after it.
 *
 * ## Announcing after the page has rendered, not when the URL changed
 *
 * `usePathname` changes when the router commits the new route, and the new route's `<title>` is
 * hoisted into `<head>` by React in the same commit — measured, not assumed: in the run above the
 * pathname and the title were both current at the first observation after the click. A streamed
 * route can still resolve its metadata later, so this does not read the title once and give up: if
 * the title has not changed by the time the effect runs it watches `<head>` for one and announces
 * when it lands, up to `TITLE_SETTLE_MS`. Either way exactly one sentence is announced per
 * navigation, because the observer is disconnected the moment it fires.
 *
 * If the title never changes, nothing is announced. That is deliberate. Two routes with the same
 * title is a defect in those routes' metadata and the fix belongs there; making this region say
 * something anyway would mean inventing a sentence out of a URL, which is how a page ends up being
 * announced as "slash lab slash preflop open cutoff".
 *
 * ## What it deliberately does not do
 *
 *  - **It does not move focus.** Moving focus to the new page's heading is a legitimate pattern and
 *    it is not this app's: the reader arrives by their own click, the skip link already puts them
 *    into `<main>` in one keystroke, and a router that yanks the caret makes "open this in the
 *    background and carry on reading" impossible.
 *  - **It does not read `useSearchParams`.** That hook opts every page under this layout into
 *    client-side rendering unless it is wrapped in its own Suspense boundary, which is a large cost
 *    for the one case it would buy: `/play?state=error` and `/play?state=decision` share a pathname.
 *    Those are a fixture-inspection affordance, not a journey.
 *  - **It does not announce the first load.** The browser and the screen reader already read a
 *    freshly loaded document, and announcing over that is the double-speak this file exists to
 *    remove.
 *
 * Remove this file and route changes go back to being announced assertively from inside a shadow
 * root — audible on some setups, silent on others, and invisible to every audit this repo runs.
 */

import { usePathname } from 'next/navigation';
import { type ReactElement, useEffect, useRef, useState } from 'react';

/**
 * The element Next appends to `<body>` to hold its own announcer.
 *
 * Exported so `test/route-announcer.test.ts` can pin it against the installed framework rather than
 * against a string this file happens to contain: if a Next upgrade renames it, the test fails and
 * somebody re-checks whether the framework's announcer is still there to stand down, instead of
 * this app quietly gaining a second one nobody can hear from the light DOM.
 */
export const FRAMEWORK_ANNOUNCER_ELEMENT = 'next-route-announcer';

/**
 * How long to keep waiting for a route's `<title>` to arrive before giving up on announcing it.
 *
 * Not a guess at network latency: the title is already in the commit for every route measured on
 * this app, so this window only covers a route whose metadata resolves in a later commit. Long
 * enough that a slow one still gets announced, short enough that the sentence cannot arrive so late
 * that it describes a page the reader has already left. A navigation that takes longer than this is
 * a performance problem, and announcing a stale title would hide it.
 */
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
  /**
   * The title the reader has already been told about.
   *
   * `null` until the first navigation, which is what makes the initial load silent: the effect
   * below records the title it found and announces nothing, so the first *change* is the first
   * announcement.
   */
  const spoken = useRef<string | null>(null);

  // The framework's shadow-DOM announcer, stood down once per commit that could have re-created it.
  // See the header for why this is a timeout and not an inline call.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the TRIGGER, not a value this effect reads. Without it the stand-down runs once on mount and never again, and any commit that re-created the element would leave two announcers speaking.
  useEffect(() => {
    const timer = setTimeout(() => {
      document.getElementsByTagName(FRAMEWORK_ANNOUNCER_ELEMENT)[0]?.remove();
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` is the TRIGGER, not a value this effect reads — what it reads is `document.title`, which the router updates in the same commit. Removing it means the announcement fires once, on the first load, and never on a navigation.
  useEffect(() => {
    /** True when there is nothing left to wait for: either it has been announced, or it never will be. */
    const settle = (title: string): boolean => {
      if (title.length === 0) return false;
      const previous = spoken.current;
      // The first run records and says nothing: the document that has just loaded is read by the
      // browser and the screen reader between them, and this would be talking over it.
      if (previous === null) {
        spoken.current = title;
        return true;
      }
      // The new route's title has not been hoisted into `<head>` yet. Not settled — keep watching.
      if (previous === title) return false;
      spoken.current = title;
      setAnnouncement(title);
      return true;
    };

    if (settle(currentTitle())) return undefined;

    // The title has not landed yet. Watch for it rather than reading once and losing the
    // announcement — `<head>` is where React hoists it, and it replaces the node rather than
    // editing it, so both the subtree and the child list have to be watched.
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

  /**
   * In the DOM from the first render, empty, and never conditionally mounted.
   *
   * A live region that arrives at the same moment as its text is missed by several screen readers —
   * the same rule the table, the quiz and the invite-code copy button all follow in this codebase.
   * `role="status"` carries `aria-live="polite"` and `aria-atomic="true"` implicitly; both are
   * written out because this app's other regions do, and because the atomic half is the reason the
   * whole title is read rather than the characters that changed.
   */
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
