/**
 * A live view shows a side pot only when one exists. `redactFor` used `buildPots`, which is correct
 * only at settlement and turned uncalled bets and unequal blinds into phantom side pots. 947 of 1,446
 * decision points (65%) in a live-table fuzz showed a multi-layer pot with nobody all in.
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
  // Mid-street the bettor's higher committedTotal is an uncalled bet, not a layer boundary.
  // Actions follow the engine's `toAct`. The helper's default big blind is 2.
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
  // A short stack all in for less than others can wager is a real layer boundary.
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
  // A folded seat once reported the full bet level as "to call" (6,772 times in an engine fuzz),
  // because `betting.ts`'s `amountToCall` has no status check.
  const { state } = deal({ stacks: [1000, 1000, 1000] });
  const folder = state.toAct;
  assert.ok(folder !== null);
  let live = applyAction(state, folder, { type: 'fold' }).state;

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

  // The seat still to act is still quoted a price, so the field was not zeroed for everyone.
  if (live.toAct !== null) {
    const active = redactFor(live, { viewerSeat: live.toAct });
    assert.ok(active.amountToCall > 0, 'the seat to act must still be told what it costs');
  }
});
