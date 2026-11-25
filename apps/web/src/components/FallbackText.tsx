import type { ReactElement } from 'react';
import type { FallbackReason } from '@/lib/fallback.ts';

/** The same words as before, "text (cause)"; only the cause, a token with a URL in it, may break anywhere. */
export function FallbackText({ reason }: { readonly reason: FallbackReason }): ReactElement {
  return (
    <>
      {reason.text} <span className="prl-fallback-cause">({reason.cause})</span>
    </>
  );
}
