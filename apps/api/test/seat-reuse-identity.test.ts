/**
 * A chair changing owner must not change who anybody's cards belong to. `LiveTable` keeps the
 * finished `HandState` between hands, and `viewFor` once mapped the viewer to a seat index through
 * the current seating, so a new occupant got the previous one's unshown cards. `isSelf` must mean
 * that seat's `playerId` is the recipient, and cards may appear only for the recipient or a seat
 * that showed down. `ws-socket.test.ts` drives the real socket.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type Card, cardToString, createSecureRandom, type PlayerView } from '@prl/poker-engine';
import { isAppError } from '../src/errors.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';

const ADA = 'usr_ada';
const CY = 'usr_cy';
const BO = 'usr_bo';
const DI = 'usr_di';
const ED = 'usr_ed';

interface Harness {
  readonly table: LiveTable;
  /** So no turn timer decides anything. */
  readonly clock: ManualClock;
  readonly problems: string[];
}

let actionCounter = 0;
function nextActionId(): string {
  actionCounter += 1;
  return `act-seatreuse-${String(actionCounter).padStart(4, '0')}`;
}

function emptyTable(maxSeats = 3): Harness {
  const problems: string[] = [];
  const clock = createManualClock();
  let hands = 0;
  const table = new LiveTable({
    roomId: 'room_seatreuse',
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats, actionTimeoutSeconds: 30 },
    clock,
    random: createSecureRandom(),
    nextHandId: () => {
      hands += 1;
      return `hand_sr${hands}`;
    },
    onProblem: (message, detail) => problems.push(`${message} ${JSON.stringify(detail ?? {})}`),
  });
  return { table, clock, problems };
}

function viewOf(table: LiveTable, userId: string): PlayerView {
  const view = table.viewFor(userId);
  assert.ok(view !== null, `the table produced no view for ${userId}`);
  return view;
}

/** Turn order and legality are read from the table, never assumed. */
async function playOut(table: LiveTable, folder: string, observer: string): Promise<void> {
  for (let guard = 0; guard < 40; guard += 1) {
    const view = viewOf(table, observer);
    if (view.street === 'complete') return;
    const toAct = view.toAct;
    if (toAct === null) return;
    const actor = view.seats.find((seat) => seat.seat === toAct)?.playerId;
    assert.ok(actor !== undefined, `seat ${toAct} is not in the view`);
    const own = viewOf(table, actor);
    const legal = new Set(own.legalActions.map((entry) => entry.type));
    assert.ok(legal.size > 0, `${actor} is to act but was offered nothing`);
    let action: { readonly type: 'fold' | 'check' | 'call' } = { type: 'fold' };
    if (actor !== folder) action = legal.has('check') ? { type: 'check' } : { type: 'call' };
    await table.submitAction(actor, {
      action,
      actionId: nextActionId(),
      expectedSequence: own.actionSequence,
    });
  }
  assert.fail('the hand never completed');
}

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

/** Indifferent to how `redactFor` is written, and fails if either question is decided from a seat index. */
function assertViewBelongsTo(view: PlayerView, userId: string): void {
  const shown = new Set((view.result?.showdowns ?? []).map((entry) => entry.seat));
  for (const seat of view.seats) {
    assert.equal(
      seat.isSelf,
      seat.playerId === userId,
      `seat ${seat.seat} is held by ${seat.playerId} but was marked isSelf=${seat.isSelf} for ${userId}`,
    );
    if (seat.playerId === userId || shown.has(seat.seat)) continue;
    assert.equal(
      seat.holeCards,
      null,
      `${userId} was shown ${seat.playerId}'s hole cards in seat ${seat.seat}`,
    );
  }
  const ownSeat = view.seats.find((seat) => seat.playerId === userId) ?? null;
  assert.equal(
    view.viewerSeat,
    ownSeat?.seat ?? null,
    `${userId} was told they occupy a seat they do not hold in this hand`,
  );
}

/** Asserted to exist so a scan cannot be vacuous. */
function dealtCardsOf(table: LiveTable, userId: string): readonly Card[] {
  const deal = table.archivedDeal();
  assert.ok(deal !== null, 'the table has no deal to read');
  const seat = deal.seats.find((entry) => entry.userId === userId);
  assert.ok(seat !== undefined, `${userId} is not in the deal`);
  assert.ok(seat.holeCards !== null, `${userId} was dealt no cards`);
  assert.equal(seat.holeCards.length, 2);
  return seat.holeCards;
}

