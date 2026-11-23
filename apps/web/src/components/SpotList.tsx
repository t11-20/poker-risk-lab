'use client';

/**
 * The player's saved spots, read from this browser. Each is opened, copied, and deleted, or, for an
 * edit of a built-in, reset to the original, which removes the edit.
 */

import { Button, browserAbandonedFocus, CardRun } from '@prl/ui';
import { type ReactElement, type RefObject, useEffect, useRef, useState } from 'react';
import { type SavedSpot, streetOf } from '../lib/spot.ts';
import {
  askedCopy,
  changedSincePrompt,
  conflictSentence,
  duplicateDraft,
  isEditOfBuiltIn,
  newSpotId,
  noticeSentence,
  type RemoveRequest,
  refusalSentence,
  removeSpot,
  repeated,
  savedAt,
  spotHref,
  type WriteResult,
} from '../lib/spot-storage.ts';
import { validateDraft } from '../lib/spot-validate.ts';
import { useSpotLibrary } from '../lib/use-spot-library.ts';

export interface SpotListProps {
  readonly titles: Readonly<Record<string, string>>;
}

const STREET_WORD = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River' } as const;

/** An open Delete or Reset prompt: the entry as it was drawn when the reader asked. */
interface Asked {
  readonly request: RemoveRequest;
  readonly own: boolean;
  readonly name: string;
  /** Its place in the list, so the caret has somewhere to go if it disappears. */
  readonly row: number;
}

/** Where the caret goes after a press removes the control it was on: a row's title or its removal button. */
interface FocusTo {
  readonly row: number;
  readonly part: 'title' | 'removal';
}

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

function displayName(spot: SavedSpot): string {
  return spot.draft.name.trim() === '' ? 'Untitled spot' : spot.draft.name.trim();
}

