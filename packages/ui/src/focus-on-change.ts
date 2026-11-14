'use client';

/**
 * Moving focus when a value changes, and never on the first render. A previous-value comparison rather
 * than a skipped first run, so the trigger is read and StrictMode's second mount run moves nothing.
 */

import { type RefObject, useEffect, useState } from 'react';

/** Answers whether `next` differs from the value it last saw, starting from `initial`. */
export function createChangeWatch<T>(initial: T): (next: T) => boolean {
  let last = initial;
  return (next) => {
    if (Object.is(last, next)) return false;
    last = next;
    return true;
  };
}

/** A change-watch held for the component's lifetime. The first render is never a change. */
export function useChangeWatch<T>(trigger: T): (next: T) => boolean {
  const [changed] = useState(() => createChangeWatch(trigger));
  return changed;
}

/** Focuses `ref` whenever `trigger` changes, and never on the first render, so mounting steals nothing. */
export function useFocusOnChange<T>(ref: RefObject<HTMLElement | null>, trigger: T): void {
  const changed = useChangeWatch(trigger);
  useEffect(() => {
    if (changed(trigger)) ref.current?.focus();
  }, [changed, ref, trigger]);
}
