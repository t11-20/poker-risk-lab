'use client';

/**
 * A row of in-page links to the Coach's sections. Not a `<nav>`: `/legends/compare` and a review can
 * hold more than one panel, and two unnamed navigation landmarks fail axe `landmark-unique`.
 * Inside a scrolling rail a click scrolls the rail alone, so the table beside it stays put and no
 * history entry is pushed. Anywhere else it is a plain anchor.
 */

import type { MouseEvent, ReactElement } from 'react';
import { REDUCED_MOTION_QUERY } from '../motion/reduced-motion.ts';

export interface CoachJumpItem {
  readonly id: string;
  readonly label: string;
}

export interface CoachJumpBarProps {
  readonly items: readonly CoachJumpItem[];
}

/** Clear of the target's own top edge, so its heading is not flush against the bar. */
const AIR_PX = 8;

function scrollingAncestor(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

function jump(event: MouseEvent<HTMLAnchorElement>, id: string): void {
  const target = document.getElementById(id);
  if (target === null) return;
  const scroller = scrollingAncestor(target);
  // The page itself is the scroller on every route but the rail, and a plain anchor is right there.
  if (scroller === null || scroller === document.scrollingElement) return;
  event.preventDefault();
  const bar = event.currentTarget.closest('.prl-coach__jump');
  const covered = bar === null ? 0 : bar.getBoundingClientRect().height;
  const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia(REDUCED_MOTION_QUERY).matches;
  scroller.scrollTo({
    top: scroller.scrollTop + offset - covered - AIR_PX,
    behavior: reduce ? 'auto' : 'smooth',
  });
  // A followed anchor moves focus to its target, so Tab carries on from there; this keeps that.
  target.focus({ preventScroll: true });
}

export function CoachJumpBar({ items }: CoachJumpBarProps): ReactElement {
  return (
    <div className="prl-coach__jump">
      <ul className="prl-coach__jump-list" aria-label="Jump to a section">
        {items.map((item) => (
          <li key={item.id}>
            <a
              className="prl-coach__jump-link"
              href={`#${item.id}`}
              onClick={(event) => jump(event, item.id)}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
