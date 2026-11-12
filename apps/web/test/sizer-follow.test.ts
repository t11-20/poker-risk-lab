/**
 * On a phone, a decision with a raise legal brings the sizer into view with the action row under it,
 * not under the row (audit at 6b3886e, M1).
 *
 * ## The defect
 *
 * The follow scroll brought the buttons in by their nearest edge, which stops where the row can
 * stick — and the row, stuck, was painted over the sizer above it. At 390x844 on the live table,
 * every decision with a raise legal: presets at 619..713 and the slider at 723..767 under the row at
 * 611..780, every preset hit-testing to Fold, Call or Raise, and a tap on ½ pot sending a min-raise.
 *
 * ## What is checked
 *
 * `sizerFollowDelta` is pure, so it is driven with the rectangles Chrome measured on this branch's
 * build before the change (390x844, dark, preflop facing a raise): bar 557..1249, sizer 624..992,
 * the row stuck at 611..780, and the note after the row — where the row sits in flow — at 1,168.
 * Scrolled by the answer, the row's flow position is above the line it sticks at, so it sits under
 * the sizer and covers none of it; measured after the change on the same decision shape, sizer
 * 220..587 and row 591..760, and `elementFromPoint` returned the control itself at all five presets,
 * the slider and the number field, on 10 of 10 decisions across both themes and 390x844 and
 * 360x640. The negative control is the old geometry itself: the detector says covered.
 *
 * The wiring in `LiveTable.tsx` imports `@prl/ui`, which this runner cannot load, so it is read
 * from source with its own negative control, as `focus-rescues-scroll.test.ts` reads the rest.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  rowCoversSizer,
  type SizerGeometry,
  sizerFollowDelta,
  type WatchGeometry,
  watchDelta,
} from '../src/lib/follow-the-table.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * 390x844: the root's scroll padding, 92px above (the 77px header and a step of air) and the Coach
 * peek's 80px below. Read off `getComputedStyle(document.documentElement)` on the live table at 390
 * and at 360; this said 77 before the glance, which is the header alone.
 */
const VIEW = { viewTop: 92, viewBottom: 844 - 80, coverBottom: 77 } as const;
/** The row's own height at 390, and the line it sticks at: the 4rem peek above the bottom edge. */
const ROW_HEIGHT = 169;
const STICKS_BELOW = 844 - 64;

/** Measured before the change: the row stuck over the sizer. Before the glance, too: no cards drawn. */
const BEFORE: SizerGeometry = {
  regionTop: 557,
  handTop: null,
  streetBottom: null,
  sizerTop: 624,
  sizerBottom: 992,
  rowTop: 611,
  rowFlowBottom: 1168,
  ...VIEW,
};

/** The page moved by `delta`, with the row painted where CSS `sticky` would paint it. */
function scrolled(geometry: SizerGeometry, delta: number): SizerGeometry {
  const rowFlowBottom = geometry.rowFlowBottom - delta;
  // In flow, the row ends a gap above the note; stuck, it ends at the line it sticks at.
  const rowBottom = Math.min(rowFlowBottom - 4, STICKS_BELOW);
  return {
    ...geometry,
    regionTop: geometry.regionTop - delta,
    handTop: geometry.handTop === null ? null : geometry.handTop - delta,
    streetBottom: geometry.streetBottom === null ? null : geometry.streetBottom - delta,
    sizerTop: geometry.sizerTop - delta,
    sizerBottom: geometry.sizerBottom - delta,
    rowFlowBottom,
    rowTop: rowBottom - ROW_HEIGHT,
  };
}

describe('the follow scroll brings the sizer in with the row under it', () => {
  it('NEGATIVE CONTROL: the measured geometry before the change is a covered sizer', () => {
    assert.equal(rowCoversSizer(BEFORE), true, 'the detector does not see the defect it exists for');
  });

  it('moves the page so the row sits in flow under the sizer, and the whole region is in view', () => {
    const delta = sizerFollowDelta(BEFORE);
    assert.equal(delta, BEFORE.rowFlowBottom - VIEW.viewBottom, 'the region fits, so by its nearest edge');
    const after = scrolled(BEFORE, delta);
    assert.equal(
      rowCoversSizer(after),
      false,
      `row ${after.rowTop} over a sizer ending ${after.sizerBottom}`,
    );
    assert.ok(after.regionTop >= VIEW.viewTop, `the price strip went under the header (${after.regionTop})`);
    assert.ok(after.rowFlowBottom <= VIEW.viewBottom, 'the row is under the Coach peek');
    // And what was measured in Chrome after the change, on the same shape of decision.
    assert.deepEqual([after.sizerTop, after.sizerBottom], [220, 588]);
  });

  it('does not move a page where the sizer and the row are already usable', () => {
    assert.equal(sizerFollowDelta(scrolled(BEFORE, sizerFollowDelta(BEFORE))), 0);
  });

  it('brings the region down by its top edge when the reader is below it', () => {
    const below = scrolled(BEFORE, 700);
    const delta = sizerFollowDelta(below);
    assert.ok(delta < 0, `expected to scroll up, got ${delta}`);
    assert.equal(scrolled(below, delta).regionTop, VIEW.viewTop);
  });

  it('on a phone too short for the region, puts the sizer’s controls first', () => {
    // 360x640: 640 - 92 - 80 = 468px of view for a region of about 610px.
    const short: SizerGeometry = { ...BEFORE, viewTop: 92, viewBottom: 640 - 80 };
    const delta = sizerFollowDelta(short);
    assert.equal(delta, short.sizerTop - 92, 'the sizer’s top is not at the top edge');
  });
});

