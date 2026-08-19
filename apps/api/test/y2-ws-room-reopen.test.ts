/**
 * An API restart must not strand an open table, and reopening one must not tell a stranger it
 * exists.
 *
 * ## The defect
 *
 * Room state is in memory by design (ADR 0009): the `prl.rooms` row and its roster are durable,
 * the `LiveRoom` is not. The REST path has always known that — `openRoomFor` in
 * `routes/rooms.ts` calls `registry.ensureOpen` before `registry.require` — but the socket's
 * `hello` handler called `registry.require` alone. So the first `hello` after a restart found an
 * empty registry, threw `room_not_found_or_not_permitted`, and the client showed a member of their
 * own table:
 *
 *   > **Not your table.** The server refused this room: either it does not exist or this session
 *   > is not a member of it. Rooms here are invite-only, so there is no list to browse — start
 *   > your own table instead.
 *
 * Every word of which was false. Reopening from the database was already implemented, already
 * tested, and already used by the other transport; the socket simply did not call it.
 *
 * ## Why the refusal half is tested just as hard
 *
 * Fixing a refusal that fires too often is one keystroke away from removing a refusal that has to
 * fire. A room that genuinely is not yours must still be refused, must still be refused with the
 * one code that does not distinguish "no such room" from "not yours", and — the part a naive fix
 * loses — must still be refused *before* this process builds a table for the caller. Opening first
 * and checking afterwards would let anybody who guessed a room id make the server construct a
 * `HandState`, a turn timer and a bot runner on their behalf. `registry.size` is how that is
 * asserted here: it is the count of live tables, and a refused stranger must leave it at zero.
 *
 * ## No socket, no port, no timing
 *
 * `SocketSink` is two methods and the clock is manual, exactly as in `test/ws-router.test.ts`. The
 * store is local to this file rather than borrowed from `test/helpers/live-room.ts`: that fake
 * answers `byId` with null, which is precisely the "this process has never seen the room" case, so
 * a fake that can also produce a durable row is what this file needs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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

/** A schema-carrying route, so Fastify compiles the Ajv instance the frame validator borrows. */
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
  /** Every call that reached the durable rows, in order. Proves what ran before what. */
  readonly calls: string[];
}

/**
 * The durable half of a room that outlived the process that was serving it.
 *
 * `status` is a parameter because a closed room and an open one have to be told apart by the code
 * under test rather than by this fake: a closed room's row still exists and still lists its
 * members, and reopening one would resurrect a table somebody deliberately ended.
 */
function persistedStore(reads: Reads, options: { readonly status?: RoomRow['status'] } = {}): RoomStore {
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
    seatMember: () => Promise.resolve(),
    unseatMember: () => Promise.resolve(),
    removeMember: () => Promise.resolve(),
    close: () => Promise.resolve(true),
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

/**
 * A process that has just started: durable rows, and an empty registry.
 *
 * Nothing here calls `registry.open`. That absence IS the restart — it is the whole of what a
 * restart does to this server — and it is why no fixture needs to kill anything.
 */
async function afterRestart(options: { readonly status?: RoomRow['status'] } = {}): Promise<Restarted> {
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
    nextRequestId: () => 'req-fixed',
  });
  return { app, router, registry, clock, reads };
}

/** Sends `hello` and lets the database reads the handler now makes settle. */
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
  // `onHello` is dispatched with `void` and now awaits the store, so the assertions have to wait
  // for the same turns of the loop the handler does.
  for (let turn = 0; turn < 8; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return recorded;
}

// ---------------------------------------------------------------------------
// The table that survives
// ---------------------------------------------------------------------------

describe('a socket reopens a room this process has never seen', () => {
  it('welcomes a member back to their own table after a restart', async () => {
    const test = await afterRestart();
    try {
      const recorded = await sayHello(test, MEMBER, 'Bo');

      // Before the fix this was an `error` frame carrying `room_not_found_or_not_permitted`,
      // followed by a 4403 close — "Not your table" — for a table that was theirs.
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
      // The roster is rebuilt from the durable rows, so the seat the database records is the seat
      // the learner comes back to rather than an empty table with their name missing.
      assert.equal(welcome['seat'], 1, 'the recorded seat is re-taken, not lost with the process');
      assert.ok(firstOf(recorded, 'state') !== null, 'the welcome is followed by the current view');

      assert.equal(test.registry.size, 1, 'the room is live again in this process');
    } finally {
      await test.app.close();
    }
  });

  it('welcomes the owner too, who has no membership row to be found by id', async () => {
    // `memberOf` is the check that passes for a member; an owner is covered by the row's
    // `owner_user_id`. Both are in the store here, so this is really asserting the owner path is
    // not accidentally the only one that works — or the only one that does not.
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

// ---------------------------------------------------------------------------
// The refusal that has to survive the fix
// ---------------------------------------------------------------------------

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

      // The same answer, byte for byte, as a room id that was never real. A refusal a stranger can
      // tell apart from "no such room" is a free way to confirm somebody else's room id.
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
    // The order of the two checks is the security property: membership is read from the durable
    // rows BEFORE anything is opened. Opening first would be shorter and would let anybody who
    // guessed a room id make this process build a `HandState`, a turn timer and a bot runner
    // before being told no.
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
    // `roomId` is set after the store read, so two `hello` frames delivered in one tick both used
    // to pass the "already in a room?" guard, both join, and `noteSocket` ends one increment over
    // — a member who has closed their tab still showing as connected at the table, permanently.
    // `connection.joining` is set synchronously, before anything can suspend.
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

      // `sockets` is what `RoomMember.connected` is derived from, so it is the observable
      // consequence of a double `noteSocket`: closing the one socket must leave the count at zero,
      // not at one. A stuck count is a member who has closed their tab and still shows as here.
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
