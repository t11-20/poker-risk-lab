/**
 * Position badges on the replay and the Lab, which build their own `PlayerView`. Under the dead-button
 * rule `button + 1` is not always the small blind, and a table is sized by its highest seat index.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scenarioById, scenarios } from '@prl/content';
import type { HandReviewDecision, HandReviewResponse, HandReviewSeat } from '@prl/contracts';
import { buildHandReplay } from '../src/lib/hand-replay.ts';
import { scenarioToPlayerView } from '../src/lib/scenario-view.ts';

interface SeatFixture {
  readonly seat: number;
  readonly startingStack: number;
  readonly net: number;
}

function seatsOf(fixtures: readonly SeatFixture[]): readonly HandReviewSeat[] {
  return fixtures.map((fixture) => ({
    seat: fixture.seat,
    displayName: `Seat ${fixture.seat}`,
    isBot: false,
    startingStack: fixture.startingStack,
    net: fixture.net,
    holeCards: null,
    showedDown: false,
  }));
}

function decision(
  sequence: number,
  seat: number,
  action: string,
  amountPaid: number,
  potBefore: number,
): HandReviewDecision {
  return {
    sequence,
    street: 'preflop',
    seat,
    action,
    to: null,
    amountPaid,
    potBefore,
    wasAutomatic: false,
    automaticReason: null,
    analysis: null,
  };
}

function reviewOf(
  seats: readonly SeatFixture[],
  decisions: readonly HandReviewDecision[],
  potTotal: number,
): HandReviewResponse {
  return {
    hand: {
      id: 'hand_x3labelsaaaaaaaaaaaaaaa',
      roomId: 'room_x3labelsaaaaaaaaaaaaaa',
      handNumber: 4,
      startedAt: '2026-08-19T09:00:00.000Z',
      completedAt: '2026-08-19T09:01:00.000Z',
      board: [],
      heroNet: null,
      endedByFold: true,
      potTotal,
    },
    commitmentRoot: 'a'.repeat(64),
    commitmentContext: 'room_x3labelsaaaaaaaaaaaaaa:4:hand_x3labelsaaaaaaaaaaaaaaa',
    reveal: null,
    verification: { ok: true, verifiedPositions: 0 },
    seats: seatsOf(seats),
    decisions,
  };
}

/** The badge each seat carries in the replay's first frame, which is what the page renders. */
function labelsOf(review: HandReviewResponse): Record<number, string | null> {
  const replay = buildHandReplay(review);
  const first = replay.steps[0];
  assert.ok(first !== undefined, 'the replay produced no steps at all');
  const badges: Record<number, string | null> = {};
  for (const seat of first.view.seats) badges[seat.seat] = seat.position;
  return badges;
}

/** Four-handed, 5/10, the last big blind stood up: button 1, no small blind (seat 2 empty), big blind 3. */
function deadSmallBlindReview(): HandReviewResponse {
  return reviewOf(
    [
      { seat: 0, startingStack: 200, net: -10 },
      { seat: 1, startingStack: 200, net: 0 },
      { seat: 3, startingStack: 200, net: 10 },
    ],
    [decision(1, 0, 'call', 10, 10), decision(2, 1, 'fold', 0, 20), decision(3, 3, 'check', 0, 20)],
    20,
  );
}

/** The same table with nobody missing: button 0, small blind 1, big blind 2, and seat 0 opens. */
function ordinaryReview(): HandReviewResponse {
  return reviewOf(
    [
      { seat: 0, startingStack: 200, net: 0 },
      { seat: 1, startingStack: 200, net: -5 },
      { seat: 2, startingStack: 200, net: 5 },
    ],
    [decision(1, 0, 'fold', 0, 15), decision(2, 1, 'fold', 0, 15)],
    15,
  );
}

