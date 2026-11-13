'use client';

/**
 * The hand replay's error boundary. An unreachable API never lands here, because the page renders a
 * fixture or an explanation instead. Next replaces a server error's message with a `digest`, so this
 * shows the digest and does not guess the cause.
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
