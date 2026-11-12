/**
 * A short all-in call is labelled with what the caller matched, not with the price.
 *
 * Found in review on PR #27. `applyAction` keeps the bet level where it was when a caller commits
 * less than it (`betLevel = max(state.betLevel, committedThisStreet)` in
 * `packages/poker-engine/src/machine.ts`), so the logged `betLevelAfter` of a 30-unit stack calling
 * a raise to 100 is 100. The seat plate used that figure and read "called 100" over a seat whose own
 * chips in front of it said 30.
 *
 * Here and not in `@prl/ui`, because this package depends on both: the frame is made by the real
 * engine — `startHand`, `applyAction`, `redactFor`, the same redaction boundary the API sends —
 * rather than typed in, so the test cannot pass by agreeing with a fixture that the engine would
 * never produce.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAction,
  createDeterministicRandomForTests,
  type HandState,
  redactFor,
  startHand,
} from '@prl/poker-engine';
// By path, because `@prl/ui`'s index pulls in its `.tsx` components, which `node --test` cannot load.
import { lastActionsThisStreet } from '../../../packages/ui/src/seat-actions.ts';

/** Four seats, 5/10. Index 3 is under the gun; index 0 is the button, with 30 units and no blind. */
function shortCallFrame(): HandState {
  let state = startHand({
    handId: 'hand-short-call',
    roomId: 'room-short-call',
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: [
      { seat: 0, playerId: 'short', stack: 30 },
      { seat: 1, playerId: 'sb', stack: 1000 },
      { seat: 2, playerId: 'bb', stack: 1000 },
      { seat: 3, playerId: 'utg', stack: 1000 },
    ],
    random: createDeterministicRandomForTests(7),
  }).state;
  assert.equal(state.toAct, 3, 'under the gun acts first preflop four-handed');
  state = applyAction(state, 3, { type: 'raise', to: 100 }).state;
  assert.equal(state.toAct, 0, 'the button is next');
  state = applyAction(state, 0, { type: 'call' }).state;
  return state;
}

describe('a short all-in call, from the real engine', () => {
  const state = shortCallFrame();
  const call = state.actions.at(-1);
  const view = redactFor(state, { viewerPlayerId: 'utg' });

  it('is the case the review described: the level stays at 100, the caller put in 30', () => {
    assert.equal(call?.action.type, 'call');
    assert.equal(call?.amountPaid, 30);
    assert.equal(call?.betLevelAfter, 100, 'the engine no longer keeps the level; this control is stale');
    const caller = view.seats.find((seat) => seat.seat === 0);
    assert.equal(caller?.committedThisStreet, 30);
    assert.equal(caller?.status, 'allIn');
  });

  it('labels the plate with the 30 the seat matched, and says it is all in', () => {
    const plates = lastActionsThisStreet(view);
    assert.equal(plates[0], 'called 30, all in');
    assert.equal(plates[3], 'raised to 100');
  });
});
