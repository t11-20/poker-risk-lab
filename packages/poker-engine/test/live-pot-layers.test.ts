/**
 * A live view shows a side pot only when one exists.
 *
 * ## The failure this is written against
 *
 * `redactFor` filled `PlayerView.pots` with `buildPots(state.seats)`. `buildPots` layers by
 * `committedTotal` and is correct at SETTLEMENT, the only place it was designed for. Called on a
 * live state it turns an ordinary uncalled bet into a side pot, because mid-street the bettor's
 * `committedTotal` genuinely is higher than everyone else's — and it fires on the very first frame
 * of every hand, because the blinds are unequal.
 *
 * `PokerTable` passes `view.pots` straight to `PotDisplay`, which prints "Main pot N units, plus
 * the side pots below" whenever a second layer exists. Measured over a live-table fuzz before the
 * fix: 947 of 1,446 decision points — 65% — rendered a multi-layer pot with NO seat all in.
 *
 * It is not cosmetic. `PotDisplay`'s header says the layers exist so "a learner needs to see that a
 * side pot is a layer with an eligibility list rather than a bonus", so the concept was being
 * taught with data that was wrong two thirds of the time, and seats still in the hand were shown as
 * ineligible for the main pot. The Coach on the same screen priced the same spot correctly through
 * `contestablePotFor`, so the two halves of the play screen disagreed with each other.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legalActions } from '../src/betting.ts';
import { applyAction } from '../src/machine.ts';
import { redactFor } from '../src/redact.ts';
import type { HandState } from '../src/types.ts';
import { deal } from './helpers.ts';

/** Calls when there is a price and checks when there is not, from the engine's own legal set. */
function continueOnce(state: HandState): HandState {
  const seat = state.toAct;
  if (seat === null) return state;
  const kinds = new Set(legalActions(state, seat).map((legal) => legal.type));
  const type = kinds.has('call') ? 'call' : kinds.has('check') ? 'check' : 'fold';
  return applyAction(state, seat, { type }).state;
}

test('the blinds alone do not make a side pot (REGRESSION)', () => {
  // The first frame of every hand. Unequal blinds, nobody all in, one pot.
  const { state } = deal({ stacks: [1000, 1000, 1000, 1000] });
  const view = redactFor(state, { viewerSeat: 0 });

  assert.equal(view.pots.length, 1, `blinds alone produced ${view.pots.length} layers`);
  const [main] = view.pots;
  assert.ok(main !== undefined);
  assert.equal(main.amount, view.potTotal, 'the single layer holds the whole pot');
  assert.equal(main.index, 0);
  assert.deepEqual(
    [...main.eligibleSeats].sort((a, b) => a - b),
    state.seats.filter((seat) => seat.status !== 'folded').map((seat) => seat.seat),
    'everyone still holding cards is eligible for it',
  );
});

test('an uncalled bet is not a side pot (REGRESSION)', () => {
  // Mid-street the bettor's committedTotal is genuinely higher than everyone else's. That is what
  // an uncalled bet IS; it is not a layer boundary.
  //
  // Actions are driven from the engine's own `toAct` rather than a hand-written seat order. Two of
  // my assumptions were wrong before this worked: the seat order, and the big blind (the helper's
  // default is 2, not 10). `applyAction` also takes (state, seat, action) and returns `{ state }`,
  // not a single options object.
  const { state } = deal({ stacks: [1000, 1000, 1000] });
  let live = state;
  for (let step = 0; step < 3 && live.toAct !== null; step += 1) {
    live = continueOnce(live);
  }
  const bettor = live.toAct;
  assert.ok(bettor !== null, 'somebody must still be to act for this fixture to bet');
  live = applyAction(live, bettor, { type: 'bet', to: 60 }).state;

  assert.ok(
    live.seats.every((seat) => seat.stack > 0 || seat.status === 'folded'),
    'this fixture must have nobody all in for it to test anything',
  );
  const view = redactFor(live, { viewerSeat: 0 });
  assert.equal(view.pots.length, 1, `an uncalled bet produced ${view.pots.length} layers`);
  assert.equal(view.pots[0]?.amount, view.potTotal);
});

test('a real side pot is still layered, so the fix did not just flatten everything', () => {
  // The other direction, and why `buildPots` is still called: a short stack all in for less than
  // the others can wager is a genuine layer boundary with a shorter eligibility list.
  // A stack that cannot even cover the big blind, so the all-in is forced at the deal.
  const { state } = deal({ stacks: [1000, 1000, 1] });
  let live = state;
  for (let step = 0; step < 6 && live.toAct !== null; step += 1) {
    live = continueOnce(live);
  }
  const allIn = live.seats.filter((seat) => seat.stack === 0 && seat.status !== 'folded');
  assert.ok(allIn.length > 0, 'the short stack was not all in; this fixture no longer tests a side pot');

  const view = redactFor(live, { viewerSeat: 0 });
  assert.ok(view.pots.length >= 1, 'a genuine all-in must still produce layers');
  const total = view.pots.reduce((sum, pot) => sum + pot.amount, 0);
  assert.equal(total, view.potTotal, 'the layers must still account for every chip in the middle');
});

test('a folded seat is shown no price to call (REGRESSION)', () => {
  // `PlayerView.amountToCall` promises "0 when nothing is owed". `amountToCall` in `betting.ts`
  // has no status check — right for the betting logic, which only asks about the seat to act, and
  // wrong for a view built for every recipient on every frame. A folded seat keeps its stack and,
  // once the street closes, has `committedThisStreet: 0`, so it reported the full bet level for the
  // rest of the hand. `PokerTable` draws that in the caution tone: "400 units to call", beside an
  // ActionBar correctly saying it is not their turn. 6,772 occurrences in an engine fuzz.
  const { state } = deal({ stacks: [1000, 1000, 1000] });
  const folder = state.toAct;
  assert.ok(folder !== null);
  let live = applyAction(state, folder, { type: 'fold' }).state;

  // Drive on so the street closes and a fresh bet lands with the folder still at the table.
  for (let step = 0; step < 4 && live.toAct !== null; step += 1) live = continueOnce(live);
  const bettor = live.toAct;
  if (bettor !== null) {
    const kinds = new Set(legalActions(live, bettor).map((legal) => legal.type));
    if (kinds.has('bet')) live = applyAction(live, bettor, { type: 'bet', to: 60 }).state;
  }

  const seatState = live.seats.find((seat) => seat.seat === folder);
  assert.equal(seatState?.status, 'folded', 'the fixture must actually have a folded seat');
  assert.ok(live.betLevel > 0, 'and a live bet level, or there is no wrong answer to give');

  const view = redactFor(live, { viewerSeat: folder });
  assert.equal(
    view.amountToCall,
    0,
    `a folded seat was quoted ${view.amountToCall} to call at bet level ${live.betLevel}`,
  );

  // The seat still to act must still be quoted a price, so this did not zero the field for everyone.
  if (live.toAct !== null) {
    const active = redactFor(live, { viewerSeat: live.toAct });
    assert.ok(active.amountToCall > 0, 'the seat to act must still be told what it costs');
  }
});
