/**
 * The table header names the seat to act. The view lists only dealt-in seats, so `toAct` is a chair
 * number and can sit above an empty chair.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadComponent } from './support/render-component.ts';

type View = { toAct: number | null; viewerSeat: number; seats: unknown };
const toActText = (await loadComponent('components/PokerTable', 'toActText')) as unknown as (
  view: View,
) => string;

const seats = [
  { seat: 0, position: 'BTN' },
  { seat: 2, position: 'SB' },
  { seat: 3, position: 'BB' },
  { seat: 5, position: 'CO' },
];

describe('toActText', () => {
  it('names the seat in that chair, past an empty chair below it (REGRESSION)', () => {
    assert.equal(toActText({ toAct: 2, viewerSeat: 0, seats }), 'SB to act');
    assert.equal(toActText({ toAct: 3, viewerSeat: 0, seats }), 'BB to act');
    assert.equal(toActText({ toAct: 5, viewerSeat: 0, seats }), 'CO to act');
  });

  it("says it is the reader's turn, and says nothing when nobody is to act", () => {
    assert.equal(toActText({ toAct: 0, viewerSeat: 0, seats }), 'Your turn');
    assert.equal(toActText({ toAct: null, viewerSeat: 0, seats }), '');
  });
});
