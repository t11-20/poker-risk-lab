/**
 * `PRL_ENROLMENT_REQUIRED`: who may take a seat, over BOTH transports, in every state.
 *
 * ## Why one file for two transports
 *
 * There are exactly three call sites of `LiveTable.sit` in this codebase — `sitAtTable`, the
 * restore loop in `ensureOpen`, and `seatBot` — and `sitAtTable` is the only one a person reaches.
 * `POST /rooms/:roomId/sit` and the socket `sit` frame both call it and nothing else, which is the
 * property the guard rests on. A guard that held on the REST route and not on the frame would be
 * worse than none: it would read as enforced, its own tests would pass, and the entire product
 * would be reachable through the transport nobody checked. So the two are asserted side by side,
 * against one registry, with the same fake and the same principals, and the socket case drives a
 * real `sit` FRAME through `WsRouter.handleFrame` rather than calling the method under it.
 *
 * ## The matrix
 *
 * `SeatEntitlement.entitledToSit` answers a boolean, so the four ways of not being entitled —
 * never enrolled, revoked, expired, not yet started, plus a cohort that has ended — are one case
 * here and are separated where they are actually decided: `test/enrolments-database.test.ts` runs
 * each of them against a real schema and PostgreSQL's own `now()`, because the window is
 * `greatest(...)`/`least(...)` in SQL and a fake would be asserting that a reimplementation agrees
 * with itself. This file's job is the other half — that a `false` from that read stops a seat on
 * both transports, that a `true` does not, and that `off` changes nothing at all.
 *
 * ## The negative control this file IS
 *
 * Every refusal here was demonstrated failing against the code as it stood before the guard
 * existed: with `entitlement` omitted (which is `off`, and the shipped default), the "refuses"
 * cases all seat the learner and the assertions fail. That is not a claim about a past run — it is
 * the `the switch off` group below, which asserts exactly that behaviour and would go red if the
 * guard ever became unconditional. The two groups are each other's control.
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
import type { SeatEntitlement } from '../src/rooms/entitlement.ts';
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

/** Ada is the learner every case seats or refuses. Bo exists so the room has a second member. */
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
 * An entitlement that answers from a set, and counts what it was asked.
 *
 * The call count is asserted as well as the answer, because "the switch is off" has to mean the
 * read does not happen at all: a registry that asked and ignored the answer would pass every
 * behavioural assertion here while adding a query per seat and per member of every room re-open on
 * deployments that opted out.
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
 * One room, two members, neither seated, reachable over both transports.
 *
 * The room is opened directly rather than created through `POST /rooms`, so `openRoomFor` in
 * `routes/rooms.ts` takes its live branch and the store is only asked the three things seating
 * needs — which is all `seatingOnlyStore` answers, and every other method of it throws rather than
 * quietly returning something a test did not intend.
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
  // Without one, every inbound frame is refused `invalid_request` and this file would be asserting
  // that the validator rejects a `sit` rather than that the guard does. Same seam, same reason, as
  // `appWithValidator` in `test/ws-router.test.ts`.
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

// ---------------------------------------------------------------------------
// The REST transport
// ---------------------------------------------------------------------------

/** `POST /rooms/:roomId/sit`, as a browser sends it: signed session cookie and a CSRF pair. */
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

// ---------------------------------------------------------------------------
// The socket transport
// ---------------------------------------------------------------------------

interface SocketRun {
  readonly frames: readonly { readonly type: string; readonly [key: string]: unknown }[];
  readonly closes: readonly { readonly code: number; readonly reason: string }[];
}

/**
 * Drives a real `sit` FRAME: open, `hello`, `sit`, and everything the router said back.
 *
 * Deliberately not a call to `registry.sitAtTable`. The whole risk this guard exists against is a
 * socket path that does not reach the guarded method, and a test that calls the method cannot see
 * that. Every frame here goes through `handleFrame`, so it is validated by the real compiled Ajv
 * schema and routed by the real switch.
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

/** The value of one counter series, read out of the rendered exposition. */
function counterValue(metrics: AppMetrics, name: string, labels: string): number | null {
  const line = metrics.registry
    .render()
    .split('\n')
    .find((row) => row.startsWith(`${name}{${labels}}`));
  return line === undefined ? null : Number(line.slice(line.lastIndexOf(' ') + 1));
}

