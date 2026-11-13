/**
 * The 404 page. It answers a real 404 only because no `loading.tsx` sits above it. A Suspense
 * boundary sends a 200 shell before the page decides, and its skeleton never clears without
 * JavaScript. `app-shell-streaming.test.ts` refuses a route-level `loading.tsx`. A slow route should
 * put its own `<Suspense>` below its existence check. A `notFound()` thrown inside a page still
 * answers 404 with an empty HTML body in Next 16 (`app-render.js`, errorRecovery), so dynamic pages
 * render `NotFoundBody` instead.
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactElement } from 'react';
import { SuitMark } from '@/components/SuitMark.tsx';
import { NAV_DESTINATIONS, RECORD_DESTINATION } from '@/lib/nav.ts';

export const metadata: Metadata = {
  title: 'Page not found',
};

/** Rendered by dynamic pages so a missing id still ships a real heading and nav. */
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
          {NAV_DESTINATIONS.map((destination) => (
            <li className="prl-footer__item" key={destination.href}>
              <Link className="prl-footer__link" href={destination.href}>
                <SuitMark area={destination.area ?? null} />
                <span className="prl-footer__link-label">{destination.label}</span>
              </Link>
              <span className="prl-footer__summary">{destination.summary}</span>
            </li>
          ))}
          {/* After the five and unmarked: see `RECORD_DESTINATION`. */}
          <li className="prl-footer__item">
            <Link className="prl-footer__link" href={RECORD_DESTINATION.href}>
              <SuitMark area={null} />
              <span className="prl-footer__link-label">{RECORD_DESTINATION.label}</span>
            </Link>
            <span className="prl-footer__summary">{RECORD_DESTINATION.summary}</span>
          </li>
        </ul>
      </nav>
    </section>
  );
}

export default function NotFound(): ReactElement {
  return <NotFoundBody />;
}
