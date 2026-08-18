/**
 * The trait radar, as inline SVG.
 *
 * ## No chart library, and no canvas
 *
 * A radar is sixteen coordinates and a polygon. A charting dependency would be a reviewed
 * supply-chain event, a bundle, and a second styling vocabulary competing with `tokens.css`,
 * in exchange for arithmetic that fits in `radar.ts` and is unit-tested there. Canvas is the
 * other tempting answer and is worse: a canvas is one opaque bitmap to a screen reader, it
 * does not inherit a colour token, and it needs a device-pixel-ratio dance to stay sharp.
 *
 * SVG also means the whole picture is styled from the stylesheet — the accent stroke, the
 * 12%-alpha fill, the hairline rings — so this component sets **geometry and nothing else**.
 * `vector-effect="non-scaling-stroke"` keeps a hairline exactly one hairline wide however the
 * SVG is scaled, which is the one thing geometry cannot express.
 *
 * ## The accessibility structure, which is most of this component
 *
 * A radar chart is a picture of a table, and to a screen reader it is nothing at all. So:
 *
 *  - the `<svg>` is `role="img"` with an `aria-label` summarising the shape — how many axes,
 *    the average, the extremes — which is what tells a reader whether to read further;
 *  - beside it, **the full table is always rendered**, visually hidden: axis marker, trait
 *    name, value. Not a `<figcaption>`, not a tooltip, not a summary sentence pretending to be
 *    the data. The numbers *are* the content, and a profile is literally a set of numbers, so
 *    anything less would be hiding the subject of the component.
 *
 * The rings and spokes carry no information the table does not, and children of `role="img"`
 * are ignored anyway, so nothing inside the SVG is announced.
 *
 * ## Why axis labels have a mode
 *
 * The wire labels are sentences ("Value-heavy vs bluff-heavy", "Adjusts to stack depth"). Six
 * of those around a ring is legible; sixteen is a thicket, at any size — SVG text does not
 * wrap and scaling the chart scales the overlap with it. So `axisLabels="index"` draws the
 * numbered markers `01…16` instead, and the hidden table maps every marker to its trait. No
 * information is lost in any mode, because the table is not a fallback.
 *
 * `text` mode also widens the `viewBox` so the words have somewhere to go, rather than relying
 * on an `overflow: visible` rule in a stylesheet this component cannot see.
 *
 * Deterministic for a given input, and server-render safe: no state, no effects, no clock.
 */

import type { LegendTraitAxis } from '@prl/contracts';
import type { ReactElement } from 'react';
import { cx } from '../cx.ts';
import { formatChips } from '../format.ts';
import {
  axisAngle,
  axisLabelAnchor,
  axisMarker,
  polarPoint,
  polygonPoints,
  RADAR_CENTRE,
  RADAR_LABEL_GUTTER,
  RADAR_LABEL_RADIUS,
  RADAR_RADIUS,
  RADAR_RING_FRACTIONS,
  radarViewBox,
  ringPoints,
  roundCoordinate,
  summariseAxes,
} from '../radar.ts';

/** `text` for up to about eight axes, `index` beyond that, `none` when a legend sits beside. */
export type RadarAxisLabels = 'text' | 'index' | 'none';

export interface RadarChartProps {
  readonly axes: readonly LegendTraitAxis[];
  /** Names the chart, e.g. the profile's archetype. The shape summary is appended for the label. */
  readonly label?: string;
  readonly axisLabels?: RadarAxisLabels;
  readonly className?: string;
}

/** Values are 0..1 by contract; the table prints two decimals, matching `@prl/poker-ai`. */
const VALUE_DECIMALS = 2;

export function RadarChart(props: RadarChartProps): ReactElement {
  const { axes, label, axisLabels = 'text', className } = props;
  const summary = summariseAxes(axes);

  if (axes.length === 0) {
    // A radar with no axes is not an empty chart, it is a missing profile. Saying so is more
    // use to a reader than three rings around nothing.
    return (
      <div className={cx('prl-radar', className)}>
        <p className="prl-radar__empty">{summary}</p>
      </div>
    );
  }

  const count = axes.length;
  // Word labels need room outside the ring; two-character markers do not. The window widens,
  // the chart itself does not move — see `radarViewBox`.
  const viewBox = radarViewBox(axisLabels === 'text' ? RADAR_LABEL_GUTTER : 0);
  const shape = polygonPoints(axes.map((axis) => axis.value));

  return (
    <div className={cx('prl-radar', className)}>
      <svg
        className="prl-radar__svg"
        viewBox={viewBox}
        role="img"
        aria-label={label === undefined ? summary : `${label}. ${summary}`}
      >
        <g className="prl-radar__rings">
          {RADAR_RING_FRACTIONS.map((fraction) => (
            <polygon
              key={`prl-radar-ring-${fraction}`}
              className="prl-radar__ring"
              points={ringPoints(count, fraction)}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </g>
        <g className="prl-radar__spokes">
          {axes.map((axis, index) => {
            const end = polarPoint(RADAR_CENTRE, RADAR_CENTRE, RADAR_RADIUS, axisAngle(index, count));
            return (
              <line
                key={axis.key}
                className="prl-radar__spoke"
                x1={RADAR_CENTRE}
                y1={RADAR_CENTRE}
                x2={roundCoordinate(end.x)}
                y2={roundCoordinate(end.y)}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>
        <polygon className="prl-radar__shape" points={shape} vectorEffect="non-scaling-stroke" />
        {axisLabels === 'none' ? null : (
          <g className="prl-radar__labels">
            {axes.map((axis, index) => {
              const angle = axisAngle(index, count);
              const at = polarPoint(RADAR_CENTRE, RADAR_CENTRE, RADAR_LABEL_RADIUS, angle);
              return (
                <text
                  key={axis.key}
                  className={cx('prl-radar__label', axisLabels === 'index' && 'prl-index')}
                  x={roundCoordinate(at.x)}
                  y={roundCoordinate(at.y)}
                  textAnchor={axisLabelAnchor(angle)}
                  dominantBaseline="middle"
                >
                  {axisLabels === 'index' ? axisMarker(index) : axis.label}
                </text>
              );
            })}
          </g>
        )}
      </svg>
      {/*
        The chart's content in full, for anyone who cannot see the chart. Always rendered, never
        collapsed, and deliberately not a `<figcaption>`: this is data, not a caption.
      */}
      <table className="prl-visually-hidden">
        <caption>{label === undefined ? 'Trait values' : `${label}: trait values`}</caption>
        <thead>
          <tr>
            <th scope="col">Axis</th>
            <th scope="col">Trait</th>
            <th scope="col">Value, on a 0 to 1 scale</th>
          </tr>
        </thead>
        <tbody>
          {axes.map((axis, index) => (
            <tr key={axis.key}>
              <td>{axisMarker(index)}</td>
              <th scope="row">{axis.label}</th>
              <td>{formatChips(axis.value, { decimals: VALUE_DECIMALS })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
