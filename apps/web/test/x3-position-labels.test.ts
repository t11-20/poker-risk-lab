/**
 * Position badges on the two screens that draw a table from something other than a live hand.
 *
 * Both build their own `PlayerView` and both call `positionLabels` to fill in `SeatView.position`,
 * which is the badge a learner reads next to each seat. Neither had a test, and both were labelling
 * the wrong seats:
 *
 *   - `hand-replay.ts` let `positionLabels` derive the blinds from a button it had itself guessed.
 *     The dead-button rule (`packages/poker-engine/src/positions.ts`) made that wrong: the big
 *     blind advances by one live player per hand, the small blind can be DEAD, and `button + 1` is
 *     then not the small blind. On a hand where the previous big blind had left, the review page
 *     badged a player who posted nothing 'SB', badged another who posted nothing 'BB', gave the
 *     seat that actually posted the big blind no badge at all, and printed the table's stakes as
 *     10/10 because the only forced bet it could see was both the smallest and the largest.
 *   - `scenario-view.ts` sized the table by the NUMBER of players instead of the highest seat
 *     index, so every walk round the table was taken modulo a table too small to contain the seats
 *     it was walking. Fourteen of the published scenarios rendered with no position badges at all.
 *
 * Both are read as a learner reads them — through the built `PlayerView`, not through the engine —
 * because the defect was never in `positionLabels` itself.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { scenarioById, scenarios } from '@prl/content';
import type { HandReviewDecision, HandReviewResponse, HandReviewSeat } from '@prl/contracts';
import { buildHandReplay } from '../src/lib/hand-replay.ts';
import { scenarioToPlayerView } from '../src/lib/scenario-view.ts';

// ---------------------------------------------------------------------------
// A review payload, as the server would send it
// ---------------------------------------------------------------------------

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
    // Null throughout: these hands belong to nobody in particular, and the labels under test are
    // drawn for every seat regardless of whose review it is.
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

/**
 * Four-handed at seats 0–3, blinds 5/10, then the player who paid the big blind stands up.
 *
 * The dead-button rule then deals seats 0, 1 and 3 with the button at seat 1, NO small blind
 * (its chair, seat 2, is empty) and the big blind at seat 3. Seat 0 opens, seat 1 folds, seat 3
 * takes it down: exactly the shape `apps/api/test/x3-dead-blind-review.test.ts` deals through the
 * engine, written out here as the payload that reaches the browser.
 */
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

// ---------------------------------------------------------------------------
// Scenario Lab
// ---------------------------------------------------------------------------

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
    // Sized by the count of players this is a two-chair table, and neither seat 3 nor seat 5 exists
    // on it — `assignBlinds` threw and the whole scenario rendered unlabelled.
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
    // The scenario states `committedThisStreet` for seat 5 as one big blind, which is the big
    // blind's own post. A table walked modulo four chairs badged seats 2 and 3 as the blinds.
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
