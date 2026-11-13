'use client';

/**
 * A term in running prose that opens its definition. A button, because `title` is unreachable by
 * keyboard and touch. A disclosure, not a dialog: the panel follows the trigger in the DOM, so Tab
 * walks through it with no trap. Escape returns focus to the trigger because the focused node is
 * removed. `aria-controls` is set only while the panel exists. The panel spans its paragraph
 * (`position: relative` in `learn.css`), so it needs no measurement and cannot overflow sideways.
 * Every element is phrasing content, because a `<div>` inside a `<p>` breaks hydration.
 */

import type { GlossaryEntry } from '@prl/contracts';
import { Chip } from '@prl/ui';
import Link from 'next/link';
import {
  type ReactElement,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { topicLabel } from '@/lib/learn-curriculum.ts';

export interface RelatedTerm {
  readonly id: string;
  readonly term: string;
}

export interface GlossaryTermProps {
  readonly entry: GlossaryEntry;
  readonly children?: ReactNode;
  readonly related?: readonly RelatedTerm[];
}

export function GlossaryTerm(props: GlossaryTermProps): ReactElement {
  const { entry, children, related = [] } = props;
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback((returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  /** `pointerdown`, not `click`, which fires after focus moves and briefly leaves two panels open. */
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      const wrapper = wrapperRef.current;
      if (wrapper === null) return;
      const target = event.target;
      if (target instanceof Node && wrapper.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== 'Escape' || !open) return;
    // Escape closes only the innermost open surface.
    event.stopPropagation();
    close(true);
  };

  /** A `null` `relatedTarget` (body or window blur) is left to the pointer handler. */
  const onFocusOut = (event: ReactFocusEvent<HTMLSpanElement>): void => {
    const next = event.relatedTarget;
    if (next === null) return;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setOpen(false);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handlers are keyboard/focus plumbing for the button inside, not an interaction of their own
    <span className="prl-term" ref={wrapperRef} onKeyDown={onKeyDown} onBlur={onFocusOut}>
      <button
        type="button"
        className="prl-term__trigger"
        ref={triggerRef}
        aria-expanded={open}
        {...(open ? { 'aria-controls': panelId } : {})}
        onClick={() => setOpen((current) => !current)}
      >
        {children ?? entry.term}
        <span className="prl-visually-hidden">{open ? ', hide definition' : ', show definition'}</span>
      </button>
      {open ? (
        <span className="prl-term__panel" id={panelId}>
          <span className="prl-term__head">
            <span className="prl-label prl-term__eyebrow">Definition</span>
            <strong className="prl-term__name">{entry.term}</strong>
          </span>
          <span className="prl-term__definition">{entry.definition}</span>
          {entry.formula === undefined ? null : <code className="prl-term__formula">{entry.formula}</code>}
          <span className="prl-term__topics">
            {entry.topics.map((topic) => (
              <Chip key={topic}>{topicLabel(topic)}</Chip>
            ))}
          </span>
          {related.length === 0 ? null : (
            <span className="prl-term__related">
              <span className="prl-label">See also</span>
              {related.map((item) => (
                <Link className="prl-term__related-link" href={`/learn/glossary#${item.id}`} key={item.id}>
                  {item.term}
                </Link>
              ))}
            </span>
          )}
          <span className="prl-term__actions">
            <Link className="prl-btn prl-btn--ghost prl-btn--sm" href={`/learn/glossary#${entry.id}`}>
              Open in the glossary
            </Link>
            <button type="button" className="prl-btn prl-btn--ghost prl-btn--sm" onClick={() => close(true)}>
              Close
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}
