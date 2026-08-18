/**
 * Randomised whole-hand invariant testing.
 *
 * Plays thousands of complete hands with random stacks, seat counts, button
 * positions, blind structures and action choices, asserting after every single
 * action that the state is internally consistent.
 *
 * The value of this is finding the states nobody thinks to write a test for:
 * a short all-in from the small blind that leaves one player able to act, a
 * three-way all-in where two players are covered by the same amount, a hand where
 * everyone is all-in before the flop. Those paths are where engines break, and
 * they are tedious to enumerate by hand.
 *
 * Every invariant below is a property that must hold for *any* legal sequence of
 * actions, not for one particular scripted hand.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { legalActions, seatsInHand, totalPot } from '../src/betting.ts';
import { verifyDeckReveal } from '../src/commitment.ts';
import { applyAction, type StartedHand, startHand } from '../src/machine.ts';
import { assertPotsBalance, buildPotLayers } from '../src/pots.ts';
import { createDeterministicRandomForTests } from '../src/rng.ts';
import type { Action, HandState } from '../src/types.ts';

/** Everything that must be true of a hand state at all times. */
function assertInvariants(state: HandState, chipsAtStart: number, context: string): void {
  const where = `${context} [street=${state.street} seq=${state.actionSequence}]`;

  // --- chip conservation ---
  const inStacks = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  const committed = state.seats.reduce((sum, seat) => sum + seat.committedTotal, 0);
  if (state.street === 'complete') {
    assert.equal(inStacks, chipsAtStart, `${where}: chips must all be back in stacks when complete`);
  } else {
    assert.equal(inStacks + committed, chipsAtStart, `${where}: chips created or destroyed`);
  }

  // --- per-seat sanity ---
  for (const seat of state.seats) {
    assert.ok(seat.stack >= 0, `${where}: seat ${seat.seat} has a negative stack`);
    assert.ok(Number.isInteger(seat.stack), `${where}: seat ${seat.seat} stack is not an integer`);
    assert.ok(seat.committedThisStreet >= 0, `${where}: negative street commitment`);
    assert.ok(
      seat.committedThisStreet <= seat.committedTotal,
      `${where}: seat ${seat.seat} street commitment exceeds its total`,
    );
    // Only while the hand is live. Seat statuses describe the hand *as played* and
    // are deliberately not reset at settlement, because hand review needs to show
    // who folded and who was all-in — so a winner who was all-in ends the hand
    // with status 'allIn' and a stack full of the pot it just won.
    if (seat.status === 'allIn' && state.street !== 'complete') {
      assert.equal(seat.stack, 0, `${where}: an all-in seat must have no chips behind`);
    }
    if (seat.status === 'active' && state.street !== 'complete') {
      // An active seat with no chips should have been marked all-in.
      assert.ok(seat.stack > 0, `${where}: seat ${seat.seat} is active with an empty stack`);
    }
    if (seat.status !== 'sittingOut' && state.street !== 'complete') {
      assert.ok(seat.holeCards !== null, `${where}: seat ${seat.seat} is in the hand without cards`);
    }
  }

  // --- bet level consistency ---
  //
  // This assertion used to read `betLevel === highestCommitment`, which encoded the
  // short-blind defect rather than the rule. The bet level is the largest FULL wager
  // in force, and preflop that starts at the big blind whether or not the player who
  // posted it could cover it: a big blind who is all-in for less than a big blind
  // does not lower the price of playing for everyone else. So with 5/10 blinds and a
  // big blind all-in for 3, the largest commitment on the table is 5 (the small
  // blind) while the bet level is — correctly — 10. The old equality was only ever
  // true because `startHand` derived the level from the commitments, and it made the
  // engine under-charge callers and accept sub-minimum raises.
  //
  // What is true in general is that the level is never below what somebody has
  // already put in, and never above the opening level for the street.
  const highestCommitment = state.seats.reduce((high, seat) => Math.max(high, seat.committedThisStreet), 0);
  const openingLevel = state.street === 'preflop' ? state.config.bigBlind : 0;
  assert.equal(
    state.betLevel,
    Math.max(openingLevel, highestCommitment),
    `${where}: betLevel disagrees with the opening level and the seat commitments`,
  );

  // --- board size matches street ---
  const expectedBoard = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5, complete: state.board.length };
  if (state.street !== 'complete') {
    assert.equal(state.board.length, expectedBoard[state.street], `${where}: wrong board size`);
  }
  assert.equal(new Set(state.board).size, state.board.length, `${where}: duplicate board card`);

  // --- no card is dealt twice ---
  const dealt = [...state.board];
  for (const seat of state.seats) if (seat.holeCards !== null) dealt.push(...seat.holeCards);
  assert.equal(new Set(dealt).size, dealt.length, `${where}: a card was dealt to two places`);

  // --- whose turn it is ---
  if (state.street === 'complete' || state.street === 'showdown') {
    assert.equal(state.toAct, null, `${where}: someone is to act in a terminal phase`);
  } else {
    const actor = state.seats.find((seat) => seat.seat === state.toAct);
    if (state.toAct !== null) {
      assert.ok(actor !== undefined, `${where}: toAct points at a seat that does not exist`);
      assert.equal(actor.status, 'active', `${where}: toAct points at a ${actor.status} seat`);
      assert.ok(legalActions(state, state.toAct).length > 0, `${where}: the actor has no legal actions`);
    }
  }

  // --- pots always balance ---
  assertPotsBalance(state.seats, buildPotLayers(state.seats));
  assert.equal(
    totalPot(state),
    state.potFromPreviousStreets + state.seats.reduce((s, seat) => s + seat.committedThisStreet, 0),
    `${where}: totalPot disagrees with its parts`,
  );

  // --- completion ---
  if (state.street === 'complete') {
    const result = state.result;
    assert.ok(result !== null, `${where}: a complete hand must have a result`);
    const awarded = result.awards.reduce((sum, award) => sum + award.amount, 0);
    const potTotal = result.pots.reduce((sum, pot) => sum + pot.amount, 0);
    assert.equal(awarded, potTotal, `${where}: awards do not match the pots`);
    assert.ok(
      seatsInHand(state).length >= 1,
      `${where}: a complete hand must have at least one player holding cards`,
    );
    // Every reveal a hand publishes must actually verify.
    const verification = verifyDeckReveal(result.reveal);
    assert.equal(
      verification.ok,
      true,
      `${where}: the hand's own reveal failed to verify: ${verification.reason}`,
    );
    // A fold-out hand must reveal no hole cards.
    if (result.endedByFold) {
      assert.equal(result.showdowns.length, 0, `${where}: a fold-out hand must not show hands`);
    }
    // Nobody may finish with a negative net beyond what they put in.
    for (const seat of state.seats) {
      const net = result.netBySeat[seat.seat] ?? 0;
      assert.ok(net >= -seat.committedTotal, `${where}: seat ${seat.seat} lost more than it committed`);
    }
  }
}

