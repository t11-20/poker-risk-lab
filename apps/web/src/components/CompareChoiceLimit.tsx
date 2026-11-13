'use client';

/**
 * Disables the unticked compare checkboxes once `max` are ticked. An enhancement only. The guard is
 * `parseCompareSelection` on the server, because the GET form works without JavaScript. It reads the
 * DOM because the boxes are uncontrolled, and it runs on mount because Back may restore ticks.
 */

import type { ReactElement, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

export interface CompareChoiceLimitProps {
  readonly max: number;
  readonly className?: string;
  readonly children: ReactNode;
}

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
