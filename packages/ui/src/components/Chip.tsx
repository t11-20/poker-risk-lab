/**
 * A small piece of labelled state: `EXACT`, `TO ACT`, `MONTE CARLO`, `Ah`.
 *
 * ## Why a chip can never convey meaning by colour alone
 *
 * By construction: **its content is its label**. A chip is a word (or a card string), so the
 * tone is always the second cue on top of text that already says what it is. That is the
 * difference between this and a status dot, which is why there is no dot in this system.
 * `glyph` adds a third, shape-based cue where the distinction matters enough to earn one.
 *
 * ## Tone is not severity
 *
 * `accent` marks live or computed data. `caution` and `adverse` mark a caveat and an adverse
 * figure — a hand that lost is information, not a failure, so the palette is a rose rather
 * than an alarm red (§2.3). Nothing here escalates: there is no "danger" tone, because
 * nothing in an educational play-money app is dangerous.
 *
 * ## `pill` is for status only
 *
 * Near-square is the system's default and `--prl-radius-pill` exists for status chips alone
 * (§4). A pill-shaped *data* token reads as a tag you could dismiss.
 *
 * `mono` switches to the monospace stack for a card string, a range or a hand class, where
 * character alignment is what makes `AhKh` readable at a glance.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement, ReactNode } from 'react';
import { cx } from '../cx.ts';

export type ChipTone = 'neutral' | 'accent' | 'favourable' | 'adverse' | 'caution' | 'info';

export interface ChipProps {
  /** The label. A chip with no text is a coloured rectangle, so this is required. */
  readonly children: ReactNode;
  readonly tone?: ChipTone;
  /** A decorative shape cue drawn before the label, e.g. "◆". Always `aria-hidden`. */
  readonly glyph?: string;
  /** Fully rounded. Status only — see the module comment. */
  readonly pill?: boolean;
  /** Monospace, for a card string or a range. */
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
