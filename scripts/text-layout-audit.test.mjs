#!/usr/bin/env node
/**
 * Tests for `findTextDefects()` and its thresholds. `collapsedCoachRow()` is Chrome's real
 * measurement of the shipped defect; `healthyRow()` and `neighbouringLines()` are the controls that
 * must not fire. Scans also assert on how much they examined.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONTROLS,
  clippedRects,
  colorAlpha,
  coverageFailures,
  drawnEdges,
  EXEMPTIONS,
  escapeAmount,
  findTextDefects,
  fontSizesFor,
  formatFinding,
  frameSides,
  intersection,
  isRealOverlap,
  nearestFrame,
  parseArgs,
  ROUTES,
  sweepMatrix,
  THEMES,
  WIDTHS,
} from './text-layout-audit.mjs';

let nextIndex = 0;

function box(overrides = {}) {
  nextIndex += 2;
  const rects = overrides.rects ?? [{ x: 0, y: 0, w: 100, h: 16 }];
  const pad = overrides.pad ?? { x: 0, y: 0, w: 100, h: 16 };
  return {
    i: overrides.i ?? nextIndex,
    end: overrides.end ?? (overrides.i ?? nextIndex) + 1,
    sel: overrides.sel ?? 'div > p',
    tag: overrides.tag ?? 'p',
    text: overrides.text ?? 'some text',
    rects,
    pad,
    content: overrides.content ?? pad,
    word: overrides.word ?? { text: 'text', width: 30 },
    flow: overrides.flow ?? -1,
    layer: overrides.layer ?? -1,
    scrollHost: overrides.scrollHost ?? null,
    blockScrolls: overrides.blockScrolls ?? false,
    ellipsis: overrides.ellipsis ?? false,
    exempt: overrides.exempt ?? [],
  };
}

function measurement(boxes, extra = {}) {
  return {
    heading: extra.heading ?? 'six-handed table',
    boxes,
    clippers: extra.clippers ?? [],
    frames: extra.frames ?? [],
    page: extra.page ?? { scrollWidth: 1440, clientWidth: 1440, innerWidth: 1440, rootFontSize: 16 },
    counts: {
      scanned: 900,
      textBoxes: boxes.length,
      textNodes: boxes.length,
      words: boxes.length * 3,
      clippers: (extra.clippers ?? []).length,
    },
    skipped: { ariaHidden: 0, visuallyHidden: 0, invisible: 0, offscreen: 0, inert: 0 },
  };
}

/** Chrome's measurement of `/play?state=decision`, dark, 1440px, with the defect present. */
function collapsedCoachRow() {
  const label = box({
    i: 100,
    end: 101,
    sel: 'div.prl-stat > dl.prl-stat__pair > dt.prl-stat__label.prl-label',
    tag: 'dt',
    text: 'Pot and price',
    rects: [
      { x: 1034, y: 1183.95, w: 29.02, h: 16 },
      { x: 1034, y: 1200.84, w: 30.81, h: 16 },
      { x: 1034, y: 1217.73, w: 42.25, h: 16 },
    ],
    pad: { x: 1034, y: 1183.95, w: 0, h: 50.67 },
    content: { x: 1034, y: 1183.95, w: 0, h: 50.67 },
    word: { text: 'price', width: 42.25 },
  });
  const value = box({
    i: 102,
    end: 103,
    sel: 'dl.prl-stat__pair > dd.prl-stat__value > span',
    tag: 'span',
    text: '100 units in the middle, 35 units to call',
    rects: [
      { x: 1053.8, y: 1183.95, w: 236.2, h: 16 },
      { x: 1149.4, y: 1200.84, w: 140.6, h: 16 },
    ],
    pad: { x: 1034, y: 1183.95, w: 256, h: 33.78 },
    content: { x: 1034, y: 1183.95, w: 256, h: 33.78 },
    word: { text: 'middle,', width: 58.05 },
  });
  return measurement([label, value]);
}

function healthyRow() {
  const label = box({
    i: 100,
    end: 101,
    sel: 'div.prl-stat > dl.prl-stat__pair > dt.prl-stat__label.prl-label',
    tag: 'dt',
    text: 'Pot and price',
    rects: [{ x: 1034, y: 1183.95, w: 96.08, h: 16 }],
    pad: { x: 1034, y: 1183.95, w: 256, h: 16 },
    content: { x: 1034, y: 1183.95, w: 256, h: 16 },
    word: { text: 'price', width: 42.25 },
  });
  const value = box({
    i: 102,
    end: 103,
    sel: 'dl.prl-stat__pair > dd.prl-stat__value > span',
    tag: 'span',
    text: '100 units in the middle, 35 units to call',
    rects: [
      { x: 1034, y: 1207.95, w: 235.22, h: 16 },
      { x: 1034, y: 1224.84, w: 140.6, h: 16 },
    ],
    pad: { x: 1034, y: 1207.95, w: 256, h: 33.78 },
    content: { x: 1034, y: 1207.95, w: 256, h: 33.78 },
    word: { text: 'middle,', width: 58.05 },
  });
  return measurement([label, value]);
}

