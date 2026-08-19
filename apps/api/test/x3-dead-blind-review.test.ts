/**
 * Hand review under a CHANGED ROSTER — the shapes the dead-button rule creates.
 *
 * `test/hands.test.ts` reviews hands whose blinds sit exactly where the button says they should,
 * because `test/helpers/hand-rows.ts` deals every fixture through `startHand` without a rotation.
 * That is the one arrangement in which deriving the blinds from the button happens to be right, so
 * a review that derived them passed every one of those tests — and published no analysis at all for
 * any hand where a player left between deals.
 *
 * The dead-button rule (`packages/poker-engine/src/positions.ts`) makes two further arrangements
 * ordinary rather than exceptional:
 *
 *   - a DEAD SMALL BLIND: the small blind falls in a chair nobody is playing from, so nobody posts
 *     it. The hand is played for one big blind. This is what happens whenever the player who paid
 *     the big blind leaves before the next deal.
 *   - a DEAD BUTTON: the button falls in an empty chair for one hand. `button + 1` and `button + 2`
 *     are then not the blinds, and the button is not even a seat in the hand.
 *
 * Both are dealt here through the engine's own `advanceBlindRotation`, so the rows under test are
 * the rows a real table would have written, and the numbers the review is checked against are the
 * engine's own `pot_after` and `amount_paid`.
 *
 * The fixtures are built locally rather than through `persistHand`, because that helper deals from
 * a button and has no way to express a rotation. Everything else about the mapping — which columns
 * exist, what a `jsonb` read hands back — mirrors it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HandReviewResponse } from '@prl/contracts';
import type { Action, BlindPositions, HandState, SeatIndex } from '@prl/poker-engine';
import {
  advanceBlindRotation,
  applyAction,
  cardToString,
  createDeterministicRandomForTests,
  startHand,
} from '@prl/poker-engine';
import type {
  BuildHandReviewInput,
  HandActionRow,
  HandRow,
  HandSeatRow,
  SkippedAnalysis,
} from '../src/review/build-review.ts';
import { buildHandReview } from '../src/review/build-review.ts';

const ROOM_ID = 'room_x3deadblindaaaaaaaaaaaa';
const NAMES = ['Ada', 'Bo', 'Cy', 'Dee'] as const;

/** Small sample count: these tests assert that an analysis exists and what spot it describes. */
const TEST_SAMPLES = 500;

const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const MAX_SEATS = 4;
const STARTING_STACK = 200;

/** `usr_` ids are prefixed and fixed-shape, one per seat, so a seat can be asked for by user. */
function userFor(seat: SeatIndex): string {
  return `usr_x3deadblindseat${seat}aaaaa`;
}

interface DealtHand {
  readonly hand: HandRow;
  readonly seats: readonly HandSeatRow[];
  readonly actions: readonly HandActionRow[];
  readonly state: HandState;
  readonly maxPotAfter: number | null;
}

interface DealOptions {
  readonly handId: string;
  readonly buttonSeat: SeatIndex;
  readonly smallBlindSeat: SeatIndex | null;
  readonly bigBlindSeat: SeatIndex;
  readonly dealtIn: readonly SeatIndex[];
  readonly steps: readonly { readonly seat: SeatIndex; readonly action: Action }[];
}

/**
 * Deals one hand with the blinds stated rather than derived, plays it, and writes out the rows.
 *
 * No `fixedDeck`: nothing here turns on which cards came out, only on whether the review could
 * reconstruct the situation at all, so the deterministic test RNG deals whatever it deals. The
 * hands are still reproducible — that is what `createDeterministicRandomForTests` is for — and the
 * row is permanently labelled `deterministic-test-only` either way.
 */
