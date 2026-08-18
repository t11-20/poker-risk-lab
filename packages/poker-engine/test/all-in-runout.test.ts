/**
 * All-in run-outs.
 *
 * The rule being tested: betting is over for the hand as soon as no further
 * wagering is possible. That is the case when at most one seat has chips behind AND
 * that seat has nothing left to call. The remaining streets are then dealt with no
 * action at all and the hands are tabled — nobody is asked to check, and nobody is
 * offered a fold, because a seat that is fully paid up and cannot be raised has
 * nothing to give up. Folding there is not a legal action in No-Limit Hold'em.
 *
 * The boundary matters in both directions, so both sides of it are tested here:
 *
 *   lone chipped seat owes NOTHING  → closed. No action requested, board runs out.
 *   lone chipped seat still OWES    → open.  It must be asked, and fold IS legal
 *                                            (it can also call, all-in for less if
 *                                            that is all it has), but it may not
 *                                            raise, because nobody could call.
 *
 * Expected chip movements below are worked out from the pot-layer rules by hand in
 * the comments, not read back from the engine, and every scenario asserts exact
 * chip conservation: the chips on the table before the hand must equal the chips in
 * the stacks after it, to the chip.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBettingClosedForHand, legalActions } from '../src/betting.ts';
import { parseCards } from '../src/cards.ts';
import { applyAction, startHand } from '../src/machine.ts';
import { createDeterministicRandomForTests } from '../src/rng.ts';
import type { Action, HandState, Pot, SeatIndex, SeatState } from '../src/types.ts';
import { call, check, deal, play, raise, stackedDeck } from './helpers.ts';

/**
 * Every chip in the game.
 *
 * While a hand is live the chips are split between stacks and the middle, so both
 * are counted. Once the hand is complete the pot has been paid into the stacks, so
 * the stacks alone are the total — adding commitments then would double-count.
 */
function totalChips(state: HandState): number {
  const inStacks = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  if (state.street === 'complete') return inStacks;
  return inStacks + state.seats.reduce((sum, seat) => sum + seat.committedTotal, 0);
}

/** Nobody may be asked to act, and no seat may be offered anything to do. */
function assertNobodyCanAct(state: HandState, where: string): void {
  assert.equal(state.toAct, null, `${where}: someone is still being asked to act`);
  for (const seat of state.seats) {
    assert.deepEqual(legalActions(state, seat.seat), [], `${where}: seat ${seat.seat} was offered an action`);
  }
}

/** The action types on offer, in the order the engine offers them. */
function offered(state: HandState, seat: number): string[] {
  return legalActions(state, seat).map((entry) => entry.type);
}

/**
 * Every chip awarded must go to a seat the pot layer says is eligible, and when the
 * hand was shown down, to a best hand among that layer's eligible seats.
 */
function assertAwardsGoToEntitledSeats(state: HandState, where: string): void {
  const result = state.result;
  assert.ok(result !== null, `${where}: a complete hand must have a result`);
  const scoreBySeat = new Map(result.showdowns.map((showdown) => [showdown.seat, showdown.score]));
  for (const award of result.awards) {
    // Annotated because `assert.ok` narrows it: an inferred type would be circular.
    const pot: Pot | undefined = result.pots.find((candidate) => candidate.index === award.potIndex);
    assert.ok(pot !== undefined, `${where}: award refers to pot ${award.potIndex}, which does not exist`);
    assert.ok(
      pot.eligibleSeats.includes(award.seat),
      `${where}: pot ${pot.index} paid seat ${award.seat}, which is not eligible for it`,
    );
    const eligibleScores = pot.eligibleSeats
      .map((seat) => scoreBySeat.get(seat))
      .filter((score): score is number => score !== undefined);
    if (eligibleScores.length > 0) {
      const best = Math.max(...eligibleScores);
      assert.equal(
        scoreBySeat.get(award.seat),
        best,
        `${where}: pot ${pot.index} did not go to the best eligible hand`,
      );
    }
  }
}

