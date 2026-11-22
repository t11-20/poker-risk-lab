'use client';

/**
 * The player's saved spots, read from this browser. Each is opened, copied, and deleted, or, for an
 * edit of a built-in, reset to the original, which removes the edit.
 */

import { Button, CardRun } from '@prl/ui';
import { type ReactElement, type RefObject, useEffect, useRef, useState } from 'react';
import { type SavedSpot, streetOf } from '../lib/spot.ts';
import {
  deleteSpot,
  duplicateDraft,
  isEditOfBuiltIn,
  newSpotId,
  noticeSentence,
  refusalSentence,
  resetToOriginal,
  spotHref,
  type WriteResult,
} from '../lib/spot-storage.ts';
import { validateDraft } from '../lib/spot-validate.ts';
import { useSpotLibrary } from '../lib/use-spot-library.ts';

export interface SpotListProps {
  readonly titles: Readonly<Record<string, string>>;
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
  readonly keepRef: RefObject<HTMLButtonElement | null>;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onRemove: (name: string) => void;
  readonly onDuplicate: () => void;
}): ReactElement {
  const { spot, href, original, confirming, keepRef, onAsk, onCancel, onRemove, onDuplicate } = props;
  const name = spot.draft.name.trim() === '' ? 'Untitled spot' : spot.draft.name.trim();
  const own = original === undefined;
  const removal = own ? 'Delete' : 'Reset to original';
  return (
    <li className="prl-spot-list__item">
      <h2 className="prl-spot-list__title">
        <a href={href}>{name}</a>
      </h2>
      <p className="prl-note">{original === undefined ? 'Your own spot' : `Your edit of "${original}"`}</p>
      <SpotCards spot={spot} />
      {confirming ? (
        <div className="prl-btn-row">
          <p className="prl-spot-list__ask">
            {own ? 'Delete this spot? This cannot be undone.' : 'Remove your edit?'}
          </p>
          <Button size="sm" ref={keepRef} onClick={onCancel}>
            Keep it
          </Button>
          <Button size="sm" onClick={() => onRemove(name)}>
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
          <Button size="sm" aria-label={`${removal}: ${name}`} onClick={onAsk}>
            {removal}
          </Button>
        </div>
      )}
    </li>
  );
}

export function SpotList({ titles }: SpotListProps): ReactElement {
  const { library, read, commit } = useSpotLibrary();
  const isBuiltIn = (id: string): boolean => titles[id] !== undefined;
  const [confirming, setConfirming] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const keepRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (confirming !== null) keepRef.current?.focus();
  }, [confirming]);

  const written = (result: WriteResult, success: string): void => {
    setStatus(result.ok ? success : refusalSentence(result.reason));
  };

  if (!library.ready) return <p className="prl-note">Reading the spots saved in this browser.</p>;

  return (
    <div className="prl-spot-list">
      {library.notice === null ? null : <p className="prl-note">{noticeSentence(library.notice)}</p>}
      <p className="prl-live-region" role="status" aria-live="polite">
        {status}
      </p>
      {library.spots.length === 0 ? (
        <div className="prl-empty">
          <p>No spots saved in this browser yet. Start a new one, or copy a scenario below and change it.</p>
        </div>
      ) : (
        <ul className="prl-spot-list__items">
          {library.spots.map((spot) => (
            <SpotItem
              key={spot.id}
              spot={spot}
              href={spotHref(spot, isBuiltIn)}
              original={
                isEditOfBuiltIn(spot, isBuiltIn) && spot.from !== null ? titles[spot.from] : undefined
              }
              confirming={confirming === spot.id}
              keepRef={keepRef}
              onAsk={() => setConfirming(spot.id)}
              onCancel={() => setConfirming(null)}
              onRemove={(name) => {
                setConfirming(null);
                const own = !isEditOfBuiltIn(spot, isBuiltIn);
                const next = own
                  ? deleteSpot(read().spots, spot.id)
                  : resetToOriginal(read().spots, spot.from ?? '');
                written(commit(next), own ? `Deleted "${name}".` : `"${name}" is back to the original.`);
              }}
              onDuplicate={() => {
                const next = duplicateDraft(read().spots, spot.draft, Date.now(), () => newSpotId());
                written(commit(next.spots), `Saved a copy called "${next.saved.draft.name}".`);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
