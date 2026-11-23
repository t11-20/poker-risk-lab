/**
 * A Delete or Reset prompt, one rule on the editor, the list and the scenario page: it asks about the copy
 * on screen when it opened, and closes without removing anything once storage holds anything else, so a
 * confirm removes only a copy the reader saw. Pure, so every order of events is a unit test.
 */

import type { SavedSpot } from './spot.ts';
import { sameCopy, storedCopy, type WriteRefusal, type WriteResult } from './spot-storage.ts';

export type Removal = 'delete' | 'reset';
/** Where the prompt is drawn, which decides what its sentences can name. */
export type Surface = 'editor' | 'list' | 'scenario';

export interface Asked {
  readonly surface: Surface;
  readonly write: Removal;
  /** The copy on screen when the prompt opened, the only one a confirm removes. */
  readonly copy: SavedSpot;
}

export type Prompt =
  | { readonly kind: 'closed' }
  | { readonly kind: 'asking'; readonly asked: Asked }
  /** Confirmed on an unchanged copy, with the write still to land within the same press. */
  | { readonly kind: 'removing'; readonly asked: Asked };

export const CLOSED: Prompt = { kind: 'closed' };

type Spots = readonly SavedSpot[];

export type PromptEvent =
  | {
      readonly type: 'open';
      readonly surface: Surface;
      readonly write: Removal;
      readonly copy: SavedSpot;
      readonly spots: Spots;
      readonly yours: boolean;
    }
  /** Storage read again, after another tab's write or this tab's own. */
  | { readonly type: 'stored'; readonly spots: Spots; readonly yours: boolean }
  | { readonly type: 'cancel'; readonly spots: Spots }
  | { readonly type: 'confirm'; readonly spots: Spots; readonly yours: boolean }
  | { readonly type: 'written'; readonly result: WriteResult };

/**
 * `keep` is the prompt's "Keep it"; `action` the Delete or Reset of the copy stored under `id`; `stable`
 * the one control the surface draws in every state. `onlyIfLost` when nobody pressed anything, so a
 * background close moves the caret only off a control that vanished, never out of a field.
 */
export type Focus = { readonly onlyIfLost: boolean } & (
  | { readonly on: 'keep' }
  | { readonly on: 'action'; readonly id: string }
  | { readonly on: 'stable' }
);

/** A sentence, and what was stored where the asked copy is kept when it was said, which it stays true of. */
export interface Said {
  readonly sentence: string;
  readonly where: { readonly id: string | null; readonly from: string | null };
  readonly stored: SavedSpot | undefined;
}

export interface Step {
  readonly prompt: Prompt;
  /** The whole list to store, on a confirm of an unchanged copy only. */
  readonly write: Spots | null;
  readonly said: Said | null;
  readonly focus: Focus | null;
  /** The newer copy the editor must take for "The new copy is shown" to be true. */
  readonly shown: SavedSpot | null;
  /** The prompt whose copy the write removed. */
  readonly removed: Asked | null;
}

export function displayName(spot: SavedSpot): string {
  return spot.draft.name.trim() === '' ? 'Untitled spot' : spot.draft.name.trim();
}

/** The prompt a page draws its question for, or `null` while none is open. */
export function askingOn(prompt: Prompt): Asked | null {
  return prompt.kind === 'asking' ? prompt.asked : null;
}

/** Whether storage still holds what a sentence describes, so a page shows it only while it is true. */
export function stillTrue(said: Said, spots: Spots): boolean {
  const now = storedCopy(spots, said.where);
  if (now === undefined || said.stored === undefined) return now === said.stored;
  return sameCopy(now, said.stored);
}

const NOTHING: Readonly<Record<Removal, string>> = {
  delete: 'nothing was deleted',
  reset: 'nothing was reset',
};

function changedSentence(asked: Asked, now: SavedSpot, yours: boolean): string {
  const nothing = NOTHING[asked.write];
  if (asked.surface === 'editor') {
    const shown = yours ? 'Your changes are still here.' : 'The new copy is shown.';
    return `This spot changed in another tab, so ${nothing}. ${shown}`;
  }
  if (asked.surface === 'scenario') {
    return `Your edit changed in another tab, so ${nothing}. Open it to see the new copy.`;
  }
  const was = displayName(asked.copy);
  const is = displayName(now);
  return `"${was}" changed in another tab, so ${nothing}. The new copy is shown${is === was ? '' : ` as "${is}"`}.`;
}

