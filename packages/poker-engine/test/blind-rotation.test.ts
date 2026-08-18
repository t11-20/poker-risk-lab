/**
 * The dead-button rule, and hands dealt under it.
 *
 * ## The gap this closes
 *
 * Every other test in this package deals to a roster fixed before the first hand: `deal()` in
 * `helpers.ts` takes an array of stacks and a button, and nothing ever moves. That exercises the
 * blinds thoroughly for ONE hand and never once for a sequence of them, which is why a rotation
 * that charged six players the big blind twice in a row over forty hands could sit in the tree
 * with 119 green engine tests above it (`docs/audit/poker-correctness.md`, P1-1: "no test in the
 * repo varies the roster between hands").
 *
 * ## The rule, stated once
 *
 *   1. The big blind advances by exactly ONE live player per hand. It is the anchor.
 *   2. The small blind falls where the big blind was — and is DEAD if nobody in the hand is there.
 *   3. The button falls where the small blind was — and is DEAD if nobody in the hand is there.
 *
 * Rule 1 is the property everything else exists to protect, and it is what the soak at the bottom
 * asserts hand by hand over a roster that changes underneath it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyAction, startHand } from '../src/machine.ts';
import {
  advanceBlindRotation,
  type BlindPositions,
  type BlindRotation,
  nextOccupied,
  positionLabels,
  seedBlindRotation,
} from '../src/positions.ts';
import { redactFor } from '../src/redact.ts';
import type { HandState, SeatIndex } from '../src/types.ts';
import { chipsInSystem, config, testRandom } from './helpers.ts';

const MAX_SEATS = 6;

/** `advanceBlindRotation` for a six-max table, with the boilerplate out of the way. */
function advance(
  previous: BlindPositions,
  entrants: readonly SeatIndex[],
  awaitingBigBlind: readonly SeatIndex[] = [],
): ReturnType<typeof advanceBlindRotation> {
  return advanceBlindRotation({ previous, maxSeats: MAX_SEATS, entrants, awaitingBigBlind });
}