/** Two correct lines crossing by 1.4px, the `/legends` false positive that set `OVERLAP_MIN_HEIGHT_SHARE`. */
function neighbouringLines() {
  return measurement([
    box({
      i: 10,
      end: 11,
      sel: 'article > h2',
      text: 'Adaptive exploiter',
      rects: [{ x: 40, y: 200, w: 180, h: 21 }],
      pad: { x: 40, y: 200, w: 400, h: 21 },
      content: { x: 40, y: 200, w: 400, h: 21 },
    }),
    box({
      i: 12,
      end: 13,
      sel: 'article > p',
      text: 'Plays the reader rather than the cards.',
      rects: [{ x: 40, y: 219.6, w: 300, h: 21 }],
      pad: { x: 40, y: 219.6, w: 400, h: 21 },
      content: { x: 40, y: 219.6, w: 400, h: 21 },
    }),
  ]);
}

// ---------------------------------------------------------------------------

describe('the collapsed Coach row, as Chrome measured it (REGRESSION)', () => {
  const { findings, counts } = findTextDefects(collapsedCoachRow(), {
    route: '/play?state=decision',
    theme: 'dark',
    width: 1440,
  });

  it('reports the collapsed column as squeezed, with the arithmetic', () => {
    const squeezed = findings.find((finding) => finding.check === 'squeezed');
    assert.ok(squeezed !== undefined, `no squeezed finding in ${JSON.stringify(findings)}`);
    assert.match(squeezed.sel, /prl-stat__label/u);
    assert.equal(squeezed.word, 'price');
    assert.equal(squeezed.has, 0);
    assert.equal(squeezed.needs, 42.25);
  });

  it('reports the glyphs painted outside their own box', () => {
    const escapes = findings.find((finding) => finding.check === 'escapes');
    assert.ok(escapes !== undefined, 'the label paints 42px outside a 0px column and was not caught');
    assert.equal(escapes.side, 'right');
    assert.equal(escapes.past, 42.25);
  });

  it('reports the sentence painted across the label, with the measured overlap', () => {
    const collision = findings.find((finding) => finding.check === 'collision');
    assert.ok(collision !== undefined, 'the glyph collision the user reported was not caught');
    assert.equal(collision.area, 147.52);
    assert.equal(collision.dy, 16);
    assert.ok(
      [collision.sel, collision.other].some((sel) => /prl-stat__value/u.test(sel)),
      'the finding must name the element whose text did the painting',
    );
  });

  it('carries the route, theme and width into every finding', () => {
    for (const finding of findings) {
      assert.equal(finding.route, '/play?state=decision');
      assert.equal(finding.theme, 'dark');
      assert.equal(finding.width, 1440);
      assert.ok(formatFinding(finding).includes('1440px'));
    }
  });

  it('says how much it examined, so a clean result cannot mean an empty scan', () => {
    assert.equal(counts.ownBox, 2);
    assert.equal(counts.pairs, 1);
  });
});

describe('a bounding-box probe would have reported this row as clear (REGRESSION)', () => {
  it('the two elements own boxes do not intersect at all', () => {
    // The label's box is 0px wide, so no box comparison can see this. Only the glyphs overlap.
    const { boxes } = collapsedCoachRow();
    const [label, value] = boxes;
    const hit = intersection(label.pad, value.pad);
    assert.equal(hit.area, 0, 'the boxes must NOT overlap; if they did this fixture is not the defect');
    const glyphs = intersection(label.rects[0], value.rects[0]);
    assert.ok(glyphs.area > 100, `the glyphs must overlap: ${JSON.stringify(glyphs)}`);
  });
});

