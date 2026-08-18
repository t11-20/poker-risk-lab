'use client';

/**
 * The theme control: three radios styled as a segmented switch.
 *
 * ## Why a radio group and not a cycling button
 *
 * A single button that cycles auto → light → dark has to answer "what happens if I press this?"
 * in its label, and there is no honest short answer — "Switch theme" says nothing about which of
 * three states arrives next, and "Switch to light" is a label that changes under the reader's
 * cursor. A radio group states all three options, marks the current one, and is operable with the
 * arrow keys for free because that is what a native radio group does.
 *
 * The inputs are real `<input type="radio">` elements made visually hidden rather than
 * `display: none`, so they keep their roles, their group semantics and their keyboard behaviour.
 * The focus ring is drawn on the sibling word (`globals.css`), because a clipped 1px input cannot
 * show one.
 *
 * ## Why the state comes from the DOM, through `useSyncExternalStore`
 *
 * The reader's choice lives in `localStorage`, which the server cannot read, and it is already
 * reflected onto `<html data-theme>` before first paint by the inline script in `theme.ts`. So
 * the attribute — not storage, and not React state — is the single source of truth, and this
 * control subscribes to it with a `MutationObserver`.
 *
 * That is not ceremony. Two instances of this control exist at once: one in the header for wide
 * viewports and one inside the navigation sheet for narrow ones. With local state, changing the
 * theme in one would leave the other showing a stale answer, and the reader would open the menu
 * to find the app disagreeing with itself about what theme it is in. Subscribing to the attribute
 * makes that unrepresentable — both controls read the same one fact.
 *
 * `getServerSnapshot` returns `system`, which is also what the server's HTML renders, so
 * hydration has nothing to correct. React then reads the live value and updates if it differs.
 * What changes one frame after hydration is which of three small words is marked — never the
 * luminance of the page, because the script already settled that during parse.
 */

import { type ReactElement, useId, useSyncExternalStore } from 'react';
import {
  applyTheme,
  readAppliedTheme,
  storeTheme,
  THEME_ATTRIBUTE,
  THEME_CHOICES,
  THEME_DESCRIPTIONS,
  THEME_LABELS,
  type ThemeChoice,
} from '@/lib/theme.ts';

/**
 * One observer for the whole app, created lazily.
 *
 * `subscribe` and `getSnapshot` have to be stable function identities or React re-subscribes on
 * every render, which is why they are module-level over a shared observer rather than closures
 * built inside the component. The same shape `usePrefersReducedMotion` uses in `@prl/ui`.
 */
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  if (observer === null && typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => {
      for (const listener of listeners) listener();
    });
    observer.observe(document.documentElement, { attributeFilter: [THEME_ATTRIBUTE] });
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size > 0 || observer === null) return;
    observer.disconnect();
    observer = null;
  };
}

/** A string primitive, so React's identity check on the snapshot is a value comparison. */
function getSnapshot(): ThemeChoice {
  return readAppliedTheme();
}

function getServerSnapshot(): ThemeChoice {
  return 'system';
}

export interface ThemeToggleProps {
  readonly className?: string;
}

export function ThemeToggle(props: ThemeToggleProps): ReactElement {
  const { className } = props;
  // `useId` rather than a literal name: the two instances of this control would otherwise share a
  // `name` and form ONE radio group, so selecting Light in the header would unselect it in the
  // sheet and the browser would scroll to whichever input it decided was the group's.
  const groupName = useId();
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const select = (next: ThemeChoice): void => {
    // The attribute is written first: it is what the stylesheet reads, what the observer above
    // reports, and therefore what re-renders both controls. Persisting is the slower, failable
    // half (storage throws in private modes) and must not gate the visible change.
    applyTheme(next);
    storeTheme(next);
  };

  return (
    <fieldset className={className === undefined ? 'prl-theme' : `prl-theme ${className}`}>
      {/* A named group needs a name in the accessibility tree; it does not need one on screen,
          where three labelled options beside a units badge are self-evident. */}
      <legend className="prl-visually-hidden">Colour theme</legend>
      {THEME_CHOICES.map((option) => (
        <label className="prl-theme__option" key={option}>
          <input
            checked={choice === option}
            className="prl-theme__input prl-visually-hidden"
            name={groupName}
            onChange={() => select(option)}
            type="radio"
            value={option}
          />
          <span className="prl-theme__word prl-label">{THEME_LABELS[option]}</span>
          {/* The short word is enough on screen and not enough in a screen reader: "Auto" alone
              does not say auto *what*. */}
          <span className="prl-visually-hidden">{THEME_DESCRIPTIONS[option]}</span>
        </label>
      ))}
    </fieldset>
  );
}
