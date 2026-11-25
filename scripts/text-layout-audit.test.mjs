#!/usr/bin/env node
/**
 * Tests for `findTextDefects()` and its thresholds. `collapsedCoachRow()` is Chrome's real
 * measurement of the shipped defect; `healthyRow()` and `neighbouringLines()` are the controls that
 * must not fire. Scans also assert on how much they examined.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  CONTROLS,
  chromeTarget,
  clippedRects,
  colorAlpha,
  coverageFailures,
  coverageFloor,
  drawnEdges,
  EXEMPTIONS,
  escapeAmount,
  exemptionFailures,
  exemptionReport,
  findTextDefects,
  foldWord,
  fontSizesFor,
  formatExemption,
  formatFinding,
  frameSides,
  intersection,
  isRealOverlap,
  judgeControl,
  LARGE_TEXT,
  letterByLetter,
  nearestFrame,
  Page,
  parseArgs,
  parseTextIndent,
  passCoverageFailures,
  ROUTES,
  sweepMatrix,
  sweepPasses,
  THEMES,
  WIDTHS,
} from './text-layout-audit.mjs';

/** Every finding shape the audit reports. */
const CHECKS = ['collision', 'escapes', 'clipped', 'spills', 'squeezed', 'broken', 'page', 'unscaled'];

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
    // What the walker sends only when it applies: preserved-space glyphs, a text-indent, broken words.
    ...Object.fromEntries(
      ['ink', 'indent', 'later', 'broken', 'fills']
        .filter((key) => overrides[key] !== undefined)
        .map((key) => [key, overrides[key]]),
    ),
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

/**
 * `/learn/pot-odds`, light, 360px, 200% text: "price = pot / call" in a `pre-wrap` formula line. The
 * 15.81px rectangle after the first line is the space before "call", hanging past the line box.
 */
function formulaLine() {
  return measurement([
    box({
      i: 249,
      end: 250,
      sel: 'pre.prl-formula__expression > span.prl-formula__line > code',
      tag: 'code',
      text: 'price = pot / call',
      rects: [
        { x: 139, y: 10893.75, w: 173.84, h: 30 },
        { x: 312.84, y: 10893.75, w: 15.81, h: 30 },
        { x: 172.7, y: 10930.14, w: 94.83, h: 30 },
      ],
      ink: [
        { x: 139, y: 10893.75, w: 173.84, h: 30 },
        { x: 172.7, y: 10930.14, w: 94.83, h: 30 },
      ],
      pad: { x: 139, y: 10890.75, w: 182.69, h: 72.78 },
      content: { x: 172.71, y: 10890.75, w: 148.97, h: 72.78 },
      word: { text: 'price', width: 79.03, first: true },
    }),
  ]);
}

describe('preserved white space hanging past a wrapped line', () => {
  it('is not counted as glyphs escaping the line (FALSE POSITIVE)', () => {
    const { findings, counts } = findTextDefects(formulaLine(), { route: '/learn/pot-odds', width: 360 });
    assert.deepEqual(findings, [], 'only a space reaches past the line, and a space paints nothing');
    assert.equal(counts.ownBox, 1);
  });

  it('was the whole escape: the same line measured with its space reaches 6.96px out', () => {
    const withSpace = formulaLine();
    withSpace.boxes[0].ink = undefined;
    const escapes = findTextDefects(withSpace, {}).findings.find((f) => f.check === 'escapes');
    assert.equal(escapes?.past, 6.96);
  });

  it('crosses no clip, frame or neighbour either', () => {
    const framed = formulaLine();
    const [line] = framed.boxes;
    framed.frames.push({ i: 248, end: 251, sel: 'span', border: line.pad, left: true, right: true });
    framed.clippers.push({ i: 247, end: 251, sel: 'pre', pad: line.pad });
    const beside = { x: 322, y: 10893.75, w: 30, h: 30 };
    const after = box({ i: 260, end: 261, rects: [beside], pad: beside });
    framed.boxes.push(after);
    assert.deepEqual(findTextDefects(framed, {}).findings, []);
    framed.boxes[0].ink = undefined;
    assert.deepEqual(
      findTextDefects(framed, {})
        .findings.map((f) => f.check)
        .sort(),
      ['clipped', 'collision', 'escapes', 'spills'],
    );
  });

  it('still reports a preserved-space word that really leaves its box', () => {
    const wide = formulaLine();
    wide.boxes[0].ink[0].w = 200;
    const escapes = findTextDefects(wide, {}).findings.find((f) => f.check === 'escapes');
    assert.equal(escapes?.past, 17.31);
  });
});

/**
 * `/learn/pot-odds`, light, 360px, 200% text: "break-even" opens a formula line set with
 * `padding-inline-start: 2ch; text-indent: -2ch`, so it starts 33.71px before the content box.
 */