describe('a correctly laid out row', () => {
  it('produces no findings, and says it looked at something', () => {
    const { findings, counts } = findTextDefects(healthyRow(), {
      route: '/play?state=decision',
      theme: 'dark',
      width: 1440,
    });
    assert.deepEqual(findings, [], `a healthy row must be clean: ${JSON.stringify(findings, null, 2)}`);
    assert.equal(counts.ownBox, 2, 'both blocks must have been measured against their own box');
    // No pair is compared: the vertical early exit skips them. `neighbouringLines` covers a real pair.
    assert.equal(counts.pairs, 0);
  });

  it('does not fire on two stacked lines whose glyph boxes cross by a pixel (FALSE POSITIVE)', () => {
    const { findings, counts } = findTextDefects(neighbouringLines(), {});
    assert.deepEqual(
      findings.map((finding) => finding.check),
      [],
      'tight leading makes adjacent lines cross; that is type, not a collision',
    );
    assert.equal(counts.pairs, 1);
  });

  it('fires when the same two lines cross by a third of their height instead', () => {
    const overlapping = neighbouringLines();
    overlapping.boxes[1].rects[0].y = 207;
    const { findings } = findTextDefects(overlapping, {});
    assert.deepEqual(
      findings.map((finding) => finding.check),
      ['collision'],
    );
  });
});

/**
 * `header > .prl-mark` owns two text nodes painted at y=300 then y=180. Sorted by `rects[0].y` the
 * scan breaks before comparing it with the paragraph at y=200.
 */
function rectsOutOfOrder() {
  return measurement([
    box({
      i: 10,
      end: 11,
      sel: 'header > span.prl-mark',
      text: 'Pot and price',
      rects: [
        { x: 40, y: 300, w: 60, h: 16 },
        { x: 40, y: 180, w: 120, h: 30 },
      ],
      pad: { x: 40, y: 180, w: 400, h: 136 },
      content: { x: 40, y: 180, w: 400, h: 136 },
    }),
    box({
      i: 12,
      end: 13,
      sel: 'header > p',
      text: '100 units in the middle, 35 units to call',
      rects: [{ x: 40, y: 200, w: 300, h: 21 }],
      pad: { x: 40, y: 200, w: 400, h: 21 },
      content: { x: 40, y: 200, w: 400, h: 21 },
    }),
  ]);
}

describe('the collision scan cannot stop early and call it clean (REGRESSION)', () => {
  it('compares a pair whose first rectangle is not its topmost one', () => {
    const { findings, counts } = findTextDefects(rectsOutOfOrder(), {});
    assert.equal(counts.pairs, 1, 'the pair was never compared; the scan stopped early');
    assert.deepEqual(
      findings.map((finding) => finding.check),
      ['collision'],
    );
  });

  it('the OLD sort key would have skipped it, which is why this fixture exists', () => {
    // The discarded `rects[0].y` ordering, to show the bug rather than only assert the fix.
    const { boxes } = rectsOutOfOrder();
    const byFirstRect = [...boxes].sort((a, b) => a.rects[0].y - b.rects[0].y);
    const lowest = Math.max(...byFirstRect[0].rects.map((r) => r.y + r.h));
    assert.equal(byFirstRect[0].sel, 'header > p', 'the paragraph must sort first under the old key');
    assert.ok(
      byFirstRect[1].rects[0].y > lowest,
      'the old key must trigger the early exit here, or this fixture proves nothing',
    );
    const topOf = (b) => Math.min(...b.rects.map((r) => r.y));
    const byTop = [...boxes].sort((a, b) => topOf(a) - topOf(b));
    assert.equal(byTop[0].sel, 'header > span.prl-mark');
    assert.ok(topOf(byTop[1]) <= Math.max(...byTop[0].rects.map((r) => r.y + r.h)));
  });
});

