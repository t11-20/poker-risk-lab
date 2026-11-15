/**
 * On a phone, a decision with a raise legal brings the sizer into view with the action row under it,
 * not under the row. Scrolling the buttons in by their nearest edge leaves the stuck row painted over
 * the sizer, so a tap on ½ pot sends a min-raise.
 * `sizerFollowDelta` is pure and is driven with rectangles Chrome measured at 390x844 and 360x640.
 * The old geometry is the negative control. `LiveTable.tsx` imports `@prl/ui`, so its wiring is read
 * from source, as `focus-rescues-scroll.test.ts` does.
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

/** 390x844 scroll padding read from `getComputedStyle`: 92px above (header plus air), the peek's 80 below. */
const VIEW = { viewTop: 92, viewBottom: 844 - 80, coverBottom: 77 } as const;
/** The row's own height at 390, and the line it sticks at: the 4rem peek above the bottom edge. */
const ROW_HEIGHT = 169;
const STICKS_BELOW = 844 - 64;

/** Measured before the change, with the row stuck over the sizer and no cards drawn. */
const BEFORE: SizerGeometry = {
  regionTop: 557,
  priceTop: null,
  handTop: null,
  streetBottom: null,
  sizerTop: 624,
  sizerBottom: 992,
  controlsBottom: 624 + 233,
  rowTop: 611,
  rowStuckTop: STICKS_BELOW - ROW_HEIGHT,
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
    priceTop: geometry.priceTop === null ? null : geometry.priceTop - delta,
    handTop: geometry.handTop === null ? null : geometry.handTop - delta,
    streetBottom: geometry.streetBottom === null ? null : geometry.streetBottom - delta,
    sizerTop: geometry.sizerTop - delta,
    sizerBottom: geometry.sizerBottom - delta,
    controlsBottom: geometry.controlsBottom - delta,
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
    // What was measured in Chrome after the change, on the same shape of decision.
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
 * The reader's cards and the board stay on screen while they size a bet. The first follow took them
 * off the top, so the bar draws `HandGlance` and the follow keeps it in view. Each fixture is the
 * layout Chrome measured after the change, placed where a deal leaves it (sizer at 624, as in `BEFORE`).
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
    priceTop: 106 + 411,
    handTop: 156 + 411,
    streetBottom: 77 + 411,
    sizerTop: 213 + 411,
    sizerBottom: 580 + 411,
    controlsBottom: 446 + 411,
    rowTop: STICKS_BELOW - ROW_HEIGHT,
    rowStuckTop: STICKS_BELOW - ROW_HEIGHT,
    rowFlowBottom: 757 + 411,
    ...VIEW,
  };
  /** 360x640: 92px above, the peek's 80 below, the row sticking 64px above the bottom edge. */
  const VIEW_360 = { viewTop: 92, viewBottom: 640 - 80, coverBottom: 77 } as const;
  const AT_360: SizerGeometry = {
    regionTop: -7 + 475,
    priceTop: 43 + 475,
    handTop: 92 + 475,
    streetBottom: 14 + 475,
    sizerTop: 149 + 475,
    sizerBottom: 538 + 475,
    controlsBottom: 234 + 149 + 475,
    rowTop: 640 - 64 - ROW_HEIGHT,
    rowStuckTop: 640 - 64 - ROW_HEIGHT,
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

/**
 * The price row is what the reader decides on, so it stays below the header too. At 360x780 the region
 * is 97px taller than the view, and the follow put the glance at the top edge with the price at 42..80,
 * under a header ending at 77, at every decision. Measured in Chrome as the follow left it: street
 * -8..13, price 42..80, glance 92..183, sizer 195..562 with its slider and field ending at 428, row
 * stuck at 547..716, the note at 739.
 */
describe('the price row stays below the header while a phone sizes a bet', () => {
  const at360 = (lower: number): SizerGeometry => ({
    regionTop: -8 + lower,
    priceTop: 42 + lower,
    handTop: 92 + lower,
    streetBottom: 13 + lower,
    sizerTop: 195 + lower,
    sizerBottom: 562 + lower,
    controlsBottom: 428 + lower,
    rowTop: 547,
    rowStuckTop: 547,
    rowFlowBottom: 739 + lower,
    viewTop: 92,
    viewBottom: 780 - 80,
    coverBottom: 77,
  });

  it('NEGATIVE CONTROL: as the follow left it, the price is under the header', () => {
    assert.ok((at360(0).priceTop ?? 0) < at360(0).coverBottom);
  });

  it('at 360x780 puts the price at the top edge, with the controls clear of the stuck row', () => {
    // From where the deal leaves the band, and from where the old follow left it.
    for (const lower of [500, 0]) {
      const at = at360(lower);
      const delta = sizerFollowDelta(at);
      assert.equal((at.priceTop ?? 0) - delta, 92, `the price is at ${(at.priceTop ?? 0) - delta}`);
      assert.equal(at.handTop === null ? null : at.handTop - delta, 142, 'the glance is not under the price');
      assert.ok(at.controlsBottom - delta <= at.rowStuckTop, 'the field is under the stuck row');
    }
  });
});

/**
 * A call or fold has no sizer, so the stuck row must clear the price and the glance instead. On the first
 * decision of a hand, following the row by its nearest edge left it stuck over the price: at 390x844
 * price 683..720 under a row at 691..780, and at 360x780 price 619..657 under a row at 627..716.
 */
describe('a decision without a sizer keeps the price and the glance clear of the stuck row', () => {
  const ROW = 89;
  /** As Chrome measured it after the change: price top, glance, note top, viewport height, and the scroll. */
  type Measured = readonly [number, readonly [number, number], number, number, number];
  const AT_390: Measured = [537, [586, 667], 764, 844, 146];
  const AT_360: Measured = [472, [522, 603], 700, 780, 147];
  /** At 360x780 in a band held from a sized decision, with the street line at 21..63 under the header. */
  const HELD_360: Measured = [92, [142, 223], 320, 780, 0];
  const placed = ([price, glance, note, height, scrolled]: Measured, by = scrolled): SizerGeometry => ({
    regionTop: price + by,
    priceTop: price + by,
    handTop: glance[0] + by,
    streetBottom: null,
    sizerTop: glance[0] + by,
    sizerBottom: glance[1] + by,
    controlsBottom: glance[1] + by,
    rowTop: Math.min(note + by - 4, height - 64) - ROW,
    rowStuckTop: height - 64 - ROW,
    rowFlowBottom: note + by,
    viewTop: 92,
    viewBottom: height - 80,
    coverBottom: 77,
  });

  it('NEGATIVE CONTROL: as the nearest edge left it, the row is painted over the price', () => {
    assert.equal(rowCoversSizer({ rowTop: 691, sizerBottom: 720 }), true);
    assert.equal(rowCoversSizer({ rowTop: 627, sizerBottom: 657 }), true);
    assert.deepEqual([placed(AT_390).priceTop, placed(AT_360).priceTop], [683, 619], 'not as measured');
  });

  it('puts the row in flow at the bottom edge, with the price and the glance above it', () => {
    for (const m of [AT_390, AT_360]) {
      const delta = sizerFollowDelta(placed(m));
      assert.equal(delta, m[4], 'not moved to where Chrome measured it');
      const after = placed(m, 0);
      assert.ok((after.priceTop ?? 0) >= after.viewTop, 'the price is under the header');
      assert.equal(rowCoversSizer(after), false, `the glance ends under a row at ${after.rowTop}`);
      assert.equal(after.rowFlowBottom, after.viewBottom, 'the row is not in flow at the bottom edge');
      assert.equal(sizerFollowDelta(after), 0, 'a second follow moves it');
    }
  });

  it('NEGATIVE CONTROL: keeping the street line moves a held band 71px, and the next sized decision back', () => {
    assert.equal(sizerFollowDelta({ ...placed(HELD_360), regionTop: 21 }), -71);
  });

  it('leaves a held band where the sized decision put it', () => {
    assert.equal(sizerFollowDelta(placed(HELD_360)), 0);
  });
});

/** As `scrolled`, for 360x640: the row sticks 64px above a 640px bottom edge. */
function scrolled360(geometry: SizerGeometry, delta: number): SizerGeometry {
  const moved = scrolled(geometry, delta);
  const rowBottom = Math.min(moved.rowFlowBottom - 4, 640 - 64);
  return { ...moved, rowTop: rowBottom - ROW_HEIGHT };
}

/**
 * Once the decision is over, the table comes back. Measured at 390x844 with only the sizer follow:
 * after a call the plate was at -146..55, and at the end of a hand the result was at -157..-21.
 */
describe('when the decision is not the reader’s, the table is watched', () => {
  const AFTER_A_CALL: WatchGeometry = {
    bandTop: 92,
    bandBottom: 204,
    tableBottom: 55,
    edge: 'decided',
    ...VIEW,
  };
  const HAND_OVER: WatchGeometry = {
    bandTop: 108,
    bandBottom: 355,
    tableBottom: -169,
    edge: 'complete',
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
    assert.equal(
      watchDelta({ bandTop: 505, bandBottom: 617, tableBottom: 468, edge: 'decided', ...VIEW }),
      0,
    );
  });

  it('brings the band up from below, as before, for a reader who pressed Deal at the top', () => {
    assert.equal(
      watchDelta({ bandTop: 1700, bandBottom: 1800, tableBottom: 1690, edge: 'dealt', ...VIEW }),
      1800 - 764,
    );
  });

  it('leaves a reader who scrolled up mid-hand where they are when the hand ends', () => {
    assert.equal(
      watchDelta({ bandTop: 1700, bandBottom: 1800, tableBottom: 1690, edge: 'complete', ...VIEW }),
      0,
    );
  });

  /**
   * The result lands between the plate and the band at the end of a hand and pushes Deal off the bottom.
   * Measured before the change, with the plate on screen: at 390x844 the band at 876..1032 with Deal at
   * 959..1003; at 360x780 the band at 1004..1160 with Deal at 1087..1131.
   */
  it('brings the deal control into view at the end of a hand, for a reader who can see their plate', () => {
    const ends: readonly [WatchGeometry, number, number][] = [
      [{ bandTop: 876, bandBottom: 1032, tableBottom: 479, edge: 'complete', ...VIEW }, 959, 1003],
      [
        { bandTop: 1004, bandBottom: 1160, tableBottom: 551, edge: 'complete', viewTop: 92, viewBottom: 700 },
        1087,
        1131,
      ],
    ];
    for (const [at, dealTop, dealBottom] of ends) {
      const by = watchDelta(at);
      assert.equal(by, at.bandBottom - at.viewBottom, 'the band is not at the bottom edge');
      assert.ok(dealTop - by >= at.viewTop && dealBottom - by <= at.viewBottom, `Deal at ${dealTop - by}`);
    }
  });

  it('leaves a band that ends below the view alone after a decision mid-hand', () => {
    assert.equal(
      watchDelta({ bandTop: 876, bandBottom: 1032, tableBottom: 479, edge: 'decided', ...VIEW }),
      0,
    );
  });
});