function SpotItem(props: {
  readonly spot: SavedSpot;
  readonly href: string;
  /** The built-in's title for an edit of one this page still has. */
  readonly original: string | undefined;
  readonly confirming: boolean;
  /** Why the open prompt will not remove this entry as it is now, or `null` while it still would. */
  readonly changed: string | null;
  /** Why the last Delete or Reset of this entry did nothing, shown beside the copy now drawn. */
  readonly refused: string | null;
  readonly keepRef: RefObject<HTMLButtonElement | null>;
  readonly onAsk: () => void;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
  readonly onDuplicate: () => void;
}): ReactElement {
  const { spot, href, original, confirming, changed, refused, keepRef } = props;
  const { onAsk, onCancel, onRemove, onDuplicate } = props;
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
      {refused === null ? null : <p className="prl-note">{refused}</p>}
      {confirming ? (
        <div className="prl-btn-row">
          <p className="prl-spot-list__ask">
            {own ? 'Delete this spot? This cannot be undone.' : 'Remove your edit?'}
          </p>
          {changed === null ? null : <p className="prl-note prl-spot-prompt__changed">{changed}</p>}
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
          <Button size="sm" aria-label={`${removal}: ${name}`} data-removal="" onClick={onAsk}>
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
  const [asked, setAsked] = useState<Asked | null>(null);
  const [status, setStatus] = useState('');
  const [refused, setRefused] = useState<{ readonly id: string; readonly sentence: string } | null>(null);
  const [focusTo, setFocusTo] = useState<FocusTo | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLParagraphElement>(null);

  // The prompt follows the entry it asked about, onto a new id when another tab reset and edited it.
  const now = asked === null || !library.ready ? null : askedCopy(library.spots, asked.request);
  const promptId = now === null || now.kind === 'gone' ? null : now.spot.id;
  const changedSpot = now?.kind === 'changed' ? now.spot : null;
  const changedLine =
    changedSpot === null || asked === null ? null : changedSincePrompt(asked.own ? 'delete' : 'reset');
  const gone = now?.kind === 'gone';

  useEffect(() => {
    if (promptId !== null) keepRef.current?.focus();
  }, [promptId]);

  useEffect(() => {
    if (changedSpot === null || changedLine === null) return;
    setStatus((current) => repeated(current, changedLine));
  }, [changedSpot, changedLine]);

  useEffect(() => {
    if (!gone || asked === null) return;
    setAsked(null);
    setStatus((current) => repeated(current, `"${asked.name}" was removed in another tab.`));
    if (browserAbandonedFocus()) setFocusTo({ row: asked.row, part: 'title' });
  }, [gone, asked]);

  // Rows are found in the DOM because the one to focus is drawn only after the write re-renders the list.
  useEffect(() => {
    if (focusTo === null) return;
    const rows = rootRef.current?.querySelectorAll<HTMLElement>('.prl-spot-list__item') ?? [];
    const row = rows[focusTo.row] ?? rows[focusTo.row - 1];
    const selector = focusTo.part === 'title' ? '.prl-spot-list__title a' : '[data-removal]';
    (row?.querySelector<HTMLElement>(selector) ?? emptyRef.current)?.focus();
  }, [focusTo]);

  const say = (message: string): void => setStatus((current) => repeated(current, message));

  const written = (result: WriteResult, success: string): boolean => {
    say(result.ok ? success : refusalSentence(result.reason));
    return result.ok;
  };

  const confirm = (): void => {
    if (asked === null) return;
    const { request, own, name } = asked;
    setAsked(null);
    const before = read().spots;
    const next = removeSpot(before, request);
    if ('conflict' in next) {
      const sentence = conflictSentence(own ? 'delete' : 'reset', 'shown');
      const conflict = next.conflict;
      setRefused({ id: conflict.id, sentence });
      say(sentence);
      setFocusTo({ row: before.findIndex((spot) => spot.id === conflict.id), part: 'removal' });
      return;
    }
    setRefused(null);
    const row = before.findIndex((spot) => !next.spots.includes(spot));
    if (written(commit(next.spots), own ? `Deleted "${name}".` : `"${name}" is back to the original.`)) {
      setFocusTo({ row: Math.max(row, 0), part: 'title' });
    }
  };

  if (!library.ready) return <p className="prl-note">Reading the spots saved in this browser.</p>;

  return (
    <div className="prl-spot-list" ref={rootRef}>
      {library.notice === null ? null : <p className="prl-note">{noticeSentence(library.notice)}</p>}
      <p className="prl-live-region" role="status" aria-live="polite">
        {status}
      </p>
      {library.spots.length === 0 ? (
        <div className="prl-empty">
          <p ref={emptyRef} tabIndex={-1}>
            No spots saved in this browser yet. Start a new one, or copy a scenario below and change it.
          </p>
        </div>
      ) : (
        <ul className="prl-spot-list__items">
          {library.spots.map((spot, row) => {
            const own = !isEditOfBuiltIn(spot, isBuiltIn);
            return (
              <SpotItem
                key={spot.id}
                spot={spot}
                href={spotHref(spot, isBuiltIn)}
                original={!own && spot.from !== null ? titles[spot.from] : undefined}
                confirming={promptId === spot.id}
                changed={promptId === spot.id ? changedLine : null}
                refused={refused?.id === spot.id ? refused.sentence : null}
                keepRef={keepRef}
                onAsk={() =>
                  setAsked({
                    request: { id: spot.id, from: spot.from, held: { kind: 'copy', spot } },
                    own,
                    name: displayName(spot),
                    row,
                  })
                }
                onCancel={() => {
                  setAsked(null);
                  setFocusTo({ row, part: 'removal' });
                }}
                onRemove={confirm}
                onDuplicate={() => {
                  setRefused(null);
                  const next = duplicateDraft(read().spots, spot.draft, Date.now(), () => newSpotId());
                  written(
                    commit(next.spots),
                    `Saved a copy of "${displayName(spot)}" at the end of the list.`,
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
