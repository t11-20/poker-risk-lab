/**
 * A chair changing owner must not change who anybody's cards belong to.
 *
 * ## The defect this file exists because of
 *
 * `LiveTable` keeps a completed `HandState` alive between hands — deliberately, because the
 * terminal frame, a reconnect between deals and the archive are all built from it. `viewFor` used
 * to translate the asking user id into a seat index by looking them up in the *current* seating,
 * and hand that index to `redactFor`. Those two rosters agree right up until somebody stands and
 * somebody else takes the chair, which is the one thing that is guaranteed to happen at a poker
 * table. The new occupant of seat 3 was then handed the previous occupant's unshown hole cards,
 * marked `isSelf: true` — the exact information the per-card Merkle commitment exists to keep
 * sealed.
 *
 * ## Why no test caught it
 *
 * Not one test in the suite had a seat change owner. Every existing case seats its players once
 * and keeps them there, and in that world a seat index and a person are the same thing, so a
 * positional check and an identity check are indistinguishable. That absence was as much the
 * defect as the code; this file is the part of the fix that stays.
 *
 * ## What is covered
 *
 * The whole lifecycle of a chair, not only the reported path: a chair that changes owner between
 * hands, the same player leaving and coming back, a chair vacated *during* a hand, the finished
 * hand retained in memory while the roster moves under it, and repeated reads for one identity
 * (which is all a reconnect is at this layer — `test/ws-socket.test.ts` drives the real socket).
 *
 * The assertions are properties rather than implementation: `isSelf` on a seat must mean "that
 * seat's `playerId` IS the recipient", and hole cards may be present only for the recipient
 * themselves or for a seat that actually showed down. Both hold however entitlement is computed,
 * and both break the moment it is computed from a seat index again.
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
  /** The table's own clock, so nothing here can be decided by a turn timer nobody advanced. */
  readonly clock: ManualClock;
  readonly problems: string[];
}

let actionCounter = 0;
function nextActionId(): string {
  actionCounter += 1;
  return `act-seatreuse-${String(actionCounter).padStart(4, '0')}`;
}

/** A table with nobody seated yet, so each test can compose its own seating story. */
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

/**
 * Plays the hand out, folding `folder` at their first turn and passively otherwise.
 *
 * Whose turn it is and what is legal are both read back from the table, never assumed — the point
 * of these tests is what the table says, so a hard-coded action order would only test the test.
 */
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
 * The property this whole file is about, asserted on one view.
 *
 * `isSelf` must mean "this seat's player IS the recipient" and nothing else, and cards may be
 * present only for the recipient or for a seat that showed down. Stated this way it is indifferent
 * to how `redactFor` is written, and it fails for any implementation that decides either question
 * from a seat index once index and person have come apart.
 */
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

