'use client';

/**
 * "How to use": opens the guided tour from anywhere, or takes focus to it when it is already open.
 * Not a toggle, because the panel may be scrolled out of sight and a press that closed it would hide
 * the thing the reader went looking for. `data-tour-opener` is where focus returns when it closes.
 */

import { cx } from '@prl/ui';
import type { ReactElement } from 'react';
import { tourStore } from '@/lib/tour.ts';

export interface TourButtonProps {
  readonly className?: string;
  /** Run first, so the phone menu can close and release its focus trap before the panel takes focus. */
  readonly beforeOpen?: () => void;
}

export function TourButton({ className, beforeOpen }: TourButtonProps): ReactElement {
  return (
    <button
      className={cx('prl-tour-button', className)}
      data-tour-opener=""
      onClick={() => {
        beforeOpen?.();
        tourStore.dispatch({ type: 'open-from-button' });
      }}
      type="button"
    >
      <span aria-hidden="true" className="prl-tour-button__mark">
        ?
      </span>
      <span className="prl-tour-button__word">How to use</span>
    </button>
  );
}
