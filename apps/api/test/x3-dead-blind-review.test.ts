/**
 * Hand review when the dead-button rule moves the blinds off `button + 1` and `button + 2`: a dead
 * small blind (nobody posts it) and a dead button (the button chair is empty). Both rotations come
 * from the engine's `advanceBlindRotation`. A review that derived blinds from the button passed
 * hands.test.ts and published no analysis for these hands.
 * Fixtures are built here because `persistHand` cannot express a rotation.
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

const TEST_SAMPLES = 500;

const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const MAX_SEATS = 4;
const STARTING_STACK = 200;

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

// Blinds are stated, not derived. No `fixedDeck`, because nothing here depends on the cards.
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
    automatic_reason: null,
  }));

  const startedAt = new Date('2026-08-19T09:00:00.000Z');
  const hand: HandRow = {
    id: state.handId,
    room_id: state.roomId,
    hand_number: state.handNumber,
    // Can be an empty chair under the dead-button rule.
    button_seat: state.buttonSeat,
    config: JSON.parse(JSON.stringify(config)) as unknown,
    commitment_root: state.commitment.root,
    commitment_context: state.commitment.context,
    random_source_kind: state.randomSourceKind,
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

function decisionsOf(review: HandReviewResponse, seat: SeatIndex): HandReviewResponse['decisions'] {
  return review.decisions.filter((decision) => decision.seat === seat);
}

// Four-handed, then the big blind leaves. Rotations come from the engine, not from memory.
const SEEDED: BlindPositions = { buttonSeat: 0, smallBlindSeat: 1, bigBlindSeat: 2 };

const DEAD_SMALL_BLIND = advanceBlindRotation({
  previous: SEEDED,
  maxSeats: MAX_SEATS,
  entrants: [0, 1, 3],
});

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

describe('a hand with a dead small blind is reviewed, not silently skipped', () => {
  // Button 1, no small blind, big blind seat 3. Deriving blinds from the button gives a pot of 15
  // against the recorded 10, so the cross-check refuses every decision.
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
    // A wrongly charged blind would also shrink the effective stack, since hero's stack binds.
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
  // Button 2 is an empty chair, so a replay that looks for it among dealt seats finds nothing.
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
    // No blind arrangement produces this pot.
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
