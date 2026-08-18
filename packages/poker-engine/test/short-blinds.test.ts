/**
 * Short blinds: a blind posted by a player who cannot cover it.
 *
 * ## The rule
 *
 * The bet level is the largest FULL wager in force, and preflop that is the big
 * blind — even when the player who posted it was all-in for less. A short blind
 * does not lower the price of playing for anybody else:
 *
 *   - a caller must still pay a whole big blind (or all-in for less than one), and
 *   - the minimum raise is still measured from a whole big blind, so preflop the
 *     first raise must reach 2 BB.
 *
 * Chips that nobody could match come back at settlement as an uncalled return, so
 * charging the full big blind never manufactures chips: with 5/10 blinds and a big
 * blind all-in for 3, a lone caller pays 10 and gets 7 back.
 *
 * The defect this file pins down derived the preflop bet level from the largest
 * amount actually committed. A short big blind made that the small blind, so the
 * level collapsed to the small blind: callers were under-charged and raises below
 * the true minimum were accepted (with 5/10 blinds and a big blind all-in for 3 the
 * level came out as 5, a call cost 5 instead of 10, and a "raise" to 15 was allowed
 * where the rules require 20).
 *
 * ## How the expectations here are derived
 *
 * Every number below is worked out from the rules by hand in the comments and then
 * written as a literal — never read back from the engine. Every scenario asserts
 * exact chip conservation before and after, because a bet-level change is exactly
 * the kind of fix that can quietly create or destroy chips at settlement.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountToCall, isBettingClosedForHand, legalActions, minimumRaiseTo } from '../src/betting.ts';
import { applyAction, startHand } from '../src/machine.ts';
import { createDeterministicRandomForTests } from '../src/rng.ts';
import type { Action, HandState, LegalAction, Pot, SeatIndex } from '../src/types.ts';
import { call, check, chipsInSystem, deal, fold, play, raise, stackedDeck } from './helpers.ts';

/** Blinds used throughout: small enough to read, big enough to be short of. */
const BLINDS = { smallBlind: 5, bigBlind: 10 } as const;

/** A brick board: no straight, no flush, no pair for any hand dealt below. */
const BRICKS = 'Qh 8s 2c 4d 9h';

function seat(state: HandState, index: SeatIndex) {
  const found = state.seats.find((candidate) => candidate.seat === index);
  assert.ok(found !== undefined, `no seat ${index}`);
  return found;
}

/** The action types on offer, in the order the engine offers them. */
function offered(state: HandState, index: SeatIndex): string[] {
  return legalActions(state, index).map((entry) => entry.type);
}

function stacks(state: HandState): number[] {
  return state.seats.map((entry) => entry.stack);
}

