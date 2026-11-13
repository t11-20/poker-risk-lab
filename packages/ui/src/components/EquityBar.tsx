/**
 * A stacked bar of equity shares with every value also printed in the readout, so the bar is
 * `aria-hidden`. Each player gets a colour, a `[data-series]` fill pattern and a name. Widths are
 * normalised; the text shows each raw equity, so a set that does not sum to 100% stays visible.
 * A share outside 0..1 reads `not a probability` (`../probability.ts`), and the readout uses the
 * caller's value, because the `NaN` coerced to 0 for the geometry would print a confident "0.0%".
 */

import type { ReactElement } from 'react';
import { cx, type StyleWithVars } from '../cx.ts';
import { formatProbability, NOT_A_PROBABILITY } from '../probability.ts';

export interface EquityBarPlayer {
  readonly label: string;
  /** Pot share as a fraction in 0..1. */
  readonly equity: number;
  /** Fraction of trials this player held the sole best hand. */
  readonly win?: number;
  /** Fraction of trials this player shared the best hand. */
  readonly tie?: number;
}

export interface EquityBarProps {
  readonly players: readonly EquityBarPlayer[];
  readonly label?: string;
  readonly className?: string;
}

/** Matches the six `[data-series]` colour and pattern pairs in the CSS. */
const SERIES_COUNT = 6;

interface Prepared {
  readonly key: string;
  readonly label: string;
  /** Clamped to a drawable number. Geometry only, never the readout. */
  readonly equity: number;
  readonly valueText: string;
  readonly share: number;
  readonly series: number;
  readonly detail: string | null;
}

function prepare(players: readonly EquityBarPlayer[]): readonly Prepared[] {
  let total = 0;
  for (const player of players) {
    if (Number.isFinite(player.equity) && player.equity > 0) total += player.equity;
  }

  const out: Prepared[] = [];
  let ordinal = 0;
  for (const player of players) {
    const equity = Number.isFinite(player.equity) ? player.equity : 0;
    // With no positive total, an even split avoids NaN widths.
    const share = total > 0 ? (Math.max(equity, 0) / total) * 100 : 100 / Math.max(players.length, 1);
    const win = player.win;
    const tie = player.tie;
    // Win and tie are refused separately, so one bad field does not hide the other.
    const detail =
      win === undefined && tie === undefined
        ? null
        : [
            win === undefined ? null : `wins ${formatProbability(win) ?? NOT_A_PROBABILITY}`,
            tie === undefined ? null : `ties ${formatProbability(tie) ?? NOT_A_PROBABILITY}`,
          ]
            .filter((part): part is string => part !== null)
            .join(', ');
    out.push({
      key: `${player.label}#${ordinal}`,
      label: player.label,
      equity,
      valueText: formatProbability(player.equity) ?? NOT_A_PROBABILITY,
      share,
      series: (ordinal % SERIES_COUNT) + 1,
      detail,
    });
    ordinal += 1;
  }
  return out;
}

export function EquityBar(props: EquityBarProps): ReactElement {
  const { players, label = 'Equity by player', className } = props;
  const prepared = prepare(players);

  return (
    <div className={cx('prl-equity-bar', className)}>
      <span className="prl-equity-bar__label prl-label">{label}</span>
      <span className="prl-equity-bar__track" aria-hidden="true">
        {prepared.map((entry) => {
          const style: StyleWithVars = { '--prl-segment-share': `${entry.share.toFixed(3)}%` };
          return (
            <span
              key={entry.key}
              className="prl-equity-bar__segment prl-fill"
              data-series={entry.series}
              style={style}
            />
          );
        })}
      </span>
      <dl className="prl-equity-bar__readout">
        {prepared.map((entry) => (
          <div className="prl-equity-bar__row" key={entry.key} data-series={entry.series}>
            <span className="prl-equity-bar__swatch prl-fill" data-series={entry.series} aria-hidden="true" />
            <dt className="prl-equity-bar__name">{entry.label}</dt>
            <dd className="prl-equity-bar__value">{entry.valueText}</dd>
            {entry.detail === null ? null : <dd className="prl-equity-bar__detail">{entry.detail}</dd>}
          </div>
        ))}
      </dl>
    </div>
  );
}
