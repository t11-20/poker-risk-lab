import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCards } from '../src/cards.ts';
import { evaluate } from '../src/evaluate.ts';
import { applyAction } from '../src/machine.ts';
import {
  assertPotsBalance,
  awardPots,
  bestFiveCards,
  buildPotLayers,
  buildPots,
  seatOrderFromButton,
} from '../src/pots.ts';
import type { SeatState } from '../src/types.ts';
import { call, chipsInSystem, deal, play, raise, stackedDeck } from './helpers.ts';

function seat(overrides: Partial<SeatState> & { seat: number }): SeatState {
  return {
    playerId: `p${overrides.seat}`,
    stack: 0,
    committedThisStreet: 0,
    committedTotal: 0,
    holeCards: null,
    status: 'active',
    lastActedAtBetLevel: null,
    isAllInThisHand: false,
    ...overrides,
  };
}

test('a single pot forms when everyone committed the same', () => {
  const seats = [
    seat({ seat: 0, committedTotal: 100 }),
    seat({ seat: 1, committedTotal: 100 }),
    seat({ seat: 2, committedTotal: 100 }),
  ];
  const pots = buildPots(seats);
  assert.equal(pots.length, 1);
  assert.equal(pots[0]?.amount, 300);
  assert.deepEqual(pots[0]?.eligibleSeats, [0, 1, 2]);
});

test('folded players contribute chips but are eligible for nothing', () => {
  const seats = [
    seat({ seat: 0, committedTotal: 100 }),
    seat({ seat: 1, committedTotal: 100, status: 'folded' }),
    seat({ seat: 2, committedTotal: 100 }),
  ];
  const pots = buildPots(seats);
  assert.equal(pots.length, 1);
  assert.equal(pots[0]?.amount, 300, "the folder's chips stay in the pot");
  assert.deepEqual(pots[0]?.eligibleSeats, [0, 2]);
});

test('three different all-in amounts build a main pot and two side pots', () => {
  // Classic: short stack 50, middle 120, big 300 — all in, all live.
  const seats = [
    seat({ seat: 0, committedTotal: 50, status: 'allIn' }),
    seat({ seat: 1, committedTotal: 120, status: 'allIn' }),
    seat({ seat: 2, committedTotal: 300, status: 'allIn' }),
  ];
  const pots = buildPots(seats);
  assert.equal(pots.length, 3);

  // Main pot: 50 from each of three.
  assert.equal(pots[0]?.amount, 150);
  assert.deepEqual(pots[0]?.eligibleSeats, [0, 1, 2]);
  assert.equal(pots[0]?.capPerSeat, 50);

  // First side pot: (120-50) from seats 1 and 2.
  assert.equal(pots[1]?.amount, 140);
  assert.deepEqual(pots[1]?.eligibleSeats, [1, 2]);

  // Second side pot: (300-120) from seat 2 alone — the uncalled portion, which
  // comes straight back without any special-case code.
  assert.equal(pots[2]?.amount, 180);
  assert.deepEqual(pots[2]?.eligibleSeats, [2]);

  assertPotsBalance(seats, { pots, returns: [] });
  assert.equal(
    pots.reduce((sum, pot) => sum + pot.amount, 0),
    470,
  );
});

test('the uncalled portion of a bet returns to the bettor', () => {
  const seats = [
    seat({ seat: 0, committedTotal: 500 }),
    seat({ seat: 1, committedTotal: 100, status: 'folded' }),
  ];
  const pots = buildPots(seats);
  const scores = new Map<number, number>();
  const awards = awardPots({ pots, scores, seats, buttonSeat: 0, maxSeats: 2 });
  const toSeat0 = awards.filter((a) => a.seat === 0).reduce((sum, a) => sum + a.amount, 0);
  assert.equal(toSeat0, 600, 'wins the 100 called plus its own 400 back');
});

test('layers with identical eligibility are merged into one displayed pot', () => {
  // Two all-ins for different amounts but both still eligible for everything they
  // paid into, plus a caller who covers both.
  const seats = [seat({ seat: 0, committedTotal: 100 }), seat({ seat: 1, committedTotal: 100 })];
  const pots = buildPots(seats);
  assert.equal(pots.length, 1, 'no spurious layers when commitments are equal');
  assert.equal(pots[0]?.index, 0);
});