function hangingIndent() {
  return measurement([
    box({
      i: 247,
      end: 248,
      sel: 'pre.prl-formula__expression > span.prl-formula__line > code',
      tag: 'code',
      text: 'break-even equity = call / (pot + call)',
      rects: [
        { x: 139, y: 10711.8, w: 158.05, h: 30 },
        { x: 172.7, y: 10748.19, w: 126.44, h: 30 },
        { x: 172.7, y: 10784.58, w: 94.83, h: 30 },
        { x: 172.7, y: 10820.97, w: 94.83, h: 30 },
        { x: 172.7, y: 10857.36, w: 79.03, h: 30 },
      ],
      pad: { x: 139, y: 10708.8, w: 182.69, h: 181.95 },
      content: { x: 172.71, y: 10708.8, w: 148.97, h: 181.95 },
      word: { text: 'break-even', width: 158.05, first: true },
      later: { text: 'equity', width: 94.83, first: false },
      indent: -33.71,
    }),
  ]);
}

describe('a hanging indent', () => {
  it('gives the first line the room it opens, so its first word is not squeezed (FALSE POSITIVE)', () => {
    const { findings } = findTextDefects(hangingIndent(), {});
    assert.deepEqual(findings, [], '158.05px of word on a first line 182.68px long fits');
  });

  it('was the whole squeeze: without the indent the word is 9.08px short', () => {
    const flat = hangingIndent();
    flat.boxes[0].indent = undefined;
    const squeezed = findTextDefects(flat, {}).findings.find((f) => f.check === 'squeezed');
    assert.equal(squeezed?.short, 9.08);
    assert.equal(squeezed?.has, 148.97);
  });

  it('gives a later line no extra room: a wide word there is still squeezed', () => {
    const later = hangingIndent();
    later.boxes[0].later = { text: 'break-even', width: 158.05, first: false };
    const squeezed = findTextDefects(later, {}).findings.find((f) => f.check === 'squeezed');
    assert.equal(squeezed?.has, 148.97, 'a continuation line starts at the content box');
    assert.equal(squeezed?.short, 9.08);
  });

  it('takes room away from the first line when the indent is positive', () => {
    const pushed = hangingIndent();
    Object.assign(pushed.boxes[0], { indent: 33.71, word: { text: 'break-even', width: 140, first: true } });
    const squeezed = findTextDefects(pushed, {}).findings.find((f) => f.check === 'squeezed');
    assert.equal(squeezed?.has, 115.26);
  });

  /** The hanging-indent block with its words folded as the walker folds them, line by line. */
  const folded = (indent, words) => {
    const widest = { word: null, opening: null, later: null };
    for (const [text, rects] of words) foldWord(widest, text, rects, 10708.8);
    const page = hangingIndent();
    Object.assign(page.boxes[0], { indent, ...widest });
    return findTextDefects(page, {}).findings.filter((f) => f.check === 'squeezed');
  };
  const line = (n, width) => ({ top: 10708.8 + 36.39 * n, width, height: 30 });

  it('judges a wrapped word by the line its widest piece is on, not its first (REGRESSION)', () => {
    // "a-" ends the long first line, and "verylongpart" on the next has only the content box.
    const squeezed = folded(-33.71, [
      ['some', [line(0, 60)]],
      ['a-verylongpart', [line(0, 20), line(1, 170)]],
    ]);
    assert.deepEqual(
      squeezed.map((f) => [f.word, f.has, f.short]),
      [['a-verylongpart', 148.97, 21.03]],
    );
  });

  it('judges the first line by its own room when a wider word sits on a later one', () => {
    // A positive indent: "Opening" has 115.26px on the first line, the 140px word below has 148.97.
    const squeezed = folded(33.71, [
      ['Opening', [line(0, 130)]],
      ['widest', [line(2, 140)]],
    ]);
    assert.deepEqual(
      squeezed.map((f) => [f.word, f.has]),
      [['Opening', 115.26]],
    );
    assert.deepEqual(folded(-33.71, [['fits', [line(0, 170)]]]), [], 'the first line has 182.68px');
  });
});

describe('a text-indent that names hanging or each-line', () => {
  it('is read as its length and its keywords, never as a plain length', () => {
    assert.deepEqual(parseTextIndent('-32px hanging', 300), { px: -32, keywords: true });
    assert.deepEqual(parseTextIndent('each-line 10%', 300), { px: 30, keywords: true });
    assert.deepEqual(parseTextIndent('10% hanging each-line', 300), { px: 30, keywords: true });
    assert.deepEqual(parseTextIndent('-33.71px', 300), { px: -33.71, keywords: false });
    assert.deepEqual(parseTextIndent('0px', 300), { px: 0, keywords: false });
  });

  it('gives no line extra room and takes it from every line, since which lines it moves is unknown', () => {
    const hanging = hangingIndent();
    Object.assign(hanging.boxes[0], { indentKeyword: true, later: undefined });
    const squeezed = findTextDefects(hanging, {}).findings.find((f) => f.check === 'squeezed');
    assert.equal(squeezed?.has, 148.97, 'a negative hanging indent opens no line');
    const pushed = hangingIndent();
    Object.assign(pushed.boxes[0], {
      indent: 20,
      indentKeyword: true,
      word: { text: 'equity', width: 140 },
      later: undefined,
    });
    assert.equal(findTextDefects(pushed, {}).findings.find((f) => f.check === 'squeezed')?.has, 128.97);
  });
});

/**
 * `/review`, light, 360px, 200% text. The row's `minmax(0, 1fr) auto` track left the result cell
 * 0px wide and `overflow-wrap: break-word` stood its label one letter a line. The label is
 * `aria-hidden` (the column header names it for a screen reader) and is painted all the same.
 */
