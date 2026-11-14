/**
 * `GET /rooms/:roomId` and the socket's `hello` both open a room by id for a caller, and must give the
 * same answer, after the same durable reads, for every case the check distinguishes. Each case runs
 * over both transports, each against a fresh registry, so a difference between them fails here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_STATUS, type ErrorCode, WS_CLOSE, wsCloseForError } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import type { RoomMemberRow, RoomRow } from '../src/repositories/rooms.ts';
import { RoomRegistry, type RoomStore } from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { createRoomRoutes } from '../src/routes/rooms.ts';
import { compileFrameValidator } from '../src/ws/hub.ts';
import { WsRouter } from '../src/ws/router.ts';
import { accountFor, fixedSessionStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const ROOM_ID = 'room_openmember1';
const MISSING_ROOM_ID = 'room_openmissing1';
const OWNER = 'usr_owner';
const MEMBER = 'usr_member';
const STRANGER = 'usr_stranger';
const NAMES: Readonly<Record<string, string>> = { [OWNER]: 'Ada', [MEMBER]: 'Bo', [STRANGER]: 'Mallory' };

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

function roomRow(status: RoomRow['status']): RoomRow {
  return {
    id: ROOM_ID,
    name: 'Opened by id',
    owner_user_id: OWNER,
    max_seats: 3,
    small_blind: 5,
    big_blind: 10,
    ante: 0,
    starting_stack: 1_000,
    action_timeout_seconds: 30,
    visibility: 'invite_only',
    status,
    closed_at: null,
    created_at: new Date('2026-08-17T12:00:00.000Z'),
  };
}

function memberRow(userId: string): RoomMemberRow {
  return {
    id: `mem_${userId}`,
    room_id: ROOM_ID,
    user_id: userId,
    display_name: NAMES[userId] ?? userId,
    seat: null,
    stack: 1_000,
    is_bot: false,
    bot_profile: null,
    bot_difficulty: null,
    bot_seed: null,
    joined_at: new Date('2026-08-17T12:00:00.000Z'),
    left_at: null,
  };
}

interface Fixture {
  /** One status per `byId` read, the last repeating, so a room can close between two reads. */
  readonly statuses?: readonly RoomRow['status'][];
  readonly byIdRejects?: boolean;
  /** The owner has no membership row, so only the ownership clause admits them. */
  readonly members?: readonly string[];
  /** Opened before the request, so the request takes the live branch. */
  readonly live?: boolean;
}

/** The owner is deliberately not a member, so the ownership clause is exercised on its own. */
function fakeStore(fixture: Fixture, reads: string[]): RoomStore {
  const refuse = (name: string): never => {
    throw new AppError('internal_error', { logDetail: `the fake store has no ${name}` });
  };
  const members = fixture.members ?? [MEMBER];
  const statuses = fixture.statuses ?? ['open'];
  let byIdReads = 0;
  return {
    create: () => refuse('create'),
    byId: (roomId) => {
      reads.push(`byId:${roomId}`);
      if (fixture.byIdRejects === true) return Promise.reject(new Error('connection terminated'));
      const status = statuses[Math.min(byIdReads, statuses.length - 1)] ?? 'open';
      byIdReads += 1;
      return Promise.resolve(roomId === ROOM_ID ? roomRow(status) : null);
    },
    byInviteCode: () => Promise.resolve(null),
    listForUser: () => Promise.resolve([]),
    membersOfRooms: (roomIds) => {
      reads.push(`membersOfRooms:${roomIds.join(',')}`);
      return Promise.resolve(roomIds.includes(ROOM_ID) ? members.map(memberRow) : []);
    },
    memberOf: (roomId, userId) => {
      reads.push(`memberOf:${userId}`);
      return Promise.resolve(roomId === ROOM_ID && members.includes(userId) ? memberRow(userId) : null);
    },
    addMember: () => refuse('addMember'),
    seatMember: () => refuse('seatMember'),
    unseatMember: () => refuse('unseatMember'),
    recordFirstSit: () => refuse('recordFirstSit'),
    removeMember: () => refuse('removeMember'),
    close: () => refuse('close'),
    closePracticeTable: () => refuse('closePracticeTable'),
    createBotUser: () => refuse('createBotUser'),
    readUnits: () => Promise.resolve(10_000),
  };
}

