/**
 * The geometry and the spoken summary for the trait radar.
 *
 * ## Why the maths is not inside the component
 *
 * `RadarChart.tsx` is JSX, and JSX cannot be run under `node --test` in this repo — there is
 * no renderer dependency and there will not be one. A radar chart is almost entirely
 * arithmetic, and arithmetic that is wrong by a sign or a quarter turn produces a picture
 * that looks plausible and says something false about a profile. So every coordinate comes
 * from a pure function here, and `test/radar.test.ts` asserts exact coordinates for inputs
 * whose answers can be worked out by hand.
 *
 * ## The conventions, fixed once
 *
 *  - **Angle 0 is straight up, and angles increase clockwise.** That is what a radar chart
 *    means by "the first axis", and it matches how the axis list reads top-to-bottom in the
 *    hidden table beside the chart.
 *  - **The y axis points down**, because that is what SVG does. Hence `y = cy - r cos(a)`
 *    rather than `+`; getting this wrong flips the chart vertically and nothing complains.
 *  - **Values are fractions in 0..1**, which is the scale `@prl/poker-ai` defines for every
 *    trait (see `traits.ts`: "All fields are 0..1 inclusive"). No per-axis rescaling — the
 *    comparability between profiles is the point of the shared scale.
 *  - **Coordinates are rounded to two decimals** on the way into a `points` attribute. Two
 *    decimals is well below a device pixel at any size this renders at, it keeps the
 *    attribute short, and it makes the output byte-identical between a server render and a
 *    client render, which is what stops React reporting a hydration mismatch on a chart.
 *
 * Nothing here reads the DOM, a clock or a random source. Same axes in, same picture out.
 */

import { formatChips, formatIndex, pluralise } from './format.ts';

export interface RadarPoint {
  readonly x: number;
  readonly y: number;
}

/** Where the polygon and the rings are drawn, in user units. */
export interface RadarGeometry {
  readonly centreX: number;
  readonly centreY: number;
  readonly radius: number;
}

/**
 * A square viewBox. The chart is round, so a square frame is the honest one, and the SVG is
 * scaled by CSS rather than by a `size` prop — a design-system component does not decide how
 * wide it is.
 */
export const RADAR_VIEWBOX = 240;
export const RADAR_CENTRE = 120;
/** Leaves room between the outer ring and the axis labels. */
export const RADAR_RADIUS = 88;
export const RADAR_LABEL_RADIUS = 102;

/**
 * Three concentric reference rings, the outermost of which *is* the boundary at 1.0. Thirds
 * rather than quarters so a reader can place a value against them without counting: below
 * the first ring, between the rings, or out at the edge.
 */
export const RADAR_RING_FRACTIONS = [1 / 3, 2 / 3, 1] as const;

export const RADAR_DEFAULT_GEOMETRY: RadarGeometry = {
  centreX: RADAR_CENTRE,
  centreY: RADAR_CENTRE,
  radius: RADAR_RADIUS,
};

/**
 * Extra horizontal room for word-shaped axis labels, in user units.
 *
 * Roughly twelve characters at label size. Beyond that a label runs out of the frame and the
 * caller wants the numbered markers instead — which is the honest answer for the sixteen-axis
 * profile card, where the wire labels are short sentences.
 */
export const RADAR_LABEL_GUTTER = 64;

/**
 * The `viewBox`, widened by `gutter` on each side.
 *
 * Widening the *window* rather than shrinking the *chart* is what keeps the geometry above
 * independent of whether labels are drawn: the ring is always radius 88 about (120, 120), and
 * a mode that needs room for text simply looks through a wider window at it, which the browser
 * resolves by rendering the whole thing a little smaller in the same CSS box.
 *
 * A negative `min-x` is perfectly legal SVG, and it is the only way to buy that room without
 * depending on an `overflow: visible` rule in a stylesheet this module cannot see.
 */
export function radarViewBox(gutter = 0): string {
  const room = Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
  return `${-room} 0 ${RADAR_VIEWBOX + room * 2} ${RADAR_VIEWBOX}`;
}

