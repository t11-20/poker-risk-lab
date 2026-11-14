/**
 * Work that must happen when a hand settles, not when a player asks to leave. A mid-hand leaver
 * keeps the chair until the hand is over, so a check made at the request is stale by settlement.
 * `TableNotice.departed`, `TableNotice.settledStacks` and `LiveRoom.releaseDeparted` are the single
 * mechanism. Chip conservation is asserted over what the archive was told, because the archive
 * survives the process and the table forgets the departed seat.
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
 * `seatMember` refuses a chair another live member holds, as `room_members_live_seat_key` does.
 * Without that refusal a test would pass whether or not the seat was released.
 */
function fakeStore(): {
  readonly store: RoomStore;
  readonly seats: Map<string, number | null>;
  readonly stacks: Map<string, number>;
  readonly left: Set<string>;
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
      if (taken) throw new AppError('seat_taken', { logDetail: `seat ${seat} is already held` });
      seats.set(userId, seat);
      return Promise.resolve(`mem_${userId}`);
    },
    // Both are partial on `left_at IS NULL` in the real schema.
    unseatMember: (_roomId, userId) => {
      if (unseatRefuses.has(userId)) return Promise.reject(new Error(`unseat refused for ${userId}`));
      if (!left.has(userId)) seats.set(userId, null);
      return Promise.resolve();
    },
    recordFirstSit: (memberId) => Promise.resolve(!left.has(memberId.slice('mem_'.length))),
    removeMember: (_roomId, userId) => {
      left.add(userId);
      return Promise.resolve();
    },
    close: () => Promise.resolve(true),
    closePracticeTable: () => refuse('closePracticeTable'),
    createBotUser: () => refuse('createBotUser'),
    readUnits: () => Promise.resolve(100_000),
  };
  return { store, seats, stacks, left, unseatRefuses };
}

/**
 * Binds `stacksSettled` to the store, with the `left_at IS NULL` guard, so assertions are about
 * `room_members.stack` rather than a spy.
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

function forcedBetUser(table: LiveTable, kind: 'smallBlind' | 'bigBlind'): string {
  const view = table.viewFor(PLAYERS[0]);
  assert.ok(view !== null, 'a dealt hand must produce a view');
  const bet = view.forcedBets.find((entry) => entry.kind === kind);
  assert.ok(bet !== undefined, `every hand posts a ${kind}`);
  const seat = view.seats.find((entry) => entry.seat === bet.seat);
  assert.ok(seat?.playerId !== undefined && seat.playerId !== null, `${kind} belongs to a dealt seat`);
  return seat.playerId;
}

/** Bounded by the seat count, so a stalled table fails instead of hanging the suite. */
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

