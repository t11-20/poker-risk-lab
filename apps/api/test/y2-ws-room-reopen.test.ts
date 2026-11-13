/**
 * After an API restart the socket's `hello` must reopen a member's table from the database, as the
 * REST path's `ensureOpen` does. A stranger must still get the one refusal code that does not tell
 * "no such room" from "not yours", before any table is built (`registry.size` stays zero). A
 * database fault must close with a code the client retries, not 4403. The store is local because
 * `test/helpers/live-room.ts` answers `byId` with null.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WS_CLOSE } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import type { RoomMemberRow, RoomRow } from '../src/repositories/rooms.ts';
import { RoomRegistry, type RoomStore } from '../src/rooms/registry.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';
import { compileFrameValidator } from '../src/ws/hub.ts';
import { type SocketSink, WsRouter } from '../src/ws/router.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const ROOM_ID = 'room_y2restart1';
const OWNER = 'usr_owner';
const MEMBER = 'usr_member';
const STRANGER = 'usr_stranger';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

async function appWithValidator(): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database: stubDatabase });
  app.get(
    '/api/v1/test-frame-schema',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

function roomRow(): RoomRow {
  return {
    id: ROOM_ID,
    name: 'Survives a restart',
    owner_user_id: OWNER,
    max_seats: 2,
    small_blind: 5,
    big_blind: 10,
    ante: 0,
    starting_stack: 1_000,
    action_timeout_seconds: 30,
    visibility: 'invite_only',
    status: 'open',
    closed_at: null,
    created_at: new Date('2026-08-17T12:00:00.000Z'),
  };
}

function memberRow(userId: string, displayName: string, seat: number | null): RoomMemberRow {
  return {
    id: `mem_${userId}`,
    room_id: ROOM_ID,
    user_id: userId,
    display_name: displayName,
    seat,
    stack: 1_000,
    is_bot: false,
    bot_profile: null,
    bot_difficulty: null,
    bot_seed: null,
    joined_at: new Date('2026-08-17T12:00:00.000Z'),
    left_at: null,
  };
}

interface Reads {
  readonly calls: string[];
}

/** `status` is a parameter so the code under test, not the fake, refuses to reopen a closed room. */
function persistedStore(
  reads: Reads,
  options: {
    readonly status?: RoomRow['status'];
    /** A plain `Error`, as `postgres` rejects with no `code` this server understands. */
    readonly byIdRejectsWith?: Error;
  } = {},
): RoomStore {
  const refuse = (name: string): never => {
    throw new AppError('internal_error', { logDetail: `the fake store has no ${name}` });
  };
  const members = new Map<string, RoomMemberRow>([
    [OWNER, memberRow(OWNER, 'Ada', 0)],
    [MEMBER, memberRow(MEMBER, 'Bo', 1)],
  ]);
  const row: RoomRow = { ...roomRow(), status: options.status ?? 'open' };
  return {
    create: () => refuse('create'),
    byId: (roomId) => {
      reads.calls.push(`byId:${roomId}`);
      if (options.byIdRejectsWith !== undefined) return Promise.reject(options.byIdRejectsWith);
      return Promise.resolve(roomId === ROOM_ID ? row : null);
    },
    byInviteCode: () => Promise.resolve(null),
    listForUser: () => Promise.resolve([]),
    membersOfRooms: (roomIds) => {
      reads.calls.push(`membersOfRooms:${roomIds.join(',')}`);
      return Promise.resolve(roomIds.includes(ROOM_ID) ? [...members.values()] : []);
    },
    memberOf: (roomId, userId) => {
      reads.calls.push(`memberOf:${userId}`);
      return Promise.resolve(roomId === ROOM_ID ? (members.get(userId) ?? null) : null);
    },
    addMember: () => refuse('addMember'),
    seatMember: (_roomId, userId) => Promise.resolve(`mem_${userId}`),
    unseatMember: () => Promise.resolve(),
    recordFirstSit: () => Promise.resolve(true),
    removeMember: () => Promise.resolve(),
    close: () => Promise.resolve(true),
    closePracticeTable: () => refuse('closePracticeTable'),
    createBotUser: () => refuse('createBotUser'),
    readUnits: () => Promise.resolve(10_000),
  };
}