// Aces against kings, board bricks: seat 0 must win, and no legal action exists
// that could change it once both players are all-in.
const AA_VS_KK_HEADS_UP = stackedDeck({ 0: 'AhAd', 1: 'KsKc' }, [1, 0], 'Qh 8s 2c 4d 9h');

test('heads-up: a call that puts the last opponent all-in runs the board out with no further action', () => {
  // Seat 0 = BTN/SB with 1000, seat 1 = BB with 200. Blinds 5/10.
  const { state } = deal({
    stacks: [1000, 200],
    buttonSeat: 0,
    config: { maxSeats: 2, smallBlind: 5, bigBlind: 10 },
    fixedDeck: AA_VS_KK_HEADS_UP,
  });
  const chipsBefore = totalChips(state);
  assert.equal(chipsBefore, 1200);

  // Button raises to 200; the big blind calls for its whole 200.
  const finished = play(state, [raise(0, 200), call(1)]);

  // One action each and the hand is over: no check, no fold, no third street asked.
  assert.equal(finished.actions.length, 2, 'exactly the two actions that were taken');
  assert.equal(finished.street, 'complete');
  assert.equal(finished.board.length, 5, 'flop, turn and river are all dealt');
  assertNobodyCanAct(finished, 'after the all-in call');
  assert.equal(finished.result?.endedByFold, false, 'an all-in is not a fold-out');
  assert.equal(finished.result?.showdowns.length, 2, 'both hands are tabled');

  // Aces hold: seat 0 wins the 400 pot, so it is up 200 and seat 1 is down 200.
  assert.equal(finished.result?.netBySeat[0], 200);
  assert.equal(finished.result?.netBySeat[1], -200);
  assert.equal(finished.seats.find((seat) => seat.seat === 0)?.stack, 1200);
  assert.equal(finished.seats.find((seat) => seat.seat === 1)?.stack, 0);
  assertAwardsGoToEntitledSeats(finished, 'AA vs KK all-in');
  assert.equal(totalChips(finished), chipsBefore, 'chips conserved exactly');
});

test('a seat that still owes chips to an all-in IS asked to act, and may call or fold but not raise', () => {
  // Seat 0 = BTN/SB with 1000, seat 1 = BB with 200. Seat 0 limps, seat 1 shoves,
  // so seat 0 owes 190 with 990 behind: a genuine live decision.
  const setup = deal({
    stacks: [1000, 200],
    buttonSeat: 0,
    config: { maxSeats: 2, smallBlind: 5, bigBlind: 10 },
    fixedDeck: AA_VS_KK_HEADS_UP,
  });
  const chipsBefore = totalChips(setup.state);
  const facingTheShove = play(setup.state, [call(0), raise(1, 200)]);

  assert.equal(facingTheShove.street, 'preflop');
  assert.equal(facingTheShove.toAct, 0, 'the covering seat must be asked');
  assert.equal(
    isBettingClosedForHand(facingTheShove),
    false,
    'betting is NOT closed while somebody still owes chips',
  );
  assert.deepEqual(
    offered(facingTheShove, 0),
    ['fold', 'call'],
    'call or fold only: a raise could not be called by anyone',
  );
  assert.throws(
    () => applyAction(facingTheShove, 0, { type: 'raise', to: 400 }),
    /nobody to call it/,
    'raising into a table with no chips behind it is rejected',
  );

  // Folding is legal here and costs seat 0 the 10 it limped for.
  const folded = applyAction(facingTheShove, 0, { type: 'fold' }).state;
  assert.equal(folded.street, 'complete');
  assert.equal(folded.result?.endedByFold, true);
  // Seat 1's own 200 is uncontested above seat 0's 10, so the pot it wins is
  // 10 + 200 = 210 and it keeps everything it put in.
  assert.equal(folded.seats.find((seat) => seat.seat === 0)?.stack, 990);
  assert.equal(folded.seats.find((seat) => seat.seat === 1)?.stack, 210);
  assert.equal(totalChips(folded), chipsBefore, 'chips conserved exactly');

  // Calling instead closes the betting and runs the board out in one pass.
  const called = applyAction(facingTheShove, 0, { type: 'call' }).state;
  assert.equal(called.street, 'complete');
  assert.equal(called.board.length, 5);
  assertNobodyCanAct(called, 'after calling the shove');
  assert.equal(called.result?.showdowns.length, 2);
  assert.equal(called.seats.find((seat) => seat.seat === 0)?.stack, 1200, 'aces win the 400');
  assert.equal(totalChips(called), chipsBefore, 'chips conserved exactly');
});