describe('the dead-button rotation', () => {
  it('seeds the first hand from the button, because nobody has paid anything yet', () => {
    const seeded = seedBlindRotation(1, MAX_SEATS, [0, 1, 3]);
    assert.deepEqual(
      { button: seeded.buttonSeat, small: seeded.smallBlindSeat, big: seeded.bigBlindSeat },
      { button: 1, small: 3, big: 0 },
    );
    assert.equal(seeded.buttonIsDead, false);
    assert.equal(seeded.isHeadsUp, false);
  });

  it('moves the big blind one seat on and drags the other two positions behind it', () => {
    // The audit's minimal repro, as a rotation: seats 0/1/3 deal BTN 1 / SB 3 / BB 0, then
    // somebody takes seat 2. The old rule moved the BUTTON to seat 2 and re-derived the blinds
    // onto seats 3 and 0, charging seat 0 a second consecutive big blind.
    const first = seedBlindRotation(1, MAX_SEATS, [0, 1, 3]);
    const second = advance(first.positions, [0, 1, 2, 3]);
    assert.deepEqual(
      { button: second.buttonSeat, small: second.smallBlindSeat, big: second.bigBlindSeat },
      { button: 3, small: 0, big: 1 },
    );
    assert.notEqual(second.bigBlindSeat, first.bigBlindSeat);
  });

  it('leaves the small blind dead rather than charging the next player twice', () => {
    const first = seedBlindRotation(1, MAX_SEATS, [0, 1, 2, 3]);
    assert.deepEqual({ small: first.smallBlindSeat, big: first.bigBlindSeat }, { small: 2, big: 3 });

    // The big blind leaves. Their seat is where the small blind belongs next hand, and there is
    // nobody in it. Seat 0 is next in line — and has just paid the big blind, so moving the small
    // blind onto them would be the same charge-twice defect wearing a different hat.
    const second = advance(first.positions, [0, 1, 2]);
    assert.deepEqual(
      { button: second.buttonSeat, small: second.smallBlindSeat, big: second.bigBlindSeat },
      { button: 2, small: null, big: 0 },
    );
    assert.equal(second.buttonIsDead, false);
  });

  it('leaves the button dead rather than moving it onto a live seat', () => {
    const first = seedBlindRotation(1, MAX_SEATS, [0, 1, 2, 3]);
    // The small blind leaves. The button belongs on their seat next hand and nobody is there.
    const second = advance(first.positions, [0, 1, 3]);
    assert.deepEqual(
      { button: second.buttonSeat, small: second.smallBlindSeat, big: second.bigBlindSeat },
      { button: 2, small: 3, big: 0 },
    );
    assert.equal(second.buttonIsDead, true);
    assert.ok(!second.dealtIn.includes(2), 'a dead button seat is not in the hand');
  });

  it('keeps a dead position in the rotation so the next hand still knows where it was', () => {
    // Two departures in a row. The button position for hand three comes from the small blind
    // position of hand two, which was itself dead — a rotation that only remembered occupied
    // seats would have lost its place here and restarted from the wrong seat.
    const first = seedBlindRotation(1, MAX_SEATS, [0, 1, 2, 3]);
    const second = advance(first.positions, [0, 1, 3]);
    assert.equal(second.positions.buttonSeat, 2, 'the dead button is still recorded');
    const third = advance(second.positions, [0, 1, 3]);
    assert.deepEqual(
      { button: third.buttonSeat, small: third.smallBlindSeat, big: third.bigBlindSeat },
      { button: 3, small: 0, big: 1 },
    );
  });

  it('gives the non-big-blind seat both positions heads-up, however the table got there', () => {
    // Three handed down to two. The big blind still advances by one live player, and the other
    // seat takes both the button and the small blind — which is the heads-up rule, and is NOT
    // what a blind shift of the three positions would produce.
    const threeHanded = seedBlindRotation(0, MAX_SEATS, [0, 1, 2]);
    assert.deepEqual(
      { small: threeHanded.smallBlindSeat, big: threeHanded.bigBlindSeat },
      { small: 1, big: 2 },
    );
    const headsUp = advance(threeHanded.positions, [0, 2]);
    assert.equal(headsUp.isHeadsUp, true);
    assert.equal(headsUp.bigBlindSeat, 0, 'the big blind advances to the next live player');
    assert.equal(headsUp.smallBlindSeat, 2);
    assert.equal(headsUp.buttonSeat, 2, 'heads-up the button IS the small blind');

    const next = advance(headsUp.positions, [0, 2]);
    assert.equal(next.bigBlindSeat, 2, 'and it alternates');
    assert.equal(next.buttonSeat, 0);
    assert.equal(next.smallBlindSeat, 0);
  });

  it('deals a waiting seat in exactly when the big blind reaches it', () => {
    // Seats 0/1/2 deal BTN 1 / SB 2 / BB 0, then seat 4 sits down owing a blind. Seat 4 is three
    // places behind the big blind, so it sits out two hands and enters on the third.
    const first = seedBlindRotation(1, MAX_SEATS, [0, 1, 2]);
    assert.deepEqual({ small: first.smallBlindSeat, big: first.bigBlindSeat }, { small: 2, big: 0 });
    const entrants = [0, 1, 2, 4];

    const second = advance(first.positions, entrants, [4]);
    assert.equal(second.bigBlindSeat, 1);
    assert.ok(!second.dealtIn.includes(4), 'not dealt in while the big blind is elsewhere');

    const third = advance(second.positions, entrants, [4]);
    assert.equal(third.bigBlindSeat, 2);
    assert.ok(!third.dealtIn.includes(4), 'still not dealt in the hand before its turn');

    const fourth = advance(third.positions, entrants, [4]);
    assert.equal(fourth.bigBlindSeat, 4, 'the big blind reaches the waiting seat');
    assert.ok(fourth.dealtIn.includes(4), 'and posting it is what deals them in');
    // The rotation walks EVERY entrant, waiting or not: a seat that is skipped for the deal is
    // still skipped over by the big blind, or it would never be reached at all.
    assert.deepEqual([...fourth.dealtIn], [0, 1, 2, 4]);
  });

  it('refuses a rotation that cannot seat two players', () => {
    const first = seedBlindRotation(0, MAX_SEATS, [0, 1, 2]);
    assert.throws(() => advance(first.positions, [0]), /at least 2 seats in the rotation/);
    assert.throws(() => advance(first.positions, [0, 1, 2], [1, 2]), /at least 2 seats dealt in/);
  });
});

