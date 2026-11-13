'use client';

/**
 * The route error boundary. It shows `error.digest` when Next supplies one, never `error.message`.
 * No `role="alert"` and no focus move, because the page replacement is announced by the navigation.
 * It owns an `h1` because it replaces the route's content. `retry()` re-fetches, while `reset()`
 * would re-render the same failed attempt. A root-layout failure falls through to `global-error.tsx`.
 */

import Link from 'next/link';
import type { ReactElement } from 'react';
import { NAV_DESTINATIONS } from '@/lib/nav.ts';

export interface ErrorBoundaryProps {
  readonly error: Error & { readonly digest?: string };
  readonly retry: () => void;
}

export default function RouteError(props: ErrorBoundaryProps): ReactElement {
  const { error, retry } = props;

  return (
    <section className="prl-container prl-section--tight">
      <p className="prl-label prl-label--strong">Error</p>
      <h1>This screen did not load</h1>
      <p>
        Something went wrong while rendering this page. Nothing you were doing has been lost: units are not
        affected, and no hand state is changed by a failed render.
      </p>

      <div className="prl-btn-row">
        <button className="prl-btn prl-btn--primary" onClick={() => retry()} type="button">
          Try again
        </button>
        <Link className="prl-btn prl-btn--secondary" href="/">
          Go to the home page
        </Link>
      </div>

      {error.digest === undefined ? null : (
        <p className="prl-note">
          Reference for a bug report: <code>{error.digest}</code>
        </p>
      )}

      <nav aria-label="Other sections">
        <ul>
          {NAV_DESTINATIONS.map((destination) => (
            <li key={destination.href}>
              <Link href={destination.href}>{destination.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </section>
  );
}
