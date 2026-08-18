'use client';

/**
 * A term in running prose that opens its definition.
 *
 * ## Why this is a button and not a `title`
 *
 * `title` is unreachable from a keyboard, unreadable on a touch screen, invisible to most
 * screen readers in any useful way, and impossible to style or to keep on screen long enough to
 * read two sentences. A definition is content, so it goes in the document.
 *
 * ## The keyboard model, in full
 *
 * The pattern is a **disclosure**, not a dialog: the panel is the next thing in the DOM after
 * the trigger, so `Tab` walks into it and out the other side with no focus management at all.
 * That is the whole reason it is not `role="dialog"` — a trap and a restore are machinery, and
 * machinery is what breaks.
 *
 *  - `Enter` / `Space` on the trigger toggles it. Native `<button>` behaviour, not reimplemented.
 *  - `aria-expanded` on the trigger reports the state; `aria-controls` names the panel while it
 *    is open. Neither is set when the panel is not in the DOM, because a dangling
 *    `aria-controls` is a broken reference in the accessibility tree.
 *  - `Escape` anywhere inside the wrapper closes it **and returns focus to the trigger**, which
 *    is the one piece of focus management a disclosure does owe: after `Escape` from inside the
 *    panel, focus would otherwise be on a node that has just been removed.
 *  - `Tab`bing past the end of the panel closes it, via `focusout` on the wrapper. Leaving an
 *    open panel behind the reader is how a page ends up with six of them open.
 *  - A pointer press outside closes it, without moving focus — focus is already elsewhere and
 *    yanking it back would be the rudest possible response to a click.
 *
 * ## Positioning, and why there is no measurement
 *
 * The panel is `position: absolute` and spans the *paragraph* it sits in rather than being
 * pinned to the word, so it cannot be clipped and can never push the page sideways at the right
 * edge of a line. That needs no `getBoundingClientRect`, no popover polyfill and no anchor
 * positioning: the containing block is the paragraph, which `learn.css` marks `position:
 * relative`.
 *
 * The cost is that the panel is not visually attached to the word, so the trigger takes an
 * accent underline and accent ink while open. That is a stronger connection than a tail on a
 * bubble, and it survives forced-colors mode.
 *
 * ## Every element here is phrasing content, and that is not incidental
 *
 * The trigger sits inside a `<p>`, so the panel does too. A `<div>` inside a paragraph closes
 * the paragraph in the browser's parser, which produces a DOM that does not match the one React
 * rendered — a hydration mismatch that reproduces as content jumping on load. Hence `<span>`
 * throughout, with `<strong>`, `<code>`, `<a>` and `<button>`, all of which are phrasing
 * content and legal where they are.
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

/** One `seeAlso` cross-reference, already resolved to a readable term. */
export interface RelatedTerm {
  readonly id: string;
  readonly term: string;
}

export interface GlossaryTermProps {
  readonly entry: GlossaryEntry;
  /** The term as the sentence spells it. Defaults to the entry's own heading form. */
  readonly children?: ReactNode;
  /**
   * `seeAlso` ids resolved to their terms, so cross-references read as words rather than slugs.
   *
   * Resolved data rather than a resolver function, and that is not a style choice: this is a client
   * component rendered from a server component, and a function cannot cross that boundary — React
   * rejects it outright ("Functions cannot be passed directly to Client Components"). The lesson
   * renderer already holds the entry map, so it does the lookup where the map lives.
   */
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

  /**
   * Outside presses, on `pointerdown` rather than `click`.
   *
   * `click` fires after the press has already moved focus, so a reader who clicks another
   * trigger would briefly have two panels open. `pointerdown` closes this one first.
   *
   * Registered only while open, and removed on close, so a page of forty terms holds at most
   * one document listener.
   */
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
    // Stopping propagation so a term inside a wider dismissible surface does not close both at
    // once: the innermost open thing is what Escape means.
    event.stopPropagation();
    close(true);
  };

  /**
   * Focus leaving the wrapper entirely closes the panel.
   *
   * `relatedTarget` is `null` when focus goes to the document body — a click on empty space, or
   * a browser-chrome focus change. That is treated as "still here" rather than as leaving,
   * because closing on it would fight the pointer handler above and would shut the panel when
   * the window itself lost focus.
   */
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
