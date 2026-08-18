/**
 * A stacked bar of equity shares — with the numbers written out underneath.
 *
 * ## The bar is the secondary encoding, not the primary one
 *
 * Every value shown as a segment length is also printed as text in the readout below.
 * That is what makes this compliant with "never convey the value by length or colour
 * alone", and it is not a fallback: the readout is the part that has to be right.
 *
 * Consequently the bar itself is `aria-hidden`. It carries nothing the readout does not
 * already say, and a screen reader announcing six unlabelled segments after six labelled
 * rows is noise. Hiding a *redundant* graphic is the correct use of `aria-hidden`;
 * hiding a graphic that carries unique information would be a bug.
 *
 * ## Three cues per player, not one
 *
 * Each player gets a colour, a fill pattern, and a name in the readout. The patterns
 * (see `[data-series]` in components.css) are what make the bar legible with any form
 * of colour-vision deficiency, and they are why the swatch in the readout is drawn with
 * the same `data-series` value as its segment — the swatch has to match the pattern, not
 * just the hue, or the legend does not connect.
 *
 * ## Shares are normalised, and the raw figures are still shown
 *
 * Equities should sum to 1. Monte Carlo results sum to 1 only up to rounding, and a
 * caller may pass a partial set. Segment *widths* are normalised so the bar always fills
 * its track, while the *text* shows each player's actual equity — so a set that does not
 * sum to 100% is visible in the numbers instead of being silently rescaled away.
 *
 * ## A share that is not a probability is refused, not drawn
 *
 * The readout is the authoritative half of this component, so it is the half that has to refuse.
 * A per-player equity outside 0..1 reaches the reader as "160.0%" if it is simply formatted, and
 * the geometry hides it: the segment widths are *normalised*, so an impossible equity produces a
 * perfectly ordinary-looking bar with an impossible number underneath it. `formatProbability`
 * returns `null` for such a value and the row says `not a probability` instead — see
 * `../probability.ts` for why this guard is duplicated at the render boundary rather than left to
 * the producer.
 *
 * The non-finite case is the same defect in disguise. `prepare` coerces a `NaN` equity to `0` so
 * the widths stay drawable, and formatting *that* would print a confident "0.0%" for a figure
 * nobody knows — a lie rather than a gap. The readout is therefore derived from the caller's
 * original value, never from the coerced one.
 *
 * Server-render safe: no state, no effects.
 */

import type { ReactElement } from 'react';
import { cx, type StyleWithVars } from '../cx.ts';
import { formatProbability, NOT_A_PROBABILITY } from '../probability.ts';

export interface EquityBarPlayer {
  /** Shown in the readout, e.g. "you" or "a tight opening range". */
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
  /** Names the bar, e.g. "Equity by player". */
  readonly label?: string;
  readonly className?: string;
}

/** Six series, matching the six `[data-series]` colour + pattern pairs in the CSS. */
const SERIES_COUNT = 6;

interface Prepared {
  readonly key: string;
  readonly label: string;
  /** Clamped to a drawable number. Feeds the geometry only — never the readout. */
  readonly equity: number;
  /** The readout, already refused where the caller's value was not a probability. */
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
    // With no positive total (every equity zero, or the list empty) an even split is
    // the only honest bar: it says "nothing to distinguish here" rather than dividing
    // by zero and producing NaN widths.
    const share = total > 0 ? (Math.max(equity, 0) / total) * 100 : 100 / Math.max(players.length, 1);
    const win = player.win;
    const tie = player.tie;
    // Win and tie rates are probabilities in their own right, so each is refused on its own
    // terms: a report can carry a sound win rate beside a broken tie rate, and losing both to
    // one bad field would hide information the reader is entitled to.
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
      // Label plus ordinal: two players can share a label ("a tight range" twice), and
      // the ordinal keeps their keys distinct without keying on the array index.
      key: `${player.label}#${ordinal}`,
      label: player.label,
      equity,
      // `player.equity`, not `equity`: the coerced value would render a NaN as a confident "0.0%".
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
      {/* Redundant with the readout below; see the module comment. */}
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
        {/*
          `data-series` on the row as well as the swatch, so the readout can pick up the same
          colour and pattern as its segment without a second lookup table.
        */}
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
