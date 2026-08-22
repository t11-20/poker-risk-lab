/**
 * The telemetry the live-table stack emits: hand lifecycle, socket lifecycle, and typed problems.
 *
 * ## Why this file exists
 *
 * Everything asserted here used to be invisible. Hands were dealt and settled with nothing
 * counting either; a failed archive write was one sentence in a log; a bot that could not decide
 * and a hand a restart interrupted arrived as prose through the same hook as a subscriber that
 * threw, so no alert could tell them apart. The instrumentation that fixed that is only worth
 * anything if it actually moves, and a counter that never moves is indistinguishable from a
 * healthy service — which is precisely why it needs a test rather than a reading.
 *
 * ## What is faked and what is real
 *
 * The archive and the room store are ports and are faked (`test/helpers/live-room.ts`), so no
 * database is involved. Everything else is production code: a real `LiveTable` dealing a real hand
 * with a real deck, the real `WsRouter` validating frames through the app's own compiled Ajv, and
 * the real `createWsHub` accepting real sockets over loopback.
 *
 * Each case constructs its own `AppMetrics` and passes it in, rather than using the process-wide
 * one. That is what makes the exact counts below assertable at all: `node --test` runs these files
 * in one process, and a shared registry would accumulate across cases and across files.
 *
 * ## Would these fail if the behaviour broke?
 *
 * - `plays a hand and counts it once at each end` asserts exact counts, so an increment moved into
 *   a path that runs per notice rather than per hand fails on the second assertion, not on the
 *   first. `settleIfComplete` returning true twice — the double-count this codebase already
 *   defends against elsewhere — shows up here as `handsCompleted` of 2.
 * - `counts an archive write that failed` waits for the archive chain to reject before asserting,
 *   so it cannot pass by racing ahead of the counter.
 * - `records every rejection reason from the closed set` uses a fresh router and connection per
 *   reason and asserts the OTHER reasons stayed at zero, so a rejection recorded under the wrong
 *   label fails rather than merely being counted somewhere.
 * - `the problem vocabulary` scans the real source for every `event:` a problem hook is given,
 *   asserts the scan found more than a dozen, asserts the set matches `PROBLEM_EVENTS` in BOTH
 *   directions, and has a negative control that feeds the extractor an invented event and asserts
 *   it is reported as unknown.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_PATHS, WS_CLOSE, WS_LIMITS, WS_PROTOCOL_VERSION } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp, registerRoutes } from '../src/app.ts';
import { type AppConfig, type EnvRecord, loadConfig } from '../src/config.ts';
import type { DatabaseHandle } from '../src/db.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import {
  classifyProblem,
  PROBLEM_EVENTS,
  type ProblemEvent,
  recordProblem,
} from '../src/observability/telemetry.ts';
import { sessionCookieName } from '../src/plugins/security.ts';
import {
  type HandArchive,
  type LiveRoom,
  noopArchive,
  type RoomRecord,
  RoomRegistry,
} from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { closeCodeLabel, compileFrameValidator, createWsHub } from '../src/ws/hub.ts';
import { type SocketSink, type WsConnection, WsRouter } from '../src/ws/router.ts';
import { accountFor, fixedSessionStore, seatingOnlyStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Long enough for a loopback handshake, short enough to fail rather than hang. */
const SOCKET_DEADLINE_MS = 10_000;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    // Nothing here connects: `buildApp` gets a stub handle and the registry gets a fake store.
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    // The assertions are all about counters; the access log for a dozen sockets would bury a
    // failure message in the output.
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

/** Readable, sequential hand ids, so a failure names the hand it happened in. */
function incrementingHandIds(prefix: string): () => string {
  let count = 0;
  return () => {
    count += 1;
    return `hand_${prefix}${count}`;
  };
}

function recordFor(roomId: string): RoomRecord {
  return {
    id: roomId,
    name: 'Telemetry table',
    ownerUserId: 'usr_a',
    config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 30 },
    startingStack: 1_000,
    createdAt: '2026-08-17T12:00:00.000Z',
    closed: false,
  };
}

interface RoomFixture {
  readonly registry: RoomRegistry;
  readonly room: LiveRoom;
  readonly metrics: AppMetrics;
}

/**
 * A registry on its own metrics, holding one open heads-up room.
 *
 * The clock is manual so nothing here depends on wall time: the turn timer never fires unless a
 * test advances it, which keeps a slow machine from turning a counter assertion into a race.
 */
