/**
 * A tonal aside. Tones match the `LessonBlock` callout tones in `@prl/contracts`, so a lesson passes
 * its tone straight through. Each tone shows a marker word and a glyph as well as colour.
 * `role="note"` and not `<aside>`, because six lesson callouts would add six `complementary` landmarks.
 */

import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type CalloutTone = 'insight' | 'warning' | 'misconception';

export interface CalloutProps {
  readonly tone: CalloutTone;
  readonly title?: string;
  readonly children: ReactNode;
  readonly className?: string;
}

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
