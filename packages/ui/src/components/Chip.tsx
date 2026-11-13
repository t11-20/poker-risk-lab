/**
 * A small piece of labelled state (`EXACT`, `TO ACT`, `Ah`). Its content is its label, so tone is never
 * the only cue. There is no danger tone, and `adverse` is a rose rather than alarm red (design system §2.3).
 */

import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type ChipTone = 'neutral' | 'accent' | 'favourable' | 'adverse' | 'caution' | 'info';

export interface ChipProps {
  /** The label. A chip with no text is a coloured rectangle, so this is required. */
  readonly children: ReactNode;
  readonly tone?: ChipTone;
  /** A decorative shape cue before the label. Always `aria-hidden`. */
  readonly glyph?: string;
  /** Status chips only (§4). A pill-shaped data token reads as a tag you could dismiss. */
  readonly pill?: boolean;
  readonly mono?: boolean;
  readonly className?: string;
}

export function Chip(props: ChipProps): ReactElement {
  const { children, tone = 'neutral', glyph, pill = false, mono = false, className } = props;
  return (
    <span
      className={cx('prl-chip', pill && 'prl-chip--pill', mono && 'prl-chip--mono', className)}
      data-tone={tone}
    >
      {glyph === undefined ? null : (
        <span className="prl-chip__glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
    </span>
  );
}