describe('a hand dealt with a dead button', () => {
  /** Six-max, seats 0/1/3 in the hand, the button dead on the empty seat 2. */
  function deadButtonHand(): HandState {
    return startHand({
      handId: 'h_dead_button',
      roomId: 'r1',
      handNumber: 7,
      config: config({ smallBlind: 5, bigBlind: 10, maxSeats: MAX_SEATS }),
      buttonSeat: 2,
      blinds: { smallBlindSeat: 3, bigBlindSeat: 0 },
      seats: [
        { seat: 0, playerId: 'p0', stack: 500 },
        { seat: 1, playerId: 'p1', stack: 500 },
        { seat: 3, playerId: 'p3', stack: 500 },
      ],
      random: testRandom(3),
    }).state;
  }

  it('posts the blinds where the rotation put them, not where the button implies', () => {
    const state = deadButtonHand();
    assert.deepEqual(
      state.forcedBets.map((bet) => [bet.kind, bet.seat, bet.amount]),
      [
        ['smallBlind', 3, 5],
        ['bigBlind', 0, 10],
      ],
    );
    assert.equal(state.betLevel, 10);
    assert.equal(state.smallBlindSeat, 3);
    assert.equal(state.bigBlindSeat, 0);
  });

  it('opens the action after the big blind, and postflop after the empty button seat', () => {
    const state = deadButtonHand();
    assert.equal(state.toAct, 1, 'under the gun is the seat after the big blind');

    // Everyone calls, so the hand reaches a flop with all three still in.
    let current = state;
    current = applyAction(current, 1, { type: 'call' }).state;
    current = applyAction(current, 3, { type: 'call' }).state;
    current = applyAction(current, 0, { type: 'check' }).state;
    assert.equal(current.street, 'flop');
    assert.equal(current.toAct, 3, 'the first live seat clockwise from the dead button acts first');
  });

  it('labels the seats without inventing a button, and settles with chips intact', () => {
    const state = deadButtonHand();
    const labels = positionLabels(state.buttonSeat, MAX_SEATS, [0, 1, 3], {
      smallBlindSeat: state.smallBlindSeat,
      bigBlindSeat: state.bigBlindSeat,
    });
    assert.equal(labels.get(3), 'SB');
    assert.equal(labels.get(0), 'BB');
    assert.equal(labels.get(2), undefined, 'a dead button seat gets no label: nobody is on it');
    assert.ok(![...labels.values()].includes('BTN'), 'and nobody else is given the button either');

    // `redactFor` labels from the state's own blinds; deriving them from a dead button would
    // throw, which would take every view of the hand with it.
    const view = redactFor(state, { viewerPlayerId: 'p1' });
    assert.equal(view.seats.find((seat) => seat.seat === 0)?.position, 'BB');
    assert.ok(
      view.seats.every((seat) => !seat.isButton),
      'no seat holds a dead button',
    );

    const before = chipsInSystem(state);
    let current = state;
    current = applyAction(current, 1, { type: 'fold' }).state;
    current = applyAction(current, 3, { type: 'fold' }).state;
    assert.equal(current.street, 'complete');
    assert.equal(chipsInSystem(current), before);
  });
});