describe('a seat that changes owner', () => {
  it('does not hand the new occupant the previous occupant’s hole cards', async () => {
    const { table, problems } = emptyTable();
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });
    await table.startHand();

    // Nobody shows, so Ada's cards are sealed permanently.
    const adaCards = dealtCardsOf(table, ADA);
    await playOut(table, ADA, CY);
    const finished = viewOf(table, CY);
    assert.equal(finished.street, 'complete');
    assert.equal(finished.result?.showdowns.length, 0, 'this hand must end with nobody showing');
    const handId = finished.handId;

    await table.stand(ADA);
    assert.equal(table.seatOf(ADA), null, 'Ada is no longer seated');
    assert.equal(table.isSeatFree(0), true, 'seat 0 is free for the next player');

    // While the finished hand is still in memory.
    await table.sit({ userId: BO, displayName: 'Bo', seat: 0, stack: 1_000 });
    assert.equal(table.seatOf(BO), 0, 'Bo now holds the chair Ada played');

    const bo = viewOf(table, BO);
    assert.equal(bo.handId, handId, 'Bo is being shown the retained finished hand — the leak’s vehicle');
    assert.equal(bo.viewerSeat, null, 'Bo was not in this hand, so Bo is a spectator of it');
    assert.deepEqual(
      bo.seats.filter((seat) => seat.isSelf),
      [],
      'no seat of a hand Bo never played may be marked as Bo’s own',
    );
    for (const seat of bo.seats) {
      assert.equal(seat.holeCards, null, `seat ${seat.seat} leaked its cards to the new occupant`);
    }
    assertViewBelongsTo(bo, BO);

    // The hand's seat 0 is Ada and the table's seat 0 is Bo.
    const handSeatZero = bo.seats.find((seat) => seat.seat === 0);
    assert.equal(handSeatZero?.playerId, ADA, 'the finished hand still records Ada in seat 0');

    const seen = cardsIn(bo);
    const leaked = adaCards.filter((card) => seen.has(card)).map(cardToString);
    assert.deepEqual(leaked, [], `Bo received Ada's ${leaked.join(', ')}`);

    // The cards are detectable in the entitled view, so the scan above can fire.
    const adaSeen = cardsIn(viewOf(table, ADA));
    assert.deepEqual(
      adaCards
        .filter((card) => adaSeen.has(card))
        .map(cardToString)
        .sort(),
      [...adaCards].map(cardToString).sort(),
      'Ada must still see her own cards, or this scan proves nothing',
    );
    assert.deepEqual(problems, []);
  });

  it('pays the new occupant their own stack, not the stack the chair closed the hand on', async () => {
    const { table } = emptyTable();
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });
    await table.startHand();
    await playOut(table, ADA, CY);

    const adaClosing = table.snapshot().seats.find((seat) => seat.userId === ADA)?.stack;
    assert.ok(adaClosing !== undefined);
    assert.notEqual(adaClosing, 1_000, 'Ada must have lost her blind, or this test proves nothing');

    await table.stand(ADA);
    await table.sit({ userId: BO, displayName: 'Bo', seat: 0, stack: 1_000 });

    // Reading seat 0 by index would credit Bo with Ada's closing stack.
    const bo = table.snapshot().seats.find((seat) => seat.userId === BO);
    assert.equal(bo?.stack, 1_000, 'Bo brought their own chips to the chair');
  });

  it('gives a player who leaves and comes back their own hand, wherever they sit down again', async () => {
    const { table } = emptyTable();
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });
    await table.startHand();
    const adaCards = [...dealtCardsOf(table, ADA)].map(cardToString).sort();
    await playOut(table, ADA, CY);

    const beforeLeaving = JSON.stringify(viewOf(table, ADA));
    await table.stand(ADA);

    assert.equal(
      JSON.stringify(viewOf(table, ADA)),
      beforeLeaving,
      'leaving the table must not change what Ada may see of the hand she played',
    );

    // A different chair, which a positional check would get wrong.
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 2, stack: 1_000 });
    assert.equal(table.seatOf(ADA), 2);
    const returned = viewOf(table, ADA);
    assert.equal(returned.viewerSeat, 0, 'in THAT hand Ada was seat 0, whatever chair she is in now');
    const own = returned.seats.find((seat) => seat.isSelf);
    assert.equal(own?.playerId, ADA);
    assert.deepEqual(
      (own?.holeCards ?? []).map(cardToString).sort(),
      adaCards,
      'Ada’s own cards followed Ada, not the chair',
    );
    assertViewBelongsTo(returned, ADA);
  });

  it('is stable across repeated reads, which is all a reconnect is at this layer', async () => {
    const { table } = emptyTable();
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });
    await table.startHand();
    await playOut(table, ADA, CY);
    await table.stand(ADA);
    await table.sit({ userId: BO, displayName: 'Bo', seat: 0, stack: 1_000 });

    for (const userId of [ADA, CY, BO]) {
      assert.equal(
        JSON.stringify(viewOf(table, userId)),
        JSON.stringify(viewOf(table, userId)),
        `${userId} got two different pictures from two reads of one state`,
      );
      assertViewBelongsTo(viewOf(table, userId), userId);
    }
    assert.notEqual(
      JSON.stringify(viewOf(table, ADA)),
      JSON.stringify(viewOf(table, BO)),
      'the player who held the chair and the player who holds it now must not share a view',
    );
    const cySeat = viewOf(table, CY).seats.find((seat) => seat.isSelf);
    assert.equal(cySeat?.playerId, CY);
    assert.notEqual(cySeat?.holeCards, null, 'Cy still sees the hand Cy played');
  });
});

