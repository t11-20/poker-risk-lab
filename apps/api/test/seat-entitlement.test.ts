/**
 * `PRL_ENROLMENT_REQUIRED`: who may take a seat, over BOTH transports, in every state.
 * REST `sit` and the socket `sit` frame both reach only `sitAtTable`, so they are asserted side by
 * side, and the socket case drives a real frame through `WsRouter.handleFrame`. The ways of not being
 * entitled are decided in SQL and tested in `enrolments-database.test.ts`; here a `false` must stop a
 * seat. The `enforced` and `off` groups are each other's negative control.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { ERROR_MESSAGES, ERROR_STATUS, WS_CLOSE, wsCloseForError } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, ConfigError, type EnvRecord, loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, type DatabaseHandle } from '../src/db.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import type { ProblemDetail } from '../src/observability/telemetry.ts';
import type { Db } from '../src/repositories/sql.ts';
import { postgresSeatEntitlement, type SeatEntitlement } from '../src/rooms/entitlement.ts';
import { RoomRegistry, resetRoomRegistryForTests, roomRegistry } from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { registerApiRoutes } from '../src/routes/index.ts';
import { createRoomRoutes } from '../src/routes/rooms.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { compileFrameValidator } from '../src/ws/hub.ts';
import { type SocketSink, WsRouter } from '../src/ws/router.ts';
import { accountFor, fixedSessionStore, seatingOnlyStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const ROOM_ID = 'room_entitlement1';

const ADA = 'usr_ada';
const BO = 'usr_bo';
const ADA_TOKEN = 'token-ada';

function testConfig(overrides: EnvRecord = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
    RATE_LIMIT_MAX: '5000',
    ...overrides,
  });
}

const stubDatabase: DatabaseHandle = {
  ping: () => Promise.resolve({ ok: true }),
  close: () => Promise.resolve(),
};

/**
 * Answers from a set and records what it was asked. The count is asserted because `off` must mean
 * the read never happens, not that it happens and is ignored.
 */
function fakeEntitlement(entitled: readonly string[]): SeatEntitlement & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    entitledToSit: (userId) => {
      asked.push(userId);
      return Promise.resolve(entitled.includes(userId));
    },
  };
}

interface Harness {
  readonly app: FastifyInstance;
  readonly registry: RoomRegistry;
  readonly router: WsRouter;
  readonly metrics: AppMetrics;
  readonly problems: { message: string; detail: ProblemDetail }[];
}

/**
 * One room, two members, neither seated, reachable over both transports. The room is opened directly
 * so `openRoomFor` takes its live branch and `seatingOnlyStore` is asked only what seating needs.
 */
async function harness(entitlement: SeatEntitlement | null): Promise<Harness> {
  const metrics = new AppMetrics();
  const app = await buildApp({ config: testConfig(), database: stubDatabase, metrics });
  const problems: { message: string; detail: ProblemDetail }[] = [];
  const registry = new RoomRegistry({
    clock: createManualClock(),
    random: createSecureRandom(),
    store: seatingOnlyStore(),
    metrics,
    onProblem: (message, detail) => problems.push({ message, detail }),
    ...(entitlement === null ? {} : { entitlement }),
  });
  await registry.open({
    record: {
      id: ROOM_ID,
      name: 'Entitlement table',
      ownerUserId: ADA,
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 3, actionTimeoutSeconds: 30 },
      startingStack: 1_000,
      createdAt: '2026-08-17T12:00:00.000Z',
      closed: false,
    },
    members: [
      { userId: ADA, displayName: 'Ada', isBot: false, botProfile: null },
      { userId: BO, displayName: 'Bo', isBot: false, botProfile: null },
    ],
  });
  const sessions = fixedSessionStore(
    new Map([[ADA_TOKEN, { sessionId: 'ses_ada', user: accountFor(ADA, 'Ada') }]]),
  );
  app.get('/api/v1/test-csrf-entitlement', async (_request, reply) => ({ token: reply.generateCsrf() }));
  // A schema-carrying route, so Fastify builds the Ajv instance `compileFrameValidator` borrows.
  // Without it every frame is refused `invalid_request` before the guard is reached.
  app.get(
    '/api/v1/test-frame-schema-entitlement',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: {} } } },
    async () => ({ ok: true }),
  );
  await app.register(createRoomRoutes({ registry, sessionStore: sessions }), { prefix: '/api/v1' });
  await app.ready();
  const router = new WsRouter({
    registry,
    clock: createManualClock(),
    validate: compileFrameValidator(app),
    config: app.appConfig,
    nextRequestId: () => 'req-fixed',
  });
  return { app, registry, router, metrics, problems };
}

