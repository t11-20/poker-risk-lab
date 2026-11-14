/**
 * Each practice table keeps its own units, and starting one closes the learner's other one
 * (`RoomRegistry.retirePracticeTables`). The press used to do that silently, so 904 units at the bot
 * table became 1,000 at a Legends match. The first press now only reads the room list and asks.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type {
  CreateLegendMatchRequest,
  CreateLegendMatchResponse,
  CreateRoomRequest,
  CreateRoomResponse,
  RoomMember,
  RoomSummary,
} from '@prl/contracts';
import { BOT_TABLE_REQUEST, FRIENDS_TABLE_REQUEST } from '../src/lib/table-rooms.ts';
import { createsPracticeTable, practiceTableToRetire } from '../src/lib/table-switch.ts';
import { openPracticeRoom, type PracticeRoomDependencies } from '../src/lib/use-live-table.ts';

const READER = 'user-reader';
const FRIEND = 'user-friend';

function member(userId: string, seat: number | null, isBot: boolean, stack = 1_000): RoomMember {
  return {
    userId,
    displayName: userId,
    seat,
    stack,
    isBot,
    botProfile: isBot ? 'calling-station' : null,
    connected: true,
    awaitingBigBlind: false,
  };
}

function room(
  id: string,
  maxSeats: number,
  bots: number,
  options: { readonly readerStack?: number; readonly readerSeat?: number | null } & Partial<RoomSummary> = {},
): RoomSummary {
  const { readerStack = 1_000, readerSeat = 0, ...overrides } = options;
  return {
    id,
    name: 'Practice table',
    ownerUserId: READER,
    maxSeats,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    startingStack: 1_000,
    actionTimeoutSeconds: 60,
    status: 'open',
    visibility: 'invite_only',
    members: [
      member(READER, readerSeat, false, readerStack),
      ...Array.from({ length: bots }, (_, index) => member(`bot-${id}-${String(index)}`, index + 1, true)),
    ],
    createdAt: '2026-11-14T00:00:00.000Z',
    ...overrides,
  };
}

const BOT_TABLE = room('room-bots', 6, 5, { name: 'Bot table', readerStack: 904 });
const LEGEND_MATCH = room('room-legend', 2, 1, { name: 'Legends practice', readerStack: 1_240 });
const FRIENDS_TABLE = room('room-friends', 6, 2, { name: 'Private table' });

describe('the table a press would close', () => {
  it('is the open bot table, with the reader’s units there', () => {
    assert.deepEqual(practiceTableToRetire([BOT_TABLE], READER, null), {
      roomId: 'room-bots',
      kind: 'botTable',
      stack: 904,
    });
  });

  it('is an open Legends match, told apart by its width as `chooseRoom` does', () => {
    assert.deepEqual(practiceTableToRetire([LEGEND_MATCH], READER, null), {
      roomId: 'room-legend',
      kind: 'legendMatch',
      stack: 1_240,
    });
  });

  it('is not a friends table, which keeps chairs free for people', () => {
    assert.equal(practiceTableToRetire([FRIENDS_TABLE], READER, null), null);
  });

  it('is not a table somebody else joined, even with a bot in every other chair', () => {
    // Watching, because the bots fill every chair but the reader's, so only the person rules it out.
    const joined = room('room-joined', 6, 5, {
      members: [...BOT_TABLE.members, member(FRIEND, null, false)],
    });
    assert.equal(practiceTableToRetire([joined], READER, null), null);
  });

  it('is not a table the reader does not own, or one already closed, or one with no bot left', () => {
    assert.equal(
      practiceTableToRetire([room('room-theirs', 2, 1, { ownerUserId: FRIEND })], READER, null),
      null,
    );
    assert.equal(practiceTableToRetire([room('room-shut', 2, 1, { status: 'closed' })], READER, null), null);
    assert.equal(practiceTableToRetire([room('room-empty', 1, 0)], READER, null), null);
  });

  it('is nothing when nothing is open', () => {
    assert.equal(practiceTableToRetire([], READER, null), null);
  });

  it('is nothing when the press reuses a room, because a reuse creates nothing and closes nothing', () => {
    assert.equal(practiceTableToRetire([BOT_TABLE], READER, BOT_TABLE), null);
    assert.equal(practiceTableToRetire([LEGEND_MATCH, FRIENDS_TABLE], READER, FRIENDS_TABLE), null);
  });

  it('gives no figure for a reader who stood up, since a live table reports 0 for them', () => {
    const standing = room('room-standing', 2, 1, { readerSeat: null, readerStack: 0 });
    assert.deepEqual(practiceTableToRetire([standing], READER, null), {
      roomId: 'room-standing',
      kind: 'legendMatch',
      stack: null,
    });
  });
});

describe('which creates replace a practice table', () => {
  it('the bot table does, as `POST /rooms` decides it', () => {
    assert.equal(createsPracticeTable(BOT_TABLE_REQUEST), true);
  });

  it('a private table does not, because it leaves chairs free', () => {
    assert.equal(createsPracticeTable(FRIENDS_TABLE_REQUEST), false);
  });
});

/** Records every request, so a test can say which ones a press made. */
function network(rooms: readonly RoomSummary[]): {
  readonly calls: string[];
  readonly dependencies: PracticeRoomDependencies;
} {
  const calls: string[] = [];
  const created = room('room-new', 6, 5, { name: 'Bot table' });
  const match = room('room-new-legend', 2, 1, { name: 'Legends practice' });
  return {
    calls,
    dependencies: {
      listRooms: () => {
        calls.push('listRooms');
        return Promise.resolve(calls.includes('createLegendMatch') ? [...rooms, match] : rooms);
      },
      createRoom: (_token: string, _request: CreateRoomRequest): Promise<CreateRoomResponse> => {
        calls.push('createRoom');
        return Promise.resolve({ room: created, inviteCode: 'ABCD-EFGH-JKMN-PQRS' });
      },
      createLegendMatch: (
        _token: string,
        _request: CreateLegendMatchRequest,
      ): Promise<CreateLegendMatchResponse> => {
        calls.push('createLegendMatch');
        return Promise.resolve({ roomId: match.id, seats: [] } as unknown as CreateLegendMatchResponse);
      },
    },
  };
}

