/**
 * The trait radar as inline SVG. No chart library and no canvas, which is one opaque bitmap to a
 * screen reader. This component sets geometry only; the stylesheet draws it.
 * The `<svg>` is `role="img"` with a shape summary, and the full table is always rendered visually
 * hidden beside it. `axisLabels="index"` draws `01…16` markers, because sixteen sentence labels overlap.
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
  /** Names the chart, e.g. the profile's archetype. The shape summary is appended. */
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
    // No axes means a missing profile, so say so rather than draw rings around nothing.
    return (
      <div className={cx('prl-radar', className)}>
        <p className="prl-radar__empty">{summary}</p>
      </div>
    );
  }

  const count = axes.length;
  // Word labels need room outside the ring. The window widens; the chart does not move.
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