function reviewRow() {
  return {
    ...measurement([
      box({
        i: 220,
        end: 221,
        sel: 'tbody > tr > td.prl-review-table__when',
        tag: 'td',
        text: '17 Aug 2026, 18:42 UTC',
        rects: [
          { x: 90, y: 2776.19, w: 15.92, h: 31 },
          { x: 90, y: 2818.19, w: 15.92, h: 31 },
          { x: 90, y: 2860.19, w: 19.09, h: 31 },
        ],
        pad: { x: 90, y: 2771.19, w: 0, h: 756 },
        content: { x: 90, y: 2771.19, w: 0, h: 756 },
        word: { text: 'UTC', width: 20.48 },
        broken: [
          { text: '17', pieces: ['1', '7'] },
          { text: 'Aug', pieces: ['A', 'u', 'g'] },
          { text: 'UTC', pieces: ['U', 'T', 'C'] },
        ],
      }),
    ]),
    ariaHidden: [
      box({
        i: 236,
        end: 237,
        sel: 'tr > td.prl-review-table__net > span.prl-review-table__cell-label',
        tag: 'span',
        text: 'Result',
        rects: [
          { x: 90, y: 2310.59, w: 19.17, h: 28 },
          { x: 90, y: 2349.59, w: 14.5, h: 28 },
          { x: 90, y: 2388.59, w: 13.52, h: 28 },
          { x: 90, y: 2427.59, w: 14.89, h: 28 },
          { x: 90, y: 2466.59, w: 6.13, h: 28 },
          { x: 90, y: 2505.59, w: 7.98, h: 28 },
        ],
        pad: { x: 90, y: 2305.59, w: 0, h: 234 },
        content: { x: 90, y: 2305.59, w: 0, h: 234 },
        word: { text: 'Result', width: 19.17 },
        broken: [{ text: 'Result', pieces: ['R', 'e', 's', 'u', 'l', 't'] }],
      }),
    ],
  };
}

/**
 * The `letter-by-letter` control as Chrome measured it at 1024px: a 20.61px column, wider than any
 * letter in it, so the widest piece (20.39px) fits and `squeezed` has nothing to say.
 */
function tornParagraph() {
  return measurement([
    box({
      i: 150,
      end: 151,
      sel: 'div.prl-learn-page > header.prl-learn-page__head > p.prl-learn-page__lead',
      text: 'Seventeen lessons, numbered in the order the ideas depend on one another, and th',
      rects: [
        { x: 40, y: 224.11, w: 12.11, h: 20 },
        { x: 40, y: 251.11, w: 18.94, h: 20 },
        { x: 40, y: 278.11, w: 20, h: 20 },
      ],
      pad: { x: 40, y: 221.11, w: 20.61, h: 3618 },
      content: { x: 40, y: 221.11, w: 20.61, h: 3618 },
      word: { text: 'lessons,', width: 20.39 },
      broken: [
        { text: 'Seventeen', pieces: ['S', 'ev', 'en', 'te', 'en'] },
        { text: 'follows', pieces: ['fol', 'lo', 'w', 's'] },
      ],
    }),
  ]);
}