// ---------------------------------------------------------------------------
// Enforced
// ---------------------------------------------------------------------------

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
   * The refusal must not close the socket, and this is the assertion that says so.
   *
   * A `sit` refusal is an error FRAME and nothing more: the socket is still perfectly good, the
   * reader may keep watching the table, ping it and read state from it, and none of that is the
   * course. Closing here would also throw away the one place the refusal is displayed
   * (`ConnectionNotices` in `apps/web/src/app/play/LiveTable.tsx` renders `table.notice`), and the
   * client would reconnect and show a connection problem instead of the reason.
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
   * The read is asked BEFORE anything durable happens.
   *
   * `sitAtTable` writes the seat to the database before it tells the live table, and gives the row
   * back if the table refuses. A guard placed after that write would work and would leave a
   * refused learner's seat briefly allocated to them — visible to another client racing for the
   * same chair, and left behind entirely if the process died in the window.
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
   * A database that cannot answer must not produce `enrolment_required`.
   *
   * That code is permanent — `wsCloseForError` maps 4xx to a close the client never retries — so
   * answering it for a transient fault would tell a genuinely enrolled learner, forever, that they
   * are not. The seat is still refused (fail closed); it is refused as `internal_error`, which is
   * 500 and therefore the retryable branch on both transports.
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

// ---------------------------------------------------------------------------
// Off — the shipped default, and the control for everything above
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The third way to end up in a chair: a restart putting you back in it
// ---------------------------------------------------------------------------

/**
 * A store that holds one room and a roster, so `ensureOpen` has seats to restore.
 *
 * `seatingOnlyStore` deliberately answers `byId: null` and an empty roster, which is right for
 * every other suite and useless here — the whole subject is what `ensureOpen` does with recorded
 * seats. Everything not needed throws, for the reason `helpers/live-room.ts` gives: a fake that
 * quietly answers a call the test did not intend hides a missing assertion.
 */
function rosterStore(
  members: readonly { readonly userId: string; readonly seat: number; readonly isBot: boolean }[],
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
    // A profile this build knows, so a bot seat is genuinely rehydrated rather than refused for an
    // unrelated reason and mistaken for the entitlement guard.
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
    seatMember: () => Promise.resolve(),
    unseatMember: () => Promise.resolve(),
    removeMember: () => Promise.resolve(),
    close: () => Promise.resolve(true),
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
}> {
  const metrics = new AppMetrics();
  const problems: { message: string; detail: ProblemDetail }[] = [];
  const registry = new RoomRegistry({
    clock: createManualClock(),
    random: createSecureRandom(),
    store: rosterStore(members),
    metrics,
    onProblem: (message, detail) => problems.push({ message, detail }),
    ...(entitlement === null ? {} : { entitlement }),
  });
  await registry.ensureOpen(ROOM_ID);
  return { registry, metrics, problems };
}