test('betting closing on the flop deals the turn and river with no action', () => {
  // Seat 0 = BTN/SB with 1000, seat 1 = BB with 200. Limp, check, then the big
  // blind shoves its remaining 190 on the flop and is called.
  const { state } = deal({
    stacks: [1000, 200],
    buttonSeat: 0,
    config: { maxSeats: 2, smallBlind: 5, bigBlind: 10 },
    fixedDeck: AA_VS_KK_HEADS_UP,
  });
  const chipsBefore = totalChips(state);
  const flop = play(state, [call(0), check(1)]);
  assert.equal(flop.street, 'flop');
  assert.equal(flop.toAct, 1, 'the big blind acts first postflop');

  const facingTheShove = applyAction(flop, 1, { type: 'bet', to: 190 }).state;
  assert.equal(facingTheShove.seats.find((seat) => seat.seat === 1)?.status, 'allIn');
  assert.equal(facingTheShove.toAct, 0);
  assert.deepEqual(offered(facingTheShove, 0), ['fold', 'call'], 'no raise: nobody could call it');

  const finished = applyAction(facingTheShove, 0, { type: 'call' }).state;
  assert.equal(finished.street, 'complete');
  assert.equal(finished.board.length, 5, 'turn and river dealt without asking anyone');
  assert.equal(finished.actions.length, 4, 'call, check, bet, call — and nothing else');
  assertNobodyCanAct(finished, 'after the flop all-in was called');
  assert.equal(finished.result?.showdowns.length, 2);
  assert.equal(totalChips(finished), chipsBefore, 'chips conserved exactly');
});

test('simultaneous all-ins: three equal stacks shove and the board runs out once', () => {
  // Equal stacks of 100, blinds 5/10, button on seat 0. Three-handed the button
  // acts first preflop. Seat 2 has the best hand, so it must win the single pot.
  const deck = stackedDeck({ 1: '7c8d', 2: 'AhAd', 0: 'KsKc' }, [1, 2, 0], 'Qh 8s 2c 4d 9h');
  const { state } = deal({
    stacks: [100, 100, 100],
    buttonSeat: 0,
    config: { maxSeats: 3, smallBlind: 5, bigBlind: 10 },
    fixedDeck: deck,
  });
  const chipsBefore = totalChips(state);
  assert.equal(chipsBefore, 300);

  const afterTwoShoves = play(state, [raise(0, 100), call(1)]);
  // Seats 0 and 1 are now all-in; seat 2 has chips but still owes 90, so it must
  // be asked — and must not be offered a raise nobody could call.
  assert.equal(afterTwoShoves.toAct, 2);
  assert.equal(isBettingClosedForHand(afterTwoShoves), false);
  assert.deepEqual(offered(afterTwoShoves, 2), ['fold', 'call']);

  const finished = applyAction(afterTwoShoves, 2, { type: 'call' }).state;
  assert.equal(finished.street, 'complete');
  assert.equal(finished.board.length, 5);
  assertNobodyCanAct(finished, 'after the third shove');
  assert.equal(finished.result?.showdowns.length, 3);
  // Equal contributions mean one undivided pot of 300.
  assert.equal(finished.result?.pots.length, 1);
  assert.equal(finished.result?.pots[0]?.amount, 300);
  assert.equal(finished.seats.find((seat) => seat.seat === 2)?.stack, 300, 'aces take the lot');
  assertAwardsGoToEntitledSeats(finished, 'three-way equal all-in');
  assert.equal(totalChips(finished), chipsBefore, 'chips conserved exactly');
});

