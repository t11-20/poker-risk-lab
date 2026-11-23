'use client';

/**
 * One surface's Delete or Reset prompt, wired to storage. `spot-prompt.ts` decides; this reads storage
 * for every event, writes only the list a step hands it, within the same press, and passes on the rest.
 */

import { browserAbandonedFocus } from '@prl/ui';
import { useEffect, useState } from 'react';
import type { SavedSpot } from './spot.ts';
import {
  type Asked,
  CLOSED,
  type Focus,
  type Prompt,
  type Removal,
  type Said,
  type Step,
  type Surface,
  step,
} from './spot-prompt.ts';
import type { useSpotLibrary } from './use-spot-library.ts';

export interface SpotPrompt {
  readonly prompt: Prompt;
  /** The last place a step sent the caret, a new object each time so an effect on it fires again. */
  readonly focus: Focus | null;
  readonly open: (write: Removal, copy: SavedSpot) => void;
  readonly cancel: () => void;
  /** The prompt whose copy was removed, or `null` when nothing was. */
  readonly confirm: () => Asked | null;
}

/** Moves the caret where a step sent it, unless that step waits for a lost caret and this one is not. */
export function moveCaret(
  focus: Focus | null,
  target: (focus: Focus) => HTMLElement | null | undefined,
): void {
  if (focus === null || (focus.onlyIfLost && !browserAbandonedFocus())) return;
  target(focus)?.focus();
}

export function useSpotPrompt(options: {
  readonly surface: Surface;
  readonly store: ReturnType<typeof useSpotLibrary>;
  /** The editor's own unsaved changes, which a newer stored copy does not replace on screen. */
  readonly yours?: boolean;
  readonly say: (said: Said) => void;
  /** Takes the newer copy a step says is now shown; only the editor draws a copy it holds itself. */
  readonly show?: (spot: SavedSpot) => void;
}): SpotPrompt {
  const { surface, store, yours = false, say, show } = options;
  const { library, read, commit } = store;
  const [prompt, setPrompt] = useState<Prompt>(CLOSED);
  const [focus, setFocus] = useState<Focus | null>(null);

  const apply = (next: Step): Step => {
    setPrompt(next.prompt);
    if (next.said !== null) say(next.said);
    if (next.focus !== null) setFocus(next.focus);
    if (next.shown !== null) show?.(next.shown);
    return next;
  };

  // After every render, because every render reads storage again, whether another tab wrote or this one.
  useEffect(() => {
    if (!library.ready) return;
    const next = step(prompt, { type: 'stored', spots: library.spots, yours });
    if (next.prompt !== prompt) apply(next);
  });

  return {
    prompt,
    focus,
    open: (write, copy) => {
      apply(step(prompt, { type: 'open', surface, write, copy, spots: read().spots, yours }));
    },
    cancel: () => {
      apply(step(prompt, { type: 'cancel', spots: read().spots }));
    },
    confirm: () => {
      const asked = apply(step(prompt, { type: 'confirm', spots: read().spots, yours }));
      if (asked.write === null) return null;
      return apply(step(asked.prompt, { type: 'written', result: commit(asked.write) })).removed;
    },
  };
}
