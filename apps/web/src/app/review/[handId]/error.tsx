'use client';

/**
 * The error state for a hand replay.
 *
 * ## What reaches this boundary, and what deliberately does not
 *
 * Not "the API is missing". The page treats an unreachable or unshipped endpoint as a normal
 * condition and renders from its fixture, so an absent API never lands here — if it did, a developer
 * with no server running would see an error page instead of the screen they are building.
 *
 * What does land here is a failure the reader needs to know about: a session that expired, a hand
 * that belongs to somebody else, a protocol version the server refuses, a malformed response. Those
 * are conditions with consequences, and each of them means the figures on this page would have been
 * wrong rather than merely absent.
 *
 * ## Why the message is short and the digest is shown
 *
 * Next redacts a server-side error's message before it reaches the browser and replaces it with a
 * `digest` — deliberately, because an exception string can carry a query, a path or an id. So this
 * component cannot know what went wrong and does not pretend to. It shows the digest, which is what
 * correlates the reader's failure with the server log line that explains it, and it offers the two
 * things that actually help: retry, and go back to the list.
 *
 * `reset()` re-renders the segment rather than reloading the document, so a transient failure costs
 * one click and no scroll position.
 */

import { Button } from '@prl/ui';
import type { ReactElement } from 'react';

export default function HandReviewError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}): ReactElement {
  return (
    <div className="prl-container">
      <div className="prl-error" role="alert">
        <p className="prl-error__title">
          <span aria-hidden="true">! </span>
          Error — this hand could not be loaded
        </p>
        <p>
          The request reached the server and the server refused it. That is different from the server being
          absent: it means there is a reason, and the reason is recorded in the server log rather than shown
          here, because an error message can carry parts of a request that should not be repeated back into a
          page.
        </p>
        <p>
          The most common causes are a session that has expired and a hand that belongs to a different
          account. Neither is retried automatically, because a retry would not fix either one.
        </p>
        {error.digest === undefined ? null : (
          <p>
            <span className="prl-label">Log reference</span> <code className="prl-mono">{error.digest}</code>
          </p>
        )}
        <div className="prl-btn-row">
          <Button variant="primary" onClick={() => reset()}>
            Try again
          </Button>
          <a className="prl-btn prl-btn--secondary" href="/review">
            Back to hand history
          </a>
        </div>
      </div>
    </div>
  );
}