/** The archive chain is not awaited by design. */
async function drainArchive(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function totalOf(stacks: ArchivedStacks): number {
  return stacks.stacks.reduce((sum, entry) => sum + entry.stack, 0);
}

describe('a hand settles every seat that played it, including one that stood up', () => {
  /**
   * Standing the big blind makes the leaver the winner (chips destroyed), standing the small blind
   * makes them the loser (blind handed back at the next sit).
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

  /** Leaving the winner out archives 1,995 chips where 3,000 went in. */
  it('archives the departing WINNER on their settled stack, not their pre-hand one', async () => {
    const { leaver, settled } = await departureOf('bigBlind');

    const users = settled.stacks.map((entry) => entry.userId);
    assert.ok(
      users.includes(leaver),
      `the departing winner ${leaver} was left out of the write-back; archived only ${users.join(',')}`,
    );
    const won = settled.stacks.find((entry) => entry.userId === leaver)?.stack;
    assert.equal(won, BUY_IN + CONFIG.smallBlind, 'the big blind took the small blind and left');
    assert.equal(
      totalOf(settled),
      PLAYERS.length * BUY_IN,
      'the archive was told about fewer chips than were bought in — the missing ones are destroyed',
    );
  });

  /** `sitAtTable` reads `buyIn = member.stack`, so a stale stack hands the blind back. */
  it('archives the departing LOSER on their settled stack, so the blind cannot be handed back', async () => {
    const { leaver, settled } = await departureOf('smallBlind');

    const paid = settled.stacks.find((entry) => entry.userId === leaver)?.stack;
    assert.equal(paid, BUY_IN - CONFIG.smallBlind, 'a player who posts a blind and folds is down it');
    assert.notEqual(paid, BUY_IN, 'archiving the pre-hand stack is how the blind gets conjured back');
    assert.equal(totalOf(settled), PLAYERS.length * BUY_IN, 'chips conserved across the departure');
  });
});

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
      assert.equal(seats.get(leaver), chair, 'a live hand keeps its chair until it is over');
      assert.equal(room.table.seatOf(leaver), chair, 'and the live table agrees, for the same reason');

      await foldItOut(room.table);
      await drainArchive();

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

      // The summary shows the chair free, so the database must agree.
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
        // Recorded in order, because the defect is an omission and a reordering.
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
      // Both seats are shorter than the big blind, so nobody ever has a decision.
      await table.sit({ userId: PLAYERS[0], displayName: PLAYERS[0], seat: 0, stack: 3 });
      await table.sit({ userId: PLAYERS[1], displayName: PLAYERS[1], seat: 1, stack: 4 });
      const { handId } = await table.startHand();
      assert.equal(table.viewFor(PLAYERS[0])?.street, 'complete', 'the hand is over before anybody acts');
      await drainArchive();

      // Without the start, `handsRepository.complete` throws `hand_not_active`.
      assert.deepEqual(
        calls,
        [`start:${handId}`, `complete:${handId}`, 'stacks', 'status:open'],
        `the archive saw ${calls.join(' | ')}`,
      );
      assert.deepEqual(problems, [], 'nothing about this hand is a problem to report');

      // `archiveNotice` promises both counters fire exactly once per hand.
      assert.equal(metrics.handsStarted.get(), 1, 'a dealt hand is a started hand, however short');
      assert.equal(metrics.handsCompleted.get(), 1);
      assert.equal(totalOf(settled[0] ?? { roomId: '', stacks: [] }), 7, 'chips conserved: 3 + 4 in, 7 out');
    } finally {
      room.close();
    }
  });
});

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
      // The owner is not a player, because `require` admits an owner regardless of membership.
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
      // No seat means no `departed` notice is coming, which `beginRoomExit` handles.
      await registry.leaveRoom('room_z5_spectator', PLAYERS[0]);
      assert.equal(room.member(PLAYERS[0]), null, 'an unseated member leaves immediately');
    } finally {
      registry.closeAll();
    }
  });
});

describe('a seat that could not be released is reported as its own kind of failure', () => {
  /**
   * Two players stand mid-hand and the store refuses the first release. This tests that one refusal
   * does not strand the chair behind it, and that the counter measures chairs, not passes.
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

  /** As `archive-write` it would page `ArchiveFailing`, which has the wrong runbook. */
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

  /** A single `await` over the whole list skips every chair after the first refusal. */
  it('still frees the chairs behind the one that failed', async () => {
    const { alsoLeaving, seats, metrics } = await stuckChair();

    assert.equal(seats.get(alsoLeaving), null, 'one refused write must not strand the next chair');
    assert.equal(metrics.seatReleaseFailures.get(), 1, 'and only the chair that failed is counted');
  });
});

describe('a refused timeout leaves the table clocked rather than frozen', () => {
  it('re-arms the turn timer when the engine rejects the timeout action', async () => {
    const clock = createManualClock();
    const problems: string[] = [];
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

      // An own property shadows the prototype `apply` on this instance only.
      Object.defineProperty(clocked, 'apply', { value: () => null, configurable: true });

      clock.advance(CONFIG.actionTimeoutSeconds * 1_000 + 1);
      await Promise.resolve();

      assert.deepEqual(problems, ['timeout-rejection'], 'the refusal is reported');
      // `TurnTimer.fire` clears `armed` first, and a null `apply` never reaches `afterMutation`,
      // so nothing but an explicit re-arm keeps a deadline.
      assert.ok(clocked.snapshot().deadlineMs !== null, 'the seat to act still has a deadline');
      assert.equal(clock.pending, 1, 'and a timer is actually scheduled to enforce it');
      assert.equal(clocked.handInProgress, true, 'the hand itself was untouched by the refusal');
    } finally {
      clocked.close();
    }
  });
});