describe('what is NOT a defect', () => {
  it('ignores two elements in different positioned layers (deliberately stacked)', () => {
    const stacked = collapsedCoachRow();
    stacked.boxes[1].flow = 50; // the value sits in a positioned layer the label does not
    const { findings } = findTextDefects(stacked, {});
    assert.ok(
      !findings.some((finding) => finding.check === 'collision'),
      'two elements in different layers overlap on purpose',
    );
    assert.ok(
      findings.some((finding) => finding.check === 'squeezed'),
      'the collapsed column is still a collapsed column',
    );
  });

  it('ignores an ancestor overlapping its own descendant', () => {
    const nested = collapsedCoachRow();
    nested.boxes[0].i = 99;
    nested.boxes[0].end = 200; // now an ancestor of the value
    const { findings } = findTextDefects(nested, {});
    assert.ok(!findings.some((finding) => finding.check === 'collision'));
  });

  it('ignores content wider than a block that scrolls horizontally', () => {
    const scroller = collapsedCoachRow();
    scroller.boxes[0].blockScrolls = true;
    const { findings, counts } = findTextDefects(scroller, {});
    assert.ok(!findings.some((finding) => finding.check === 'squeezed'));
    assert.ok(!findings.some((finding) => finding.check === 'escapes'));
    assert.equal(counts.scrollExcused, 1);
  });

  it('does NOT excuse a collapsed column because some ancestor scrolls (REGRESSION)', () => {
    // A scrolling ancestor must not excuse a zero-width column. The Coach rail has one.
    const inRail = collapsedCoachRow();
    inRail.boxes[0].scrollHost = 374;
    const { findings } = findTextDefects(inRail, {});
    assert.ok(findings.some((finding) => finding.check === 'squeezed'));
  });

  it('ignores text truncated on purpose with an ellipsis', () => {
    const truncated = collapsedCoachRow();
    truncated.boxes[0].ellipsis = true;
    const { findings, counts } = findTextDefects(truncated, {});
    assert.ok(!findings.some((finding) => finding.check === 'escapes'));
    assert.equal(counts.ellipsisExcused, 1);
  });

  it('absorbs the letter-space a tracked uppercase label adds after its last glyph', () => {
    // Measured 0.96px on `.prl-stat__unit` at 12px/0.08em, on a correct row.
    const tracked = healthyRow();
    tracked.boxes[0].rects[0].w = tracked.boxes[0].pad.w + 0.96;
    const { findings } = findTextDefects(tracked, {});
    assert.deepEqual(findings, []);
  });
});

describe('text cut off by an ancestor that hides overflow', () => {
  const clipped = () =>
    measurement(
      [
        box({
          i: 20,
          end: 21,
          sel: 'header > h1',
          text: 'The curriculum',
          rects: [{ x: 40, y: 100, w: 145.33, h: 40 }],
          pad: { x: 40, y: 100, w: 145.33, h: 40 },
          content: { x: 40, y: 100, w: 145.33, h: 40 },
          word: { text: 'curriculum', width: 100 },
        }),
      ],
      {
        clippers: [
          { i: 19, end: 40, sel: 'header.prl-learn-page__head', pad: { x: 40, y: 90, w: 90, h: 60 } },
        ],
      },
    );

  it('reports the glyphs beyond the clip, and names the ancestor doing it', () => {
    const { findings, counts } = findTextDefects(clipped(), {});
    const finding = findings.find((f) => f.check === 'clipped');
    assert.ok(finding !== undefined, `nothing reported: ${JSON.stringify(findings)}`);
    assert.equal(finding.past, 55.33);
    assert.match(finding.clipper, /prl-learn-page__head/u);
    assert.equal(counts.clipTests, 1);
  });

  it('says nothing when the text fits inside the clip', () => {
    const fits = clipped();
    fits.clippers[0].pad.w = 300;
    const { findings, counts } = findTextDefects(fits, {});
    assert.deepEqual(findings, []);
    assert.equal(counts.clipTests, 1, 'the test must have been performed and passed, not skipped');
  });

  it('says nothing about text that is not inside the clipper at all', () => {
    const elsewhere = clipped();
    elsewhere.boxes[0].i = 90;
    elsewhere.boxes[0].end = 91;
    const { findings, counts } = findTextDefects(elsewhere, {});
    assert.deepEqual(findings, []);
    assert.equal(counts.clipTests, 0);
  });
});

/**
 * The `bordered-spill` control as Chrome measured it at 1440px: a 480px paragraph inside a 200px
 * banner. Its glyphs stay inside the paragraph's own box, so only the banner's border is crossed.
 */
function spilledBanner() {
  return measurement(
    [
      box({
        i: 31,
        end: 32,
        sel: 'main > div.prl-legal__banner > p',
        text: 'Passages carrying this marker are placeholders written by the people who built t',
        rects: [
          { x: 438.11, y: 509.95, w: 430.22, h: 17 },
          { x: 438.11, y: 533.95, w: 475.95, h: 17 },
          { x: 438.11, y: 629.95, w: 174.5, h: 17 },
        ],
        pad: { x: 438.11, y: 506.95, w: 480, h: 144 },
        content: { x: 438.11, y: 506.95, w: 480, h: 144 },
      }),
    ],
    {
      frames: [
        { i: 30, end: 33, sel: 'main > div.prl-legal__banner', border: BANNER, left: true, right: true },
      ],
    },
  );
}
const BANNER = { x: 413.11, y: 450.45, w: 200, h: 225.5 };

