/**
 * One labelled figure, in prose.
 *
 * ## StatTile or Metric?
 *
 * `Metric` is the instrument readout: an oversized tabular figure with a unit, a delta and an
 * optional count-up, for a panel whose subject *is* the number. `StatTile` is the quiet
 * version — a pre-formatted string, at body scale, for a figure mentioned inside content: a
 * lesson, a seat, a table of stats. Two components rather than a `size="xs"` on one, because
 * they differ in more than size: this one accepts an already-formatted string (including
 * `NOT_AVAILABLE`) and never animates.
 *
 * A `<dl>` rather than two `<div>`s: a label and its value *are* a description list,
 * and the pairing is then in the markup rather than implied by position. A screen
 * reader reads "pot odds, 2.4 to 1" as one item instead of two unrelated fragments.
 *
 * `tone` tints the value for a gain or a loss. It is decoration only — the string
 * passed in already carries its sign (`formatSignedUnits` guarantees that), so the
 * tile is fully readable with the colour removed. Nothing in this component sets a
 * tone by itself; the caller has to ask for it, which keeps "green means good" from
 * creeping in by default.
 *
 * `NOT_AVAILABLE` (an em dash) is what `format.ts` returns for a missing figure. An em
 * dash alone is announced as nothing, so a tile whose value is that dash gets an
 * explicit accessible label instead.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatChips, NOT_AVAILABLE } from '../format.ts';

export type StatTone = 'neutral' | 'positive' | 'negative';

export interface StatTileProps {
  readonly label: string;
  /** A pre-formatted string, or a raw number which is grouped for you. */
  readonly value: string | number;
  /** Unit word shown after the value, e.g. "units", "to 1", "% of pot". */
  readonly unit?: string;
  /** One sentence of context. Kept visible — this is where assumptions live. */
  readonly note?: string;
  readonly tone?: StatTone;
  readonly className?: string;
}

export function StatTile(props: StatTileProps): ReactElement {
  const { label, value, unit, note, tone = 'neutral', className } = props;
  const shown = typeof value === 'number' ? formatChips(value) : value;
  const isMissing = shown === NOT_AVAILABLE || shown.trim() === '';

  return (
    <div className={cx('prl-stat', className)} data-tone={tone}>
      <dl className="prl-stat__pair">
        <dt className="prl-stat__label prl-label">{label}</dt>
        <dd className="prl-stat__value">
          {/*
            An em dash on its own is announced as nothing at all, so a missing figure
            gets real hidden text instead. Not `aria-label`: that attribute is ignored on
            an element with a generic role, which would have produced a value announced as
            silence — the failure mode it was meant to prevent.
          */}
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
