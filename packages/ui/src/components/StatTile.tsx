/**
 * One labelled figure at body scale, pre-formatted and never animated. `Metric` is the oversized readout.
 * A `<dl>` so a screen reader reads label and value as one item. `tone` is decoration only, because the
 * string already carries its sign, and nothing sets a tone by default.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatChips, NOT_AVAILABLE } from '../format.ts';
import type { TipCopy } from '../tips.ts';
import { Tip } from './Tip.tsx';

export type StatTone = 'neutral' | 'positive' | 'negative';

export interface StatTileProps {
  readonly label: string;
  /** A pre-formatted string, or a raw number which is grouped for you. */
  readonly value: string | number;
  readonly unit?: string;
  readonly note?: string;
  readonly tone?: StatTone;
  /** A `?` after the label, inside the `<dt>`, which names nothing, so the pair is still read as one. */
  readonly tip?: TipCopy;
  readonly className?: string;
}

export function StatTile(props: StatTileProps): ReactElement {
  const { label, value, unit, note, tone = 'neutral', tip, className } = props;
  const shown = typeof value === 'number' ? formatChips(value) : value;
  const isMissing = shown === NOT_AVAILABLE || shown.trim() === '';

  return (
    <div
      className={cx('prl-stat', className)}
      data-tip-subject={tip === undefined ? undefined : ''}
      data-tone={tone}
    >
      <dl className="prl-stat__pair">
        <dt className="prl-stat__label prl-label">
          {label}
          {tip === undefined ? null : <Tip tip={tip} />}
        </dt>
        <dd className="prl-stat__value">
          {/* Hidden text, not `aria-label` (ignored on a generic role). A lone dash is read as nothing. */}
          {isMissing ? (
            <span>
              <span aria-hidden="true">{NOT_AVAILABLE}</span>
              <span className="prl-visually-hidden">not available</span>
            </span>
          ) : (
            <span>{shown}</span>
          )}
          {unit === undefined || isMissing ? null : <span className="prl-stat__unit prl-label">{unit}</span>}
        </dd>
      </dl>
      {note === undefined ? null : <p className="prl-stat__note">{note}</p>}
    </div>
  );
}