async function sitOverRest(test: Harness, seat: number): Promise<{ status: number; code: string }> {
  const seed = await test.app.inject({ method: 'GET', url: '/api/v1/test-csrf-entitlement' });
  const payload: unknown = seed.json();
  assert.ok(typeof payload === 'object' && payload !== null && 'token' in payload);
  const csrfCookie = seed.cookies.find((entry) => entry.name === 'prl_csrf');
  assert.ok(csrfCookie !== undefined, 'the security plugin issued no CSRF cookie');
  const response = await test.app.inject({
    method: 'POST',
    url: `/api/v1/rooms/${ROOM_ID}/sit`,
    headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': String(Reflect.get(payload, 'token')) },
    cookies: { prl_session: test.app.signCookie(ADA_TOKEN), prl_csrf: csrfCookie.value },
    payload: { seat },
  });
  const body: unknown = response.statusCode === 200 ? null : response.json();
  const error = body === null ? null : Reflect.get(body as object, 'error');
  return {
    status: response.statusCode,
    code: error === null || typeof error !== 'object' ? '' : String(Reflect.get(error, 'code')),
  };
}

interface SocketRun {
  readonly frames: readonly { readonly type: string; readonly [key: string]: unknown }[];
  readonly closes: readonly { readonly code: number; readonly reason: string }[];
}

/**
 * Drives a real `sit` FRAME through `handleFrame`, not `registry.sitAtTable`, because the risk is a
 * socket path that never reaches the guarded method.
 */