describe('a room re-opened after a restart', () => {
  /**
   * The gap this closes: a revocation that stops applying to the one person it was aimed at.
   *
   * Nothing ejects a seated learner mid-session, by design — their chair is theirs until they
   * stand. The next restart is the moment the question is asked again, and answering it with the
   * durable row alone would mean an expired or withdrawn enrolment is quietly ignored for as long
   * as nobody deploys, then applied months later at a deploy nobody connects to it.
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
   * The reported event is `seat-entitlement`, and specifically NOT `seat-retake`.
   *
   * `seat-retake` is classified as an ACTOR failure — "it is somebody's turn and nothing is going
   * to act" — and increments `prl_table_actor_failures_total`, which has a page-tier runbook about
   * stalled tables. A chair deliberately left empty stalls nothing. Reusing the nearest existing
   * kind is the mistake `docs/production/runbooks/stuck-seat.md` records having been made once
   * already, and this assertion is what stops it being made again here.
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

  it('gives the chair back to somebody who still is entitled', async () => {
    const restored = await restoreRoom(fakeEntitlement([ADA]), [{ userId: ADA, seat: 0, isBot: false }]);
    assert.equal(restored.registry.require(ROOM_ID, ADA).table.seatOf(ADA), 0);
    assert.deepEqual(restored.problems, []);
  });

  /**
   * A bot is never asked, and this is the assertion that keeps every Legends table alive.
   *
   * Bots have real user rows — a seat is a seat whoever occupies it — and can never hold an
   * enrolment, because nothing enrols them and the operator tool works on accounts a person signed
   * in with. Asking would empty every AI table on the first restart of an enforcing deployment,
   * which is a total outage of the feature dressed as a security control.
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

// ---------------------------------------------------------------------------
// The close code
// ---------------------------------------------------------------------------

describe('the close code an enrolment refusal would carry', () => {
  /**
   * The `sit` guard never closes a socket, so this is about the OTHER paths.
   *
   * `wsCloseForError` is exhaustive over `ErrorCode` by construction — it reads `ERROR_STATUS` —
   * so any future path that closes on this code (a `hello`-time gate, a broadened `guard`) gets
   * whatever the status implies, without anybody choosing again. This asserts that what it implies
   * is the PERMANENT branch, because a client that reconnects in a loop against a refusal only an
   * operator can lift is a defect, and 4503 is exactly the code that instructs it to.
   */
  it('is 4403 and not 4503: an absent enrolment is not something waiting fixes', () => {
    assert.equal(wsCloseForError('enrolment_required'), WS_CLOSE.forbidden);
    assert.notEqual(wsCloseForError('enrolment_required'), WS_CLOSE.serverShuttingDown);
    assert.ok(
      ERROR_STATUS.enrolment_required < 500,
      'a 5xx status would route this to the retry-with-backoff close code',
    );
    // The contrast that makes the choice legible: the one refusal that IS retryable.
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

// ---------------------------------------------------------------------------
// The wiring, on the app that is actually assembled
// ---------------------------------------------------------------------------

/**
 * Everything above drives a registry this file constructed. This drives the one `registerApiRoutes`
 * builds, which is the only one a deployment has.
 *
 * The failure it guards against is silent and looks exactly like success: drop the one line in
 * `routes/index.ts` that passes `postgresSeatEntitlement(getSql)` and every test in this package
 * stays green, every room opens, every learner is seated, and `PRL_ENROLMENT_REQUIRED=enforced`
 * does nothing whatsoever. That is the same failure `test/wiring.test.ts` guards for the room
 * lease, and its comment records the same mistake having been made once already for the archive.
 *
 * Asserted in BOTH directions, because a wiring that ignored the config and always bound one would
 * pass a one-sided test and would break every existing deployment.
 *
 * `configureDatabase` is called and never dialled: `postgresSeatEntitlement` takes a getter, so
 * building the registry issues no query, which is itself part of what is being asserted.
 */
describe('the assembled app', () => {
  // Once per process, and never dialled. `db.ts` refuses a second pool outright, which is why this
  // is here rather than inside `wire` — and the connection details are irrelevant to the question,
  // because `postgresSeatEntitlement` takes a getter and issues no query at wiring time.
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

// ---------------------------------------------------------------------------
// The switch itself
// ---------------------------------------------------------------------------

describe('reading PRL_ENROLMENT_REQUIRED', () => {
  it('defaults to off, so every existing deployment keeps working', () => {
    assert.equal(testConfig().enrolmentRequired, 'off');
  });

  it('accepts both values, in any case', () => {
    assert.equal(testConfig({ PRL_ENROLMENT_REQUIRED: 'enforced' }).enrolmentRequired, 'enforced');
    assert.equal(testConfig({ PRL_ENROLMENT_REQUIRED: 'ENFORCED' }).enrolmentRequired, 'enforced');
    assert.equal(testConfig({ PRL_ENROLMENT_REQUIRED: 'off' }).enrolmentRequired, 'off');
  });

  /**
   * `true` is the realistic typo, and taking `off` from it is the dangerous outcome.
   *
   * Somebody who writes `PRL_ENROLMENT_REQUIRED=true` has decided to enforce and believes they
   * have. A silent fallback would leave a cohort's tables open to the internet while the
   * deployment's own configuration said otherwise, and nothing would ever say so.
   */
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