/** Picks a legal action, weighted so that aggression and all-ins actually occur. */
function chooseAction(state: HandState, nextInt: (bound: number) => number): Action {
  const seat = state.toAct;
  if (seat === null) throw new Error('no one to act');
  const legal = legalActions(state, seat);
  assert.ok(legal.length > 0, 'the engine offered no legal actions');

  const roll = nextInt(100);
  const aggressive = legal.find((entry) => entry.type === 'bet' || entry.type === 'raise');

  // 25% aggression when available, and when aggressive, sometimes shove.
  if (aggressive !== undefined && roll < 25) {
    const minTo = aggressive.minTo ?? 0;
    const maxTo = aggressive.maxTo ?? minTo;
    const to = nextInt(4) === 0 ? maxTo : minTo + nextInt(Math.max(1, maxTo - minTo + 1));
    const clamped = Math.min(Math.max(to, minTo), maxTo);
    return aggressive.type === 'bet' ? { type: 'bet', to: clamped } : { type: 'raise', to: clamped };
  }
  if (legal.some((entry) => entry.type === 'check')) return { type: 'check' };
  // Fold sometimes rather than always calling, so fold-out paths get exercised.
  if (roll < 45 && legal.some((entry) => entry.type === 'fold')) return { type: 'fold' };
  if (legal.some((entry) => entry.type === 'call')) return { type: 'call' };
  return { type: 'fold' };
}

