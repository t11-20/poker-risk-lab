'use client';

/**
 * Putting the caret back when the control it was on disappears. Pressing a conditional control usually
 * unmounts or disables it, and the browser then drops focus to the document (`scripts/keyboard-audit.mjs`).
 * The decisions are React-free so `node --test` can run them without a DOM (ADR 0008).
 */

import { useState } from 'react';

/**
 * Whether the caret has dropped onto the document. Chrome 151 can leave `activeElement` on `<html>`
 * rather than `body` after blurring a newly disabled control (measured on `/play?state=decision`).
 */
export function browserAbandonedFocus(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === document.documentElement;
}

interface FocusLeaving {
  readonly relatedTarget: Node | null;
  readonly currentTarget: { contains(other: Node | null): boolean };
}

export interface FocusRescue {
  readonly onFocusCapture: () => void;
  /** True when the caret went somewhere outside the region, so a caller can drop its own state too. */
  readonly onBlurCapture: (event: FocusLeaving) => boolean;
  /** A press is presence: Chrome can deliver the activating Enter without a focus event React saw. */
  readonly claim: () => void;
  readonly held: () => boolean;
  /** Moves the caret to `target` only if it was in the region and the browser has given up on it. */
  readonly rescue: (target: HTMLElement | null | undefined) => void;
}

export function createFocusRescue(abandoned: () => boolean = browserAbandonedFocus): FocusRescue {
  let held = false;
  const claim = (): void => {
    held = true;
  };
  return {
    onFocusCapture: claim,
    onBlurCapture: (event) => {
      const next = event.relatedTarget;
      // Null means the focused node was removed or disabled, not that the reader went elsewhere.
      const left = next !== null && !event.currentTarget.contains(next);
      if (left) held = false;
      return left;
    },
    claim,
    held: () => held,
    rescue: (target) => {
      if (!held || !abandoned()) return;
      // A plain `.focus()` scrolls its target into view, and at 390x844 that jumped the page 566 to 2,073px.
      target?.focus({ preventScroll: true });
      held = false;
    },
  };
}

/** One rescue per component, kept for its lifetime so the handlers and every effect share `held`. */
export function useFocusRescue(): FocusRescue {
  const [rescue] = useState(() => createFocusRescue());
  return rescue;
}
