import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legalActions, mayRaise, minimumRaiseTo } from '../src/betting.ts';
import { applyAction } from '../src/machine.ts';
import { assignBlinds, firstToActPostflop, firstToActPreflop, positionLabels } from '../src/positions.ts';
import { bet, call, check, chipsInSystem, config, deal, fold, play, raise } from './helpers.ts';

test('blinds are posted and the first raise must reach 2 big blinds', () => {
  // 6-max, button seat 0, so SB = 1, BB = 2, UTG = 3.
  const { state } = deal({ stacks: [200, 200, 200, 200, 200, 200], buttonSeat: 0 });
  const sb = state.seats.find((s) => s.seat === 1);
  const bb = state.seats.find((s) => s.seat === 2);
  assert.equal(sb?.committedThisStreet, 1);
  assert.equal(bb?.committedThisStreet, 2);
  assert.equal(state.betLevel, 2);
  assert.equal(state.toAct, 3, 'UTG acts first preflop');
  assert.equal(minimumRaiseTo(state), 4, 'the big blind counts as a full bet, so min raise is to 2 BB');

  const legal = legalActions(state, 3);
  const raiseOption = legal.find((entry) => entry.type === 'raise');
  assert.equal(raiseOption?.minTo, 4);
  assert.equal(raiseOption?.maxTo, 200);
  assert.ok(legal.some((entry) => entry.type === 'call'));
  assert.ok(!legal.some((entry) => entry.type === 'check'), 'cannot check facing the big blind');
});

