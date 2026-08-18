'use client';

/**
 * The route error boundary.
 *
 * ## What it is allowed to say
 *
 * Not the exception. `error.message` on a production build is a digest-shaped string with no meaning
 * to a reader, and on a development build it is a stack-adjacent internal detail — neither belongs
 * on screen. What is shown is what the reader can act on (retry, or go somewhere that works) plus
 * `error.digest` when Next provides one, which is the value that correlates this screen with a
 * server log line without disclosing anything about the failure itself. The same reasoning the API
 * applies to its own error envelope, from the other side of the wire.
 *
 * ## Why this exists at all when every screen has a fixture
 *
 * A screen that cannot reach the API renders from a fixture and never gets here: that is a normal
 * condition handled by `safeFetch` returning a result rather than throwing. Arriving here means
 * something genuinely unexpected happened in a render — which makes "try again" a reasonable first
 * offer, because a transient failure is the likeliest cause, and a way out of the page the necessary
 * second one.
 *
 * ## Two details that are easy to get wrong
 *
 *  - **`role="alert"` is not used, and nothing retries automatically.** An assertive region
 *    interrupts whatever a screen reader was saying; this is a whole page replacement, so the
 *    heading is announced by the navigation itself. Focus is not moved either — the reader arrived
 *    here by their own action and the caret should stay where they left it.
 *  - **It owns an `h1`.** This markup replaces the route's content, so if it did not carry one the
 *    page would have no `h1` at all. `error.tsx` is a page for the duration it is on screen.
 *
 * ## `retry`, not `reset`
 *
 * Both are handed to this component. `reset()` clears the error state and re-renders the boundary's
 * children with what it already has; `retry()` re-FETCHES and re-renders. For a screen that failed
 * because something upstream was briefly unavailable, re-rendering the same stale attempt is not
 * "try again" — it is the same failure with a different animation. Next 16 names `retry` as the one
 * to reach for, and this is exactly the case it means.
 *
 * It must be a client component: `retry` is a function passed across the boundary, and there is no
 * server-side equivalent of "try rendering that again".
 *
 * NOTE: this boundary does not wrap the root layout, so a failure in the shell itself falls through
 * to `global-error.tsx` — which renders its OWN document and does not receive `globals.css` or the
 * `data-theme` attribute, so it cannot be themed from here. That file is not part of this change.
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

      {/* Only shown when Next actually supplied one. A "reference: undefined" line is worse than no
          reference, because a reader will try to quote it. */}
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