describe('text painted across the frame drawn around it', () => {
  it('reports the glyphs past the border, and names the box that drew it', () => {
    const { findings, counts } = findTextDefects(spilledBanner(), {
      route: '/terms',
      theme: 'dark',
      width: 1440,
    });
    assert.deepEqual(
      findings.map((f) => f.check),
      ['spills'],
      'the paragraph fits its own box, so nothing but the frame can see this',
    );
    assert.equal(findings[0].side, 'right');
    assert.equal(findings[0].past, 300.95);
    assert.match(findings[0].frame, /prl-legal__banner$/u);
    assert.match(formatFinding(findings[0]), /SPILLS .*\n.*300\.95px past the right edge drawn by/u);
    assert.equal(counts.frameTests, 1);
  });

  it('says nothing when the glyphs stay inside, or cross an edge the frame does not draw', () => {
    const fits = spilledBanner();
    fits.frames[0].border = { ...BANNER, w: 560 };
    assert.deepEqual(findTextDefects(fits, {}).findings, []);
    assert.equal(findTextDefects(fits, {}).counts.frameTests, 1, 'measured and clear, not skipped');
    const leftOnly = spilledBanner();
    leftOnly.frames[0].right = false;
    assert.deepEqual(findTextDefects(leftOnly, {}).findings, []);
  });

  it('judges against the innermost frame only', () => {
    const nested = spilledBanner();
    nested.frames.push({
      i: 1,
      end: 90,
      sel: 'main',
      border: { x: 0, y: 0, w: 1440, h: 900 },
      left: true,
      right: true,
    });
    assert.equal(findTextDefects(nested, {}).findings[0]?.frame, 'main > div.prl-legal__banner');
    const inner = spilledBanner();
    inner.frames.push({ i: 31, end: 32, sel: 'p', border: inner.boxes[0].pad, left: true, right: true });
    assert.deepEqual(findTextDefects(inner, {}).findings, []);
  });

  it('excuses text in its own absolute layer, scrolled, clipped or truncated inside the frame', () => {
    for (const excuse of [
      (m) => Object.assign(m.boxes[0], { layer: 31 }),
      (m) => Object.assign(m.boxes[0], { scrollHost: 30 }),
      (m) => Object.assign(m.boxes[0], { ellipsis: true }),
      (m) => m.clippers.push({ i: 30, end: 33, sel: 'div', pad: BANNER }),
    ]) {
      const excused = spilledBanner();
      excuse(excused);
      const result = findTextDefects(excused, {});
      assert.ok(!result.findings.some((f) => f.check === 'spills'), JSON.stringify(result.findings));
    }
    const layered = spilledBanner();
    layered.boxes[0].layer = 30;
    assert.ok(
      findTextDefects(layered, {}).findings.some((f) => f.check === 'spills'),
      'the frame IS the layer',
    );
  });

  it('a clipper wider than the frame does not hide the spill (REGRESSION)', () => {
    const wide = spilledBanner();
    wide.clippers.push({ i: 31, end: 32, sel: 'p', pad: wide.boxes[0].pad });
    const result = findTextDefects(wide, {});
    assert.equal(result.findings.find((f) => f.check === 'spills')?.past, 300.95);
    const cut = clippedRects(wide.boxes[0].rects, [{ pad: { x: 500, y: 0, w: 100, h: 1 } }]);
    assert.deepEqual(
      cut.map((r) => [r.x, r.w]),
      [
        [500, 100],
        [500, 100],
        [500, 100],
      ],
    );
    assert.deepEqual(clippedRects(wide.boxes[0].rects, [{ pad: { x: 0, y: 0, w: 400, h: 1 } }]), []);
  });

  it('nearestFrame and drawnEdges are the parts the rule is built from', () => {
    const [text] = spilledBanner().boxes;
    assert.equal(nearestFrame(text, []), null);
    assert.equal(nearestFrame(text, [{ i: 40, end: 50 }]), null);
    const open = drawnEdges({ border: BANNER, left: false, right: true });
    assert.ok(Math.abs(open.x + open.w - 613.11) < 1e-6, 'the drawn right edge stays where it was');
    assert.ok(open.x < -1000);
  });
});