interface Recorder {
  readonly sink: SocketSink;
  readonly frames: string[];
  readonly closes: { code: number; reason: string }[];
}

function recorder(): Recorder {
  const frames: string[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    frames,
    closes,
    sink: { send: (text) => frames.push(text), close: (code, reason) => closes.push({ code, reason }) },
  };
}

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

function framesOf(recorded: Recorder): readonly Frame[] {
  return recorded.frames.map((text) => {
    const value: unknown = JSON.parse(text);
    assert.ok(typeof value === 'object' && value !== null && 'type' in value);
    return value as Frame;
  });
}

function firstOf(recorded: Recorder, type: string): Frame | null {
  return framesOf(recorded).find((frame) => frame.type === type) ?? null;
}

interface Restarted {
  readonly app: FastifyInstance;
  readonly router: WsRouter;
  readonly registry: RoomRegistry;
  readonly clock: ManualClock;
  readonly reads: Reads;
}

/** Nothing calls `registry.open`. That absence is the restart. */
async function afterRestart(
  options: { readonly status?: RoomRow['status']; readonly byIdRejectsWith?: Error } = {},
): Promise<Restarted> {
  const app = await appWithValidator();
  const clock = createManualClock();
  const reads: Reads = { calls: [] };
  const registry = new RoomRegistry({
    clock,
    random: createSecureRandom(),
    store: persistedStore(reads, options),
  });
  assert.equal(registry.size, 0, 'a restarted process holds no live tables');
  const router = new WsRouter({
    registry,
    clock,
    validate: compileFrameValidator(app),
    config: app.appConfig,
    nextRequestId: () => 'req-fixed',
  });
  return { app, router, registry, clock, reads };
}

async function sayHello(
  test: Restarted,
  userId: string,
  displayName: string,
  roomId = ROOM_ID,
): Promise<Recorder> {
  const recorded = recorder();
  const connection = test.router.open(recorded.sink, {
    userId,
    displayName,
    sessionId: `ses_${userId}`,
  });
  test.router.handleFrame(
    connection,
    JSON.stringify({ type: 'hello', protocolVersion: 1, roomId, clientNonce: `nonce-${userId}` }),
  );
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return recorded;
}

describe('a socket reopens a room this process has never seen', () => {
  it('welcomes a member back to their own table after a restart', async () => {
    const test = await afterRestart();
    try {
      const recorded = await sayHello(test, MEMBER, 'Bo');

      assert.deepEqual(
        recorded.closes,
        [],
        `the socket must stay open; it was closed with ${JSON.stringify(recorded.closes)}`,
      );
      const error = firstOf(recorded, 'error');
      assert.equal(error, null, `no refusal was expected, got ${JSON.stringify(error)}`);

      const welcome = firstOf(recorded, 'welcome');
      assert.ok(welcome !== null, 'hello is answered with a welcome');
      assert.equal(welcome['userId'], MEMBER);
      assert.equal(welcome['seat'], 1, 'the recorded seat is re-taken, not lost with the process');
      assert.ok(firstOf(recorded, 'state') !== null, 'the welcome is followed by the current view');

      assert.equal(test.registry.size, 1, 'the room is live again in this process');
    } finally {
      await test.app.close();
    }
  });

  it('welcomes the owner too, who has no membership row to be found by id', async () => {
    const test = await afterRestart();
    try {
      const recorded = await sayHello(test, OWNER, 'Ada');
      assert.deepEqual(recorded.closes, []);
      assert.equal(firstOf(recorded, 'welcome')?.['userId'], OWNER);
      assert.equal(firstOf(recorded, 'welcome')?.['seat'], 0);
    } finally {
      await test.app.close();
    }
  });

  it('reads the durable rows once and serves the second socket from memory', async () => {
    const test = await afterRestart();
    try {
      await sayHello(test, MEMBER, 'Bo');
      const afterFirst = [...test.reads.calls];
      assert.ok(afterFirst.includes(`byId:${ROOM_ID}`), 'the first hello reads the room row');

      await sayHello(test, OWNER, 'Ada');
      assert.deepEqual(
        test.reads.calls,
        afterFirst,
        'a room already in memory must not be re-read: the handshake stays synchronous for every ' +
          'socket after the first, which is what keeps a client that bursts hello+sit working',
      );
    } finally {
      await test.app.close();
    }
  });
});