async function openRoom(
  roomId: string,
  archive: HandArchive = noopArchive,
  metrics: AppMetrics = new AppMetrics(),
): Promise<RoomFixture> {
  const registry = new RoomRegistry({
    store: seatingOnlyStore(),
    clock: createManualClock(),
    random: createSecureRandom(),
    nextHandId: incrementingHandIds(roomId),
    archive,
    metrics,
  });
  const room = await registry.open({ record: recordFor(roomId) });
  return { registry, room, metrics };
}

/** Seats two people, so a hand can be dealt. */
async function seatTwo(room: LiveRoom): Promise<void> {
  await room.table.sit({ userId: 'usr_a', displayName: 'Ada', seat: 0, stack: 1_000 });
  await room.table.sit({ userId: 'usr_b', displayName: 'Bo', seat: 1, stack: 1_000 });
}

/** Whoever the engine says is to act, as a user id. */
function actorOf(room: LiveRoom): string {
  const view = room.table.viewFor('usr_a');
  assert.ok(view !== null, 'a hand must be in progress');
  assert.ok(view.toAct !== null, 'somebody must be to act');
  return view.toAct === 0 ? 'usr_a' : 'usr_b';
}

/** Folds until the hand is over. Heads-up, the first fold ends it. */
async function foldToTheEnd(room: LiveRoom): Promise<void> {
  for (let guard = 0; guard < 8; guard += 1) {
    if (!room.table.snapshot().handInProgress) return;
    const actor = actorOf(room);
    const view = room.table.viewFor(actor);
    assert.ok(view !== null);
    await room.table.submitAction(actor, {
      action: { type: 'fold' },
      actionId: `fold-${guard}-aaaaaaaa`,
      expectedSequence: view.actionSequence,
    });
  }
  assert.fail('the hand did not end within the fold budget');
}

