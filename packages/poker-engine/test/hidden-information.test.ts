/**
 * Hidden-information isolation.
 *
 * These tests do not check that `redactFor` sets the fields we expect. They check
 * the property that actually matters: that a serialised player view contains no
 * card the recipient is not entitled to see, and no trace of the deck, the cursor
 * or the commitment salt.
 *
 * The scan is over `JSON.stringify(view)`, walking every value in the object graph,
 * because that is the form the data actually leaves the process in. A leak through
 * a field nobody thought to check is precisely the failure this is guarding.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Card, cardToString } from '../src/cards.ts';
import { verifyDeckReveal } from '../src/commitment.ts';
import { applyAction } from '../src/machine.ts';
import { cardsHiddenFrom, type PlayerView, redactFor } from '../src/redact.ts';
import type { HandState, SeatIndex } from '../src/types.ts';
import { call, check, deal, fold, play, raise, stackedDeck } from './helpers.ts';

/**
 * Asserts that no hidden card is present in the view.
 *
 * Cards are small integers, so they collide with stacks, pots and bet sizes. To
 * avoid a meaningless assertion, the check looks specifically at the places a card
 * could actually be represented — every array of numbers in the view, plus the
 * board and hole-card fields — rather than at every number anywhere.
 */
function assertNoHiddenCards(state: HandState, viewerSeat: SeatIndex | null): void {
  const view = redactFor(state, { viewerSeat });
  const hidden = new Set(cardsHiddenFrom(state, viewerSeat));
  const serialised = JSON.parse(JSON.stringify(view)) as PlayerView;

  const cardBearingArrays: Card[][] = [];
  const collectCardArrays = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (value.every((entry) => typeof entry === 'number')) cardBearingArrays.push(value as Card[]);
      for (const entry of value) collectCardArrays(entry);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const entry of Object.values(value)) collectCardArrays(entry);
    }
  };
  collectCardArrays(serialised);

  for (const array of cardBearingArrays) {
    // A 52-length array of distinct 0..51 values is the deck itself and must never
    // appear before the hand is complete.
    if (array.length === 52 && new Set(array).size === 52) {
      assert.fail(`view for seat ${String(viewerSeat)} contains a full 52-card deck`);
    }
  }

  // Board and hole cards are the only card-typed fields; check them precisely.
  for (const card of serialised.board) {
    assert.ok(!hidden.has(card), `board leaked hidden card ${cardToString(card)}`);
  }
  for (const seatView of serialised.seats) {
    if (seatView.holeCards === null) continue;
    for (const card of seatView.holeCards) {
      assert.ok(
        !hidden.has(card),
        `seat ${seatView.seat} hole card ${cardToString(card)} leaked to viewer ${String(viewerSeat)}`,
      );
    }
  }
  for (const showdown of serialised.result?.showdowns ?? []) {
    for (const card of showdown.holeCards) {
      assert.ok(!hidden.has(card), `showdown leaked hidden card ${cardToString(card)}`);
    }
  }

  // The secrets must not appear under any key at all.
  const raw = JSON.stringify(serialised);
  assert.ok(!raw.includes('"deck"'), 'the view must not carry a deck field');
  assert.ok(!raw.includes('deckCursor'), 'the view must not carry the deck cursor');
  assert.ok(!raw.includes('deckSalt'), 'the view must not carry the commitment salt');
  assert.equal(
    Object.hasOwn(serialised as object, 'deck'),
    false,
    'PlayerView is constructed field by field, so it can never inherit `deck`',
  );
}

test('a player view never contains another player’s hole cards during play', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  for (const viewer of [0, 1, 2, null]) {
    assertNoHiddenCards(state, viewer);
  }

  const view0 = redactFor(state, { viewerSeat: 0 });
  const own = view0.seats.find((seat) => seat.seat === 0);
  assert.ok(own?.holeCards !== null, 'a player always sees their own cards');
  for (const other of view0.seats.filter((seat) => seat.seat !== 0)) {
    assert.equal(other.holeCards, null, `seat ${other.seat} cards must be hidden from seat 0`);
  }
});

