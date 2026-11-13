/**
 * Randomised whole-hand invariants. Thousands of hands with random stacks, seats, buttons, blinds
 * and actions, asserting consistency after every action. It reaches the shapes nobody scripts, such
 * as a short all-in from the small blind or a three-way all-in before the flop.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { amountToCall, legalActions, seatsInHand, totalPot } from '../src/betting.ts';
import { verifyDeckReveal } from '../src/commitment.ts';
import { applyAction, type StartedHand, startHand } from '../src/machine.ts';
import { assertPotsBalance, buildPotLayers, contestablePotFor } from '../src/pots.ts';
import { createDeterministicRandomForTests } from '../src/rng.ts';
import type { Action, HandState, SeatIndex } from '../src/types.ts';

function assertInvariants(state: HandState, chipsAtStart: number, context: string): void {
  const where = `${context} [street=${state.street} seq=${state.actionSequence}]`;

  const inStacks = state.seats.reduce((sum, seat) => sum + seat.stack, 0);
  const committed = state.seats.reduce((sum, seat) => sum + seat.committedTotal, 0);
  if (state.street === 'complete') {
    assert.equal(inStacks, chipsAtStart, `${where}: chips must all be back in stacks when complete`);
  } else {
    assert.equal(inStacks + committed, chipsAtStart, `${where}: chips created or destroyed`);
  }

  for (const seat of state.seats) {
    assert.ok(seat.stack >= 0, `${where}: seat ${seat.seat} has a negative stack`);
    assert.ok(Number.isInteger(seat.stack), `${where}: seat ${seat.seat} stack is not an integer`);
    assert.ok(seat.committedThisStreet >= 0, `${where}: negative street commitment`);
    assert.ok(
      seat.committedThisStreet <= seat.committedTotal,
      `${where}: seat ${seat.seat} street commitment exceeds its total`,
    );
    // Statuses are not reset at settlement, because hand review shows who folded and who was all-in.
    if (seat.status === 'allIn' && state.street !== 'complete') {
      assert.equal(seat.stack, 0, `${where}: an all-in seat must have no chips behind`);
    }
    if (seat.status === 'active' && state.street !== 'complete') {
      assert.ok(seat.stack > 0, `${where}: seat ${seat.seat} is active with an empty stack`);
    }
    if (seat.status !== 'sittingOut' && state.street !== 'complete') {
      assert.ok(seat.holeCards !== null, `${where}: seat ${seat.seat} is in the hand without cards`);
    }
  }

  // The bet level is never below any commitment and never above the street's opening level. It is
  // not the largest commitment (a short big blind does not lower it), see short-blinds.test.ts.
  const highestCommitment = state.seats.reduce((high, seat) => Math.max(high, seat.committedThisStreet), 0);
  const openingLevel = state.street === 'preflop' ? state.config.bigBlind : 0;
  assert.equal(
    state.betLevel,
    Math.max(openingLevel, highestCommitment),
    `${where}: betLevel disagrees with the opening level and the seat commitments`,
  );

  const expectedBoard = { preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5, complete: state.board.length };
  if (state.street !== 'complete') {
    assert.equal(state.board.length, expectedBoard[state.street], `${where}: wrong board size`);
  }
  assert.equal(new Set(state.board).size, state.board.length, `${where}: duplicate board card`);

  const dealt = [...state.board];
  for (const seat of state.seats) if (seat.holeCards !== null) dealt.push(...seat.holeCards);
  assert.equal(new Set(dealt).size, dealt.length, `${where}: a card was dealt to two places`);

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

  assertPotsBalance(state.seats, buildPotLayers(state.seats));
  assert.equal(
    totalPot(state),
    state.potFromPreviousStreets + state.seats.reduce((s, seat) => s + seat.committedThisStreet, 0),
    `${where}: totalPot disagrees with its parts`,
  );

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
    const verification = verifyDeckReveal(result.reveal);
    assert.equal(
      verification.ok,
      true,
      `${where}: the hand's own reveal failed to verify: ${verification.reason}`,
    );
    if (result.endedByFold) {
      assert.equal(result.showdowns.length, 0, `${where}: a fold-out hand must not show hands`);
    }
    for (const seat of state.seats) {
      const net = result.netBySeat[seat.seat] ?? 0;
      assert.ok(net >= -seat.committedTotal, `${where}: seat ${seat.seat} lost more than it committed`);
    }
  }
}

/**
 * Checks the pot a seat about to act could win, over every shape the fuzz reaches (including
 * multiway two-side-pot cases). The oracle sums `min(committedTotal, hero's cap)` over whole-hand
 * totals, a different derivation from `contestablePotFor`'s street-only layering. They agree only if
 * a seat to act has matched every completed street, which is what this tests.
 *
 * @returns 1 when the engine capped this seat's call, 0 otherwise
 */
