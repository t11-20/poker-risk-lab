/**
 * What a hand SETTLING is responsible for, and what a player ASKING to leave is not.
 *
 * ## The defect class this file closes
 *
 * Four defects, one shape. Work that must happen when a hand settles was attached instead to the
 * moment a player asked to leave, and the two are separated by an arbitrary amount of play: a
 * player holding a live hand is flagged `leaving`, folds at their turn, and keeps their chair
 * until the hand is over. Every one of the four was a check evaluated at the request, found
 * false, and never re-run:
 *
 *   1. `settleIfComplete` wrote the final stacks into `this.seats` and then removed the leavers on
 *      the next line, and only afterwards published `handComplete`. The archive listener answered
 *      "who settled?" with `table.snapshot().seats` — a LATER read, from which the departed seat
 *      was already gone. A big blind who stood up and then won the pot uncontested was never
 *      written back: `room_members.stack` kept its pre-hand value and the chips they won were
 *      **destroyed**. The mirror case **created** chips — a leaver who posted a blind and
 *      auto-folded was recorded as still holding it, and `sitAtTable` (`buyIn = member.stack`)
 *      handed it back at their next sit.
 *   2. `standFromTable` freed `room_members.seat` only `if (table.seatOf(userId) === null)`, which
 *      is false for anybody holding a live hand. `settleIfComplete` freed the LIVE chair when the
 *      hand ended, on a path with no store, and nothing re-ran the check. The summary is built
 *      from the live table, so it showed the seat free; the next client to tap it was refused by
 *      `room_members_live_seat_key` with `seat_taken`, for the rest of the process's life.
 *   3. `afterMutation` did `reason = completed ? 'handComplete' : reason`, which threw away
 *      `'handStarted'` for a hand that was over before anybody acted — two seats both all-in for
 *      less than the big blind. The archive gates `hands.start` on that reason, so no row was
 *      written; `handsRepository.complete` then threw `hand_not_active`, aborting the rest of that
 *      archive step and taking `stacksSettled` and `roomStatusChanged` with it.
 *   4. `leaveRoom` dropped the in-memory membership under the same stale condition as (2), so a
 *      mid-hand leaver was durably gone and still a live member: `require()` kept granting them
 *      the room summary, the socket attach and the spectator views.
 *
 * The fix is one mechanism, not four patches. `LiveTable.removeSeats` names the users whose chair
 * it just freed on the notice that frees it (`TableNotice.departed`), `settleIfComplete` puts the
 * settled stacks on the notice at the one instant every seat is still present and already final
 * (`TableNotice.settledStacks`), and `LiveRoom.releaseDeparted` is the single reaction that does
 * the durable and in-memory tidying. Nothing downstream can tell an immediate departure from one
 * that waited out a hand, which is what makes the next defect of this shape impossible to write.
 *
 * ## Would these fail if the behaviour broke? Every one was run against the old code
 *
 * These began as four standalone reproductions of the audit's findings, run against the unfixed
 * tree. What each printed then, and prints now, is recorded at the assertion it belongs to. In
 * summary, against the OLD code:
 *
 *   - `stacksSettled` was called with `[{B,1000},{C,995}]` for a hand whose winner was A on 1005;
 *   - `room_members.seat` for the departed player read `0` after the hand completed, not `null`;
 *   - the archive received `["complete:hand_1","stacks","status:open"]` with no `start`;
 *   - `room.member('A')` was still a record after `leaveRoom` had durably removed A.
 *
 * The chip-conservation assertions are the strongest of them: they add up what the ARCHIVE was
 * told, not what the table happens to hold, because the archive is what survives the process and
 * the table is what forgets the departed seat.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSecureRandom } from '@prl/poker-engine';
import { AppError, isAppError } from '../src/errors.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import type { ProblemDetail } from '../src/observability/telemetry.ts';
import type { RoomMemberRow } from '../src/repositories/rooms.ts';
import { BotRunner } from '../src/rooms/bots.ts';
import {
  type ArchivedStacks,
  type HandArchive,
  LiveRoom,
  noopArchive,
  type RoomRecord,
  RoomRegistry,
  type RoomStore,
} from '../src/rooms/registry.ts';
import { LiveTable } from '../src/rooms/table.ts';
import { type Clock, createManualClock } from '../src/rooms/timers.ts';

const CONFIG = { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 3, actionTimeoutSeconds: 30 } as const;
const BUY_IN = 1_000;
const PLAYERS = ['usr_a', 'usr_b', 'usr_c'] as const;

let handCounter = 0;

/** Readable, sequential hand ids, so a failure names the hand it happened in. */
function incrementingHandIds(): () => string {
  return () => {
    handCounter += 1;
    return `hand_z5_${handCounter}`;
  };
}