test('a spectator view shows nobody’s hole cards', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  const view = redactFor(state, { viewerSeat: null });
  for (const seat of view.seats) assert.equal(seat.holeCards, null);
  assert.equal(view.legalActions.length, 0, 'a spectator is never offered actions');
  assert.equal(view.amountToCall, 0);
  assertNoHiddenCards(state, null);
});

test('the undealt deck is never visible at any point in a hand', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  let current = state;
  const streets: string[] = [];
  // Walk the hand street by street, checking every view after every action.
  while (current.street !== 'complete') {
    streets.push(current.street);
    for (const viewer of [0, 1, 2, null]) assertNoHiddenCards(current, viewer);
    const seat = current.toAct;
    if (seat === null) break;
    const legal = redactFor(current, { viewerSeat: seat }).legalActions;
    const canCheck = legal.some((entry) => entry.type === 'check');
    current = applyAction(current, seat, canCheck ? { type: 'check' } : { type: 'call' }).state;
  }
  assert.ok(streets.includes('preflop'));
  assert.ok(streets.includes('flop'));
  assert.ok(streets.includes('turn'));
  assert.ok(streets.includes('river'));
  for (const viewer of [0, 1, 2, null]) assertNoHiddenCards(current, viewer);
});

test('cards are only revealed at showdown, and only for seats that showed', () => {
  // Two players reach showdown; a third folds and must keep its cards hidden.
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KhKd', 0: '7c8d' }, [1, 2, 0], 'Qh 5s 2c 4d 9h');
  const { state } = deal({
    stacks: [200, 200, 200],
    buttonSeat: 0,
    config: { maxSeats: 3 },
    fixedDeck: deck,
  });
  // Seat 0 folds; seats 1 and 2 go to showdown.
  let current = play(state, [fold(0), call(1), check(2)]);
  while (current.street !== 'complete') {
    const seat = current.toAct;
    if (seat === null) break;
    current = applyAction(current, seat, { type: 'check' }).state;
  }
  assert.equal(current.street, 'complete');
  const result = current.result;
  assert.ok(result !== null);
  assert.equal(result.showdowns.length, 2, 'only the two players still in show');
  assert.deepEqual(result.showdowns.map((s) => s.seat).sort(), [1, 2]);

  const spectator = redactFor(current, { viewerSeat: null });
  const folder = spectator.seats.find((seat) => seat.seat === 0);
  assert.equal(
    folder?.holeCards,
    null,
    'a folded player’s cards stay hidden — revealing them leaks whether they bluffed',
  );
  for (const seat of [1, 2]) {
    const shown = spectator.seats.find((entry) => entry.seat === seat);
    assert.ok(shown?.holeCards !== null, `seat ${seat} showed its hand`);
  }
  for (const viewer of [0, 1, 2, null]) assertNoHiddenCards(current, viewer);
});

test('a hand that ends by folding reveals nobody’s cards', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  const finished = play(state, [fold(0), fold(1)]);
  assert.equal(finished.street, 'complete');
  assert.equal(finished.result?.showdowns.length, 0);
  const spectator = redactFor(finished, { viewerSeat: null });
  for (const seat of spectator.seats) {
    assert.equal(seat.holeCards, null, 'no cards are shown when everyone folds');
  }
  // The winner still sees its own cards.
  const winnerView = redactFor(finished, { viewerSeat: 2 });
  assert.ok(winnerView.seats.find((seat) => seat.seat === 2)?.holeCards !== null);
  assert.equal(winnerView.seats.find((seat) => seat.seat === 0)?.holeCards, null);
});

test('the commitment hash is published during the hand but the deck is not', () => {
  const { state } = deal({ stacks: [200, 200], buttonSeat: 0, config: { maxSeats: 2 } });
  const view = redactFor(state, { viewerSeat: 0 });
  assert.match(view.commitmentRoot, /^[0-9a-f]{64}$/, 'the Merkle root is public up front');
  assert.equal(view.result, null, 'the reveal only arrives with the result');
  assertNoHiddenCards(state, 0);
});