const SESSION = { user: { id: READER }, csrfToken: 'token' };
const LEGEND = { profileId: 'calling-station', difficulty: 'educational' } as const;
const signal = new AbortController().signal;

describe('pressing "Deal me in" with the other table open', () => {
  it('on /play, the first press asks and creates nothing (REGRESSION)', async () => {
    const { calls, dependencies } = network([LEGEND_MATCH]);
    const first = await openPracticeRoom(SESSION, BOT_TABLE_REQUEST, undefined, {}, signal, dependencies);
    assert.equal(first.kind, 'confirm');
    assert.deepEqual(first.kind === 'confirm' ? first.other : null, {
      roomId: 'room-legend',
      kind: 'legendMatch',
      stack: 1_240,
    });
    assert.deepEqual(calls, ['listRooms']);
  });

  it('on /play, the confirming press creates the bot table', async () => {
    const { calls, dependencies } = network([LEGEND_MATCH]);
    const confirmed = await openPracticeRoom(
      SESSION,
      BOT_TABLE_REQUEST,
      undefined,
      { confirmed: true },
      signal,
      dependencies,
    );
    assert.equal(confirmed.kind, 'opened');
    assert.deepEqual(calls, ['listRooms', 'createRoom']);
  });

  it('on a Legends page, the first press asks and the confirming press creates the match', async () => {
    const first = network([BOT_TABLE]);
    const asked = await openPracticeRoom(SESSION, BOT_TABLE_REQUEST, LEGEND, {}, signal, first.dependencies);
    assert.equal(asked.kind === 'confirm' ? asked.other.kind : null, 'botTable');
    assert.deepEqual(first.calls, ['listRooms']);

    const second = network([BOT_TABLE]);
    const opened = await openPracticeRoom(
      SESSION,
      BOT_TABLE_REQUEST,
      LEGEND,
      { confirmed: true },
      signal,
      second.dependencies,
    );
    assert.equal(opened.kind === 'opened' ? opened.room.id : null, 'room-new-legend');
    assert.deepEqual(second.calls, ['listRooms', 'createLegendMatch', 'listRooms']);
  });

  it('on /play, the bot table already open is reused, with no question and no create', async () => {
    const { calls, dependencies } = network([LEGEND_MATCH, BOT_TABLE]);
    const opened = await openPracticeRoom(SESSION, BOT_TABLE_REQUEST, undefined, {}, signal, dependencies);
    assert.equal(opened.kind === 'opened' ? opened.room.id : null, 'room-bots');
    assert.deepEqual(calls, ['listRooms']);
  });

  it('with only a friends table open, a Legends press creates at once', async () => {
    const { calls, dependencies } = network([FRIENDS_TABLE]);
    const opened = await openPracticeRoom(SESSION, BOT_TABLE_REQUEST, LEGEND, {}, signal, dependencies);
    assert.equal(opened.kind, 'opened');
    assert.deepEqual(calls, ['listRooms', 'createLegendMatch', 'listRooms']);
  });

  it('"Start a fresh table" and the private table are explicit choices, and are not asked about', async () => {
    const fresh = network([LEGEND_MATCH]);
    const rebuilt = await openPracticeRoom(
      SESSION,
      BOT_TABLE_REQUEST,
      undefined,
      { fresh: true },
      signal,
      fresh.dependencies,
    );
    assert.equal(rebuilt.kind, 'opened');
    assert.deepEqual(fresh.calls, ['listRooms', 'createRoom']);

    const friends = network([LEGEND_MATCH]);
    const opened = await openPracticeRoom(
      SESSION,
      FRIENDS_TABLE_REQUEST,
      undefined,
      { fresh: true },
      signal,
      friends.dependencies,
    );
    assert.equal(opened.kind, 'opened');
    assert.deepEqual(friends.calls, ['listRooms', 'createRoom']);
  });
});

