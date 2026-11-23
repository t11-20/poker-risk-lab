'use client';

/**
 * The player's saved spots, read from this browser. Each is opened, copied, and deleted, or, for an
 * edit of a built-in, reset to the original, which removes the edit.
 */

import { Button, CardRun, useFocusRescue } from '@prl/ui';
import { type ReactElement, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { type SavedSpot, streetOf } from '../lib/spot.ts';
import { askingOn, displayName, type Said, stillTrue } from '../lib/spot-prompt.ts';
import {
  duplicateDraft,
  isEditOfBuiltIn,
  newSpotId,
  noticeSentence,
  refusalSentence,
  repeated,
  savedAt,
  spotHref,
} from '../lib/spot-storage.ts';
import { validateDraft } from '../lib/spot-validate.ts';
import { useSpotLibrary } from '../lib/use-spot-library.ts';
import { moveCaret, useSpotPrompt } from '../lib/use-spot-prompt.ts';

export interface SpotListProps {
  readonly titles: Readonly<Record<string, string>>;
  /** The page's heading, focusable, where the caret goes when the row it was on is gone. */
  readonly headingId: string;
}

const STREET_WORD = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' } as const;

function SpotCards({ spot }: { readonly spot: SavedSpot }): ReactElement {
  const checked = validateDraft(spot.draft);
  if (!checked.ok) return <p className="prl-note">Has fields to fix.</p>;
  const { hero, board } = checked.spot;
  return (
    <p className="prl-spot-list__cards">
      <span className="prl-label">{STREET_WORD[streetOf(board)]}</span> <CardRun cards={[...hero.cards]} />
      {board.length === 0 ? null : (
        <>
          {' on '}
          <CardRun cards={[...board]} />
        </>
      )}
    </p>
  );
}

function SpotItem(props: {
  readonly spot: SavedSpot;
  readonly href: string;
  /** The built-in's title for an edit of one this page still has. */
  readonly original: string | undefined;
  readonly confirming: boolean;
  /** What the last prompt on this entry said, while it is still true of the copy drawn. */
  readonly said: string | null;
  readonly keepRef: RefObject<HTMLButtonElement | null>;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
  readonly onDuplicate: () => void;
}): ReactElement {
  const { spot, href, original, confirming, said, keepRef, onAsk, onCancel, onRemove, onDuplicate } = props;
  const name = displayName(spot);
  const own = original === undefined;
  const removal = own ? 'Delete' : 'Reset to original';
  const time = savedAt(spot.updatedAt);
  return (
    <li className="prl-spot-list__item">
      <h2 className="prl-spot-list__title">
        <a href={href}>{name}</a>
      </h2>
      <p className="prl-note">{original === undefined ? 'Your own spot' : `Your edit of "${original}"`}</p>
      {time === null ? null : (
        <p className="prl-note">
          Saved <time dateTime={time.iso}>{time.text}</time>.
        </p>
      )}
      <SpotCards spot={spot} />
      {said === null ? null : <p className="prl-note">{said}</p>}
      {confirming ? (
        <div className="prl-btn-row">
          <p className="prl-spot-list__ask">
            {own ? 'Delete this spot? This cannot be undone.' : 'Remove your edit?'}
          </p>
          <Button size="sm" ref={keepRef} onClick={onCancel}>
            Keep it
          </Button>
          <Button size="sm" onClick={onRemove}>
            {removal}
          </Button>
        </div>
      ) : (
        <div className="prl-btn-row">
          <a className="prl-btn prl-btn--secondary prl-btn--sm" href={href} aria-label={`Edit ${name}`}>
            Edit
          </a>
          <Button size="sm" aria-label={`Duplicate ${name}`} onClick={onDuplicate}>
            Duplicate
          </Button>
          <Button size="sm" aria-label={`${removal}: ${name}`} data-removal={spot.id} onClick={onAsk}>
            {removal}
          </Button>
        </div>
      )}
    </li>
  );
}

export function SpotList({ titles, headingId }: SpotListProps): ReactElement {
  const store = useSpotLibrary();
  const { library, read, commit } = store;
  const isBuiltIn = (id: string): boolean => titles[id] !== undefined;
  const [status, setStatus] = useState('');
  const [said, setSaid] = useState<Said | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const rescue = useFocusRescue();
  const announce = useCallback((message: string): void => {
    setStatus((current) => repeated(current, message));
  }, []);
  const say = useCallback(
    (next: Said): void => {
      setSaid(next);
      announce(next.sentence);
    },
    [announce],
  );
  const ask = useSpotPrompt({ surface: 'list', store, say });
  const asking = askingOn(ask.prompt)?.copy.id ?? null;
  const shown = said !== null && stillTrue(said, library.spots) ? said : null;

  // Rows are found in the DOM because the one to focus is drawn only after the write re-renders the list.
  useEffect(() => {
    moveCaret(ask.focus, (focus) => {
      if (focus.on === 'keep') return keepRef.current;
      const buttons = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-removal]') ?? [])];
      const action =
        focus.on === 'action' ? buttons.find((b) => b.dataset['removal'] === focus.id) : undefined;
      return action ?? document.getElementById(headingId);
    });
  }, [ask.focus, headingId]);

  // Another tab's write can remove the row the caret is on, and with the last row the whole list.
  useEffect(() => {
    if (library.ready) rescue.rescue(document.getElementById(headingId));
  }, [library, rescue, headingId]);

  if (!library.ready) return <p className="prl-note">Reading the spots saved in this browser.</p>;

  return (
    <div
      className="prl-spot-list"
      ref={rootRef}
      onBlurCapture={rescue.onBlurCapture}
      onFocusCapture={rescue.onFocusCapture}
    >
      {library.notice === null ? null : <p className="prl-note">{noticeSentence(library.notice)}</p>}
      <p className="prl-live-region" role="status" aria-live="polite">
        {status}
      </p>
      {shown === null || shown.stored !== undefined ? null : <p className="prl-note">{shown.sentence}</p>}
      {library.spots.length === 0 ? (
        <div className="prl-empty">
          <p>No spots saved in this browser yet. Start a new one, or copy a scenario below and change it.</p>
        </div>
      ) : (
        <ul className="prl-spot-list__items">
          {library.spots.map((spot) => {
            const own = !isEditOfBuiltIn(spot, isBuiltIn);
            return (
              <SpotItem
                key={spot.id}
                spot={spot}
                href={spotHref(spot, isBuiltIn)}
                original={!own && spot.from !== null ? titles[spot.from] : undefined}
                confirming={asking === spot.id}
                said={shown?.stored?.id === spot.id ? shown.sentence : null}
                keepRef={keepRef}
                onAsk={() => {
                  setSaid(null);
                  ask.open(own ? 'delete' : 'reset', spot);
                }}
                onCancel={ask.cancel}
                onRemove={ask.confirm}
                onDuplicate={() => {
                  setSaid(null);
                  const next = duplicateDraft(read().spots, spot.draft, Date.now(), () => newSpotId());
                  const result = commit(next.spots);
                  announce(
                    result.ok
                      ? `Saved a copy of "${displayName(spot)}" at the end of the list.`
                      : refusalSentence(result.reason),
                  );
                }}
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}