/**
 * The reader's cards and the board stay on screen while they size a bet.
 *
 * The follow above took the reader's own plate and the board off the top at 390x844 (plate at
 * -174..46, board at -303..-203), so the bar now draws `HandGlance` between the price and the sizer,
 * and the follow keeps it in view. Each fixture is the layout Chrome measured AFTER the change on the
 * live table, both themes, placed where a deal leaves it — the sizer at 624, as in `BEFORE` — so the
 * answer has to bring every rectangle back to where it was measured.
 *
 *   390x844: street 56..77 (one line), price 106..144, glance 156..201, sizer 213..580, row in flow
 *            584..753 and the note after it at 757; number field 402..446.
 *   360x640: price 43..80, street ending at 14, glance 92..137, sizer 149..538, row stuck at
 *            407..576, number field at 190..234 below the sizer's top, and the note at 715.
 */
describe('the glance at the reader’s cards stays in view while they size a bet', () => {
  /** Where the deal left the 390x844 layout: everything 411px further down. */
  const AT_390: SizerGeometry = {
    regionTop: 56 + 411,
    handTop: 156 + 411,
    streetBottom: 77 + 411,
    sizerTop: 213 + 411,
    sizerBottom: 580 + 411,
    rowTop: STICKS_BELOW - ROW_HEIGHT,
    rowFlowBottom: 757 + 411,
    ...VIEW,
  };
  /** 360x640: 92px above, the peek's 80 below, the row sticking 64px above the bottom edge. */
  const VIEW_360 = { viewTop: 92, viewBottom: 640 - 80, coverBottom: 77 } as const;
  const AT_360: SizerGeometry = {
    regionTop: -7 + 475,
    handTop: 92 + 475,
    streetBottom: 14 + 475,
    sizerTop: 149 + 475,
    sizerBottom: 538 + 475,
    rowTop: 640 - 64 - ROW_HEIGHT,
    rowFlowBottom: 715 + 475,
    ...VIEW_360,
  };
  const FIELD_BELOW_SIZER_TOP = { top: 190, bottom: 234 } as const;

  it('NEGATIVE CONTROL: the sizer at the top edge, the old answer, puts the glance under the header', () => {
    for (const at of [AT_390, AT_360]) {
      assert.ok(
        at.rowFlowBottom - at.regionTop > at.viewBottom - at.viewTop,
        'the region fits: not the case',
      );
      const glanceTop = (at.handTop ?? 0) - (at.sizerTop - at.viewTop);
      assert.ok(glanceTop < at.viewTop, `the old answer left the glance in view at ${glanceTop}`);
    }
  });

  it('NEGATIVE CONTROL: the row at the bottom edge alone leaves half the street line under the header', () => {
    const streetBottom = (AT_390.streetBottom ?? 0) - (AT_390.rowFlowBottom - AT_390.viewBottom);
    assert.equal(
      streetBottom,
      84,
      'the street line ended where it was measured before it was given up whole',
    );
    assert.ok(streetBottom > AT_390.coverBottom);
  });

  it('at 390x844 keeps the price, the glance, the sizer and the row in flow, and gives up the street line', () => {
    const delta = sizerFollowDelta(AT_390);
    const after = scrolled(AT_390, delta);
    assert.deepEqual(
      [after.handTop, after.sizerTop, after.sizerBottom],
      [156, 213, 580],
      'not where measured',
    );
    assert.equal(after.streetBottom, AT_390.coverBottom, 'the street line is not wholly under the header');
    assert.ok(after.rowFlowBottom <= VIEW.viewBottom, 'the row is under the Coach peek');
    assert.equal(
      rowCoversSizer(after),
      false,
      `row ${after.rowTop} over a sizer ending ${after.sizerBottom}`,
    );
    assert.equal(sizerFollowDelta(after), 0, 'a second follow moves the page again');
  });

  it('at 360x640 puts the glance at the top edge with the number field clear of the stuck row', () => {
    const delta = sizerFollowDelta(AT_360);
    const after = scrolled360(AT_360, delta);
    assert.equal(after.handTop, VIEW_360.viewTop, 'the glance is not at the top edge');
    assert.equal(after.sizerTop, 149, 'the sizer is not where it was measured');
    const fieldBottom = after.sizerTop + FIELD_BELOW_SIZER_TOP.bottom;
    assert.ok(
      fieldBottom <= after.rowTop,
      `the number field ends at ${fieldBottom}, under a row at ${after.rowTop}`,
    );
    assert.equal(sizerFollowDelta(after), 0, 'a second follow moves the page again');
  });
});