function assertContestablePot(state: HandState, seat: SeatIndex, where: string): number {
  const actor = state.seats.find((entry) => entry.seat === seat);
  assert.ok(actor !== undefined, `${where}: the seat to act does not exist`);
  const call = amountToCall(state, actor);
  const pot = totalPot(state);
  const share = contestablePotFor({ seats: state.seats, heroSeat: seat, callAmount: call, potTotal: pot });

  const cap = actor.committedTotal + call;
  let oracle = -call;
  for (const entry of state.seats) {
    oracle += Math.min(entry.committedTotal + (entry.seat === seat ? call : 0), cap);
  }
  assert.equal(
    share.contestable,
    oracle,
    `${where}: the street layering says seat ${seat} can win ${share.contestable} where the whole-hand ` +
      `totals say ${oracle}`,
  );
  assert.equal(
    share.contestable + share.uncontestable,
    pot,
    `${where}: the two halves of the pot do not add up to it`,
  );

  const capped = call > 0 && state.betLevel - actor.committedThisStreet > actor.stack;
  if (!capped) {
    // Negative control. A seat that covers the bet has nothing above its reach.
    assert.equal(
      share.contestable,
      pot,
      `${where}: seat ${seat} covers the ${call} owed out of ${actor.stack} behind, so nothing in the ` +
        `middle is beyond its reach — but ${share.uncontestable} was withheld`,
    );
  }
  return capped ? 1 : 0;
}

function chooseAction(state: HandState, nextInt: (bound: number) => number): Action {
  const seat = state.toAct;
  if (seat === null) throw new Error('no one to act');
  const legal = legalActions(state, seat);
  assert.ok(legal.length > 0, 'the engine offered no legal actions');

  const roll = nextInt(100);
  const aggressive = legal.find((entry) => entry.type === 'bet' || entry.type === 'raise');

  if (aggressive !== undefined && roll < 25) {
    const minTo = aggressive.minTo ?? 0;
    const maxTo = aggressive.maxTo ?? minTo;
    const to = nextInt(4) === 0 ? maxTo : minTo + nextInt(Math.max(1, maxTo - minTo + 1));
    const clamped = Math.min(Math.max(to, minTo), maxTo);
    return aggressive.type === 'bet' ? { type: 'bet', to: clamped } : { type: 'raise', to: clamped };
  }
  if (legal.some((entry) => entry.type === 'check')) return { type: 'check' };
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
  let cappedCalls = 0;
  let cappedWithASidePot = 0;
  let worstUnderstatement = 1;
  const streetsSeen = new Set<string>();

  for (let handIndex = 0; handIndex < HANDS; handIndex++) {
    const random = createDeterministicRandomForTests(handIndex + 1);
    const nextInt = (bound: number): number => random.nextInt(bound);

    const playerCount = 2 + nextInt(5);
    const bigBlind = [2, 10, 20, 50][nextInt(4)] ?? 2;
    const smallBlind = Math.max(1, Math.floor(bigBlind / 2));
    const ante = nextInt(4) === 0 ? Math.max(1, Math.floor(bigBlind / 4)) : 0;
    const stacks = Array.from({ length: playerCount }, () => {
      // Include stacks far below the blinds, so short all-ins from the blinds occur.
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
      // `startHand` refuses some shapes (fewer than two players with chips).
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
      const capped = assertContestablePot(state, seat, `hand ${handIndex} before action ${guard}`);
      cappedCalls += capped;
      if (capped === 1) {
        const actor = state.seats.find((entry) => entry.seat === seat);
        const call = actor === undefined ? 0 : amountToCall(state, actor);
        const pot = totalPot(state);
        const share = contestablePotFor({
          seats: state.seats,
          heroSeat: seat,
          callAmount: call,
          potTotal: pot,
        });
        if (share.uncontestable > 0) {
          cappedWithASidePot += 1;
          // How much the whole middle understated the equity a call needs.
          const honest = call / (share.contestable + call);
          const misleading = call / (pot + call);
          worstUnderstatement = Math.max(worstUnderstatement, honest / misleading);
        }
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

  // A fuzz that never reaches the interesting states tests nothing.
  assert.equal(handsPlayed > HANDS * 0.9, true, `only ${handsPlayed} of ${HANDS} hands were playable`);
  assert.ok(reachedShowdown > 200, `only ${reachedShowdown} hands reached showdown`);
  assert.ok(endedByFold > 200, `only ${endedByFold} hands ended by folding`);
  assert.ok(sawSidePots > 100, `only ${sawSidePots} hands produced side pots`);
  // Without short stacks the capped-case assertions would pass over zero cases.
  assert.ok(cappedCalls > 200, `only ${cappedCalls} decision points had a call capped at the stack`);
  assert.ok(
    cappedWithASidePot > 100,
    `only ${cappedWithASidePot} capped calls left chips beyond hero's reach, which is the case this checks`,
  );
  for (const street of ['preflop', 'flop', 'turn', 'river']) {
    assert.ok(streetsSeen.has(street), `the fuzz never reached ${street}`);
  }
  console.log(
    `      ${handsPlayed} hands, ${actionsApplied} actions | showdown ${reachedShowdown}, folded ${endedByFold}, ` +
      `side pots ${sawSidePots}, all-in preflop ${sawAllInPreflop} | capped calls ${cappedCalls}, ` +
      `of which ${cappedWithASidePot} faced a side pot they could not win (worst price understated ` +
      `${worstUnderstatement.toFixed(1)}x)`,
  );
});

test('FUZZ: replaying the same seed reproduces the hand exactly', () => {
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
  // A rejected action must leave the state untouched, or a malformed request could move the hand.
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
