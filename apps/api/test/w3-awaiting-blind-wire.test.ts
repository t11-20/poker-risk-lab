/**
 * `RoomMember.awaitingBigBlind` reports the dead-button wait on the wire. `PlayerView.seats` omits a
 * seat that was not dealt in, so without this field the client shows a seated player who silently
 * gets no cards. Every assertion pins the field to the table's own answer (`owesBlind`,
 * `snapshot().awaitingBigBlind`), not a constant, so a second derivation cannot drift unnoticed.
 * No database. It uses a seating-only store and a no-op archive, as in ws-router.test.ts.
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

async function seat(room: LiveRoom, userId: string, seatIndex: number): Promise<void> {
  room.addMember({ userId, displayName: userId.toUpperCase(), isBot: false, botProfile: null });
  await room.table.sit({ userId, displayName: userId.toUpperCase(), seat: seatIndex, stack: 1_000 });
}

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
      // Nobody owes before the first deal, so the newcomer must arrive after it.
      await seat(room, 'usr_alice', 0);
      await seat(room, 'usr_borys', 1);
      const beforeAnyHand = toRoomSummary(room);
      for (const member of beforeAnyHand.members) {
        assert.equal(member.awaitingBigBlind, false, `${member.userId} owes nothing before a deal`);
      }

      await room.table.startHand();

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

      // A getter, symbol or `undefined` field passes the checks above and vanishes in JSON.
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

      // Only a true-to-false transition tells a working field from one latched true.
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
    // Obligations live only on the live table. The field is required so a mapping that forgets it
    // cannot compile (ADR 0003).
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
