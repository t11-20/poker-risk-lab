/**
 * The sixteen trait axes as bars, each with its description always visible, because the description
 * is what stops a high value reading as "better". No ranking, grade or colour ramp, so every bar
 * uses one series colour. The number is printed as text and the bar is `aria-hidden`.
 * The share is a static `flex-basis`. Nothing animates a width.
 */

import type { LegendTraitAxis, LegendTraitKey } from '@prl/contracts';
import { axisMarker, Chip, cx, formatChips, formatPercent, type StyleWithVars } from '@prl/ui';
import type { ReactElement } from 'react';

const VALUE_DECIMALS = 2;

/** At zero decimals two axes 0.05 apart draw the same bar. */
const SHARE_DECIMALS = 1;

export interface TraitBarsProps {
  readonly axes: readonly LegendTraitAxis[];
  /** Marked with a word, not a colour or size, so the mark never reads as "high". */
  readonly signature?: readonly LegendTraitKey[];
  readonly className?: string;
}

/** The bar clamps an out-of-range value. The printed figure does not. */
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
              {/* One unit, because as two flex items the scale wrapped alone at 360px. */}
              <span className="prl-legend-traits__figure">
                <span className="prl-legend-traits__value">
                  {formatChips(axis.value, { decimals: VALUE_DECIMALS })}
                </span>
                <span className="prl-label">of 1</span>
              </span>
            </div>
            {/* Decorative. The figure and the sentence carry the value. */}
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
