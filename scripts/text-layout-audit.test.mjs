#!/usr/bin/env node
/**
 * Tests for the painted-text detectors.
 *
 * Run with:  node --test scripts/text-layout-audit.test.mjs
 * Also run by: pnpm run test:scripts
 *
 * ## What is being tested, and why it is worth testing
 *
 * `scripts/text-layout-audit.mjs` drives Chrome, and a test cannot. What it CAN test is the half
 * that decides anything: `findTextDefects()` is a pure function over rectangles, and every
 * threshold in that file is a number this test can put on either side of.
 *
 * ## Would this fail if the behaviour broke?
 *
 * The fixtures below are not invented. `collapsedCoachRow()` is the measurement Chrome returned
 * from `/play?state=decision` with the shipped defect put back into `apps/web/src/styles/play.css`
 * and the app rebuilt — a 0px content box, the word "price" needing 42.25px, and 147.52 px² of
 * glyph overlap between the label and the sentence. If the detectors stop working, these fail.
 *
 * The other half of the control is `healthyRow()` and `neighbouringLines()`: a detector that fires
 * on everything is as useless as one that fires on nothing, and only having both halves rules both
 * out. `neighbouringLines()` in particular is the real false positive that set
 * `OVERLAP_MIN_HEIGHT_SHARE` — `getClientRects` measures the font's ascent and descent rather than
 * the line box, so two correctly stacked lines of tight-leading type cross by a pixel.
 *
 * Every block that scans also asserts on the COUNT of what was examined, because "no findings" and
 * "nothing was looked at" print identically and only one of them is good news.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CONTROLS,
  coverageFailures,
  EXEMPTIONS,
  escapeAmount,
  findTextDefects,
  formatFinding,
  intersection,
  isRealOverlap,
  parseArgs,
  ROUTES,
  sweepMatrix,
  THEMES,
  WIDTHS,
} from './text-layout-audit.mjs';

// ---------------------------------------------------------------------------
// Builders for the shape the in-page walker returns
// ---------------------------------------------------------------------------

let nextIndex = 0;

/** One text-bearing element, in the shape `WALKER` actually returns. */
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
    scrollHost: overrides.scrollHost ?? null,
    blockScrolls: overrides.blockScrolls ?? false,
    ellipsis: overrides.ellipsis ?? false,
    exempt: overrides.exempt ?? [],
  };
}

