/**
 * Would this app notice if the API served one player another player's hole cards?
 * The source checks in `a11y-contracts.test.ts` only cover `holeCards === null`, so a leak is driven
 * here through the real producers. Live frames come from `startHand`, `applyAction` and `redactFor`,
 * and a leak is a card that `HandState` really dealt, moved onto a seat not entitled to it. Clean
 * cases assert `seatsWithCards`, because an empty sweep also reports nothing unentitled.
 * Negative control (2026-08-27): deleting the `checkHoleCardEntitlement` line from `narrowState`
 * failed 4 of 15 tests here and 1 of 17 in `table-socket.test.ts`, and every honest case stayed green.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyAction,
  createDeterministicRandomForTests,
  type HandState,
  legalActions,
  type PlayerView,
  redactFor,
  startHand,
} from '@prl/poker-engine';
import { REVIEW_HAND_FOLDED, REVIEW_HAND_SHOWDOWN } from '../src/fixtures/review.ts';
import { buildHandReplay } from '../src/lib/hand-replay.ts';
import {
  checkHoleCardEntitlement,
  checkReviewHoleCardEntitlement,
} from '../src/lib/hole-card-entitlement.ts';
import { readServerMessage } from '../src/lib/table-socket.ts';
import { dataRefusalSentence, EMPTY_TABLE_STATE, tableReducer } from '../src/lib/use-live-table.ts';

/** Three seats, 5/10 blinds, a deck this seed deals the same way every run. */
function dealtHand(): HandState {
  return startHand({
    handId: 'hand-entitlement',
    roomId: 'room-entitlement',
    handNumber: 1,
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
    buttonSeat: 0,
    seats: [
      { seat: 0, playerId: 'p0', stack: 1000 },
      { seat: 1, playerId: 'p1', stack: 1000 },
      { seat: 2, playerId: 'p2', stack: 1000 },
    ],
    random: createDeterministicRandomForTests(7),
  }).state;
}

/**
 * Plays the hand out. Named seats fold at their first chance, everybody else takes the most passive
 * legal action. Three endings are needed: a showdown, a fold-out with an empty showdown list (the
 * ordinary ending here), and one seat folded, which catches a check that exempts any completed hand.
 */
function playOut(state: HandState, foldSeats: readonly number[] = []): HandState {
  let current = state;
  let guard = 0;
  while (current.toAct !== null && guard < 60) {
    guard += 1;
    const seat = current.toAct;
    const offered = new Set(legalActions(current, seat).map((action) => action.type));
    // Literals rather than `chosen.type`, because none of these carries an amount and this walk
    // must never size a bet.
    const preference: readonly ('fold' | 'check' | 'call')[] = foldSeats.includes(seat)
      ? ['fold', 'check', 'call']
      : ['check', 'call'];
    const chosen = preference.find((type) => offered.has(type));
    assert.ok(chosen !== undefined, `seat ${String(seat)} was offered no passive action`);
    current = applyAction(current, seat, { type: chosen }).state;
  }
  return current;
}

function stateFrame(view: PlayerView | null): string {
  return JSON.stringify({
    type: 'state',
    view,
    room: {
      id: 'room-entitlement',
      name: 'Entitlement table',
      ownerUserId: 'p0',
      maxSeats: 6,
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      startingStack: 1000,
      actionTimeoutSeconds: 30,
      status: 'open',
      visibility: 'invite_only',
      members: [
        {
          userId: 'p0',
          displayName: 'You',
          seat: 0,
          stack: 1000,
          isBot: false,
          botProfile: null,
          connected: true,
          awaitingBigBlind: false,
        },
      ],
      createdAt: '2026-08-27T00:00:00.000Z',
    },
    deadlineMs: null,
    serverTimeMs: 1_756_000_000_000,
    revision: 1,
  });
}

/** One seat's real dealt cards put back on it, the way a broken `redactFor` would leak them. */
function withLeak(view: PlayerView, state: HandState, seat: number): PlayerView {
  const dealt = state.seats.find((entry) => entry.seat === seat);
  assert.ok(dealt !== undefined && dealt.holeCards !== null, `seat ${String(seat)} was dealt cards`);
  return {
    ...view,
    seats: view.seats.map((entry) =>
      entry.seat === seat ? { ...entry, holeCards: dealt.holeCards } : entry,
    ),
  };
}

