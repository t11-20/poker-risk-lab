'use client';

/**
 * The reset control the whole product promises and nothing implemented.
 *
 * ## What was wrong
 *
 * The footer says, on every page, that units are "free practice counters with no monetary value,
 * which you can reset to the starting amount whenever you like", and the home page says the same
 * thing. `POST /me/units/reset` has always existed, has no rate limit tighter than the global one,
 * and is deliberately unconditional — `docs/PRODUCT-GUARDRAILS.md` §1 requires the reset to be
 * always available and never penalised. It was in no client at all, not even as a path constant. A
 * stated right that cannot be exercised is a worse claim than not making it.
 *
 * ## Why this is a client component
 *
 * The API requires the double-submit CSRF token on every mutation, and a server render holds
 * neither the token nor the cookie paired with it. Forwarding a reader's CSRF secret into a
 * server-side POST is precisely the forgery the check exists to stop — see the boundary note in
 * `lib/server-session.ts`. So the reset is made from the browser, where the token is legitimately
 * held, which also means it is a real user gesture rather than something a render did on their
 * behalf.
 *
 * ## No confirmation dialog
 *
 * There is nothing to lose. Units are free, worth nothing, and cannot be bought, transferred or
 * redeemed, so a "are you sure?" would be ceremony implying a stake that does not exist — and it is
 * how a reset becomes something a reader hesitates over, which is exactly what the guardrail
 * forbids. What the reader IS told, before and after, is the one thing that genuinely does not
 * change: their played hands and everything derived from them stay exactly as they are.
 */

import { API_PATHS, type ResetUnitsResponse } from '@prl/contracts';
import { Button } from '@prl/ui';
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
          message:
            'This page could not get a security token from the server, so nothing was sent. Reload and try again.',
        });
        return;
      }
      // An empty object rather than no body at all: the endpoint accepts both, and a POST with a
      // `content-type` and no body is refused by Fastify's parser as a malformed request.
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
      {/*
        In the DOM from the first render, empty. A live region that arrives at the same moment as
        its text is missed by several screen readers, which for a control whose entire visible
        effect is a sentence would mean the press appeared to do nothing at all.
      */}
      <p className="prl-note" role="status">
        {reset.state === 'done'
          ? `Done. Your units are back to ${String(reset.units)}. Nothing else changed: the hands you have played, and every figure on this page derived from them, are exactly as they were.`
          : reset.state === 'failed'
            ? reset.message
            : ''}
      </p>
    </div>
  );
}