/** The hole cards the deal recorded for one player, asserted to exist so a scan cannot be vacuous. */
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

    // Ada is dealt in and folds. Nobody shows, so her two cards are sealed permanently — not
    // merely until the hand ends.
    const adaCards = dealtCardsOf(table, ADA);
    await playOut(table, ADA, CY);
    const finished = viewOf(table, CY);
    assert.equal(finished.street, 'complete');
    assert.equal(finished.result?.showdowns.length, 0, 'this hand must end with nobody showing');
    const handId = finished.handId;

    // Ada stands. The hand is over, so the chair is released at once.
    await table.stand(ADA);
    assert.equal(table.seatOf(ADA), null, 'Ada is no longer seated');
    assert.equal(table.isSeatFree(0), true, 'seat 0 is free for the next player');

    // Bo takes the chair Ada just left, while the finished hand is still in memory.
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

    // The divergence this test turns on is real: the hand's seat 0 is Ada, the table's seat 0 is
    // Bo. Any answer computed from the index 0 would have been Ada's.
    const handSeatZero = bo.seats.find((seat) => seat.seat === 0);
    assert.equal(handSeatZero?.playerId, ADA, 'the finished hand still records Ada in seat 0');

    // Ground truth: none of Ada's cards reached Bo, in any field, at any depth.
    const seen = cardsIn(bo);
    const leaked = adaCards.filter((card) => seen.has(card)).map(cardToString);
    assert.deepEqual(leaked, [], `Bo received Ada's ${leaked.join(', ')}`);

    // And the scan is not vacuous: those very cards ARE detectable, in the view of the one person
    // entitled to them. A check that could never fire would satisfy everything above.
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

    // Chips belong to people. Reading the finished hand's seat 0 by index would have credited Bo
    // with Ada's closing stack — quieter than a leaked card, and just as wrong.
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

    // Standing up is not forgetting. The hand Ada played is still hers to look at.
    assert.equal(
      JSON.stringify(viewOf(table, ADA)),
      beforeLeaving,
      'leaving the table must not change what Ada may see of the hand she played',
    );

    // And she comes back to a DIFFERENT chair, which under a positional check would have made her
    // a stranger to her own hand (or, worse, an owner of somebody else's).
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

    // A reconnect re-reads the same state for the same identity. Every read for one person must be
    // the same answer, and two people must never be given the same answer.
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
    // Cy played the hand and Bo did not, so the seat Cy owns must be Cy's alone.
    const cySeat = viewOf(table, CY).seats.find((seat) => seat.isSelf);
    assert.equal(cySeat?.playerId, CY);
    assert.notEqual(cySeat?.holeCards, null, 'Cy still sees the hand Cy played');
  });
});

describe('a seat vacated mid-hand', () => {
  it('is not released while its player still holds cards, so nobody can inherit them', async () => {
    // Four chairs for three players, so the refusal below is `seat_taken` — the reason under test —
    // rather than `room_full`, which would pass the assertion while proving something else.
    const { table } = emptyTable(4);
    await table.sit({ userId: ADA, displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: CY, displayName: 'Cy', seat: 1, stack: 1_000 });
    await table.sit({ userId: DI, displayName: 'Di', seat: 2, stack: 1_000 });
    await table.startHand();
    assert.equal(table.handInProgress, true);

    // Ada stands while holding a live hand. She folds at her turn and is flagged to leave, but the
    // chair stays hers until the hand is settled — which is the structural reason the mid-hand
    // version of this leak is unreachable rather than merely unlikely.
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

    // Di sits down after the deal, so she is at the table but not in the hand. She stands again
    // while the hand is still live — the one way a chair genuinely changes owner mid-hand — and Ed
    // takes it.
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

    // Nor may either newcomer act into the live hand from a chair that was never dealt in.
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

    // The hand itself is untouched by any of it.
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

    // Hand one: Ada plays it and folds, then leaves.
    await table.startHand();
    const adaCards = dealtCardsOf(table, ADA);
    await playOut(table, ADA, CY);
    await table.stand(ADA);

    // Bo inherits the chair and plays hand two from it. Both hands' rosters now exist, one inside
    // the retained state and one in the seating, and they disagree about who seat 0 is.
    await table.sit({ userId: BO, displayName: 'Bo', seat: 0, stack: 1_000 });
    const everyone = [ADA, CY, BO, DI];
    for (const userId of everyone) assertViewBelongsTo(viewOf(table, userId), userId);

    await table.startHand();
    for (const userId of everyone) assertViewBelongsTo(viewOf(table, userId), userId);
    await playOut(table, BO, CY);
    for (const userId of everyone) assertViewBelongsTo(viewOf(table, userId), userId);

    // Ada is not in hand two at all, and her cards from hand one are gone with the state that held
    // them — she is now a spectator of a hand she never sat in.
    const ada = viewOf(table, ADA);
    assert.equal(ada.viewerSeat, null, 'Ada was not dealt into the second hand');
    const seen = cardsIn(ada);
    const stale = adaCards.filter((card) => seen.has(card)).map(cardToString);
    assert.deepEqual(stale, [], `hand one's cards followed the chair into hand two: ${stale.join(', ')}`);
    assert.deepEqual(problems, []);
  });
});
