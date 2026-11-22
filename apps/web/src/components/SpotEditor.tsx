'use client';

/**
 * The Lab's spot editor: cards from a picker, the stacks and bets as fields, and the analysis worked
 * out again on every valid change. Saves go to this browser only (`spot-storage.ts`), and nothing here
 * calls the API, so an edited spot can never be recorded against a built-in scenario's id.
 */

import { Button, CardPicker, CoachPanel, Panel } from '@prl/ui';
import { nextOpenSlot, pickCard, removeCard } from '@prl/ui/card-picker';
import { formatChips } from '@prl/ui/format';
import { type ReactElement, type ReactNode, type RefObject, useEffect, useId, useRef, useState } from 'react';
import {
  blankDraft,
  cardName,
  type HandKind,
  MAX_OPPONENTS,
  type OpponentDraft,
  type SavedSpot,
  type SpotDraft,
} from '../lib/spot.ts';
import {
  addOpponent,
  allSlots,
  clearBoard,
  pickerGroups,
  priceLine,
  randomHand,
  removeOpponent,
  updateOpponent,
  withSlotCard,
} from '../lib/spot-editing.ts';
import {
  deleteSpot,
  duplicateDraft,
  editOf,
  newSpotId,
  noticeSentence,
  resetToOriginal,
  saveSpot,
  type WriteResult,
} from '../lib/spot-storage.ts';
import { type FieldErrors, type FieldKey, opponentField, validateDraft } from '../lib/spot-validate.ts';
import { useSpotLibrary } from '../lib/use-spot-library.ts';
import { type ReportState, useSpotReport } from '../lib/use-spot-report.ts';

export interface BuiltInOriginal {
  readonly title: string;
  readonly draft: SpotDraft;
}

export type EditorTarget =
  | { readonly mode: 'new' }
  | { readonly mode: 'from'; readonly scenarioId: string }
  | { readonly mode: 'id'; readonly id: string };

export interface SpotEditorProps {
  readonly target: EditorTarget;
  /** Every built-in, so an edit can be reset to its original without asking the server. */
  readonly originals: Readonly<Record<string, BuiltInOriginal>>;
}

interface Editing {
  readonly id: string | null;
  readonly from: string | null;
}

type Confirming = 'delete' | 'reset' | null;

const HAND_KINDS: readonly { readonly kind: HandKind; readonly label: string }[] = [
  { kind: 'range', label: 'Range' },
  { kind: 'cards', label: 'Exact cards' },
  { kind: 'none', label: 'Not modelled' },
];

const STORAGE_REFUSAL: Readonly<Record<Extract<WriteResult, { ok: false }>['reason'], string>> = {
  unavailable: 'Not saved: this browser is not letting the page store anything.',
  newer: 'Not saved: your saved spots come from a newer version of this page. Reload first.',
};

function draftsMatch(a: SpotDraft | null, b: SpotDraft): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b);
}

function setQuery(key: 'id' | 'from', value: string): void {
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set(key, value);
  window.history.replaceState(window.history.state, '', url);
}