test('unequal stacks: the covering seat is never asked once it has matched the largest all-in', () => {
  // Seat 0 = BTN with 1000, seat 1 = SB with 50, seat 2 = BB with 120. Blinds 5/10.
  // Seat 0 raises to 120, both blinds call all-in.
  //
  // Layers from the totals (0: 120, 1: 50, 2: 120), all three still holding cards:
  //   cap 50   → 50 x 3 = 150, contested by seats 0, 1 and 2
  //   cap 120  → 70 x 2 = 140, contested by seats 0 and 2
  // Seat 1 has the best hand and takes the 150; seat 2 is second and takes the 140.
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KhKd', 0: '3s5c' }, [1, 2, 0], 'Qh 8s 2c 4d 9h');
  const { state } = deal({
    stacks: [1000, 50, 120],
    buttonSeat: 0,
    config: { maxSeats: 3, smallBlind: 5, bigBlind: 10 },
    fixedDeck: deck,
  });
  const chipsBefore = totalChips(state);
  assert.equal(chipsBefore, 1170);

  const finished = play(state, [raise(0, 120), call(1), call(2)]);
  assert.equal(finished.actions.length, 3, 'seat 0 is never asked to check the run-out');
  assert.equal(finished.street, 'complete');
  assert.equal(finished.board.length, 5);
  assertNobodyCanAct(finished, 'after both blinds called all-in');
  assert.equal(finished.result?.showdowns.length, 3);

  assert.equal(finished.result?.pots.length, 2, 'main pot plus one side pot');
  assert.equal(finished.result?.pots[0]?.amount, 150);
  assert.equal(finished.result?.pots[1]?.amount, 140);
  assert.equal(finished.seats.find((seat) => seat.seat === 0)?.stack, 880, 'keeps the 880 it never bet');
  assert.equal(finished.seats.find((seat) => seat.seat === 1)?.stack, 150);
  assert.equal(finished.seats.find((seat) => seat.seat === 2)?.stack, 140);
  assertAwardsGoToEntitledSeats(finished, 'three-way unequal all-in');
  assert.equal(totalChips(finished), chipsBefore, 'chips conserved exactly');
});

