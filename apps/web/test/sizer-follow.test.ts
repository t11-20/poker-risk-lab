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
import { rowCoversSizer, type SizerGeometry, sizerFollowDelta } from '../src/lib/follow-the-table.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** 390x844: 77px of sticky header above, the Coach peek's 80px of scroll padding below. */
const VIEW = { viewTop: 77, viewBottom: 844 - 80 } as const;
/** The row's own height at 390, and the line it sticks at: the 4rem peek above the bottom edge. */
const ROW_HEIGHT = 169;
const STICKS_BELOW = 844 - 64;

/** Measured before the change: the row stuck over the sizer. */
const BEFORE: SizerGeometry = {
  regionTop: 557,
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
    // 360x640: 640 - 77 - 80 = 483px of view for a region of about 610px.
    const short: SizerGeometry = { ...BEFORE, viewTop: 77, viewBottom: 640 - 80 };
    const delta = sizerFollowDelta(short);
    assert.equal(delta, short.sizerTop - 77, 'the sizer’s top is not at the top edge');
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

  it('NEGATIVE CONTROL: the old follow, the buttons by the nearest edge only, fails the predicate', () => {
    const old = `    const target = element.querySelector<HTMLElement>('.prl-action-bar__actions') ?? element;
    if (inView(target)) return;
    target.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });`;
    assert.equal(wired(old), false);
  });
});