describe('a word broken letter by letter', () => {
  it('reports the stacked "Result" on /review, aria-hidden or not (REGRESSION)', () => {
    const { findings, counts } = findTextDefects(reviewRow(), { route: '/review', width: 360, scale: 2 });
    const broken = findings.filter((f) => f.check === 'broken');
    assert.deepEqual(
      broken.map((f) => [f.word, f.ariaHidden]),
      [
        ['17', false],
        ['Result', true],
      ],
    );
    assert.deepEqual(broken[1].pieces, ['R', 'e', 's', 'u', 'l', 't']);
    assert.match(
      formatFinding(broken[1]),
      /BROKEN .*\(aria-hidden\)\n.*"Result" is torn over 6 lines: R \| e/u,
    );
    assert.equal(counts.breakTests, 4, 'every word on two lines, in the cell and the hidden label');
  });

  it('says "at least" when the page sent only the first pieces of a longer word', () => {
    const finding = { check: 'broken', route: '/review', theme: 'light', width: 360, sel: 'td', text: '' };
    const many = Array.from({ length: 80 }, () => 'a');
    assert.match(formatFinding({ ...finding, word: 'a', pieces: many }), /torn over at least 80 lines/u);
    assert.match(formatFinding({ ...finding, word: 'Result', pieces: ['R', 'e'] }), /torn over 2 lines/u);
  });

  it('judges aria-hidden text for nothing else: its overlaps are often decorative', () => {
    const { findings } = findTextDefects(reviewRow(), {});
    for (const finding of findings) {
      if (finding.check !== 'broken') assert.doesNotMatch(finding.sel, /cell-label/u);
    }
  });

  it('catches a column a letter wide, where squeezed is silent because every piece fits', () => {
    const { findings } = findTextDefects(tornParagraph(), { route: '/learn', width: 1024 });
    assert.deepEqual(
      findings.map((f) => f.check),
      ['broken'],
    );
    assert.equal(findings[0].word, 'Seventeen');
  });

  it('is not excused by a block that scrolls sideways', () => {
    const scroller = tornParagraph();
    scroller.boxes[0].blockScrolls = true;
    assert.deepEqual(
      findTextDefects(scroller, {}).findings.map((f) => f.check),
      ['broken'],
    );
  });

  it('leaves a token wrapped across full lines alone, however its breaks were allowed', () => {
    // The deal's Merkle root on /review/hand-0042 at 360px, 200%: `overflow-wrap: anywhere`, six a line.
    const root = ['9e1f07', 'f25216', '506575', 'ad44f6', '2e0827', '411aad', 'b092a9', 'a1fe53', '52df3b'];
    assert.equal(letterByLetter([...root, '69045b', '1612']), null);
    // At 1024px it wraps 31, 31, 2: a short last line is a full token, not a torn one.
    assert.equal(
      letterByLetter(['9e1f07f25216506575ad44f62e08274', '11aadb092a9a1fe5352df3b69045b16', '12']),
      null,
    );
    // The same root in a column two characters wide is unreadable, and `anywhere` does not excuse it.
    assert.notEqual(letterByLetter(['9e', '1f', '07', 'f2', '52']), null);
  });

  it('is not cleared by one piece of three characters or more (REGRESSION)', () => {
    assert.deepEqual(letterByLetter(['Br', 'illi', 'an', 't']), ['Br', 'illi', 'an', 't']);
    assert.notEqual(letterByLetter(['R', 'e', 's', 'u', 'l', 'ti', 'lli', 'ng']), null);
    assert.notEqual(letterByLetter(['ab', 'cdef', 'gh']), null, 'two of three pieces are short');
    assert.equal(letterByLetter(['abcdef', 'gh']), null, 'one short piece of two is a last line');
    assert.equal(letterByLetter(['abcdef', 'ghijkl', 'mn']), null, 'one short piece of three');
  });

  it('judges only the full lines where the browser fills, since the ends are leftovers', () => {
    assert.equal(letterByLetter(['ex', 'traordinari', 'ly'], true), null);
    assert.equal(letterByLetter(['Br', 'illi', 'an', 't'], true), null);
    assert.notEqual(letterByLetter(['Br', 'il', 'li', 'ant'], true), null);
    assert.notEqual(letterByLetter(['abcd', 'ef', 'gh', 'i', 'jklm'], true), null);
  });

  it('leaves an emergency break of a long word alone', () => {
    // `/learn/sample-size-and-risk-of-ruin` at 360px, 200%.
    assert.equal(letterByLetter(['reachin', 'g']), null);
    assert.equal(letterByLetter(['sensible', '.']), null);
  });

  it('counts a break after a hyphen, dash or slash as the text own, and judges each side of it', () => {
    assert.equal(letterByLetter(['(open-', 'raise)']), null);
    assert.equal(letterByLetter(['a-', 'b']), null);
    assert.deepEqual(letterByLetter(['br', 'ea', 'k-', 'ev', 'en']), ['br', 'ea', 'k-']);
    assert.deepEqual(letterByLetter(['d', 'o', 'c', 's', '/', 'T', 'H']), ['d', 'o', 'c', 's', '/']);
  });

  it('needs three pieces where the browser itself splits words to fill a line', () => {
    // Under `word-break: break-all` "the" at a line end is "t" and "he", which is filling, not tearing.
    assert.equal(letterByLetter(['t', 'he'], true), null);
    assert.notEqual(letterByLetter(['t', 'he']), null);
    assert.deepEqual(letterByLetter(['U', 'T', 'C'], true), ['U', 'T', 'C']);
    const filled = tornParagraph();
    filled.boxes[0].broken = [{ text: 'the', pieces: ['th', 'e'] }];
    filled.boxes[0].fills = true;
    assert.deepEqual(findTextDefects(filled, {}).findings, []);
  });

  it('counts the words it judged, so a dead line count or piece split examines nothing (REGRESSION)', () => {
    // What the walker sends when lineCount never finds a second line, and when piecesOf never splits.
    const deadLines = measurement([box({ broken: [] }), box({ broken: [] })]);
    assert.equal(findTextDefects(deadLines, {}).counts.breakTests, 0);
    const deadPieces = measurement([box({ broken: [{ text: 'Result', pieces: ['Result'] }] })]);
    assert.equal(findTextDefects(deadPieces, {}).counts.breakTests, 0);
    const problems = coverageFailures({
      ...FULL_DEFAULT_RUN,
      detector: { ...FULL_DEFAULT_RUN.detector, breakTests: 0 },
    });
    assert.match(problems.join('\n'), /only 0 words on two lines or more judged/u);
    // A torn word is reported once, and the words after it are still counted.
    assert.equal(findTextDefects(tornParagraph(), {}).counts.breakTests, 2);
  });

  it('counts a box the walker sent no break data for as unexamined', () => {
    const { counts } = findTextDefects(measurement([box({})]), {});
    assert.equal(counts.breakTests, 0);
    const exempted = tornParagraph();
    exempted.boxes[0].exempt = [0];
    const rules = [{ check: 'broken', selector: '.prl-learn-page__lead', why: 'because' }];
    const result = findTextDefects(exempted, {}, rules);
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.usedExemptions, [0]);
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
    const problems = exemptionFailures(exemptionReport([{ scale: 1, narrowed: false }], {}, rules));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /matched nothing/u);
    assert.deepEqual(exemptionFailures(exemptionReport([{ scale: 1 }], { 0: 3 }, rules)), []);
  });

  it('a pass that does not say whether it was narrowed is held to its rules', () => {
    assert.equal(exemptionReport([{}], {}, rules)[0].status, 'stale');
  });

  it('every shipped rule carries a reason, and the list holds only the radar labels', () => {
    for (const rule of EXEMPTIONS) {
      assert.ok(typeof rule.selector === 'string' && rule.selector.length > 0);
      assert.ok(typeof rule.why === 'string' && rule.why.length > 30, 'an exemption needs a reason');
      assert.ok(CHECKS.includes(rule.check));
    }
    assert.deepEqual(
      EXEMPTIONS.map((rule) => [rule.check, rule.selector, rule.aboveScale]),
      [['clipped', 'text.prl-radar__label', 1]],
    );
  });
});