describe('which edges of a box a reader sees', () => {
  const edges = (overrides) => ({
    borderLeftWidth: '0px',
    borderLeftStyle: 'none',
    borderLeftColor: 'rgb(0, 0, 0)',
    borderRightWidth: '0px',
    borderRightStyle: 'none',
    borderRightColor: 'rgb(0, 0, 0)',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    ...overrides,
  });
  const solid = {
    borderLeftWidth: '1px',
    borderLeftStyle: 'solid',
    borderRightWidth: '1px',
    borderRightStyle: 'solid',
  };

  it('colorAlpha reads every form Chrome computes', () => {
    assert.equal(colorAlpha('rgb(20, 24, 31)'), 1);
    assert.equal(colorAlpha('rgba(0, 0, 0, 0)'), 0);
    assert.equal(colorAlpha('rgba(255, 255, 255, 0.06)'), 0.06);
    assert.equal(colorAlpha('rgb(20 24 31 / 0.5)'), 0.5);
    assert.equal(colorAlpha('color(srgb 1 1 1 / 40%)'), 0.4);
    assert.equal(colorAlpha('transparent'), 0);
  });

  it('a drawn border marks its side, and a hidden, zero or transparent one does not', () => {
    assert.deepEqual(frameSides(edges(solid), 'rgb(1, 1, 1)'), { left: true, right: true });
    assert.deepEqual(frameSides(edges({ ...solid, borderRightWidth: '0px' }), ''), {
      left: true,
      right: false,
    });
    assert.deepEqual(frameSides(edges({ ...solid, borderLeftStyle: 'hidden' }), ''), {
      left: false,
      right: true,
    });
    const clear = { borderLeftColor: 'rgba(0, 0, 0, 0)', borderRightColor: 'rgba(0, 0, 0, 0)' };
    assert.deepEqual(frameSides(edges({ ...solid, ...clear }), ''), { left: false, right: false });
  });

  it('a fill marks both sides only when it differs from the colour behind it', () => {
    const panel = edges({ backgroundColor: 'rgb(20, 24, 31)' });
    assert.deepEqual(frameSides(panel, 'rgb(12, 14, 18)'), { left: true, right: true });
    assert.deepEqual(frameSides(panel, 'rgb(20, 24, 31)'), { left: false, right: false });
    const veil = edges({ backgroundColor: 'rgba(255, 255, 255, 0.5)' });
    assert.deepEqual(
      frameSides(veil, 'rgba(255, 255, 255, 0.5)'),
      { left: true, right: true },
      'it composites',
    );
    assert.deepEqual(frameSides(edges({}), 'rgb(12, 14, 18)'), { left: false, right: false });
  });
});

describe('the page itself', () => {
  it('reports a document that scrolls sideways', () => {
    const wide = healthyRow();
    wide.page = { scrollWidth: 412, clientWidth: 360, innerWidth: 360, rootFontSize: 16 };
    const { findings } = findTextDefects(wide, { route: '/', theme: 'dark', width: 360 });
    const finding = findings.find((f) => f.check === 'page');
    assert.ok(finding !== undefined);
    assert.equal(finding.past, 52);
    assert.match(formatFinding(finding), /scrolls sideways/u);
  });

  it('reports 2px of sideways scroll, which the scenario link on /learn/counting-outs made (REGRESSION)', () => {
    const nudged = healthyRow();
    nudged.page = { scrollWidth: 362, clientWidth: 360, innerWidth: 360, rootFontSize: 16 };
    const { findings } = findTextDefects(nudged, {
      route: '/learn/counting-outs',
      theme: 'dark',
      width: 360,
    });
    assert.equal(findings.find((f) => f.check === 'page')?.past, 2);
  });
});

describe('exemptions', () => {
  const rules = [{ check: 'squeezed', selector: '.whatever', why: 'because' }];

  it('suppresses only the check they name, and only for the element that matched', () => {
    const withRule = collapsedCoachRow();
    withRule.boxes[0].exempt = [0];
    const { findings, usedExemptions } = findTextDefects(withRule, {}, rules);
    assert.ok(!findings.some((finding) => finding.check === 'squeezed'));
    assert.ok(
      findings.some((finding) => finding.check === 'escapes'),
      'an exemption for one check must not silence the others',
    );
    assert.deepEqual(usedExemptions, [0]);
  });

  it('a rule that matched nothing anywhere fails the gate (REGRESSION)', () => {
    const problems = coverageFailures(
      {
        measurements: 150,
        textBoxes: 34098,
        detector: { ownBox: 34028, clipTests: 4168, frameTests: 25211, pairs: 25744 },
        routesLoaded: 30,
        routesWanted: 30,
        usedExemptions: new Set(),
      },
      rules,
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /matched nothing/u);
  });

  it('the shipped list is empty, and every rule in it must carry a reason', () => {
    for (const rule of EXEMPTIONS) {
      assert.ok(typeof rule.selector === 'string' && rule.selector.length > 0);
      assert.ok(typeof rule.why === 'string' && rule.why.length > 30, 'an exemption needs a reason');
      assert.ok(
        ['collision', 'escapes', 'clipped', 'spills', 'squeezed', 'page', 'unscaled'].includes(rule.check),
      );
    }
  });
});

