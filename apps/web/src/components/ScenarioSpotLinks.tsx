'use client';

/**
 * On a built-in scenario's page: "Edit a copy", or, once the player has saved an edit of it, a link to
 * that edit and "Reset to original". The scenario itself is never changed; resetting deletes the edit.
 */

import { Button } from '@prl/ui';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { editOf, resetToOriginal } from '../lib/spot-storage.ts';
import { useSpotLibrary } from '../lib/use-spot-library.ts';

export function ScenarioSpotLinks({ scenarioId }: { readonly scenarioId: string }): ReactElement {
  const { library, commit } = useSpotLibrary();
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState('');
  const keepRef = useRef<HTMLButtonElement>(null);
  const href = `/lab/spots/edit?from=${encodeURIComponent(scenarioId)}`;
  const edit = editOf(library.spots, scenarioId);

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  return (
    <div className="prl-spot-links">
      {edit === undefined ? (
        <p className="prl-spot-links__line">
          <a className="prl-btn prl-btn--secondary prl-btn--sm" href={href}>
            Edit a copy
          </a>
          <span className="prl-note">Change the cards, stacks or bet. The scenario stays as it is.</span>
        </p>
      ) : confirming ? (
        <div className="prl-btn-row">
          <p className="prl-spot-links__line">Remove your edit of this scenario?</p>
          <Button size="sm" ref={keepRef} onClick={() => setConfirming(false)}>
            Keep it
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setConfirming(false);
              const result = commit(resetToOriginal(library.spots, scenarioId));
              setStatus(
                result.ok
                  ? 'Your edit is removed.'
                  : 'Not removed: this browser is not letting the page store anything.',
              );
            }}
          >
            Reset to original
          </Button>
        </div>
      ) : (
        <p className="prl-spot-links__line">
          <a className="prl-btn prl-btn--secondary prl-btn--sm" href={href}>
            Open your edit
          </a>
          <Button size="sm" onClick={() => setConfirming(true)}>
            Reset to original
          </Button>
          <span className="prl-note">You have an edited copy of this scenario, saved in this browser.</span>
        </p>
      )}
      <p className="prl-live-region" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
