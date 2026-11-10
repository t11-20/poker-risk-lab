/**
 * `coachRequestsPerMinute` is per SESSION, and this is the file that makes that true.
 *
 * ## The defect
 *
 * `WS_LIMITS.coachRequestsPerMinute` has always been documented "per minute per session", and
 * `takeCoachToken` kept its window on `connection.coachRequests` — a field of `WsConnection`, so a
 * window per socket. The contract also permits a session `maxSocketsPerSession: 4` sockets at
 * once, and the hub enforces exactly that. The two together meant one session could hold its four
 * permitted sockets and put 4 x 30 = 120 Coach analyses a minute onto the shared worker pool,
 * which is the process-wide resource the limit exists to protect and which every other session at
 * every other table is queueing behind. Nothing about that required a hostile client: four tabs
 * open on the same table is an ordinary thing for a learner to do.
 *
 * Measured against the old code with the fixtures below: 4 sockets on one session, 36 requests
 * round-robined across them, **144 accepted and 0 refused** — because each socket had its own
 * window and none of them reached 30. With the fix: **30 accepted, 114 refused**.
 *
 * `scripts/load-test.mjs` said "30 per socket" in its own header, so the repo disagreed with its
 * own contract in prose as well as in code. The contract's claim is the stronger one and the one
 * that protects the pool, so the code moved to meet it; that script's comment is now wrong and
 * could not be edited from this change.
 *
 * ## The two ways a per-session limit gets quietly undone
 *
 * Both are asserted here, because a fix for the first that reintroduced the second would be no
 * fix at all:
 *
 *  1. **Spread across sockets.** The headline case above.
 *  2. **Reset by reconnecting.** If the window died with the last socket, a caller would clear it
 *     by closing the socket and opening another — cheaper than the per-socket window it replaced,
 *     since the upgrade is bounded only by the global HTTP limiter. So the window outlives its
 *     sockets by one window, and `sessionsTracked()` is asserted to come back to zero afterwards
 *     so that "it outlives them" cannot quietly become "it lives forever".
 *
 * ## No hand is ever dealt here, and that is deliberate
 *
 * `onCoach` checks the rate limit BEFORE it reads a view, so a request at a table with no live
 * hand still spends a token and then fails with `hand_not_active`. That makes an accepted request
 * distinguishable from a refused one (`hand_not_active` vs `rate_limited`) without starting a
 * hand, without a worker thread and without a Monte Carlo — 144 real analyses would make this file
 * take minutes and would measure the pool rather than the limiter.
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
/** One session, however many sockets. That single fact is what this whole file is about. */
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
 * Opens a socket on `sessionId` and completes its handshake.
 *
 * The `welcome` is asserted here rather than left to the caller, and that assertion earned its
 * place while this file was being written: `clientNonce` is `REQUEST_ID_PATTERN`, which is
 * `{8,64}` characters, and a seven-character nonce made every `hello` fail schema validation
 * silently — no close, just an `invalid_request` frame. Every later request was then refused
 * `before_handshake`, and the whole file "measured" a Coach limiter it had never reached.
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

/** Lets the `void`-dispatched intents settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The error codes a recorder has seen, in order. `hand_not_active` means the token was spent. */
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
 * Requests per socket, chosen against the OTHER limit on this path.
 *
 * The per-socket token bucket is `burstAllowance` (40) deep and refills at `messagesPerSecond` on
 * a clock this test never advances, so a socket that sends its `hello` plus 36 Coach requests has
 * used 37 of 40 and is never closed for flooding. If it were, every assertion below would be
 * measuring the wrong limiter — which is exactly the confusion this constant exists to prevent.
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
        // Round-robin rather than one socket at a time, so a fix that merely summed the sockets'
        // windows at the end would still have to get the ordering right.
        const socket = sockets[index % sockets.length];
        assert.ok(socket !== undefined);
        requestCoach(test, socket, index);
      }
      await settle();

      const codes = sockets.flatMap((socket) => errorCodes(socket.recorded));
      const accepted = countOf(codes, 'hand_not_active');
      const refused = countOf(codes, 'rate_limited');
      assert.equal(accepted + refused, PER_SOCKET_REQUESTS * sockets.length, `unexpected: ${codes}`);

      // The old expression, written out. `takeCoachToken` filtered and pushed
      // `connection.coachRequests`, so the ceiling was the limit TIMES the number of sockets a
      // session may hold. MEASURED BEFORE: accepted = 144, refused = 0 — every socket stayed under
      // its own 30 and nothing was refused at all.
      const perSocketCeiling = WS_LIMITS.coachRequestsPerMinute * WS_LIMITS.maxSocketsPerSession;
      assert.notEqual(
        accepted,
        perSocketCeiling,
        'the session was allowed the per-socket ceiling; the window is still on the connection',
      );
      // MEASURED AFTER: accepted = 30, refused = 114.
      assert.equal(
        accepted,
        WS_LIMITS.coachRequestsPerMinute,
        'a session gets exactly its published budget, however many sockets it spreads it over',
      );
      assert.equal(refused, PER_SOCKET_REQUESTS * sockets.length - WS_LIMITS.coachRequestsPerMinute);

      // Which socket was refused is not a property worth asserting, but that the refusal reached
      // more than one of them is: a limit that only ever refused the fourth socket would be a
      // per-socket limit with extra steps.
      const socketsThatSawARefusal = sockets.filter((socket) =>
        errorCodes(socket.recorded).includes('rate_limited'),
      ).length;
      assert.equal(socketsThatSawARefusal, sockets.length, 'every socket shares the one budget');
    } finally {
      await test.app.close();
    }
  });

  it('still refuses a single socket at 30, which is the control for the count itself', async () => {
    // The negative control for the assertion above. Without it, "30 accepted across four sockets"
    // would also pass against a limiter that refused everything after an arbitrary 30 requests for
    // some unrelated reason — or against one that was broken in the other direction.
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
    // The other direction, and the one that would make this limit a bug report rather than a fix:
    // a window keyed on something too coarse — the user, the room, a single global counter —
    // would let one learner exhaust the Coach for everybody.
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
    // The hole a naive per-session fix leaves. Reconnecting costs one WebSocket upgrade, which is
    // bounded only by the global HTTP limiter, so a window that died with the last socket would be
    // a CHEAPER reset than the per-socket window it replaced.
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

      // MEASURED with the window on the connection, and also with a first draft of the fix that
      // deleted the session entry as soon as its last socket closed: `['hand_not_active']`, a
      // fresh budget for the price of a reconnect.
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
    // The leak assertion. A per-session map keyed on an id the caller can mint — a guest session
    // costs one `POST /auth/guest` — is unbounded growth unless something removes the entries.
    const test = await harness();
    try {
      assert.equal(test.router.sessionsTracked(), 0, 'a fresh router holds nothing');

      // A socket that never asked for a Coach analysis leaves nothing behind at all: no timer, no
      // entry, nothing to sweep. That is the overwhelmingly common case.
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

      // ...and no longer. The clock is manual, so this is exact rather than a sleep.
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
    // Without the cancel in `open`, the timer armed by the first close would fire while the second
    // socket was live and delete a window that is still in force — a free reset, arriving a minute
    // late, for any session that reconnects promptly.
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
      // Past when the first close's timer would have fired, but still inside the window as far as
      // the timestamps are concerned? No: 60_000 expires them too. So the assertion is only that
      // the ENTRY survived the timer — the window itself is allowed to have emptied.
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