/** Polls a condition to a deadline. Used only where a real socket makes the timing real. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + SOCKET_DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------

describe('the hand lifecycle is counted', () => {
  it('plays a hand and counts it once at each end', async () => {
    const { room, metrics } = await openRoom('room_handcount');
    await seatTwo(room);

    assert.equal(metrics.handsStarted.get(), 0, 'seating is not a hand');
    assert.equal(metrics.handsCompleted.get(), 0);

    await room.table.startHand();
    assert.equal(metrics.handsStarted.get(), 1);
    assert.equal(metrics.handsCompleted.get(), 0, 'a hand in progress has not completed');

    await foldToTheEnd(room);
    assert.equal(metrics.handsCompleted.get(), 1);
    // Exactly once. Every action publishes a notice through the same subscription, so an
    // increment keyed on anything but the completion flag would be several by now.
    assert.equal(metrics.handsStarted.get(), 1);

    await room.table.startHand();
    await foldToTheEnd(room);
    assert.equal(metrics.handsStarted.get(), 2);
    assert.equal(metrics.handsCompleted.get(), 2);
    assert.equal(metrics.handsFailed.get({ reason: 'room_closed' }), 0, 'nothing was abandoned');
  });

  it('counts a hand abandoned because its room closed under it', async () => {
    const { registry, room, metrics } = await openRoom('room_closedmidhand');
    await seatTwo(room);
    await room.table.startHand();

    registry.close('room_closedmidhand');
    // The deck and the commitment salts went with the process's memory of that hand, so it can
    // never reach a settled result — which is the gap between started and completed that
    // `handsFailed` exists to explain.
    assert.equal(metrics.handsFailed.get({ reason: 'room_closed' }), 1);
    assert.equal(metrics.handsStarted.get(), 1);
    assert.equal(metrics.handsCompleted.get(), 0);
  });

  it('does not count a room closed between hands as an abandoned hand', async () => {
    // The negative control for the assertion above: an increment on every `close()` would pass
    // that test and fail this one.
    const { registry, room, metrics } = await openRoom('room_closedbetween');
    await seatTwo(room);
    await room.table.startHand();
    await foldToTheEnd(room);

    registry.close('room_closedbetween');
    assert.equal(metrics.handsFailed.get({ reason: 'room_closed' }), 0);
    assert.equal(metrics.handsCompleted.get(), 1);
  });

  it('counts every hand a restart interrupted, by how many there were', async () => {
    const abandoned = [
      { handId: 'hand_orphan1', roomId: 'room_restarted', handNumber: 4 },
      { handId: 'hand_orphan2', roomId: 'room_restarted', handNumber: 5 },
    ];
    const metrics = new AppMetrics();
    const { registry } = await openRoom(
      'room_restarted',
      { ...noopArchive, abandonInterruptedHands: async () => abandoned },
      metrics,
    );

    // Two, not one: one reconciliation can close several hands, and the count was what every
    // caller of `reconcileInterruptedHands` used to throw away.
    assert.equal(metrics.handsFailed.get({ reason: 'interrupted_by_restart' }), 2);
    assert.equal(metrics.handsStarted.get(), 0, 'reconciling is not dealing');

    // A room already live in this process is not reconciled again, so the counter does not move.
    assert.equal(await registry.reconcileInterruptedHands('room_restarted'), 0);
    assert.equal(metrics.handsFailed.get({ reason: 'interrupted_by_restart' }), 2);
  });

  it('counts an archive write that failed, and lets the hand carry on regardless', async () => {
    const metrics = new AppMetrics();
    const problems: string[] = [];
    let reported: (() => void) | null = null;
    const firstProblem = new Promise<void>((resolve) => {
      reported = resolve;
    });

    const registry = new RoomRegistry({
      store: seatingOnlyStore(),
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: incrementingHandIds('room_archivefail'),
      archive: {
        ...noopArchive,
        handStarted: () => Promise.reject(new Error('the archive is down')),
      },
      metrics,
      onProblem: (message, detail) => {
        problems.push(`${detail.event}: ${message}`);
        reported?.();
      },
    });
    const room = await registry.open({ record: recordFor('room_archivefail') });
    await seatTwo(room);
    await room.table.startHand();

    // The archive chain is deliberately awaited by nobody, so the test waits for the failure to
    // be reported rather than assuming it has happened by now.
    await firstProblem;

    assert.equal(metrics.archiveFailures.get(), 1);
    assert.deepEqual(problems, ['archive-write: a hand could not be archived']);
    // Play continued: a reporting problem must never become a gameplay one.
    assert.equal(metrics.handsStarted.get(), 1);
    assert.equal(room.table.snapshot().handInProgress, true);
    // And a failed archive write is NOT a failed hand — that distinction is the whole reason
    // `archiveFailures` is a separate counter.
    assert.equal(metrics.handsFailed.get({ reason: 'room_closed' }), 0);
  });

  it('reads the live-room gauge from the registry at scrape time', async () => {
    const metrics = new AppMetrics();
    const { registry } = await openRoom('room_gaugeone', noopArchive, metrics);
    assert.equal(metrics.roomsLive.get(), 1);

    await registry.open({ record: recordFor('room_gaugetwo') });
    assert.equal(metrics.roomsLive.get(), 2);

    registry.close('room_gaugetwo');
    assert.equal(metrics.roomsLive.get(), 1, 'a gauge bound to the map cannot drift from it');

    registry.closeAll();
    assert.equal(metrics.roomsLive.get(), 0);
    assert.match(metrics.render(), /prl_rooms_live 0/);
  });
});

// ---------------------------------------------------------------------------
// Inbound frames
// ---------------------------------------------------------------------------

describe('rejected socket frames are counted by a reason from the closed set', () => {
  /** A schema-carrying route, so Fastify sets up the validator this suite borrows. */
  const SCHEMA_ROUTE = '/api/v1/test-frame-schema';
  let app: FastifyInstance;

  before(async () => {
    app = await buildApp({ config: testConfig(), database: stubDatabase, metrics: new AppMetrics() });
    app.get(
      SCHEMA_ROUTE,
      { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
      async () => ({ ok: true }),
    );
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  interface FrameFixture {
    readonly metrics: AppMetrics;
    readonly router: WsRouter;
    readonly connection: WsConnection;
  }

  /** A router on its own metrics, with one open connection and one live room to join. */
  async function frameFixture(roomId: string): Promise<FrameFixture> {
    const metrics = new AppMetrics();
    const { registry, room } = await openRoom(roomId, noopArchive, metrics);
    await seatTwo(room);
    const sink: SocketSink = { send: () => undefined, close: () => undefined };
    const router = new WsRouter({
      registry,
      clock: createManualClock(),
      validate: compileFrameValidator(app),
      config: app.appConfig,
      metrics,
    });
    const connection = router.open(sink, {
      userId: 'usr_a',
      displayName: 'Ada',
      sessionId: 'ses_frames',
    });
    return { metrics, router, connection };
  }

  const HELLO = (roomId: string, protocolVersion = WS_PROTOCOL_VERSION): string =>
    JSON.stringify({ type: 'hello', protocolVersion, roomId, clientNonce: 'nonce-aaaaaaaa' });

  /** Every reason except the one under test must still be zero. */
  function assertOnly(metrics: AppMetrics, reason: string, count = 1): void {
    const everyReason = [
      'too_large',
      'rate_limited',
      'not_json',
      'schema',
      'unknown_type',
      'before_handshake',
      'duplicate_hello',
      'bad_protocol_version',
    ];
    for (const candidate of everyReason) {
      assert.equal(
        metrics.wsFramesRejected.get({ reason: candidate }),
        candidate === reason ? count : 0,
        `expected ${count} rejection(s) under "${reason}", not under "${candidate}"`,
      );
    }
  }

  it('labels an oversized frame `too_large` and nothing else', async () => {
    const { router, connection, metrics } = await frameFixture('room_frametoolarge');
    router.handleFrame(connection, 'x'.repeat(WS_LIMITS.maxMessageBytes + 1));
    assertOnly(metrics, 'too_large');
  });

  it('labels a frame that is not JSON `not_json`', async () => {
    const { router, connection, metrics } = await frameFixture('room_framenotjson');
    router.handleFrame(connection, '{not json at all');
    assertOnly(metrics, 'not_json');
  });

  it('labels a frame the contract schema refuses `schema`, never the validator’s complaint', async () => {
    const { router, connection, metrics } = await frameFixture('room_frameschema');
    // A `type` the discriminator has no branch for, so the validator refuses before the router
    // reads a field. Its message names the branch it tried; that message must not be the label.
    router.handleFrame(connection, JSON.stringify({ type: 'definitely-not-a-frame' }));
    assertOnly(metrics, 'schema');
  });

  it('labels an intent that arrived before the handshake `before_handshake`', async () => {
    const { router, connection, metrics } = await frameFixture('room_framehandshake');
    router.handleFrame(connection, JSON.stringify({ type: 'ping', nonce: 'nonce-aaaaaaaa' }));
    assertOnly(metrics, 'before_handshake');
  });

  it('labels a second hello on one socket `duplicate_hello`', async () => {
    const { router, connection, metrics } = await frameFixture('room_framehello');
    // The room is already live, so the first `hello` joins with no suspension and the second one
    // sees a socket that is already in a room. That is the race the `joining` flag exists for.
    router.handleFrame(connection, HELLO('room_framehello'));
    assert.equal(connection.roomId, 'room_framehello', 'the first hello must have joined');
    router.handleFrame(connection, HELLO('room_framehello'));
    assertOnly(metrics, 'duplicate_hello');
  });

  it('labels a hello naming another protocol version `bad_protocol_version`, not the version', async () => {
    const { router, connection, metrics } = await frameFixture('room_frameversion');
    router.handleFrame(connection, HELLO('room_frameversion', WS_PROTOCOL_VERSION + 7));
    assertOnly(metrics, 'bad_protocol_version');
    // The number the client chose must not have become a series of its own.
    assert.doesNotMatch(metrics.render(), new RegExp(`reason="${WS_PROTOCOL_VERSION + 7}"`));
  });

  it('labels the frame that exhausts the token bucket `rate_limited`', async () => {
    const { router, connection, metrics } = await frameFixture('room_framerate');
    // A manual clock that never advances means the bucket never refills, so the burst allowance
    // is exactly how many frames get through. Each of those is itself refused, as `not_json`,
    // which is what makes the last one's different label the assertion.
    for (let index = 0; index < WS_LIMITS.burstAllowance + 1; index += 1) {
      router.handleFrame(connection, '{not json at all');
    }
    assert.equal(metrics.wsFramesRejected.get({ reason: 'rate_limited' }), 1);
    assert.equal(metrics.wsFramesRejected.get({ reason: 'not_json' }), WS_LIMITS.burstAllowance);
  });

  it('cannot be made to mint a series: a thousand distinct bad frames produce one', async () => {
    const { router, connection, metrics } = await frameFixture('room_framecardinality');
    for (let index = 0; index < 1_000; index += 1) {
      router.handleFrame(connection, `{"type":"junk-${index}"}`);
    }
    const lines = metrics
      .render()
      .split('\n')
      .filter((line) => line.startsWith('prl_websocket_frames_rejected_total{'));
    // One for `schema`, one for `rate_limited` once the bucket empties. Never one per frame.
    assert.equal(lines.length, 2, lines.join(' | '));
  });
});

// ---------------------------------------------------------------------------
// The socket lifecycle, over a real socket
// ---------------------------------------------------------------------------

describe('the socket lifecycle, over a real socket', () => {
  const openSockets: WebSocket[] = [];
  const openApps: FastifyInstance[] = [];

  after(async () => {
    for (const socket of openSockets) socket.terminate();
    for (const instance of openApps) await instance.close();
  });

  interface Hub {
    readonly metrics: AppMetrics;
    readonly url: string;
    readonly cookie: string;
  }

  async function startHub(roomId: string): Promise<Hub> {
    const config = testConfig();
    const metrics = new AppMetrics();
    const app = await buildApp({ config, database: stubDatabase, metrics });
    openApps.push(app);
    const { registry } = await openRoom(roomId, noopArchive, metrics);
    const sessions = new Map([
      ['token-aaaaaaaa', { sessionId: 'ses_hub', user: accountFor('usr_a', 'Ada') }],
    ]);
    await registerRoutes(app, [
      createWsHub({ registry, sessionStore: fixedSessionStore(sessions), metrics }),
    ]);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as AddressInfo;
    return {
      metrics,
      url: `ws://127.0.0.1:${address.port}${API_PATHS.ws()}`,
      cookie: `${sessionCookieName(config)}=${app.signCookie('token-aaaaaaaa')}`,
    };
  }

  it('counts an accepted socket, reads the live count, and labels the close by its code', async () => {
    const hub = await startHub('room_socketclose');
    assert.equal(hub.metrics.wsConnections.get(), 0);

    const socket = new WebSocket(hub.url, {
      headers: { origin: ALLOWED_ORIGIN, cookie: hub.cookie },
    });
    openSockets.push(socket);
    await once(socket, 'open');
    await waitFor(() => hub.metrics.wsConnections.get() === 1, 'the hub to adopt the socket');
    assert.equal(hub.metrics.wsOpened.get(), 1);

    // A normal client close. The code the peer sent is the label, taken from the close event
    // rather than assumed — that is what distinguishes a deploy (4503) from a dropped connection
    // (1006) on the same graph.
    socket.close(WS_CLOSE.normal, 'done');
    await waitFor(() => hub.metrics.wsConnections.get() === 0, 'the hub to release the socket');
    assert.equal(hub.metrics.wsClosed.get({ code: String(WS_CLOSE.normal) }), 1);
    assert.equal(hub.metrics.wsClosed.get({ code: String(WS_CLOSE.badOrigin) }), 0);
    assert.match(hub.metrics.render(), /prl_websocket_connections 0/);
  });

  it('counts a refused upgrade by reason, and never as an opened connection', async () => {
    const hub = await startHub('room_socketrefused');

    const foreign = new WebSocket(hub.url, {
      headers: { origin: 'https://evil.example.test', cookie: hub.cookie },
    });
    openSockets.push(foreign);
    const [foreignCode] = (await once(foreign, 'close')) as [number];
    assert.equal(foreignCode, WS_CLOSE.badOrigin);

    const anonymous = new WebSocket(hub.url, { headers: { origin: ALLOWED_ORIGIN } });
    openSockets.push(anonymous);
    const [anonymousCode] = (await once(anonymous, 'close')) as [number];
    assert.equal(anonymousCode, WS_CLOSE.unauthenticated);

    assert.equal(hub.metrics.wsRefused.get({ reason: 'bad_origin' }), 1);
    assert.equal(hub.metrics.wsRefused.get({ reason: 'unauthenticated' }), 1);
    assert.equal(hub.metrics.wsRefused.get({ reason: 'rate_limited' }), 0);
    // A refused upgrade is a completed TCP connection at the protocol level and must still not be
    // counted as an accepted socket, or the reconnect-loop signal (opened versus closed) becomes
    // meaningless the moment somebody points a page at this API.
    assert.equal(hub.metrics.wsOpened.get(), 0);
    assert.equal(hub.metrics.wsConnections.get(), 0);
    // Nothing about the origin or the session reaches a label.
    assert.doesNotMatch(hub.metrics.render(), /evil\.example\.test/);
  });

  it('folds a close code the contract does not define into `other`', () => {
    for (const code of Object.values(WS_CLOSE)) assert.equal(closeCodeLabel(code), String(code));
    // The codes a peer produces without the server asking.
    for (const code of [1001, 1005, 1006, 1009, 1011]) assert.equal(closeCodeLabel(code), String(code));
    // And the 65,000-odd a client could invent, which must all land on one series.
    for (const code of [3000, 4999, 4321, 0, -1, 70_000]) assert.equal(closeCodeLabel(code), 'other');
  });
});

// ---------------------------------------------------------------------------
// The problem vocabulary
// ---------------------------------------------------------------------------

/**
 * Every `event: 'some-name'` in a source file, as the problem hooks write them.
 *
 * Deliberately blind to dotted names, which is what keeps `ws.upgrade.refused` — an audit event,
 * a different vocabulary with a different grammar — out of this scan. Exported shape rather than
 * inlined so the negative control below can feed it a source string that is not on disk.
 */
function problemEventsIn(source: string): readonly string[] {
  return [...source.matchAll(/\bevent: '([a-z]+(?:-[a-z]+)*)'/g)].map((match) => match[1] ?? '');
}

describe('the problem vocabulary', () => {
  /** The source files whose hooks report a problem. */
  const SCANNED_DIRECTORIES = ['src/rooms', 'src/ws', 'src/observability'];

  async function scanSource(): Promise<readonly string[]> {
    const found: string[] = [];
    for (const directory of SCANNED_DIRECTORIES) {
      const absolute = path.join(PACKAGE_ROOT, directory);
      for (const entry of await readdir(absolute)) {
        if (!entry.endsWith('.ts')) continue;
        found.push(...problemEventsIn(await readFile(path.join(absolute, entry), 'utf8')));
      }
    }
    return found;
  }

  it('names every event the source actually raises, and raises every event it names', async () => {
    const raised = await scanSource();
    // The scan looked at something. A regex that silently stopped matching would otherwise pass
    // both set comparisons below by finding nothing at all.
    assert.ok(raised.length > 12, `expected more than a dozen problem call sites, found ${raised.length}`);

    const declared = new Set<string>(PROBLEM_EVENTS);
    const unknown = [...new Set(raised)].filter((event) => !declared.has(event));
    assert.deepEqual(unknown, [], 'a call site raised an event the union does not declare');

    const unused = [...declared].filter((event) => !raised.includes(event));
    assert.deepEqual(unused, [], 'the union declares an event no call site raises');
  });

  it('the extractor can actually fail', () => {
    // The negative control: an invented event in a source string is found and reported as unknown.
    const poisoned = "this.onProblem('something', { event: 'not-a-real-event', seat: 1 });";
    assert.deepEqual(problemEventsIn(poisoned), ['not-a-real-event']);
    assert.ok(!new Set<string>(PROBLEM_EVENTS).has('not-a-real-event'));
    // And it ignores the audit vocabulary, which is dotted and is not a problem event.
    assert.deepEqual(problemEventsIn("{ event: 'ws.upgrade.refused' }"), []);
  });

  it('counts exactly the seat-actor failures against the actor counter', () => {
    const metrics = new AppMetrics();
    for (const event of PROBLEM_EVENTS) recordProblem(event, metrics);

    // Written out rather than derived from `classifyProblem`, because deriving it would make this
    // a test of the classifier against itself. These seven are the events after which it is
    // somebody's turn and nothing is going to act.
    const actors: readonly ProblemEvent[] = [
      'bot-policy',
      'bot-action-rejected',
      'bot-rehydrate',
      'seat-retake',
      'turn-timeout',
      'timeout-rejection',
      'departed-seat-fold',
    ];
    for (const event of actors) {
      assert.equal(metrics.tableActorFailures.get({ reason: event }), 1, `${event} must be counted`);
      assert.equal(classifyProblem(event), 'actor');
    }

    // The negative control, and the reason it matters: `archive-write` and `hands-interrupted` are
    // counted at their source against different metrics, so counting them here too would double
    // them, and a subscriber that threw is not a seat failing to act.
    for (const event of ['archive-write', 'hands-interrupted', 'subscriber-throw'] as const) {
      assert.equal(metrics.tableActorFailures.get({ reason: event }), 0, `${event} must not be counted`);
    }
    assert.equal(metrics.tableActorFailures.seriesCount, actors.length);
  });
});
