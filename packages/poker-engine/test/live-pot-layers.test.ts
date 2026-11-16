/**
 * A live view shows a side pot only when one exists. Layering every committed chip mid-street turned
 * uncalled bets, unequal blinds and unmatched all-ins into phantom side pots.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legalActions } from '../src/betting.ts';
import { applyAction } from '../src/machine.ts';
import { redactFor } from '../src/redact.ts';
import type { HandState, Pot } from '../src/types.ts';
import { bet, call, check, deal, fold, play, raise } from './helpers.ts';

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
  // `betting.ts`'s `amountToCall` has no status check, so a folded seat would report the full bet level.
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

const layers = (pots: readonly Pot[]) => pots.map((pot) => [pot.amount, [...pot.eligibleSeats]]);
const blinds = { smallBlind: 5, bigBlind: 10 };

test('an all-in bet nobody has called yet is not a side pot (REGRESSION)', () => {
  // The audit spot: 536 in the middle, a river shove of 764 into hero's 764.
  const { state } = deal({ stacks: [1000, 1000, 1000], config: blinds });
  const river = play(state, [
    ...[raise(0, 64), call(1), call(2)],
    ...[bet(1, 172), call(2), fold(0)],
    ...[check(1), check(2)],
    ...[check(1), bet(2, 764)],
  ]);
  assert.equal(river.toAct, 1);
  const view = redactFor(river, { viewerSeat: 1 });
  assert.equal(view.potTotal, 1300);
  assert.deepEqual(layers(view.pots), [[1300, [1, 2]]]);
});

test('two equal all-ins facing an equal stack make no side pot (REGRESSION)', () => {
  // 1,713 before the flop, two shoves of 479 and hero to act with 479.
  const { state } = deal({ stacks: [1000, 1000, 1000, 1000], config: blinds });
  const flop = play(state, [
    ...[raise(3, 150), call(0), raise(1, 521), call(2), call(3), fold(0)],
    ...[bet(1, 479), call(2)],
  ]);
  assert.equal(flop.toAct, 3);
  const view = redactFor(flop, { viewerSeat: 3 });
  assert.deepEqual(layers(view.pots), [[2671, [1, 2, 3]]]);
});

test('a short all-in becomes a side pot once the street it was matched on closes', () => {
  const { state } = deal({ stacks: [1000, 1000, 300], config: blinds });
  const preflop = play(state, [raise(0, 100), call(1), call(2)]);
  const shortCalled = play(preflop, [bet(1, 400), call(2)]);
  assert.equal(shortCalled.toAct, 0, 'the street is still open');
  assert.deepEqual(layers(redactFor(shortCalled, { viewerSeat: 0 }).pots), [[900, [0, 1, 2]]]);

  const turn = play(shortCalled, [call(0)]);
  assert.equal(turn.street, 'turn');
  assert.deepEqual(layers(redactFor(turn, { viewerSeat: 0 }).pots), [
    [900, [0, 1, 2]],
    [400, [0, 1]],
  ]);

  // A bet on a later street sits with the side pot its bettors contest, not in a layer of its own.
  const turnBet = play(turn, [bet(1, 100)]);
  assert.deepEqual(layers(redactFor(turnBet, { viewerSeat: 0 }).pots), [
    [900, [0, 1, 2]],
    [500, [0, 1]],
  ]);
});