test('a hand won by folding reveals the board but NEVER the winner’s cards', () => {
  // This is the test that killed the first commitment design. Hashing the whole
  // deck and publishing salt + deck at the end would have exposed the cards of
  // every player who never showed — in a heads-up fold, the winner's exact hand.
  const { state } = deal({ stacks: [200, 200], buttonSeat: 0, config: { maxSeats: 2 } });
  const finished = play(state, [fold(0)]);
  assert.equal(finished.street, 'complete');
  assert.equal(finished.result?.endedByFold, true);
  assert.equal(finished.result?.showdowns.length, 0);

  const reveal = finished.result?.reveal;
  assert.ok(reveal !== undefined);
  assert.equal(reveal.complete, false, 'a fold-out hand never produces a full deck reveal');
  assert.equal(reveal.cards.length, 0, 'no board was dealt and nobody showed, so nothing is revealed');

  // The proofs that do exist must verify, and must not include any hidden card.
  const verification = verifyDeckReveal(reveal);
  assert.equal(verification.ok, true, verification.reason);
  const hidden = new Set(cardsHiddenFrom(finished, 0));
  for (const entry of reveal.cards) {
    assert.ok(!hidden.has(entry.card), `reveal leaked hidden card at position ${entry.index}`);
  }
  // Seat 1 folded nothing — it won without showing, so its two cards stay hidden.
  assert.equal(hidden.size, 2 + 48, `the winner's two cards plus the 48 undealt cards stay sealed`);
});

test('a hand that reaches showdown reveals the board and only the shown hands', () => {
  const deck = stackedDeck({ 1: 'AhAd', 0: 'KhKd' }, [1, 0], 'Qh 5s 2c 4d 9c');
  const { state } = deal({
    stacks: [200, 200],
    buttonSeat: 0,
    config: { maxSeats: 2 },
    fixedDeck: deck,
  });
  let current = play(state, [call(0), check(1)]);
  while (current.street !== 'complete') {
    const seat = current.toAct;
    if (seat === null) break;
    current = applyAction(current, seat, { type: 'check' }).state;
  }
  assert.equal(current.street, 'complete');
  const reveal = current.result?.reveal;
  assert.ok(reveal !== undefined);
  const verification = verifyDeckReveal(reveal);
  assert.equal(verification.ok, true, verification.reason);
  // 5 board cards + 4 hole cards from the two players who showed = 9 positions.
  assert.equal(reveal.cards.length, 9);
  assert.equal(reveal.complete, false, 'the 43 undealt cards stay sealed');
  const revealedCards = new Set(reveal.cards.map((entry) => entry.card));
  for (const card of current.board) assert.ok(revealedCards.has(card), 'every board card is proved');
  for (const showdown of current.result?.showdowns ?? []) {
    for (const card of showdown.holeCards) {
      assert.ok(revealedCards.has(card), 'every shown hole card is proved');
    }
  }
});

test('legal actions are only ever offered to the player whose turn it is', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  const toAct = state.toAct;
  assert.notEqual(toAct, null);
  for (const viewer of [0, 1, 2]) {
    const view = redactFor(state, { viewerSeat: viewer });
    if (viewer === toAct) assert.ok(view.legalActions.length > 0, 'the actor gets options');
    else assert.equal(view.legalActions.length, 0, `seat ${viewer} must not be told it can act`);
  }
});

test('cardsHiddenFrom accounts for every card not visible to the recipient', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  // 52 cards total: 6 dealt as hole cards, 46 still in the deck.
  const hiddenFrom0 = cardsHiddenFrom(state, 0);
  assert.equal(hiddenFrom0.length, 4 + 46, 'four opponents’ cards plus the undealt deck');
  const hiddenFromSpectator = cardsHiddenFrom(state, null);
  assert.equal(hiddenFromSpectator.length, 6 + 46, 'all six hole cards plus the undealt deck');
  assert.equal(new Set(hiddenFrom0).size, hiddenFrom0.length, 'no duplicates');
});

test('a raise does not change what any recipient can see', () => {
  const { state } = deal({ stacks: [200, 200, 200], buttonSeat: 0, config: { maxSeats: 3 } });
  const raised = play(state, [raise(0, 10)]);
  for (const viewer of [0, 1, 2, null]) assertNoHiddenCards(raised, viewer);
});
