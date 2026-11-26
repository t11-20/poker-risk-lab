/**
 * The radar chart's geometry and its spoken summary. A rotated or flipped radar still looks plausible,
 * so coordinates are asserted exactly against hand-worked values. Centre (120, 120), radius 88, the
 * first axis at (120, 32), and a full four-axis polygon is `120,32 208,120 120,208 32,120` (clockwise).
 * Trig is exact only at quarter turns, so other angles are checked to a tolerance.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  axisAngle,
  axisLabelAnchor,
  axisMarker,
  clampUnit,
  outwardUnit,
  polarPoint,
  polygonPoints,
  RADAR_CENTRE,
  RADAR_DEFAULT_GEOMETRY,
  RADAR_LABEL_GUTTER,
  RADAR_LABEL_MIN_GAP,
  RADAR_LABEL_RADIUS,
  RADAR_MARKER_WIDTH_EM,
  RADAR_RADIUS,
  RADAR_RING_FRACTIONS,
  RADAR_VIEWBOX,
  RADAR_WORD_WIDTH_EM,
  radarLabelRoom,
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
    assert.equal(polygonPoints([1]), '120,32');
  });

  it('ignores a nonsensical gutter rather than emitting a broken viewBox', () => {
    assert.equal(radarViewBox(-40), '0 0 240 240');
    assert.equal(radarViewBox(Number.NaN), '0 0 240 240');
  });
});

/** What Chrome drew for a two-digit marker, in em: glyph width, and reach either side of centre. */
const MEASURED_MARKER = { width: 1.17, halfHeight: 0.58 };

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Where each marker's glyphs land on a chart of `count` axes, anchored as `RadarChart` anchors them. */
function markerBoxes(count: number, labelSize: number, labelRadius: number): Box[] {
  const width = MEASURED_MARKER.width * labelSize;
  const half = MEASURED_MARKER.halfHeight * labelSize;
  const boxes: Box[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = axisAngle(index, count);
    const at = polarPoint(RADAR_CENTRE, RADAR_CENTRE, labelRadius, angle);
    const anchor = axisLabelAnchor(angle);
    const left = anchor === 'start' ? at.x : anchor === 'end' ? at.x - width : at.x - width / 2;
    boxes.push({ left, right: left + width, top: at.y - half, bottom: at.y + half });
  }
  return boxes;
}

/** The nearest any glyph comes to the centre, which must stay outside the outer ring. */
function nearestToCentre(box: Box): number {
  const x = Math.max(box.left, Math.min(RADAR_CENTRE, box.right));
  const y = Math.max(box.top, Math.min(RADAR_CENTRE, box.bottom));
  return Math.hypot(x - RADAR_CENTRE, y - RADAR_CENTRE);
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Every way a marker can fail at one label size, as sentences, so a failure names the size and the axis. */
function markerFaults(labelSize: number, room: { plotRadius: number; labelRadius: number }): string[] {
  const faults: string[] = [];
  for (const count of [5, 8, 16]) {
    const boxes = markerBoxes(count, labelSize, room.labelRadius);
    for (const [index, box] of boxes.entries()) {
      const where = `${labelSize}px label, axis ${index + 1} of ${count}`;
      if (box.left < 0 || box.top < 0 || box.right > RADAR_VIEWBOX || box.bottom > RADAR_VIEWBOX) {
        faults.push(`${where} leaves the viewBox`);
      }
      if (nearestToCentre(box) < room.plotRadius + RADAR_LABEL_MIN_GAP) {
        faults.push(`${where} comes within ${RADAR_LABEL_MIN_GAP} of the outer ring`);
      }
      const next = boxes[(index + 1) % count];
      if (next !== undefined && next !== box && overlaps(box, next))
        faults.push(`${where} overlaps the next`);
    }
  }
  return faults;
}

describe('the room labels take from the plot', () => {
  it('is no room at all at the default 12px label, so default text draws the chart unchanged', () => {
    for (const [width, gutter] of [
      [RADAR_MARKER_WIDTH_EM, 0],
      [RADAR_WORD_WIDTH_EM, RADAR_LABEL_GUTTER],
      [0, 0],
    ] as const) {
      const room = radarLabelRoom(12, width, gutter);
      assert.equal(room.plotRadius, RADAR_RADIUS);
      assert.equal(room.labelRadius, RADAR_LABEL_RADIUS);
    }
  });

  // Past 200% sixteen markers touch their diagonal neighbours: a 240-unit window has no wider ring to give.
  it('keeps every marker inside the window, clear of the ring and of its neighbour, up to 200% text', () => {
    for (let labelSize = 12; labelSize <= 24; labelSize += 0.25) {
      assert.deepEqual(markerFaults(labelSize, radarLabelRoom(labelSize, RADAR_MARKER_WIDTH_EM)), []);
    }
  });

  it('is what the fixed geometry lacked: at 150% text its markers already left the window', () => {
    const fixed = { plotRadius: RADAR_RADIUS, labelRadius: RADAR_LABEL_RADIUS };
    assert.deepEqual(markerFaults(12, fixed), []);
    assert.ok(markerFaults(18, fixed).some((fault) => fault.endsWith('leaves the viewBox')));
    assert.ok(markerFaults(24, fixed).some((fault) => fault.endsWith('of the outer ring')));
  });

  it('shrinks the plot by about a fifth at 200% text, so the chart is still a chart', () => {
    const { plotRadius } = radarLabelRoom(24, RADAR_MARKER_WIDTH_EM);
    assert.ok(plotRadius / RADAR_RADIUS > 0.75, `the plot is ${plotRadius} of ${RADAR_RADIUS}`);
    assert.ok(plotRadius < RADAR_RADIUS);
  });

  it('never grows the plot past its default, even for labels smaller than the default', () => {
    assert.deepEqual(radarLabelRoom(9, RADAR_MARKER_WIDTH_EM), {
      plotRadius: RADAR_RADIUS,
      labelRadius: RADAR_LABEL_RADIUS,
    });
  });

  it('gives word labels the gutter, and stops shrinking at half the plot', () => {
    assert.ok(radarLabelRoom(18, RADAR_WORD_WIDTH_EM, RADAR_LABEL_GUTTER).plotRadius > RADAR_RADIUS / 2);
    assert.equal(radarLabelRoom(24, RADAR_WORD_WIDTH_EM, RADAR_LABEL_GUTTER).plotRadius, RADAR_RADIUS / 2);
  });

  it('moves each label straight away from the centre', () => {
    for (let index = 0; index < 16; index += 1) {
      const angle = axisAngle(index, 16);
      const away = outwardUnit(angle);
      const at = polarPoint(RADAR_CENTRE, RADAR_CENTRE, RADAR_LABEL_RADIUS, angle);
      assert.ok(Math.abs(Math.hypot(away.x, away.y) - 1) < 1e-4, `axis ${index} is not a unit vector`);
      const along = (away.x * (at.x - RADAR_CENTRE) + away.y * (at.y - RADAR_CENTRE)) / RADAR_LABEL_RADIUS;
      assert.ok(Math.abs(along - 1) < 1e-4, `axis ${index} does not point away from the centre`);
    }
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
    // Traits describe style, not quality. A high `foldToPressure` is not a virtue.
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
