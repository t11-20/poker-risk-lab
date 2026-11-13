/**
 * `coachRequestsPerMinute` is per session. The window used to live on each socket, and a session
 * may hold `maxSocketsPerSession` (4), so one session put 4 x 30 analyses a minute on the shared
 * worker pool. Measured against the old code, 144 were accepted and 0 refused. Now 30 and 114.
 * The window also outlives its last socket by one window, so reconnecting does not reset it.
 * No hand is dealt. `onCoach` spends a token before reading a view, so `hand_not_active` means
 * accepted and `rate_limited` means refused, with no Monte Carlo.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WS_LIMITS } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { RoomRegistry } from '../src/rooms/registry.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';
import { compileFrameValidator } from '../src/ws/hub.ts';
import { type SocketSink, WsRouter } from '../src/ws/router.ts';
import { seatingOnlyStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const ROOM_ID = 'room_coachlimit';
const USER = 'usr_a';
const SESSION = 'ses_shared';

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

interface Harness {
  readonly app: FastifyInstance;
  readonly router: WsRouter;
  readonly registry: RoomRegistry;
  readonly clock: ManualClock;
}

async function harness(): Promise<Harness> {
  const app = await appWithValidator();
  const clock = createManualClock();
  const registry = new RoomRegistry({ clock, random: createSecureRandom(), store: seatingOnlyStore() });
  await registry.open({
    record: {
      id: ROOM_ID,
      name: 'Coach limit table',
      ownerUserId: USER,
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
      startingStack: 1_000,
      createdAt: '2026-08-17T12:00:00.000Z',
      closed: false,
    },
    members: [{ userId: USER, displayName: 'Ada', isBot: false, botProfile: null }],
  });
  const router = new WsRouter({
    registry,
    clock,
    validate: compileFrameValidator(app),
    config: app.appConfig,
    nextRequestId: () => 'req-fixed',
  });
  return { app, router, registry, clock };
}

interface Socket {
  readonly recorded: Recorder;
  readonly connection: ReturnType<WsRouter['open']>;
}

/**
 * Asserts `welcome`, because a too-short `clientNonce` once failed every `hello` quietly and the
 * file measured a limiter it never reached.
 */
