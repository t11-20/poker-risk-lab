'use client';

/**
 * The theme control, three visually hidden native radios, so every option is stated and arrow keys
 * work. The focus ring is drawn on the sibling word (`globals.css`). The source of truth is
 * `<html data-theme>`, set before first paint by `theme.ts` and observed here, because two copies
 * (footer and `MobileNav` sheet) must never disagree. The server snapshot is `system`, so hydration
 * only changes which word is marked, never the page luminance.
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

/** Module-level so `subscribe` and `getSnapshot` keep stable identities and React does not re-subscribe. */
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
  // A shared literal name would merge both copies into one radio group.
  const groupName = useId();
  const choice = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const select = (next: ThemeChoice): void => {
    // The attribute first. Storage can throw in private modes and must not gate the visible change.
    applyTheme(next);
    storeTheme(next);
  };

  return (
    <fieldset className={className === undefined ? 'prl-theme' : `prl-theme ${className}`}>
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
          <span className="prl-visually-hidden">{THEME_DESCRIPTIONS[option]}</span>
        </label>
      ))}
    </fieldset>
  );
}
