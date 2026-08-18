/**
 * Entitlement belongs to a person, never to a chair.
 *
 * ## The bug this file exists because of
 *
 * `redactFor` used to decide "is this seat the recipient's" by comparing seat *indices*. That is
 * correct for exactly as long as a `HandState` and the seating that produced it agree about who
 * sits where — and a server keeps a finished hand alive after the hand is over, precisely when
 * they stop agreeing. A player stood up, somebody else took the chair, and the new occupant was
 * handed the previous occupant's unshown hole cards with `isSelf: true`.
 *
 * `HandState.seats[].playerId` is the fix: `startHand` writes it once and `applyAction` never
 * touches it, so it is the roster **as at the moment of the deal**, frozen inside the state that
 * carries the cards. Nothing that happens to the table afterwards can move it.
 *
 * ## What is asserted here, and why in this shape
 *
 * These tests deliberately give the seats player ids that do NOT match their indices
 * (`seat 0 -> usr_c`, `seat 1 -> usr_a`, ...). A test whose ids are `p0, p1, p2` cannot tell an
 * identity check from a position check, because in that state the two agree — which is exactly why
 * the original bug survived a suite that already scanned every view for leaked cards.
 *
 * The assertions are properties, not implementation: `isSelf` holds for a seat iff that seat's
 * `playerId` IS the recipient, and hole cards are visible iff `isSelf` or that seat showed down.
 * Any rewrite that keys off a seat index fails them the moment index and identity diverge.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Card, cardToString } from '../src/cards.ts';
import { applyAction, type SeatSetup, startHand } from '../src/machine.ts';
import { cardsHiddenFrom, type PlayerView, redactFor } from '../src/redact.ts';
import { createDeterministicRandomForTests } from '../src/rng.ts';
import type { HandState, SeatIndex, TableConfig } from '../src/types.ts';
import { stackedDeck } from './helpers.ts';

const CONFIG: TableConfig = {
  smallBlind: 5,
  bigBlind: 10,
  ante: 0,
  maxSeats: 3,
  actionTimeoutSeconds: 30,
};

/**
 * Deals a hand in which seat index and player id are deliberately unrelated.
 *
 * `ids[i]` is the player in seat `i`, so a caller can permute the people around the table without
 * moving a single card: the same `fixedDeck` deals the same cards to the same *seats*, and the
 * question every test here asks is which *person* is then allowed to see them.
 */
function dealWithIdentities(ids: readonly string[], fixedDeck?: readonly number[]): HandState {
  const seats: SeatSetup[] = ids.map((playerId, seat) => ({ seat, playerId, stack: 1_000 }));
  return startHand({
    handId: 'hand_identity',
    roomId: 'room_identity',
    handNumber: 1,
    config: { ...CONFIG, maxSeats: Math.max(2, ids.length) },
    buttonSeat: 0,
    seats,
    random: createDeterministicRandomForTests(7),
    ...(fixedDeck === undefined ? {} : { fixedDeck }),
  }).state;
}

/** Folds whoever is to act until the hand is over. Leaves nobody's cards shown. */
function foldToCompletion(state: HandState): HandState {
  let current = state;
  for (let guard = 0; guard < 16 && current.street !== 'complete'; guard += 1) {
    const seat = current.toAct;
    if (seat === null) break;
    current = applyAction(current, seat, { type: 'fold' }).state;
  }
  assert.equal(current.street, 'complete', 'the hand should have folded out');
  return current;
}

/** Every card anywhere in a serialised view, under the keys a card can actually live in. */
function cardsIn(view: PlayerView): Set<Card> {
  const found = new Set<Card>();
  const walk = (value: unknown, underCardKey: boolean): void => {
    if (typeof value === 'number') {
      if (underCardKey) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, underCardKey);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        walk(entry, key === 'holeCards' || key === 'board' || key === 'card' || key === 'bestFive');
      }
    }
  };
  walk(JSON.parse(JSON.stringify(view)) as unknown, false);
  return found;
}

/**
 * The property, asserted directly: who you are decides what you see.
 *
 * Applied to every recipient a state has, plus a stranger and a spectator, so the check covers the
 * "not in this hand at all" case that a seat index cannot even express.
 */