/**
 * `/legends`, light, 768px, 200% text: radar label "04" cut 4.5px past the radar that hides overflow.
 * `exempt` is what the walker sends when the element matches the rule's selector; the root is 32px.
 */
const RADAR_RULE = EXEMPTIONS.findIndex((rule) => rule.selector === 'text.prl-radar__label');
const RADAR = 'article.prl-legend-card > div.prl-radar.prl-legend-radar > svg.prl-radar__svg';

function radarLabel(clipperSel = RADAR) {
  const label = { x: 395.5, y: 140, w: 9, h: 20 };
  return measurement(
    [
      box({
        i: 300,
        end: 301,
        sel: 'svg.prl-radar__svg > g.prl-radar__labels > text.prl-radar__label.prl-index',
        tag: 'text',
        text: '04',
        rects: [label],
        pad: label,
        word: { text: '04', width: 9 },
        exempt: [RADAR_RULE],
      }),
    ],
    {
      clippers: [{ i: 298, end: 302, sel: clipperSel, pad: { x: 100, y: 0, w: 300, h: 300 } }],
      page: { scrollWidth: 768, clientWidth: 768, innerWidth: 768, rootFontSize: 32 },
    },
  );
}

describe('the radar label exemption', () => {
  const clippedAt = (m, context) => findTextDefects(m, context).findings.filter((f) => f.check === 'clipped');

  it('suppresses the label clipped by its own radar at 200% text, and counts it', () => {
    assert.ok(RADAR_RULE >= 0, 'no shipped exemption names text.prl-radar__label');
    const result = findTextDefects(radarLabel(), { route: '/legends', width: 768, scale: 2 });
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.usedExemptions, [RADAR_RULE]);
    assert.deepEqual(result.suppressed, { [RADAR_RULE]: 1 });
  });

  it('still reports the same finding at 100% text, or with no size given (REGRESSION)', () => {
    assert.equal(clippedAt(radarLabel(), { route: '/legends', width: 768, scale: 1 })[0]?.past, 4.5);
    assert.equal(clippedAt(radarLabel(), { route: '/legends', width: 768 }).length, 1);
    assert.deepEqual(findTextDefects(radarLabel(), { scale: 1 }).usedExemptions, []);
  });

  it('still reports the label cut off by an ancestor that is not the radar', () => {
    const byCard = radarLabel('section.prl-legend-section > div.prl-legend-grid > article.prl-legend-card');
    assert.equal(clippedAt(byCard, { scale: 2 }).length, 1);
  });

  it('suppresses no other shape on the same label', () => {
    const framed = radarLabel();
    framed.clippers = [];
    framed.frames.push({
      i: 298,
      end: 302,
      sel: RADAR,
      border: { x: 100, y: 0, w: 300, h: 300 },
      left: true,
      right: true,
    });
    const checks = findTextDefects(framed, { scale: 2 }).findings.map((f) => f.check);
    assert.deepEqual(checks, ['spills']);
  });

  it('is held to having matched by a full pass above 100%, and said aloud when none ran', () => {
    const report = (argv, suppressed) =>
      exemptionReport(sweepPasses(parseArgs(argv)), suppressed)[RADAR_RULE].status;
    assert.equal(report([], { [RADAR_RULE]: 312 }), 'used');
    assert.equal(report([], {}), 'stale', 'the default run reaches the rule through its large-text pass');
    assert.equal(report(['--text-scale', '2'], {}), 'stale');
    assert.equal(report(['--text-scale', '1'], {}), 'unreached', 'a 100% run cannot use it');
    assert.equal(report(['--routes', '/learn'], {}), 'unreached', 'a narrowed run cannot prove it stale');
    const stale = exemptionReport(sweepPasses(parseArgs([])), {});
    assert.match(exemptionFailures(stale)[0], /text\.prl-radar__label\) matched nothing/u);
  });

  it('prints its reason and what it suppressed', () => {
    const [used] = exemptionReport(sweepPasses(parseArgs([])), { [RADAR_RULE]: 312 });
    assert.match(formatExemption(used), /^clipped text\.prl-radar__label above 100% text: 312 finding/u);
    assert.match(formatExemption(used), /why: .*held for the owner/u);
    const [unreached] = exemptionReport(sweepPasses(parseArgs(['--text-scale', '1'])), {});
    assert.match(formatExemption(unreached), /not reached/u);
  });
});

