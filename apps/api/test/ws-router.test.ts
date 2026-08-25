/**
 * The WebSocket protocol, driven directly.
 *
 * ## No socket, no port, no timing
 *
 * `SocketSink` is two methods, so every test here is a recorder object and a manual clock. That
 * buys three things a socket-level test would not: the frames are inspectable as text (which is how
 * the redaction assertion is made), a five-second handshake window is exercised in a microsecond,
 * and there is no flakiness to explain away.
 *
 * The one thing it does not cover is the upgrade itself, so the two refusals that live there —
 * a rejected `Origin` and an unauthenticated cookie — are asserted against `evaluateUpgrade`, the
 * pure function `hub.ts` makes that decision with.
 *
 * ## The validator is the real one
 *
 * `compileFrameValidator` is handed a real Fastify instance built by `buildApp`, so frames are
 * validated by the app's own compiled Ajv against the contract's own `wsClientMessageSchema`. A
 * hand-written stand-in would prove nothing about what the server actually accepts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WS_CLOSE, WS_LIMITS } from '@prl/contracts';
import {
  applyAction,
  createDeterministicRandomForTests,
  createSecureRandom,
  legalActions,
  parseCards,
  redactFor,
  startHand,
} from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { buildHypotheticalState } from '../src/rooms/bots.ts';
import { RoomRegistry } from '../src/rooms/registry.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';
import { compileFrameValidator, evaluateUpgrade } from '../src/ws/hub.ts';
import { coachForView, type SocketSink, WsRouter } from '../src/ws/router.ts';
// Shared with `test/ws-socket.test.ts`, which drives the same protocol over a real socket. Two
// copies of this fake would be two different servers to reason about.
import { seatingOnlyStore } from './helpers/live-room.ts';

/** Readable, sequential hand ids, so a failure names the hand it happened in. */
function incrementingHandIds(): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_ws${count}`;
  };
}

const ALLOWED_ORIGIN = 'http://localhost:3000';

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

/** A schema-carrying route, so Fastify sets up the validator this file borrows. */
const SCHEMA_ROUTE = '/api/v1/test-frame-schema';

async function appWithValidator(): Promise<FastifyInstance> {
  const app = await buildApp({ config: testConfig(), database: stubDatabase });
  app.get(
    SCHEMA_ROUTE,
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async () => ({ ok: true }),
  );
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Recorders and harness
// ---------------------------------------------------------------------------

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
    sink: {
      send: (text) => frames.push(text),
      close: (code, reason) => closes.push({ code, reason }),
    },
  };
}

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

function parsed(recorded: Recorder): readonly Frame[] {
  return recorded.frames.map((text) => {
    const value: unknown = JSON.parse(text);
    assert.ok(typeof value === 'object' && value !== null && 'type' in value);
    return value as Frame;
  });
}

function lastOf(recorded: Recorder, type: string): Frame | null {
  const matching = parsed(recorded).filter((frame) => frame.type === type);
  return matching.at(-1) ?? null;
}

interface Harness {
  readonly app: FastifyInstance;
  readonly router: WsRouter;
  readonly registry: RoomRegistry;
  readonly clock: ManualClock;
  readonly roomId: string;
}

/** A two-seat room with both seats taken, and a router pointed at it. */
async function harness(
  options: { readonly seated?: boolean; readonly units?: number } = {},
): Promise<Harness> {
  const app = await appWithValidator();
  const clock = createManualClock();
  const registry = new RoomRegistry({
    clock,
    random: createSecureRandom(),
    store: seatingOnlyStore(options.units),
    nextHandId: incrementingHandIds(),
  });
  const roomId = 'room_ws1';
  const room = await registry.open({
    record: {
      id: roomId,
      name: 'Socket table',
      ownerUserId: 'usr_a',
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
      startingStack: 1_000,
      createdAt: '2026-08-17T12:00:00.000Z',
      closed: false,
    },
    members: [
      { userId: 'usr_a', displayName: 'Ada', isBot: false, botProfile: null },
      { userId: 'usr_b', displayName: 'Bo', isBot: false, botProfile: null },
    ],
  });
  if (options.seated !== false) {
    await room.table.sit({ userId: 'usr_a', displayName: 'Ada', seat: 0, stack: 1_000 });
    await room.table.sit({ userId: 'usr_b', displayName: 'Bo', seat: 1, stack: 1_000 });
  }
  const router = new WsRouter({
    registry,
    clock,
    validate: compileFrameValidator(app),
    config: app.appConfig,
    nextRequestId: () => 'req-fixed',
  });
  return { app, router, registry, clock, roomId };
}

/** Opens a socket and completes the handshake. */
function connect(
  test: Harness,
  userId: string,
  displayName: string,
): { readonly recorded: Recorder; readonly connection: ReturnType<WsRouter['open']> } {
  const recorded = recorder();
  const connection = test.router.open(recorded.sink, {
    userId,
    displayName,
    sessionId: `ses_${userId}`,
  });
  test.router.handleFrame(
    connection,
    JSON.stringify({
      type: 'hello',
      protocolVersion: 1,
      roomId: test.roomId,
      clientNonce: `nonce-${userId}`,
    }),
  );
  return { recorded, connection };
}

/** Lets the table's queued mutations settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Waits for a frame of `type` to arrive, rather than for a fixed number of macrotask turns.
 *
 * `settle()` is right for everything the router answers synchronously, which was once everything.
 * The Coach is no longer one of those: it is submitted to the worker pool (`workers/pool.ts`), so
 * the reply arrives after a thread has spawned, imported the engine and run a Monte Carlo — tens
 * of milliseconds at best, seconds on a cold thread, and never within six `setImmediate` turns.
 *
 * Polling for the frame rather than sleeping a fixed time is what keeps this honest in both
 * directions: it returns the instant the frame lands, so the suite does not get slower, and it
 * fails with a NAMED timeout rather than a confusing "no frame arrived" if the reply never comes.
 * The deadline is generous because the first analysis in a process pays for the preflop strength
 * table on that thread; a tighter one would be a flake on a loaded machine, which is worse than
 * a slow test.
 */
async function waitForFrame(recorded: Recorder, type: string, timeoutMs = 20_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = lastOf(recorded, type);
    if (frame !== null) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`no "${type}" frame arrived within ${timeoutMs} ms`);
}

// ---------------------------------------------------------------------------
// The upgrade
// ---------------------------------------------------------------------------

describe('the upgrade decision', () => {
  it('refuses an origin that is not allowlisted, and a missing one, with 4406', async () => {
    // `isAllowedOrigin` is configured by the security plugin, so an app has to exist first.
    const app = await appWithValidator();

    const foreign = evaluateUpgrade({
      origin: 'https://evil.example.test',
      userId: 'usr_a',
      socketsForSession: 0,
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.ok === false ? foreign.code : 0, WS_CLOSE.badOrigin);

    // No Origin at all: every browser sends one, so this is a non-browser client and is refused
    // for the same reason. Fail closed.
    const absent = evaluateUpgrade({ origin: null, userId: 'usr_a', socketsForSession: 0 });
    assert.equal(absent.ok, false);
    assert.equal(absent.ok === false ? absent.code : 0, WS_CLOSE.badOrigin);

    const allowed = evaluateUpgrade({ origin: ALLOWED_ORIGIN, userId: 'usr_a', socketsForSession: 0 });
    assert.equal(allowed.ok, true);
    await app.close();
  });

  it('refuses an unauthenticated upgrade with 4401 and a session over its socket cap with 4429', async () => {
    const app = await appWithValidator();

    const anonymous = evaluateUpgrade({ origin: ALLOWED_ORIGIN, userId: null, socketsForSession: 0 });
    assert.equal(anonymous.ok, false);
    assert.equal(anonymous.ok === false ? anonymous.code : 0, WS_CLOSE.unauthenticated);

    const flooding = evaluateUpgrade({
      origin: ALLOWED_ORIGIN,
      userId: 'usr_a',
      socketsForSession: WS_LIMITS.maxSocketsPerSession,
    });
    assert.equal(flooding.ok, false);
    assert.equal(flooding.ok === false ? flooding.code : 0, WS_CLOSE.rateLimited);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

describe('the handshake', () => {
  it('closes 4408 when hello does not arrive in time', async () => {
    const test = await harness();
    const recorded = recorder();
    test.router.open(recorded.sink, { userId: 'usr_a', displayName: 'Ada', sessionId: 'ses_a' });

    test.clock.advance(WS_LIMITS.handshakeTimeoutMs - 1);
    assert.equal(recorded.closes.length, 0, 'the window must not close early');

    test.clock.advance(1);
    assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.handshakeTimeout);
    await test.app.close();
  });

  it('cancels the handshake timer once hello arrives', async () => {
    const test = await harness();
    const { recorded } = connect(test, 'usr_a', 'Ada');
    test.clock.advance(WS_LIMITS.handshakeTimeoutMs * 3);
    assert.equal(recorded.closes.length, 0, 'a socket that said hello must not be timed out');

    const welcome = lastOf(recorded, 'welcome');
    assert.ok(welcome !== null, 'hello is answered with a welcome');
    assert.equal(welcome['userId'], 'usr_a');
    assert.equal(welcome['seat'], 0);
    // Reconnect is exactly this: the welcome is followed by the current view.
    assert.ok(lastOf(recorded, 'state') !== null, 'the welcome is followed by a state frame');
    await test.app.close();
  });

  it('closes 4400 on a protocol version it does not support', async () => {
    const test = await harness();
    const recorded = recorder();
    const connection = test.router.open(recorded.sink, {
      userId: 'usr_a',
      displayName: 'Ada',
      sessionId: 'ses_a',
    });
    test.router.handleFrame(
      connection,
      JSON.stringify({ type: 'hello', protocolVersion: 99, roomId: test.roomId, clientNonce: 'nonce-1234' }),
    );

    const error = lastOf(recorded, 'error');
    assert.ok(error !== null);
    assert.equal((error['error'] as { code: string }).code, 'unsupported_protocol_version');
    assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.protocolMismatch);
    await test.app.close();
  });

  it('closes 4403 for a room the caller is not a member of', async () => {
    const test = await harness();
    const recorded = recorder();
    const connection = test.router.open(recorded.sink, {
      userId: 'usr_stranger',
      displayName: 'Stranger',
      sessionId: 'ses_x',
    });
    test.router.handleFrame(
      connection,
      JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        roomId: test.roomId,
        clientNonce: 'nonce-1234',
      }),
    );

    const error = lastOf(recorded, 'error');
    assert.ok(error !== null);
    assert.equal(
      (error['error'] as { code: string }).code,
      'room_not_found_or_not_permitted',
      'a non-member and a stranger get the same code',
    );
    assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.forbidden);
    await test.app.close();
  });

  it('refuses an intent that arrives before hello', async () => {
    const test = await harness();
    const recorded = recorder();
    const connection = test.router.open(recorded.sink, {
      userId: 'usr_a',
      displayName: 'Ada',
      sessionId: 'ses_a',
    });
    test.router.handleFrame(connection, JSON.stringify({ type: 'startHand', requestId: 'req-12345678' }));

    const error = lastOf(recorded, 'error');
    assert.ok(error !== null);
    assert.equal((error['error'] as { code: string }).code, 'invalid_request');
    assert.equal(recorded.closes.length, 0, 'an early intent is answered, not fatal');
    await test.app.close();
  });
});

// ---------------------------------------------------------------------------
// Membership, after the handshake
// ---------------------------------------------------------------------------

/**
 * `hello` checks membership once. Leaving the room has to reach the socket that check let in.
 *
 * ## The defect
 *
 * `POST /rooms/:roomId/leave` drops the membership durably and in memory, and `registry.require`
 * then refuses a fresh `hello` with `room_not_found_or_not_permitted` — which is what made this
 * look closed. The socket the departed learner already held kept receiving the private table.
 * Measured against the shipped code, over a real socket, after `leaveRoom` for that learner:
 *
 *     ex-member's socket      -> {"type":"event","event":{"kind":"playerJoined",…}}
 *                             -> {"type":"state","room":{…"members":[…]},…}
 *     ex-member's fresh hello -> {"type":"error","error":{"code":"room_not_found_or_not_permitted"}}
 *
 * An invite-only table is invite-only for the duration and not only at the door: those frames
 * carry the roster, the seats, the stacks, and once a hand is dealt the spectator's view of it.
 *
 * ## Both directions
 *
 * The second test is the control that matters more than the first. A router that closed every
 * socket on every broadcast would pass "the ex-member is closed" and destroy the product, so the
 * member who stayed is asserted to still be there, still receiving state, and never closed.
 */
describe('a socket whose membership has ended', () => {
  it('is closed rather than sent another frame from the table it left', async () => {
    const test = await harness({ seated: false });
    const stays = connect(test, 'usr_a', 'Ada');
    const leaves = connect(test, 'usr_b', 'Bo');
    const framesAtDeparture = leaves.recorded.frames.length;

    await test.registry.leaveRoom(test.roomId, 'usr_b');
    // Anything at all that makes the table speak. `sit` is the cheapest.
    test.router.handleFrame(
      stays.connection,
      JSON.stringify({ type: 'sit', seat: 0, requestId: 'req-abcdefgh' }),
    );
    await settle();

    assert.deepEqual(
      leaves.recorded.frames.slice(framesAtDeparture),
      [],
      'a learner who has left the table received another frame from it',
    );
    assert.equal(
      leaves.recorded.closes.at(0)?.code,
      WS_CLOSE.forbidden,
      'the departed socket must be closed 4403, not left attached to the room',
    );
    await test.app.close();
  });

  it('leaves everybody who is still a member exactly where they were', async () => {
    const test = await harness({ seated: false });
    const stays = connect(test, 'usr_a', 'Ada');
    const leaves = connect(test, 'usr_b', 'Bo');
    const framesBefore = stays.recorded.frames.length;

    await test.registry.leaveRoom(test.roomId, 'usr_b');
    test.router.handleFrame(
      stays.connection,
      JSON.stringify({ type: 'sit', seat: 0, requestId: 'req-abcdefgh' }),
    );
    await settle();

    assert.equal(leaves.recorded.closes.length, 1, 'the departure is the thing under test');
    assert.equal(stays.recorded.closes.length, 0, 'a member who stayed was closed');
    assert.ok(stays.recorded.frames.length > framesBefore, 'a member who stayed stopped receiving the table');
    const state = lastOf(stays.recorded, 'state');
    assert.ok(state !== null, 'a member who stayed received no state frame');
    assert.equal((state['room'] as { id: string }).id, test.roomId);
    await test.app.close();
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('frame limits', () => {
  it('drops an oversized frame without parsing it, and closes 4429', async () => {
    const test = await harness();
    const { recorded, connection } = connect(test, 'usr_a', 'Ada');
    const before = recorded.frames.length;

    // Valid JSON, and valid against the schema, so the only thing that can refuse it is the size
    // cap. If the cap were missing this would produce a pong.
    const padded = `${JSON.stringify({ type: 'ping', nonce: 'nonce-1234' })}${' '.repeat(WS_LIMITS.maxMessageBytes)}`;
    test.router.handleFrame(connection, padded);

    assert.equal(recorded.frames.length, before, 'an oversized frame must produce no reply at all');
    assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.rateLimited);
    await test.app.close();
  });

  it('closes 4429 once a socket exceeds its burst allowance', async () => {
    const test = await harness();
    const { recorded, connection } = connect(test, 'usr_a', 'Ada');
    // `hello` already spent one token, so the allowance runs out inside this loop.
    for (let sent = 0; sent < WS_LIMITS.burstAllowance + 1; sent += 1) {
      test.router.handleFrame(connection, JSON.stringify({ type: 'ping', nonce: 'nonce-1234' }));
    }

    assert.equal(recorded.closes.at(0)?.code, WS_CLOSE.rateLimited);
    const pongs = parsed(recorded).filter((frame) => frame.type === 'pong').length;
    assert.ok(
      pongs < WS_LIMITS.burstAllowance + 1,
      `the limiter must have refused at least one frame, answered ${pongs}`,
    );
    await test.app.close();
  });

  it('answers a malformed frame with invalid_request rather than closing', async () => {
    const test = await harness();
    const { recorded, connection } = connect(test, 'usr_a', 'Ada');
    test.router.handleFrame(connection, '{not json');
    test.router.handleFrame(connection, JSON.stringify({ type: 'nonsense' }));
    test.router.handleFrame(connection, JSON.stringify({ type: 'sit', seat: 99, requestId: 'req-12345678' }));

    const errors = parsed(recorded).filter((frame) => frame.type === 'error');
    assert.equal(errors.length, 3);
    for (const error of errors) {
      assert.equal((error['error'] as { code: string }).code, 'invalid_request');
    }
    assert.equal(recorded.closes.length, 0, 'a bad frame is not a fatal one');
    await test.app.close();
  });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The user whose turn it is, from the table itself. */
function actorOf(test: Harness): { readonly userId: string; readonly sequence: number } {
  const room = test.registry.get(test.roomId);
  assert.ok(room !== null);
  const view = room.table.viewFor('usr_a');
  assert.ok(view !== null && view.toAct !== null);
  return { userId: view.toAct === 0 ? 'usr_a' : 'usr_b', sequence: view.actionSequence };
}

describe('submitting an action over a socket', () => {
  it('deduplicates a repeated actionId and applies it once', async () => {
    const test = await harness();
    const alpha = connect(test, 'usr_a', 'Ada');
    const beta = connect(test, 'usr_b', 'Bo');

    test.router.handleFrame(
      alpha.connection,
      JSON.stringify({ type: 'startHand', requestId: 'req-start001' }),
    );
    await settle();

    const actor = actorOf(test);
    const socket = actor.userId === 'usr_a' ? alpha : beta;
    const frame = JSON.stringify({
      type: 'action',
      actionId: 'act-abcdef12',
      expectedSequence: actor.sequence,
      requestId: 'req-action01',
      action: { type: 'call' },
    });

    test.router.handleFrame(socket.connection, frame);
    await settle();
    const firstAck = lastOf(socket.recorded, 'ack');
    assert.ok(firstAck !== null);
    assert.equal(firstAck['deduplicated'], undefined, 'the first application is not a duplicate');
    const appliedSequence = firstAck['appliedSequence'];

    const room = test.registry.get(test.roomId);
    assert.ok(room !== null);
    const afterFirst = JSON.stringify(room.table.viewFor('usr_a'));

    // The retry a dropped response produces: identical frame, identical actionId.
    test.router.handleFrame(socket.connection, frame);
    await settle();
    const secondAck = lastOf(socket.recorded, 'ack');
    assert.ok(secondAck !== null);
    assert.equal(secondAck['deduplicated'], true, 'a repeat must be reported as deduplicated');
    assert.equal(secondAck['appliedSequence'], appliedSequence, 'and must report the original outcome');
    assert.equal(JSON.stringify(room.table.viewFor('usr_a')), afterFirst, 'nothing may be applied twice');
    await test.app.close();
  });

  it('rejects a stale expectedSequence and leaves the hand untouched', async () => {
    const test = await harness();
    const alpha = connect(test, 'usr_a', 'Ada');
    const beta = connect(test, 'usr_b', 'Bo');
    test.router.handleFrame(
      alpha.connection,
      JSON.stringify({ type: 'startHand', requestId: 'req-start002' }),
    );
    await settle();

    const actor = actorOf(test);
    const socket = actor.userId === 'usr_a' ? alpha : beta;
    const room = test.registry.get(test.roomId);
    assert.ok(room !== null);
    const before = JSON.stringify(room.table.viewFor(actor.userId));

    test.router.handleFrame(
      socket.connection,
      JSON.stringify({
        type: 'action',
        actionId: 'act-stale123',
        expectedSequence: actor.sequence + 3,
        requestId: 'req-action02',
        action: { type: 'call' },
      }),
    );
    await settle();

    const error = lastOf(socket.recorded, 'error');
    assert.ok(error !== null);
    assert.equal((error['error'] as { code: string }).code, 'stale_action_sequence');
    assert.equal(JSON.stringify(room.table.viewFor(actor.userId)), before, 'a rejection changes nothing');
    await test.app.close();
  });

  it('tells the seat that is not to act, and says so in the contract’s words', async () => {
    const test = await harness();
    const alpha = connect(test, 'usr_a', 'Ada');
    const beta = connect(test, 'usr_b', 'Bo');
    test.router.handleFrame(
      alpha.connection,
      JSON.stringify({ type: 'startHand', requestId: 'req-start003' }),
    );
    await settle();

    const actor = actorOf(test);
    const waiting = actor.userId === 'usr_a' ? beta : alpha;
    test.router.handleFrame(
      waiting.connection,
      JSON.stringify({
        type: 'action',
        actionId: 'act-turn0001',
        expectedSequence: actor.sequence,
        requestId: 'req-action03',
        action: { type: 'call' },
      }),
    );
    await settle();

    const error = lastOf(waiting.recorded, 'error');
    assert.ok(error !== null);
    assert.equal((error['error'] as { code: string }).code, 'not_your_turn');
    await test.app.close();
  });
});

// ---------------------------------------------------------------------------
// Redaction, per recipient
// ---------------------------------------------------------------------------

describe('per-recipient redaction', () => {
  it('sends two sockets different views, neither carrying the other’s hole cards', async () => {
    const test = await harness();
    const alpha = connect(test, 'usr_a', 'Ada');
    const beta = connect(test, 'usr_b', 'Bo');
    test.router.handleFrame(
      alpha.connection,
      JSON.stringify({ type: 'startHand', requestId: 'req-start004' }),
    );
    await settle();

    const alphaState = lastOf(alpha.recorded, 'state');
    const betaState = lastOf(beta.recorded, 'state');
    assert.ok(alphaState !== null && betaState !== null, 'both sockets must have a state frame');

    const alphaView = alphaState['view'] as {
      viewerSeat: number;
      seats: readonly { seat: number; holeCards: readonly number[] | null }[];
    };
    const betaView = betaState['view'] as typeof alphaView;
    assert.equal(alphaView.viewerSeat, 0);
    assert.equal(betaView.viewerSeat, 1);
    assert.notEqual(
      JSON.stringify(alphaView),
      JSON.stringify(betaView),
      'one shared view object would be identical text',
    );

    const alphaOwn = alphaView.seats.find((seat) => seat.seat === 0)?.holeCards ?? null;
    const betaOwn = betaView.seats.find((seat) => seat.seat === 1)?.holeCards ?? null;
    assert.ok(alphaOwn !== null && betaOwn !== null, 'each seat sees its own cards');
    assert.equal(alphaView.seats.find((seat) => seat.seat === 1)?.holeCards, null);
    assert.equal(betaView.seats.find((seat) => seat.seat === 0)?.holeCards, null);

    // The text-level scan: the exact serialisation of the other seat's own cards must not appear
    // anywhere in this socket's frames — not in a state frame, not in an event, not in an ack.
    const alphaText = alpha.recorded.frames.join('\n');
    const betaText = beta.recorded.frames.join('\n');
    assert.ok(!alphaText.includes(JSON.stringify(betaOwn)), 'seat 0 received seat 1’s hole cards in a frame');
    assert.ok(!betaText.includes(JSON.stringify(alphaOwn)), 'seat 1 received seat 0’s hole cards in a frame');
    for (const text of [alphaText, betaText]) {
      assert.ok(!text.includes('"deck"'), 'a frame must never carry a deck');
      assert.ok(!text.includes('deckSalt'), 'a frame must never carry a commitment salt');
      assert.ok(!text.includes('deckCursor'), 'a frame must never carry the deck cursor');
    }
    await test.app.close();
  });

  it('gives a reconnecting socket the current view with no catch-up protocol', async () => {
    const test = await harness();
    const alpha = connect(test, 'usr_a', 'Ada');
    test.router.handleFrame(
      alpha.connection,
      JSON.stringify({ type: 'startHand', requestId: 'req-start005' }),
    );
    await settle();
    const room = test.registry.get(test.roomId);
    assert.ok(room !== null);
    const handId = room.table.handId;

    // The socket drops and comes back. Nothing is replayed and nothing is requested.
    test.router.handleClose(alpha.connection);
    const again = connect(test, 'usr_a', 'Ada');
    const state = lastOf(again.recorded, 'state');
    assert.ok(state !== null);
    const view = state['view'] as { handId: string; seats: readonly { holeCards: unknown }[] };
    assert.equal(view.handId, handId, 'the reconnect carries the hand in progress');
    assert.equal(state['revision'], 1, 'revision is per socket, so a fresh socket starts again');
    await test.app.close();
  });
});

// ---------------------------------------------------------------------------
// The Coach over a socket
// ---------------------------------------------------------------------------

describe('coachForView', () => {
  it('builds a report from a seat’s own view, with its assumptions stated', () => {
    // A hypothetical river spot, so the equity is an exact enumeration and this test is fast.
    const state = buildHypotheticalState({
      heroCards: parseCards('AhKh'),
      board: parseCards('Qh7h2c9s3d'),
      street: 'river',
      pot: 200,
      toCall: 100,
      heroStack: 900,
      opponentStack: 900,
      bigBlind: 10,
    });
    const view = redactFor(state, { viewerSeat: 0 });
    const report = coachForView(view, { samples: 200 });

    assert.equal(report.street, 'river');
    assert.equal(report.toCall, 100);
    assert.ok(report.assumptions.length >= 1, 'a number without its assumptions is a guess');
    assert.ok(report.uncertainty.limitations.length >= 1, 'the limitations are never empty');
    assert.ok(report.candidates.length >= 2, 'every legal action gets a candidate');
  });

  it('refuses to analyse for a spectator, who holds no cards', () => {
    const state = buildHypotheticalState({
      heroCards: parseCards('AhKh'),
      board: parseCards('Qh7h2c9s3d'),
      street: 'river',
      pot: 200,
      toCall: 100,
      heroStack: 900,
      opponentStack: 900,
      bigBlind: 10,
    });
    const spectator = redactFor(state, { viewerSeat: null });
    assert.throws(
      () => coachForView(spectator, { samples: 200 }),
      (error: unknown) => error instanceof AppError && error.code === 'not_seated',
    );
  });

  /**
   * Three seats, blinds 5 and 10. Seat 0 folds and seat 1 shoves its 40, leaving seat 2
   * with 990 behind facing 30 to call and nobody who could answer a raise. The engine
   * offers `fold, call`; the Coach used to publish three raises here and recommend
   * "raise to 80-100" as its highest-EV line, because affordability was the only thing
   * it could see.
   */
  function everyOpponentAllIn(): ReturnType<typeof startHand>['state'] {
    let state = startHand({
      handId: 'hand_allin',
      roomId: 'room_allin',
      handNumber: 1,
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 3, actionTimeoutSeconds: 30 },
      buttonSeat: 0,
      seats: [
        { seat: 0, playerId: 'p0', stack: 1_000 },
        { seat: 1, playerId: 'p1', stack: 40 },
        { seat: 2, playerId: 'p2', stack: 1_000 },
      ],
      random: createDeterministicRandomForTests(11),
    }).state;
    state = applyAction(state, 0, { type: 'fold' }).state;
    return applyAction(state, 1, { type: 'raise', to: 40 }).state;
  }

  it('never publishes an action the engine withholds from this seat', () => {
    const state = everyOpponentAllIn();
    const offered = legalActions(state, 2).map((entry) => entry.type);
    assert.deepEqual([...offered].sort(), ['call', 'fold'], 'the engine offers no aggression here');

    const view = redactFor(state, { viewerSeat: 2 });
    const report = coachForView(view, { samples: 400 });

    // Hero can plainly afford a raise; that was the whole of the old guard.
    const own = view.seats.find((seat) => seat.isSelf);
    assert.ok((own?.stack ?? 0) - view.amountToCall > 900, 'hero has chips behind');

    for (const candidate of report.candidates) {
      assert.ok(
        offered.includes(candidate.action),
        `the Coach published ${candidate.action}, which the engine refuses`,
      );
    }
    assert.ok(
      offered.includes(report.suggestion.action),
      `the Coach suggested ${report.suggestion.action}, which the engine refuses`,
    );
  });

  it('refuses a report for a seat that is not to act, because every action would be rejected', () => {
    // `redactFor` fills `legalActions` only for the seat that is to act, so a request from
    // any other seat carries an empty list — and an empty list means there is no decision,
    // not that every action is available.
    const state = everyOpponentAllIn();
    const bystander = redactFor(state, { viewerSeat: 1 });
    assert.deepEqual([...bystander.legalActions], [], 'the seat that is not to act is offered nothing');
    assert.throws(
      () => coachForView(bystander, { samples: 200 }),
      (error: unknown) => error instanceof AppError && error.code === 'hand_not_active',
    );
  });
});

describe('live Coach follows the match difficulty', () => {
  async function withBot(
    difficulty: 'educational' | 'expert',
  ): Promise<{ test: Harness; recorded: Recorder; connection: ReturnType<WsRouter['open']> }> {
    const test = await harness({ seated: false });
    const room = test.registry.get(test.roomId);
    assert.ok(room !== null);
    await room.table.sit({ userId: 'usr_a', displayName: 'Ada', seat: 0, stack: 1_000 });
    await test.registry.seatBot(test.roomId, {
      userId: 'usr_bot',
      displayName: 'Legend',
      seat: 1,
      profileId: 'adaptive-exploiter',
      difficulty,
      seed: 1,
    });
    const { recorded, connection } = connect(test, 'usr_a', 'Ada');
    return { test, recorded, connection };
  }

  it('still answers at a table with no Expert bot', async () => {
    const test = await harness();
    const alpha = connect(test, 'usr_a', 'Ada');
    const beta = connect(test, 'usr_b', 'Bo');
    test.router.handleFrame(
      alpha.connection,
      JSON.stringify({ type: 'startHand', requestId: 'req-start-ed' }),
    );
    await settle();
    const alphaView = lastOf(alpha.recorded, 'state')?.['view'] as
      | { toAct: number | null; viewerSeat: number | null }
      | undefined;
    const actor = alphaView?.toAct === alphaView?.viewerSeat ? alpha : beta;
    test.router.handleFrame(
      actor.connection,
      JSON.stringify({ type: 'requestCoach', requestId: 'req-coach-ed' }),
    );
    // Not `settle()`: the Coach now runs on a worker thread, so the reply cannot arrive within a
    // fixed number of macrotask turns. See `waitForFrame`.
    const coach = await waitForFrame(actor.recorded, 'coach');
    assert.ok(coach !== null, 'a table without an Expert bot must still receive a Coach report');
    await test.app.close();
  });

  it('refuses on expert, where the chip says Coach in review only', async () => {
    const { test, recorded, connection } = await withBot('expert');
    assert.equal(test.registry.get(test.roomId)?.bots.coachDuringHand(), false);
    test.router.handleFrame(connection, JSON.stringify({ type: 'startHand', requestId: 'req-start-ex' }));
    await settle();
    test.router.handleFrame(connection, JSON.stringify({ type: 'requestCoach', requestId: 'req-coach-ex' }));
    await settle();
    assert.equal(lastOf(recorded, 'coach'), null, 'expert must not receive a live report');
    const error = lastOf(recorded, 'error');
    assert.ok(error !== null);
    assert.equal((error['error'] as { code: string }).code, 'coach_not_available');
    await test.app.close();
  });
});
