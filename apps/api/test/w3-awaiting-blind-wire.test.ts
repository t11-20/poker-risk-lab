/**
 * The blind obligation, carried across the wire.
 *
 * ## The defect this closes
 *
 * A newcomer at a table with a rotation already running waits for the big blind to reach them
 * rather than being dealt straight in — that is the dead-button rule, and it is what stops four of
 * the fifteen seating combinations handing an arriving player a completely free hand. The table
 * enforces it (`LiveTable.owesBlind`, `TableSnapshot.awaitingBigBlind`) and `test/table-blinds.test.ts`
 * proves the enforcement.
 *
 * But there was **no wire field**. `PlayerView.seats` contains only the seats that were dealt in,
 * so a waiting player is simply absent from the view, while `RoomSummary.members` still lists them
 * with a seat number and a stack. The client therefore rendered a seated player who silently
 * received no cards, with nothing anywhere explaining why — which reads to a learner as the table
 * being broken, on the one rule this product most wants them to understand.
 *
 * `RoomMember.awaitingBigBlind` is that field. These tests are what say it is really on the wire,
 * really derived from the obligation the server enforces, and really false when it should be.
 *
 * ## Why the assertions are pairs
 *
 * A wire field that is computed a second, independent way is a field that can drift from the rule
 * it claims to report — and drift silently, because both halves would still look correct on their
 * own. So every assertion below pins the summary against the TABLE's own answer (`owesBlind`,
 * `snapshot().awaitingBigBlind`) rather than against a constant. If the mapping is ever rewritten
 * to guess from, say, whether the member appears in the current view, these fail.
 *
 * No database: the registry is opened with the seating-only store and the no-op archive, exactly
 * as `test/ws-router.test.ts` does, because none of this is about SQL.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RoomMember, RoomSummary } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import {
  type LiveRoom,
  type RoomRecord,
  RoomRegistry,
  summaryFromRows,
  toRoomSummary,
} from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { seatingOnlyStore } from './helpers/live-room.ts';

const CONFIG = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 } as const;

function record(): RoomRecord {
  return {
    id: 'room_awaitingblindwire',
    name: 'Waiting for the blind',
    ownerUserId: 'usr_alice',
    config: CONFIG,
    startingStack: 1_000,
    createdAt: '2026-08-18T12:00:00.000Z',
    closed: false,
  };
}

/** Readable hand ids, so a failure names the hand it happened in. */
function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_awaitingblind${count}`;
  };
}

function openRoom(): Promise<LiveRoom> {
  const registry = new RoomRegistry({
    store: seatingOnlyStore(),
    clock: createManualClock(),
    random: createSecureRandom(),
    nextHandId: incrementingHandIds(),
  });
  return registry.open({ record: record() });
}

/** Seats a player at the live table and registers them as a member, as the sit route does. */
async function seat(room: LiveRoom, userId: string, seatIndex: number): Promise<void> {
  room.addMember({ userId, displayName: userId.toUpperCase(), isBot: false, botProfile: null });
  await room.table.sit({ userId, displayName: userId.toUpperCase(), seat: seatIndex, stack: 1_000 });
}

/**
 * Folds every decision until the hand is over.
 *
 * Folding rather than calling keeps the hand short and the chip movement trivial — the subject
 * here is who is being DEALT IN, not who won. Same technique, and the same reason, as
 * `test/table-blinds.test.ts`.
 */
async function foldItOut(room: LiveRoom, observer: string): Promise<void> {
  for (let guard = 0; guard <= 64; guard += 1) {
    const view = room.table.viewFor(observer);
    if (view === null || view.toAct === null) return;
    const actor = view.seats.find((entry) => entry.seat === view.toAct)?.playerId;
    assert.ok(actor !== undefined, `seat ${String(view.toAct)} is to act but holds no player`);
    await room.table.submitAction(actor, {
      action: { type: 'fold' },
      actionId: `act_${String(guard)}_${String(view.actionSequence)}`,
      expectedSequence: view.actionSequence,
    });
  }
  assert.fail('a folded-round hand did not finish');
}

function memberOf(summary: RoomSummary, userId: string): RoomMember {
  const found = summary.members.find((member) => member.userId === userId);
  assert.ok(found !== undefined, `no member ${userId} in the summary`);
  return found;
}

describe('a seat that is waiting for the big blind is visible on the wire', () => {
  it('reports the obligation the table is actually enforcing, seat by seat', async () => {
    const room = await openRoom();
    try {
      // Two players, one hand dealt: this is what starts a rotation. Before the first deal there
      // is nobody who has already paid, so nobody can owe anything and the field is uniformly
      // false — which is why the newcomer has to arrive AFTER this.
      await seat(room, 'usr_alice', 0);
      await seat(room, 'usr_borys', 1);
      const beforeAnyHand = toRoomSummary(room);
      for (const member of beforeAnyHand.members) {
        assert.equal(member.awaitingBigBlind, false, `${member.userId} owes nothing before a deal`);
      }

      await room.table.startHand();

      // Carla arrives mid-rotation. She is seated, she has chips, and she is NOT being dealt in
      // until the big blind reaches her.
      await seat(room, 'usr_carla', 3);

      const summary = toRoomSummary(room);
      assert.equal(
        memberOf(summary, 'usr_carla').awaitingBigBlind,
        true,
        'the newcomer holds a seat and is not in the deal; the wire has to say so or the client ' +
          'renders a player who mysteriously receives no cards',
      );
      assert.equal(memberOf(summary, 'usr_alice').awaitingBigBlind, false);
      assert.equal(memberOf(summary, 'usr_borys').awaitingBigBlind, false);

      // The pairing that stops the two halves drifting: every member's field must equal the
      // table's own answer for that seat, not a value computed some other way that merely happens
      // to agree today.
      for (const member of summary.members) {
        assert.equal(
          member.awaitingBigBlind,
          room.table.owesBlind(member.userId),
          `${member.userId}: the summary disagrees with LiveTable.owesBlind`,
        );
      }
      const waiting = room.table.snapshot().awaitingBigBlind;
      assert.deepEqual([...waiting], [3], 'the snapshot names seat 3 and nothing else');
      assert.deepEqual(
        summary.members.filter((member) => member.awaitingBigBlind).map((member) => member.seat),
        [...waiting],
        'the summary must mark exactly the seats the snapshot names',
      );
    } finally {
      room.close();
    }
  });

  it('survives serialisation, because that is the only form the client ever sees', async () => {
    const room = await openRoom();
    try {
      await seat(room, 'usr_alice', 0);
      await seat(room, 'usr_borys', 1);
      await room.table.startHand();
      await seat(room, 'usr_carla', 3);

      // `toRoomSummary` feeds `welcome` and every `state` frame, and both go through JSON. A field
      // that is a getter, a symbol, or `undefined` would pass every assertion above and arrive at
      // the client as nothing at all.
      const framed: unknown = JSON.parse(JSON.stringify(toRoomSummary(room)));
      assert.ok(framed !== null && typeof framed === 'object');
      const members: unknown = Reflect.get(framed, 'members');
      assert.ok(Array.isArray(members));
      const carla = members.find(
        (member: unknown) =>
          member !== null && typeof member === 'object' && Reflect.get(member, 'userId') === 'usr_carla',
      );
      assert.ok(carla !== undefined, 'the newcomer is missing from the serialised member list');
      assert.equal(
        Reflect.get(carla, 'awaitingBigBlind'),
        true,
        'awaitingBigBlind must survive JSON as a real boolean; this is the whole delivery path',
      );
    } finally {
      room.close();
    }
  });

  it('is discharged by posting, and the wire follows it down as well as up', async () => {
    const room = await openRoom();
    try {
      await seat(room, 'usr_alice', 0);
      await seat(room, 'usr_borys', 1);
      await room.table.startHand();
      await seat(room, 'usr_carla', 3);
      assert.equal(memberOf(toRoomSummary(room), 'usr_carla').awaitingBigBlind, true);

      // The rotation is what ends the wait. Play hands out until the big blind reaches seat 3; the
      // debt is discharged for everybody dealt in, so the field must go false on its own. A field
      // that latched true would be just as wrong as one that never went true, and only a
      // transition can tell the two apart.
      let cleared = false;
      for (let hand = 0; hand < 6 && !cleared; hand += 1) {
        await foldItOut(room, 'usr_alice');
        await room.table.startHand();
        cleared = memberOf(toRoomSummary(room), 'usr_carla').awaitingBigBlind === false;
      }
      assert.equal(cleared, true, 'the obligation never cleared within a full orbit');
      assert.equal(room.table.owesBlind('usr_carla'), false, 'and the table agrees it is discharged');
    } finally {
      room.close();
    }
  });

  it('is false for a room with no live table, rather than absent', () => {
    // The other mapping. A closed room, or one belonging to another process, has no obligations to
    // report — they live on the live table and are not persisted. `false` is the honest answer and
    // it has to be STATED: the field is required precisely so a mapping that forgot about it
    // cannot compile, which is the fail-closed posture ADR 0003 asks for.
    const summary = summaryFromRows(
      {
        id: 'room_fromrows',
        name: 'A room from rows',
        owner_user_id: 'usr_alice',
        max_seats: 6,
        small_blind: 5,
        big_blind: 10,
        ante: 0,
        starting_stack: 1_000,
        action_timeout_seconds: 30,
        status: 'open',
        visibility: 'invite_only',
        created_at: new Date('2026-08-18T12:00:00.000Z'),
        closed_at: null,
      },
      [
        {
          id: 'mem_one',
          room_id: 'room_fromrows',
          user_id: 'usr_alice',
          display_name: 'Alice',
          seat: 0,
          stack: 1_000,
          is_bot: false,
          bot_profile: null,
          bot_difficulty: null,
          bot_seed: null,
          joined_at: new Date('2026-08-18T12:00:00.000Z'),
          left_at: null,
        },
      ],
    );
    const member = memberOf(summary, 'usr_alice');
    assert.equal(member.awaitingBigBlind, false);
    assert.ok(
      Object.hasOwn(member, 'awaitingBigBlind'),
      'the field must be present rather than merely falsy-by-absence: a client that checks it ' +
        'must be able to tell "not waiting" from "this server does not report waiting"',
    );
  });
});