/** As `scrolled`, for 360x640: the row sticks 64px above a 640px bottom edge. */
function scrolled360(geometry: SizerGeometry, delta: number): SizerGeometry {
  const moved = scrolled(geometry, delta);
  const rowBottom = Math.min(moved.rowFlowBottom - 4, 640 - 64);
  return { ...moved, rowTop: rowBottom - ROW_HEIGHT };
}

/**
 * Once the decision is over, the table comes back. Measured at 390x844 on this branch with only the
 * sizer follow in place: after a call the band collapsed to 92..204 under the header with the plate
 * at -146..55; at the end of a hand the result was at -157..-21 above a band at 108..355.
 */
describe('when the decision is not the reader’s, the table is watched', () => {
  const AFTER_A_CALL: WatchGeometry = {
    bandTop: 92,
    bandBottom: 204,
    tableBottom: 55,
    dealt: false,
    ...VIEW,
  };
  const HAND_OVER: WatchGeometry = {
    bandTop: 108,
    bandBottom: 355,
    tableBottom: -169,
    dealt: false,
    ...VIEW,
  };

  it('NEGATIVE CONTROL: the band by its nearest edge, as before, leaves both where they were', () => {
    // The old follow did nothing to a band already in view, which is what both of these are.
    for (const at of [AFTER_A_CALL, HAND_OVER]) {
      assert.ok(at.bandTop >= VIEW.viewTop && at.bandBottom <= VIEW.viewBottom, 'not in view: not the case');
      assert.ok(at.tableBottom <= VIEW.viewTop, 'the plate is on screen: not the case');
    }
  });

  it('puts the band at the bottom edge, with the plate above it, after a call', () => {
    const by = watchDelta(AFTER_A_CALL);
    assert.equal(by, 204 - VIEW.viewBottom);
    assert.ok(AFTER_A_CALL.tableBottom - by > VIEW.viewTop, 'the plate is still above the header');
  });

  it('brings the result in above the band at the end of a hand, as measured after the change', () => {
    const by = watchDelta(HAND_OVER);
    // The summary was at -157..-21; measured after: 252..388, with the band at 517..764.
    assert.deepEqual([-157 - by, -21 - by], [252, 388]);
  });

  it('does not move a reader who can see their plate', () => {
    assert.equal(watchDelta({ bandTop: 505, bandBottom: 617, tableBottom: 468, dealt: false, ...VIEW }), 0);
  });

  it('brings the band up from below, as before, for a reader who pressed Deal at the top', () => {
    assert.equal(
      watchDelta({ bandTop: 1700, bandBottom: 1800, tableBottom: 1690, dealt: true, ...VIEW }),
      1800 - 764,
    );
  });

  it('leaves a reader who scrolled up mid-hand where they are when the hand ends', () => {
    assert.equal(
      watchDelta({ bandTop: 1700, bandBottom: 1800, tableBottom: 1690, dealt: false, ...VIEW }),
      0,
    );
  });
});

describe('the live table uses it, on a narrow column only', () => {
  const wired = (source: string): boolean =>
    /window\.getComputedStyle\(row\)\.position !== 'sticky'\) return null;/u.test(source) &&
    /const sized = sizerScroll\(element\);\s*if \(sized !== null\) \{\s*if \(sized !== 0\) window\.scrollBy\(\{ top: sized,/u.test(
      source,
    );

  it('asks for the sizer scroll before following the buttons, when the row is sticky', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(wired(live), 'useFollowTheTable no longer brings the sizer in on a narrow column');
  });

  const keepsTheGlance = (source: string): boolean =>
    /bar\.querySelector<HTMLElement>\('\.prl-hand-glance'\)\?\.getBoundingClientRect\(\);/u.test(source) &&
    /handTop: hand === undefined \|\| hand\.height === 0 \? null : hand\.top,/u.test(source) &&
    /coverBottom: document\.querySelector\('\.prl-shell__header'\)/u.test(source);

  it('reads the glance, where it is drawn, and the header into the sizer scroll', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(keepsTheGlance(live), 'sizerScroll no longer tells the follow where the reader’s cards are');
  });

  const watches = (source: string): boolean =>
    /const watchEdge = turnEdge === '' \? handEdge : null;/u.test(source) &&
    /const by = watchScroll\(element, dealt\);\s*if \(by !== 0\) window\.scrollBy\(/u.test(source) &&
    /\}, \[watchEdge, band, reduced\]\);/u.test(source);

  it('watches the table on a deal, at the end of the reader’s decision and at the end of the hand', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(watches(live), 'useFollowTheTable no longer brings the table back when the decision is over');
  });

  it('NEGATIVE CONTROL: the old follow, the buttons by the nearest edge only, fails the predicate', () => {
    const old = `    const target = element.querySelector<HTMLElement>('.prl-action-bar__actions') ?? element;
    if (inView(target)) return;
    target.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });`;
    assert.equal(wired(old), false);
    assert.equal(watches(old), false);
    assert.equal(keepsTheGlance(old), false);
  });
});