test('the lone chipped seat may be all-in for LESS than an opponent, and still gets its decision', () => {
  // Seat 0 = BTN with 1000, seat 1 = SB with 500, seat 2 = BB with 40. Blinds 5/10.
  // Seat 0 shoves 1000, seat 1 calls all-in for 500. Seat 2 now has chips behind but
  // only 30 of them, against a bet level of 1000: it can call all-in for 40 total or
  // fold, and nothing else.
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KhKd', 0: '3s5c' }, [1, 2, 0], 'Qh 8s 2c 4d 9h');
  const setup = deal({
    stacks: [1000, 500, 40],
    buttonSeat: 0,
    config: { maxSeats: 3, smallBlind: 5, bigBlind: 10 },
    fixedDeck: deck,
  });
  const chipsBefore = totalChips(setup.state);
  assert.equal(chipsBefore, 1540);

  const facingTheShove = play(setup.state, [raise(0, 1000), call(1)]);
  assert.equal(facingTheShove.toAct, 2, 'the short seat with chips left must be asked');
  assert.equal(isBettingClosedForHand(facingTheShove), false, 'it still owes chips, so betting is open');
  assert.deepEqual(offered(facingTheShove, 2), ['fold', 'call']);
  const callOption = legalActions(facingTheShove, 2).find((entry) => entry.type === 'call');
  assert.equal(callOption?.costAtMin, 30, 'calling costs everything it has left');
  assert.equal(callOption?.minTo, 40, 'which reaches 40 for the street, not the 1000 bet level');
  assert.equal(callOption?.allInAtMax, true);

  // Calling: everyone is all-in, so the board runs out.
  //
  // Layers from the totals (0: 1000, 1: 500, 2: 40):
  //   cap 40    → 40 x 3 = 120, contested by seats 0, 1 and 2   (seat 1's aces win)
  //   cap 500   → 460 x 2 = 920, contested by seats 0 and 1      (seat 1's aces win)
  //   cap 1000  → 500, seat 0 only: its own uncalled money back
  const called = applyAction(facingTheShove, 2, { type: 'call' }).state;
  assert.equal(called.street, 'complete');
  assert.equal(called.board.length, 5);
  assertNobodyCanAct(called, 'after the short call');
  assert.equal(called.result?.showdowns.length, 3);
  assert.equal(called.seats.find((seat) => seat.seat === 0)?.stack, 500, 'gets its uncalled 500 back');
  assert.equal(called.seats.find((seat) => seat.seat === 1)?.stack, 1040, '120 + 920 with the aces');
  assert.equal(called.seats.find((seat) => seat.seat === 2)?.stack, 0);
  assertAwardsGoToEntitledSeats(called, 'short call against two bigger all-ins');
  assert.equal(totalChips(called), chipsBefore, 'chips conserved exactly');

  // Folding is equally legal, and the two seats already all-in must still show down.
  const folded = applyAction(facingTheShove, 2, { type: 'fold' }).state;
  assert.equal(folded.street, 'complete');
  assert.equal(folded.board.length, 5, 'the remaining all-in players are still owed a run-out');
  assert.equal(folded.result?.endedByFold, false, 'two players are still contesting the pot');
  assert.equal(folded.result?.showdowns.length, 2);
  assertNobodyCanAct(folded, 'after the short fold');
  // Seat 2 keeps the 30 it did not commit; its 10 blind stays in the pot. Seat 1's
  // aces win everything up to 500 each, and seat 0 gets its uncalled 500 back.
  assert.equal(folded.seats.find((seat) => seat.seat === 2)?.stack, 30);
  assert.equal(folded.seats.find((seat) => seat.seat === 1)?.stack, 1010);
  assert.equal(folded.seats.find((seat) => seat.seat === 0)?.stack, 500);
  assertAwardsGoToEntitledSeats(folded, 'short fold against two bigger all-ins');
  assert.equal(totalChips(folded), chipsBefore, 'chips conserved exactly');
});

test('a call that leaves one seat fully paid up closes the betting mid-preflop', () => {
  // Seat 0 = BTN with 8, seat 1 = SB all-in for its whole 5, seat 2 = BB with 1000.
  // Blinds 5/10, so the big blind's 10 is already the bet level. Seat 0 calls all-in
  // for 8, and now only seat 2 has chips — with nothing to call. It must never be
  // asked to act: there is nobody left to bet into and nothing to fold to.
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KhKd', 0: '3s5c' }, [1, 2, 0], 'Qh 8s 2c 4d 9h');
  const { state } = deal({
    stacks: [8, 5, 1000],
    buttonSeat: 0,
    config: { maxSeats: 3, smallBlind: 5, bigBlind: 10 },
    fixedDeck: deck,
  });
  const chipsBefore = totalChips(state);
  assert.equal(chipsBefore, 1013);
  assert.equal(state.seats.find((seat) => seat.seat === 1)?.status, 'allIn', 'short of the small blind');
  assert.equal(state.toAct, 0);
  assert.deepEqual(offered(state, 0), ['fold', 'call'], 'it cannot reach a raise, so none is offered');

  const finished = applyAction(state, 0, { type: 'call' }).state;
  assert.equal(finished.actions.length, 1, 'the big blind is never asked to act');
  assert.equal(finished.street, 'complete');
  assert.equal(finished.board.length, 5);
  assertNobodyCanAct(finished, 'after the short call');
  assert.equal(finished.result?.showdowns.length, 3);

  // Layers from the totals (0: 8, 1: 5, 2: 10):
  //   cap 5  → 5 x 3 = 15, contested by all three   (seat 1's aces win)
  //   cap 8  → 3 x 2 = 6, contested by seats 0 and 2 (seat 2's kings win)
  //   cap 10 → 2, seat 2 only: its own uncalled money back
  assert.equal(finished.seats.find((seat) => seat.seat === 1)?.stack, 15, 'the aces win the main pot');
  assert.equal(finished.seats.find((seat) => seat.seat === 2)?.stack, 998, '990 behind + 6 + 2 back');
  assert.equal(finished.seats.find((seat) => seat.seat === 0)?.stack, 0);
  assertAwardsGoToEntitledSeats(finished, 'short call closes the betting');
  assert.equal(totalChips(finished), chipsBefore, 'chips conserved exactly');
});

