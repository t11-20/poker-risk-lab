'use client';

/**
 * The units reset, always available and never penalised (`docs/PRODUCT-GUARDRAILS.md` §1). A client
 * component, because the CSRF token lives in the browser and must not be forwarded into a server POST
 * (`lib/server-session.ts`). No confirmation dialog, because there is nothing to lose.
 */

import { API_PATHS, type ResetUnitsResponse } from '@prl/contracts';
import { Button, formatUnits } from '@prl/ui';
import { type ReactElement, useState } from 'react';
import { apiSend, fetchSession, safeFetch } from '@/lib/api.ts';

type ResetState =
  | { readonly state: 'idle' }
  | { readonly state: 'working' }
  | { readonly state: 'done'; readonly units: number }
  | { readonly state: 'failed'; readonly message: string };

export function UnitsReset(): ReactElement {
  const [reset, setReset] = useState<ResetState>({ state: 'idle' });

  const run = (): void => {
    setReset({ state: 'working' });
    void (async () => {
      const session = await fetchSession();
      const token = session.ok ? session.data.csrfToken : null;
      if (token === null) {
        setReset({
          state: 'failed',
          // The CSRF token could not be fetched. The learner can act on "reload", not on "token".
          message:
            'Something went wrong before anything was sent, so nothing changed. Reload the page and try again.',
        });
        return;
      }
      // An empty object, because Fastify refuses a POST with a `content-type` and no body.
      const result = await safeFetch<ResetUnitsResponse>(() =>
        apiSend<ResetUnitsResponse>('POST', API_PATHS.unitsReset(), {}, { csrfToken: token }),
      );
      setReset(
        result.ok
          ? { state: 'done', units: result.data.units }
          : { state: 'failed', message: `${result.error.message} Nothing was changed.` },
      );
    })();
  };

  return (
    <div className="prl-stack">
      <p className="prl-btn-row">
        <Button variant="secondary" onClick={run} disabled={reset.state === 'working'}>
          {reset.state === 'working' ? 'Resetting…' : 'Reset my units to the starting amount'}
        </Button>
      </p>
      {/* Mounted empty from the first render. Screen readers miss a region that mounts with its text. */}
      <p className="prl-note" role="status">
        {reset.state === 'done'
          ? // `formatUnits`, so this reads "1,000 units" like the footer and the header badge.
            `Done. You are back to ${formatUnits(reset.units)}. Nothing else changed: the hands you have played, and every figure on this page derived from them, are exactly as they were.`
          : reset.state === 'failed'
            ? reset.message
            : ''}
      </p>
    </div>
  );
}