/**
 * Between the reader's decisions the band keeps the height it had at the decision, and the glance in it
 * shows the board and the latest action, so the page stays put. Measured at 390x844 before the change:
 * a call took the sizer and the row out, the band shrank to 40..152 with the plate ending at 3, the
 * watch scrolled 612px up, and the next decision's follow scrolled about 600px back down.
 */
describe('between the reader’s decisions the page stays where the decision left it', () => {
  const WAITING: WatchGeometry = { bandTop: 40, bandBottom: 152, tableBottom: 3, edge: 'decided', ...VIEW };

  it('NEGATIVE CONTROL: with the band released, the watch moves the page 612px up, as measured', () => {
    assert.equal(watchDelta(WAITING), -612);
  });

  it('does not move the page while the band is held', () => {
    // As measured (the shrunk band) and as held (its 841px at the decision).
    assert.equal(watchDelta({ ...WAITING, edge: 'held' }), 0);
    assert.equal(watchDelta({ ...WAITING, bandBottom: 40 + 841, edge: 'held' }), 0);
  });
});

describe('the live table uses it, on a narrow column only', () => {
  const wired = (source: string): boolean =>
    /window\.getComputedStyle\(row\)\.position !== 'sticky'\) return null;/u.test(source) &&
    /const sized = stuckRowScroll\(element\);\s*if \(sized !== null\) \{[\s\S]*?if \(sized !== 0\) window\.scrollBy\(\{ top: sized,/u.test(
      source,
    );

  it('asks for the sizer scroll before following the buttons, when the row is sticky', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(wired(live), 'useFollowTheTable no longer brings the sizer in on a narrow column');
  });

  const keepsTheGlance = (source: string): boolean =>
    /const drawn = hand !== undefined && hand\.height > 0;/u.test(source) &&
    /handTop: drawn \? hand\.top : null,/u.test(source) &&
    /priceTop: price === null \? null : price\.getBoundingClientRect\(\)\.top,/u.test(source) &&
    /coverBottom: document\.querySelector\('\.prl-shell__header'\)/u.test(source);

  it('reads the glance, where it is drawn, and the header into the sizer scroll', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(keepsTheGlance(live), 'stuckRowScroll no longer tells the follow where the reader’s cards are');
  });

  const watches = (source: string): boolean =>
    /const watchEdge = turnEdge === '' \? handEdge : null;/u.test(source) &&
    /dealt \? 'dealt' : watchEdge\.endsWith\(':true'\) \? 'complete' : 'decided',\s*\);\s*if \(by !== 0\) window\.scrollBy\(/u.test(
      source,
    ) &&
    /\}, \[watchEdge, band, reduced\]\);/u.test(source);

  it('watches the table on a deal, at the end of the reader’s decision and at the end of the hand', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(watches(live), 'useFollowTheTable no longer brings the table back when the decision is over');
  });

  const holds = (source: string): boolean =>
    /if \(element\.querySelector\('\.prl-sizer'\) !== null\) \{\s*held\.current = handEdge;\s*element\.style\.minBlockSize = `\$\{element\.getBoundingClientRect\(\)\.height\}px`;/u.test(
      source,
    ) &&
    /const holding = held\.current === watchEdge;\s*if \(!holding\) \{\s*held\.current = null;\s*element\.style\.minBlockSize = '';/u.test(
      source,
    ) &&
    /watchScroll\(\s*element,\s*holding \? 'held'/u.test(source);

  it('holds the band from a sized decision until the hand’s edge changes, and the watch then holds still', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(holds(live), 'useFollowTheTable no longer holds the band between the reader’s decisions');
  });

  // Standing up clears the hand edge, so the watch, which needs one, never runs to release the hold.
  const releasesWithoutASeat = (source: string): boolean =>
    /if \(handEdge !== null \|\| held\.current === null\) return;\s*held\.current = null;\s*if \(band\.current !== null\) band\.current\.style\.minBlockSize = '';\s*\}, \[handEdge, band\]\);/u.test(
      source,
    );

  it('releases the held band when the reader stands up or loses the table', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(
      releasesWithoutASeat(live),
      'a reader who stands up after a sized decision keeps a tall empty band',
    );
    assert.equal(releasesWithoutASeat('  }, [watchEdge, band, reduced]);'), false);
  });

  const glancesWhileLive = (source: string): boolean =>
    /if \(hole === null \|\| view\.street === 'complete'\) return null;\s*return \(\s*<HandGlance/u.test(
      source,
    );

  it('draws the glance from the deal to the end of the hand, at a decision with no sizer too', () => {
    const stage = readFileSync(join(SRC, 'components', 'TableStage.tsx'), 'utf8');
    assert.ok(glancesWhileLive(stage), 'a call or fold is decided without the reader’s cards on screen');
  });

  // At a decision with no sizer the price is what the stuck row must clear, so the follow still measures.
  const followsWithoutASizer = (source: string): boolean =>
    /if \(bar == null \|\| row == null\) return null;\s*if \(window\.getComputedStyle\(row\)\.position !== 'sticky'\) return null;/u.test(
      source,
    ) &&
    /const first = \(sizer === null \? price : street\) \?\? bar;/u.test(source) &&
    /const under = \(sizer \?\? \(drawn \? glance : null\) \?\? price \?\? bar\)\.getBoundingClientRect\(\);/u.test(
      source,
    );

  it('keeps the price and the glance clear of the stuck row at a decision with no sizer', () => {
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    assert.ok(
      followsWithoutASizer(live),
      'a call or fold brings the row in by its nearest edge, over the price',
    );
  });

  it('NEGATIVE CONTROL: the old follow, the buttons by the nearest edge only, fails the predicate', () => {
    const old = `    const target = element.querySelector<HTMLElement>('.prl-action-bar__actions') ?? element;
    if (inView(target)) return;
    target.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });`;
    assert.equal(wired(old), false);
    assert.equal(watches(old), false);
    assert.equal(keepsTheGlance(old), false);
    const unheld = `    const element = band.current;
    if (element === null || typingElsewhere(element)) return;
    const by = watchScroll(element, dealt ? 'dealt' : watchEdge.endsWith(':true') ? 'complete' : 'decided');`;
    assert.equal(holds(unheld), false);
    const sizingOnly = `  if (!view.legalActions.some((action) => action.type === 'bet' || action.type === 'raise')) return null;`;
    assert.equal(glancesWhileLive(sizingOnly), false);
    const sizedOrWaiting = `  if (hole === null) return null;
  const waiting = view.legalActions.length === 0 && view.street !== 'complete';
  if (!waiting && !view.legalActions.some((action) => action.type === 'bet' || action.type === 'raise')) {
    return null;
  }
  return (
    <HandGlance`;
    assert.equal(glancesWhileLive(sizedOrWaiting), false);
    // The source as it is, with only the guard each predicate exists for taken out.
    const live = readFileSync(join(SRC, 'app', 'play', 'LiveTable.tsx'), 'utf8');
    const sizerOnly = live.replace(
      'if (bar == null || row == null)',
      'if (bar == null || sizer == null || row == null)',
    );
    assert.notEqual(sizerOnly, live);
    assert.equal(followsWithoutASizer(sizerOnly), false);
    const keepsTheStreet = live.replace('(sizer === null ? price : street) ?? bar', 'street ?? bar');
    assert.notEqual(keepsTheStreet, live);
    assert.equal(followsWithoutASizer(keepsTheStreet), false);
    const holdsAtEveryDecision = live.replace("if (element.querySelector('.prl-sizer') !== null) {", '{');
    assert.notEqual(holdsAtEveryDecision, live);
    assert.equal(holds(holdsAtEveryDecision), false);
  });
});