test('a split pot divides evenly and odd chips go left of the button', () => {
  const seats = [
    seat({ seat: 0, committedTotal: 7 }),
    seat({ seat: 1, committedTotal: 7 }),
    seat({ seat: 2, committedTotal: 7 }),
  ];
  const pots = buildPots(seats);
  assert.equal(pots[0]?.amount, 21);
  // All three tie.
  const scores = new Map([
    [0, 500],
    [1, 500],
    [2, 500],
  ]);
  const awards = awardPots({ pots, scores, seats, buttonSeat: 0, maxSeats: 3 });
  const byseat = new Map(awards.map((a) => [a.seat, a.amount]));
  assert.equal(
    awards.reduce((sum, a) => sum + a.amount, 0),
    21,
    'every chip is awarded',
  );
  assert.equal(byseat.get(1), 7);
  assert.equal(byseat.get(2), 7);
  assert.equal(byseat.get(0), 7);

  // An odd chip only exists when the pot does not divide by the number of
  // winners. Three contributors of 7 make a pot of 21; if only two of them tie,
  // the split is 10 each with one chip left over, which must go to the winner
  // first in order left of the button.
  const oddSeats = [
    seat({ seat: 0, committedTotal: 7 }),
    seat({ seat: 1, committedTotal: 7 }),
    seat({ seat: 2, committedTotal: 7 }),
  ];
  const oddPots = buildPots(oddSeats);
  assert.equal(oddPots[0]?.amount, 21);
  const oddAwards = awardPots({
    pots: oddPots,
    // Seats 1 and 2 tie for the best hand; seat 0 loses.
    scores: new Map([
      [0, 100],
      [1, 500],
      [2, 500],
    ]),
    seats: oddSeats,
    buttonSeat: 0,
    maxSeats: 3,
  });
  assert.equal(
    oddAwards.reduce((sum, a) => sum + a.amount, 0),
    21,
    'every chip is awarded when the split is uneven',
  );
  const oddByseat = new Map(oddAwards.map((a) => [a.seat, a.amount]));
  assert.equal(oddByseat.get(1), 11, 'seat 1 is first left of button 0, so it takes the odd chip');
  assert.equal(oddByseat.get(2), 10);
  assert.equal(oddByseat.get(0), undefined, 'a loser is awarded nothing');
  assert.deepEqual(
    oddAwards.filter((a) => a.oddChips > 0).map((a) => a.seat),
    [1],
  );

  // Move the button and the odd chip follows it.
  const movedButton = awardPots({
    pots: oddPots,
    scores: new Map([
      [0, 100],
      [1, 500],
      [2, 500],
    ]),
    seats: oddSeats,
    buttonSeat: 1,
    maxSeats: 3,
  });
  assert.deepEqual(
    movedButton.filter((a) => a.oddChips > 0).map((a) => a.seat),
    [2],
    'with the button on seat 1, seat 2 is first in order',
  );
});

test('odd chip assignment is deterministic and starts left of the button', () => {
  assert.deepEqual(seatOrderFromButton(0, 6, [0, 1, 2, 3, 4, 5]), [1, 2, 3, 4, 5, 0]);
  assert.deepEqual(seatOrderFromButton(4, 6, [0, 1, 2, 3, 4, 5]), [5, 0, 1, 2, 3, 4]);
  assert.deepEqual(seatOrderFromButton(4, 6, [0, 2, 4]), [0, 2, 4]);
});

test('awarding never creates or destroys chips, over many random all-in shapes', () => {
  let checked = 0;
  let rngState = 0x1234567;
  const nextInt = (bound: number): number => {
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    rngState |= 0;
    return Math.abs(rngState) % bound;
  };

  for (let iteration = 0; iteration < 5000; iteration++) {
    const playerCount = 2 + nextInt(5);
    const seats: SeatState[] = [];
    for (let index = 0; index < playerCount; index++) {
      const status = nextInt(4) === 0 ? 'folded' : nextInt(2) === 0 ? 'allIn' : 'active';
      seats.push(seat({ seat: index, committedTotal: 1 + nextInt(200), status }));
    }
    // At least one seat must remain live, otherwise the situation is impossible.
    if (!seats.some((s) => s.status !== 'folded')) {
      const first = seats[0];
      if (first !== undefined) seats[0] = { ...first, status: 'active' };
    }

    // This fuzz deliberately generates shapes that legal play cannot reach —
    // including a folded seat as the single largest contributor. Those are exactly
    // the states that used to make pot construction throw, so they are worth
    // covering: the invariant must be "chips are conserved", not "the inputs were
    // reachable".
    const layers = buildPotLayers(seats);
    assertPotsBalance(seats, layers);

    const scores = new Map<number, number>();
    for (const s of seats) {
      if (s.status !== 'folded') scores.set(s.seat, 1 + nextInt(50));
    }
    const awards = awardPots({
      pots: layers.pots,
      scores,
      seats,
      buttonSeat: nextInt(playerCount),
      maxSeats: playerCount,
    });

    const committed = seats.reduce((sum, s) => sum + s.committedTotal, 0);
    const awarded = awards.reduce((sum, a) => sum + a.amount, 0);
    const returned = layers.returns.reduce((sum, r) => sum + r.amount, 0);
    assert.equal(
      awarded + returned,
      committed,
      `iteration ${iteration}: awarded ${awarded} + returned ${returned} vs committed ${committed}`,
    );
    for (const award of awards) {
      assert.ok(award.amount >= 0, 'no negative awards');
      const winner = seats.find((s) => s.seat === award.seat);
      assert.notEqual(winner?.status, 'folded', 'a folded seat must never WIN chips');
    }
    for (const entry of layers.returns) {
      assert.ok(entry.amount > 0, 'returns are always positive');
      const contributor = seats.find((s) => s.seat === entry.seat);
      assert.ok(contributor !== undefined);
      assert.ok(entry.amount <= contributor.committedTotal, 'nobody gets back more than they put in');
    }
    checked += 1;
  }
  assert.equal(checked, 5000);
});

