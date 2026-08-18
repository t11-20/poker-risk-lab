/**
 * The sixteen trait axes as labelled bars, each with its plain-language meaning.
 *
 * ## Why every row carries its description
 *
 * `LegendTraitAxis.description` is written so that a HIGH value never reads as "better" — every
 * trait is a trade-off and each sentence says what it costs. That property only survives if the
 * sentence is on screen next to the number. So the description is not optional here, not
 * collapsed, and not moved to a tooltip: it is the difference between a profile card and a
 * scorecard.
 *
 * For the same reason there is **no ranking, no star rating, no grade and no colour scale** in
 * this component. Every bar is the same series colour, because a hot-to-cold ramp would say that
 * one end of an axis is good — which is exactly the claim the wire text is written to avoid.
 * `Folds under pressure` at 0.76 is not worse than 0.14; it is a different opponent.
 *
 * ## Three encodings, in the right order
 *
 *  1. **The number, as text.** A length is not readable on its own and it is not announced at all,
 *     so the value is printed for every axis with its scale (`0.92 of 1`) in tabular figures.
 *  2. **The description, as text.** What the axis means and what it trades away.
 *  3. **The bar.** `aria-hidden`, because it repeats the number beside it and announcing both
 *     would read sixteen axes twice.
 *
 * The share is published to CSS as a custom property and applied as a static `flex-basis`.
 * Nothing here animates a width: the design system permits `transform` and `opacity` only.
 *
 * Server-render safe: no state, no effects, no clock.
 */

import type { LegendTraitAxis, LegendTraitKey } from '@prl/contracts';
import { axisMarker, Chip, cx, formatChips, formatPercent, type StyleWithVars } from '@prl/ui';
import type { ReactElement } from 'react';

/** Trait values are 0..1 by contract, and two decimals is the precision `@prl/poker-ai` states. */
const VALUE_DECIMALS = 2;

/** One decimal on the bar's share: below that, two axes 0.05 apart draw the same bar. */
const SHARE_DECIMALS = 1;

export interface TraitBarsProps {
  readonly axes: readonly LegendTraitAxis[];
  /**
   * The axes this profile is most defined by. Marked with a word, not with a colour or a size, so
   * the mark says "this one characterises the style" and not "this one is high".
   */
  readonly signature?: readonly LegendTraitKey[];
  readonly className?: string;
}

/** A value outside 0..1 is a defect upstream. The bar clamps; the printed figure does not. */
function shareFor(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  const clamped = Math.min(1, Math.max(0, value));
  return formatPercent(clamped, { decimals: SHARE_DECIMALS });
}

export function TraitBars(props: TraitBarsProps): ReactElement {
  const { axes, signature = [], className } = props;

  if (axes.length === 0) {
    return (
      <p className={cx('prl-legend-traits__meaning', className)}>
        No trait axes were reported for this profile, so there is nothing here to read. A profile with no axes
        is a missing profile rather than an empty chart.
      </p>
    );
  }

  return (
    <ol className={cx('prl-legend-traits', className)}>
      {axes.map((axis, index) => {
        const style: StyleWithVars = { '--prl-legend-trait-share': shareFor(axis.value) };
        const isSignature = signature.includes(axis.key);
        return (
          <li className="prl-legend-traits__row" key={axis.key}>
            <div className="prl-legend-traits__head">
              <span aria-hidden="true" className="prl-index">
                {axisMarker(index)}
              </span>
              <span className="prl-legend-traits__label">{axis.label}</span>
              {isSignature ? (
                <Chip glyph="◆" tone="accent">
                  Signature axis
                </Chip>
              ) : null}
              <span className="prl-legend-traits__value">
                {formatChips(axis.value, { decimals: VALUE_DECIMALS })}
              </span>
              <span className="prl-label">of 1</span>
            </div>
            {/*
              Decorative: the figure above and the sentence below carry everything this draws. The
              fill reuses the `.prl-fill` / `[data-series]` pair from components.css so the colour
              comes from the series tokens rather than from a value in this file.
            */}
            <div aria-hidden="true" className="prl-legend-traits__track">
              <span className="prl-legend-traits__fill prl-fill" data-series="a" style={style} />
            </div>
            <p className="prl-legend-traits__meaning">{axis.description}</p>
          </li>
        );
      })}
    </ol>
  );
}
