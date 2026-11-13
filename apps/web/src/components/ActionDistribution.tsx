/**
 * The distribution a policy sampled its action from, as a bar plus a printed legend. The styles are
 * probabilistic, so the spread is shown rather than its mode. Every probability is printed as text,
 * because the bar alone would convey value by length. The series comes from the verb, so an action
 * keeps its colour and fill pattern (`[data-series]` in `components.css`) in every compare column.
 * A sum other than 1 is reported, never normalised away. Server-render safe.
 */

import {
  cx,
  formatPercent,
  formatProbability,
  NOT_A_PROBABILITY,
  type StyleWithVars,
  withKeys,
} from '@prl/ui';
import type { ReactElement } from 'react';

export interface ActionShare {
  readonly action: string;
  readonly probability: number;
  readonly medianSizeToPotFraction?: number | null;
}

export interface ActionDistributionProps {
  readonly label: string;
  readonly entries: readonly ActionShare[];
  /**
   * Must be one of `entries[].action`, taken from the list and never rebuilt, because it is matched
   * with `===`. A rebuilt `raise to 1,200` never matched the entry's `raise to 1200`.
   * Use `mostLikelyAction`.
   */
  readonly modalAction?: string;
  readonly className?: string;
}

/** Lives in a leaf `.ts` module because `node --test` cannot load a `.tsx`. */
export { mostLikelyAction } from '@/lib/action-distribution.ts';

/** `d` is reserved for an unknown verb, so it never shares a colour with a known one. */
const SERIES_BY_VERB: Readonly<Record<string, string>> = {
  fold: 'f',
  check: 'e',
  call: 'a',
  bet: 'b',
  raise: 'c',
};

const UNKNOWN_SERIES = 'd';

const SUM_TOLERANCE = 0.005;

const SHARE_DECIMALS = 1;

export function seriesForAction(action: string): string {
  const verb = action.trim().toLowerCase().split(' ')[0] ?? '';
  return SERIES_BY_VERB[verb] ?? UNKNOWN_SERIES;
}

export function ActionDistribution(props: ActionDistributionProps): ReactElement {
  const { label, entries, modalAction, className } = props;

  if (entries.length === 0) {
    return (
      <div className={cx('prl-legend-dist', className)}>
        <span className="prl-label">{label}</span>
        <p className="prl-legend-dist__size">
          No action distribution was reported for this decision, so there is nothing to show about how the
          action was chosen.
        </p>
      </div>
    );
  }

  let total = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.probability)) total += entry.probability;
  }
  const sumIsOff = Math.abs(total - 1) > SUM_TOLERANCE;
  const keyed = withKeys(
    entries.map((entry) => entry.action),
    'action',
  );

  return (
    <div className={cx('prl-legend-dist', className)}>
      <span className="prl-label">{label}</span>
      {/* Decorative. The legend below carries every value as text. */}
      <div aria-hidden="true" className="prl-bar">
        {entries.map((entry, index) => {
          const style: StyleWithVars = {
            '--prl-segment-share': formatPercent(
              Number.isFinite(entry.probability) ? Math.max(0, entry.probability) : 0,
              { decimals: SHARE_DECIMALS },
            ),
          };
          return (
            <span
              className="prl-bar__segment prl-fill"
              data-series={seriesForAction(entry.action)}
              key={keyed[index]?.key ?? entry.action}
              style={style}
            />
          );
        })}
      </div>
      <ul className="prl-legend-dist__legend">
        {entries.map((entry, index) => (
          <li
            className="prl-legend-dist__row"
            data-modal={modalAction !== undefined && modalAction === entry.action ? 'true' : undefined}
            key={keyed[index]?.key ?? entry.action}
          >
            <span
              aria-hidden="true"
              className="prl-legend-dist__swatch prl-fill"
              data-series={seriesForAction(entry.action)}
            />
            <span className="prl-legend-dist__action">
              {entry.action}
              {modalAction !== undefined && modalAction === entry.action ? (
                <span className="prl-legend-dist__most-likely"> — most likely</span>
              ) : null}
            </span>
            <span className="prl-legend-dist__probability">
              {/* A probability, so an entry outside 0..1 is named rather than printed as a percentage. */}
              {formatProbability(entry.probability, { decimals: SHARE_DECIMALS }) ?? NOT_A_PROBABILITY}
            </span>
            {entry.medianSizeToPotFraction === undefined || entry.medianSizeToPotFraction === null ? null : (
              <span className="prl-legend-dist__size">
                {/* Not a probability. A bet above pot size is ordinary, so this uses `formatPercent`. */}
                {`Median size ${formatPercent(entry.medianSizeToPotFraction, { decimals: 0 })} of the pot`}
              </span>
            )}
          </li>
        ))}
      </ul>
      {sumIsOff ? (
        <p className="prl-legend-dist__size">
          {`These weights sum to ${formatPercent(total, { decimals: SHARE_DECIMALS })} rather than 100%. That is a defect in the data rather than a rounding choice here, and the figures are shown unaltered so it is visible.`}
        </p>
      ) : null}
    </div>
  );
}