function deal(options: DealOptions): DealtHand {
  const config = {
    smallBlind: SMALL_BLIND,
    bigBlind: BIG_BLIND,
    ante: 0,
    maxSeats: MAX_SEATS,
    actionTimeoutSeconds: 30,
  };
  const started = startHand({
    handId: options.handId,
    roomId: ROOM_ID,
    handNumber: 1,
    config,
    buttonSeat: options.buttonSeat,
    seats: options.dealtIn.map((seat) => ({
      seat,
      playerId: userFor(seat),
      stack: STARTING_STACK,
    })),
    random: createDeterministicRandomForTests(11),
    blinds: { smallBlindSeat: options.smallBlindSeat, bigBlindSeat: options.bigBlindSeat },
  });

  let state = started.state;
  for (const [index, step] of options.steps.entries()) {
    assert.equal(
      state.toAct,
      step.seat,
      `step ${index}: expected seat ${step.seat} to act on ${state.street}`,
    );
    state = applyAction(state, step.seat, step.action, { actionId: `x3-action-${index + 1}` }).state;
  }

  const shown = new Set((state.result?.showdowns ?? []).map((showdown) => showdown.seat));
  const seats: readonly HandSeatRow[] = state.seats.map((seat) => ({
    seat: seat.seat,
    user_id: userFor(seat.seat),
    display_name: NAMES[seat.seat] ?? null,
    is_bot: false,
    starting_stack: STARTING_STACK,
    hole_cards: seat.holeCards === null ? null : seat.holeCards.map((card) => cardToString(card)),
    net_result: state.result === null ? null : (state.result.netBySeat[seat.seat] ?? 0),
    status: seat.status,
    showed_down: shown.has(seat.seat),
  }));

  const actions: readonly HandActionRow[] = state.actions.map((logged) => ({
    sequence: logged.sequence,
    street: logged.street,
    seat: logged.seat,
    action_type: logged.action.type,
    action_to: logged.action.type === 'bet' || logged.action.type === 'raise' ? logged.action.to : null,
    amount_paid: logged.amountPaid,
    bet_level_after: logged.betLevelAfter,
    pot_after: logged.potAfter,
    was_automatic: logged.wasAutomatic,
  }));

  const startedAt = new Date('2026-08-19T09:00:00.000Z');
  const hand: HandRow = {
    id: state.handId,
    room_id: state.roomId,
    hand_number: state.handNumber,
    // The column the review used to derive the blinds from. It records where the button sat, which
    // under the dead-button rule can be a chair nobody is playing from.
    button_seat: state.buttonSeat,
    config: JSON.parse(JSON.stringify(config)) as unknown,
    commitment_root: state.commitment.root,
    commitment_context: state.commitment.context,
    board: state.board.map((card) => cardToString(card)),
    street: state.street,
    result: JSON.parse(JSON.stringify(state.result)) as unknown,
    reveal: JSON.parse(JSON.stringify(state.result?.reveal ?? null)) as unknown,
    started_at: startedAt,
    completed_at: state.street === 'complete' ? new Date(startedAt.getTime() + 60_000) : null,
  };

  return {
    hand,
    seats,
    actions,
    state,
    maxPotAfter: actions.length === 0 ? null : Math.max(...actions.map((action) => action.pot_after)),
  };
}

function reviewAs(dealt: DealtHand, seat: SeatIndex, skipped?: SkippedAnalysis[]): HandReviewResponse {
  const input: BuildHandReviewInput = {
    hand: dealt.hand,
    seats: dealt.seats,
    actions: dealt.actions,
    viewerUserId: userFor(seat),
    maxPotAfter: dealt.maxPotAfter,
  };
  return buildHandReview(input, {
    equitySamples: TEST_SAMPLES,
    ...(skipped === undefined ? {} : { onAnalysisSkipped: (detail) => skipped.push(detail) }),
  });
}

/** Every decision belonging to `seat`, which are the only ones that can carry an analysis. */
function decisionsOf(review: HandReviewResponse, seat: SeatIndex): HandReviewResponse['decisions'] {
  return review.decisions.filter((decision) => decision.seat === seat);
}

// ---------------------------------------------------------------------------
// The rotation these fixtures reproduce
// ---------------------------------------------------------------------------

/**
 * Four-handed, then the player who paid the big blind stands up.
 *
 * Worked through the engine rather than asserted from memory, so the fixtures below cannot claim a
 * rotation the rule does not actually produce.
 */
const SEEDED: BlindPositions = { buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2 };

/** Seat 2 — the big blind — leaves. The small blind position (seat 2) is now empty: it is DEAD. */
const DEAD_SMALL_BLIND = advanceBlindRotation({
  previous: SEEDED,
  maxSeats: MAX_SEATS,
  entrants: [0, 1, 3],
});

/** One more hand with the same three players. The button position (seat 2) is empty: it is DEAD. */
const DEAD_BUTTON = advanceBlindRotation({
  previous: DEAD_SMALL_BLIND.positions,
  maxSeats: MAX_SEATS,
  entrants: [0, 1, 3],
});

