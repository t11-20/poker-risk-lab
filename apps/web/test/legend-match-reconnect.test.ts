/**
 * Coming back to a Legends match that is still running puts the reader back at it, with their seat
 * and stack. A finished or abandoned one is never reopened, and the reader starts fresh as before.
 * "Still running" is the server's own rule for dealing a hand: the room is open and both chairs hold
 * chips (`LiveTable.startHand`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type {
  CreateLegendMatchRequest,
  CreateLegendMatchResponse,
  LegendDifficulty,
  RoomMember,
  RoomSummary,
} from '@prl/contracts';
import { BOT_TABLE_REQUEST, resumeRememberedTable, type TableSession } from '../src/lib/table-rooms.ts';
import { openPracticeRoom, type PracticeRoomDependencies } from '../src/lib/use-live-table.ts';

const READER = 'usr_reader';
const PAGE = { profileId: 'calling-station', difficulty: 'realistic' } as const;

function member(
  userId: string,
  seat: number | null,
  stack: number,
  bot: LegendDifficulty | null,
): RoomMember {
  return {
    userId,
    displayName: userId,
    seat,
    stack,
    isBot: bot !== null,
    botProfile: bot === null ? null : 'calling-station',
    botDifficulty: bot,
    connected: true,
    awaitingBigBlind: false,
  };
}

interface Shape {
  readonly readerSeat?: number | null;
  readonly readerStack?: number;
  readonly botSeat?: number | null;
  readonly botStack?: number;
  readonly difficulty?: LegendDifficulty;
  readonly status?: RoomSummary['status'];
}

/** A heads-up match as `GET /rooms` lists it, against Calling Station at Realistic unless told. */
function match(id: string, shape: Shape = {}): RoomSummary {
  const { readerSeat = 0, readerStack = 1_240, botSeat = 1, botStack = 760 } = shape;
  return {
    id,
    name: 'Legends practice',
    ownerUserId: READER,
    maxSeats: 2,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    startingStack: 1_000,
    actionTimeoutSeconds: 60,
    status: shape.status ?? 'open',
    visibility: 'invite_only',
    members: [
      member(READER, readerSeat, readerStack, null),
      member(`bot-${id}`, botSeat, botStack, shape.difficulty ?? 'realistic'),
    ],
    createdAt: '2026-11-15T00:00:00.000Z',
  };
}

const BOT_TABLE: RoomSummary = {
  ...match('room-bots'),
  name: 'Bot table',
  maxSeats: 6,
  members: [
    member(READER, 0, 904, null),
    ...[1, 2, 3, 4, 5].map((seat) => member(`bot-${String(seat)}`, seat, 1_000, 'realistic')),
  ],
};

function network(rooms: readonly RoomSummary[]): {
  readonly calls: string[];
  readonly dependencies: PracticeRoomDependencies;
} {
  const calls: string[] = [];
  const created = match('room-new');
  return {
    calls,
    dependencies: {
      listRooms: () => {
        calls.push('listRooms');
        return Promise.resolve(calls.includes('createLegendMatch') ? [...rooms, created] : rooms);
      },
      createRoom: () => Promise.reject(new Error('a Legends page never creates a bot table')),
      createLegendMatch: (_token: string, _request: CreateLegendMatchRequest) => {
        calls.push('createLegendMatch');
        return Promise.resolve({ roomId: created.id } as unknown as CreateLegendMatchResponse);
      },
    },
  };
}

const SESSION: TableSession = {
  user: { id: READER, kind: 'guest', displayName: 'Guest', units: 1_000, createdAt: '2026-11-15T00:00:00Z' },
  csrfToken: 'token',
};
const signal = new AbortController().signal;

async function press(rooms: readonly RoomSummary[]) {
  const { calls, dependencies } = network(rooms);
  const opened = await openPracticeRoom(SESSION, BOT_TABLE_REQUEST, PAGE, {}, signal, dependencies);
  return { opened, calls };
}

async function resume(rooms: readonly RoomSummary[], remembered: string) {
  return await resumeRememberedTable(
    remembered,
    signal,
    { readSession: () => Promise.resolve(SESSION), listRooms: () => Promise.resolve(rooms) },
    PAGE,
  );
}

