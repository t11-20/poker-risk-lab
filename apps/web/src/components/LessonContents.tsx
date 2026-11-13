'use client';

/**
 * The lesson's sticky in-page contents. Tracked with `IntersectionObserver` and no scroll handler
 * (§5.4). The header band is read from the root's `scroll-padding-block-start` (`base.css`, WCAG
 * 2.4.11) rather than hard-coded. The active heading is the last one whose top has passed that band,
 * because "topmost visible" reads ahead and "nearest the middle" flickers. Emits no heading.
 */

import { formatIndex } from '@prl/ui';
import { type ReactElement, useEffect, useId, useRef, useState } from 'react';
import type { OutlineHeading } from '@/lib/learn-curriculum.ts';

export interface LessonContentsProps {
  readonly headings: readonly OutlineHeading[];
}

/** The computed value is in px. Unparseable falls back to 0, which is slightly early, never broken. */
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