describe('the hand replay badges the seats that actually posted the blinds', () => {
  it('gives the big blind its badge, and gives the empty small blind to nobody', () => {
    const badges = labelsOf(deadSmallBlindReview());
    assert.deepEqual(
      badges,
      { 0: 'CO', 1: 'BTN', 3: 'BB' },
      'seat 3 posted the only blind; seats 0 and 1 posted nothing and neither is a blind',
    );
    assert.ok(
      !Object.values(badges).includes('SB'),
      'nobody posted a small blind in this hand, so no seat may wear the badge',
    );
  });

  it('puts the dealer badge on the button rather than on the lowest seat that posted nothing', () => {
    const replay = buildHandReplay(deadSmallBlindReview());
    const first = replay.steps[0];
    assert.ok(first !== undefined);
    assert.deepEqual(
      first.view.seats.filter((seat) => seat.isButton).map((seat) => seat.seat),
      [1],
      'the button was at seat 1; seat 0 merely also posted nothing',
    );
    assert.equal(first.view.buttonSeat, 1);
  });

  it('does not report the big blind as the small blind as well', () => {
    const replay = buildHandReplay(deadSmallBlindReview());
    const config = replay.steps[0]?.view.config;
    assert.ok(config !== undefined);
    assert.equal(config.bigBlind, 10, 'the one forced bet in the hand');
    assert.equal(
      config.smallBlind,
      0,
      'a dead small blind has no amount to report; 10 would claim the table played 10/10',
    );
  });

  it('still labels an ordinary hand from the seats that posted', () => {
    assert.deepEqual(labelsOf(ordinaryReview()), { 0: 'BTN', 1: 'SB', 2: 'BB' });
    const replay = buildHandReplay(ordinaryReview());
    const config = replay.steps[0]?.view.config;
    assert.deepEqual(
      { small: config?.smallBlind, big: config?.bigBlind },
      { small: 5, big: 10 },
      'both blinds were posted, so both amounts are recoverable',
    );
  });

  it('keeps agreeing with the server about the pot at every step', () => {
    for (const review of [deadSmallBlindReview(), ordinaryReview()]) {
      assert.equal(
        buildHandReplay(review).potDerivationDisagrees,
        false,
        'the reconstruction must still add up to the server’s own potBefore',
      );
    }
  });
});

describe('every published scenario renders a position badge for every seat', () => {
  it('labels all of them', () => {
    const unlabelled: string[] = [];
    for (const scenario of scenarios()) {
      const table = scenarioToPlayerView(scenario);
      assert.ok(table !== null, `${scenario.id} produced no table at all`);
      const missing = table.view.seats.filter((seat) => seat.position === null);
      if (missing.length > 0) {
        unlabelled.push(`${scenario.id} (seats ${missing.map((seat) => seat.seat).join(', ')})`);
      }
    }
    assert.deepEqual(
      unlabelled,
      [],
      'a seat with no position badge is a seat the learner cannot place at the table',
    );
  });

  it('reads two players at seats 3 and 5 as a six-max table, not as a two-seat one', () => {
    // Sized by player count this is a two-chair table, on which seats 3 and 5 do not exist.
    const scenario = scenarioById('rk-low-spr-commit-top-pair');
    assert.ok(scenario !== null);
    const table = scenarioToPlayerView(scenario);
    assert.ok(table !== null);
    assert.deepEqual(
      Object.fromEntries(table.view.seats.map((seat) => [seat.seat, seat.position])),
      { 3: 'BTN/SB', 5: 'BB' },
      'the button posts the small blind heads-up',
    );
  });

  it('agrees with what a scenario says its own seats put in', () => {
    // Seat 5 committed one big blind. Walked modulo four chairs, seats 2 and 3 got the blinds.
    const scenario = scenarioById('rk-when-survival-outweighs-chip-ev');
    assert.ok(scenario !== null);
    const committed = scenario.committedThisStreet ?? {};
    assert.equal(committed[5], scenario.bigBlind, 'seat 5 posted exactly the big blind');

    const table = scenarioToPlayerView(scenario);
    assert.ok(table !== null);
    assert.deepEqual(
      Object.fromEntries(table.view.seats.map((seat) => [seat.seat, seat.position])),
      { 2: 'CO', 3: 'BTN', 4: 'SB', 5: 'BB' },
      'the blinds sit left of the authored button, and seat 5 is the one that posted one',
    );
  });
});