function recordFor(roomId: string, ownerUserId: string): RoomRecord {
  return {
    id: roomId,
    name: 'Departure table',
    ownerUserId,
    config: CONFIG,
    startingStack: BUY_IN,
    createdAt: '2026-08-17T12:00:00.000Z',
    closed: false,
  };
}

/**
 * A room store over two maps, with the ONE database rule these tests turn on.
 *
 * `seatMember` refuses a chair another live member already holds, exactly as
 * `room_members_live_seat_key` does. That refusal is the whole point: the second defect's
 * user-visible symptom is a seat the summary shows as free and the database will not grant, so a
 * fake that let the second sit through would pass whether or not the seat was ever released.
 */
function fakeStore(): {
  readonly store: RoomStore;
  readonly seats: Map<string, number | null>;
  readonly stacks: Map<string, number>;
  readonly left: Set<string>;
  /** Users whose `unseatMember` rejects, so a release failure can be driven deliberately. */
  readonly unseatRefuses: Set<string>;
} {
  const seats = new Map<string, number | null>();
  const stacks = new Map<string, number>();
  const left = new Set<string>();
  const unseatRefuses = new Set<string>();
  const refuse = (name: string): never => {
    throw new AppError('internal_error', { logDetail: `the fake store has no ${name}` });
  };
  const rowFor = (roomId: string, userId: string): RoomMemberRow | null => {
    if (left.has(userId)) return null;
    return {
      id: `mem_${userId}`,
      room_id: roomId,
      user_id: userId,
      display_name: userId,
      seat: seats.get(userId) ?? null,
      stack: stacks.get(userId) ?? BUY_IN,
      is_bot: false,
      bot_profile: null,
      bot_difficulty: null,
      bot_seed: null,
      joined_at: new Date('2026-08-17T12:00:00.000Z'),
      left_at: null,
    };
  };
  const store: RoomStore = {
    create: () => refuse('create'),
    byId: () => Promise.resolve(null),
    byInviteCode: () => Promise.resolve(null),
    listForUser: () => Promise.resolve([]),
    membersOfRooms: () => Promise.resolve([]),
    memberOf: (roomId, userId) => Promise.resolve(rowFor(roomId, userId)),
    addMember: () => refuse('addMember'),
    seatMember: (_roomId, userId, seat) => {
      const taken = [...seats].some(([other, held]) => held === seat && other !== userId && !left.has(other));
      // `room_members_live_seat_key`, in one line. See this factory's comment.
      if (taken) throw new AppError('seat_taken', { logDetail: `seat ${seat} is already held` });
      seats.set(userId, seat);
      return Promise.resolve();
    },
    // Both of these are partial on `left_at IS NULL` in the real schema, so a member who has left
    // is untouched by either. Mirrored here so a test cannot pass on a write the database refuses.
    unseatMember: (_roomId, userId) => {
      // A rejected write, not a silent no-op: the point of the failure test is what the room does
      // when the database refuses, and a fake that swallowed it would prove nothing.
      if (unseatRefuses.has(userId)) return Promise.reject(new Error(`unseat refused for ${userId}`));
      if (!left.has(userId)) seats.set(userId, null);
      return Promise.resolve();
    },
    removeMember: (_roomId, userId) => {
      left.add(userId);
      return Promise.resolve();
    },
    close: () => Promise.resolve(true),
    createBotUser: () => refuse('createBotUser'),
    readUnits: () => Promise.resolve(100_000),
  };
  return { store, seats, stacks, left, unseatRefuses };
}

