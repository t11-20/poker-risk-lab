/**
 * A tonal aside. The lesson tones in `@prl/contracts` are a subset of these: a lesson passes its
 * tone straight through, and `note` is for a receipt or an honesty line that is not an insight.
 * Each tone shows a marker word; warning and misconception also carry a glyph.
 * `role="note"` and not `<aside>`, because six lesson callouts would add six `complementary` landmarks.
 */

import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type CalloutTone = 'insight' | 'warning' | 'misconception' | 'note';

export interface CalloutProps {
  readonly tone: CalloutTone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/** No glyph on an insight or a note: the word says it, and a diamond beside it was decoration. */
const MARKERS: Readonly<Record<CalloutTone, { readonly word: string; readonly glyph?: string }>> = {
  insight: { word: 'Insight' },
  warning: { word: 'Watch out', glyph: '▲' },
  misconception: { word: 'Common misconception', glyph: '✕' },
  note: { word: 'Note' },
};

const TONE_CLASS: Readonly<Record<CalloutTone, string>> = {
  insight: 'prl-callout--insight',
  warning: 'prl-callout--warning',
  misconception: 'prl-callout--misconception',
  note: 'prl-callout--note',
};

export function Callout(props: CalloutProps): ReactElement {
  const { tone, title, children, className } = props;
  const marker = MARKERS[tone];

  return (
    <div className={cx('prl-callout', TONE_CLASS[tone], className)} role="note">
      <span className="prl-callout__marker prl-label">
        {marker.glyph === undefined ? null : <span aria-hidden="true">{marker.glyph}</span>}
        {marker.word}
      </span>
      {title === undefined ? null : <p className="prl-callout__title">{title}</p>}
      <div className="prl-callout__body">{children}</div>
    </div>
  );
}