describe('a seat vacated mid-hand', () => {
  it('is not released while its player still holds cards, so nobody can inherit them', async () => {
    // Four chairs, so the refusal is `seat_taken` and not `room_full`.
    const { table } = emptyTable(4);
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });
    await table.sit({ userId: DI, displayName: 'Di', seat: 2, stack: 1_000 });
    await table.startHand();
    assert.equal(table.handInProgress, true);

    // The chair stays Ada's until the hand settles, which makes the mid-hand leak unreachable.
    await table.stand(ADA);
    assert.equal(table.handInProgress, true, 'a three-handed pot survives one fold');
    assert.equal(table.seatOf(ADA), 0, 'Ada keeps the chair until the hand settles');
    assert.equal(table.isSeatFree(0), false);
    await assert.rejects(
      table.sit({ userId: BO, displayName: 'Bo', seat: 0, stack: 1_000 }),
      (error: unknown) => isAppError(error) && error.code === 'seat_taken',
      'a chair holding live cards must not be reassignable',
    );

    await playOut(table, CY, DI);
    assert.equal(table.isSeatFree(0), true, 'settlement releases the chair');
    await table.sit({ userId: BO, displayName: 'Bo', seat: 0, stack: 1_000 });
    assertViewBelongsTo(viewOf(table, BO), BO);
    const adaCards = dealtCardsOf(table, ADA);
    const seen = cardsIn(viewOf(table, BO));
    const shown = new Set((viewOf(table, BO).result?.showdowns ?? []).map((entry) => entry.seat));
    if (!shown.has(0)) {
      const leaked = adaCards.filter((card) => seen.has(card)).map(cardToString);
      assert.deepEqual(leaked, [], `Bo inherited Ada's ${leaked.join(', ')} with the chair`);
    }
  });

  it('leaks nothing when a chair nobody was dealt into changes hands during a hand', async () => {
    const { table } = emptyTable();
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });
    await table.startHand();

    // Di missed the deal, then stands while the hand is live, the one way a chair changes owner
    // mid-hand. Ed takes it.
    await table.sit({ userId: DI, displayName: 'Di', seat: 2, stack: 1_000 });
    assert.equal(viewOf(table, DI).viewerSeat, null, 'a player who missed the deal is a spectator of it');
    await table.stand(DI);
    assert.equal(table.isSeatFree(2), true, 'a chair with no cards in it is released at once');
    await table.sit({ userId: ED, displayName: 'Ed', seat: 2, stack: 1_000 });
    assert.equal(table.handInProgress, true, 'all of that happened inside the live hand');

    const ed = viewOf(table, ED);
    assert.equal(ed.viewerSeat, null);
    assert.deepEqual(ed.legalActions, [], 'a spectator is never offered an action');
    assert.equal(ed.amountToCall, 0);
    for (const seat of ed.seats) assert.equal(seat.holeCards, null);
    assertViewBelongsTo(ed, ED);

    for (const newcomer of [ED]) {
      await assert.rejects(
        table.submitAction(newcomer, {
          action: { type: 'call' },
          actionId: nextActionId(),
          expectedSequence: ed.actionSequence,
        }),
        (error: unknown) => isAppError(error) && error.code === 'not_your_turn',
        'somebody who was not dealt in has no turn to take',
      );
    }

    await playOut(table, ADA, CY);
    assert.equal(viewOf(table, CY).street, 'complete');
    assertViewBelongsTo(viewOf(table, CY), CY);
    assertViewBelongsTo(viewOf(table, ED), ED);
  });
});

describe('across consecutive hands', () => {
  it('never marks a seat as the recipient’s unless that seat’s player IS the recipient', async () => {
    const { table, problems } = emptyTable();
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });

    await table.startHand();
    const adaCards = dealtCardsOf(table, ADA);
    await playOut(table, ADA, CY);
    await table.stand(ADA);

    // The retained roster and the seating now disagree about seat 0.
    await table.sit({ userId: BO, displayName: 'Bo', seat: 0, stack: 1_000 });
    const everyone = [ADA, CY, BO, DI];
    for (const userId of everyone) assertViewBelongsTo(viewOf(table, userId), userId);

    await table.startHand();
    for (const userId of everyone) assertViewBelongsTo(viewOf(table, userId), userId);
    await playOut(table, BO, CY);
    for (const userId of everyone) assertViewBelongsTo(viewOf(table, userId), userId);

    const ada = viewOf(table, ADA);
    assert.equal(ada.viewerSeat, null, 'Ada was not dealt into the second hand');
    const seen = cardsIn(ada);
    const stale = adaCards.filter((card) => seen.has(card)).map(cardToString);
    assert.deepEqual(stale, [], `hand one's cards followed the chair into hand two: ${stale.join(', ')}`);
    assert.deepEqual(problems, []);
  });
});