test('the blinds alone can close the betting: a small blind all-in for less than the big blind', () => {
  // Heads-up, seat 0 = BTN/SB with a stack of exactly 5 against a 5/10 blind, so
  // posting the small blind puts it all-in. Seat 1 posts 10 and has nothing to call.
  // No action is possible at any point, so `startHand` itself must run the board out.
  const { state } = deal({
    stacks: [5, 1000],
    buttonSeat: 0,
    config: { maxSeats: 2, smallBlind: 5, bigBlind: 10 },
    fixedDeck: AA_VS_KK_HEADS_UP,
  });

  assert.equal(state.street, 'complete', 'the hand is decided before anyone can act');
  assert.equal(state.actions.length, 0, 'not one action was taken');
  assert.equal(state.board.length, 5);
  assertNobodyCanAct(state, 'after the blinds alone closed the betting');
  assert.equal(state.result?.endedByFold, false);
  assert.equal(state.result?.showdowns.length, 2);
  // Only 5 of the big blind's 10 can be contested; the other 5 comes straight back.
  // Seat 0's aces win the 10 that was matched.
  assert.equal(state.seats.find((seat) => seat.seat === 0)?.stack, 10);
  assert.equal(state.seats.find((seat) => seat.seat === 1)?.stack, 995);
  assertAwardsGoToEntitledSeats(state, 'blinds-only run-out');
  assert.equal(totalChips(state), 1005, 'chips conserved exactly');
});

test('a fully committed seat with no opponent able to act is offered nothing at all — not even a fold', () => {
  // The state the engine must never produce, assembled by hand so the guard is
  // tested directly rather than through whatever path happens to reach it: flop,
  // seat 1 all-in, seat 0 covering with 800 behind, nothing to call.
  const { state } = deal({
    stacks: [1000, 200],
    buttonSeat: 0,
    config: { maxSeats: 2, smallBlind: 5, bigBlind: 10 },
    fixedDeck: AA_VS_KK_HEADS_UP,
  });
  const closed: HandState = {
    ...state,
    street: 'flop',
    board: parseCards('Qh 8s 2c'),
    toAct: 0,
    betLevel: 0,
    lastFullRaiseBetLevel: 0,
    lastFullRaiseIncrement: 0,
    potFromPreviousStreets: 400,
    seats: state.seats.map((seat): SeatState => {
      const common = { committedThisStreet: 0, committedTotal: 200, lastActedAtBetLevel: null };
      return seat.seat === 0
        ? { ...seat, ...common, stack: 800, status: 'active' }
        : { ...seat, ...common, stack: 0, status: 'allIn', isAllInThisHand: true };
    }),
  };

  assert.equal(isBettingClosedForHand(closed), true, 'no wagering is possible in this state');
  assert.deepEqual(legalActions(closed, 0), [], 'no action is legal, so none is offered');
  assert.ok(!offered(closed, 0).includes('fold'), 'a fold here would forfeit an already-paid-for pot');
  assert.throws(() => applyAction(closed, 0, { type: 'fold' }), /cannot fold here/);
  assert.throws(() => applyAction(closed, 0, { type: 'check' }), /cannot check here/);
  assert.throws(() => applyAction(closed, 0, { type: 'bet', to: 100 }), /nobody to call it/);

  // And the same hand played for real never reaches it: the engine deals the board
  // out instead of asking.
  const played = play(state, [raise(0, 200), call(1)]);
  assert.equal(played.street, 'complete');
  assert.equal(played.actions.length, 2);
});