/** The tally of the default run (every route, both themes, five widths, 100% text) on 2026-11-25. */
const FULL_DEFAULT_RUN = {
  measurements: 200,
  measurementsWanted: 200,
  textBoxes: 38970,
  detector: { ownBox: 38970, clipTests: 4280, frameTests: 28610, pairs: 33050, breakTests: 232 },
  routesLoaded: 40,
  routesWanted: 40,
  usedExemptions: new Set(),
};

/** 62 routes, light only, 360px only, 200% text: the shape of a small CI pass, measured the same day. */
const ONE_WIDTH_ONE_THEME = {
  measurements: 62,
  measurementsWanted: 62,
  textBoxes: 8761,
  detector: { ownBox: 8761, clipTests: 780, frameTests: 5166, pairs: 1648, breakTests: 648 },
  routesLoaded: 62,
  routesWanted: 62,
  usedExemptions: new Set(),
};

describe('a sweep of nothing is not a pass', () => {
  const healthy = FULL_DEFAULT_RUN;

  it('a full sweep of this app clears every floor', () => {
    assert.deepEqual(coverageFailures(healthy, []), []);
  });

  it('a run of one width and one theme is held to its own size, not refused (REGRESSION)', () => {
    // The fixed floors asked every run for 100 measurements and 8,000 pairs, so this was refused four times.
    assert.deepEqual(coverageFailures(ONE_WIDTH_ONE_THEME, []), []);
    assert.equal(coverageFloor('pairs', 62), 496);
    assert.equal(coverageFloor('pairs', 200), 1600);
  });

  it('the floor follows the matrix asked for and is never zero', () => {
    for (const key of ['textBoxes', 'ownBox', 'clipTests', 'frameTests', 'pairs', 'breakTests']) {
      assert.ok(coverageFloor(key, 1) >= 1, `${key} has no floor for a single measurement`);
      assert.equal(coverageFloor(key, 0), 1, `${key} must still ask for something when nothing was asked`);
      assert.ok(coverageFloor(key, 200) > coverageFloor(key, 62));
    }
  });

  it('refuses a run that measured almost nothing', () => {
    const problems = coverageFailures({ ...healthy, measurements: 2, textBoxes: 40 }, []);
    assert.equal(problems.length, 2);
    for (const problem of problems) assert.match(problem, /a sweep of nothing is not a pass/u);
    assert.match(problems[0], /only 2 of 200 page measurement/u);
  });

  it('refuses a sweep that asked for nothing, or reports no matrix at all', () => {
    const empty = {
      ...healthy,
      measurements: 0,
      measurementsWanted: 0,
      textBoxes: 0,
      detector: { ownBox: 0, clipTests: 0, frameTests: 0, pairs: 0, breakTests: 0 },
    };
    const problems = coverageFailures(empty, []);
    assert.match(problems[0], /asked for no measurement/u);
    assert.ok(problems.length >= 7, problems.join('\n'));
    const { measurementsWanted: _, ...unsized } = healthy;
    assert.match(coverageFailures(unsized, [])[0], /asked for no measurement/u);
  });

  it('a run that measured less than it asked cannot lower its own floor', () => {
    // Twelve of 200 pages measured, each one rich: the floors still follow the 200 asked for.
    const short = { ...healthy, measurements: 12, textBoxes: 9000 };
    const problems = coverageFailures(short, []);
    assert.match(problems[0], /only 12 of 200/u);
  });

  it('refuses a run where a detector examined nothing, even with pages measured', () => {
    // A busy sweep with one detector out of the loop must still fail.
    for (const key of ['ownBox', 'clipTests', 'frameTests', 'pairs', 'breakTests']) {
      const problems = coverageFailures({ ...healthy, detector: { ...healthy.detector, [key]: 0 } }, []);
      assert.equal(problems.length, 1, `${key} at zero must be reported`);
      assert.match(problems[0], /a detector that examined nothing/u);
    }
  });

  it('refuses a narrow run in which a detector examined nothing, naming the floor it missed', () => {
    // `/learn`, dark, 1024px, as measured: no text sits inside a clipping ancestor, no word breaks.
    const learn = {
      measurements: 1,
      measurementsWanted: 1,
      textBoxes: 216,
      detector: { ownBox: 216, clipTests: 0, frameTests: 180, pairs: 146, breakTests: 0 },
      routesLoaded: 1,
      routesWanted: 1,
      usedExemptions: new Set(),
    };
    const problems = coverageFailures(learn, []);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /only 0 text blocks measured against a clipping ancestor \(floor 4 for 1 /u);
    assert.match(problems[1], /only 0 words on two lines or more judged .*\(floor 1 for 1 /u);
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
    assert.match(problems[0], /12 route\(s\) never loaded/u);
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
    const full = sweepMatrix(parseArgs([])).filter((cell) => cell.scale === 1);
    assert.equal(full.length, ROUTES.length * THEMES.length * WIDTHS.length);
    assert.ok(full.length >= 100, `${String(full.length)} measurements is not a sweep`);
    const narrow = sweepMatrix(parseArgs(['--routes', '/learn', '--widths', '360', '--themes', 'dark']));
    assert.deepEqual(narrow, [{ route: '/learn', theme: 'dark', width: 360, scale: 1 }]);
  });

  it('every check has a negative control that runs on every invocation', () => {
    const covered = new Set(CONTROLS.map((control) => control.expect));
    for (const check of CHECKS) {
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

// The large-text pass as first measured: ROUTES, light, 768 and 1024, 200% text on 2026-11-26.
// Its clip tests come from three routes only.
const LARGE_TEXT_RUN = {
  measurements: 40,
  measurementsWanted: 40,
  textBoxes: 7530,
  detector: { ownBox: 7530, clipTests: 856, frameTests: 5474, pairs: 3218, breakTests: 57 },
  routesLoaded: 20,
  routesWanted: 20,
};

describe('the large-text pass', () => {
  const cells = (argv) => sweepMatrix(parseArgs(argv));
  const large = (argv) => cells(argv).filter((cell) => cell.scale !== 1);

  it('the default run also measures every route at 200% text, light, at 768 and 1024', () => {
    const extra = large([]);
    assert.equal(extra.length, ROUTES.length * 2, 'the default run has no large-text pass');
    assert.deepEqual([...new Set(extra.map((cell) => cell.scale))], [2]);
    assert.deepEqual([...new Set(extra.map((cell) => cell.theme))], ['light']);
    assert.deepEqual([...new Set(extra.map((cell) => cell.width))], [768, 1024]);
    assert.deepEqual([...new Set(extra.map((cell) => cell.route))], ROUTES);
    assert.equal(cells([]).length, ROUTES.length * (THEMES.length * WIDTHS.length + 2));
  });

  it('follows --routes, so one route can be checked the way the gate checks it', () => {
    assert.deepEqual(large(['--routes', '/legends']), [
      { route: '/legends', theme: 'light', width: 768, scale: 2 },
      { route: '/legends', theme: 'light', width: 1024, scale: 2 },
    ]);
    assert.deepEqual(
      sweepPasses(parseArgs(['--routes', '/legends'])).map((pass) => pass.narrowed),
      [true, true],
    );
  });

  it('is replaced by exactly the matrix --text-scale, --widths or --themes names', () => {
    const asked = cells(['--text-scale', '2', '--themes', 'light', '--widths', '768,1024']);
    assert.equal(asked.length, ROUTES.length * 2, 'the cells a --text-scale run named, and no more');
    assert.ok(asked.every((cell) => cell.scale === 2));
    assert.ok(cells(['--text-scale', '1']).every((cell) => cell.scale === 1));
    assert.ok(cells(['--text-scale', '1.5']).every((cell) => cell.scale === 1.5));
    assert.deepEqual(large(['--widths', '360']), []);
    assert.deepEqual(large(['--themes', 'dark']), []);
    assert.deepEqual(
      sweepPasses(parseArgs(['--text-scale', '2'])).map((pass) => [pass.scale, pass.narrowed]),
      [[2, false]],
    );
  });

  it('cannot borrow coverage from the 100% pass (REGRESSION)', () => {
    const passes = sweepPasses(parseArgs([]));
    const unclipped = { ...LARGE_TEXT_RUN, detector: { ...LARGE_TEXT_RUN.detector, clipTests: 0 } };
    const problems = passCoverageFailures(passes, [FULL_DEFAULT_RUN, unclipped]);
    assert.equal(problems.length, 1, '4,280 clip tests at 100% must not cover a pass with none');
    assert.match(problems[0], /^200% text pass: only 0 text blocks .*clipping ancestor \(floor 160 for 40 /u);
    assert.deepEqual(passCoverageFailures(passes, [FULL_DEFAULT_RUN, LARGE_TEXT_RUN]), []);
  });

  it('is a large size Chrome can set, in a theme and widths the audit knows', () => {
    assert.ok(LARGE_TEXT.scale > 1);
    assert.doesNotThrow(() => parseArgs(['--text-scale', String(LARGE_TEXT.scale)]));
    for (const theme of LARGE_TEXT.themes) assert.ok(THEMES.includes(theme));
    for (const width of LARGE_TEXT.widths) assert.ok(WIDTHS.includes(width));
  });

  it('holds its own cells to the coverage floors, as its first run measured them', () => {
    assert.deepEqual(coverageFailures(LARGE_TEXT_RUN), []);
    const unclipped = { ...LARGE_TEXT_RUN, detector: { ...LARGE_TEXT_RUN.detector, clipTests: 100 } };
    assert.match(
      coverageFailures(unclipped)[0],
      /only 100 text blocks .*clipping ancestor \(floor 160 for 40 /u,
    );
  });
});

describe('the large-text negative control', () => {
  const header = CONTROLS.find((control) => control.id === 'header-px-breakpoint');
  const styles = ['apps/web/src/styles/nav.css', 'apps/web/src/app/globals.css'].map((path) =>
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  );

  it('puts the desktop header back under px breakpoints, at the pass size and a pass cell', () => {
    assert.ok(header !== undefined, 'no control re-creates the header that only 200% text catches');
    assert.equal(header.expect, 'page');
    assert.equal(header.scale, LARGE_TEXT.scale);
    assert.ok(LARGE_TEXT.themes.includes(header.theme));
    assert.ok(LARGE_TEXT.widths.includes(header.width));
    assert.ok(ROUTES.includes(header.route));
    assert.match(header.css, /\.prl-shell__header-inner \{ grid-template-columns: auto 1fr auto; \}/u);
    assert.doesNotMatch(header.css, /\d+(\.\d+)?em\)/u, 'an em condition would move with the text');
  });

  it('mirrors breakpoints the stylesheets still state in em, so it re-creates their px forms', () => {
    const px = [...header.css.matchAll(/min-width: (\d+)px/gu)].map((m) => Number(m[1]));
    assert.deepEqual(px, [600, 860]);
    for (const width of px) {
      const em = `(min-width: ${String(width / 16)}em)`;
      assert.ok(
        styles.some((css) => css.includes(em)),
        `${em} is no longer in the stylesheets`,
      );
    }
    assert.ok(styles[0].includes('grid-template-columns: auto 1fr auto;'));
  });

  it('counts only when caught at its size and silent at 100% text', () => {
    const page = [{ check: 'page' }];
    assert.deepEqual(judgeControl(header, page, []), { caught: true, why: '' });
    assert.deepEqual(judgeControl(header, page, page), { caught: false, why: 'fires at 100% text' });
    assert.deepEqual(judgeControl(header, page, undefined).caught, false, 'never measured at 100%');
    assert.deepEqual(judgeControl(header, [], []), { caught: false, why: 'missed' });
  });

  it('every control with its own size needs more than 100%, and the others need no second look', () => {
    for (const control of CONTROLS.filter((c) => c.scale !== undefined)) assert.ok(control.scale > 1);
    const plain = CONTROLS.find((control) => control.id === 'coach-track');
    assert.equal(plain.scale, undefined);
    assert.equal(judgeControl(plain, [{ check: 'squeezed' }], undefined).caught, true);
  });
});

describe("the audit's own Chrome", () => {
  it('takes a port and a profile from the environment, or its own defaults', () => {
    assert.deepEqual(chromeTarget({ PRL_LAYOUT_CDP_PORT: '9985', PRL_LAYOUT_PROFILE: 'scratch/p' }, 1), {
      port: 9985,
      profile: 'scratch/p',
    });
    assert.equal(chromeTarget({}, 141).port, 9651);
  });

  it('refuses an empty or non-numeric port and an empty profile at start', () => {
    for (const bad of ['', ' ', 'abc', '99x', '0', '70000', '-1', '9985.5']) {
      assert.throws(() => chromeTarget({ PRL_LAYOUT_CDP_PORT: bad }, 1), /PRL_LAYOUT_CDP_PORT/u, `"${bad}"`);
    }
    // Chrome given an empty --user-data-dir opens the user's own profile.
    for (const bad of ['', '  ']) {
      assert.throws(
        () => chromeTarget({ PRL_LAYOUT_PROFILE: bad }, 1),
        /PRL_LAYOUT_PROFILE is set but empty/u,
      );
    }
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

  it('refuses an empty list, which would ask for a sweep of nothing', () => {
    assert.throws(() => parseArgs(['--routes', ',']), /--routes was given an empty list/u);
    assert.throws(() => parseArgs(['--themes', '']), /--themes was given an empty list/u);
    assert.throws(() => parseArgs(['--widths', '']), /at least 200/u);
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

/** A DevTools socket that answers every call, refusing the ones `refuse` picks as Chrome does. */
class FakeSocket {
  sent = [];
  #onMessage = [];

  constructor(refuse = () => false) {
    this.refuse = refuse;
  }

  addEventListener(type, listener) {
    if (type === 'message') this.#onMessage.push(listener);
  }

  send(text) {
    const call = JSON.parse(text);
    this.sent.push(call);
    const reply = this.refuse(call, this.sent.length)
      ? { id: call.id, error: { code: -32601, message: `'${call.method}' wasn't found` } }
      : { id: call.id, result: {} };
    queueMicrotask(() => {
      for (const listener of this.#onMessage) listener({ data: JSON.stringify(reply) });
    });
  }
}

describe("Chrome's text size setting", () => {
  const fontCalls = (socket) =>
    socket.sent.filter((call) => call.method === 'Page.setFontSizes').map((call) => call.params.fontSizes);

  it('refuses the run when Chrome refuses a size other than 100%, naming the refusal', async () => {
    const socket = new FakeSocket(() => true);
    const page = new Page(socket);
    await assert.rejects(page.setTextScale(2), /refused Page\.setFontSizes for 200% text .*wasn't found/u);
    assert.equal(page.textScale, 1, 'a refused size must not be reported as the one measured');
  });

  it('sends nothing at 100%, so the default run does not depend on the method at all', async () => {
    const socket = new FakeSocket(() => true);
    const page = new Page(socket);
    await page.setTextScale(1);
    assert.deepEqual(socket.sent, []);
    assert.match(page.textSizeMethod, /default/u);
  });

  it('goes back to 16px and 13px after 200%, and refuses a refused return', async () => {
    const socket = new FakeSocket();
    const page = new Page(socket);
    await page.setTextScale(2);
    await page.setTextScale(1);
    assert.deepEqual(fontCalls(socket), [
      { standard: 32, fixed: 26 },
      { standard: 16, fixed: 13 },
    ]);
    assert.equal(page.textScale, 1);
    const stuck = new Page(new FakeSocket((_, n) => n > 1));
    await stuck.setTextScale(2);
    await assert.rejects(stuck.setTextScale(1), /refused Page\.setFontSizes for 100% text/u);
    assert.equal(stuck.textScale, 2, 'the page is still at 200%, and says so');
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
