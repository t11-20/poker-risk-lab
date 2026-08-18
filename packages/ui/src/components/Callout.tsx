/**
 * A tonal aside: an insight, a warning, or a common misconception.
 *
 * The three tones are the ones `@prl/contracts` already defines for lesson callout
 * blocks (`LessonBlock` of kind `callout`), so a lesson renderer can pass its tone
 * straight through with no mapping table.
 *
 * ## Tone is a word first, a colour second
 *
 * Each tone renders a literal marker — "Insight", "Watch out", "Common misconception" —
 * as visible text, plus a distinct glyph, plus a border and tint. Strip the colour and
 * the callout still says exactly what kind of thing it is. That ordering is deliberate:
 * the colour is the *last* cue added, not the first.
 *
 * `role="note"` names the container for assistive tech without pretending to be a
 * landmark. An `<aside>` would be a `complementary` landmark, and a page with six
 * lesson callouts would then have six competing landmarks in its rotor — pages own
 * landmarks in this codebase, components do not create them.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type CalloutTone = 'insight' | 'warning' | 'misconception';

export interface CalloutProps {
  readonly tone: CalloutTone;
  /** Optional headline. The tone marker is always shown, with or without this. */
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Marker word and glyph per tone. The word is the accessible cue; the glyph is extra. */
const MARKERS: Readonly<Record<CalloutTone, { readonly word: string; readonly glyph: string }>> = {
  insight: { word: 'Insight', glyph: '◆' },
  warning: { word: 'Watch out', glyph: '▲' },
  misconception: { word: 'Common misconception', glyph: '✕' },
};

const TONE_CLASS: Readonly<Record<CalloutTone, string>> = {
  insight: 'prl-callout--insight',
  warning: 'prl-callout--warning',
  misconception: 'prl-callout--misconception',
};

export function Callout(props: CalloutProps): ReactElement {
  const { tone, title, children, className } = props;
  const marker = MARKERS[tone];

  return (
    <div className={cx('prl-callout', TONE_CLASS[tone], className)} role="note">
      <span className="prl-callout__marker prl-label">
        <span aria-hidden="true">{marker.glyph}</span>
        {marker.word}
      </span>
      {title === undefined ? null : <p className="prl-callout__title">{title}</p>}
      <div className="prl-callout__body">{children}</div>
    </div>
  );
}