/** Picks an all-in-hungry action, so run-out paths dominate the sample. */
function shoveHappyAction(state: HandState, nextInt: (bound: number) => number): Action {
  const seat = state.toAct;
  assert.notEqual(seat, null, 'asked for an action with nobody to act');
  if (seat === null) throw new Error('unreachable');
  const legal = legalActions(state, seat);
  assert.ok(legal.length > 0, `seat ${seat} was asked to act with no legal action available`);

  const roll = nextInt(100);
  const aggressive = legal.find((entry) => entry.type === 'bet' || entry.type === 'raise');
  if (aggressive !== undefined && roll < 55) {
    const maxTo = aggressive.maxTo ?? aggressive.minTo ?? 0;
    return aggressive.type === 'bet' ? { type: 'bet', to: maxTo } : { type: 'raise', to: maxTo };
  }
  // A slice of real folds, so fold-out settlement is exercised too.
  if (roll >= 94 && legal.some((entry) => entry.type === 'fold')) return { type: 'fold' };
  if (roll < 85 && legal.some((entry) => entry.type === 'call')) return { type: 'call' };
  if (legal.some((entry) => entry.type === 'check')) return { type: 'check' };
  if (legal.some((entry) => entry.type === 'call')) return { type: 'call' };
  return { type: 'fold' };
}

/** The decisions the rules say cannot exist, checked on every live state. */
function assertNoImpossibleDecision(state: HandState, where: string): void {
  if (state.toAct === null) return;
  const actor = state.seats.find((seat) => seat.seat === state.toAct);
  assert.ok(actor !== undefined, `${where}: toAct points at no seat`);
  const legal = legalActions(state, actor.seat);
  assert.ok(legal.length > 0, `${where}: the seat to act was offered nothing`);

  const contenders = state.seats.filter((seat) => seat.status === 'active' || seat.status === 'allIn');
  const withChips = contenders.filter((seat) => seat.status === 'active');
  if (contenders.length >= 2 && withChips.length === 1) {
    assert.ok(
      actor.committedThisStreet < state.betLevel,
      `${where}: seat ${actor.seat} was asked to act with nothing to call and no opponent able to wager`,
    );
    assert.ok(
      !legal.some((entry) => entry.type === 'bet' || entry.type === 'raise'),
      `${where}: seat ${actor.seat} was offered aggression that nobody could call`,
    );
  }
  if (withChips.length <= 1 && actor.committedThisStreet >= state.betLevel) {
    assert.ok(
      !legal.some((entry) => entry.type === 'fold'),
      `${where}: seat ${actor.seat} was offered a fold with nothing to call`,
    );
  }
}

