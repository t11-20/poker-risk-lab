'use client';

/**
 * On a built-in scenario's page: "Edit a copy", or, once the player has saved an edit of it, a link to
 * that edit and "Reset to original". The scenario itself is never changed; resetting deletes the edit.
 */

import { Button, useFocusRescue } from '@prl/ui';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { askingOn, type Said, stillTrue } from '../lib/spot-prompt.ts';
import { editOf, repeated } from '../lib/spot-storage.ts';
import { useSpotLibrary } from '../lib/use-spot-library.ts';
import { moveCaret, useSpotPrompt } from '../lib/use-spot-prompt.ts';

export function ScenarioSpotLinks({ scenarioId }: { readonly scenarioId: string }): ReactElement {
  const store = useSpotLibrary();
  const { library } = store;
  const [status, setStatus] = useState('');
  const [said, setSaid] = useState<Said | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // One link, drawn in the same place whether or not an edit exists, so the caret survives either.
  const linkRef = useRef<HTMLAnchorElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const rescue = useFocusRescue();
  const say = useCallback((next: Said): void => {
    setSaid(next);
    setStatus((current) => repeated(current, next.sentence));
  }, []);
  const ask = useSpotPrompt({ surface: 'scenario', store, say });
  const href = `/lab/spots/edit?from=${encodeURIComponent(scenarioId)}`;
  const edit = editOf(library.spots, scenarioId);
  const asking = askingOn(ask.prompt) !== null;

  useEffect(() => {
    moveCaret(ask.focus, (focus) => ({ keep: keepRef, action: resetRef, stable: linkRef })[focus.on].current);
  }, [ask.focus]);

  // Another tab can remove the edit while the caret is on its Reset, which unmounts under it.
  useEffect(() => {
    if (library.ready) rescue.rescue(linkRef.current);
  }, [library, rescue]);

  return (
    <div
      className="prl-spot-links"
      onBlurCapture={rescue.onBlurCapture}
      onFocusCapture={rescue.onFocusCapture}
    >
      <p className="prl-spot-links__line">
        <a className="prl-btn prl-btn--secondary prl-btn--sm" href={href} ref={linkRef}>
          {edit === undefined ? 'Edit a copy' : 'Open your edit'}
        </a>
        {edit === undefined ? (
          <span className="prl-note">Change the cards, stacks or bet. The scenario stays as it is.</span>
        ) : asking ? null : (
          <>
            <Button
              size="sm"
              ref={resetRef}
              onClick={() => {
                setSaid(null);
                ask.open('reset', edit);
              }}
            >
              Reset to original
            </Button>
            <span className="prl-note">You have an edited copy of this scenario, saved in this browser.</span>
          </>
        )}
      </p>
      {asking ? (
        <div className="prl-btn-row">
          <p className="prl-spot-links__line">Remove your edit of this scenario?</p>
          <Button size="sm" ref={keepRef} onClick={ask.cancel}>
            Keep it
          </Button>
          <Button size="sm" onClick={ask.confirm}>
            Reset to original
          </Button>
        </div>
      ) : null}
      {said !== null && stillTrue(said, library.spots) ? <p className="prl-note">{said.sentence}</p> : null}
      <p className="prl-live-region" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