async function sitOverSocket(test: Harness, seat: number): Promise<SocketRun> {
  const frames: { type: string; [key: string]: unknown }[] = [];
  const closes: { code: number; reason: string }[] = [];
  const sink: SocketSink = {
    send: (text) => {
      const value: unknown = JSON.parse(text);
      assert.ok(typeof value === 'object' && value !== null && 'type' in value);
      frames.push(value as { type: string });
    },
    close: (code, reason) => closes.push({ code, reason }),
  };
  const connection = test.router.open(sink, {
    userId: ADA,
    displayName: 'Ada',
    sessionId: 'ses_ada',
  });
  test.router.handleFrame(
    connection,
    JSON.stringify({ type: 'hello', protocolVersion: 1, roomId: ROOM_ID, clientNonce: 'nonce-ada' }),
  );
  test.router.handleFrame(connection, JSON.stringify({ type: 'sit', seat, requestId: 'req-sit1' }));
  // The intents are dispatched with `void`, so the answer lands a few microtasks later.
  for (let turn = 0; turn < 6; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return { frames, closes };
}

function counterValue(metrics: AppMetrics, name: string, labels: string): number | null {
  const line = metrics.registry
    .render()
    .split('\n')
    .find((row) => row.startsWith(`${name}{${labels}}`));
  return line === undefined ? null : Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('PRL_ENROLMENT_REQUIRED=enforced: taking a seat', () => {
  it('refuses an unenrolled learner over REST, with a code they can act on', async () => {
    const test = await harness(fakeEntitlement([]));
    const { status, code } = await sitOverRest(test, 0);
    assert.equal(code, 'enrolment_required');
    assert.equal(status, 403);
    assert.equal(
      test.registry.require(ROOM_ID, ADA).table.seatOf(ADA),
      null,
      'the learner was refused and seated anyway',
    );
    await test.app.close();
  });

  it('refuses an unenrolled learner over the socket, driving the real sit frame', async () => {
    const test = await harness(fakeEntitlement([]));
    const run = await sitOverSocket(test, 0);
    const error = run.frames.find((frame) => frame.type === 'error');
    assert.ok(error !== undefined, `no error frame; got ${run.frames.map((f) => f.type).join(', ')}`);
    const detail = Reflect.get(error, 'error');
    assert.ok(typeof detail === 'object' && detail !== null);
    assert.equal(Reflect.get(detail, 'code'), 'enrolment_required');
    assert.equal(
      Reflect.get(detail, 'message'),
      ERROR_MESSAGES.enrolment_required,
      'the socket must send the contract wording and never an internal message',
    );
    assert.equal(
      run.frames.some((frame) => frame.type === 'ack'),
      false,
      'the sit was acked as well as refused',
    );
    assert.equal(test.registry.require(ROOM_ID, ADA).table.seatOf(ADA), null);
    await test.app.close();
  });

  /**
   * A `sit` refusal is an error frame only. Closing the socket would discard the one place the reason
   * is shown (`table.notice` in `LiveTable.tsx`), and the client would reconnect and show a connection
   * problem instead.
   */
  it('leaves the socket open: a refused seat is not a refused connection', async () => {
    const test = await harness(fakeEntitlement([]));
    const run = await sitOverSocket(test, 0);
    assert.deepEqual(run.closes, [], 'the socket was closed for a refusal that is not fatal to it');
    assert.equal(
      run.frames.some((frame) => frame.type === 'welcome'),
      true,
      'the handshake itself must still succeed: watching a table is not taking a seat',
    );
    await test.app.close();
  });

  it('seats an enrolled learner normally, over both transports', async () => {
    const rest = await harness(fakeEntitlement([ADA]));
    const restResult = await sitOverRest(rest, 0);
    assert.equal(restResult.status, 200, `REST refused an enrolled learner: ${restResult.code}`);
    assert.equal(rest.registry.require(ROOM_ID, ADA).table.seatOf(ADA), 0);
    await rest.app.close();

    const socket = await harness(fakeEntitlement([ADA]));
    const run = await sitOverSocket(socket, 1);
    assert.equal(
      run.frames.some((frame) => frame.type === 'error'),
      false,
      'the socket refused an enrolled learner',
    );
    assert.equal(
      run.frames.some((frame) => frame.type === 'ack' && frame.requestId === 'req-sit1'),
      true,
      'no ack for a sit that should have been allowed',
    );
    assert.equal(socket.registry.require(ROOM_ID, ADA).table.seatOf(ADA), 1);
    await socket.app.close();
  });

  /**
   * `sitAtTable` writes the seat before it tells the live table, so a guard placed after that write
   * would briefly allocate the chair to a refused learner.
   */
  it('refuses before the durable seat is written', async () => {
    const entitlement = fakeEntitlement([]);
    const test = await harness(entitlement);
    await sitOverRest(test, 0);
    const member = await test.registry.store.memberOf(ROOM_ID, ADA);
    assert.equal(member?.seat ?? null, null, 'a refused sit left a durable seat behind');
    assert.deepEqual(entitlement.asked, [ADA]);
    await test.app.close();
  });

  it('counts the refusal, and the counter existed at zero before it', async () => {
    const test = await harness(fakeEntitlement([]));
    assert.equal(
      counterValue(test.metrics, 'prl_seat_entitlement_refusals_total', 'reason="not_entitled"'),
      0,
      'the series must be primed: increase() cannot see a rise from a series never scraped',
    );
    await sitOverRest(test, 0);
    await sitOverSocket(test, 0);
    assert.equal(
      counterValue(test.metrics, 'prl_seat_entitlement_refusals_total', 'reason="not_entitled"'),
      2,
      'both transports must count against the same series',
    );
    assert.equal(
      counterValue(test.metrics, 'prl_seat_entitlement_refusals_total', 'reason="seat_not_restored"'),
      0,
      'a request-path refusal is not a seat that failed to be restored',
    );
    await test.app.close();
  });

  /**
   * `enrolment_required` is permanent (`wsCloseForError` maps 4xx to a close the client never
   * retries), so a transient fault must refuse as `internal_error`, the retryable 500.
   */
  it('fails closed but honestly when the entitlement read itself fails', async () => {
    const test = await harness({
      entitledToSit: () => Promise.reject(new Error('connection terminated unexpectedly')),
    });
    const { status, code } = await sitOverRest(test, 0);
    assert.equal(code, 'internal_error');
    assert.equal(status, 500);
    assert.equal(test.registry.require(ROOM_ID, ADA).table.seatOf(ADA), null);
    assert.equal(
      counterValue(test.metrics, 'prl_seat_entitlement_refusals_total', 'reason="not_entitled"'),
      0,
      'a fault is not a refusal and must not be counted as one',
    );
    await test.app.close();
  });
});

describe('PRL_ENROLMENT_REQUIRED=off: nothing changes', () => {
  it('seats anybody over REST and over the socket, and has nothing to ask', async () => {
    const rest = await harness(null);
    assert.equal(rest.registry.enforcesEntitlement, false);
    const restResult = await sitOverRest(rest, 0);
    assert.equal(restResult.status, 200, `an open instance refused a seat: ${restResult.code}`);
    assert.equal(rest.registry.require(ROOM_ID, ADA).table.seatOf(ADA), 0);
    await rest.app.close();

    const socket = await harness(null);
    const run = await sitOverSocket(socket, 1);
    assert.equal(
      run.frames.some((frame) => frame.type === 'error'),
      false,
      'an open instance refused a seat over the socket',
    );
    assert.equal(socket.registry.require(ROOM_ID, ADA).table.seatOf(ADA), 1);
    await socket.app.close();
  });

  it('leaves the refusal counters at zero rather than absent', async () => {
    const test = await harness(null);
    await sitOverRest(test, 0);
    assert.equal(
      counterValue(test.metrics, 'prl_seat_entitlement_refusals_total', 'reason="not_entitled"'),
      0,
      'an open instance must still export the series, at zero, so a dashboard reads "none" and ' +
        'not "no data"',
    );
    await test.app.close();
  });
});

/**
 * A store that holds one room and a roster, so `ensureOpen` has seats to restore.
 * Everything not needed throws, so an unintended call cannot pass quietly.
 */
function rosterStore(
  members: readonly { readonly userId: string; readonly seat: number; readonly isBot: boolean }[],
  unseated: string[] = [],
): RoomRegistry['store'] {
  const refuse = (name: string): never => {
    throw new Error(`the roster fake has no ${name}`);
  };
  const row = {
    id: ROOM_ID,
    name: 'Restored table',
    owner_user_id: ADA,
    max_seats: 3,
    small_blind: 5,
    big_blind: 10,
    ante: 0,
    starting_stack: 1_000,
    action_timeout_seconds: 30,
    visibility: 'invite_only' as const,
    status: 'open' as const,
    closed_at: null,
    created_at: new Date('2026-08-17T12:00:00.000Z'),
  };
  const rows = members.map((member, index) => ({
    id: `mem_${index}`,
    room_id: ROOM_ID,
    user_id: member.userId,
    display_name: member.userId,
    seat: member.seat,
    stack: 1_000,
    is_bot: member.isBot,
    // A profile this build knows, so a bot seat is not refused for an unrelated reason.
    bot_profile: member.isBot ? 'tight-aggressive' : null,
    bot_difficulty: member.isBot ? ('realistic' as const) : null,
    bot_seed: member.isBot ? 17 : null,
    joined_at: new Date(),
    left_at: null,
  }));
  return {
    create: () => refuse('create'),
    byId: () => Promise.resolve(row),
    byInviteCode: () => Promise.resolve(null),
    listForUser: () => Promise.resolve([]),
    membersOfRooms: () => Promise.resolve(rows),
    memberOf: (_roomId, userId) => Promise.resolve(rows.find((entry) => entry.user_id === userId) ?? null),
    addMember: () => refuse('addMember'),
    seatMember: (_roomId, userId) => Promise.resolve(`mem_${userId}`),
    unseatMember: (_roomId, userId) => {
      unseated.push(userId);
      return Promise.resolve();
    },
    recordFirstSit: () => Promise.resolve(true),
    removeMember: () => Promise.resolve(),
    close: () => Promise.resolve(true),
    closePracticeTable: () => refuse('closePracticeTable'),
    createBotUser: () => refuse('createBotUser'),
    readUnits: () => Promise.resolve(10_000),
  };
}

async function restoreRoom(
  entitlement: SeatEntitlement | null,
  members: readonly { readonly userId: string; readonly seat: number; readonly isBot: boolean }[],
): Promise<{
  readonly registry: RoomRegistry;
  readonly metrics: AppMetrics;
  readonly problems: { message: string; detail: ProblemDetail }[];
  /** Users whose durable seat was given back. See the phantom-chair case below. */
  readonly unseated: string[];
}> {
  const metrics = new AppMetrics();
  const problems: { message: string; detail: ProblemDetail }[] = [];
  const unseated: string[] = [];
  const registry = new RoomRegistry({
    clock: createManualClock(),
    random: createSecureRandom(),
    store: rosterStore(members, unseated),
    metrics,
    onProblem: (message, detail) => problems.push({ message, detail }),
    ...(entitlement === null ? {} : { entitlement }),
  });
  await registry.ensureOpen(ROOM_ID);
  return { registry, metrics, problems, unseated };
}

describe('a room re-opened after a restart', () => {
  /**
   * Nothing ejects a seated learner mid-session, so a restart is when entitlement is asked again.
   * Restoring from the durable row alone would ignore a revocation until some later deploy.
   */
  it('does not give the chair back to somebody who is no longer entitled', async () => {
    const restored = await restoreRoom(fakeEntitlement([]), [{ userId: ADA, seat: 0, isBot: false }]);
    const room = restored.registry.require(ROOM_ID, ADA);
    assert.equal(room.table.seatOf(ADA), null, 'an unentitled learner was put back in their seat');
    assert.equal(
      counterValue(restored.metrics, 'prl_seat_entitlement_refusals_total', 'reason="seat_not_restored"'),
      1,
    );
    assert.equal(
      counterValue(restored.metrics, 'prl_seat_entitlement_refusals_total', 'reason="not_entitled"'),
      0,
      'nobody asked for this seat, so it is not a request-path refusal',
    );
  });

  /**
   * `seat-retake` is an actor failure that feeds `prl_table_actor_failures_total` and a page-tier
   * runbook. A chair left empty on purpose stalls nothing. See `docs/production/runbooks/stuck-seat.md`.
   */
  it('reports it as its own kind rather than as a seat that could not be re-taken', async () => {
    const restored = await restoreRoom(fakeEntitlement([]), [{ userId: ADA, seat: 0, isBot: false }]);
    const events = restored.problems.map((problem) => problem.detail.event);
    assert.deepEqual(events, ['seat-entitlement']);
    assert.equal(
      counterValue(restored.metrics, 'prl_table_actor_failures_total', 'reason="seat-retake"'),
      null,
      'a seat left empty on purpose must not read as a table with nobody to act',
    );
  });

  /**
   * `room_members_live_seat_key` is UNIQUE `(room_id, seat) WHERE left_at IS NULL`, so a row that still
   * names seat 0 holds it. Leaving it showed the chair free while the next learner got `seat_taken` for
   * the life of the room, the same state `standFromTable` records as an incident.
   * Only `seat` is given back. The membership and the stack stay.
   */
  it('gives the durable seat back, so the chair is usable by somebody else (NEGATIVE CONTROL)', async () => {
    const restored = await restoreRoom(fakeEntitlement([]), [{ userId: ADA, seat: 0, isBot: false }]);
    assert.equal(restored.registry.require(ROOM_ID, ADA).table.seatOf(ADA), null);
    assert.deepEqual(
      restored.unseated,
      [ADA],
      'the durable seat was left held by a learner who is not in it, so nobody else can take it',
    );
    const problem = restored.problems.find((entry) => entry.detail.event === 'seat-entitlement');
    assert.equal(problem?.detail['freed'], true, 'the log must say whether the chair actually came free');
  });

  it('gives the chair back to somebody who still is entitled', async () => {
    const restored = await restoreRoom(fakeEntitlement([ADA]), [{ userId: ADA, seat: 0, isBot: false }]);
    assert.equal(restored.registry.require(ROOM_ID, ADA).table.seatOf(ADA), 0);
    assert.deepEqual(restored.problems, []);
    assert.deepEqual(restored.unseated, [], 'a restored chair must not be handed back to the pool');
  });

  /**
   * Bots have user rows but can never hold an enrolment. Asking would empty every AI table on the
   * first restart of an enforcing deployment.
   */
  it('never asks about a bot seat, and restores it', async () => {
    const entitlement = fakeEntitlement([ADA]);
    const restored = await restoreRoom(entitlement, [
      { userId: ADA, seat: 0, isBot: false },
      { userId: 'usr_bot1', seat: 1, isBot: true },
    ]);
    assert.deepEqual(entitlement.asked, [ADA], 'the bot seat was put through the entitlement read');
    assert.equal(restored.registry.require(ROOM_ID, ADA).table.seatOf('usr_bot1'), 1);
  });

  it('asks nothing at all when the switch is off, so a re-open costs no extra query', async () => {
    const restored = await restoreRoom(null, [
      { userId: ADA, seat: 0, isBot: false },
      { userId: BO, seat: 1, isBot: false },
    ]);
    assert.equal(restored.registry.enforcesEntitlement, false);
    assert.equal(restored.registry.require(ROOM_ID, ADA).table.seatOf(ADA), 0);
    assert.equal(restored.registry.require(ROOM_ID, ADA).table.seatOf(BO), 1);
  });
});

describe('the close code an enrolment refusal would carry', () => {
  /**
   * The `sit` guard never closes a socket. Any future path that closes on this code gets the close
   * `ERROR_STATUS` implies, and that must be the permanent 4403, not the reconnect-in-a-loop 4503.
   */
  it('is 4403 and not 4503: an absent enrolment is not something waiting fixes', () => {
    assert.equal(wsCloseForError('enrolment_required'), WS_CLOSE.forbidden);
    assert.notEqual(wsCloseForError('enrolment_required'), WS_CLOSE.serverShuttingDown);
    assert.ok(
      ERROR_STATUS.enrolment_required < 500,
      'a 5xx status would route this to the retry-with-backoff close code',
    );
    // The one refusal that IS retryable.
    assert.equal(wsCloseForError('room_owned_elsewhere'), WS_CLOSE.serverShuttingDown);
  });

  it('says nothing about money, because this software cannot take any', () => {
    assert.doesNotMatch(
      ERROR_MESSAGES.enrolment_required,
      /\b(pay|paid|price|cost|fee|purchase|buy|card|subscription)\b/iu,
      'the refusal must not imply a transaction: a scholarship enrolment and any other are the ' +
        'same row, and nothing here can take money',
    );
    assert.match(
      ERROR_MESSAGES.enrolment_required,
      /ask whoever enrols your class/iu,
      'the refusal has to say what to do next, or it is a bare 403 with extra words',
    );
  });
});

/**
 * Drives the registry `registerApiRoutes` builds, the only one a deployment has. Dropping the
 * `postgresSeatEntitlement(getSql)` line in `routes/index.ts` would leave every other test green and
 * `enforced` doing nothing. Asserted in both directions, because always binding breaks every existing
 * deployment.
 */
describe('the assembled app', () => {
  // Once per process, because `db.ts` refuses a second pool. Never dialled, since
  // `postgresSeatEntitlement` takes a getter and issues no query at wiring time.
  let databaseReady = false;

  const wire = async (enrolmentRequired: string | undefined): Promise<RoomRegistry> => {
    resetRoomRegistryForTests();
    const config = testConfig(
      enrolmentRequired === undefined ? {} : { PRL_ENROLMENT_REQUIRED: enrolmentRequired },
    );
    if (!databaseReady) {
      configureDatabase(config);
      databaseReady = true;
    }
    const app = await buildApp({ config, database: stubDatabase, metrics: new AppMetrics() });
    await registerApiRoutes(app);
    await app.ready();
    const registry = roomRegistry();
    await app.close();
    return registry;
  };

  after(async () => {
    resetRoomRegistryForTests();
    await closeSharedPool();
    await closeDatabase(1_000);
  });

  it('binds the entitlement read when the config says enforced', async () => {
    const registry = await wire('enforced');
    assert.equal(
      registry.enforcesEntitlement,
      true,
      'PRL_ENROLMENT_REQUIRED=enforced assembled a registry that gates nothing: every learner ' +
        'would be seated, and every test would still be green',
    );
  });

  it('binds nothing when it is off, and off is what an unset variable means', async () => {
    assert.equal((await wire('off')).enforcesEntitlement, false);
    assert.equal(
      (await wire(undefined)).enforcesEntitlement,
      false,
      'an existing deployment that sets nothing must keep behaving exactly as it did',
    );
  });
});

describe('reading PRL_ENROLMENT_REQUIRED', () => {
  it('defaults to off, so every existing deployment keeps working', () => {
    assert.equal(testConfig().enrolmentRequired, 'off');
  });

  it('accepts both values, in any case', () => {
    assert.equal(testConfig({ PRL_ENROLMENT_REQUIRED: 'enforced' }).enrolmentRequired, 'enforced');
    assert.equal(testConfig({ PRL_ENROLMENT_REQUIRED: 'ENFORCED' }).enrolmentRequired, 'enforced');
    assert.equal(testConfig({ PRL_ENROLMENT_REQUIRED: 'off' }).enrolmentRequired, 'off');
  });

  /** `true` is the realistic typo, and silently taking `off` from it would leave a cohort's tables open. */
  it('refuses an unrecognised value at boot rather than falling back', () => {
    for (const value of ['true', 'on', '1', 'required', 'yes']) {
      assert.throws(
        () => testConfig({ PRL_ENROLMENT_REQUIRED: value }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigError);
          assert.ok(
            error.problems.some((problem) => problem.includes('PRL_ENROLMENT_REQUIRED')),
            `the refusal must name the variable; got ${error.problems.join(' | ')}`,
          );
          return true;
        },
        `"${value}" was accepted`,
      );
    }
  });
});

/**
 * The real binding must let a failed read propagate. Swallowing it would render a database outage as
 * the permanent `enrolment_required` instead of a retryable `internal_error`.
 * The registry case above uses a fake, so it cannot see this.
 */
describe('the real seat entitlement, with no database behind it', () => {
  it('lets a failed read propagate rather than answering "not entitled"', async () => {
    const failure = new Error('connection terminated unexpectedly');
    const guard = postgresSeatEntitlement(() => {
      throw failure;
    });
    await assert.rejects(
      () => guard.entitledToSit('usr_ada'),
      (error: unknown) => error === failure,
      'a database that could not answer was reported as a withdrawn enrolment',
    );
  });

  it('answers false only when the query itself says nobody is entitled', async () => {
    // Positive control. A binding that rethrew everything would satisfy the case above too.
    const answering = (rows: readonly unknown[]): Db => (() => Promise.resolve([...rows])) as unknown as Db;
    const nobody = postgresSeatEntitlement(() => answering([]));
    assert.equal(await nobody.entitledToSit('usr_ada'), false);
    const somebody = postgresSeatEntitlement(() =>
      answering([
        { id: 'enr_1', cohort_id: 'coh_1', cohort_key: 'k', cohort_name: 'n', from: new Date(), until: null },
      ]),
    );
    assert.equal(await somebody.entitledToSit('usr_ada'), true);
  });
});