/** Every awarded chip must go to a seat the pot layer says is eligible for it. */
function assertAwardsGoToEntitledSeats(state: HandState, where: string): void {
  const result = state.result;
  assert.ok(result !== null, `${where}: a complete hand must have a result`);
  const scoreBySeat = new Map(result.showdowns.map((showdown) => [showdown.seat, showdown.score]));
  for (const award of result.awards) {
    const pot: Pot | undefined = result.pots.find((candidate) => candidate.index === award.potIndex);
    assert.ok(pot !== undefined, `${where}: award refers to pot ${award.potIndex}, which does not exist`);
    assert.ok(
      pot.eligibleSeats.includes(award.seat),
      `${where}: pot ${pot.index} paid seat ${award.seat}, which is not eligible for it`,
    );
    // Annotated because `assert.ok` above narrows through an assertion signature,
    // which makes an inferred type here circular.
    const eligibleScores: number[] = pot.eligibleSeats
      .map((candidate) => scoreBySeat.get(candidate))
      .filter((score): score is number => score !== undefined);
    if (eligibleScores.length > 0) {
      assert.equal(
        scoreBySeat.get(award.seat),
        Math.max(...eligibleScores),
        `${where}: pot ${pot.index} did not go to the best eligible hand`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 1. A short BIG blind
// ---------------------------------------------------------------------------

test('a short big blind still sets the preflop bet level at one FULL big blind', () => {
  // 4-handed, button seat 0 → SB 1, BB 2, UTG 3. Blinds 5/10 and the big blind
  // holds only 3, so it posts 3 and is all-in. The largest amount that reached the
  // pot is therefore the small blind's 5 — but the bet level is 10.
  const { state } = deal({
    stacks: [1000, 1000, 3, 1000],
    buttonSeat: 0,
    config: { maxSeats: 4, ...BLINDS },
  });
  assert.equal(chipsInSystem(state), 3003);

  const smallBlind = state.forcedBets.find((forced) => forced.kind === 'smallBlind');
  const bigBlind = state.forcedBets.find((forced) => forced.kind === 'bigBlind');
  assert.deepEqual(smallBlind, { kind: 'smallBlind', seat: 1, amount: 5, wasShort: false });
  assert.deepEqual(bigBlind, { kind: 'bigBlind', seat: 2, amount: 3, wasShort: true });
  assert.equal(seat(state, 2).status, 'allIn', 'a player who cannot cover the blind is all-in, not folded');
  assert.equal(seat(state, 2).committedThisStreet, 3);
  assert.equal(seat(state, 1).committedThisStreet, 5, 'the largest amount actually committed is only 5');

  assert.equal(state.betLevel, 10, 'the bet level is a full big blind, not the short post and not the SB');
  assert.equal(state.lastFullRaiseBetLevel, 10);
  assert.equal(state.lastFullRaiseIncrement, 10);
  assert.equal(minimumRaiseTo(state), 20, 'the first raise must reach 2 BB, measured from a full BB');
  assert.equal(state.toAct, 3, 'UTG is first to act preflop');

  // What UTG is charged and offered.
  assert.equal(amountToCall(state, seat(state, 3)), 10, 'a caller pays a whole big blind');
  const utg = legalActions(state, 3);
  assert.deepEqual(
    utg.map((entry) => entry.type),
    ['fold', 'call', 'raise'],
  );
  const callOption = utg.find((entry) => entry.type === 'call');
  assert.equal(callOption?.minTo, 10);
  assert.equal(callOption?.costAtMin, 10);
  const raiseOption = utg.find((entry) => entry.type === 'raise');
  assert.equal(raiseOption?.minTo, 20);
  assert.equal(raiseOption?.maxTo, 1000);
  assert.equal(raiseOption?.costAtMin, 20);

  // And the small blind, which has 5 out already, owes the other 5.
  const afterUtgCalls = play(state, [call(3)]);
  assert.equal(seat(afterUtgCalls, 3).committedThisStreet, 10, 'the caller paid the full big blind');
  assert.equal(seat(afterUtgCalls, 3).stack, 990);
  assert.equal(afterUtgCalls.toAct, 0);
  const afterButtonFolds = play(afterUtgCalls, [fold(0)]);
  assert.equal(afterButtonFolds.toAct, 1);
  assert.equal(amountToCall(afterButtonFolds, seat(afterButtonFolds, 1)), 5, '5 posted, 5 still owed');
  assert.equal(chipsInSystem(afterButtonFolds), 3003, 'chips conserved exactly');
});

test('a sub-minimum raise over a short big blind is rejected', () => {
  const { state } = deal({
    stacks: [1000, 1000, 3, 1000],
    buttonSeat: 0,
    config: { maxSeats: 4, ...BLINDS },
  });
  const before = chipsInSystem(state);

  // The minimum raise is to 20: the full big blind of 10 plus an increment of at
  // least one big blind. Everything under that is illegal for a seat that can
  // afford the minimum, including the 15 the collapsed level used to allow.
  for (const to of [6, 10, 11, 15, 19]) {
    assert.throws(
      () => applyAction(state, 3, { type: 'raise', to }),
      /below the minimum of 20/,
      `raise to ${to} must be rejected`,
    );
  }

  const raised = applyAction(state, 3, { type: 'raise', to: 20 }).state;
  assert.equal(raised.betLevel, 20, 'the minimum legal raise is exactly 2 BB');
  assert.equal(raised.lastFullRaiseBetLevel, 20);
  assert.equal(raised.lastFullRaiseIncrement, 10, 'increment is 20 - 10, the full big blind');
  assert.equal(minimumRaiseTo(raised), 30, 'the next raise must reach 20 + 10');
  assert.equal(seat(raised, 3).stack, 980);
  assert.equal(chipsInSystem(raised), before, 'chips conserved exactly');

  // The state is untouched by the rejected attempts: none of them moved a chip.
  assert.equal(chipsInSystem(state), before);
  assert.equal(seat(state, 3).stack, 1000);
});

test('a hand against a short big blind pays out exactly, with the caller charged in full', () => {
  // Seats: 0 BTN (1000), 1 SB (1000), 2 BB (3, all-in on the post), 3 UTG (1000).
  // UTG calls 10, the button folds, the small blind calls 10.
  //
  // Commitments: seat 1 = 10, seat 2 = 3, seat 3 = 10; the button put in nothing.
  // Layers, from the caps of the seats still holding cards:
  //   cap 3  → 3 x 3 = 9,  eligible 1, 2, 3   (seat 2's aces win it)
  //   cap 10 → 7 x 2 = 14, eligible 1 and 3   (seat 3's kings win it)
  // 9 + 14 = 23 = 10 + 3 + 10, so every chip in the middle is accounted for.
  const deck = stackedDeck({ 1: '3s5c', 2: 'AhAd', 3: 'KsKc', 0: '6h7d' }, [1, 2, 3, 0], BRICKS);
  const { state } = deal({
    stacks: [1000, 1000, 3, 1000],
    buttonSeat: 0,
    config: { maxSeats: 4, ...BLINDS },
    fixedDeck: deck,
  });
  const before = chipsInSystem(state);
  assert.equal(before, 3003);

  const finished = play(state, [
    call(3),
    fold(0),
    call(1),
    // Flop, turn and river checked down by the two seats with chips. The big blind
    // is all-in, so it is never asked.
    check(1),
    check(3),
    check(1),
    check(3),
    check(1),
    check(3),
  ]);

  assert.equal(finished.street, 'complete');
  assert.equal(finished.board.length, 5);
  assert.equal(finished.result?.showdowns.length, 3, 'all three seats still in show down');
  assert.equal(finished.result?.pots.length, 2);
  assert.equal(finished.result?.pots[0]?.amount, 9, 'main pot is 3 from each of the three contenders');
  assert.deepEqual(finished.result?.pots[0]?.eligibleSeats, [1, 2, 3]);
  assert.equal(finished.result?.pots[1]?.amount, 14, 'side pot is the 7 each that seats 1 and 3 added');
  assert.deepEqual(finished.result?.pots[1]?.eligibleSeats, [1, 3]);

  // Under the collapsed bet level the callers would each have paid 5, making the
  // side pot 4 rather than 14 — these stacks are what distinguishes the two.
  assert.deepEqual(stacks(finished), [1000, 990, 9, 1004]);
  assert.equal(finished.result?.netBySeat[1], -10);
  assert.equal(finished.result?.netBySeat[2], 6);
  assert.equal(finished.result?.netBySeat[3], 4);
  assertAwardsGoToEntitledSeats(finished, 'short big blind, three-way showdown');
  assert.equal(chipsInSystem(finished), before, 'chips conserved exactly');
});

// ---------------------------------------------------------------------------
// 2. A short SMALL blind, and both blinds short
// ---------------------------------------------------------------------------

test('a short small blind leaves the bet level at the full big blind', () => {
  // Seats: 0 BTN (1000), 1 SB (2, all-in on the post), 2 BB (1000), 3 UTG (1000).
  const { state } = deal({
    stacks: [1000, 2, 1000, 1000],
    buttonSeat: 0,
    config: { maxSeats: 4, ...BLINDS },
  });
  assert.equal(chipsInSystem(state), 3002);

  assert.deepEqual(
    state.forcedBets.find((forced) => forced.kind === 'smallBlind'),
    { kind: 'smallBlind', seat: 1, amount: 2, wasShort: true },
  );
  assert.equal(seat(state, 1).status, 'allIn');
  assert.equal(state.betLevel, 10, 'the big blind was posted in full, so the level is plainly 10');
  assert.equal(minimumRaiseTo(state), 20);
  assert.equal(state.toAct, 3);
  assert.equal(amountToCall(state, seat(state, 3)), 10);
  assert.throws(() => applyAction(state, 3, { type: 'raise', to: 19 }), /below the minimum of 20/);

  // The big blind keeps its option: everyone limps and it may still check or raise.
  const limped = play(state, [call(3), call(0)]);
  assert.equal(limped.toAct, 2, 'the short small blind is all-in, so the option passes to the BB');
  assert.deepEqual(offered(limped, 2), ['fold', 'check', 'raise']);
  assert.equal(chipsInSystem(limped), 3002, 'chips conserved exactly');
});

test('both blinds short: the level is still a full big blind and the pot layers are exact', () => {
  // Seats: 0 BTN (1000), 1 SB (2, all-in), 2 BB (3, all-in), 3 UTG (1000).
  // Nobody at the table has posted as much as a big blind, yet the price of playing
  // is a full big blind. UTG and the button both call 10.
  //
  // Commitments: 0 = 10, 1 = 2, 2 = 3, 3 = 10. Layers:
  //   cap 2  → 2 x 4 = 8,  eligible 0, 1, 2, 3   (seat 1's aces win it)
  //   cap 3  → 1 x 3 = 3,  eligible 0, 2, 3      (seat 2's kings win it)
  //   cap 10 → 7 x 2 = 14, eligible 0 and 3      (seat 3's queens win it)
  // 8 + 3 + 14 = 25 = 10 + 2 + 3 + 10.
  const board = 'Th 8s 2c 4d 9h';
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KsKc', 3: 'QsQc', 0: '3s5c' }, [1, 2, 3, 0], board);
  const { state } = deal({
    stacks: [1000, 2, 3, 1000],
    buttonSeat: 0,
    config: { maxSeats: 4, ...BLINDS },
    fixedDeck: deck,
  });
  const before = chipsInSystem(state);
  assert.equal(before, 2005);

  assert.equal(state.betLevel, 10);
  assert.equal(minimumRaiseTo(state), 20);
  assert.equal(state.toAct, 3);
  assert.equal(amountToCall(state, seat(state, 3)), 10, 'a full big blind, though nobody posted one');
  assert.throws(() => applyAction(state, 3, { type: 'raise', to: 15 }), /below the minimum of 20/);

  const finished = play(state, [
    call(3),
    call(0),
    // Only seats 0 and 3 have chips; seat 3 is first to act postflop because the two
    // seats between it and the button are all-in.
    check(3),
    check(0),
    check(3),
    check(0),
    check(3),
    check(0),
  ]);

  assert.equal(finished.street, 'complete');
  assert.equal(finished.result?.showdowns.length, 4);
  assert.equal(finished.result?.pots.length, 3);
  assert.equal(finished.result?.pots[0]?.amount, 8);
  assert.equal(finished.result?.pots[1]?.amount, 3);
  assert.equal(finished.result?.pots[2]?.amount, 14);
  assert.deepEqual(stacks(finished), [990, 8, 3, 1004]);
  assertAwardsGoToEntitledSeats(finished, 'both blinds short');
  assert.equal(chipsInSystem(finished), before, 'chips conserved exactly');
});

// ---------------------------------------------------------------------------
// 3. Heads-up, where the button is the small blind
// ---------------------------------------------------------------------------

test('heads-up: a button/small blind all-in on the post leaves nothing to decide', () => {
  // Seat 0 = BTN/SB with 3 against a 5/10 blind, so it is all-in for 3. Seat 1
  // posts the full 10 and has nothing to call, so no action is possible at all and
  // `startHand` runs the board out on its own.
  //
  // Only 3 of seat 1's 10 can be contested: cap 3 → 6 for the pair of them, and the
  // uncontested 7 goes straight back to seat 1.
  const deck = stackedDeck({ 1: 'KsKc', 0: 'AhAd' }, [1, 0], BRICKS);
  const { state } = deal({
    stacks: [3, 1000],
    buttonSeat: 0,
    config: { maxSeats: 2, ...BLINDS },
    fixedDeck: deck,
  });

  // No bet level to inspect: the hand is settled inside `startHand`, and settling
  // clears the street's bet level along with the commitments it swept into the pot.
  assert.equal(state.street, 'complete', 'the hand is decided before anyone can act');
  assert.equal(state.actions.length, 0);
  assert.equal(state.board.length, 5);
  assert.equal(state.result?.showdowns.length, 2);
  assert.equal(state.result?.pots[0]?.amount, 6);
  assert.deepEqual(stacks(state), [6, 997]);
  assertAwardsGoToEntitledSeats(state, 'heads-up short button blind');
  assert.equal(chipsInSystem(state), 1003, 'chips conserved exactly');
});

test('heads-up: a button/small blind that covers its blind but not the big blind must still act', () => {
  // Seat 0 = BTN/SB with 7: it posts the 5 in full and has 2 behind, so it is short
  // of the 10 bet level and owes a decision. It cannot raise — its 7 does not even
  // reach the bet level — so call or fold is the whole list.
  const deck = stackedDeck({ 1: 'KsKc', 0: 'AhAd' }, [1, 0], BRICKS);
  const setup = deal({
    stacks: [7, 1000],
    buttonSeat: 0,
    config: { maxSeats: 2, ...BLINDS },
    fixedDeck: deck,
  });
  const before = chipsInSystem(setup.state);
  assert.equal(before, 1007);

  assert.equal(setup.state.betLevel, 10);
  assert.equal(setup.state.street, 'preflop');
  assert.equal(setup.state.toAct, 0, 'heads-up the button acts first preflop');
  assert.equal(isBettingClosedForHand(setup.state), false, 'seat 0 is short of the bet level');
  assert.deepEqual(offered(setup.state, 0), ['fold', 'call']);
  const callOption = legalActions(setup.state, 0).find((entry) => entry.type === 'call');
  assert.equal(callOption?.costAtMin, 2, 'everything it has left');
  assert.equal(callOption?.minTo, 7, 'which reaches 7 for the street, not the 10 bet level');
  assert.equal(callOption?.allInAtMax, true);

  // Calling: cap 7 → 14 contested, and seat 1's uncontested 3 comes back.
  const called = applyAction(setup.state, 0, { type: 'call' }).state;
  assert.equal(called.street, 'complete');
  assert.equal(called.result?.pots[0]?.amount, 14);
  assert.deepEqual(stacks(called), [14, 993]);
  assertAwardsGoToEntitledSeats(called, 'heads-up short button blind calls');
  assert.equal(chipsInSystem(called), before, 'chips conserved exactly');

  // Folding: seat 1 wins the 5 seat 0 posted plus 5 of its own, and gets 5 back.
  const folded = applyAction(setup.state, 0, { type: 'fold' }).state;
  assert.equal(folded.street, 'complete');
  assert.equal(folded.result?.endedByFold, true);
  assert.deepEqual(stacks(folded), [2, 1005]);
  assert.equal(chipsInSystem(folded), before, 'chips conserved exactly');
});

test('heads-up: a short big blind still charges the button/small blind a full big blind', () => {
  // Seat 0 = BTN/SB with 1000, seat 1 = BB with 3 and therefore all-in for 3.
  //
  // This is the shape the defect hid completely: the largest commitment on the
  // table was the small blind's 5, so the bet level collapsed to 5, seat 0 looked
  // fully paid up and the hand ran out with seat 0 never asked. The rule is that
  // the level is 10, seat 0 owes 5 more and has a real decision.
  const deck = stackedDeck({ 1: 'AhAd', 0: 'KsKc' }, [1, 0], BRICKS);
  const setup = deal({
    stacks: [1000, 3],
    buttonSeat: 0,
    config: { maxSeats: 2, ...BLINDS },
    fixedDeck: deck,
  });
  const before = chipsInSystem(setup.state);
  assert.equal(before, 1003);

  assert.equal(setup.state.betLevel, 10, 'a big blind all-in for 3 still opens the betting at 10');
  assert.equal(setup.state.street, 'preflop', 'the hand is NOT over: seat 0 owes 5');
  assert.equal(setup.state.toAct, 0);
  assert.equal(amountToCall(setup.state, seat(setup.state, 0)), 5);
  assert.deepEqual(offered(setup.state, 0), ['fold', 'call'], 'no raise: nobody could call one');
  assert.throws(() => applyAction(setup.state, 0, { type: 'raise', to: 20 }), /nobody to call it/);

  // Calling: seat 0 pays the full big blind, of which only 3 can be matched, so 7
  // returns. cap 3 → 6 contested by both.
  const called = applyAction(setup.state, 0, { type: 'call' }).state;
  // `committedTotal`, not `committedThisStreet`: settlement sweeps the street's
  // commitments into the pot and zeroes them, but keeps the totals for hand review.
  assert.equal(seat(called, 0).committedTotal, 10, 'the caller paid the full big blind');
  assert.equal(called.street, 'complete');
  assert.equal(called.board.length, 5);
  assert.equal(called.result?.showdowns.length, 2);
  // The uncalled 7 is not a special case: it is simply the top layer, and seat 0 is
  // its only eligible player, so the general algorithm hands it straight back.
  assert.equal(called.result?.pots.length, 2);
  assert.equal(called.result?.pots[0]?.amount, 6);
  assert.deepEqual(called.result?.pots[0]?.eligibleSeats, [0, 1]);
  assert.equal(called.result?.pots[1]?.amount, 7);
  assert.deepEqual(called.result?.pots[1]?.eligibleSeats, [0]);
  assert.deepEqual(stacks(called), [997, 6], 'seat 1 wins 6 with aces; seat 0 gets its uncalled 7 back');
  assertAwardsGoToEntitledSeats(called, 'heads-up short big blind, called');
  assert.equal(chipsInSystem(called), before, 'chips conserved exactly');

  // Folding is legal too, and costs seat 0 only the 3 that seat 1 could match.
  const folded = applyAction(setup.state, 0, { type: 'fold' }).state;
  assert.equal(folded.street, 'complete');
  assert.equal(folded.result?.endedByFold, true);
  assert.deepEqual(stacks(folded), [997, 6]);
  assert.equal(chipsInSystem(folded), before, 'chips conserved exactly');
});

test('heads-up: both blinds short runs out with the smaller stack capping the pot', () => {
  // Seat 0 = BTN/SB with 2 (all-in for 2), seat 1 = BB with 3 (all-in for 3).
  // Nobody can act. cap 2 → 4 contested; seat 1's extra 1 is uncontested and returns.
  const deck = stackedDeck({ 1: 'KsKc', 0: 'AhAd' }, [1, 0], BRICKS);
  const { state } = deal({
    stacks: [2, 3],
    buttonSeat: 0,
    config: { maxSeats: 2, ...BLINDS },
    fixedDeck: deck,
  });

  assert.equal(state.street, 'complete', 'neither seat has a chip left, so nobody can act');
  assert.equal(state.actions.length, 0);
  assert.equal(state.result?.pots.length, 2);
  assert.equal(state.result?.pots[0]?.amount, 4);
  assert.deepEqual(state.result?.pots[0]?.eligibleSeats, [0, 1]);
  assert.equal(state.result?.pots[1]?.amount, 1, 'the extra 1 that only seat 1 put in, so only it can win');
  assert.deepEqual(state.result?.pots[1]?.eligibleSeats, [1]);
  assert.deepEqual(stacks(state), [4, 1], 'aces take the 4; seat 1 keeps the 1 nobody could match');
  assertAwardsGoToEntitledSeats(state, 'heads-up both blinds short');
  assert.equal(chipsInSystem(state), 5, 'chips conserved exactly');
});

// ---------------------------------------------------------------------------
// 4. A short all-in raise does not reopen the betting
// ---------------------------------------------------------------------------

test('a short all-in raise over a short big blind does not reopen the action', () => {
  // Seats: 0 BTN (1000), 1 SB (45), 2 BB (3, all-in on the post), 3 UTG (1000).
  //
  //   UTG raises to 30   → complete (minimum was 20). Increment 20, so the next
  //                        full raise would have to reach 50.
  //   BTN calls 30       → it has now acted AT the current full-raise level.
  //   SB shoves to 45    → its whole stack, but 15 short of the 50 a complete raise
  //                        needs. It lifts the bet level without reopening anything.
  //   UTG and BTN        → owe the extra 15, and must NOT be offered a raise.
  const deck = stackedDeck({ 1: 'KsKc', 2: 'AhAd', 3: '6h7d', 0: '3s5c' }, [1, 2, 3, 0], BRICKS);
  const { state } = deal({
    stacks: [1000, 45, 3, 1000],
    buttonSeat: 0,
    config: { maxSeats: 4, ...BLINDS },
    fixedDeck: deck,
  });
  const before = chipsInSystem(state);
  assert.equal(before, 2048);

  let current = play(state, [raise(3, 30), call(0)]);
  assert.equal(current.betLevel, 30);
  assert.equal(current.lastFullRaiseBetLevel, 30);
  assert.equal(current.lastFullRaiseIncrement, 20, 'increment is 30 - 10, measured from a full big blind');
  assert.equal(minimumRaiseTo(current), 50, 'a complete re-raise must reach 30 + 20');
  assert.equal(current.toAct, 1);

  // The small blind cannot reach 50, so its only raise is the shove — and nothing
  // between the two is legal.
  const shoveOption = legalActions(current, 1).find((entry) => entry.type === 'raise');
  assert.equal(shoveOption?.minTo, 45, 'the minimum collapses to the shove when the stack cannot reach 50');
  assert.equal(shoveOption?.maxTo, 45);
  assert.throws(() => applyAction(current, 1, { type: 'raise', to: 44 }), /below the minimum of 45/);

  current = applyAction(current, 1, { type: 'raise', to: 45 }).state;
  assert.equal(current.betLevel, 45, 'the bet level rises to the all-in amount');
  assert.equal(current.lastFullRaiseBetLevel, 30, 'but a short all-in is not a complete raise');
  assert.equal(current.lastFullRaiseIncrement, 20, 'and it does not change the increment either');
  assert.equal(seat(current, 1).status, 'allIn');

  // UTG acted at 30, which is still the last complete level: call or fold only.
  assert.equal(current.toAct, 3, 'the all-in big blind is skipped');
  assert.deepEqual(offered(current, 3), ['fold', 'call']);
  assert.equal(amountToCall(current, seat(current, 3)), 15);
  assert.throws(() => applyAction(current, 3, { type: 'raise', to: 100 }), /may not raise/);

  current = play(current, [call(3)]);
  assert.equal(current.toAct, 0, 'the button is in the same position');
  assert.deepEqual(offered(current, 0), ['fold', 'call']);
  assert.throws(() => applyAction(current, 0, { type: 'raise', to: 200 }), /may not raise/);

  // Play it out. Commitments: 0 = 45, 1 = 45, 2 = 3, 3 = 45. Layers:
  //   cap 3  → 3 x 4 = 12,   eligible 0, 1, 2, 3  (seat 2's aces win it)
  //   cap 45 → 42 x 3 = 126, eligible 0, 1, 3     (seat 1's kings win it)
  // 12 + 126 = 138 = 45 + 45 + 3 + 45.
  const finished = play(current, [call(0), check(3), check(0), check(3), check(0), check(3), check(0)]);
  assert.equal(finished.street, 'complete');
  assert.equal(finished.result?.pots.length, 2);
  assert.equal(finished.result?.pots[0]?.amount, 12);
  assert.equal(finished.result?.pots[1]?.amount, 126);
  assert.deepEqual(stacks(finished), [955, 126, 12, 955]);
  assertAwardsGoToEntitledSeats(finished, 'short all-in raise over a short big blind');
  assert.equal(chipsInSystem(finished), before, 'chips conserved exactly');
});

test('a complete raise after a short all-in reopens the action to the players it shut out', () => {
  // The mirror image of the test above, and the reason the shut-out is expressed as
  // "has this seat acted at the last COMPLETE level" rather than a sticky flag.
  //
  // Five seats, button 0 → SB 1, BB 2 (short, all-in for 3), UTG 3, then seat 4.
  // The short stack is the button this time, so a seat that has not yet acted — the
  // small blind — is still to come when the short all-in lands.
  //
  //   UTG raises to 30   → complete. Increment 20, next full raise to 50.
  //   Seat 4 calls 30.
  //   BTN shoves to 45   → short all-in: raises the level, reopens nothing.
  //   SB has not acted   → it may raise, and to at least 45 + 20 = 65.
  //   SB raises to 65    → complete, so UTG (which acted at 30) is live again.
  const { state } = deal({
    stacks: [45, 1000, 3, 1000, 1000],
    buttonSeat: 0,
    config: { maxSeats: 5, ...BLINDS },
  });
  const before = chipsInSystem(state);
  assert.equal(before, 3048);
  assert.equal(state.betLevel, 10);
  assert.equal(state.toAct, 3);

  let current = play(state, [raise(3, 30), call(4)]);
  assert.equal(current.toAct, 0);
  current = applyAction(current, 0, { type: 'raise', to: 45 }).state; // short all-in
  assert.equal(current.betLevel, 45);
  assert.equal(current.lastFullRaiseBetLevel, 30, 'the short all-in is not a complete raise');

  assert.equal(current.toAct, 1, 'the small blind, which has not acted this street');
  const sbRaise = legalActions(current, 1).find((entry) => entry.type === 'raise');
  assert.equal(sbRaise?.minTo, 65, 'a seat that has not acted may raise, to 45 + the 20 increment');
  current = applyAction(current, 1, { type: 'raise', to: 65 }).state;
  assert.equal(current.lastFullRaiseBetLevel, 65, '65 is 20 over 45, a complete raise');
  assert.equal(current.lastFullRaiseIncrement, 20);

  assert.equal(current.toAct, 3, 'the all-in big blind is skipped');
  assert.ok(
    offered(current, 3).includes('raise'),
    'a complete raise reopens the action for a player who had been shut out',
  );
  assert.equal(minimumRaiseTo(current), 85, 'and the next raise must reach 65 + 20');
  assert.equal(chipsInSystem(current), before, 'chips conserved exactly');
});

// ---------------------------------------------------------------------------
// 5. Randomised soak, weighted hard towards short blind posts
// ---------------------------------------------------------------------------

/**
 * Picks a legal action, weighted towards calling so that short blinds actually get
 * contested rather than folded around, with enough aggression to build side pots.
 * `fold` is the final fallback and is always available when anything is.
 */
function chooseAction(legal: readonly LegalAction[], nextInt: (bound: number) => number): Action {
  const roll = nextInt(100);
  const aggressive = legal.find((entry) => entry.type === 'bet' || entry.type === 'raise');
  if (aggressive !== undefined && roll < 30) {
    const minTo = aggressive.minTo ?? 0;
    const maxTo = aggressive.maxTo ?? minTo;
    const to = Math.min(maxTo, minTo + (roll < 10 ? maxTo - minTo : nextInt(maxTo - minTo + 1)));
    return aggressive.type === 'bet' ? { type: 'bet', to } : { type: 'raise', to };
  }
  if (roll < 88 && legal.some((entry) => entry.type === 'call')) return { type: 'call' };
  if (legal.some((entry) => entry.type === 'check')) return { type: 'check' };
  if (roll < 95 && legal.some((entry) => entry.type === 'call')) return { type: 'call' };
  return { type: 'fold' };
}

test('SOAK: 3000 short-blind-heavy hands keep the level honest and conserve chips exactly', () => {
  const HANDS = 3000;
  let handsPlayed = 0;
  let actionsApplied = 0;
  let shortPosts = 0;
  let handsWithAShortPost = 0;
  let handsDecidedByTheBlinds = 0;
  const seatCounts = new Set<number>();

  for (let handIndex = 0; handIndex < HANDS; handIndex++) {
    const random = createDeterministicRandomForTests(handIndex + 1);
    const nextInt = (bound: number): number => random.nextInt(bound);
    const players = 2 + nextInt(5);
    const bigBlind = [2, 10, 20, 50][nextInt(4)] ?? 10;
    const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
    // Half the stacks are deliberately below the big blind, and a third of those
    // below the small blind, so short posts are the common case rather than a
    // rarity. The rest are deep enough for real betting to happen around them.
    const stackList = Array.from({ length: players }, () => {
      const scale = nextInt(6);
      if (scale === 0) return 1 + nextInt(Math.max(1, smallBlind));
      if (scale <= 2) return 1 + nextInt(bigBlind);
      if (scale === 3) return bigBlind + nextInt(bigBlind * 3);
      return bigBlind * (8 + nextInt(25));
    });
    const chipsBefore = stackList.reduce((sum, stack) => sum + stack, 0);

    let state: HandState;
    try {
      state = startHand({
        handId: `short_${handIndex}`,
        roomId: 'short-blinds',
        handNumber: handIndex,
        config: { smallBlind, bigBlind, ante: 0, maxSeats: players, actionTimeoutSeconds: 30 },
        buttonSeat: nextInt(players),
        seats: stackList.map((stack, index) => ({ seat: index, playerId: `p${index}`, stack })),
        random,
      }).state;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /at least 2 players|button seat/, `hand ${handIndex} rejected: ${message}`);
      continue;
    }
    handsPlayed += 1;
    seatCounts.add(players);

    const short = state.forcedBets.filter((forced) => forced.wasShort);
    shortPosts += short.length;
    if (short.length > 0) handsWithAShortPost += 1;
    if (state.street === 'complete') handsDecidedByTheBlinds += 1;

    // The rule, asserted straight off the deal: the price of playing is one whole
    // big blind, whoever could or could not cover their blind. Skipped only when the
    // blinds alone ended the hand, because settling clears the street's bet level.
    if (state.street === 'preflop') {
      assert.equal(
        state.betLevel,
        bigBlind,
        `hand ${handIndex}: preflop bet level must be the full big blind ${bigBlind}`,
      );
      assert.equal(state.lastFullRaiseBetLevel, bigBlind);
      assert.equal(minimumRaiseTo(state), bigBlind * 2, `hand ${handIndex}: first raise must reach 2 BB`);
    }

    let guard = 0;
    while (state.street !== 'complete') {
      const toAct: SeatIndex | null = state.toAct;
      assert.notEqual(toAct, null, `hand ${handIndex} stalled on ${state.street}`);
      if (toAct === null) break;
      const legal = legalActions(state, toAct);
      assert.ok(legal.length > 0, `hand ${handIndex}: seat ${toAct} was asked to act with nothing to do`);

      // Until somebody raises, the preflop level must stay at exactly one big
      // blind: a short post must never drag it down.
      const raisedYet = state.actions.some(
        (logged) => logged.action.type === 'bet' || logged.action.type === 'raise',
      );
      if (state.street === 'preflop' && !raisedYet) {
        assert.equal(state.betLevel, bigBlind, `hand ${handIndex}: the level slipped below a big blind`);
      }

      state = applyAction(state, toAct, chooseAction(legal, nextInt)).state;
      actionsApplied += 1;
      guard += 1;
      assert.ok(guard < 400, `hand ${handIndex} did not terminate`);
    }

    assert.equal(chipsInSystem(state), chipsBefore, `hand ${handIndex}: chips created or destroyed`);
    assert.equal(
      state.seats.reduce((sum, entry) => sum + entry.stack, 0),
      chipsBefore,
      `hand ${handIndex}: chips did not all end up back in stacks`,
    );
    assertAwardsGoToEntitledSeats(state, `hand ${handIndex}`);
  }

  assert.ok(handsPlayed > HANDS * 0.8, `only ${handsPlayed} of ${HANDS} hands were playable`);
  assert.ok(handsWithAShortPost > HANDS * 0.3, `only ${handsWithAShortPost} hands had a short blind post`);
  assert.deepEqual(
    [...seatCounts].sort((a, b) => a - b),
    [2, 3, 4, 5, 6],
    'every table size was played',
  );
  console.log(
    `      ${handsPlayed} hands, ${actionsApplied} actions | short posts ${shortPosts} across ` +
      `${handsWithAShortPost} hands, decided by the blinds alone ${handsDecidedByTheBlinds}`,
  );
});
