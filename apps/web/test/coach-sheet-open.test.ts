/**
 * On a phone the open Coach sheet takes the bottom of the screen and the action row sticks on top of it,
 * so the price and the glance must sit between the header and that row. At a first call they were measured
 * low on the screen, where the open sheet would cover them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CoachOpenGeometry, coachOpenDelta } from '../src/lib/follow-the-table.ts';

/** Price top, glance bottom, viewport height, open sheet height, row height. `viewTop` is 92 at both. */
const at = (
  priceTop: number,
  keepBottom: number,
  viewHeight: number,
  sheet: number,
  row: number,
): CoachOpenGeometry => ({ priceTop, keepBottom, viewTop: 92, rowTop: viewHeight - sheet - row, viewHeight });

describe('opening the Coach sheet keeps the price and the cards above the stuck row', () => {
  it('brings a first call up to the header at 390x844 and 360x780', () => {
    assert.equal(coachOpenDelta(at(537, 667, 844, 444, 89)), 445);
    assert.equal(coachOpenDelta(at(472, 603, 780, 380, 89)), 380);
  });

  it('leaves a held band alone, with the two-row bar of a sized decision', () => {
    assert.equal(coachOpenDelta(at(92, 223, 780, 380, 168)), 0);
    assert.equal(coachOpenDelta(at(92, 223, 844, 444, 168)), 0);
  });

  it('brings the price back out from under the header', () => {
    assert.equal(coachOpenDelta(at(-15, 116, 844, 444, 168)), -107);
  });

  it('does not move a reader whose decision is off the screen', () => {
    assert.equal(coachOpenDelta(at(1700, 1830, 844, 444, 168)), 0);
    assert.equal(coachOpenDelta(at(-400, -270, 844, 444, 168)), 0);
  });
});
