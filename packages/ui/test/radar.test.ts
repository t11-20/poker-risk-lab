/**
 * Tests for the radar chart's geometry and its spoken summary.
 *
 * A radar chart cannot be eyeballed for correctness: a quarter-turn error, a flipped y axis or
 * an off-by-one in the axis order all produce a plausible-looking shape that says something
 * false about a profile. So the coordinates are asserted **exactly**, against values that can
 * be worked out by hand:
 *
 *  - the centre is (120, 120) and the radius is 88, so the first axis — straight up — must land
 *    on (120, 32). If that moves, the chart has rotated.
 *  - a four-axis polygon at full value must be the diamond `120,32 208,120 120,208 32,120`,
 *    clockwise from the top. Both the direction of rotation and the SVG y-axis convention are
 *    pinned by that one string.
 *
 * The trig is only exact at multiples of a quarter turn, so the exact assertions live on
 * `polygonPoints` (which rounds on the way out) and on `polarPoint` at angle 0, while the other
 * quarter turns are checked to a tolerance.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  axisAngle,
  axisLabelAnchor,
  axisMarker,
  clampUnit,
  polarPoint,
  polygonPoints,
  RADAR_CENTRE,
  RADAR_DEFAULT_GEOMETRY,
  RADAR_LABEL_GUTTER,
  RADAR_LABEL_RADIUS,
  RADAR_RADIUS,
  RADAR_RING_FRACTIONS,
  RADAR_VIEWBOX,
  radarViewBox,
  ringPoints,
  roundCoordinate,
  summariseAxes,
} from '../src/radar.ts';

const TOLERANCE = 1e-9;

function assertClose(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < TOLERANCE, `${what}: expected ${expected}, got ${actual}`);
}

describe('the chart frame', () => {
  it('is centred in its own square, with the label ring outside the value ring', () => {
    assert.equal(RADAR_CENTRE * 2, RADAR_VIEWBOX);
    assert.ok(RADAR_RADIUS < RADAR_LABEL_RADIUS, 'labels must sit outside the ring they annotate');
    assert.ok(RADAR_LABEL_RADIUS < RADAR_CENTRE, 'the label ring must fit inside the box');
  });

  it('has three reference rings, the outermost of which is the boundary', () => {
    assert.equal(RADAR_RING_FRACTIONS.length, 3);
    assert.equal(RADAR_RING_FRACTIONS.at(-1), 1);
  });

  it('widens the window for word labels instead of moving the chart', () => {
    assert.equal(radarViewBox(0), '0 0 240 240');
    assert.equal(radarViewBox(), '0 0 240 240');
    assert.equal(radarViewBox(RADAR_LABEL_GUTTER), '-64 0 368 240');
    // The centre must stay where the geometry puts it, whichever window is used.
    assert.equal(polygonPoints([1]), '120,32');
  });

  it('ignores a nonsensical gutter rather than emitting a broken viewBox', () => {
    assert.equal(radarViewBox(-40), '0 0 240 240');
    assert.equal(radarViewBox(Number.NaN), '0 0 240 240');
  });
});

describe('axisAngle', () => {
  it('starts straight up and goes round once', () => {
    assert.equal(axisAngle(0, 16), 0);
    assert.equal(axisAngle(4, 16), Math.PI / 2);
    assert.equal(axisAngle(8, 16), Math.PI);
    assert.equal(axisAngle(16, 16), 2 * Math.PI);
  });

  it('divides the circle evenly', () => {
    assert.equal(axisAngle(1, 4), Math.PI / 2);
    assert.equal(axisAngle(1, 2), Math.PI);
    assertClose(axisAngle(1, 16), Math.PI / 8, 'one sixteenth');
  });

  it('has no angle to give when there are no axes', () => {
    // Rather than dividing by zero and sending Infinity into a coordinate.
    assert.equal(axisAngle(0, 0), 0);
    assert.equal(axisAngle(3, -1), 0);
    assert.equal(axisAngle(Number.NaN, 16), 0);
  });
});

describe('polarPoint', () => {
  it('places angle zero straight up, exactly', () => {
    assert.deepEqual(polarPoint(120, 120, 88, 0), { x: 120, y: 32 });
    assert.deepEqual(polarPoint(0, 0, 10, 0), { x: 0, y: -10 });
  });

  it('goes clockwise: a quarter turn is to the right, three quarters to the left', () => {
    const right = polarPoint(120, 120, 88, Math.PI / 2);
    assertClose(right.x, 208, 'quarter turn x');
    assertClose(right.y, 120, 'quarter turn y');

    const down = polarPoint(120, 120, 88, Math.PI);
    assertClose(down.x, 120, 'half turn x');
    assertClose(down.y, 208, 'half turn y');

    const left = polarPoint(120, 120, 88, (3 * Math.PI) / 2);
    assertClose(left.x, 32, 'three quarter turn x');
    assertClose(left.y, 120, 'three quarter turn y');
  });

  it('collapses to the centre at radius zero', () => {
    assert.deepEqual(polarPoint(60, 70, 0, 1.234), { x: 60, y: 70 });
  });
});

describe('polygonPoints', () => {
  it('draws the full diamond for four axes at full value', () => {
    assert.equal(polygonPoints([1, 1, 1, 1]), '120,32 208,120 120,208 32,120');
  });

  it('draws a single point at the centre when every value is zero', () => {
    assert.equal(polygonPoints([0, 0, 0]), '120,120 120,120 120,120');
  });

  it('scales each axis independently', () => {
    // Half value on the first axis is halfway between the centre and (120, 32).
    assert.equal(polygonPoints([0.5, 0, 0, 0]), '120,76 120,120 120,120 120,120');
  });

  it('clamps out-of-range values instead of drawing outside the ring', () => {
    assert.equal(polygonPoints([2, 2, 2, 2]), polygonPoints([1, 1, 1, 1]));
    assert.equal(polygonPoints([-1, -1, -1]), polygonPoints([0, 0, 0]));
    assert.equal(polygonPoints([Number.NaN, 1, 1, 1]), polygonPoints([0, 1, 1, 1]));
  });

  it('honours a supplied geometry', () => {
    const points = polygonPoints([1, 1], { centreX: 50, centreY: 50, radius: 10 });
    assert.equal(points, '50,40 50,60');
  });

  it('emits nothing for no axes', () => {
    assert.equal(polygonPoints([]), '');
  });

  it('rounds to two decimals, so a server render and a client render are byte-identical', () => {
    const points = polygonPoints([1, 1, 1], RADAR_DEFAULT_GEOMETRY);
    for (const pair of points.split(' ')) {
      for (const number of pair.split(',')) {
        const decimals = number.split('.')[1] ?? '';
        assert.ok(decimals.length <= 2, `too much precision in ${number}`);
      }
    }
  });

  it('is deterministic', () => {
    const values = [0.42, 0.78, 0.13, 0.9, 0.5, 0.61];
    assert.equal(polygonPoints(values), polygonPoints(values));
  });
});

describe('ringPoints', () => {
  it('is the value polygon with every axis at the same fraction', () => {
    assert.equal(ringPoints(4, 1), polygonPoints([1, 1, 1, 1]));
    assert.equal(ringPoints(3, 0.5), polygonPoints([0.5, 0.5, 0.5]));
  });

  it('puts the inner ring a third of the way out', () => {
    // 88 / 3 = 29.333…, so the top corner sits at 120 - 29.33.
    const [first] = ringPoints(4, 1 / 3).split(' ');
    assert.equal(first, '120,90.67');
  });

  it('draws sixteen corners for a sixteen-axis chart', () => {
    assert.equal(ringPoints(16, 1).split(' ').length, 16);
  });

  it('has nothing to draw without axes', () => {
    assert.equal(ringPoints(0, 1), '');
    assert.equal(ringPoints(-4, 1), '');
    assert.equal(ringPoints(Number.NaN, 1), '');
  });
});

describe('axisLabelAnchor', () => {
  it('centres the labels at the top and bottom', () => {
    assert.equal(axisLabelAnchor(0), 'middle');
    assert.equal(axisLabelAnchor(Math.PI), 'middle');
  });

  it('hangs a label away from the chart on each side', () => {
    assert.equal(axisLabelAnchor(Math.PI / 2), 'start');
    assert.equal(axisLabelAnchor((3 * Math.PI) / 2), 'end');
  });

  it('keeps a near-vertical axis centred rather than nudged sideways', () => {
    assert.equal(axisLabelAnchor(axisAngle(0, 16)), 'middle');
    assert.equal(axisLabelAnchor(axisAngle(4, 16)), 'start');
    assert.equal(axisLabelAnchor(axisAngle(12, 16)), 'end');
  });
});

describe('clampUnit and roundCoordinate', () => {
  it('clamps a value into the drawable range', () => {
    assert.equal(clampUnit(0.42), 0.42);
    assert.equal(clampUnit(0), 0);
    assert.equal(clampUnit(1), 1);
    assert.equal(clampUnit(1.4), 1);
    assert.equal(clampUnit(-0.2), 0);
    assert.equal(clampUnit(Number.NaN), 0);
    assert.equal(clampUnit(Number.POSITIVE_INFINITY), 0);
  });

  it('rounds to two decimals and never emits a non-finite coordinate', () => {
    assert.equal(roundCoordinate(29.333333), 29.33);
    assert.equal(roundCoordinate(120), 120);
    assert.equal(roundCoordinate(Number.NaN), 0);
    assert.equal(roundCoordinate(Number.POSITIVE_INFINITY), 0);
  });
});

describe('axisMarker', () => {
  it('numbers axes from one, padded to two digits', () => {
    assert.equal(axisMarker(0), '01');
    assert.equal(axisMarker(8), '09');
    assert.equal(axisMarker(15), '16');
  });
});

describe('summariseAxes', () => {
  const axes = [
    { label: 'Aggression', value: 0.82 },
    { label: 'Bluffing', value: 0.31 },
    { label: 'Folds under pressure', value: 0.14 },
  ];

  it('states the count, the average and both extremes', () => {
    assert.equal(
      summariseAxes(axes),
      'Trait radar over 3 trait axes on a 0 to 1 scale, averaging 0.42. ' +
        'Highest: Aggression at 0.82. Lowest: Folds under pressure at 0.14.',
    );
  });

  it('says so when there are no axes at all', () => {
    assert.equal(summariseAxes([]), 'Trait radar with no axes reported.');
  });

  it('reports unreadable values rather than inventing a shape', () => {
    const broken = [{ label: 'Aggression', value: Number.NaN }];
    assert.equal(
      summariseAxes(broken),
      'Trait radar over 1 trait axis, none of which reported a readable value.',
    );
  });

  it('ignores unreadable axes when averaging the rest', () => {
    const mixed = [
      { label: 'Aggression', value: 0.5 },
      { label: 'Bluffing', value: Number.NaN },
      { label: 'Risk appetite', value: 0.3 },
    ];
    const text = summariseAxes(mixed);
    assert.ok(text.includes('averaging 0.40'), text);
    assert.ok(text.includes('Highest: Aggression at 0.50'), text);
    assert.ok(text.includes('Lowest: Risk appetite at 0.30'), text);
  });

  it('never implies that a high value is a good one', () => {
    // The trait vocabulary describes style, not quality: a high `foldToPressure` is not a
    // virtue, and the summary must not smuggle a judgement in.
    const forbidden = ['best', 'worst', 'strongest', 'weakest', 'good', 'bad', 'better', 'optimal'];
    const text = summariseAxes(axes).toLowerCase();
    for (const word of forbidden) {
      assert.ok(!text.includes(word), `"${word}" appeared in a radar summary: ${text}`);
    }
  });

  it('breaks a tie towards the first axis, so the sentence is stable', () => {
    const tied = [
      { label: 'First', value: 0.5 },
      { label: 'Second', value: 0.5 },
    ];
    const text = summariseAxes(tied);
    assert.ok(text.includes('Highest: First'), text);
    assert.ok(text.includes('Lowest: First'), text);
  });
});