describe('"Deal me in" on the page of a match still running', () => {
  it('reconnects to it, creating nothing and asking nothing', async () => {
    const { opened, calls } = await press([match('room-running')]);
    assert.equal(opened.kind === 'opened' ? opened.room.id : opened.kind, 'room-running');
    assert.deepEqual(calls, ['listRooms']);
  });

  it('reconnects mid-hand, when an all-in seat shows no chips behind', async () => {
    const { opened } = await press([match('room-all-in', { readerStack: 0, status: 'playing' })]);
    assert.equal(opened.kind === 'opened' ? opened.room.id : opened.kind, 'room-all-in');
  });

  it('reconnects a reader who stood up, since a live table reports 0 for a standing member', async () => {
    const { opened } = await press([match('room-stood', { readerSeat: null, readerStack: 0 })]);
    assert.equal(opened.kind === 'opened' ? opened.room.id : opened.kind, 'room-stood');
  });
});

describe('a finished or abandoned match is never reopened', () => {
  for (const [why, shape] of [
    ['the reader is bust', { readerStack: 0 }],
    ['the bot is bust', { botStack: 0 }],
    ['the bot was not seated again after a restart', { botSeat: null, botStack: 0 }],
  ] as const) {
    it(`asks before closing it, as before, when ${why}`, async () => {
      const { opened, calls } = await press([match('room-over', shape)]);
      assert.equal(opened.kind, 'confirm');
      assert.deepEqual(opened.kind === 'confirm' ? opened.other : null, {
        roomId: 'room-over',
        kind: 'legendMatch',
        stack: shape.readerStack ?? 1_240,
        match: null,
      });
      assert.deepEqual(calls, ['listRooms']);
    });
  }

  it('starts a new match when the server closed it, so it is no longer listed open', async () => {
    const { opened, calls } = await press([match('room-closed', { status: 'closed' })]);
    assert.equal(opened.kind === 'opened' ? opened.room.id : opened.kind, 'room-new');
    assert.deepEqual(calls, ['listRooms', 'createLegendMatch', 'listRooms']);
  });

  it('is not resumed on load either', async () => {
    assert.equal(await resume([match('room-over', { botStack: 0 })], 'room-over'), null);
    assert.equal(await resume([match('room-closed', { status: 'closed' })], 'room-closed'), null);
    assert.equal(await resume([], 'room-gone'), null, 'a room the server no longer lists');
  });
});

describe('a match against another profile or at another difficulty', () => {
  it('still gets the switch warning, which names that match so the reader can go back to it', async () => {
    const other = { ...match('room-expert', { difficulty: 'expert' }) };
    const { opened, calls } = await press([other]);
    assert.deepEqual(opened.kind === 'confirm' ? opened.other : opened.kind, {
      roomId: 'room-expert',
      kind: 'legendMatch',
      stack: 1_240,
      match: { profileId: 'calling-station', difficulty: 'expert' },
    });
    assert.deepEqual(calls, ['listRooms']);

    const nit = match('room-nit');
    const renamed = { ...nit, members: nit.members.map((m) => (m.isBot ? { ...m, botProfile: 'nit' } : m)) };
    const asked = await press([renamed]);
    assert.equal(
      asked.opened.kind === 'confirm' ? asked.opened.other.kind : asked.opened.kind,
      'legendMatch',
    );
  });

  it('is not resumed on this page, and neither is the bot table the tab remembers', async () => {
    assert.equal(await resume([match('room-expert', { difficulty: 'expert' })], 'room-expert'), null);
    assert.equal(await resume([BOT_TABLE], 'room-bots'), null);
  });
});

describe('coming back to the match page', () => {
  it('resumes the match the tab remembers, while it is still running', async () => {
    const resumed = await resume([BOT_TABLE, match('room-running')], 'room-running');
    assert.equal(resumed?.room.id, 'room-running');
  });
});

describe('"Keep my other Legends match"', () => {
  it('links to that match’s page, remembering it first so the page resumes it', () => {
    const panel = readFileSync(new URL('../src/app/play/LiveTable.tsx', import.meta.url), 'utf8');
    assert.match(
      panel,
      /href=\{legendMatchHref\(match\.profileId, match\.difficulty\)\}\s*onClick=\{live\.stayAtOtherTable\}/u,
    );
    assert.doesNotMatch(panel, /none is ever reopened/u);
  });
});