/**
 * The archive bound to a store's stack map, the way `postgresArchive.stacksSettled` binds to
 * `roomsRepository.updateMemberStack` — including its `left_at IS NULL` guard.
 *
 * Without this binding a test could only assert what the archive was TOLD. The chip destruction
 * in defect 1 is what the durable row ends up holding, so the two have to be joined up somewhere,
 * and joining them here keeps the assertions about `room_members.stack` rather than about a spy.
 */
function stackWritingArchive(
  stacks: Map<string, number>,
  left: ReadonlySet<string>,
  calls: ArchivedStacks[],
): HandArchive {
  return {
    ...noopArchive,
    stacksSettled: (settled) => {
      calls.push(settled);
      for (const entry of settled.stacks) {
        if (!left.has(entry.userId)) stacks.set(entry.userId, entry.stack);
      }
      return Promise.resolve();
    },
  };
}

function tableFor(roomId: string, clock: Clock): LiveTable {
  return new LiveTable({
    roomId,
    config: CONFIG,
    clock,
    random: createSecureRandom(),
    nextHandId: incrementingHandIds(),
  });
}

/** The user id sitting in the seat that posted `kind` this hand. */
function forcedBetUser(table: LiveTable, kind: 'smallBlind' | 'bigBlind'): string {
  // Any seated viewer will do: forced bets, the roster and the button are all public, and nothing
  // here reads a card.
  const view = table.viewFor(PLAYERS[0]);
  assert.ok(view !== null, 'a dealt hand must produce a view');
  const bet = view.forcedBets.find((entry) => entry.kind === kind);
  assert.ok(bet !== undefined, `every hand posts a ${kind}`);
  const seat = view.seats.find((entry) => entry.seat === bet.seat);
  assert.ok(seat?.playerId !== undefined && seat.playerId !== null, `${kind} belongs to a dealt seat`);
  return seat.playerId;
}

/**
 * Folds the hand out, honouring turn order and letting the departed seats fold themselves.
 *
 * Bounded by the seat count rather than looping until complete, so a table that stops advancing
 * fails the caller's assertions instead of hanging the suite.
 */
async function foldItOut(table: LiveTable): Promise<void> {
  for (let step = 0; step < CONFIG.maxSeats * 2; step += 1) {
    const view = table.viewFor(PLAYERS[0]);
    if (view === null || view.street === 'complete' || view.toAct === null) return;
    const actor = view.seats.find((entry) => entry.seat === view.toAct)?.playerId;
    assert.ok(actor !== undefined && actor !== null, 'the seat to act must belong to somebody');
    await table.submitAction(actor, {
      action: { type: 'fold' },
      actionId: `z5_fold_${step}_${actor}`,
      expectedSequence: view.actionSequence,
    });
  }
}

