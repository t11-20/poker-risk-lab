/**
 * The 404 page.
 *
 * ## THIS PAGE ONLY ANSWERS 404 BECAUSE THERE IS NO `loading.tsx` ABOVE IT
 *
 * The most important fact about this file is not in this file. A `loading.tsx` is a Suspense
 * boundary, and Next sends the shell the moment a boundary's fallback renders — which means the
 * response headers are already on the wire before the page has decided anything. `notFound()` then
 * swaps this content into an in-flight `200`. That is what was happening: a missing lesson,
 * scenario, profile or hand rendered "Page not found" under HTTP 200, to readers and to crawlers
 * alike, and no amount of care in a page could change it.
 *
 * There WAS an `app/loading.tsx` — a generic skeleton for every route — and an
 * `app/review/[handId]/loading.tsx`. Both are gone, and neither should come back at the root:
 *
 *  - **Status.** With no boundary above them, these routes render to completion before the
 *    response starts, so `notFound()` sets a real `404`. `apps/web/test/app-shell-streaming.test.ts`
 *    refuses a route-level `loading.tsx` anywhere under `src/app`, so the boundary cannot come back.
 *  - **Readable without JavaScript.** A Suspense fallback is replaced by React's inline `$RC`
 *    script once the real payload arrives. With scripting unavailable that swap never runs, so
 *    every route in this app showed its skeleton permanently — indistinguishable from a hung page,
 *    on a product whose lessons and scenario write-ups are ordinary prose with no reason to need
 *    scripting at all.
 *
 * The trade-off is real and is accepted: a route that waits on the API now shows the previous page
 * until the new one is ready, rather than a skeleton. That is a slower-feeling navigation; a page
 * that is silently the wrong status code, and blank without JavaScript, is a broken one. A route
 * that genuinely needs a placeholder should put its own `<Suspense>` *below* its existence check,
 * around the part that is slow, so the 404 decision is still made before anything is sent.
 *
 * ## One case this does NOT fix, measured rather than assumed
 *
 * An unmatched URL — `/nonsense` — renders this page as ordinary HTML: shell, heading, the five
 * destinations, all present with scripting off. That is the routing-level 404 and it is complete.
 *
 * A `notFound()` thrown from inside a page — a profile id, a scenario id, a hand id that does not
 * exist — answers `404` with an EMPTY HTML body, and delivers this content only in the RSC payload
 * for the client to render. That is Next 16 itself, not this app: `app-render.js`, the
 * `MARK: errorRecovery` path, re-renders the tree as `ErrorApp` and then explicitly inlines "the
 * readable datastream from the main render rather than the flight data from the error page render"
 * — its own comment. It behaves the same way for a crawler user-agent, which was checked. Removing
 * `loading.tsx` does not reach it and neither does a segment-level `not-found.tsx`, which was tried.
 *
 * The status code is right, `noindex` is set, and the four routes it affects all take an identifier
 * a reader can only have got from a link or a typo. Two app-level workarounds exist and both are
 * worse than the symptom: prerendering these routes with `dynamicParams: false` would turn a
 * per-reader page into a build-time one, and a `proxy.ts` that knew every valid id would be a
 * second source of truth for what exists — and could not cover `/review/[handId]` at all, whose ids
 * are one reader's own. Left as a framework issue with the line recorded here.
 *
 * ## Why it lists the destinations rather than apologising
 *
 * A reader arrives here with a goal and a broken URL. "Page not found" tells them the state; the
 * five destinations with a line each tell them what to do about it, which is the only useful thing
 * this page can offer. That is also why the summaries are here rather than bare labels: somebody who
 * mistyped a URL may not know which of five sections had the thing they wanted.
 *
 * It owns an `h1` because it replaces the route's content, and it renders inside the shell, so the
 * header, the units badge and the footer are all still where they were — a 404 that loses the
 * navigation strands the reader twice.
 *
 * A server component: nothing here needs the browser.
 */

import { formatIndex } from '@prl/ui';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { NAV_DESTINATIONS } from '@/lib/nav.ts';

export const metadata: Metadata = {
  title: 'Page not found',
};

/** Shared 404 body so `notFound()`-avoiding pages still ship a real heading and nav. */
export function NotFoundBody(): ReactElement {
  return (
    <section className="prl-container prl-section--tight">
      <p className="prl-label prl-label--strong">404</p>
      <h1>Page not found</h1>
      <p>
        There is nothing at this address. It may have moved, or the link may have been mistyped — here is
        everything the app can actually show you.
      </p>

      <nav aria-label="All sections">
        <ul className="prl-footer__list">
          {NAV_DESTINATIONS.map((destination, position) => (
            <li className="prl-footer__item" key={destination.href}>
              <Link className="prl-footer__link" href={destination.href}>
                <span aria-hidden="true" className="prl-index">
                  {formatIndex(position + 1)}
                </span>
                <span className="prl-footer__link-label">{destination.label}</span>
              </Link>
              <span className="prl-footer__summary">{destination.summary}</span>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}

export default function NotFound(): ReactElement {
  return <NotFoundBody />;
}
