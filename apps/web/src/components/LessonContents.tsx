'use client';

/**
 * The lesson's own headings, as a sticky in-page contents on wide screens.
 *
 * ## No scroll listener, and no magic offset either
 *
 * The active heading is tracked with `IntersectionObserver`, per §5.4. The observer's callback
 * carries `boundingClientRect` with it, so the position check costs nothing extra — the rule
 * that matters is that no layout is forced from a scroll handler, and there is no scroll handler
 * here at all.
 *
 * The one number this needs is how far below the top of the viewport a heading counts as
 * "reached", which is the height of the sticky header. Rather than hard-code it — the design
 * system has no px literals in components, and a second copy of a layout value is a second thing
 * to get wrong — it is **read from the stylesheet**: `base.css` already sets
 * `scroll-padding-block-start` on the root so a focused element is never hidden behind the
 * header (WCAG 2.4.11), and that is exactly the same distance. One `getComputedStyle` on mount.
 *
 * ## Which heading is "active"
 *
 * The last one whose top has passed the header band. Not "the topmost one currently visible",
 * which reads ahead of the reader on a long section, and not "the closest to the middle", which
 * flickers between two headings that happen to straddle it. If nothing has been passed yet the
 * first heading is active, because that is the section being read.
 *
 * ## Accessibility
 *
 * `aria-current="true"` on the active link, which is the whole point of tracking it: a
 * screen-reader user gets the same orientation a sighted reader gets from the accent marker.
 * The nav takes its accessible name from the visible label via `aria-labelledby`, so the two
 * cannot drift apart. No heading is emitted — the document outline belongs to the lesson's own
 * sections, and a contents list that injected an `h2` would appear inside its own list.
 */

import { formatIndex } from '@prl/ui';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import type { OutlineHeading } from '@/lib/learn-curriculum.ts';

export interface LessonContentsProps {
  readonly headings: readonly OutlineHeading[];
}

/**
 * The header band, in CSS pixels, from `scroll-padding-block-start` on the root element.
 *
 * `Number.parseFloat` on a computed value: computed styles resolve `var()` and `clamp()` to an
 * absolute `px` length, so this is the real number the browser is using, not the token's
 * authored form. Anything unparseable falls back to 0, which degrades to "a heading counts as
 * reached when it touches the top of the viewport" — slightly early, never broken.
 */
function headerOffset(): number {
  if (typeof window === 'undefined') return 0;
  const value = window.getComputedStyle(document.documentElement).scrollPaddingBlockStart;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function LessonContents(props: LessonContentsProps): ReactElement | null {
  const { headings } = props;
  const first = headings[0];
  const [activeId, setActiveId] = useState<string | null>(first === undefined ? null : first.id);
  const labelId = useId();
  /** Latest entry per heading id. Read in the callback, so it does not belong in state. */
  const positions = useRef(new Map<string, number>());

  useEffect(() => {
    if (headings.length === 0 || typeof IntersectionObserver === 'undefined') return undefined;
    const offset = headerOffset();
    const ids = headings.map((heading) => heading.id);
    const seen = positions.current;

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        seen.set(entry.target.id, entry.boundingClientRect.top);
      }
      let active: string | null = null;
      for (const id of ids) {
        const top = seen.get(id);
        if (top !== undefined && top <= offset + 1) active = id;
      }
      setActiveId(active ?? ids[0] ?? null);
    });

    for (const id of ids) {
      const element = document.getElementById(id);
      if (element !== null) observer.observe(element);
    }
    // Not unobserved after firing: this observer is *tracking* a position for as long as the
    // lesson is on screen, which is a different job from a one-shot reveal. It is disconnected
    // on unmount, which is the part that matters.
    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav className="prl-learn-contents" aria-labelledby={labelId}>
      <span className="prl-label prl-learn-contents__label" id={labelId}>
        On this page
      </span>
      <ol className="prl-learn-contents__list">
        {headings.map((heading, position) => (
          <li className="prl-learn-contents__item" key={heading.id}>
            <a
              className="prl-learn-contents__link"
              href={`#${heading.id}`}
              {...(activeId === heading.id ? { 'aria-current': 'true' as const } : {})}
            >
              <span className="prl-index prl-learn-contents__index" aria-hidden="true">
                {formatIndex(position + 1)}
              </span>
              <span className="prl-learn-contents__text">{heading.text}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