/** Lets the archive chain — which nothing awaits, by design — drain. */
async function drainArchive(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function totalOf(stacks: ArchivedStacks): number {
  return stacks.stacks.reduce((sum, entry) => sum + entry.stack, 0);
}

// ---------------------------------------------------------------------------
// Defect 1: the settled stacks of a seat that left mid-hand
// ---------------------------------------------------------------------------

describe('a hand settles every seat that played it, including one that stood up', () => {
  /**
   * Drives one departure and returns what the archive was told.
   *
   * Both directions of the defect are the same script with a different leaver, so they share it:
   * standing the big blind makes the departing player the WINNER (chips destroyed when they are
   * left out of the write-back), standing the small blind makes them the LOSER (chips created,
   * because their posted blind is handed back at their next sit).
   */
  async function departureOf(kind: 'smallBlind' | 'bigBlind'): Promise<{
    readonly leaver: string;
    readonly settled: ArchivedStacks;
  }> {
    const clock = createManualClock();
    const table = tableFor(`room_z5_${kind}`, clock);
    const calls: ArchivedStacks[] = [];
    const room = new LiveRoom({
      record: recordFor(`room_z5_${kind}`, PLAYERS[0]),
      table,
      bots: new BotRunner({ table, clock }),
      archive: {
        ...noopArchive,
        stacksSettled: (settled) => {
          calls.push(settled);
          return Promise.resolve();
        },
      },
      onProblem: () => undefined,
      metrics: new AppMetrics(),
    });
    try {
      for (const [seat, userId] of PLAYERS.entries()) {
        await table.sit({ userId, displayName: userId, seat, stack: BUY_IN });
      }
      await table.startHand();
      const leaver = forcedBetUser(table, kind);
      await table.stand(leaver);
      await foldItOut(table);
      await drainArchive();
      const settled = calls.at(-1);
      assert.ok(settled !== undefined, 'the hand must have settled');
      return { leaver, settled };
    } finally {
      room.close();
    }
  }

  /**
   * The reproduction, inverted.
   *
   * Against the old code this printed
   * `stacksSettled calls [{"roomId":"room_x","stacks":[{"userId":"B","stack":1000},{"userId":"C","stack":995}]}]`
   * for a hand whose result was `[{amount:15, playerId:"A"}]` — the winner absent, 1,995 chips
   * archived where 3,000 went in, and A's durable row left on its pre-hand 1000 while A actually
   * held 1005. It now prints all three seats with A on 1005.
   */
  it('archives the departing WINNER on their settled stack, not their pre-hand one', async () => {
    const { leaver, settled } = await departureOf('bigBlind');

    const users = settled.stacks.map((entry) => entry.userId);
    assert.ok(
      users.includes(leaver),
      `the departing winner ${leaver} was left out of the write-back; archived only ${users.join(',')}`,
    );
    const won = settled.stacks.find((entry) => entry.userId === leaver)?.stack;
    // Uncontested from the big blind: the 5 the small blind posted, and nothing else.
    assert.equal(won, BUY_IN + CONFIG.smallBlind, 'the big blind took the small blind and left');
    assert.equal(
      totalOf(settled),
      PLAYERS.length * BUY_IN,
      'the archive was told about fewer chips than were bought in — the missing ones are destroyed',
    );
  });

  /**
   * The mirror, which creates chips rather than destroying them.
   *
   * The small blind stands, is folded automatically when the action reaches them, and is 5 chips
   * lighter. Archived at their pre-hand 1000 instead — which is what the old code did, by leaving
   * them out entirely — `sitAtTable` reads `buyIn = member.stack` and hands the blind straight
   * back the next time they sit.
   */
  it('archives the departing LOSER on their settled stack, so the blind cannot be handed back', async () => {
    const { leaver, settled } = await departureOf('smallBlind');

    const paid = settled.stacks.find((entry) => entry.userId === leaver)?.stack;
    assert.equal(paid, BUY_IN - CONFIG.smallBlind, 'a player who posts a blind and folds is down it');
    assert.notEqual(paid, BUY_IN, 'archiving the pre-hand stack is how the blind gets conjured back');
    assert.equal(totalOf(settled), PLAYERS.length * BUY_IN, 'chips conserved across the departure');
  });
});

// ---------------------------------------------------------------------------
// Defect 2: the durable seat of a player who stood up mid-hand
// ---------------------------------------------------------------------------

describe('standing up mid-hand releases the durable seat when the hand settles', () => {
  it('frees room_members.seat, writes the settled stack, and lets the chair be taken again', async () => {
    const { store, seats, stacks, left } = fakeStore();
    const calls: ArchivedStacks[] = [];
    const registry = new RoomRegistry({
      store,
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
      archive: stackWritingArchive(stacks, left, calls),
      metrics: new AppMetrics(),
    });
    try {
      const room = await registry.open({
        record: recordFor('room_z5_seat', PLAYERS[0]),
        members: [...PLAYERS, 'usr_d'].map((userId) => ({
          userId,
          displayName: userId,
          isBot: false,
          botProfile: null,
        })),
      });
      for (const [seat, userId] of PLAYERS.entries()) {
        await registry.sitAtTable('room_z5_seat', { userId, displayName: userId }, seat);
      }
      await room.table.startHand();
      const leaver = forcedBetUser(room.table, 'bigBlind');
      const chair = seats.get(leaver);
      assert.ok(typeof chair === 'number', 'the leaver holds a durable seat before they stand');

      await registry.standFromTable('room_z5_seat', leaver);
      // Still theirs, and that is correct: they are holding cards and money in the pot. Freeing it
      // now is what would let somebody else take a chair that is still in the hand.
      assert.equal(seats.get(leaver), chair, 'a live hand keeps its chair until it is over');
      assert.equal(room.table.seatOf(leaver), chair, 'and the live table agrees, for the same reason');

      await foldItOut(room.table);
      await drainArchive();

      // Against the old code this read `0` — `standFromTable` released the row only when the table
      // freed the chair synchronously, and `settleIfComplete` freed it on a path with no store.
      assert.equal(
        seats.get(leaver),
        null,
        `${leaver} left the live table but room_members.seat still says ${String(seats.get(leaver))}`,
      );
      assert.equal(room.table.seatOf(leaver), null, 'and the live seat is gone too');
      assert.equal(
        stacks.get(leaver),
        BUY_IN + CONFIG.smallBlind,
        'the departing winner’s durable stack is what they actually left with',
      );

      // The symptom an operator sees: the summary is built from the live table, so it shows the
      // chair free. Before the fix the database refused it — `seat_taken` from
      // `room_members_live_seat_key` — for the rest of the process's life.
      assert.ok(
        registry.summary('room_z5_seat').members.every((member) => member.seat !== chair),
        'the summary shows the chair free',
      );
      await registry.sitAtTable('room_z5_seat', { userId: 'usr_d', displayName: 'usr_d' }, chair);
      assert.equal(seats.get('usr_d'), chair, 'and the chair the summary offers can actually be taken');
    } finally {
      registry.closeAll();
    }
  });
});

// ---------------------------------------------------------------------------
// Defect 3: a hand that is over before anybody acts
// ---------------------------------------------------------------------------

describe('a hand that is complete when startHand returns is still archived as started', () => {
  it('writes hands.start before hands.complete, and counts one of each', async () => {
    const clock = createManualClock();
    const table = tableFor('room_z5_short', clock);
    const calls: string[] = [];
    const settled: ArchivedStacks[] = [];
    const metrics = new AppMetrics();
    const problems: string[] = [];
    const room = new LiveRoom({
      record: recordFor('room_z5_short', PLAYERS[0]),
      table,
      bots: new BotRunner({ table, clock }),
      archive: {
        ...noopArchive,
        // Every write recorded in the ORDER it was made: the defect is an omission and a
        // reordering, and a set of booleans could see neither.
        handStarted: (deal) => {
          calls.push(`start:${deal.handId}`);
          return Promise.resolve();
        },
        handCompleted: (result) => {
          calls.push(`complete:${result.handId}`);
          return Promise.resolve();
        },
        stacksSettled: (stacks) => {
          calls.push('stacks');
          settled.push(stacks);
          return Promise.resolve();
        },
        roomStatusChanged: (_roomId, status) => {
          calls.push(`status:${status}`);
          return Promise.resolve();
        },
      },
      onProblem: (message, detail: ProblemDetail) => problems.push(`${detail.event}: ${message}`),
      metrics,
    });
    try {
      // Both seats are shorter than the big blind, so each is all-in the instant the forced bets
      // are posted and nobody ever has a decision. `LiveTable.startHand` says this case exists;
      // this is it.
      await table.sit({ userId: PLAYERS[0], displayName: PLAYERS[0], seat: 0, stack: 3 });
      await table.sit({ userId: PLAYERS[1], displayName: PLAYERS[1], seat: 1, stack: 4 });
      const { handId } = await table.startHand();
      assert.equal(table.viewFor(PLAYERS[0])?.street, 'complete', 'the hand is over before anybody acts');
      await drainArchive();

      // Against the old code this printed `["complete:hand_1","stacks","status:open"]`. The start
      // was thrown away because `afterMutation` overwrote the reason with `handComplete`, and
      // against the real `postgresArchive` the missing row made `handsRepository.complete` throw
      // `hand_not_active`, which aborted the rest of that step and skipped the two lines after it.
      assert.deepEqual(
        calls,
        [`start:${handId}`, `complete:${handId}`, 'stacks', 'status:open'],
        `the archive saw ${calls.join(' | ')}`,
      );
      assert.deepEqual(problems, [], 'nothing about this hand is a problem to report');

      // The invariant `archiveNotice` states about itself: both conditions fire exactly once per
      // hand. Completed climbing while started did not is precisely how it was falsified.
      assert.equal(metrics.handsStarted.get(), 1, 'a dealt hand is a started hand, however short');
      assert.equal(metrics.handsCompleted.get(), 1);
      assert.equal(totalOf(settled[0] ?? { roomId: '', stacks: [] }), 7, 'chips conserved: 3 + 4 in, 7 out');
    } finally {
      room.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Defect 4: the membership of somebody who left the room mid-hand
// ---------------------------------------------------------------------------

describe('leaving the room mid-hand drops the membership when the hand settles', () => {
  it('keeps the member while they hold cards, then removes them for good', async () => {
    const { store, seats, stacks, left } = fakeStore();
    const registry = new RoomRegistry({
      store,
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
      archive: stackWritingArchive(stacks, left, []),
      metrics: new AppMetrics(),
    });
    try {
      // The owner is deliberately NOT one of the players: `require` lets a room's owner in whether
      // or not they are a member, so a test that made the leaver the owner would prove nothing
      // about membership at all.
      const room = await registry.open({
        record: recordFor('room_z5_leave', 'usr_owner'),
        members: PLAYERS.map((userId) => ({
          userId,
          displayName: userId,
          isBot: false,
          botProfile: null,
        })),
      });
      for (const [seat, userId] of PLAYERS.entries()) {
        await registry.sitAtTable('room_z5_leave', { userId, displayName: userId }, seat);
      }
      await room.table.startHand();
      const leaver = forcedBetUser(room.table, 'bigBlind');

      await registry.leaveRoom('room_z5_leave', leaver);
      assert.equal(left.has(leaver), true, 'the durable row is marked left the moment they ask');
      assert.ok(room.member(leaver) !== null, 'and they stay a live member while they hold cards');

      await foldItOut(room.table);
      await drainArchive();

      // Against the old code every one of these three was the other way round: `leaveRoom` dropped
      // the membership only `if (seatOf(userId) === null)` at the moment of the request — false
      // for a player in a hand — and nothing re-ran it, so an ex-member kept `require()`-gated
      // access (room summary, socket attach, spectator views) for the process's lifetime.
      assert.equal(room.member(leaver), null, `${leaver} left the room durably but is still a live member`);
      assert.throws(
        () => registry.require('room_z5_leave', leaver),
        (error: unknown) => isAppError(error) && error.code === 'room_not_found_or_not_permitted',
        'an ex-member must not keep require()-gated access',
      );
      assert.ok(
        registry.summary('room_z5_leave').members.every((member) => member.userId !== leaver),
        'nor be listed in the room summary',
      );
      assert.equal(seats.get(leaver), null, 'and their chair is free');
    } finally {
      registry.closeAll();
    }
  });

  it('drops a member who never sat down at all, which no departure notice would announce', async () => {
    const { store, stacks, left } = fakeStore();
    const registry = new RoomRegistry({
      store,
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
      archive: stackWritingArchive(stacks, left, []),
      metrics: new AppMetrics(),
    });
    try {
      const room = await registry.open({
        record: recordFor('room_z5_spectator', 'usr_owner'),
        members: [{ userId: PLAYERS[0], displayName: PLAYERS[0], isBot: false, botProfile: null }],
      });
      // The case `beginRoomExit` exists to catch: no seat means no `departed` notice is ever
      // coming, so an exit that waited for one would wait for ever.
      await registry.leaveRoom('room_z5_spectator', PLAYERS[0]);
      assert.equal(room.member(PLAYERS[0]), null, 'an unseated member leaves immediately');
    } finally {
      registry.closeAll();
    }
  });
});

// ---------------------------------------------------------------------------
// When the seat release itself fails
// ---------------------------------------------------------------------------

describe('a seat that could not be released is reported as its own kind of failure', () => {
  /**
   * Two players stand mid-hand, so both chairs are freed by ONE settlement notice, and the store
   * refuses the first of them.
   *
   * Two things are under test and neither is visible with a single departure: that one refused
   * write does not strand the chair behind it, and that the counter measures CHAIRS rather than
   * passes.
   */
  async function stuckChair(): Promise<{
    readonly stuck: string;
    readonly alsoLeaving: string;
    readonly seats: Map<string, number | null>;
    readonly metrics: AppMetrics;
    readonly problems: readonly ProblemDetail[];
  }> {
    const { store, seats, stacks, left, unseatRefuses } = fakeStore();
    const metrics = new AppMetrics();
    const problems: ProblemDetail[] = [];
    const registry = new RoomRegistry({
      store,
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
      archive: stackWritingArchive(stacks, left, []),
      metrics,
      onProblem: (_message, detail) => problems.push(detail),
    });
    try {
      const room = await registry.open({
        record: recordFor('room_z5_stuck', 'usr_owner'),
        members: PLAYERS.map((userId) => ({
          userId,
          displayName: userId,
          isBot: false,
          botProfile: null,
        })),
      });
      for (const [seat, userId] of PLAYERS.entries()) {
        await registry.sitAtTable('room_z5_stuck', { userId, displayName: userId }, seat);
      }
      await room.table.startHand();
      // The blinds, so both leavers are certainly in the live hand and certainly leave together
      // when it settles rather than one of them leaving at once.
      const stuck = forcedBetUser(room.table, 'bigBlind');
      const alsoLeaving = forcedBetUser(room.table, 'smallBlind');
      unseatRefuses.add(stuck);

      await registry.standFromTable('room_z5_stuck', stuck);
      await registry.standFromTable('room_z5_stuck', alsoLeaving);
      await foldItOut(room.table);
      await drainArchive();
      return { stuck, alsoLeaving, seats, metrics, problems };
    } finally {
      registry.closeAll();
    }
  }

  /**
   * The routing this closes.
   *
   * `ProblemEvent` had no name for a failed seat release, so it reported as `archive-write` and
   * incremented `prl_archive_failures_total`. Run against that code, this test printed
   * `event archive-write | archiveFailures 1 | seatReleaseFailures 0` — an operator paged by
   * `ArchiveFailing`, which is zero-tolerance, would have opened the hand-history runbook for a
   * chair nobody can sit in. It now prints `event seat-release | archiveFailures 0 |
   * seatReleaseFailures 1`.
   */
  it('reports seat-release, not archive-write, and counts it on its own metric', async () => {
    const { stuck, metrics, problems } = await stuckChair();

    const reported = problems.filter((detail) => detail.event === 'seat-release');
    assert.equal(reported.length, 1, `expected one seat-release problem, saw ${problems.length}`);
    assert.deepEqual(reported[0]?.users, [stuck], 'the log line names the chair that is stuck');
    assert.equal(metrics.seatReleaseFailures.get(), 1, 'one chair could not be freed');
    assert.equal(
      metrics.archiveFailures.get(),
      0,
      'a stuck chair must not page the archive alert — different subsystem, different runbook',
    );
    assert.equal(
      metrics.tableActorFailures.get({ reason: 'seat-release' }),
      0,
      'nor be counted as a seat actor that failed to act: nothing is waiting to act',
    );
  });

  /**
   * Run against a `releaseDeparted` whose loop was a single `await` over the whole list — the
   * shape this replaced — and `usr_c`'s chair came back `2` instead of `null`: the first refusal
   * threw out of the loop and every chair behind it was skipped without a word. That is the same
   * defect this file is about, one level down.
   */
  it('still frees the chairs behind the one that failed', async () => {
    const { alsoLeaving, seats, metrics } = await stuckChair();

    assert.equal(seats.get(alsoLeaving), null, 'one refused write must not strand the next chair');
    assert.equal(metrics.seatReleaseFailures.get(), 1, 'and only the chair that failed is counted');
  });
});

// ---------------------------------------------------------------------------
// The turn clock, which nothing else re-arms
// ---------------------------------------------------------------------------

describe('a refused timeout leaves the table clocked rather than frozen', () => {
  it('re-arms the turn timer when the engine rejects the timeout action', async () => {
    const clock = createManualClock();
    const problems: string[] = [];
    // Built here rather than through `tableFor`, because this is the one case that needs the
    // problem hook: the refusal it reports is half of what the test asserts.
    const clocked = new LiveTable({
      roomId: 'room_z5_clock',
      config: CONFIG,
      clock,
      random: createSecureRandom(),
      nextHandId: incrementingHandIds(),
      onProblem: (_message, detail: ProblemDetail) => problems.push(detail.event),
    });
    try {
      await clocked.sit({ userId: PLAYERS[0], displayName: PLAYERS[0], seat: 0, stack: BUY_IN });
      await clocked.sit({ userId: PLAYERS[1], displayName: PLAYERS[1], seat: 1, stack: BUY_IN });
      await clocked.startHand();
      assert.ok(clocked.snapshot().deadlineMs !== null, 'a hand in progress is clocked');

      // The only way to reach `apply` returning null without a corrupt engine: shadow it on this
      // one instance. An own property wins over the prototype method, so `this.apply(...)` inside
      // `applyTimeout` resolves here. The prototype — and therefore every other table in this
      // process — is untouched.
      Object.defineProperty(clocked, 'apply', { value: () => null, configurable: true });

      clock.advance(CONFIG.actionTimeoutSeconds * 1_000 + 1);
      await Promise.resolve();

      assert.deepEqual(problems, ['timeout-rejection'], 'the refusal is reported');
      // `TurnTimer.fire` clears `armed` before it calls back, and a null from `apply` never reaches
      // `afterMutation`, so nothing else would ever arm this table again. Against the old code
      // both of these were the empty answer — `deadlineMs: null`, `pending: 0` — and the hand was
      // frozen on a seat with no clock and no expiry coming, for good.
      assert.ok(clocked.snapshot().deadlineMs !== null, 'the seat to act still has a deadline');
      assert.equal(clock.pending, 1, 'and a timer is actually scheduled to enforce it');
      assert.equal(clocked.handInProgress, true, 'the hand itself was untouched by the refusal');
    } finally {
      clocked.close();
    }
  });
});