function assertEntitlementFollowsIdentity(state: HandState, viewerPlayerId: string | null): void {
  const view = redactFor(state, { viewerPlayerId });
  const own = state.seats.filter((seat) => seat.playerId === viewerPlayerId);
  const expectedSeat = own.length === 1 ? (own[0]?.seat ?? null) : null;
  assert.equal(
    view.viewerSeat,
    expectedSeat,
    `the view for ${String(viewerPlayerId)} must be built for the seat that id holds`,
  );

  const shown = new Set(
    state.street === 'complete' ? (state.result?.showdowns ?? []).map((entry) => entry.seat) : [],
  );
  for (const seat of view.seats) {
    assert.equal(
      seat.isSelf,
      seat.playerId === viewerPlayerId && expectedSeat !== null,
      `isSelf on seat ${seat.seat} must mean "${String(viewerPlayerId)} is ${seat.playerId}"`,
    );
    const maySee = seat.isSelf || shown.has(seat.seat);
    if (maySee) continue;
    assert.equal(
      seat.holeCards,
      null,
      `seat ${seat.seat} (${seat.playerId}) exposed its cards to ${String(viewerPlayerId)}`,
    );
  }

  // And against ground truth read from the state, so a leak cannot widen its own expectation.
  const hidden = new Set(cardsHiddenFrom(state, { viewerPlayerId }));
  const leaked = [...cardsIn(view)].filter((card) => hidden.has(card)).map(cardToString);
  assert.deepEqual(leaked, [], `${String(viewerPlayerId)} received sealed cards: ${leaked.join(', ')}`);
}

test('a view is built for the person named, whatever chair that person is in', () => {
  // Seat 0 is usr_c, seat 1 is usr_a, seat 2 is usr_b. Every index is somebody else's.
  const state = dealWithIdentities(['usr_c', 'usr_a', 'usr_b']);

  const view = redactFor(state, { viewerPlayerId: 'usr_a' });
  assert.equal(view.viewerSeat, 1, 'usr_a sits in seat 1, and the view must say so');

  const selves = view.seats.filter((seat) => seat.isSelf);
  assert.equal(selves.length, 1, 'exactly one seat can be the recipient');
  assert.equal(selves[0]?.playerId, 'usr_a');
  assert.notEqual(selves[0]?.holeCards, null, 'usr_a must see usr_a’s cards');

  for (const seat of view.seats.filter((entry) => entry.playerId !== 'usr_a')) {
    assert.equal(seat.holeCards, null, `${seat.playerId} must not show its cards to usr_a`);
  }
});

test('the same deal with the players moved round gives each person the SAME two cards', () => {
  // One deck, two seatings. The cards belong to the seats; the entitlement belongs to the people.
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KhKd', 0: '7c8d' }, [1, 2, 0], 'Qh 5s 2c');

  const first = dealWithIdentities(['usr_a', 'usr_b', 'usr_c'], deck);
  const second = dealWithIdentities(['usr_c', 'usr_a', 'usr_b'], deck);

  // usr_a is in seat 0 of the first deal and seat 1 of the second. Its own cards must follow it.
  const inFirst = redactFor(first, { viewerPlayerId: 'usr_a' });
  const inSecond = redactFor(second, { viewerPlayerId: 'usr_a' });
  assert.equal(inFirst.viewerSeat, 0);
  assert.equal(inSecond.viewerSeat, 1);

  const ownOf = (view: PlayerView): readonly Card[] => {
    const seat = view.seats.find((entry) => entry.isSelf);
    assert.ok(seat !== undefined, 'the recipient must appear in their own view');
    assert.ok(seat.holeCards !== null, 'the recipient must see their own cards');
    assert.equal(seat.playerId, 'usr_a', 'isSelf must be the recipient, not a chair');
    return seat.holeCards;
  };
  // Seat 0 holds 7c8d in both deals; seat 1 holds AhAd in both. usr_a moved, so its cards changed —
  // which is the point: the view followed the SEAT usr_a actually occupies in each state, and was
  // not derived from a remembered index of 0.
  assert.deepEqual(ownOf(inFirst).map(cardToString).sort(), ['7c', '8d']);
  assert.deepEqual(ownOf(inSecond).map(cardToString).sort(), ['Ad', 'Ah']);
});

test('a player who is not in the hand gets the spectator view, not the chair’s cards', () => {
  const state = dealWithIdentities(['usr_c', 'usr_a', 'usr_b']);

  // usr_newcomer holds no seat in this hand. Under a positional check they would have had to be
  // translated into an index first, and any index at all would have handed them somebody's cards.
  const view = redactFor(state, { viewerPlayerId: 'usr_newcomer' });
  assert.equal(view.viewerSeat, null, 'a stranger is a spectator');
  assert.deepEqual(
    view.seats.filter((seat) => seat.isSelf),
    [],
    'a stranger owns no seat',
  );
  for (const seat of view.seats) assert.equal(seat.holeCards, null);
  assert.deepEqual(view.legalActions, [], 'a stranger is never offered an action');
  assert.equal(view.amountToCall, 0, 'a stranger owes nothing');
  assertEntitlementFollowsIdentity(state, 'usr_newcomer');
});