test('SOAK: 1500 shove-heavy hands conserve chips and never ask an impossible decision', () => {
  const HANDS = 1500;
  let handsPlayed = 0;
  let actionsApplied = 0;
  let runOuts = 0;
  let showdowns = 0;
  let foldOuts = 0;
  const seatCounts = new Set<number>();

  for (let handIndex = 0; handIndex < HANDS; handIndex++) {
    const random = createDeterministicRandomForTests(handIndex + 1);
    const nextInt = (bound: number): number => random.nextInt(bound);
    const players = 2 + nextInt(5);
    const bigBlind = [2, 10, 20][nextInt(3)] ?? 10;
    const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
    // A deliberately lumpy stack distribution: stacks below the blinds force
    // short all-ins from the blinds, and one very deep stack makes the
    // "one seat still has chips" shape the common case rather than a rarity.
    const stacks = Array.from({ length: players }, () => {
      const scale = nextInt(3);
      if (scale === 0) return 1 + nextInt(bigBlind * 2);
      if (scale === 1) return bigBlind + nextInt(bigBlind * 4);
      return bigBlind * (10 + nextInt(30));
    });
    const chipsBefore = stacks.reduce((sum, stack) => sum + stack, 0);

    let state: HandState | null = startedOrSkipped(
      handIndex,
      players,
      smallBlind,
      bigBlind,
      stacks,
      nextInt(players),
      random,
    );
    if (state === null) continue;
    handsPlayed += 1;
    seatCounts.add(players);
    assertNoImpossibleDecision(state, `hand ${handIndex} after the deal`);
    if (state.street === 'complete') runOuts += 1;

    let guard = 0;
    while (state.street !== 'complete') {
      // Annotated for the same reason as `state`: inferring it here would be circular.
      const seat: SeatIndex | null = state.toAct;
      assert.notEqual(seat, null, `hand ${handIndex} stalled on ${state.street} with nobody to act`);
      if (seat === null) break;
      state = applyAction(state, seat, shoveHappyAction(state, nextInt)).state;
      actionsApplied += 1;
      assertNoImpossibleDecision(state, `hand ${handIndex} after action ${guard}`);
      guard += 1;
      assert.ok(guard < 400, `hand ${handIndex} did not terminate`);
    }

    assert.equal(totalChips(state), chipsBefore, `hand ${handIndex}: chips created or destroyed`);
    assertAwardsGoToEntitledSeats(state, `hand ${handIndex}`);
    const result = state.result;
    assert.ok(result !== null);
    if (result.showdowns.length > 0) {
      showdowns += 1;
      assert.equal(state.board.length, 5, `hand ${handIndex}: showdown on an unfinished board`);
    } else {
      foldOuts += 1;
    }
  }

  assert.ok(handsPlayed > HANDS * 0.9, `only ${handsPlayed} of ${HANDS} hands were playable`);
  assert.ok(showdowns > 500, `only ${showdowns} hands reached a showdown`);
  assert.ok(foldOuts > 20, `only ${foldOuts} hands ended by folding`);
  assert.deepEqual(
    [...seatCounts].sort((a, b) => a - b),
    [2, 3, 4, 5, 6],
    'every table size was played',
  );
  console.log(
    `      ${handsPlayed} hands, ${actionsApplied} actions | showdowns ${showdowns}, ` +
      `fold-outs ${foldOuts}, run-out before any action ${runOuts}`,
  );
});

/** Deals a hand, returning null for the shapes `startHand` legitimately refuses. */
function startedOrSkipped(
  handIndex: number,
  players: number,
  smallBlind: number,
  bigBlind: number,
  stacks: readonly number[],
  buttonSeat: number,
  random: ReturnType<typeof createDeterministicRandomForTests>,
): HandState | null {
  try {
    return startHandForSoak(handIndex, players, smallBlind, bigBlind, stacks, buttonSeat, random);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /at least 2 players|button seat/, `hand ${handIndex} rejected: ${message}`);
    return null;
  }
}

function startHandForSoak(
  handIndex: number,
  players: number,
  smallBlind: number,
  bigBlind: number,
  stacks: readonly number[],
  buttonSeat: number,
  random: ReturnType<typeof createDeterministicRandomForTests>,
): HandState {
  return startHand({
    handId: `soak_${handIndex}`,
    roomId: 'soak',
    handNumber: handIndex,
    config: { smallBlind, bigBlind, ante: 0, maxSeats: players, actionTimeoutSeconds: 30 },
    buttonSeat,
    seats: stacks.map((stack, seat) => ({ seat, playerId: `p${seat}`, stack })),
    random,
  }).state;
}
