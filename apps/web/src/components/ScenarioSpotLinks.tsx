'use client';

/**
 * On a built-in scenario's page: "Edit a copy", or, once the player has saved an edit of it, a link to
 * that edit and "Reset to original". The scenario itself is never changed; resetting deletes the edit.
 */

import { Button, browserAbandonedFocus } from '@prl/ui';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import type { SavedSpot } from '../lib/spot.ts';
import {
  askedCopy,
  changedSincePrompt,
  conflictSentence,
  editOf,
  removeSpot,
  repeated,
} from '../lib/spot-storage.ts';
import { useSpotLibrary } from '../lib/use-spot-library.ts';

export function ScenarioSpotLinks({ scenarioId }: { readonly scenarioId: string }): ReactElement {
  const { library, read, commit } = useSpotLibrary();
  const [refused, setRefused] = useState(false);
  // The edit as drawn when Reset was pressed, so a save in another tab since is refused, not removed.
  const [asked, setAsked] = useState<SavedSpot | null>(null);
  const [status, setStatus] = useState('');
  // Set by a press whose control unmounts, so the caret lands on a named control rather than <body>.
  const [focusTo, setFocusTo] = useState<{ readonly on: 'edit' | 'reset' } | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const editRef = useRef<HTMLAnchorElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const href = `/lab/spots/edit?from=${encodeURIComponent(scenarioId)}`;
  const edit = editOf(library.spots, scenarioId);
  const request =
    asked === null ? null : { id: asked.id, from: scenarioId, held: { kind: 'copy', spot: asked } as const };
  const now = request === null || !library.ready ? null : askedCopy(library.spots, request);
  const changedSpot = now?.kind === 'changed' ? now.spot : null;
  const changedLine = changedSpot === null ? null : changedSincePrompt('reset');
  const gone = now?.kind === 'gone';

  useEffect(() => {
    if (asked !== null) keepRef.current?.focus();
  }, [asked]);

  useEffect(() => {
    if (focusTo !== null) (focusTo.on === 'edit' ? editRef : resetRef).current?.focus();
  }, [focusTo]);

  useEffect(() => {
    if (changedSpot === null || changedLine === null) return;
    setStatus((current) => repeated(current, changedLine));
  }, [changedSpot, changedLine]);

  useEffect(() => {
    if (!gone) return;
    setAsked(null);
    setStatus((current) => repeated(current, 'Your edit was removed in another tab.'));
    if (browserAbandonedFocus()) setFocusTo({ on: 'edit' });
  }, [gone]);

  const say = (message: string): void => setStatus((current) => repeated(current, message));

  const confirm = (): void => {
    if (request === null) return;
    setAsked(null);
    const next = removeSpot(read().spots, request);
    setRefused('conflict' in next);
    if ('conflict' in next) {
      say(conflictSentence('reset', 'open'));
      setFocusTo({ on: 'reset' });
      return;
    }
    const result = commit(next.spots);
    say(
      result.ok
        ? 'Your edit is removed.'
        : 'Not removed: this browser is not letting the page store anything.',
    );
    setFocusTo({ on: result.ok ? 'edit' : 'reset' });
  };

  return (
    <div className="prl-spot-links">
      {edit === undefined ? (
        <p className="prl-spot-links__line">
          <a className="prl-btn prl-btn--secondary prl-btn--sm" href={href} ref={editRef}>
            Edit a copy
          </a>
          <span className="prl-note">Change the cards, stacks or bet. The scenario stays as it is.</span>
        </p>
      ) : asked !== null ? (
        <div className="prl-btn-row">
          <p className="prl-spot-links__line">Remove your edit of this scenario?</p>
          {changedLine === null ? null : <p className="prl-note prl-spot-prompt__changed">{changedLine}</p>}
          <Button
            size="sm"
            ref={keepRef}
            onClick={() => {
              setAsked(null);
              setFocusTo({ on: 'reset' });
            }}
          >
            Keep it
          </Button>
          <Button size="sm" onClick={confirm}>
            Reset to original
          </Button>
        </div>
      ) : (
        <p className="prl-spot-links__line">
          <a className="prl-btn prl-btn--secondary prl-btn--sm" href={href}>
            Open your edit
          </a>
          <Button size="sm" ref={resetRef} onClick={() => setAsked(edit)}>
            Reset to original
          </Button>
          <span className="prl-note">You have an edited copy of this scenario, saved in this browser.</span>
        </p>
      )}
      {refused && edit !== undefined ? <p className="prl-note">{conflictSentence('reset', 'open')}</p> : null}
      <p className="prl-live-region" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