function connect(test: Harness, sessionId: string, label: string): Socket {
  const recorded = recorder();
  const connection = test.router.open(recorded.sink, {
    userId: USER,
    displayName: 'Ada',
    sessionId,
  });
  test.router.handleFrame(
    connection,
    JSON.stringify({ type: 'hello', protocolVersion: 1, roomId: ROOM_ID, clientNonce: label }),
  );
  assert.ok(
    recorded.frames.some((text) => text.includes('"type":"welcome"')),
    `the handshake for ${label} did not produce a welcome: ${recorded.frames.join(' ')}`,
  );
  return { recorded, connection };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** `hand_not_active` means the token was spent. */
function errorCodes(recorded: Recorder): readonly string[] {
  const codes: string[] = [];
  for (const text of recorded.frames) {
    const frame: { type?: unknown; error?: { code?: unknown } } = JSON.parse(text);
    if (frame.type === 'error') codes.push(String(frame.error?.code));
  }
  return codes;
}

function countOf(codes: readonly string[], code: string): number {
  return codes.filter((entry) => entry === code).length;
}

/**
 * Under the per-socket bucket (`burstAllowance` 40, clock never advanced), so `hello` plus 36 is
 * never closed for flooding and the other limiter never answers.
 */
const PER_SOCKET_REQUESTS = 36;

function requestCoach(test: Harness, socket: Socket, index: number): void {
  test.router.handleFrame(
    socket.connection,
    JSON.stringify({ type: 'requestCoach', requestId: `req-coach-${index}` }),
  );
}

describe('the Coach limit is spent by the session, not by each socket', () => {
  it('gives one session 30 analyses across four sockets, not 30 on each', async () => {
    const test = await harness();
    try {
      const sockets = [0, 1, 2, 3].map((index) => connect(test, SESSION, `nonce-socket-${index}`));
      await settle();
      for (const socket of sockets) {
        assert.deepEqual(socket.recorded.closes, [], 'all four sockets must be open before we start');
      }

      for (let index = 0; index < PER_SOCKET_REQUESTS * sockets.length; index += 1) {
        const socket = sockets[index % sockets.length];
        assert.ok(socket !== undefined);
        requestCoach(test, socket, index);
      }
      await settle();

      const codes = sockets.flatMap((socket) => errorCodes(socket.recorded));
      const accepted = countOf(codes, 'hand_not_active');
      const refused = countOf(codes, 'rate_limited');
      assert.equal(accepted + refused, PER_SOCKET_REQUESTS * sockets.length, `unexpected: ${codes}`);

      // The old ceiling was the limit times the sockets a session may hold.
      const perSocketCeiling = WS_LIMITS.coachRequestsPerMinute * WS_LIMITS.maxSocketsPerSession;
      assert.notEqual(
        accepted,
        perSocketCeiling,
        'the session was allowed the per-socket ceiling; the window is still on the connection',
      );
      assert.equal(
        accepted,
        WS_LIMITS.coachRequestsPerMinute,
        'a session gets exactly its published budget, however many sockets it spreads it over',
      );
      assert.equal(refused, PER_SOCKET_REQUESTS * sockets.length - WS_LIMITS.coachRequestsPerMinute);

      // Refusals must reach more than one socket, or this is a per-socket limit in disguise.
      const socketsThatSawARefusal = sockets.filter((socket) =>
        errorCodes(socket.recorded).includes('rate_limited'),
      ).length;
      assert.equal(socketsThatSawARefusal, sockets.length, 'every socket shares the one budget');
    } finally {
      await test.app.close();
    }
  });

  it('still refuses a single socket at 30, which is the control for the count itself', async () => {
    const test = await harness();
    try {
      const socket = connect(test, 'ses_alone', 'nonce-alone');
      await settle();
      for (let index = 0; index < PER_SOCKET_REQUESTS; index += 1) requestCoach(test, socket, index);
      await settle();

      const codes = errorCodes(socket.recorded);
      assert.equal(countOf(codes, 'hand_not_active'), WS_LIMITS.coachRequestsPerMinute);
      assert.equal(countOf(codes, 'rate_limited'), PER_SOCKET_REQUESTS - WS_LIMITS.coachRequestsPerMinute);
      assert.deepEqual(socket.recorded.closes, [], 'the frame bucket must not be what refused these');
    } finally {
      await test.app.close();
    }
  });

  it('keeps each session in its own budget, so one caller cannot spend another’s', async () => {
    // A window keyed too coarsely would let one learner exhaust the Coach for everybody.
    const test = await harness();
    try {
      const first = connect(test, 'ses_one', 'nonce-one');
      const second = connect(test, 'ses_two', 'nonce-two');
      await settle();
      for (let index = 0; index < PER_SOCKET_REQUESTS; index += 1) requestCoach(test, first, index);
      await settle();
      assert.equal(countOf(errorCodes(first.recorded), 'rate_limited'), 6, 'the first session is over');

      requestCoach(test, second, 999);
      await settle();
      assert.deepEqual(
        errorCodes(second.recorded),
        ['hand_not_active'],
        'a second session must have its own untouched window',
      );
    } finally {
      await test.app.close();
    }
  });
});

describe('the Coach window survives a reconnect, and then goes away', () => {
  it('does not hand a session a fresh budget for closing its socket and opening another', async () => {
    // Reconnecting costs one upgrade, bounded only by the global HTTP limiter.
    const test = await harness();
    try {
      const first = connect(test, SESSION, 'nonce-first-socket');
      await settle();
      for (let index = 0; index < WS_LIMITS.coachRequestsPerMinute; index += 1) {
        requestCoach(test, first, index);
      }
      await settle();
      assert.equal(
        countOf(errorCodes(first.recorded), 'hand_not_active'),
        WS_LIMITS.coachRequestsPerMinute,
        'the budget is spent exactly, with nothing refused yet',
      );

      test.router.handleClose(first.connection);
      const second = connect(test, SESSION, 'nonce-second-socket');
      await settle();
      requestCoach(test, second, 100);
      await settle();

      // A draft that deleted the entry on the last close gave a fresh budget here.
      assert.deepEqual(
        errorCodes(second.recorded),
        ['rate_limited'],
        'the window belongs to the session and a new socket inherits what is left of it',
      );
    } finally {
      await test.app.close();
    }
  });

  it('forgets a session one window after its last socket, and forgets an unused one at once', async () => {
    // A guest session costs one `POST /auth/guest`, so entries must be removed.
    const test = await harness();
    try {
      assert.equal(test.router.sessionsTracked(), 0, 'a fresh router holds nothing');

      const quiet = connect(test, 'ses_quiet', 'nonce-quiet-socket');
      await settle();
      assert.equal(test.router.sessionsTracked(), 1);
      test.router.handleClose(quiet.connection);
      assert.equal(test.router.sessionsTracked(), 0, 'no window to keep, so no entry to keep');

      const spender = connect(test, 'ses_spender', 'nonce-spender-socket');
      await settle();
      requestCoach(test, spender, 0);
      await settle();
      test.router.handleClose(spender.connection);
      assert.equal(
        test.router.sessionsTracked(),
        1,
        'the window outlives the socket, which is the previous test',
      );

      test.clock.advance(60_000);
      assert.equal(
        test.router.sessionsTracked(),
        0,
        'a session with no sockets and an expired window is dropped',
      );
    } finally {
      await test.app.close();
    }
  });

  it('cancels the pending deletion when a socket comes back inside the window', async () => {
    // Without the cancel in `open`, the first close's timer would delete a window still in force.
    const test = await harness();
    try {
      const first = connect(test, SESSION, 'nonce-socket-a');
      await settle();
      for (let index = 0; index < WS_LIMITS.coachRequestsPerMinute; index += 1) {
        requestCoach(test, first, index);
      }
      await settle();
      test.router.handleClose(first.connection);

      const second = connect(test, SESSION, 'nonce-socket-b');
      await settle();
      // 60_000 also expires the timestamps, so only the entry's survival is asserted.
      test.clock.advance(60_000);
      assert.equal(
        test.router.sessionsTracked(),
        1,
        'a session with a live socket must never be swept, whatever timer was armed before it',
      );

      test.router.handleClose(second.connection);
      test.clock.advance(60_000);
      assert.equal(test.router.sessionsTracked(), 0, 'and it is still swept once nothing holds it');
    } finally {
      await test.app.close();
    }
  });
});
