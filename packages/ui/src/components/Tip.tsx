'use client';

/**
 * A toggletip: a small `?` button beside a control that opens one sentence about it. A native button,
 * so click, tap, Enter and Space are one `click` and nothing here handles keys for it. It closes on a
 * second press, Escape, a press outside, focus leaving or a scroll, and a hovering mouse may peek
 * (`../tip-state.ts`). Focus never moves, so it traps nothing.
 *
 * The sentence is the button's `aria-describedby`, the `UnitsBadge` pattern: a screen reader hears it
 * on arriving at the button, before any press, and a description is read from a hidden node, so it is
 * there in the server render. A live region was rejected: it speaks only after a press, and text that
 * appears with its region is announced unreliably.
 *
 * The bubble is a `popover="manual"` so it paints in the top layer, above the Coach sheet's overflow,
 * and is placed beside its subject (`[data-tip-subject]`, else the parent) so it never covers what it
 * explains. Its position is published as two custom properties, never as layout set from JS.
 */

import {
  type ReactElement,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { cx } from '../cx.ts';
import { countsAsHover, nextTipState, placeTip, type TipEvent, type TipState } from '../tip-state.ts';
import type { TipCopy } from '../tips.ts';

export interface TipProps {
  readonly tip: TipCopy;
  readonly className?: string;
}

function deviceCanHover(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(hover: hover)').matches;
}

/** Safari 17.0 and Chrome 114 have the Popover API. Without it the bubble is a fixed layer instead. */
function canPopover(element: HTMLElement): boolean {
  return typeof element.showPopover === 'function';
}

function place(root: HTMLElement, button: HTMLElement, bubble: HTMLElement): void {
  const subject = root.parentElement?.closest('[data-tip-subject]') ?? root.parentElement ?? root;
  // In rem, so the gutter is `--prl-space-6` and the gap `--prl-space-2` at any text size.
  const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const { x, y, side } = placeTip({
    anchor: button.getBoundingClientRect(),
    subject: subject.getBoundingClientRect(),
    size: { width: bubble.offsetWidth, height: bubble.offsetHeight },
    viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    gutter: rem,
    gap: rem / 4,
  });
  bubble.style.setProperty('--prl-tip-x', `${Math.round(x)}px`);
  bubble.style.setProperty('--prl-tip-y', `${Math.round(y)}px`);
  bubble.dataset['side'] = side;
}

export function Tip(props: TipProps): ReactElement {
  const { tip, className } = props;
  const bubbleId = useId();
  const [state, setState] = useState<TipState>('closed');
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const bubbleRef = useRef<HTMLSpanElement | null>(null);
  const open = state !== 'closed';

  const send = (event: TipEvent): void => setState((current) => nextTipState(current, event));

  // Layout, so the bubble is in the top layer and placed before the frame that first shows it.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const button = buttonRef.current;
    const bubble = bubbleRef.current;
    if (root === null || button === null || bubble === null) return;
    if (!open) {
      if (canPopover(bubble) && bubble.matches(':popover-open')) bubble.hidePopover();
      return;
    }
    if (canPopover(bubble) && !bubble.matches(':popover-open')) bubble.showPopover();
    place(root, button, bubble);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const send = (event: TipEvent): void => setState((current) => nextTipState(current, event));
    // `pointerdown`, so the bubble is gone before the press lands on whatever was under it.
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      send({ type: 'outside' });
    };
    // Capture, and stopped, so one Escape closes the tip and not also the sheet the tip sits in.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      send({ type: 'escape' });
    };
    // A bubble placed in viewport coordinates would drift from its button, so moving the page closes it.
    const onMoved = (): void => send({ type: 'viewport-moved' });
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('scroll', onMoved, { capture: true, passive: true });
    window.addEventListener('resize', onMoved);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('scroll', onMoved, { capture: true });
      window.removeEventListener('resize', onMoved);
    };
  }, [open]);

  const onPointerEnter = (event: ReactPointerEvent<HTMLElement>): void => {
    if (countsAsHover(event.pointerType, deviceCanHover())) send({ type: 'hover-start' });
  };
  // The bubble's hover bridge (`tip.css`) spans the gap, so crossing to the bubble is not leaving.
  const onPointerLeave = (event: ReactPointerEvent<HTMLElement>): void => {
    if (!countsAsHover(event.pointerType, deviceCanHover())) return;
    const next = event.relatedTarget;
    if (next instanceof Node && rootRef.current?.contains(next)) return;
    send({ type: 'hover-end' });
  };
  const onBlur = (event: ReactFocusEvent<HTMLButtonElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && rootRef.current?.contains(next)) return;
    send({ type: 'focus-left' });
  };

  return (
    <span className={cx('prl-tip', className)} ref={rootRef}>
      <button
        aria-controls={bubbleId}
        aria-describedby={bubbleId}
        aria-expanded={open}
        className="prl-tip__button"
        onBlur={onBlur}
        onClick={() => send({ type: 'press' })}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        ref={buttonRef}
        type="button"
      >
        <span aria-hidden="true">?</span>
        <span className="prl-visually-hidden">{`About ${tip.term}`}</span>
      </button>
      <span
        className="prl-tip__bubble"
        data-open={open ? 'true' : 'false'}
        id={bubbleId}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        popover="manual"
        ref={bubbleRef}
      >
        {tip.text}
      </span>
    </span>
  );
}