describe('a hand dealt with a dead small blind', () => {
  it('posts one blind and charges nobody for the missing one', () => {
    const state = startHand({
      handId: 'h_dead_sb',
      roomId: 'r1',
      handNumber: 8,
      config: config({ smallBlind: 5, bigBlind: 10, maxSeats: MAX_SEATS }),
      buttonSeat: 2,
      blinds: { smallBlindSeat: null, bigBlindSeat: 0 },
      seats: [
        { seat: 0, playerId: 'p0', stack: 500 },
        { seat: 1, playerId: 'p1', stack: 500 },
        { seat: 2, playerId: 'p2', stack: 500 },
      ],
      random: testRandom(4),
    }).state;

    assert.deepEqual(
      state.forcedBets.map((bet) => [bet.kind, bet.seat, bet.amount]),
      [['bigBlind', 0, 10]],
    );
    assert.equal(state.smallBlindSeat, null);
    assert.equal(state.betLevel, 10, 'the price to play is still one full big blind');
    assert.equal(state.toAct, 1, 'the seat after the big blind opens');

    const labels = positionLabels(state.buttonSeat, MAX_SEATS, [0, 1, 2], {
      smallBlindSeat: state.smallBlindSeat,
      bigBlindSeat: state.bigBlindSeat,
    });
    assert.equal(labels.get(2), 'BTN');
    assert.equal(labels.get(0), 'BB');
    assert.ok(![...labels.values()].includes('SB'), 'nobody is labelled the small blind');

    const before = chipsInSystem(state);
    let current = applyAction(state, 1, { type: 'fold' }).state;
    current = applyAction(current, 2, { type: 'fold' }).state;
    assert.equal(current.street, 'complete');
    assert.equal(chipsInSystem(current), before);
    // Nothing but the big blind was ever at risk, and it comes straight back.
    assert.equal(current.seats.find((seat) => seat.seat === 0)?.stack, 500);
  });

  it('refuses blinds that do not describe a hand it could deal', () => {
    const base = {
      handId: 'h_bad',
      roomId: 'r1',
      handNumber: 1,
      config: config({ maxSeats: MAX_SEATS }),
      seats: [
        { seat: 0, playerId: 'p0', stack: 500 },
        { seat: 1, playerId: 'p1', stack: 500 },
        { seat: 2, playerId: 'p2', stack: 500 },
      ],
      random: testRandom(5),
    } as const;

    assert.throws(
      () => startHand({ ...base, buttonSeat: 0, blinds: { smallBlindSeat: 1, bigBlindSeat: 4 } }),
      /big blind seat 4 has no player with chips/,
    );
    assert.throws(
      () => startHand({ ...base, buttonSeat: 0, blinds: { smallBlindSeat: 4, bigBlindSeat: 1 } }),
      /small blind seat 4 has no player with chips; pass null/,
    );
    assert.throws(
      () => startHand({ ...base, buttonSeat: 0, blinds: { smallBlindSeat: 1, bigBlindSeat: 1 } }),
      /seat 1 cannot post both blinds/,
    );
    assert.throws(
      () =>
        startHand({
          ...base,
          seats: base.seats.slice(0, 2),
          buttonSeat: 0,
          blinds: { smallBlindSeat: 1, bigBlindSeat: 0 },
        }),
      /heads-up the button posts the small blind/,
    );
  });
});

