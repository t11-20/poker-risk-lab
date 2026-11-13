/**
 * Entitlement belongs to a person, never a chair. `redactFor` once compared seat indices, so after
 * a player stood up the next occupant of the chair saw their unshown cards with `isSelf: true`.
 * Player ids here deliberately differ from seat indices (`seat 0 -> usr_c`), because with ids like
 * `p0, p1` an identity check and a position check agree, which is how the bug survived.
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

/** Deals a hand where seat index and player id are unrelated. `ids[i]` is the player in seat `i`. */
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
 * Who you are decides what you see. Checked for every recipient, plus a stranger and a spectator,
 * which covers the "not in this hand" case a seat index cannot express.
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

  // Also against ground truth from the state, so a leak cannot widen its own expectation.
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
  const deck = stackedDeck({ 1: 'AhAd', 2: 'KhKd', 0: '7c8d' }, [1, 2, 0], 'Qh 5s 2c');

  const first = dealWithIdentities(['usr_a', 'usr_b', 'usr_c'], deck);
  const second = dealWithIdentities(['usr_c', 'usr_a', 'usr_b'], deck);

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
  // usr_a moved seats, so its cards changed. The view followed the seat it occupies in each state.
  assert.deepEqual(ownOf(inFirst).map(cardToString).sort(), ['7c', '8d']);
  assert.deepEqual(ownOf(inSecond).map(cardToString).sort(), ['Ad', 'Ah']);
});

test('a player who is not in the hand gets the spectator view, not the chair’s cards', () => {
  const state = dealWithIdentities(['usr_c', 'usr_a', 'usr_b']);

  // usr_newcomer holds no seat. A positional check would map them to some index and leak its cards.
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
  // The reported defect. The hand is over, the cards were never shown, and a stranger asks.
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
  // `LiveTable.sit` refuses a second seat to one user. The ambiguous case still gets the spectator view.
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

  // A seat index not in this state must not invent a recipient.
  const stray: SeatIndex = 5;
  const view = redactFor(state, { viewerSeat: stray });
  assert.equal(view.viewerSeat, null, 'an index this hand does not have belongs to nobody');
  for (const seat of view.seats) {
    assert.equal(seat.isSelf, false);
    assert.equal(seat.holeCards, null);
  }

  for (const seat of state.seats) {
    assert.equal(
      JSON.stringify(redactFor(state, { viewerSeat: seat.seat })),
      JSON.stringify(redactFor(state, { viewerPlayerId: seat.playerId })),
      `the two forms disagree about seat ${seat.seat}`,
    );
  }
});