/** What a caller learns, in the same shape for both transports. */
type Answer = { readonly opened: string } | { readonly refused: ErrorCode };

interface Observed {
  readonly answer: Answer;
  readonly reads: readonly string[];
  readonly liveTables: number;
}

async function harness(fixture: Fixture): Promise<{
  readonly app: FastifyInstance;
  readonly registry: RoomRegistry;
  readonly reads: string[];
}> {
  const app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
      PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
      SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
      RATE_LIMIT_MAX: '5000',
    }),
    database: stubDatabase,
  });
  const reads: string[] = [];
  const registry = new RoomRegistry({
    clock: createManualClock(),
    random: createSecureRandom(),
    store: fakeStore(fixture, reads),
  });
  const sessions = fixedSessionStore(
    new Map(
      [OWNER, MEMBER, STRANGER].map((userId) => [
        `token-${userId}`,
        { sessionId: `ses_${userId}`, user: accountFor(userId, NAMES[userId] ?? userId) },
      ]),
    ),
  );
  // A schema-carrying route, so Fastify builds the Ajv instance `compileFrameValidator` borrows.
  app.get(
    '/api/v1/test-frame-schema-open',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async () => ({ ok: true }),
  );
  await app.register(createRoomRoutes({ registry, sessionStore: sessions }), { prefix: '/api/v1' });
  await app.ready();
  if (fixture.live === true) {
    assert.ok((await registry.ensureOpen(ROOM_ID)) !== null, 'the fixture could not open the room');
    reads.length = 0;
  }
  return { app, registry, reads };
}

async function overRest(fixture: Fixture, userId: string, roomId: string): Promise<Observed> {
  const test = await harness(fixture);
  try {
    const response = await test.app.inject({
      method: 'GET',
      url: `/api/v1/rooms/${roomId}`,
      cookies: { prl_session: test.app.signCookie(`token-${userId}`) },
    });
    const body = response.json() as { room?: { id?: string }; error?: { code?: ErrorCode } };
    let answer: Answer;
    if (response.statusCode === 200) {
      assert.ok(body.room?.id !== undefined, response.body);
      answer = { opened: body.room.id };
    } else {
      const code = body.error?.code;
      assert.ok(code !== undefined, response.body);
      assert.equal(response.statusCode, ERROR_STATUS[code], 'the status belongs to the code');
      answer = { refused: code };
    }
    return { answer, reads: [...test.reads], liveTables: test.registry.size };
  } finally {
    await test.app.close();
  }
}

async function overSocket(fixture: Fixture, userId: string, roomId: string): Promise<Observed> {
  const test = await harness(fixture);
  try {
    const router = new WsRouter({
      registry: test.registry,
      clock: createManualClock(),
      validate: compileFrameValidator(test.app),
      config: test.app.appConfig,
      nextRequestId: () => 'req-fixed',
    });
    const frames: { type: string; [key: string]: unknown }[] = [];
    const closes: number[] = [];
    const connection = router.open(
      { send: (text) => frames.push(JSON.parse(text)), close: (code) => closes.push(code) },
      { userId, displayName: NAMES[userId] ?? userId, sessionId: `ses_${userId}` },
    );
    router.handleFrame(
      connection,
      JSON.stringify({ type: 'hello', protocolVersion: 1, roomId, clientNonce: `nonce-${userId}` }),
    );
    for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setImmediate(resolve));

    const welcome = frames.find((frame) => frame.type === 'welcome');
    const error = frames.find((frame) => frame.type === 'error');
    let answer: Answer;
    if (welcome !== undefined) {
      assert.equal(error, undefined);
      assert.deepEqual(closes, []);
      const room = welcome['room'] as { id?: string } | undefined;
      assert.ok(room?.id !== undefined);
      answer = { opened: room.id };
    } else {
      assert.ok(error !== undefined, `hello was neither welcomed nor refused: ${JSON.stringify(frames)}`);
      const code = (error['error'] as { code: ErrorCode }).code;
      assert.deepEqual(closes, [wsCloseForError(code)], 'the close code belongs to the refusal');
      answer = { refused: code };
    }
    router.handleClose(connection);
    return { answer, reads: [...test.reads], liveTables: test.registry.size };
  } finally {
    await test.app.close();
  }
}

