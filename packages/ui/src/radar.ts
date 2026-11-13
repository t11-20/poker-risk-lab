/**
 * Geometry and the spoken summary for the trait radar, pure so `test/radar.test.ts` can pin coordinates.
 * Angle 0 is straight up and angles increase clockwise. SVG y points down, so `y = cy - r cos(a)`.
 * Values are the shared 0..1 trait scale, never rescaled per axis.
 * Coordinates round to two decimals so server and client renders match byte for byte.
 */

import { formatChips, formatIndex, pluralise } from './format.ts';

export interface RadarPoint {
  readonly x: number;
  readonly y: number;
}

/** In user units. */
export interface RadarGeometry {
  readonly centreX: number;
  readonly centreY: number;
  readonly radius: number;
}

/** CSS sizes the SVG. The component never takes a `size` prop. */
export const RADAR_VIEWBOX = 240;
export const RADAR_CENTRE = 120;
/** Leaves room between the outer ring and the axis labels. */
export const RADAR_RADIUS = 88;
export const RADAR_LABEL_RADIUS = 102;

/** Thirds, so a value reads as below, between or at the edge without counting. The last ring is 1.0. */
export const RADAR_RING_FRACTIONS = [1 / 3, 2 / 3, 1] as const;

export const RADAR_DEFAULT_GEOMETRY: RadarGeometry = {
  centreX: RADAR_CENTRE,
  centreY: RADAR_CENTRE,
  radius: RADAR_RADIUS,
};

/** About twelve characters at label size. Longer labels need the numbered markers instead. */
export const RADAR_LABEL_GUTTER = 64;

/**
 * Widens the window rather than shrinking the chart, so the geometry never depends on labels.
 * A negative `min-x` buys the room without relying on `overflow: visible` in a stylesheet.
 */
export function radarViewBox(gutter = 0): string {
  const room = Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
  return `${-room} 0 ${RADAR_VIEWBOX + room * 2} ${RADAR_VIEWBOX}`;
}

const COORDINATE_SCALE = 100;

/** Below this `|sin|`, a label centres on its spoke. Beyond it, it hangs away from the chart. */
const VERTICAL_TOLERANCE = 0.15;

/** Exported because the component writes spoke attributes directly and must round the same way. */
export function roundCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
}

/** Radians. A count of zero or less returns 0 rather than a `NaN` coordinate downstream. */
export function axisAngle(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 0) return 0;
  return (2 * Math.PI * index) / count;
}

/** Unrounded. Callers that emit an attribute round on the way out. */
export function polarPoint(centreX: number, centreY: number, r: number, angle: number): RadarPoint {
  return {
    x: centreX + r * Math.sin(angle),
    y: centreY - r * Math.cos(angle),
  };
}

/** Only the drawing clamps. The hidden table prints the raw value, so an impossible one stays visible. */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function polygonPoints(
  values: readonly number[],
  geometry: RadarGeometry = RADAR_DEFAULT_GEOMETRY,
): string {
  const count = values.length;
  const parts: string[] = [];
  let index = 0;
  for (const value of values) {
    const point = polarPoint(
      geometry.centreX,
      geometry.centreY,
      geometry.radius * clampUnit(value),
      axisAngle(index, count),
    );
    parts.push(`${roundCoordinate(point.x)},${roundCoordinate(point.y)}`);
    index += 1;
  }
  return parts.join(' ');
}

/**
 * A polygon, not a circle, so it shares corners with the value polygon. A circle behind a 16-gon
 * looks like the values cross a line they never cross.
 */
export function ringPoints(
  axisCount: number,
  fraction: number,
  geometry: RadarGeometry = RADAR_DEFAULT_GEOMETRY,
): string {
  if (!Number.isFinite(axisCount) || axisCount <= 0) return '';
  const values: number[] = [];
  for (let index = 0; index < Math.trunc(axisCount); index += 1) values.push(fraction);
  return polygonPoints(values, geometry);
}

export function axisLabelAnchor(angle: number): 'start' | 'middle' | 'end' {
  const horizontal = Math.sin(angle);
  if (!Number.isFinite(horizontal) || Math.abs(horizontal) < VERTICAL_TOLERANCE) return 'middle';
  return horizontal > 0 ? 'start' : 'end';
}

export interface RadarAxisValue {
  readonly label: string;
  readonly value: number;
}

/** Takes a 0-based index and shows a 1-based position, matching the hidden table. */
export function axisMarker(index: number): string {
  return formatIndex(index + 1);
}

function traitValueText(value: number): string {
  return formatChips(value, { decimals: 2 });
}

/**
 * The shape for `aria-label`, meaning axis count, average and extremes. `RadarChart` renders the full table.
 * "Highest" and "lowest", never "best", because the traits describe style, not quality.
 */
export function summariseAxes(axes: readonly RadarAxisValue[]): string {
  if (axes.length === 0) return 'Trait radar with no axes reported.';

  let highest: RadarAxisValue | null = null;
  let lowest: RadarAxisValue | null = null;
  let total = 0;
  let counted = 0;
  for (const axis of axes) {
    if (!Number.isFinite(axis.value)) continue;
    total += axis.value;
    counted += 1;
    if (highest === null || axis.value > highest.value) highest = axis;
    if (lowest === null || axis.value < lowest.value) lowest = axis;
  }

  const scale = pluralise(axes.length, 'trait axis', 'trait axes');
  if (highest === null || lowest === null || counted === 0) {
    return `Trait radar over ${scale}, none of which reported a readable value.`;
  }
  const mean = traitValueText(total / counted);
  return (
    `Trait radar over ${scale} on a 0 to 1 scale, averaging ${mean}. ` +
    `Highest: ${highest.label} at ${traitValueText(highest.value)}. ` +
    `Lowest: ${lowest.label} at ${traitValueText(lowest.value)}.`
  );
}
