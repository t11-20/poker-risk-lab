/**
 * Live-table telemetry (hand lifecycle, socket lifecycle, typed problems), because a counter that
 * never moves looks like a healthy service. The archive and room store are faked
 * (`test/helpers/live-room.ts`). The table, router and hub are production code over loopback.
 * Each case builds its own `AppMetrics`, because `node --test` shares one process across files.
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

const SOCKET_DEADLINE_MS = 10_000;

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

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

/** The clock is manual, so the turn timer fires only when a test advances it. */
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

async function seatTwo(room: LiveRoom): Promise<void> {
  await room.table.sit({ userId: 'usr_a', displayName: 'Ada', seat: 0, stack: 1_000 });
  await room.table.sit({ userId: 'usr_b', displayName: 'Bo', seat: 1, stack: 1_000 });
}

function actorOf(room: LiveRoom): string {
  const view = room.table.viewFor('usr_a');
  assert.ok(view !== null, 'a hand must be in progress');
  assert.ok(view.toAct !== null, 'somebody must be to act');
  return view.toAct === 0 ? 'usr_a' : 'usr_b';
}

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

/** Only where a real socket makes the timing real. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + SOCKET_DEADLINE_MS;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    // Every action publishes a notice, so a per-notice increment would be several by now.
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
    // The deck and salts died with the process's memory of the hand, so it can never settle.
    assert.equal(metrics.handsFailed.get({ reason: 'room_closed' }), 1);
    assert.equal(metrics.handsStarted.get(), 1);
    assert.equal(metrics.handsCompleted.get(), 0);
  });

  it('does not count a room closed between hands as an abandoned hand', async () => {
    // An increment on every `close()` would pass the test above and fail this one.
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

    // One reconciliation can close several hands.
    assert.equal(metrics.handsFailed.get({ reason: 'interrupted_by_restart' }), 2);
    assert.equal(metrics.handsStarted.get(), 0, 'reconciling is not dealing');

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

    // Nobody awaits the archive chain, so wait for the reported failure.
    await firstProblem;

    assert.equal(metrics.archiveFailures.get(), 1);
    assert.deepEqual(problems, ['archive-write: a hand could not be archived']);
    // A reporting problem must never become a gameplay one.
    assert.equal(metrics.handsStarted.get(), 1);
    assert.equal(room.table.snapshot().handInProgress, true);
    // A failed archive write is not a failed hand.
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

describe('rejected socket frames are counted by a reason from the closed set', () => {
  /** Makes Fastify set up the validator this suite borrows. */
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

  /** Every other reason must still be zero, so a wrong label fails. */
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
    // The validator's message names the branch it tried, and that message must not become the label.
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
    // The second `hello` sees a socket already in a room, the race the `joining` flag exists for.
    router.handleFrame(connection, HELLO('room_framehello'));
    assert.equal(connection.roomId, 'room_framehello', 'the first hello must have joined');
    router.handleFrame(connection, HELLO('room_framehello'));
    assertOnly(metrics, 'duplicate_hello');
  });

  it('labels a hello naming another protocol version `bad_protocol_version`, not the version', async () => {
    const { router, connection, metrics } = await frameFixture('room_frameversion');
    router.handleFrame(connection, HELLO('room_frameversion', WS_PROTOCOL_VERSION + 7));
    assertOnly(metrics, 'bad_protocol_version');
    // A client-chosen number must not become a series.
    assert.doesNotMatch(metrics.render(), new RegExp(`reason="${WS_PROTOCOL_VERSION + 7}"`));
  });

  it('labels the frame that exhausts the token bucket `rate_limited`', async () => {
    const { router, connection, metrics } = await frameFixture('room_framerate');
    // A manual clock means the bucket never refills. Each burst frame is refused as `not_json`, so
    // the last one's different label is the assertion.
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
    // One line per reason change, never one per frame.
    assert.equal(lines.length, 2, lines.join(' | '));
  });
});

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

    // The label comes from the close event, which separates a deploy (4503) from a drop (1006).
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
    // Counting refused upgrades as opened would break the opened-versus-closed reconnect-loop signal.
    assert.equal(hub.metrics.wsOpened.get(), 0);
    assert.equal(hub.metrics.wsConnections.get(), 0);
    assert.doesNotMatch(hub.metrics.render(), /evil\.example\.test/);
  });

  it('folds a close code the contract does not define into `other`', () => {
    for (const code of Object.values(WS_CLOSE)) assert.equal(closeCodeLabel(code), String(code));
    for (const code of [1001, 1005, 1006, 1009, 1011]) assert.equal(closeCodeLabel(code), String(code));
    // Every invented code lands on one series.
    for (const code of [3000, 4999, 4321, 0, -1, 70_000]) assert.equal(closeCodeLabel(code), 'other');
  });
});

/** Blind to dotted names, which keeps the `ws.upgrade.refused` audit vocabulary out. */
function problemEventsIn(source: string): readonly string[] {
  return [...source.matchAll(/\bevent: '([a-z]+(?:-[a-z]+)*)'/g)].map((match) => match[1] ?? '');
}

describe('the problem vocabulary', () => {
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
    // A regex that stopped matching would pass both set comparisons by finding nothing.
    assert.ok(raised.length > 12, `expected more than a dozen problem call sites, found ${raised.length}`);

    const declared = new Set<string>(PROBLEM_EVENTS);
    const unknown = [...new Set(raised)].filter((event) => !declared.has(event));
    assert.deepEqual(unknown, [], 'a call site raised an event the union does not declare');

    const unused = [...declared].filter((event) => !raised.includes(event));
    assert.deepEqual(unused, [], 'the union declares an event no call site raises');
  });

  it('the extractor can actually fail', () => {
    // Negative control.
    const poisoned = "this.onProblem('something', { event: 'not-a-real-event', seat: 1 });";
    assert.deepEqual(problemEventsIn(poisoned), ['not-a-real-event']);
    assert.ok(!new Set<string>(PROBLEM_EVENTS).has('not-a-real-event'));
    assert.deepEqual(problemEventsIn("{ event: 'ws.upgrade.refused' }"), []);
  });

  it('counts exactly the seat-actor failures against the actor counter', () => {
    const metrics = new AppMetrics();
    for (const event of PROBLEM_EVENTS) recordProblem(event, metrics);

    // Written out, not derived from `classifyProblem`, so this does not test the classifier
    // against itself. After these seven it is somebody's turn and nothing will act.
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

    // These are counted at source against other metrics, and a throwing subscriber is not a seat
    // failing to act.
    for (const event of ['archive-write', 'hands-interrupted', 'subscriber-throw'] as const) {
      assert.equal(metrics.tableActorFailures.get({ reason: event }), 0, `${event} must not be counted`);
    }
    assert.equal(metrics.tableActorFailures.seriesCount, actors.length);
  });
});