describe('SOAK: the blinds over a roster that changes every hand', () => {
  it('advances the big blind by exactly one live player, for 400 hands', () => {
    const random = testRandom(20_260_818);
    const tableConfig = config({ smallBlind: 5, bigBlind: 10, maxSeats: MAX_SEATS });
    const stacks = new Map<SeatIndex, number>([
      [0, 2_000],
      [1, 2_000],
      [2, 2_000],
    ]);
    let positions: BlindPositions | null = null;
    let previousBigBlind: SeatIndex | null = null;
    let chipsBoughtIn = 6_000;
    let handsPlayed = 0;

    // A deterministic pseudo-random schedule: every hand, one seat may leave and one may arrive.
    // Deterministic so a failure is reproducible, and driven off the engine's own test generator
    // so there is no second source of randomness to keep honest.
    const roll = (bound: number): number => random.nextInt(bound);

    for (let hand = 1; hand <= 400; hand += 1) {
      // Departures and arrivals, before the deal. Never below two seats: a table that cannot deal
      // is not what this soak is about.
      if (stacks.size > 2 && roll(4) === 0) {
        const seats = [...stacks.keys()];
        const leaving = seats[roll(seats.length)];
        if (leaving !== undefined) {
          chipsBoughtIn -= stacks.get(leaving) ?? 0;
          stacks.delete(leaving);
        }
      }
      if (stacks.size < MAX_SEATS && roll(3) === 0) {
        const free = [0, 1, 2, 3, 4, 5].filter((seat) => !stacks.has(seat));
        const arriving = free[roll(free.length)];
        if (arriving !== undefined) {
          stacks.set(arriving, 2_000);
          chipsBoughtIn += 2_000;
        }
      }

      const entrants = [...stacks.keys()].sort((a, b) => a - b);
      // No blind obligations here: this soak is about the ROTATION, and mixing the entry rule in
      // would make a failure ambiguous between the two. `apps/api/test/table-blinds.test.ts`
      // covers obligations against the live table, which is where they live.
      // Annotated rather than inferred: `positions` is written from `rotation.positions` at the
      // bottom of the loop, so without it the two infer through each other and land on `any`.
      const rotation: BlindRotation =
        positions === null
          ? seedBlindRotation(entrants[0] ?? 0, MAX_SEATS, entrants)
          : advanceBlindRotation({ previous: positions, maxSeats: MAX_SEATS, entrants });

      if (previousBigBlind !== null) {
        assert.equal(
          rotation.bigBlindSeat,
          nextOccupied(previousBigBlind, MAX_SEATS, entrants),
          `hand ${hand}: the big blind must advance by exactly one seat in the rotation ` +
            `(${entrants.join(',')}) from seat ${previousBigBlind}`,
        );
        assert.notEqual(
          rotation.bigBlindSeat,
          previousBigBlind,
          `hand ${hand}: seat ${previousBigBlind} was charged the big blind twice in a row`,
        );
      }

      const started = startHand({
        handId: `h_soak_${hand}`,
        roomId: 'r_soak',
        handNumber: hand,
        config: tableConfig,
        buttonSeat: rotation.buttonSeat,
        blinds: { smallBlindSeat: rotation.smallBlindSeat, bigBlindSeat: rotation.bigBlindSeat },
        seats: rotation.dealtIn.map((seat) => ({
          seat,
          playerId: `p${seat}`,
          stack: stacks.get(seat) ?? 0,
        })),
        random,
      });

      // The small blind is dead exactly when its seat is not in the hand, and never otherwise.
      const posted = new Set(started.state.forcedBets.map((bet) => bet.kind));
      assert.equal(
        posted.has('smallBlind'),
        rotation.smallBlindSeat !== null,
        `hand ${hand}: a small blind was posted iff the rotation says one is live`,
      );

      let current = started.state;
      const before = chipsInSystem(current);
      for (let guard = 0; guard <= 64 && current.street !== 'complete'; guard += 1) {
        const toAct = current.toAct;
        if (toAct === null) break;
        current = applyAction(current, toAct, { type: 'fold' }).state;
      }
      assert.equal(current.street, 'complete', `hand ${hand} did not finish`);
      assert.equal(chipsInSystem(current), before, `hand ${hand} created or destroyed chips`);

      for (const seat of current.seats) stacks.set(seat.seat, seat.stack);
      const onTable = [...stacks.values()].reduce((sum, stack) => sum + stack, 0);
      assert.equal(onTable, chipsBoughtIn, `hand ${hand}: chips on the table drifted`);

      positions = rotation.positions;
      previousBigBlind = rotation.bigBlindSeat;
      handsPlayed += 1;
    }

    assert.equal(handsPlayed, 400);
  });
});