function goneSentence({ surface, write, copy }: Asked): string {
  if (surface === 'editor') return `This spot was deleted in another tab, so there is nothing to ${write}.`;
  if (surface === 'scenario') return 'Your edit was removed in another tab.';
  return `"${displayName(copy)}" was ${write === 'delete' ? 'deleted' : 'removed'} in another tab.`;
}

function doneSentence(asked: Asked): string {
  const deleting = asked.write === 'delete';
  if (asked.surface === 'editor')
    return deleting ? 'Deleted.' : 'Back to the original. Your edit is removed.';
  if (asked.surface === 'scenario') return 'Your edit is removed.';
  const name = displayName(asked.copy);
  return deleting ? `Deleted "${name}".` : `"${name}" is back to the original.`;
}

const NOT_DONE: Readonly<Record<Removal, string>> = { delete: 'Not deleted', reset: 'Not reset' };

const WHY: Readonly<Record<WriteRefusal, string>> = {
  unavailable: 'this browser is not letting the page store anything.',
  full: "this browser's storage for this site is full.",
  newer: 'your saved spots come from a newer version of this page. Reload first.',
  unreadable: 'the spots left would not read back whole.',
};

const NONE = { write: null, said: null, focus: null, shown: null, removed: null } as const;
const STABLE: Focus = { on: 'stable', onlyIfLost: false };

function stay(prompt: Prompt): Step {
  return { ...NONE, prompt };
}

function said(asked: Asked, sentence: string, stored: SavedSpot | undefined): Said {
  return { sentence, where: { id: asked.copy.id, from: asked.copy.from }, stored };
}

/** What storage holds where the asked copy is kept: the same entry, another one, or nothing. */
function stored(asked: Asked, spots: Spots): SavedSpot | 'same' | undefined {
  const now = storedCopy(spots, asked.copy);
  return now !== undefined && sameCopy(now, asked.copy) ? 'same' : now;
}

function closeOn(asked: Asked, now: SavedSpot | undefined, yours: boolean, onlyIfLost: boolean): Step {
  if (now === undefined) {
    return {
      ...NONE,
      prompt: CLOSED,
      said: said(asked, goneSentence(asked), undefined),
      focus: { on: 'stable', onlyIfLost },
    };
  }
  return {
    ...NONE,
    prompt: CLOSED,
    said: said(asked, changedSentence(asked, now, yours), now),
    focus: { on: 'action', id: now.id, onlyIfLost },
    shown: asked.surface === 'editor' && !yours ? now : null,
  };
}

export function step(prompt: Prompt, event: PromptEvent): Step {
  if (event.type === 'open') {
    if (prompt.kind === 'removing') return stay(prompt);
    const { surface, write, copy, spots, yours } = event;
    const asked: Asked = { surface, write, copy };
    const now = stored(asked, spots);
    if (now !== 'same') return closeOn(asked, now, yours, false);
    return { ...NONE, prompt: { kind: 'asking', asked }, focus: { on: 'keep', onlyIfLost: false } };
  }
  if (event.type === 'written') {
    if (prompt.kind !== 'removing') return stay(prompt);
    const { asked } = prompt;
    if (event.result.ok) {
      const done = said(asked, doneSentence(asked), undefined);
      return { ...NONE, prompt: CLOSED, said: done, focus: STABLE, removed: asked };
    }
    const sentence = `${NOT_DONE[asked.write]}: ${WHY[event.result.reason]}`;
    const focus: Focus = { on: 'action', id: asked.copy.id, onlyIfLost: false };
    return { ...NONE, prompt: CLOSED, said: said(asked, sentence, asked.copy), focus };
  }
  if (prompt.kind !== 'asking') return stay(prompt);
  const { asked } = prompt;
  if (event.type === 'cancel') {
    const now = storedCopy(event.spots, asked.copy);
    const focus: Focus = now === undefined ? STABLE : { on: 'action', id: now.id, onlyIfLost: false };
    return { ...NONE, prompt: CLOSED, focus };
  }
  const now = stored(asked, event.spots);
  if (event.type === 'stored') return now === 'same' ? stay(prompt) : closeOn(asked, now, event.yours, true);
  if (now !== 'same') return closeOn(asked, now, event.yours, false);
  const write = event.spots.filter((spot) => spot.id !== asked.copy.id);
  return { ...NONE, prompt: { kind: 'removing', asked }, write };
}