test('a completed fold-out kept in memory shows the newcomer nothing at all', () => {
  // The reported defect, at the layer it was fixed in: the hand is over, the cards were never
  // shown, and the state is still around. Whoever asks next is somebody the hand never heard of.
  const finished = foldToCompletion(dealWithIdentities(['usr_c', 'usr_a', 'usr_b']));
  assert.equal(finished.result?.showdowns.length, 0, 'a fold-out shows nobody');

  const newcomer = redactFor(finished, { viewerPlayerId: 'usr_newcomer' });
  assert.equal(newcomer.viewerSeat, null);
  for (const seat of newcomer.seats) {
    assert.equal(seat.holeCards, null, `seat ${seat.seat} leaked out of a finished hand`);
    assert.equal(seat.isSelf, false);
  }
  const dealt = finished.seats.flatMap((seat) => seat.holeCards ?? []);
  assert.equal(dealt.length, 6, 'the finished hand must still hold the cards there was something to leak');
  const seen = cardsIn(newcomer);
  const leaked = dealt.filter((card) => seen.has(card)).map(cardToString);
  assert.deepEqual(leaked, [], `the newcomer received ${leaked.join(', ')} from a hand they never played`);

  // Meanwhile the people who WERE in it keep their own cards, before and after the hand ended.
  for (const player of ['usr_a', 'usr_b', 'usr_c']) {
    const own = redactFor(finished, { viewerPlayerId: player }).seats.find((seat) => seat.isSelf);
    assert.equal(own?.playerId, player);
    assert.notEqual(own?.holeCards, null, `${player} lost sight of their own finished hand`);
  }
});

test('entitlement is playerId equality, at every point of a hand and for every recipient', () => {
  const ids = ['usr_c', 'usr_a', 'usr_b'];
  let current = dealWithIdentities(ids);
  const recipients: (string | null)[] = [...ids, 'usr_newcomer', null];

  const streets: string[] = [];
  for (let guard = 0; guard < 64 && current.street !== 'complete'; guard += 1) {
    streets.push(current.street);
    for (const recipient of recipients) assertEntitlementFollowsIdentity(current, recipient);
    const seat = current.toAct;
    if (seat === null) break;
    const legal = redactFor(current, { viewerSeat: seat }).legalActions;
    const canCheck = legal.some((entry) => entry.type === 'check');
    current = applyAction(current, seat, canCheck ? { type: 'check' } : { type: 'call' }).state;
  }
  assert.ok(streets.includes('preflop') && streets.includes('river'), `walked ${streets.join(' -> ')}`);
  assert.equal(current.street, 'complete');
  assert.ok((current.result?.showdowns.length ?? 0) >= 2, 'this hand should reach a showdown');
  for (const recipient of recipients) assertEntitlementFollowsIdentity(current, recipient);
});

test('an ambiguous recipient fails closed rather than picking a seat', () => {
  // One id in two chairs cannot happen through `LiveTable.sit`, which refuses a second seat to a
  // user who already holds one. It is asserted anyway because "cannot happen" is not a guarantee,
  // and the safe answer to an ambiguous question is the spectator view — never a guess at which of
  // the two hands the asker meant.
  const state = dealWithIdentities(['usr_twin', 'usr_twin', 'usr_b']);
  const view = redactFor(state, { viewerPlayerId: 'usr_twin' });
  assert.equal(view.viewerSeat, null, 'an ambiguous identity resolves to nobody');
  for (const seat of view.seats) {
    assert.equal(seat.isSelf, false, 'no seat may be claimed on an ambiguous identity');
    assert.equal(seat.holeCards, null, 'and no cards may be handed over on one');
  }
  assert.deepEqual(view.legalActions, []);
  assert.equal(
    cardsHiddenFrom(state, { viewerPlayerId: 'usr_twin' }).length,
    6 + (52 - 6),
    'every hole card and the whole undealt deck stay hidden from an unresolvable recipient',
  );
});

test('the positional form resolves through the state, so an unknown index is a spectator', () => {
  const state = dealWithIdentities(['usr_c', 'usr_a', 'usr_b']);

  // The seat form is only ever valid for an index read out of this same state. Handed one that is
  // not in it — the shape a remembered or externally-supplied index has — it must not invent a
  // recipient, and `viewerSeat` must report what the view was actually built for.
  const stray: SeatIndex = 5;
  const view = redactFor(state, { viewerSeat: stray });
  assert.equal(view.viewerSeat, null, 'an index this hand does not have belongs to nobody');
  for (const seat of view.seats) {
    assert.equal(seat.isSelf, false);
    assert.equal(seat.holeCards, null);
  }

  // And for an index that IS in the state, the two forms agree exactly — which is what makes the
  // positional form safe for the engine's own callers, who are iterating this state's own seats.
  for (const seat of state.seats) {
    assert.equal(
      JSON.stringify(redactFor(state, { viewerSeat: seat.seat })),
      JSON.stringify(redactFor(state, { viewerPlayerId: seat.playerId })),
      `the two forms disagree about seat ${seat.seat}`,
    );
  }
});