interface Case {
  readonly name: string;
  readonly fixture: Fixture;
  readonly userId: string;
  readonly roomId?: string;
  readonly expected: Observed;
}

const REFUSED: Answer = { refused: 'room_not_found_or_not_permitted' };
const OPENED: Answer = { opened: ROOM_ID };
/** `ensureOpen`'s read, its roster load, and the build's own recheck of the row. */
const ROSTER_LOAD = [`byId:${ROOM_ID}`, `membersOfRooms:${ROOM_ID}`, `byId:${ROOM_ID}`];

const CASES: readonly Case[] = [
  {
    name: 'a member of a room this process has not opened',
    fixture: {},
    userId: MEMBER,
    expected: {
      answer: OPENED,
      reads: [`byId:${ROOM_ID}`, `memberOf:${MEMBER}`, ...ROSTER_LOAD],
      liveTables: 1,
    },
  },
  {
    name: 'the owner, who has no membership row',
    fixture: {},
    userId: OWNER,
    expected: {
      answer: OPENED,
      reads: [`byId:${ROOM_ID}`, `memberOf:${OWNER}`, ...ROSTER_LOAD],
      liveTables: 1,
    },
  },
  {
    name: 'a stranger, refused before any table is built',
    fixture: {},
    userId: STRANGER,
    expected: { answer: REFUSED, reads: [`byId:${ROOM_ID}`, `memberOf:${STRANGER}`], liveTables: 0 },
  },
  {
    name: 'a member of a closed room, refused before membership is read',
    fixture: { statuses: ['closed'] },
    userId: MEMBER,
    expected: { answer: REFUSED, reads: [`byId:${ROOM_ID}`], liveTables: 0 },
  },
  {
    name: 'a room that does not exist, refused as a stranger is',
    fixture: {},
    userId: MEMBER,
    roomId: MISSING_ROOM_ID,
    expected: { answer: REFUSED, reads: [`byId:${MISSING_ROOM_ID}`], liveTables: 0 },
  },
  {
    name: 'a room closed between the membership check and the build',
    fixture: { statuses: ['open', 'closed'] },
    userId: MEMBER,
    expected: {
      answer: REFUSED,
      reads: [`byId:${ROOM_ID}`, `memberOf:${MEMBER}`, `byId:${ROOM_ID}`],
      liveTables: 0,
    },
  },
  {
    name: 'a room closed while its table was being built',
    fixture: { statuses: ['open', 'open', 'closed'] },
    userId: MEMBER,
    expected: {
      answer: REFUSED,
      reads: [`byId:${ROOM_ID}`, `memberOf:${MEMBER}`, ...ROSTER_LOAD],
      liveTables: 0,
    },
  },
  {
    name: 'a member of a live room, served from memory',
    fixture: { live: true },
    userId: MEMBER,
    expected: { answer: OPENED, reads: [], liveTables: 1 },
  },
  {
    name: 'a stranger to a live room, refused from memory',
    fixture: { live: true },
    userId: STRANGER,
    expected: { answer: REFUSED, reads: [], liveTables: 1 },
  },
  {
    name: 'a database fault reading the room, which is not a refusal',
    fixture: { byIdRejects: true },
    userId: MEMBER,
    expected: { answer: { refused: 'internal_error' }, reads: [`byId:${ROOM_ID}`], liveTables: 0 },
  },
];

describe('opening a room by id gives the same answer over REST and the socket', () => {
  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const roomId = testCase.roomId ?? ROOM_ID;
      const rest = await overRest(testCase.fixture, testCase.userId, roomId);
      assert.deepEqual(rest, testCase.expected, 'GET /rooms/:roomId');
      const socket = await overSocket(testCase.fixture, testCase.userId, roomId);
      assert.deepEqual(socket, testCase.expected, 'hello');
    });
  }

  it('closes a refused socket with the code a stranger gets, and a fault with one the client retries', () => {
    assert.equal(wsCloseForError('room_not_found_or_not_permitted'), WS_CLOSE.forbidden);
    assert.notEqual(wsCloseForError('internal_error'), WS_CLOSE.forbidden);
  });
});