describe('a state frame carrying cards the reader is not entitled to', () => {
  const dealt = dealtHand();
  const midHand = redactFor(dealt, { viewerPlayerId: 'p0' });
  const shownDown = redactFor(playOut(dealt), { viewerPlayerId: 'p0' });
  const foldedOut = redactFor(playOut(dealt, [1, 2]), { viewerPlayerId: 'p0' });
  const mixed = redactFor(playOut(dealt, [1]), { viewerPlayerId: 'p0' });

  it('is not what redactFor produces, mid-hand', () => {
    const swept = checkHoleCardEntitlement(midHand);
    assert.deepEqual(swept.unentitled, []);
    assert.equal(swept.seatsWithCards, 1, 'exactly the viewer’s own seat carried cards');
    assert.equal(swept.seatsExamined, 3);
    assert.equal(readServerMessage(stateFrame(midHand)).ok, true);
  });

  it('is not what redactFor produces at a showdown, where three seats legitimately open', () => {
    const swept = checkHoleCardEntitlement(shownDown);
    assert.equal(shownDown.street, 'complete');
    assert.deepEqual(swept.unentitled, [], 'a seat named in result.showdowns is entitled');
    // Three seats showed, so the check is not passing by ignoring completed hands.
    assert.equal(swept.seatsWithCards, 3);
    assert.equal(readServerMessage(stateFrame(shownDown)).ok, true);
  });

  it('is not what redactFor produces when everybody else folds', () => {
    const swept = checkHoleCardEntitlement(foldedOut);
    assert.equal(foldedOut.street, 'complete');
    assert.equal(foldedOut.result?.endedByFold, true);
    assert.deepEqual(foldedOut.result?.showdowns ?? [], [], 'nobody showed, so nobody is exempt');
    assert.deepEqual(swept.unentitled, []);
    assert.equal(swept.seatsWithCards, 1, 'the viewer keeps their own cards after the hand');
    assert.equal(readServerMessage(stateFrame(foldedOut)).ok, true);
  });

  it('is refused mid-hand, and the rejection names the seat', () => {
    const leaked = withLeak(midHand, dealt, 2);
    assert.deepEqual(checkHoleCardEntitlement(leaked).unentitled, [2]);

    const outcome = readServerMessage(stateFrame(leaked));
    assert.equal(outcome.ok, false, 'a frame carrying seat 2’s cards must not reach a renderer');
    assert.ok(!outcome.ok);
    assert.deepEqual(outcome.rejection.unentitledSeats, [2]);
    assert.equal(outcome.rejection.claimedType, 'state');
    assert.match(outcome.rejection.reason, /seat 2/u);
    // The shape was right and the content was a leak, so the reason must not say "shape".
    assert.doesNotMatch(outcome.rejection.reason, /shape/u);
  });

  it('is refused after a fold-out, which is the ending a showdown exemption would wave through', () => {
    const leaked = withLeak(foldedOut, dealt, 1);
    const outcome = readServerMessage(stateFrame(leaked));
    assert.equal(outcome.ok, false);
    assert.ok(!outcome.ok);
    assert.deepEqual(outcome.rejection.unentitledSeats, [1]);
  });

  it('is refused when a completed hand shows a seat its own result does not name', () => {
    // Seat 1 folded and is not in `showdowns`, so its cards leak in a view that rightly shows two others.
    const shownSeats = new Set((mixed.result?.showdowns ?? []).map((entry) => entry.seat));
    assert.equal(mixed.street, 'complete');
    assert.ok(shownSeats.size >= 2, 'two seats reached showdown');
    assert.ok(!shownSeats.has(1), 'seat 1 folded and never opened its hand');

    const clean = checkHoleCardEntitlement(mixed);
    assert.deepEqual(clean.unentitled, []);
    assert.ok(clean.seatsWithCards >= 2, 'the honest view already carries the two opened hands');
    assert.equal(readServerMessage(stateFrame(mixed)).ok, true);

    const leaked = withLeak(mixed, dealt, 1);
    assert.deepEqual(checkHoleCardEntitlement(leaked).unentitled, [1]);
    assert.equal(readServerMessage(stateFrame(leaked)).ok, false);
  });

  it('is refused when `isSelf` claims a seat that `viewerSeat` does not', () => {
    // `redactFor` takes both from one resolved seat, so honest output never disagrees. A forged
    // `isSelf` must not buy an exemption.
    const forged: PlayerView = {
      ...midHand,
      seats: midHand.seats.map((seat) =>
        seat.seat === 2 ? { ...seat, isSelf: true, holeCards: dealt.seats[2]?.holeCards ?? null } : seat,
      ),
    };
    assert.equal(forged.viewerSeat, 0, 'the frame still says which seat the reader holds');
    assert.deepEqual(checkHoleCardEntitlement(forged).unentitled, [2]);
    assert.equal(readServerMessage(stateFrame(forged)).ok, false);
  });

  it('leaves the between-hands frame alone', () => {
    // `view: null` means no hand is in progress, so nothing is examined and the frame is accepted.
    const swept = checkHoleCardEntitlement(null);
    assert.deepEqual(swept.unentitled, []);
    assert.equal(swept.seatsWithCards, 0);
    assert.equal(readServerMessage(stateFrame(null)).ok, true);
  });
});