describe('a sweep of nothing is not a pass', () => {
  const healthy = {
    measurements: 150,
    textBoxes: 34098,
    detector: { ownBox: 34028, clipTests: 4168, frameTests: 25211, pairs: 25744 },
    routesLoaded: 30,
    routesWanted: 30,
    usedExemptions: new Set(),
  };

  it('a full sweep of this app clears every floor', () => {
    assert.deepEqual(coverageFailures(healthy, []), []);
  });

  it('refuses a run that measured almost nothing', () => {
    const problems = coverageFailures({ ...healthy, measurements: 2, textBoxes: 40 }, []);
    assert.equal(problems.length, 2);
    for (const problem of problems) assert.match(problem, /a sweep of nothing is not a pass/u);
  });

  it('refuses a run where a detector examined nothing, even with pages measured', () => {
    // A busy sweep with one detector out of the loop must still fail.
    for (const key of ['ownBox', 'clipTests', 'frameTests', 'pairs']) {
      const problems = coverageFailures({ ...healthy, detector: { ...healthy.detector, [key]: 0 } }, []);
      assert.equal(problems.length, 1, `${key} at zero must be reported`);
      assert.match(problems[0], /a detector that examined nothing/u);
    }
  });

  it('counts a detector missing from the tally as one that examined nothing', () => {
    const { frameTests: _, ...withoutFrames } = healthy.detector;
    const problems = coverageFailures({ ...healthy, detector: withoutFrames }, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /frame drawn around them/u);
  });

  it('refuses a run where a route never loaded', () => {
    const problems = coverageFailures({ ...healthy, routesLoaded: 28 }, []);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /2 route\(s\) never loaded/u);
  });
});

