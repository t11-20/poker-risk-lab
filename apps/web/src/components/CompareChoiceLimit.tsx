'use client';

/**
 * The compare form's checkboxes, with a sixth tick made impossible once JavaScript is running.
 *
 * ## Why this is an enhancement and not the guard
 *
 * The form is a plain GET form and has to keep working without JavaScript, so nothing here can be
 * the thing that stops six styles reaching the API — `parseCompareSelection` is, on the server,
 * where it also says which styles it left out. This only saves a reader with a script running from
 * making the round trip to be told: once `max` boxes are ticked, every unticked box is disabled,
 * and unticking one enables them again. The form note says "two to five" in either case.
 *
 * `disabled` rather than an alert or an un-tick: a box that refuses a tick, next to a sentence
 * that says why, is the native affordance for "no more of these", and an un-ticked box that the
 * reader just ticked is a control that ignored them.
 *
 * It reads the DOM rather than holding the ticks in React state, because the checkboxes are
 * server-rendered children with `defaultChecked` — uncontrolled, so their checked state lives in
 * the DOM and nowhere else. That includes a state the browser restored on Back, which is why the
 * count also runs once on mount.
 */

import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

export interface CompareChoiceLimitProps {
  readonly max: number;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Disable every unticked checkbox under `root` once `max` are ticked; enable them all below it. */
function applyLimit(root: HTMLElement, max: number): void {
  const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const full = boxes.filter((box) => box.checked).length >= max;
  for (const box of boxes) box.disabled = full && !box.checked;
}

export function CompareChoiceLimit({ max, className, children }: CompareChoiceLimitProps): ReactElement {
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (root.current !== null) applyLimit(root.current, max);
  }, [max]);

  return (
    <div className={className} onChange={(event) => applyLimit(event.currentTarget, max)} ref={root}>
      {children}
    </div>
  );
}