describe('a hand review carrying cards the reader is not entitled to', () => {
  it('is not what the shipped review fixtures carry', () => {
    for (const [name, review] of [
      ['showdown', REVIEW_HAND_SHOWDOWN],
      ['folded', REVIEW_HAND_FOLDED],
    ] as const) {
      const viewerSeat = buildHandReplay(review).viewerSeat;
      const swept = checkReviewHoleCardEntitlement(review, viewerSeat);
      assert.deepEqual(swept.unentitled, [], `${name}: no seat carries cards it has no right to`);
      assert.ok(swept.seatsWithCards > 0, `${name}: the sweep had cards to examine`);
      assert.ok(swept.seatsExamined > 0, `${name}: the sweep had seats to examine`);
    }
  });

  it('is reported when a seat that folded carries cards anyway', () => {
    const review = REVIEW_HAND_FOLDED;
    const viewerSeat = buildHandReplay(review).viewerSeat;
    assert.equal(viewerSeat, 0, 'the fixture’s reader holds seat 0');
    const victim = review.seats.find((seat) => seat.seat !== viewerSeat && seat.holeCards === null);
    assert.ok(victim !== undefined, 'the fixture has a seat whose cards were withheld');

    const leaked = {
      ...review,
      seats: review.seats.map((seat) =>
        seat.seat === victim.seat ? { ...seat, holeCards: ['Qs', 'Qd'] } : seat,
      ),
    };
    assert.deepEqual(checkReviewHoleCardEntitlement(leaked, viewerSeat).unentitled, [victim.seat]);
  });

  it('would be drawn face-up, which is why the check above is not decoration', () => {
    // `Seat.tsx` draws any pair that reaches a `SeatView`, and `buildHandReplay` copies the payload's
    // cards straight through, so the leak reaches the component's props.
    const review = REVIEW_HAND_FOLDED;
    const viewerSeat = buildHandReplay(review).viewerSeat;
    const victim = review.seats.find((seat) => seat.seat !== viewerSeat && seat.holeCards === null);
    assert.ok(victim !== undefined);
    const leaked = {
      ...review,
      seats: review.seats.map((seat) =>
        seat.seat === victim.seat ? { ...seat, holeCards: ['Qs', 'Qd'] } : seat,
      ),
    };

    const steps = buildHandReplay(leaked).steps;
    assert.ok(steps.length > 0, 'a replay has steps');
    const drawn = steps.map(
      (step) => step.view.seats.find((seat) => seat.seat === victim.seat)?.holeCards ?? null,
    );
    assert.ok(
      drawn.every((pair) => pair !== null && pair.length === 2),
      'every frame of the replay hands the folded seat’s cards to the component that draws them',
    );
  });

  it('is a different rule from the live one, and the live one does not fit a replay', () => {
    // A replay carries opened cards in every step and its views have no `result`, so the live rule
    // flags an honest seat. If `buildHandReplay` starts filling `result.showdowns`, read
    // `lib/hole-card-entitlement.ts`'s header before deleting this.
    const replay = buildHandReplay(REVIEW_HAND_SHOWDOWN);
    const opened = REVIEW_HAND_SHOWDOWN.seats.find(
      (seat) => seat.showedDown && seat.seat !== replay.viewerSeat,
    );
    assert.ok(opened !== undefined, 'the fixture has an opponent who opened their hand');
    const byLiveRule = replay.steps.map((step) => checkHoleCardEntitlement(step.view).unentitled);
    assert.ok(
      byLiveRule.every((seats) => seats.includes(opened.seat)),
      'the live rule reports the opened seat at every step of the replay',
    );
    assert.deepEqual(
      checkReviewHoleCardEntitlement(REVIEW_HAND_SHOWDOWN, replay.viewerSeat).unentitled,
      [],
      'the review rule, reading showedDown, does not',
    );
  });

  it('narrows to `showedDown` alone when the viewer’s seat cannot be recovered', () => {
    // A test and not a runtime guard, because with no recoverable viewer seat a page would refuse an
    // honest hand. The exemption narrows rather than widens, which is the safe direction.
    const swept = checkReviewHoleCardEntitlement(REVIEW_HAND_FOLDED, null);
    assert.deepEqual(swept.unentitled, [0]);
    assert.equal(swept.seatsWithCards, 1);
  });
});

describe('a refused frame', () => {
  it('leaves a sentence for the reader, not just a table that stopped moving', () => {
    // A table that silently stops dealing looks like a slow one, and the reader is the one who can report it.
    const before = { ...EMPTY_TABLE_STATE, view: null };
    const after = tableReducer(before, { kind: 'dataRefused', seats: [2] });
    // Against the module's own sentence, so deleting the wording fails this.
    assert.equal(after.dataRefusal, dataRefusalSentence([2]));
    assert.match(after.dataRefusal ?? '', /seat 3/u, 'seats are printed 1-based, as everywhere else');
    assert.match(after.dataRefusal ?? '', /Nothing was staked/u);
    // The cards arrived and this page declined to draw them, so claiming otherwise would be a lie.
    assert.doesNotMatch(after.dataRefusal ?? '', /never (saw|reached)/u);
    // Not the "server refused something" panel, because this is the opposite direction.
    assert.equal(after.notice, null);
    assert.equal(after.noticeCode, null);
  });

  it('does not clear itself when the next frame looks fine', () => {
    // A leaking server resends the same view, so clearing on the next good frame would flicker.
    const refused = tableReducer(EMPTY_TABLE_STATE, { kind: 'dataRefused', seats: [2] });
    const later = tableReducer(refused, { kind: 'notice', message: 'that seat has gone' });
    assert.equal(later.dataRefusal, refused.dataRefusal);
    assert.equal(tableReducer(later, { kind: 'reset' }).dataRefusal, null);
  });
});