describe('the rotation under test is the engine’s own, not a hand-written one', () => {
  it('produces a dead small blind when the big blind leaves', () => {
    assert.deepEqual(
      {
        button: DEAD_SMALL_BLIND.buttonSeat,
        small: DEAD_SMALL_BLIND.smallBlindSeat,
        big: DEAD_SMALL_BLIND.bigBlindSeat,
        dealt: DEAD_SMALL_BLIND.dealtIn,
      },
      { button: 1, small: null, big: 3, dealt: [0, 1, 3] },
      'the big blind advances by one live player; the small blind falls in the empty chair',
    );
    assert.equal(DEAD_SMALL_BLIND.buttonIsDead, false);
  });

  it('produces a dead button on the following hand', () => {
    assert.deepEqual(
      {
        button: DEAD_BUTTON.buttonSeat,
        small: DEAD_BUTTON.smallBlindSeat,
        big: DEAD_BUTTON.bigBlindSeat,
        dealt: DEAD_BUTTON.dealtIn,
      },
      { button: 2, small: 3, big: 0, dealt: [0, 1, 3] },
      'the button falls where the small blind was, and nobody is sitting there',
    );
    assert.equal(DEAD_BUTTON.buttonIsDead, true);
  });
});

// ---------------------------------------------------------------------------
// The regression
// ---------------------------------------------------------------------------

describe('a hand with a dead small blind is reviewed, not silently skipped', () => {
  /**
   * Button 1, no small blind, big blind seat 3. Seat 0 opens (the seat after the big blind).
   *
   * A review that derived the blinds from the button would charge `assignBlinds(1, 4, [0,1,3])` —
   * seat 3 the small blind and seat 0 the big blind — reconstructing a pot of 15 against the 10 the
   * engine actually recorded, and would refuse every decision on the pot cross-check.
   */
  function dealt(): DealtHand {
    return deal({
      handId: 'hand_x3deadsmallblindaaaaaaa',
      buttonSeat: DEAD_SMALL_BLIND.buttonSeat,
      smallBlindSeat: DEAD_SMALL_BLIND.smallBlindSeat,
      bigBlindSeat: DEAD_SMALL_BLIND.bigBlindSeat,
      dealtIn: DEAD_SMALL_BLIND.dealtIn,
      steps: [
        { seat: 0, action: { type: 'call' } },
        { seat: 1, action: { type: 'fold' } },
        { seat: 3, action: { type: 'check' } },
        { seat: 3, action: { type: 'check' } },
        { seat: 0, action: { type: 'check' } },
        { seat: 3, action: { type: 'check' } },
        { seat: 0, action: { type: 'check' } },
        { seat: 3, action: { type: 'check' } },
        { seat: 0, action: { type: 'check' } },
      ],
    });
  }

  it('posts only the big blind, exactly as the engine did', () => {
    const hand = dealt();
    assert.deepEqual(
      hand.state.forcedBets.map((bet) => ({ kind: bet.kind, seat: bet.seat, amount: bet.amount })),
      [{ kind: 'bigBlind', seat: 3, amount: BIG_BLIND }],
      'a dead small blind is posted by nobody',
    );
    assert.equal(hand.actions[0]?.pot_after, 20, 'seat 0 called the big blind into a pot of 10');
  });

  it('gives the opener a real analysis of the pot and price they actually faced', () => {
    const hand = dealt();
    const skipped: SkippedAnalysis[] = [];
    const review = reviewAs(hand, 0, skipped);

    const own = decisionsOf(review, 0);
    assert.ok(own.length > 0, 'seat 0 acted on every street');
    assert.deepEqual(
      skipped,
      [],
      'no decision of the viewer’s own was skipped; each reason would name a refusal',
    );
    for (const decision of own) {
      assert.notEqual(
        decision.analysis,
        null,
        `sequence ${decision.sequence} carries no analysis — the replay could not reconstruct it`,
      );
    }

    const preflop = own[0];
    assert.ok(preflop?.analysis != null);
    assert.equal(preflop.potBefore, BIG_BLIND, 'one big blind and nothing else was in the middle');
    assert.equal(preflop.analysis.potTotal, BIG_BLIND, 'the analysis faced the same pot');
    assert.equal(
      preflop.analysis.toCall,
      BIG_BLIND,
      'seat 0 posted nothing, so it owed a whole big blind — not the 0 a mis-assigned blind gives',
    );
    // Seat 0 posted nothing, so it still has its whole stack and covers everybody. Charging it a
    // blind it never paid shows up here as well as in `toCall`: the effective stack would drop by
    // the blind, because it is hero's own stack that becomes the binding one.
    assert.equal(preflop.analysis.stackContext.effectiveStack, STARTING_STACK);
  });

  it('reports the same pot the engine recorded at every decision', () => {
    const hand = dealt();
    const review = reviewAs(hand, 0);
    let expected = (hand.actions[0]?.pot_after ?? 0) - (hand.actions[0]?.amount_paid ?? 0);
    for (const [index, decision] of review.decisions.entries()) {
      assert.equal(decision.potBefore, expected, `decision ${index} faced the wrong pot`);
      expected = hand.actions[index]?.pot_after ?? expected;
    }
  });
});