/** A whole page measurement, with sensible page-level numbers. */
function measurement(boxes, extra = {}) {
  return {
    heading: extra.heading ?? 'six-handed table',
    boxes,
    clippers: extra.clippers ?? [],
    page: extra.page ?? { scrollWidth: 1440, clientWidth: 1440, innerWidth: 1440 },
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

/**
 * The Coach row as Chrome measured it with the defect present.
 *
 * `/play?state=decision`, dark theme, 1440px wide. The label is a grid item in a track that
 * collapsed to nothing; the value is the sentence that took the whole row.
 */
function collapsedCoachRow() {
  const label = box({
    i: 100,
    end: 101,
    sel: 'div.prl-stat > dl.prl-stat__pair > dt.prl-stat__label.prl-label',
    tag: 'dt',
    text: 'Pot and price',
    // Three lines, one word each, painted out of a zero-width column.
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

/** The same row, laid out correctly: one column, label above value, nothing overlapping. */
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

/**
 * Two correctly stacked lines whose glyph rectangles cross by 1.4px.
 *
 * This is the false positive that decided `OVERLAP_MIN_HEIGHT_SHARE`, observed on `/legends` on a
 * page with nothing wrong with it: `getClientRects` returns the font's ascent and descent, and
 * `--prl-leading-tight` leaves that slightly taller than the line box it sits in.
 */
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
    // This is the measurement error the gate exists for, written down as an assertion: the label's
    // padding box is 0px wide and the value's starts at the same x, so no box-based comparison of
    // these two elements can ever report a collision. Only the glyphs overlap.
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
    // No pair is compared here and that is the detector working: the label's glyphs end 8px above
    // where the value's begin, so the vertical early-exit skips them. `neighbouringLines` below is
    // the fixture that proves a pair which COULD collide is actually compared.
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
    // The other side of the threshold, so the test above is proof of a boundary rather than proof
    // that the detector is switched off.
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
 * A box whose FIRST rectangle is not its highest one.
 *
 * The walker pushes rectangles in text-node document order, and within a node in line order, so
 * `rects[0]` is the first rect of the first text node. Usually that is the highest. It is not
 * guaranteed to be, and the collision scan's early exit is only sound if the sort key is the true
 * minimum: it stops on the first box beginning below the current one's lowest edge and concludes
 * every box after it is lower still.
 *
 * Here the ELEMENT `header > .prl-mark` owns two text nodes whose glyphs paint at y=300 and y=180 —
 * the second higher than the first. Sorted by `rects[0].y` it lands after the paragraph at y=200,
 * the scan breaks, and its real overlap with that paragraph is never compared. Sorted by the
 * topmost rect it lands first and the pair is examined.
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
    // Reproduces the discarded ordering over the same fixture so the control demonstrates the bug
    // rather than merely asserting the fix. Sorted by `rects[0].y` the mark (300) follows the
    // paragraph (200); scanning from the paragraph, the mark begins below the paragraph's lowest
    // edge (221) and the scan breaks with the two never compared.
    const { boxes } = rectsOutOfOrder();
    const byFirstRect = [...boxes].sort((a, b) => a.rects[0].y - b.rects[0].y);
    const lowest = Math.max(...byFirstRect[0].rects.map((r) => r.y + r.h));
    assert.equal(byFirstRect[0].sel, 'header > p', 'the paragraph must sort first under the old key');
    assert.ok(
      byFirstRect[1].rects[0].y > lowest,
      'the old key must trigger the early exit here, or this fixture proves nothing',
    );
    // And under the key actually used, the order is the other way round and nothing breaks early.
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
    // The first version of this loop skipped any element with a scrolling ancestor, and the Coach
    // rail has one — so it was blind to the exact defect it was written for. A scroller further up
    // does not make a zero-width column correct.
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
    // Measured on `.prl-stat__unit` at 12px / 0.08em: 0.96px past the content edge, on a row that
    // is laid out correctly. A zero tolerance would report every label in the app.
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

describe('the page itself', () => {
  it('reports a document that scrolls sideways', () => {
    const wide = healthyRow();
    wide.page = { scrollWidth: 412, clientWidth: 360, innerWidth: 360 };
    const { findings } = findTextDefects(wide, { route: '/', theme: 'dark', width: 360 });
    const finding = findings.find((f) => f.check === 'page');
    assert.ok(finding !== undefined);
    assert.equal(finding.past, 52);
    assert.match(formatFinding(finding), /scrolls sideways/u);
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
        detector: { ownBox: 34028, clipTests: 4168, pairs: 25744 },
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
    // Empty is the measured answer today. If somebody adds one, it says why.
    for (const rule of EXEMPTIONS) {
      assert.ok(typeof rule.selector === 'string' && rule.selector.length > 0);
      assert.ok(typeof rule.why === 'string' && rule.why.length > 30, 'an exemption needs a reason');
      assert.ok(['collision', 'escapes', 'clipped', 'squeezed', 'page'].includes(rule.check));
    }
  });
});

describe('a sweep of nothing is not a pass', () => {
  const healthy = {
    measurements: 150,
    textBoxes: 34098,
    detector: { ownBox: 34028, clipTests: 4168, pairs: 25744 },
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
    // The dangerous shape: the sweep looks busy, one detector fell out of the loop, and the
    // difference between "found nothing" and "looked at nothing" is invisible in the output.
    for (const key of ['ownBox', 'clipTests', 'pairs']) {
      const problems = coverageFailures({ ...healthy, detector: { ...healthy.detector, [key]: 0 } }, []);
      assert.equal(problems.length, 1, `${key} at zero must be reported`);
      assert.match(problems[0], /a detector that examined nothing/u);
    }
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
    // 1px of height between two 16px lines is type touching, not a collision.
    const grazing = { x: 0, y: 15, w: 100, h: 16 };
    assert.equal(isRealOverlap(intersection(a, grazing), a, grazing), false);
    // A 1px-wide sliver of full height is a rounding artefact, not a collision.
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
    for (const check of ['collision', 'escapes', 'clipped', 'squeezed', 'page']) {
      assert.ok(covered.has(check), `${check} has no negative control, so nobody has seen it fire`);
    }
    for (const control of CONTROLS) {
      assert.ok(ROUTES.includes(control.route), `${control.id} runs on a route the gate does not sweep`);
      assert.ok(WIDTHS.includes(control.width));
      assert.match(control.css, /\{/u);
    }
    // The first control must be the defect this whole file exists for, put back verbatim.
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