/** Two decimals — see the module comment on hydration stability. */
const COORDINATE_SCALE = 100;

/**
 * How far from the vertical an axis may sit before its label stops being centred. A label
 * near the top or bottom of the ring reads best centred on its spoke; one out to the side
 * has to hang away from the chart or it will sit on top of it.
 */
const VERTICAL_TOLERANCE = 0.15;

/**
 * Rounds one coordinate for an SVG attribute. Exported because the component emits `x1`/`y2`
 * attributes directly for the spokes and must round them the same way the polygons do.
 */
export function roundCoordinate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * COORDINATE_SCALE) / COORDINATE_SCALE;
}

/**
 * The angle of the nth axis, in radians, with 0 straight up and increasing clockwise.
 *
 * A count of zero or less has no axes to place, so the answer is 0 rather than a division by
 * zero producing `Infinity` and an `NaN` coordinate downstream.
 */
export function axisAngle(index: number, count: number): number {
  if (!Number.isFinite(index) || !Number.isFinite(count) || count <= 0) return 0;
  return (2 * Math.PI * index) / count;
}

/**
 * A point at radius `r` and angle `angle` from a centre.
 *
 * Unrounded: this is the primitive, and callers that emit an attribute round on the way out.
 */
export function polarPoint(centreX: number, centreY: number, r: number, angle: number): RadarPoint {
  return {
    x: centreX + r * Math.sin(angle),
    y: centreY - r * Math.cos(angle),
  };
}

/**
 * Clamps a trait value into the drawable 0..1 range.
 *
 * Only the *drawing* clamps. The visually hidden table beside the chart prints the value it
 * was given, so a profile that arrives with 1.4 on an axis shows an odd number in the table
 * rather than a polygon spilling silently over its own boundary. Hiding an impossible value
 * would hide the bug that produced it — the same rule `format.ts` follows.
 */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * The `points` attribute for a polygon through one value per axis.
 *
 * Values are taken in order, one axis each, starting straight up. `"x,y x,y …"` — the SVG
 * spelling, with coordinates rounded.
 */
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
 * The `points` attribute for one reference ring, drawn as a polygon rather than a circle.
 *
 * A polygonal ring shares its corners with the value polygon, so a reader can compare the two
 * shapes directly. A circle behind a 16-gon would sit outside it at every axis and inside it
 * between them, which reads as the value polygon crossing a reference line it never crosses.
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

/**
 * The `text-anchor` for an axis label at this angle, so a label never overlaps the chart it
 * belongs to: hung to the right on the right-hand side, to the left on the left, centred at
 * the top and bottom.
 */
export function axisLabelAnchor(angle: number): 'start' | 'middle' | 'end' {
  const horizontal = Math.sin(angle);
  if (!Number.isFinite(horizontal) || Math.abs(horizontal) < VERTICAL_TOLERANCE) return 'middle';
  return horizontal > 0 ? 'start' : 'end';
}

export interface RadarAxisValue {
  readonly label: string;
  readonly value: number;
}

/**
 * `01`, `02`, … — the numbered-system motif as a compact axis marker.
 *
 * Takes a 0-based array index and shows a 1-based position, because the marker is read by a
 * human and the hidden table it keys into is read the same way.
 */
export function axisMarker(index: number): string {
  return formatIndex(index + 1);
}

function traitValueText(value: number): string {
  return formatChips(value, { decimals: 2 });
}

/**
 * One sentence describing the shape, for the chart's `aria-label`.
 *
 * A radar chart is a picture of a table, and the `aria-label` is not a substitute for that
 * table — `RadarChart` renders the full one, visually hidden, right next to it. What this
 * sentence does is give a reader who lands on the image the *shape*: how many axes, the
 * average, and which axes sit at the extremes, so they know whether the table below is worth
 * reading in full.
 *
 * The wording is deliberately neutral. "Highest" and "lowest", never "strongest" or "best":
 * a high value on `foldToPressure` is not a virtue, and the trait vocabulary is documented as
 * describing style rather than quality.
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