describe('reopening does not become a way in', () => {
  it('refuses a stranger with the code that does not confirm the room exists', async () => {
    const test = await afterRestart();
    try {
      const recorded = await sayHello(test, STRANGER, 'Mallory');

      const error = firstOf(recorded, 'error');
      assert.ok(error !== null, 'an uninvited caller must be refused');
      const body = error['error'];
      assert.ok(typeof body === 'object' && body !== null && 'code' in body);
      assert.equal(
        (body as { readonly code: unknown }).code,
        'room_not_found_or_not_permitted',
        'the one code that covers "no such room" and "not yours" alike',
      );
      assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.forbidden);

      // A refusal distinguishable from "no such room" would confirm somebody else's room id.
      const unknown = await sayHello(test, STRANGER, 'Mallory', 'room_y2neverexisted');
      assert.deepEqual(
        framesOf(unknown),
        framesOf(recorded),
        'a real room a caller is not in, and a room that does not exist, must be indistinguishable',
      );
      assert.deepEqual(unknown.closes, recorded.closes);
    } finally {
      await test.app.close();
    }
  });

  it('refuses a stranger without building a table for them', async () => {
    // Membership is read before anything is opened, so a guessed id builds nothing.
    const test = await afterRestart();
    try {
      await sayHello(test, STRANGER, 'Mallory');
      assert.equal(
        test.registry.size,
        0,
        'a refused caller must not have caused a live table to be constructed',
      );
      assert.equal(
        test.reads.calls.includes(`membersOfRooms:${ROOM_ID}`),
        false,
        'the roster load belongs to ensureOpen, which must never have been reached',
      );
    } finally {
      await test.app.close();
    }
  });

  it('does not resurrect a room somebody closed', async () => {
    const test = await afterRestart({ status: 'closed' });
    try {
      const recorded = await sayHello(test, MEMBER, 'Bo');
      assert.ok(firstOf(recorded, 'error') !== null, 'a closed room is not reopened for anybody');
      assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.forbidden);
      assert.equal(test.registry.size, 0);
    } finally {
      await test.app.close();
    }
  });

  it('joins a socket to a room once, however many hellos race the database read', async () => {
    // `roomId` is set after the store read, so two hellos in one tick both joined and left
    // `noteSocket` one over. `connection.joining` is set synchronously.
    const test = await afterRestart();
    try {
      const recorded = recorder();
      const connection = test.router.open(recorded.sink, {
        userId: MEMBER,
        displayName: 'Bo',
        sessionId: `ses_${MEMBER}`,
      });
      const hello = JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        roomId: ROOM_ID,
        clientNonce: 'nonce-double',
      });
      test.router.handleFrame(connection, hello);
      test.router.handleFrame(connection, hello);
      for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));

      assert.equal(
        framesOf(recorded).filter((frame) => frame.type === 'welcome').length,
        1,
        'one socket, one welcome',
      );
      assert.equal(test.router.socketsIn(ROOM_ID).length, 1, 'the socket is registered once');
      const errors = framesOf(recorded).filter((frame) => frame.type === 'error');
      assert.equal(errors.length, 1, 'the duplicate hello is refused rather than ignored');

      // `RoomMember.connected` is derived from `sockets`, so it must return to zero.
      test.router.handleClose(connection);
      const room = test.registry.get(ROOM_ID);
      assert.ok(room !== null);
      const member = room.memberList().find((entry) => entry.userId === MEMBER);
      assert.equal(member?.sockets, 0, 'the only socket closed, so nobody is connected');
    } finally {
      await test.app.close();
    }
  });
});