test('a raise sets the minimum for the next raise by increment, not by doubling', () => {
  const { state } = deal({ stacks: [200, 200, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  // Button 0 → SB 1, BB 2, UTG 3 acts first.
  const afterRaise = play(state, [raise(3, 20)]);
  assert.equal(afterRaise.betLevel, 20);
  assert.equal(afterRaise.lastFullRaiseIncrement, 18, 'increment is 20 - 2');
  assert.equal(minimumRaiseTo(afterRaise), 38, 'next raise must reach 20 + 18, not 40');

  const raiseOption = legalActions(afterRaise, 0).find((entry) => entry.type === 'raise');
  assert.equal(raiseOption?.minTo, 38);
  assert.throws(() => applyAction(afterRaise, 0, { type: 'raise', to: 37 }), /below the minimum of 38/);
  const legalRaise = applyAction(afterRaise, 0, { type: 'raise', to: 38 });
  assert.equal(legalRaise.state.betLevel, 38);
});

test('the big blind has the option to raise when everyone limps', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  // Button 0, SB 1, BB 2. First to act is seat 0 (three-handed: button is UTG).
  assert.equal(state.toAct, 0);
  const afterLimps = play(state, [call(0), call(1)]);
  assert.equal(afterLimps.street, 'preflop', 'the BB still has the option');
  assert.equal(afterLimps.toAct, 2);
  const legal = legalActions(afterLimps, 2);
  assert.ok(
    legal.some((entry) => entry.type === 'check'),
    'BB may check',
  );
  assert.ok(
    legal.some((entry) => entry.type === 'raise'),
    'BB may raise',
  );

  const afterCheck = play(afterLimps, [check(2)]);
  assert.equal(afterCheck.street, 'flop', 'checking the option ends the street');
  assert.equal(afterCheck.board.length, 3);
});

test('heads-up: the button posts the small blind, acts first preflop and last postflop', () => {
  const { state } = deal({ stacks: [200, 200], buttonSeat: 0, config: { maxSeats: 2 } });
  const blinds = assignBlinds(0, 2, [0, 1]);
  assert.equal(blinds.smallBlindSeat, 0, 'heads-up button is the small blind');
  assert.equal(blinds.bigBlindSeat, 1);
  assert.ok(blinds.isHeadsUp);
  assert.equal(firstToActPreflop(0, 2, [0, 1]), 0, 'button acts first preflop');
  assert.equal(firstToActPostflop(0, 2, [0, 1]), 1, 'big blind acts first postflop');
  assert.equal(state.toAct, 0);

  const labels = positionLabels(0, 2, [0, 1]);
  assert.equal(labels.get(0), 'BTN/SB');
  assert.equal(labels.get(1), 'BB');

  const flop = play(state, [call(0), check(1)]);
  assert.equal(flop.street, 'flop');
  assert.equal(flop.toAct, 1, 'big blind is first to act on the flop');
});

test('a player who raises cannot raise again until someone else raises', () => {
  const { state } = deal({ stacks: [200, 200, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  const afterRaise = play(state, [raise(3, 20)]);
  const raiser = afterRaise.seats.find((s) => s.seat === 3);
  assert.ok(raiser !== undefined);
  assert.equal(
    raiser.lastActedAtBetLevel,
    20,
    'the raiser records the level it created, not the level it faced',
  );
  assert.equal(afterRaise.lastFullRaiseBetLevel, 20);
  assert.ok(!mayRaise(afterRaise, raiser), 'a player may not re-raise its own raise');
});

test('TWO short all-ins DO reopen the action when their increments add to a full raise', () => {
  /**
   * The half of TDA 43-C that `mayRaise` used to be missing.
   *
   * The rule is not "a short all-in never reopens". It is that an all-in of less than a full
   * raise does not reopen the betting to a player who has already acted **and is not facing at
   * least a full raise when the action returns to him**. One short all-in cannot clear that bar,
   * which is what the test above pins down and why keying only on `lastFullRaiseBetLevel` looked
   * complete. Two consecutive short all-ins can, because their increments add.
   *
   * Seats: 0 BTN (1000), 1 SB (150 — short), 2 BB (220 — short), 3 UTG (1000).
   *   UTG raises to 100   → complete. Increment 98, so a full re-raise must reach 198.
   *   BTN calls 100       → has now acted at the full-raise level.
   *   SB shoves to 150    → +50, short of 198. Not a complete raise.
   *   BB shoves to 220    → +70, short of 248. Also not a complete raise.
   *   Back to UTG         → acted at 100, now facing 220. The increase is 120, against a full
   *                         raise of 98. It IS facing a full raise, so it may re-raise.
   *
   * Against the unfixed code both UTG and BTN were offered only call and fold, with a live
   * opponent still holding 780 behind. A 30,000-hand fuzz put the rate at 44 wrongly-denied
   * raises across 34 hands.
   */
  const { state } = deal({ stacks: [1000, 150, 220, 1000], buttonSeat: 0, config: { maxSeats: 4 } });
  let current = play(state, [raise(3, 100), call(0)]);
  assert.equal(current.lastFullRaiseBetLevel, 100);
  assert.equal(current.lastFullRaiseIncrement, 98);

  current = applyAction(current, 1, { type: 'raise', to: 150 }).state;
  current = applyAction(current, 2, { type: 'raise', to: 220 }).state;
  assert.equal(current.betLevel, 220);
  assert.equal(current.lastFullRaiseBetLevel, 100, 'neither all-in was a complete raise');

  // UTG acted at 100 and faces 220: an increase of 120 >= the full raise of 98.
  assert.equal(current.toAct, 3);
  const utg = current.seats.find((entry) => entry.seat === 3);
  assert.ok(utg !== undefined);
  assert.equal(mayRaise(current, utg), true);
  const utgOptions = legalActions(current, 3);
  assert.ok(
    utgOptions.some((entry) => entry.type === 'raise'),
    'two short all-ins together are a full raise, so the action is reopened',
  );
  // And the reopened minimum is the ordinary one, measured from the current level.
  assert.equal(minimumRaiseTo(current), 318);
  const raised = applyAction(current, 3, { type: 'raise', to: 318 });
  assert.equal(raised.state.betLevel, 318);

  // The negative control that keeps this honest: a seat facing LESS than a full raise since it
  // acted is still refused. Same shape, one short all-in short of the bar.
  const { state: near } = deal({ stacks: [1000, 150, 200, 1000], buttonSeat: 0, config: { maxSeats: 4 } });
  let short = play(near, [raise(3, 100), call(0)]);
  short = applyAction(short, 1, { type: 'raise', to: 150 }).state;
  assert.equal(short.betLevel, 150);
  assert.equal(short.toAct, 2);
  const bbOptions = legalActions(short, 2);
  assert.ok(
    bbOptions.some((entry) => entry.type === 'raise'),
    'the BB has not acted, so it may raise',
  );
  short = applyAction(short, 2, { type: 'call' }).state;
  // UTG acted at 100 and faces 150: an increase of 50, short of the full raise of 98.
  assert.equal(short.toAct, 3);
  const utgShort = short.seats.find((entry) => entry.seat === 3);
  assert.ok(utgShort !== undefined);
  assert.equal(mayRaise(short, utgShort), false);
  assert.ok(!legalActions(short, 3).some((entry) => entry.type === 'raise'));
});

test('a short all-in raise does NOT reopen the action for a player who already acted', () => {
  // Seats: 0 BTN (200), 1 SB (30 — the short stack), 2 BB (200), 3 UTG (200).
  //
  // The sequence that isolates the rule:
  //   UTG raises to 20  → a complete raise. Increment 18, so a full re-raise
  //                       would have to reach 38.
  //   BTN calls 20      → BTN has now acted AT the current full-raise level.
  //   SB shoves to 30   → only +10, short of 38. It lifts the bet level but is
  //                       NOT a complete raise.
  //   BB (yet to act)   → its right to raise is untouched.
  //   BTN and UTG       → owe the extra 10, but must NOT be offered a raise.
  const { state } = deal({ stacks: [200, 30, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  let current = play(state, [raise(3, 20), call(0)]);
  assert.equal(current.lastFullRaiseBetLevel, 20);
  assert.equal(current.lastFullRaiseIncrement, 18);
  assert.equal(current.toAct, 1);

  current = applyAction(current, 1, { type: 'raise', to: 30 }).state;
  assert.equal(current.betLevel, 30, 'the bet level rises to the all-in amount');
  assert.equal(current.lastFullRaiseBetLevel, 20, 'but a short all-in is not a complete raise');
  assert.equal(current.seats.find((s) => s.seat === 1)?.status, 'allIn');

  // The big blind has not acted this street, so its right to raise is intact.
  assert.equal(current.toAct, 2);
  assert.ok(
    legalActions(current, 2).some((entry) => entry.type === 'raise'),
    'the BB has not acted yet, so it may still raise',
  );
  current = play(current, [call(2)]);

  // Back to UTG, which acted at level 20 — the current full-raise level.
  assert.equal(current.toAct, 3);
  const utgOptions = legalActions(current, 3);
  assert.ok(
    utgOptions.some((entry) => entry.type === 'call'),
    'may call the extra 10',
  );
  assert.ok(
    utgOptions.some((entry) => entry.type === 'fold'),
    'may fold',
  );
  assert.ok(
    !utgOptions.some((entry) => entry.type === 'raise'),
    'may NOT raise: the only increase since it acted was a short all-in',
  );
  assert.throws(() => applyAction(current, 3, { type: 'raise', to: 100 }), /may not raise/);

  // The button acted at level 20 too, so it is in the same position.
  const afterUtgCalls = play(current, [call(3)]);
  assert.equal(afterUtgCalls.toAct, 0);
  assert.ok(
    !legalActions(afterUtgCalls, 0).some((entry) => entry.type === 'raise'),
    'the button also already acted at the full-raise level',
  );
});

test('a later COMPLETE raise reopens the action to everyone again', () => {
  const { state } = deal({ stacks: [200, 30, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  let current = play(state, [raise(3, 20), call(0)]);
  current = applyAction(current, 1, { type: 'raise', to: 30 }).state; // short all-in
  // The BB makes a complete raise to 60: increment 30, comfortably over the 18
  // required, so this one does reopen the action.
  current = applyAction(current, 2, { type: 'raise', to: 60 }).state;
  assert.equal(current.lastFullRaiseBetLevel, 60);
  assert.equal(current.toAct, 3);
  assert.ok(
    legalActions(current, 3).some((entry) => entry.type === 'raise'),
    'a complete raise reopens the action for players who had been shut out',
  );
});

test('a player may shove below the minimum raise when that is all they have', () => {
  // Seat 3 raises to 20 out of a 25 stack, leaving 5 behind. Facing 60 it can
  // only reach 25 in total, which is a legal short all-in.
  const { state } = deal({ stacks: [200, 200, 200, 25], buttonSeat: 0, config: { maxSeats: 4 } });
  let current = play(state, [raise(3, 20), raise(0, 60)]);
  // Action passes the blinds before returning to seat 3.
  current = play(current, [fold(1), fold(2)]);
  assert.equal(current.toAct, 3);

  const shortSeat = current.seats.find((s) => s.seat === 3);
  assert.equal(shortSeat?.stack, 5);

  const options = legalActions(current, 3);
  const callOption = options.find((entry) => entry.type === 'call');
  assert.equal(callOption?.costAtMin, 5, 'calling is capped at the remaining stack');
  assert.equal(callOption?.allInAtMax, true);

  // The raise option, if offered, must be capped at the stack — a shove for 25.
  const raiseOption = options.find((entry) => entry.type === 'raise');
  if (raiseOption !== undefined) {
    assert.equal(raiseOption.maxTo, 25, 'a shove reaches exactly the stack');
    assert.equal(raiseOption.minTo, 25, 'the minimum collapses to the shove when the stack cannot reach it');
  }

  // Calling all-in for less than the bet is legal and leaves the seat all-in.
  const after = applyAction(current, 3, { type: 'call' }).state;
  assert.equal(after.seats.find((s) => s.seat === 3)?.status, 'allIn');
  assert.equal(after.seats.find((s) => s.seat === 3)?.committedTotal, 25);
});

test('folding out of turn and acting out of turn are rejected', () => {
  const { state } = deal({ stacks: [200, 200, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  assert.equal(state.toAct, 3);
  assert.throws(() => applyAction(state, 0, { type: 'fold' }), /not seat 0's turn/);
  assert.equal(legalActions(state, 0).length, 0, 'no legal actions when it is not your turn');
});

test('checking when facing a bet is rejected with a useful message', () => {
  const { state } = deal({ stacks: [200, 200, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  assert.throws(() => applyAction(state, 3, { type: 'check' }), /cannot check facing a bet of 2; 2 to call/);
});

test('betting more than the stack is rejected', () => {
  const { state } = deal({ stacks: [200, 200, 200, 30], buttonSeat: 0, config: { maxSeats: 4 } });
  assert.throws(() => applyAction(state, 3, { type: 'raise', to: 31 }), /exceeds your maximum of 30/);
});

test('non-integer and negative bet amounts are rejected', () => {
  const { state } = deal({ stacks: [200, 200, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  assert.throws(() => applyAction(state, 3, { type: 'raise', to: 20.5 }), /integer/);
  assert.throws(() => applyAction(state, 3, { type: 'raise', to: -5 }), /below the minimum/);
  assert.throws(() => applyAction(state, 3, { type: 'raise', to: Number.NaN }), /integer/);
});

test('postflop the minimum bet is one big blind and a raise doubles the increment', () => {
  const { state } = deal({
    stacks: [200, 200],
    buttonSeat: 0,
    config: { maxSeats: 2, bigBlind: 10, smallBlind: 5 },
  });
  const flop = play(state, [call(0), check(1)]);
  assert.equal(flop.street, 'flop');
  assert.equal(flop.betLevel, 0);
  const betOption = legalActions(flop, 1).find((entry) => entry.type === 'bet');
  assert.equal(betOption?.minTo, 10, 'minimum opening bet is one big blind');
  assert.equal(betOption?.maxTo, 190);

  const afterBet = play(flop, [bet(1, 30)]);
  assert.equal(minimumRaiseTo(afterBet), 60, 'raise must reach 30 + 30');
  const raiseOption = legalActions(afterBet, 0).find((entry) => entry.type === 'raise');
  assert.equal(raiseOption?.minTo, 60);
});

test('chips are conserved through an entire hand', () => {
  const { state } = deal({ stacks: [100, 100, 100], buttonSeat: 0, config: { maxSeats: 3 } });
  const before = chipsInSystem(state);
  const finished = play(state, [call(0), call(1), check(2), check(1), check(2), check(0)]);
  // Turn and river checks.
  let current = finished;
  while (current.street !== 'complete') {
    const seat = current.toAct;
    assert.notEqual(seat, null, `stuck on street ${current.street}`);
    if (seat === null) break;
    current = applyAction(current, seat, { type: 'check' }).state;
  }
  assert.equal(current.street, 'complete');
  assert.equal(chipsInSystem(current), before, 'no chips created or destroyed');
  assert.equal(
    current.seats.reduce((sum, seat) => sum + seat.stack, 0),
    before,
    'all chips end up back in stacks',
  );
});

test('when everyone folds the last player standing wins without a showdown', () => {
  const { state } = deal({ stacks: [100, 100, 100], buttonSeat: 0, config: { maxSeats: 3 } });
  const finished = play(state, [fold(0), fold(1)]);
  assert.equal(finished.street, 'complete');
  assert.equal(finished.result?.endedByFold, true);
  assert.equal(finished.result?.showdowns.length, 0, 'no cards are shown');
  const winner = finished.seats.find((seat) => seat.seat === 2);
  assert.equal(winner?.stack, 101, 'BB wins its own 2 back plus the 1 small blind');
  assert.equal(finished.result?.netBySeat[2], 1);
  assert.equal(finished.result?.netBySeat[1], -1);
});

test('a raise reopens the action so a player who already called must act again', () => {
  const { state } = deal({ stacks: [200, 200, 200, 200], buttonSeat: 0, config: { maxSeats: 4 } });
  let current = play(state, [call(3), call(0)]);
  assert.equal(current.toAct, 1, 'small blind acts next');
  current = play(current, [raise(1, 12)]);
  // Everyone who called at level 2 now owes an action again.
  assert.equal(current.toAct, 2);
  current = play(current, [call(2)]);
  assert.equal(current.toAct, 3, 'the original limper must act again after the raise');
  assert.equal(current.street, 'preflop');
});

test('antes are posted before blinds and a player short of the ante goes all-in', () => {
  const { state } = deal({
    stacks: [100, 100, 1],
    buttonSeat: 0,
    config: { maxSeats: 3, ante: 5, smallBlind: 5, bigBlind: 10 },
  });
  const shortSeat = state.seats.find((seat) => seat.seat === 2);
  assert.equal(shortSeat?.committedTotal, 1, 'paid what it could toward the ante');
  assert.equal(shortSeat?.status, 'allIn');
  const anteFor1 = state.forcedBets.find((f) => f.seat === 2 && f.kind === 'ante');
  assert.equal(anteFor1?.wasShort, true);
  assert.equal(anteFor1?.amount, 1);
});

test('legal action bounds never let a player commit more than their stack', () => {
  for (const stack of [3, 7, 15, 99, 100]) {
    const { state } = deal({ stacks: [200, 200, stack], buttonSeat: 0, config: { maxSeats: 3 } });
    for (const seat of [0, 1, 2]) {
      for (const entry of legalActions(state, seat)) {
        const actor = state.seats.find((s) => s.seat === seat);
        assert.ok(actor !== undefined);
        if (entry.maxTo !== undefined) {
          assert.ok(
            entry.maxTo - actor.committedThisStreet <= actor.stack,
            `seat ${seat} maxTo ${entry.maxTo} exceeds stack ${actor.stack}`,
          );
        }
        if (entry.costAtMin !== undefined) {
          assert.ok(entry.costAtMin <= actor.stack, `seat ${seat} costAtMin exceeds stack`);
        }
      }
    }
  }
});

test('config validation rejects nonsense tables', () => {
  assert.throws(() => deal({ stacks: [100, 100], config: { bigBlind: 0 } }), /bigBlind must be a positive/);
  assert.throws(
    () => deal({ stacks: [100, 100], config: { smallBlind: 20, bigBlind: 10 } }),
    /at least smallBlind/,
  );
  assert.throws(() => deal({ stacks: [100], config: { maxSeats: 2 } }), /at least 2 players/);
  assert.throws(
    () => deal({ stacks: [10, 10, 10, 10, 10, 10, 10], config: { maxSeats: 7 } }),
    /maxSeats must be 2..6/,
  );
  assert.equal(config({ ante: 3 }).ante, 3);
});