describe('geometry', () => {
  it('intersection is zero for rectangles that only touch', () => {
    assert.deepEqual(intersection({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), {
      dx: 0,
      dy: 0,
      area: 0,
    });
  });

  it('a real overlap needs area, width and a share of the height', () => {
    const a = { x: 0, y: 0, w: 100, h: 16 };
    assert.equal(isRealOverlap(intersection(a, { x: 0, y: 0, w: 100, h: 16 }), a, a), true);
    const grazing = { x: 0, y: 15, w: 100, h: 16 };
    assert.equal(isRealOverlap(intersection(a, grazing), a, grazing), false);
    const sliver = { x: 99, y: 0, w: 100, h: 16 };
    assert.equal(isRealOverlap(intersection(a, sliver), a, sliver), false);
  });

  it('escapeAmount reports the worst side and nothing when the text fits', () => {
    const inside = escapeAmount([{ x: 10, y: 0, w: 50, h: 16 }], { x: 0, y: 0, w: 100, h: 16 });
    assert.deepEqual(inside, { amount: 0, side: '' });
    const over = escapeAmount([{ x: 10, y: 0, w: 120, h: 16 }], { x: 0, y: 0, w: 100, h: 16 });
    assert.deepEqual(over, { amount: 30, side: 'right' });
    const under = escapeAmount([{ x: -12, y: 0, w: 50, h: 16 }], { x: 0, y: 0, w: 100, h: 16 });
    assert.deepEqual(under, { amount: 12, side: 'left' });
  });
});

describe('the scope of the sweep', () => {
  it('covers the five widths the brief names, both themes and every route', () => {
    for (const width of [360, 768, 1024, 1440, 1920]) {
      assert.ok(WIDTHS.includes(width), `${String(width)} is not swept`);
    }
    assert.deepEqual(THEMES, ['dark', 'light']);
    assert.ok(ROUTES.includes('/play?state=decision'), 'the route the defect was on must be swept');
    assert.ok(ROUTES.includes('/play?state=complete'));
    assert.ok(ROUTES.length >= 12, `only ${String(ROUTES.length)} route(s) are swept`);
  });

  it('the matrix is every combination, and a narrowed one is smaller', () => {
    const full = sweepMatrix(parseArgs([]));
    assert.equal(full.length, ROUTES.length * THEMES.length * WIDTHS.length);
    assert.ok(full.length >= 100, `${String(full.length)} measurements is not a sweep`);
    const narrow = sweepMatrix(parseArgs(['--routes', '/learn', '--widths', '360', '--themes', 'dark']));
    assert.deepEqual(narrow, [{ route: '/learn', theme: 'dark', width: 360 }]);
  });

  it('every check has a negative control that runs on every invocation', () => {
    const covered = new Set(CONTROLS.map((control) => control.expect));
    for (const check of ['collision', 'escapes', 'clipped', 'spills', 'squeezed', 'page', 'unscaled']) {
      assert.ok(covered.has(check), `${check} has no negative control, so nobody has seen it fire`);
    }
    for (const control of CONTROLS) {
      assert.ok(ROUTES.includes(control.route), `${control.id} runs on a route the gate does not sweep`);
      assert.ok(WIDTHS.includes(control.width));
      assert.match(control.css, /\{/u);
    }
    assert.match(CONTROLS[0].css, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/u);
    assert.equal(CONTROLS[0].route, '/play?state=decision');
  });
});

describe('the command line', () => {
  it('refuses combinations that would leave nothing to measure', () => {
    assert.throws(() => parseArgs(['--controls-only', '--no-self-test']), /nothing to run/u);
    assert.throws(() => parseArgs(['--themes', 'sepia']), /dark and light/u);
    assert.throws(() => parseArgs(['--widths', '10']), /at least 200/u);
    assert.throws(() => parseArgs(['--ready-timeout', '0']), /positive whole number/u);
    assert.throws(() => parseArgs(['--nonsense']), /unknown option/u);
    assert.throws(() => parseArgs(['--routes']), /needs a value/u);
  });

  it('self-test is on unless it is turned off', () => {
    assert.equal(parseArgs([]).selfTest, true);
    assert.equal(parseArgs(['--no-self-test']).selfTest, false);
  });
});

describe("the reader's text size", () => {
  it('is 1 unless asked, and takes Chrome sizes from 1 to 3', () => {
    assert.equal(parseArgs([]).textScale, 1);
    assert.equal(parseArgs(['--text-scale', '2']).textScale, 2);
    assert.equal(parseArgs(['--text-scale', '1.5']).textScale, 1.5);
    assert.equal(parseArgs(['--text-scale', '3']).textScale, 3);
  });

  it('refuses a size out of range, one that is not a number, and one Chrome cannot set exactly', () => {
    for (const bad of ['0.5', '0', '3.5', '4', '-2']) {
      assert.throws(() => parseArgs(['--text-scale', bad]), /from 1 to 3/u, `${bad} was accepted`);
    }
    for (const bad of ['big', '', '2x', 'NaN', 'Infinity']) {
      assert.throws(() => parseArgs(['--text-scale', bad]), /from 1 to 3/u, `${bad} was accepted`);
    }
    // 1.3 is 20.8px, and Page.setFontSizes takes whole pixels.
    assert.throws(() => parseArgs(['--text-scale', '1.3']), /sixteenths/u);
    assert.throws(() => parseArgs(['--text-scale']), /needs a value/u);
  });

  it('accepts the 320px reflow width', () => {
    assert.deepEqual(parseArgs(['--widths', '320,360']).widths, [320, 360]);
  });

  it('sends Chrome whole pixels for both faces', () => {
    assert.deepEqual(fontSizesFor(1), { standard: 16, fixed: 13 });
    assert.deepEqual(fontSizesFor(2), { standard: 32, fixed: 26 });
    assert.deepEqual(fontSizesFor(1.5), { standard: 24, fixed: 20 });
  });
});

describe('a page that ignores the reader text size', () => {
  const at = (rootFontSize, scale) => {
    const page = healthyRow();
    page.page = { ...page.page, rootFontSize };
    const context = { route: '/lab', theme: 'light', width: 600 };
    if (scale !== undefined) context.scale = scale;
    return findTextDefects(page, context).findings.filter((f) => f.check === 'unscaled');
  };

  it('is reported when the root stays at 16px under a 200% setting, with both numbers', () => {
    const [finding] = at(16, 2);
    assert.ok(finding !== undefined, 'a 16px root under 32px text was not reported');
    assert.equal(finding.rootFontSize, 16);
    assert.equal(finding.expected, 32);
    assert.equal(finding.scale, 2);
    assert.match(formatFinding(finding), /600px {2}200% text\n.*UNSCALED .*16px where the reader set 32px/u);
  });

  it('is reported for a root pinned in px at the default size too', () => {
    assert.equal(at(10).length, 1);
  });

  it('is reported when the root size could not be read, so a missing measurement cannot pass', () => {
    assert.equal(at(undefined, 2).length, 1);
    assert.equal(at(Number.NaN, 1).length, 1);
  });

  it('says nothing when the root follows the setting', () => {
    assert.deepEqual(at(32, 2), []);
    assert.deepEqual(at(24, 1.5), []);
    assert.deepEqual(at(16), []);
  });
});