describe('the hook and the panel', () => {
  const hook = readFileSync(new URL('../src/lib/use-live-table.ts', import.meta.url), 'utf8');
  const panel = readFileSync(new URL('../src/app/play/LiveTable.tsx', import.meta.url), 'utf8');

  it('only the confirming control passes `confirmed`, so no other press can skip the question', () => {
    assert.equal([...hook.matchAll(/confirmed: true/gu)].length, 1, 'one call site confirms');
    const at = hook.indexOf('confirmed: true');
    const owner = hook.lastIndexOf('const ', at);
    assert.match(hook.slice(owner, at), /^const confirmSwitch = /u);
  });

  it('announces the warning on insertion and keeps "Deal me in" off screen while it is up', () => {
    assert.match(
      panel,
      /\{live\.switchWarning === null \? null : \(?\s*<SwitchTablesNotice live=\{live\} warning=\{live\.switchWarning\}/u,
    );
    assert.match(panel, /<div role="alert">\s*<p>\{switchSentence\(/u);
    assert.match(panel, /\(phase === 'idle' \|\| phase === 'failed'\) && live\.switchWarning === null/u);
    assert.match(
      panel,
      /live\.switchWarning === null \? 'no-switch' : 'switch'/u,
      'the focus rescue sees it',
    );
  });

  it('no longer calls whichever table the reader has "the one you already have" (REGRESSION)', () => {
    assert.doesNotMatch(panel, /opens your practice table: the one you already have/u);
    const told = [...panel.matchAll(/'Each table keeps its own units/gu)].length;
    assert.equal(told, 2, 'the idle sentence on /play and on a Legends page both say so');
  });
});