test('bestFiveCards returns the five cards that actually make the hand', () => {
  const cards = parseCards('Ah Kh Qh Jh Th 2c 3d');
  const best = bestFiveCards(cards);
  assert.equal(best.length, 5);
  assert.equal(evaluate(best), evaluate(cards));
  assert.deepEqual(
    [...best].sort((a, b) => a - b),
    [...parseCards('Th Jh Qh Kh Ah')].sort((a, b) => a - b),
  );
});

test('end to end: a three-way all-in builds side pots and pays the right players', () => {
  // Seat 0 (BTN, 300), seat 1 (SB, 50), seat 2 (BB, 120).
  // Deal order left of button: 1, 2, 0.
  // Give seat 1 the best hand, seat 2 second, seat 0 worst — so the short stack
  // wins the main pot and seat 2 takes the side pot.
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KhKd', 0: '3s5c' }, [1, 2, 0], 'Qh 8s 2c 4d 9h');
  const { state } = deal({
    stacks: [300, 50, 120],
    buttonSeat: 0,
    config: { maxSeats: 3, smallBlind: 1, bigBlind: 2 },
    fixedDeck: deck,
  });
  const before = chipsInSystem(state);

  // Everyone gets all-in. Seat 0 acts first three-handed.
  let current = applyAction(state, 0, { type: 'raise', to: 300 }).state;
  current = applyAction(current, 1, { type: 'call' }).state;
  current = applyAction(current, 2, { type: 'call' }).state;

  assert.equal(current.street, 'complete', 'all-in runs the board out');
  assert.equal(current.board.length, 5);
  assert.equal(chipsInSystem(current), before, 'chips conserved');

  const result = current.result;
  assert.ok(result !== null);
  assert.equal(result.pots.length, 3, 'main pot plus two side pots');

  // Seat 1 has aces and wins the main pot (50 x 3 = 150).
  const mainPot = result.pots[0];
  assert.equal(mainPot?.amount, 150);
  const mainAward = result.awards.filter((a) => a.potIndex === 0);
  assert.equal(mainAward.length, 1);
  assert.equal(mainAward[0]?.seat, 1);

  // Seat 2 has kings and beats seat 0, taking the first side pot ((120-50) x 2 = 140).
  const sideAward = result.awards.filter((a) => a.potIndex === 1);
  assert.equal(sideAward[0]?.seat, 2);
  assert.equal(result.pots[1]?.amount, 140);

  // The rest is seat 0's uncalled money coming back.
  const returned = result.awards.filter((a) => a.potIndex === 2);
  assert.equal(returned[0]?.seat, 0);
  assert.equal(result.pots[2]?.amount, 180);

  assert.equal(result.netBySeat[1], 100, 'short stack doubles its 50 twice over');
  assert.equal(result.netBySeat[2], 20);
  assert.equal(result.netBySeat[0], -120);
});

test('a chopped pot in a real hand splits the chips', () => {
  // Both players play the board: identical hands.
  const deck = stackedDeck({ 1: '2c3d', 0: '2h3h' }, [1, 0], 'Ah Ad Ac Ks Kd');
  const { state } = deal({
    stacks: [100, 100],
    buttonSeat: 0,
    config: { maxSeats: 2, smallBlind: 1, bigBlind: 2 },
    fixedDeck: deck,
  });
  const finished = play(state, [call(0), raise(1, 100), call(0)]);
  assert.equal(finished.street, 'complete');
  const result = finished.result;
  assert.ok(result !== null);
  assert.equal(result.showdowns.length, 2);
  assert.equal(result.showdowns[0]?.score, result.showdowns[1]?.score, 'both play the same board');
  assert.equal(result.awards.length, 2);
  assert.ok(result.awards.every((a) => a.wasSplit));
  assert.equal(result.netBySeat[0], 0);
  assert.equal(result.netBySeat[1], 0);
  assert.equal(chipsInSystem(finished), 200);
});