test('FUZZ: 4000 random hands satisfy every invariant after every action', () => {
  const HANDS = 4000;
  let handsPlayed = 0;
  let actionsApplied = 0;
  let reachedShowdown = 0;
  let endedByFold = 0;
  let sawSidePots = 0;
  let sawAllInPreflop = 0;
  const streetsSeen = new Set<string>();

  for (let handIndex = 0; handIndex < HANDS; handIndex++) {
    const random = createDeterministicRandomForTests(handIndex + 1);
    const nextInt = (bound: number): number => random.nextInt(bound);

    const playerCount = 2 + nextInt(5);
    const bigBlind = [2, 10, 20, 50][nextInt(4)] ?? 2;
    const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
    const ante = nextInt(4) === 0 ? Math.max(1, Math.floor(bigBlind / 4)) : 0;
    const stacks = Array.from({ length: playerCount }, () => {
      // Deliberately include stacks far smaller than the blinds, so short
      // all-in-from-the-blind paths are exercised rather than avoided.
      const scale = nextInt(4);
      if (scale === 0) return 1 + nextInt(bigBlind);
      if (scale === 1) return bigBlind + nextInt(bigBlind * 5);
      return bigBlind * (5 + nextInt(40));
    });

    const chipsAtStart = stacks.reduce((sum, stack) => sum + stack, 0);
    const buttonSeat = nextInt(playerCount);

    let started: StartedHand;
    try {
      started = startHand({
        handId: `fuzz_${handIndex}`,
        roomId: 'fuzz',
        handNumber: handIndex,
        config: { smallBlind, bigBlind, ante, maxSeats: playerCount, actionTimeoutSeconds: 30 },
        buttonSeat,
        seats: stacks.map((stack, seat) => ({ seat, playerId: `p${seat}`, stack })),
        random,
      });
    } catch (error) {
      // startHand legitimately refuses some shapes (fewer than two players with
      // chips). Those are rejections, not failures.
      const message = error instanceof Error ? error.message : String(error);
      assert.match(
        message,
        /at least 2 players|button seat/,
        `hand ${handIndex} was rejected for an unexpected reason: ${message}`,
      );
      continue;
    }

    let state = started.state;
    handsPlayed += 1;
    assertInvariants(state, chipsAtStart, `hand ${handIndex} after deal`);
    if (state.street === 'complete') sawAllInPreflop += 1;

    let guard = 0;
    while (state.street !== 'complete') {
      streetsSeen.add(state.street);
      const seat = state.toAct;
      if (seat === null) {
        assert.fail(`hand ${handIndex} stalled on ${state.street} with nobody to act`);
      }
      const action = chooseAction(state, nextInt);
      state = applyAction(state, seat, action, { actionId: `a${guard}` }).state;
      actionsApplied += 1;
      assertInvariants(state, chipsAtStart, `hand ${handIndex} after action ${guard}`);
      guard += 1;
      assert.ok(guard < 400, `hand ${handIndex} did not terminate after 400 actions`);
    }

    const result = state.result;
    assert.ok(result !== null);
    if (result.endedByFold) endedByFold += 1;
    else reachedShowdown += 1;
    if (result.pots.length > 1) sawSidePots += 1;
  }

  // Coverage assertions: a fuzz run that never reaches the interesting states is
  // not testing anything, so fail if the generator degenerated.
  assert.equal(handsPlayed > HANDS * 0.9, true, `only ${handsPlayed} of ${HANDS} hands were playable`);
  assert.ok(reachedShowdown > 200, `only ${reachedShowdown} hands reached showdown`);
  assert.ok(endedByFold > 200, `only ${endedByFold} hands ended by folding`);
  assert.ok(sawSidePots > 100, `only ${sawSidePots} hands produced side pots`);
  for (const street of ['preflop', 'flop', 'turn', 'river']) {
    assert.ok(streetsSeen.has(street), `the fuzz never reached ${street}`);
  }
  console.log(
    `      ${handsPlayed} hands, ${actionsApplied} actions | showdown ${reachedShowdown}, folded ${endedByFold}, ` +
      `side pots ${sawSidePots}, all-in preflop ${sawAllInPreflop}`,
  );
});

test('FUZZ: replaying the same seed reproduces the hand exactly', () => {
  // Determinism is what makes hand review and bug reports possible: the same seed
  // and the same actions must give the same result, every time.
  const runOnce = (): HandState => {
    const random = createDeterministicRandomForTests(9999);
    let state = startHand({
      handId: 'replay',
      roomId: 'fuzz',
      handNumber: 1,
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 4, actionTimeoutSeconds: 30 },
      buttonSeat: 0,
      seats: [0, 1, 2, 3].map((seat) => ({ seat, playerId: `p${seat}`, stack: 500 })),
      random,
    }).state;
    const nextInt = (bound: number): number => random.nextInt(bound);
    while (state.street !== 'complete') {
      const seat = state.toAct;
      if (seat === null) break;
      state = applyAction(state, seat, chooseAction(state, nextInt)).state;
    }
    return state;
  };
  const first = runOnce();
  const second = runOnce();
  assert.deepEqual(first.board, second.board);
  assert.deepEqual(first.commitment, second.commitment);
  assert.deepEqual(
    first.actions.map((a) => [a.seat, a.action, a.amountPaid]),
    second.actions.map((a) => [a.seat, a.action, a.amountPaid]),
  );
  assert.deepEqual(first.result?.netBySeat, second.result?.netBySeat);
});

test('FUZZ: an illegal action is always rejected, never silently applied', () => {
  // Every rejected action must leave the state completely untouched, or a client
  // could nudge the hand forward with a malformed request.
  const random = createDeterministicRandomForTests(7);
  const state = startHand({
    handId: 'reject',
    roomId: 'fuzz',
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 3, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: [0, 1, 2].map((seat) => ({ seat, playerId: `p${seat}`, stack: 500 })),
    random,
  }).state;

  const before = JSON.stringify({ ...state, deck: 'hidden', deckSalts: 'hidden' });
  const illegal: Array<{ seat: number; action: Action }> = [
    { seat: 0, action: { type: 'check' } },
    { seat: 0, action: { type: 'raise', to: 1 } },
    { seat: 0, action: { type: 'raise', to: 100_000 } },
    { seat: 0, action: { type: 'bet', to: 50 } },
    { seat: 1, action: { type: 'fold' } },
    { seat: 2, action: { type: 'call' } },
    { seat: 99, action: { type: 'fold' } },
  ];
  let rejected = 0;
  for (const attempt of illegal) {
    try {
      applyAction(state, attempt.seat, attempt.action);
    } catch {
      rejected += 1;
    }
    const after = JSON.stringify({ ...state, deck: 'hidden', deckSalts: 'hidden' });
    assert.equal(after, before, `state mutated by a rejected action: ${JSON.stringify(attempt)}`);
  }
  assert.equal(rejected, illegal.length, 'every one of these actions must be rejected');
});