describe('a hand with a dead button is reviewed, not silently skipped', () => {
  /**
   * Button 2 — an empty chair — small blind seat 3, big blind seat 0. Seat 1 opens.
   *
   * The button is not a seat in this hand at all, so a replay that insisted on finding it among the
   * dealt seats gave up before it started and reported `analysis: null` for the whole hand.
   */
  function dealt(): DealtHand {
    return deal({
      handId: 'hand_x3deadbuttonaaaaaaaaaaa',
      buttonSeat: DEAD_BUTTON.buttonSeat,
      smallBlindSeat: DEAD_BUTTON.smallBlindSeat,
      bigBlindSeat: DEAD_BUTTON.bigBlindSeat,
      dealtIn: DEAD_BUTTON.dealtIn,
      steps: [
        { seat: 1, action: { type: 'call' } },
        { seat: 3, action: { type: 'call' } },
        { seat: 0, action: { type: 'check' } },
        { seat: 3, action: { type: 'check' } },
        { seat: 0, action: { type: 'check' } },
        { seat: 1, action: { type: 'check' } },
      ],
    });
  }

  it('deals a hand whose button seat holds no player', () => {
    const hand = dealt();
    assert.equal(hand.hand.button_seat, 2);
    assert.ok(
      !hand.seats.some((seat) => seat.seat === 2),
      'seat 2 is not in the hand, which is what makes the button dead',
    );
  });

  it('analyses the small blind’s decisions from the blinds that were really posted', () => {
    const hand = dealt();
    const skipped: SkippedAnalysis[] = [];
    const review = reviewAs(hand, 3, skipped);

    const own = decisionsOf(review, 3);
    assert.ok(own.length > 0);
    assert.deepEqual(skipped, []);
    for (const decision of own) {
      assert.notEqual(decision.analysis, null, `sequence ${decision.sequence} carries no analysis`);
    }

    const preflop = own[0];
    assert.ok(preflop?.analysis != null);
    assert.equal(preflop.potBefore, SMALL_BLIND + BIG_BLIND + BIG_BLIND, 'both blinds plus a call');
    assert.equal(
      preflop.analysis.toCall,
      BIG_BLIND - SMALL_BLIND,
      'the small blind had 5 out already, so it owed the difference',
    );
  });
});

// ---------------------------------------------------------------------------
// The check that caught the regression must keep catching things
// ---------------------------------------------------------------------------

describe('the pot cross-check still refuses a hand it cannot faithfully replay', () => {
  it('refuses every decision when the persisted pot does not follow from the rows', () => {
    const hand = deal({
      handId: 'hand_x3tamperedaaaaaaaaaaaaa',
      buttonSeat: DEAD_SMALL_BLIND.buttonSeat,
      smallBlindSeat: DEAD_SMALL_BLIND.smallBlindSeat,
      bigBlindSeat: DEAD_SMALL_BLIND.bigBlindSeat,
      dealtIn: DEAD_SMALL_BLIND.dealtIn,
      steps: [
        { seat: 0, action: { type: 'call' } },
        { seat: 1, action: { type: 'fold' } },
        { seat: 3, action: { type: 'check' } },
        { seat: 3, action: { type: 'check' } },
        { seat: 0, action: { type: 'check' } },
      ],
    });
    // A row nothing can explain: the first action claims a pot that no arrangement of the blinds
    // produces, so no reconstruction may be accepted for it.
    const tampered: DealtHand = {
      ...hand,
      actions: hand.actions.map((action) => (action.sequence === 1 ? { ...action, pot_after: 999 } : action)),
    };

    const skipped: SkippedAnalysis[] = [];
    const review = reviewAs(tampered, 0, skipped);
    for (const decision of decisionsOf(review, 0)) {
      assert.equal(decision.analysis, null, 'a hand that cannot be replayed gets no analysis');
    }
    assert.ok(skipped.length > 0, 'and the refusal is recorded with its reason');
    assert.deepEqual(
      [...new Set(skipped.map((entry) => entry.reason))],
      ['the replayed pot disagrees with the persisted pot'],
      'the recovery must never explain away a pot; the cross-check is what stops it',
    );
  });
});