/** `apps/web` cannot be imported from here, so the client's close-code table is read as text. */
const TABLE_SOCKET_SOURCE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'web',
  'src',
  'lib',
  'table-socket.ts',
);

function clientRetries(caseLabel: string): boolean {
  const source = readFileSync(TABLE_SOCKET_SOURCE, 'utf8');
  const start = source.indexOf(`case ${caseLabel}:`);
  assert.notEqual(start, -1, `describeClose has no branch for ${caseLabel}; this test is out of date`);
  const rest = source.slice(start + `case ${caseLabel}:`.length);
  const end = rest.indexOf('\n    case ');
  const block = end === -1 ? rest : rest.slice(0, end);
  assert.match(block, /retryable: (true|false)/, `no retryable flag in the ${caseLabel} branch`);
  return /retryable: true/.test(block);
}

describe('a transient database fault during hello is not reported as a permanent refusal', () => {
  it('closes with a code the client retries, not with 4403', async () => {
    const blip = new Error('connection terminated unexpectedly');
    const test = await afterRestart({ byIdRejectsWith: blip });
    try {
      const recorded = await sayHello(test, MEMBER, 'Bo');

      const error = firstOf(recorded, 'error');
      assert.ok(error !== null, 'the frame half is unchanged: the member is told something failed');
      const body = error['error'];
      assert.ok(typeof body === 'object' && body !== null && 'code' in body);
      assert.equal(
        (body as { readonly code: unknown }).code,
        'internal_error',
        'a fault on our side is `internal_error`, which the old code also got right',
      );

      const close = recorded.closes.at(0);
      assert.ok(close !== undefined, 'the socket is still closed; a half-joined socket must not linger');

      // Measured before the fix it was 4403, because the catch block closed with a hard-coded
      // `WS_CLOSE.forbidden`.
      const oldCloseCode = WS_CLOSE.forbidden;
      assert.notEqual(
        close.code,
        oldCloseCode,
        'a database blip must not close 4403 — that is the code for "not your table"',
      );
      assert.equal(close.code, WS_CLOSE.serverShuttingDown);

      assert.equal(
        clientRetries('WS_CLOSE.serverShuttingDown'),
        true,
        'the code chosen for a server fault must be one the client reconnects from',
      );
      assert.equal(
        clientRetries('WS_CLOSE.forbidden'),
        false,
        'and 4403 must still be the permanent one, or this test proves nothing about the fix',
      );
    } finally {
      await test.app.close();
    }
  });

  it('still closes a genuine refusal with 4403, blip fixture and all', async () => {
    // Routing every failure to a retryable code would reconnect for ever to a room the caller cannot enter.
    const test = await afterRestart();
    try {
      const recorded = await sayHello(test, STRANGER, 'Mallory');
      assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.forbidden);
      assert.equal(recorded.closes.at(0)?.reason, 'not permitted');
    } finally {
      await test.app.close();
    }
  });

  it('leaves nothing behind: no live table, and the socket is not left half-joined', async () => {
    const test = await afterRestart({ byIdRejectsWith: new Error('connection terminated unexpectedly') });
    try {
      await sayHello(test, MEMBER, 'Bo');
      assert.equal(test.registry.size, 0, 'the read failed, so no table was built');
      assert.equal(test.router.socketsIn(ROOM_ID).length, 0, 'and the socket joined no room');
    } finally {
      await test.app.close();
    }
  });
});