/** One labelled text field with its hint and error, wired through `aria-describedby`. */
function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly error: string | undefined;
  readonly hint?: string;
  readonly numeric?: boolean;
  readonly suffix?: string;
}): ReactElement {
  const { label, value, onChange, error, hint, numeric = false, suffix } = props;
  const id = useId();
  const described = [hint === undefined ? null : `${id}-hint`, error === undefined ? null : `${id}-error`]
    .filter((part) => part !== null)
    .join(' ');
  return (
    <div className="prl-field">
      <label className="prl-field__label" htmlFor={id}>
        {label}
      </label>
      <span className="prl-spot-field__control">
        <input
          id={id}
          className={numeric ? 'prl-input prl-number' : 'prl-input'}
          type="text"
          inputMode={numeric ? 'numeric' : 'text'}
          autoComplete="off"
          spellCheck={!numeric}
          value={value}
          aria-invalid={error === undefined ? undefined : true}
          {...(described === '' ? {} : { 'aria-describedby': described })}
          onChange={(event) => onChange(event.target.value)}
        />
        {suffix === undefined ? null : (
          <span className="prl-spot-field__suffix" aria-hidden="true">
            {suffix}
          </span>
        )}
      </span>
      {hint === undefined ? null : (
        <p className="prl-field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="prl-field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

function ErrorLine({
  id,
  message,
}: {
  readonly id: string;
  readonly message: string | undefined;
}): ReactElement | null {
  if (message === undefined) return null;
  return (
    <p className="prl-field__error" id={id}>
      {message}
    </p>
  );
}

function AnalysisBody({ state }: { readonly state: ReportState }): ReactNode {
  if (state.kind === 'idle') {
    return <p className="prl-note">Fix the marked fields and the numbers appear here.</p>;
  }
  if (state.kind === 'refused') return <p className="prl-field__error">{state.message}</p>;
  const report = state.kind === 'ready' ? state.report : state.previous;
  if (report === null) return <p className="prl-note">Working out the numbers.</p>;
  return <CoachPanel report={report} title="The analysis" />;
}

function statusText(state: ReportState): string {
  if (state.kind === 'idle') return 'No numbers yet';
  if (state.kind === 'refused') return 'No numbers for this spot';
  if (state.kind === 'working') return 'Updating';
  return 'Up to date';
}

function savedFor(target: EditorTarget, spots: readonly SavedSpot[]): SavedSpot | undefined {
  if (target.mode === 'id') return spots.find((spot) => spot.id === target.id);
  if (target.mode === 'from') return editOf(spots, target.scenarioId);
  return undefined;
}

function OpponentFields(props: {
  readonly opponent: OpponentDraft;
  readonly index: number;
  readonly removable: boolean;
  readonly errors: FieldErrors;
  readonly onChange: (change: Partial<Omit<OpponentDraft, 'key'>>) => void;
  readonly onRemove: () => void;
}): ReactElement {
  const { opponent, index, removable, errors, onChange, onRemove } = props;
  const legend = opponent.name.trim() === '' ? `Opponent ${index + 1}` : opponent.name.trim();
  const err = (field: Parameters<typeof opponentField>[1]): string | undefined =>
    errors.get(opponentField(opponent.key, field));
  return (
    <fieldset className="prl-spot-editor__opponent">
      <legend className="prl-spot-editor__legend">{legend}</legend>
      <div className="prl-spot-editor__fields">
        <TextField
          label="Name"
          value={opponent.name}
          onChange={(name) => onChange({ name })}
          error={err('name')}
        />
        <TextField
          label="Stack"
          hint="What they had when this street's betting began."
          numeric
          value={opponent.stack}
          onChange={(stack) => onChange({ stack })}
          error={err('stack')}
        />
        <TextField
          label="Bet"
          hint="Their chips in on this street. The largest bet is the one you face."
          numeric
          value={opponent.bet}
          onChange={(bet) => onChange({ bet })}
          error={err('bet')}
        />
      </div>
      <fieldset className="prl-spot-editor__kinds">
        <legend className="prl-field__label">Their hand</legend>
        {HAND_KINDS.map((choice) => (
          <label className="prl-spot-editor__kind" key={choice.kind}>
            <input
              type="radio"
              name={`hand-${opponent.key}`}
              value={choice.kind}
              checked={opponent.handKind === choice.kind}
              onChange={() => onChange({ handKind: choice.kind })}
            />
            {choice.label}
          </label>
        ))}
      </fieldset>
      <HandField opponent={opponent} legend={legend} error={err('range')} onChange={onChange} />
      {removable ? (
        <Button size="sm" variant="ghost" onClick={onRemove} aria-label={`Remove ${legend}`}>
          Remove
        </Button>
      ) : null}
    </fieldset>
  );
}

function HandField(props: {
  readonly opponent: OpponentDraft;
  readonly legend: string;
  readonly error: string | undefined;
  readonly onChange: (change: Partial<Omit<OpponentDraft, 'key'>>) => void;
}): ReactElement {
  const { opponent, legend, error, onChange } = props;
  if (opponent.handKind === 'range') {
    return (
      <TextField
        label="Range"
        hint="Hands like QQ+, AKs, KQo, 22-66 or A2s+, with commas between, or top:20 for the strongest 20%."
        value={opponent.range}
        onChange={(range) => onChange({ range })}
        error={error}
      />
    );
  }
  if (opponent.handKind === 'cards') {
    return <p className="prl-note">Pick their two cards in the Cards panel, under {legend}&rsquo;s hand.</p>;
  }
  return (
    <p className="prl-note">
      Still in the hand, but the analysis does not model their cards: it compares your hand with the opponents
      that have a range or cards.
    </p>
  );
}

function EditorBar(props: {
  readonly confirming: Confirming;
  readonly ready: boolean;
  readonly ownEdit: boolean;
  readonly saved: boolean;
  readonly dirty: boolean;
  readonly keepRef: RefObject<HTMLButtonElement | null>;
  readonly onSave: () => void;
  readonly onDuplicate: () => void;
  readonly onConfirm: (what: Confirming) => void;
  readonly onConfirmed: () => void;
}): ReactElement {
  const { confirming, ready, ownEdit, saved, dirty, keepRef, onSave, onDuplicate, onConfirm, onConfirmed } =
    props;
  if (confirming !== null) {
    const deleting = confirming === 'delete';
    return (
      <div className="prl-spot-editor__bar">
        <p>
          {deleting
            ? 'Delete this spot from this browser? This cannot be undone.'
            : 'Remove your edit and go back to the original?'}
        </p>
        <Button ref={keepRef} onClick={() => onConfirm(null)}>
          Keep it
        </Button>
        <Button onClick={onConfirmed}>{deleting ? 'Delete' : 'Reset to original'}</Button>
      </div>
    );
  }
  return (
    <div className="prl-spot-editor__bar">
      <Button variant="primary" onClick={onSave} aria-disabled={!ready}>
        Save
      </Button>
      <Button onClick={onDuplicate}>Duplicate</Button>
      {ownEdit ? <Button onClick={() => onConfirm('reset')}>Reset to original</Button> : null}
      {!ownEdit && saved ? <Button onClick={() => onConfirm('delete')}>Delete</Button> : null}
      <p className="prl-spot-editor__state">{dirty ? 'Not saved yet' : 'Saved'}</p>
    </div>
  );
}

function ResultSection({ state }: { readonly state: ReportState }): ReactElement {
  const titleId = useId();
  return (
    <section
      className="prl-spot-editor__result"
      aria-labelledby={titleId}
      aria-busy={state.kind === 'working'}
      data-tour="result"
      data-ms={state.kind === 'ready' ? Math.round(state.ms) : undefined}
    >
      <h2 className="prl-spot-editor__result-title" id={titleId}>
        Numbers
      </h2>
      <p className="prl-spot-editor__status" data-tour="run" data-state={state.kind}>
        {statusText(state)}
        <span className="prl-spot-editor__status-note">
          {' '}
          &middot; Every change works the numbers out again, here in your browser.
        </span>
      </p>
      <AnalysisBody state={state} />
    </section>
  );
}

export function SpotEditor({ target, originals }: SpotEditorProps): ReactElement {
  const { library, commit } = useSpotLibrary();
  const fromId = target.mode === 'from' ? target.scenarioId : null;
  const original = fromId === null ? undefined : originals[fromId];
  const [editing, setEditing] = useState<Editing>({ id: null, from: fromId });
  const [draft, setDraft] = useState<SpotDraft>(original?.draft ?? blankDraft());
  const [saved, setSaved] = useState<SpotDraft | null>(null);
  const [missing, setMissing] = useState(false);
  const [loaded, setLoaded] = useState(target.mode !== 'id');
  const [active, setActive] = useState<string | null>(() => nextOpenSlot(allSlots(draft), null));
  const [pickerStatus, setPickerStatus] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [confirming, setConfirming] = useState<Confirming>(null);
  const resolved = useRef(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const cardsErrorId = useId();
  const opponentsErrorId = useId();

  // The saved copy, once storage has been read. Runs once, so a later save does not reload the draft.
  useEffect(() => {
    if (!library.ready || resolved.current) return;
    resolved.current = true;
    const found = savedFor(target, library.spots);
    if (target.mode === 'id' && found === undefined) {
      setMissing(true);
      return;
    }
    if (found !== undefined) {
      setEditing({ id: found.id, from: found.from });
      setDraft(found.draft);
      setSaved(found.draft);
      setActive(nextOpenSlot(allSlots(found.draft), null));
    }
    setLoaded(true);
  }, [library, target]);

  useEffect(() => {
    if (confirming !== null) keepRef.current?.focus();
  }, [confirming]);

  const validation = validateDraft(draft);
  const errors: FieldErrors = validation.ok ? new Map() : validation.errors;
  const report = useSpotReport(loaded && validation.ok ? validation.spot : null);
  const err = (key: FieldKey): string | undefined => errors.get(key);
  const linked = editing.from === null ? undefined : originals[editing.from];
  const dirty = !draftsMatch(saved, draft);
  const price = priceLine(draft);
  const cardErrors = [
    err('hole'),
    err('board'),
    ...draft.opponents.map((o) => err(opponentField(o.key, 'cards'))),
  ];
  const cardsError = cardErrors.filter((message) => message !== undefined).join(' ') || undefined;

  const change = (next: SpotDraft): void => {
    setDraft(next);
    setSaveStatus('');
  };

  const written = (result: WriteResult, success: string): boolean => {
    setSaveStatus(result.ok ? success : STORAGE_REFUSAL[result.reason]);
    return result.ok;
  };

  // Until storage is read, `library.spots` is empty, and writing it would erase every saved spot.
  const save = (): void => {
    if (!library.ready) return;
    if (!validation.ok) {
      setSaveStatus(
        `Not saved. Fix the ${errors.size === 1 ? 'marked field' : `${errors.size} marked fields`} first.`,
      );
      document.querySelector<HTMLElement>('.prl-spot-editor [aria-invalid="true"]')?.focus();
      return;
    }
    const next = saveSpot(library.spots, { ...editing, draft }, Date.now(), () => newSpotId());
    if (!written(commit(next.spots), 'Saved in this browser.')) return;
    setEditing({ id: next.saved.id, from: next.saved.from });
    setSaved(draft);
    if (next.saved.from === null) setQuery('id', next.saved.id);
  };

  const duplicate = (): void => {
    if (!library.ready) return;
    if (!validation.ok) {
      setSaveStatus('Fix the marked fields before making a copy.');
      return;
    }
    const next = duplicateDraft(library.spots, draft, Date.now(), () => newSpotId());
    if (
      !written(
        commit(next.spots),
        `Saved a copy called "${next.saved.draft.name}". You are now editing the copy.`,
      )
    ) {
      return;
    }
    setEditing({ id: next.saved.id, from: null });
    setDraft(next.saved.draft);
    setSaved(next.saved.draft);
    setQuery('id', next.saved.id);
  };

  const confirmDelete = (): void => {
    if (editing.id === null || !library.ready) return;
    if (written(commit(deleteSpot(library.spots, editing.id)), 'Deleted.'))
      window.location.assign('/lab/spots');
  };

  const confirmReset = (): void => {
    const from = editing.from;
    const back = from === null ? undefined : originals[from];
    if (from === null || back === undefined || !library.ready) return;
    if (!written(commit(resetToOriginal(library.spots, from)), 'Back to the original. Your edit is removed.'))
      return;
    setConfirming(null);
    setEditing({ id: null, from });
    setDraft(back.draft);
    setSaved(null);
    setActive(nextOpenSlot(allSlots(back.draft), null));
  };

  const onPick = (card: number): void => {
    const result = pickCard(allSlots(draft), active, card);
    if (result.placed === null) {
      setPickerStatus(
        active === null ? 'Every slot is full. Choose a slot to change it.' : 'That card is in use.',
      );
      return;
    }
    change(withSlotCard(draft, result.placed.id, card));
    setActive(result.active);
    setPickerStatus(`${cardName(card)} in ${result.placed.label}.`);
  };

  const onRemove = (id: string): void => {
    const slot = allSlots(draft).find((candidate) => candidate.id === id);
    const result = removeCard(allSlots(draft), id);
    change(withSlotCard(draft, id, null));
    setActive(result.active);
    if (slot?.card != null) setPickerStatus(`${cardName(slot.card)} removed from ${slot.label}.`);
  };

  if (missing) {
    return (
      <div className="prl-spot-editor prl-empty">
        <p>This spot is not saved in this browser. It may have been deleted, or saved in another browser.</p>
        <a className="prl-btn prl-btn--secondary" href="/lab/spots">
          Your spots
        </a>
      </div>
    );
  }

  const ownEdit = editing.id !== null && editing.from !== null;
  return (
    <div className="prl-spot-editor">
      {library.notice === null ? null : (
        <p className="prl-note prl-spot-editor__notice">{noticeSentence(library.notice)}</p>
      )}
      {linked === undefined ? null : (
        <p className="prl-note">
          {ownEdit
            ? `Your edit of "${linked.title}". The original scenario is unchanged.`
            : `A copy of "${linked.title}". Saving keeps your copy in this browser; the original stays as it is.`}
        </p>
      )}

      <EditorBar
        confirming={confirming}
        ready={library.ready}
        ownEdit={ownEdit}
        saved={editing.id !== null}
        dirty={dirty}
        keepRef={keepRef}
        onSave={save}
        onDuplicate={duplicate}
        onConfirm={setConfirming}
        onConfirmed={confirming === 'delete' ? confirmDelete : confirmReset}
      />
      <p className="prl-live-region" role="status" aria-live="polite">
        {saveStatus}
      </p>
      {saveStatus === '' ? null : <p className="prl-note">{saveStatus}</p>}

      <div className="prl-spot-editor__layout">
        <div className="prl-spot-editor__inputs">
          <Panel title="Cards" headingLevel={2} className="prl-spot-editor__cards">
            <div data-tour="hand-board">
              <CardPicker
                groups={pickerGroups(draft)}
                active={active}
                onSelectSlot={setActive}
                onPick={onPick}
                onRemove={onRemove}
                status={pickerStatus}
                {...(cardsError === undefined ? {} : { errorId: cardsErrorId })}
              />
              <ErrorLine id={cardsErrorId} message={cardsError} />
              <div className="prl-btn-row prl-spot-editor__card-tools">
                <Button
                  size="sm"
                  onClick={() => {
                    change(clearBoard(draft));
                    setActive('flop1');
                    setPickerStatus('Board cleared.');
                  }}
                >
                  Clear board
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    const next = randomHand(draft);
                    change(next);
                    setActive(nextOpenSlot(allSlots(next), 'hole2'));
                    const { hole1, hole2 } = next.cards;
                    if (hole1 !== null && hole2 !== null) {
                      setPickerStatus(`Dealt ${cardName(hole1)} and ${cardName(hole2)}.`);
                    }
                  }}
                >
                  Random hand
                </Button>
              </div>
            </div>
          </Panel>

          <Panel title="Pot and you" headingLevel={2}>
            <div className="prl-spot-editor__fields">
              <TextField
                label="Name"
                value={draft.name}
                onChange={(name) => change({ ...draft, name })}
                error={err('name')}
              />
              <TextField
                label="Pot before bets"
                hint="Chips in the middle before this street's betting, including any a folded player put in."
                numeric
                value={draft.potBefore}
                onChange={(potBefore) => change({ ...draft, potBefore })}
                error={err('potBefore')}
              />
              <TextField
                label="Big blind"
                numeric
                value={draft.bigBlind}
                onChange={(bigBlind) => change({ ...draft, bigBlind })}
                error={err('bigBlind')}
              />
              <TextField
                label="Your stack"
                hint="What you had when this street's betting began."
                numeric
                value={draft.heroStack}
                onChange={(heroStack) => change({ ...draft, heroStack })}
                error={err('heroStack')}
              />
              <TextField
                label="You put in"
                hint="Chips you have already put in on this street, such as a blind."
                numeric
                value={draft.heroBet}
                onChange={(heroBet) => change({ ...draft, heroBet })}
                error={err('heroBet')}
              />
            </div>
            <p className="prl-spot-editor__price" aria-live="off">
              {price === null
                ? 'The pot and the price show once the amounts are whole numbers.'
                : `Pot now ${formatChips(price.pot)}. To call ${formatChips(price.toCall)}.`}
            </p>
          </Panel>

          <Panel title="Opponents" headingLevel={2}>
            <ol className="prl-spot-editor__opponents">
              {draft.opponents.map((opponent, index) => (
                <li key={opponent.key}>
                  <OpponentFields
                    opponent={opponent}
                    index={index}
                    removable={draft.opponents.length > 1}
                    errors={errors}
                    onChange={(edit) => change(updateOpponent(draft, opponent.key, edit))}
                    onRemove={() => change(removeOpponent(draft, opponent.key))}
                  />
                </li>
              ))}
            </ol>
            <ErrorLine id={opponentsErrorId} message={err('opponents')} />
            {draft.opponents.length < MAX_OPPONENTS ? (
              <Button size="sm" onClick={() => change(addOpponent(draft))}>
                Add opponent
              </Button>
            ) : (
              <p className="prl-note">{`${MAX_OPPONENTS} opponents is the most the analysis handles.`}</p>
            )}
          </Panel>

          <Panel title="Assumptions" headingLevel={2}>
            <label className="prl-spot-editor__check">
              <input
                type="checkbox"
                checked={draft.neverFolds}
                onChange={(event) => change({ ...draft, neverFolds: event.target.checked })}
              />
              The opponent never folds to a bet or raise
            </label>
            <TextField
              label="Fold rate"
              hint="How often a bet or raise wins at once. Leave blank to let the analysis read it from the range."
              numeric
              suffix="%"
              value={draft.foldRate}
              onChange={(foldRate) => change({ ...draft, foldRate })}
              error={err('foldRate')}
            />
          </Panel>
        </div>

        <ResultSection state={report} />
      </div>
    </div>
  );
}
