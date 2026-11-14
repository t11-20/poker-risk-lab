/**
 * Units are the chips in front of a learner. Starting a practice table must not mint a stack, and a
 * reset must reach the live table the learner sits at.
 * The fake store in `test/rooms.test.ts` answers `readUnits` from a constant, so these run over the
 * real stores in one rolled-back transaction. Nothing is committed.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';
import { API_PATHS, WS_CLOSE } from '@prl/contracts';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { AppMetrics } from '../src/observability/metrics.ts';
import type { ProblemDetail } from '../src/observability/telemetry.ts';
import { newRoomMemberId } from '../src/repositories/ids.ts';
import * as roomsRepository from '../src/repositories/rooms.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { postgresArchive, postgresRoomStore, RoomRegistry, type RoomStore } from '../src/rooms/registry.ts';
import { LiveTable, type SettledStack } from '../src/rooms/table.ts';
import { createManualClock, type ManualClock } from '../src/rooms/timers.ts';
import { type AuthStore, createAuthRoutes } from '../src/routes/auth.ts';
import { createRoomRoutes } from '../src/routes/rooms.ts';
import { createWsHub } from '../src/ws/hub.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';
import { stubDatabase, testConfig } from './helpers/hands-app.ts';
import { accountFor, fixedSessionStore } from './helpers/live-room.ts';

const ALLOWED_ORIGIN = 'http://localhost:3000';
const TOKEN = 'tok_practice_units';
const CSRF_ROUTE = '/api/v1/test-csrf-practice-units';

let client: Sql | null = null;
let skipReason: string | false = databaseSkip('the units of a learner at practice tables');
if (TEST_DATABASE_URL !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
        SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
        DATABASE_POOL_MAX: '2',
      }),
    );
    await probe`select 1 from prl.users limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `prl schema is not reachable (${error instanceof Error ? error.name : 'error'}): run pnpm db:migrate`;
  }
}
if (skipReason !== false) {
  console.info(`[practice-table-units.test.ts] skipping database-backed tests: ${skipReason}`);
}
const dbOptions = { skip: skipReason };

after(async () => {
  if (client !== null) await client.end({ timeout: 5 });
});

const ROLLBACK = new Error('rollback: this transaction was only ever a test');

async function inRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const handle = client;
  if (handle === null) throw new Error('inRollback called without a database');
  try {
    await handle.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly registry: RoomRegistry;
  readonly clock: ManualClock;
  readonly metrics: AppMetrics;
  readonly userId: string;
  readonly problems: { message: string; detail: ProblemDetail }[];
  readonly wsUrl: string | null;
  readonly send: (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) => Promise<{ status: number; body: unknown }>;
}

interface HarnessOptions {
  readonly wrap?: (store: RoomStore) => RoomStore;
  readonly hub?: boolean;
}

/** Assembled as `routes/index.ts` does, with only the session lookup replaced. */
async function harness(tx: TransactionSql, options: HarnessOptions = {}): Promise<Harness> {
  const wrap = options.wrap ?? ((store: RoomStore) => store);
  const user = await usersRepository.createGuest(tx, { displayName: 'Reader' });
  const problems: { message: string; detail: ProblemDetail }[] = [];
  const clock = createManualClock();
  const metrics = new AppMetrics();
  const registry = new RoomRegistry({
    clock,
    metrics,
    random: createSecureRandom(),
    store: wrap(postgresRoomStore(() => tx)),
    archive: postgresArchive(() => tx),
    botThinkingDelayMs: 5,
    onProblem: (message, detail) => problems.push({ message, detail }),
  });
  const sessions = fixedSessionStore(
    new Map([[TOKEN, { sessionId: 'ses_practice', user: accountFor(user.id, 'Reader') }]]),
  );
  const refuse = (name: string): never => {
    throw new AppError('internal_error', { logDetail: `this harness has no ${name}` });
  };
  const authStore: AuthStore = {
    sessions,
    users: {
      createGuest: () => refuse('createGuest'),
      findOrCreateOidc: () => refuse('findOrCreateOidc'),
      readUnits: async (userId) => (await usersRepository.readUnits(tx, userId)).units,
      resetUnits: async (userId) => (await usersRepository.resetUnits(tx, userId)).units,
      deleteAccount: () => refuse('deleteAccount'),
    },
    oidcAttempts: { create: () => refuse('oidc create'), consume: () => refuse('oidc consume') },
  };

  const app = await buildApp({ config: testConfig(), database: stubDatabase });
  app.get(CSRF_ROUTE, async (_request, reply) => ({ token: reply.generateCsrf() }));
  await app.register(createAuthRoutes({ store: authStore, tables: registry }), { prefix: '/api/v1' });
  await app.register(createRoomRoutes({ registry, sessionStore: sessions }), { prefix: '/api/v1' });
  let wsUrl: string | null = null;
  if (options.hub === true) {
    await app.register(createWsHub({ registry, sessionStore: sessions }), { prefix: '/api/v1' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    wsUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}${API_PATHS.ws()}`;
  } else {
    await app.ready();
  }

  const send: Harness['send'] = async (method, url, payload) => {
    const seed = await app.inject({ method: 'GET', url: CSRF_ROUTE });
    const token = String(Reflect.get(seed.json() as object, 'token'));
    const csrf = seed.cookies.find((entry) => entry.name === 'prl_csrf');
    assert.ok(csrf !== undefined, 'the security plugin issued no CSRF cookie');
    const response = await app.inject({
      method,
      url,
      headers: { origin: ALLOWED_ORIGIN, 'x-csrf-token': token },
      cookies: { prl_session: app.signCookie(TOKEN), prl_csrf: csrf.value },
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.json() };
  };
  return { app, registry, clock, metrics, userId: user.id, problems, wsUrl, send };
}

/** Mirrors `openPracticeRoom` in `use-live-table.ts`. */
function matchAgainst(profileId: string): object {
  return {
    profileIds: [profileId],
    difficulty: 'educational',
    startingStack: 1_000,
    smallBlind: 5,
    bigBlind: 10,
  };
}

async function startMatch(test: Harness, profileId: string): Promise<string> {
  const created = await test.send('POST', '/api/v1/legends/matches', matchAgainst(profileId));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return String(Reflect.get(created.body as object, 'roomId'));
}

async function units(tx: TransactionSql, userId: string): Promise<number> {
  return (await usersRepository.readUnits(tx, userId)).units;
}

describe('units across practice tables', dbOptions, () => {
  it('a closed table holds no units', async () => {
    await inRollback(async (tx) => {
      const owner = await usersRepository.createGuest(tx, { displayName: 'Owner' });
      const { room } = await roomsRepository.create(tx, {
        name: 'Kitchen table',
        ownerUserId: owner.id,
        maxSeats: 2,
        smallBlind: 1,
        bigBlind: 2,
        startingStack: 1_000,
      });
      await roomsRepository.addMember(tx, { roomId: room.id, userId: owner.id, stack: 400 });
      // Only a table the learner has sat at holds units.
      await roomsRepository.seatMember(tx, room.id, owner.id, 0);
      assert.equal(await units(tx, owner.id), 400, 'the chips in front of them');

      // A closed table holds nothing, so the learner is back on the allowance.
      await roomsRepository.close(tx, room.id, { ownerUserId: owner.id });
      assert.equal(await units(tx, owner.id), usersRepository.DEFAULT_UNIT_ALLOWANCE);
    });
  });

  it('starting three Legends matches leaves the reader with one table of units, not three', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      assert.equal(await units(tx, test.userId), 1_000, 'a fresh reader has the allowance');

      const first = await startMatch(test, 'calling-station');
      const sat = await test.send('POST', `/api/v1/rooms/${first}/sit`, { seat: 0 });
      assert.equal(sat.status, 200, JSON.stringify(sat.body));
      const firstRoom = test.registry.get(first);
      assert.ok(firstRoom !== null);
      await firstRoom.table.startHand();
      assert.equal(await units(tx, test.userId), 1_000);

      const second = await startMatch(test, 'vocal-aggressor');
      const third = await startMatch(test, 'patient-technician');
      assert.equal(
        await units(tx, test.userId),
        1_000,
        'each match used to add a 1,000-unit membership: 1,000 → 2,000 → 3,000',
      );

      test.clock.advance(60_000);
      await new Promise((resolve) => setImmediate(resolve));
      await firstRoom.archiveSettled();

      for (const retired of [first, second]) {
        assert.equal((await roomsRepository.byId(tx, retired))?.status, 'closed');
        assert.equal(test.registry.get(retired), null, 'the live table went with the row');
      }
      assert.equal((await roomsRepository.byId(tx, third))?.status, 'open');

      // The left hand is played out as a fold. Abandoning it at net zero would void a losing hand, and
      // counting it failed would page `HandsFailing`.
      const hands = await tx<{ completed: boolean; abandoned: string | null; status: string }[]>`
        select h.completed_at is not null as completed, h.result ->> 'abandoned' as abandoned, s.status
          from prl.hands h
          join prl.hand_seats s on s.hand_id = h.id and s.user_id = ${test.userId}
         where h.room_id = ${first}
      `;
      assert.equal(hands.length, 1, 'the dealt hand was archived');
      assert.deepEqual(
        hands.map((hand) => ({ ...hand })),
        [{ completed: true, abandoned: null, status: 'folded' }],
        'the hand the reader left settled as a fold',
      );
      assert.equal(test.metrics.handsFailed.get({ reason: 'room_closed' }), 0, 'nobody is paged for it');
      assert.equal(test.metrics.handsCompleted.get(), 1);
      assert.deepEqual(test.problems, [], 'retiring wrote everything it meant to');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('never retires a table with a chair for another person', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const friends = await test.send('POST', '/api/v1/rooms', {
        name: 'Private table',
        maxSeats: 6,
        smallBlind: 5,
        bigBlind: 10,
        startingStack: 1_000,
        actionTimeoutSeconds: 60,
        bots: [
          { profile: 'tight-aggressive', count: 1 },
          { profile: 'calling-station', count: 1 },
        ],
      });
      assert.equal(friends.status, 201, JSON.stringify(friends.body));
      const friendsId = String(Reflect.get(Reflect.get(friends.body as object, 'room') as object, 'id'));

      await startMatch(test, 'calling-station');
      await startMatch(test, 'patient-technician');
      assert.equal((await roomsRepository.byId(tx, friendsId))?.status, 'open');
      assert.ok(test.registry.get(friendsId) !== null);
      assert.equal(await units(tx, test.userId), 1_000, 'no table the reader has sat at holds units');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a reset reaches the table the reader is sitting at, so they are dealt in again', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const roomId = await startMatch(test, 'calling-station');
      assert.equal((await test.send('POST', `/api/v1/rooms/${roomId}/sit`, { seat: 0 })).status, 200);

      // Busted the way a restart does it, so no hand has to be lost on purpose.
      await roomsRepository.updateMemberStack(tx, roomId, test.userId, 0);
      test.registry.close(roomId);
      assert.equal((await test.send('GET', `/api/v1/rooms/${roomId}`)).status, 200);
      const stackOf = (): number | undefined =>
        test.registry
          .get(roomId)
          ?.table.snapshot()
          .seats.find((seat) => seat.userId === test.userId)?.stack;
      assert.equal(stackOf(), 0, 'precondition: seated with nothing');

      const reset = await test.send('POST', '/api/v1/me/units/reset');
      assert.equal(reset.status, 200, JSON.stringify(reset.body));
      assert.equal(Reflect.get(reset.body as object, 'units'), 1_000);
      assert.equal(stackOf(), 1_000, 'the live table was left holding 0 after "back to 1000"');

      const room = test.registry.get(roomId);
      assert.ok(room !== null);
      await room.table.startHand();
      assert.equal(room.table.viewFor(test.userId)?.viewerSeat, 0, 'the reader is dealt in');
      await room.archiveSettled();
      assert.equal(await units(tx, test.userId), 1_000);

      await test.registry.shutdown();
      await test.app.close();
    });
  });
});

/** Mirrors `FRIENDS_TABLE_REQUEST` in `apps/web/src/lib/table-rooms.ts`. */
const FRIENDS_TABLE = {
  name: 'Private table',
  maxSeats: 6,
  smallBlind: 5,
  bigBlind: 10,
  startingStack: 1_000,
  actionTimeoutSeconds: 60,
  bots: [
    { profile: 'tight-aggressive', count: 1 },
    { profile: 'calling-station', count: 1 },
  ],
};

/** The shape `retirePracticeTables` treats as a practice table. */
const HEADS_UP_TABLE = { ...FRIENDS_TABLE, maxSeats: 2, bots: [{ profile: 'nit', count: 1 }] };

async function createTable(test: Harness, body: object): Promise<{ id: string; inviteCode: string }> {
  const created = await test.send('POST', '/api/v1/rooms', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const room = Reflect.get(created.body as object, 'room') as object;
  return {
    id: String(Reflect.get(room, 'id')),
    inviteCode: String(Reflect.get(created.body as object, 'inviteCode')),
  };
}

async function statusOf(tx: TransactionSql, roomId: string): Promise<string | undefined> {
  return (await roomsRepository.byId(tx, roomId))?.status;
}

async function playOut(test: Harness, roomId: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    test.clock.advance(60_000);
    await new Promise((resolve) => setImmediate(resolve));
  }
  await test.registry.get(roomId)?.archiveSettled();
}

describe('only a table the reader has sat at holds units', dbOptions, () => {
  it('starting private tables and a match leaves the allowance, not a stack per table', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      // None of these is a practice table, so nothing retires them.
      const friends = [];
      for (let i = 0; i < 3; i += 1) friends.push(await createTable(test, FRIENDS_TABLE));
      await startMatch(test, 'calling-station');
      assert.equal(await units(tx, test.userId), 1_000, 'four rooms created, none sat at');
      for (const table of friends)
        assert.equal(await statusOf(tx, table.id), 'open', 'a friends table stays');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a table with no bots is never retired and holds nothing until the reader sits', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const bare = await createTable(test, { ...FRIENDS_TABLE, bots: undefined });
      assert.equal(await units(tx, test.userId), 1_000, 'the old sum counted the empty table as 1,000 more');
      await startMatch(test, 'calling-station');
      await startMatch(test, 'calling-station');
      assert.equal(await units(tx, test.userId), 1_000);
      assert.equal(await statusOf(tx, bare.id), 'open', 'bots === 0 is never a practice table');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a played table keeps its chips when the reader stands, and a busted one still asks for a reset', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const table = await createTable(test, FRIENDS_TABLE);
      const sit = (): Promise<{ status: number; body: unknown }> =>
        test.send('POST', `/api/v1/rooms/${table.id}/sit`, { seat: 0 });
      // The socket's `stand` frame calls exactly this.
      const stand = (): Promise<void> => test.registry.standFromTable(table.id, test.userId);
      const seatStack = (): number | undefined =>
        test.registry
          .get(table.id)
          ?.table.snapshot()
          .seats.find((seat) => seat.userId === test.userId)?.stack;

      assert.equal((await sit()).status, 200);
      const room = test.registry.get(table.id);
      assert.ok(room !== null);
      await room.table.startHand();
      await stand();
      await playOut(test, table.id);
      const settled = (await roomsRepository.memberOf(tx, table.id, test.userId))?.stack;
      assert.ok(settled !== undefined);
      assert.equal(seatStack(), undefined, 'precondition: the reader has left the chair');
      // Standing is not leaving. A `seat is not null` filter alone would drop them to the allowance.
      assert.equal(await units(tx, test.userId), settled, 'the chips of a table the reader played at');

      await roomsRepository.updateMemberStack(tx, table.id, test.userId, 1_500);
      assert.equal(await units(tx, test.userId), 1_500);
      assert.equal((await sit()).status, 200, 'the standing winner is not refused their own chips');
      assert.equal(seatStack(), 1_500);
      await startMatch(test, 'calling-station');
      assert.equal(await units(tx, test.userId), 1_500, 'the old sum read 2,500');

      await stand();
      await roomsRepository.updateMemberStack(tx, table.id, test.userId, 0);
      assert.equal(await units(tx, test.userId), 0);
      const refused = await sit();
      assert.equal(refused.status, 409, JSON.stringify(refused.body));
      const code = Reflect.get(Reflect.get(refused.body as object, 'error') as object, 'code');
      assert.equal(code, 'insufficient_units');
      assert.equal((await test.send('POST', '/api/v1/me/units/reset')).status, 200);
      assert.equal(await units(tx, test.userId), 1_000);
      assert.equal((await sit()).status, 200);
      assert.equal(seatStack(), 1_000);

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it("a first sit is drawn from the room, whatever the size of the room's stack", async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      // A never-sat membership is not counted, so `units < buyIn` would refuse any stack above the
      // allowance for good.
      const deep = await createTable(test, { ...FRIENDS_TABLE, startingStack: 5_000, bots: undefined });
      const sat = await test.send('POST', `/api/v1/rooms/${deep.id}/sit`, { seat: 0 });
      assert.equal(sat.status, 200, JSON.stringify(sat.body));
      assert.equal(await units(tx, test.userId), 5_000, 'seated: the chips in front of them');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('standing up before the first deal keeps the chips the room gave the first sit', async () => {
    await inRollback(async (tx) => {
      // Seated-now and dealt-in are both false here, but the room still holds 5,000 for the sit.
      const test = await harness(tx);
      const deep = await createTable(test, { ...FRIENDS_TABLE, startingStack: 5_000, bots: undefined });
      const sit = (): Promise<{ status: number; body: unknown }> =>
        test.send('POST', `/api/v1/rooms/${deep.id}/sit`, { seat: 0 });
      assert.equal(await units(tx, test.userId), 1_000, 'not sat at yet: the allowance');
      assert.equal((await sit()).status, 200);
      await test.registry.standFromTable(deep.id, test.userId);
      assert.equal(await units(tx, test.userId), 5_000, 'stood before a deal: the room still holds 5,000');
      assert.equal((await sit()).status, 200);
      assert.equal(await units(tx, test.userId), 5_000, 'and sitting again gives exactly that');

      for (let i = 0; i < 3; i += 1) await createTable(test, FRIENDS_TABLE);
      assert.equal(await units(tx, test.userId), 5_000, 'each unsat table used to add 1,000');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a sit the live table refuses is not a first sit', async () => {
    await inRollback(async (tx) => {
      // A leaver mid-hand still holds the live chair, so the database grants it and the live table
      // refuses. `first_seated_at` must not be written for that sit.
      const test = await harness(tx);
      // 2,000 so a counted membership differs from the allowance.
      const table = await createTable(test, { ...HEADS_UP_TABLE, startingStack: 2_000 });
      assert.equal((await test.send('POST', `/api/v1/rooms/${table.id}/sit`, { seat: 0 })).status, 200);
      const room = test.registry.get(table.id);
      assert.ok(room !== null);
      await room.table.startHand();
      const view = room.table.viewFor(test.userId);
      assert.ok(view !== null && view.toAct !== null);
      if (view.toAct === view.viewerSeat) {
        await room.table.submitAction(test.userId, {
          action: { type: 'call' },
          actionId: 'act-refusedsit1',
          expectedSequence: view.actionSequence,
        });
      }
      await test.registry.leaveRoom(table.id, test.userId);
      assert.equal(room.table.seatOf(test.userId), 0, 'precondition: the live chair still holds the hand');

      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      const principal = { userId: friend.id, displayName: 'Friend' };
      await test.registry.joinByInviteCode(principal, table.inviteCode);
      await assert.rejects(test.registry.sitAtTable(table.id, principal, 0), (error: unknown) => {
        assert.ok(error instanceof AppError);
        // A refusal from `seatMember` would be `seat_taken`.
        assert.equal(error.code, 'room_full', 'the live table, not the database, refused the chair');
        return true;
      });
      assert.equal(await units(tx, friend.id), 1_000, 'a refused sit used to count 2,000 for ever');
      const [row] = await tx<{ seat: number | null; sat: boolean }[]>`
        select seat, first_seated_at is not null as sat from prl.room_members
         where room_id = ${table.id} and user_id = ${friend.id} and left_at is null
      `;
      assert.deepEqual({ ...row }, { seat: null, sat: false }, 'the seat given back, and no first sit');

      await playOut(test, table.id);
      await test.registry.sitAtTable(table.id, principal, 0);
      assert.equal(await units(tx, friend.id), 2_000, 'seated: the chips in front of them');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a first sit that cannot be recorded leaves the sit standing, and says so', async () => {
    await inRollback(async (tx) => {
      // The write follows the live sit, so failing the request would report an error for a seat held.
      const test = await harness(tx, {
        wrap: (store) => ({
          ...store,
          recordFirstSit: () => Promise.reject(new Error('first sit refused by this test')),
        }),
      });
      const table = await createTable(test, { ...FRIENDS_TABLE, startingStack: 2_000, bots: undefined });
      const sat = await test.send('POST', `/api/v1/rooms/${table.id}/sit`, { seat: 0 });
      assert.equal(sat.status, 200, JSON.stringify(sat.body));
      assert.equal(test.registry.get(table.id)?.table.seatOf(test.userId), 0, 'seated at the live table');
      assert.equal(await units(tx, test.userId), 2_000, 'seated: counted without the column');
      assert.deepEqual(
        test.problems.map((problem) => problem.detail.event),
        ['first-sit-record'],
        'the unrecorded first sit was reported',
      );

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  /** Runs `inTheGap` before the next real `recordFirstSit`, with its arguments untouched. */
  function gateFirstSit(): {
    readonly wrap: (store: RoomStore) => RoomStore;
    arm: (inTheGap: () => Promise<void>) => void;
    readonly armed: () => boolean;
  } {
    let pending: (() => Promise<void>) | null = null;
    return {
      wrap: (store) => ({
        ...store,
        recordFirstSit: async (...args: Parameters<RoomStore['recordFirstSit']>) => {
          const inTheGap = pending;
          pending = null;
          if (inTheGap !== null) await inTheGap();
          return store.recordFirstSit(...args);
        },
      }),
      arm: (inTheGap) => {
        pending = inTheGap;
      },
      armed: () => pending !== null,
    };
  }

  it('a leave and rejoin while the first sit is written does not record it on the new membership', async () => {
    await inRollback(async (tx) => {
      // Found by (room, user, live), the write would land on a membership rejoined by another tab in the gap.
      const gate = gateFirstSit();
      const test = await harness(tx, { wrap: gate.wrap });
      const table = await createTable(test, { ...FRIENDS_TABLE, startingStack: 2_000, bots: undefined });
      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      const principal = { userId: friend.id, displayName: 'Friend' };
      await test.registry.joinByInviteCode(principal, table.inviteCode);
      gate.arm(async () => {
        await test.registry.leaveRoom(table.id, friend.id);
        await test.registry.joinByInviteCode(principal, table.inviteCode);
      });
      await test.registry.sitAtTable(table.id, principal, 3);
      assert.equal(gate.armed(), false, 'the leave and rejoin never ran in the gap, so this proved nothing');

      assert.equal(await units(tx, friend.id), 1_000, 'the new membership used to count 2,000');
      const rows = await tx<{ left: boolean; sat: boolean }[]>`
        select left_at is not null as left, first_seated_at is not null as sat
          from prl.room_members
         where room_id = ${table.id} and user_id = ${friend.id}
         order by left_at nulls last
      `;
      assert.deepEqual(
        rows.map((row) => ({ ...row })),
        [
          { left: true, sat: false },
          { left: false, sat: false },
        ],
        'the rejoined membership has not sat',
      );
      assert.deepEqual(test.problems, [], 'a membership that left in the gap is not a failure to record');

      await test.registry.sitAtTable(table.id, principal, 3);
      await test.registry.standFromTable(table.id, friend.id);
      assert.equal(await units(tx, friend.id), 2_000, 'sat at, then stood before a deal');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a stand while the first sit is written still records the sit', async () => {
    await inRollback(async (tx) => {
      // The write must not require a seat. A stand before the first deal keeps the room's chips.
      const gate = gateFirstSit();
      const test = await harness(tx, { wrap: gate.wrap });
      const table = await createTable(test, { ...FRIENDS_TABLE, startingStack: 2_000, bots: undefined });
      gate.arm(() => test.registry.standFromTable(table.id, test.userId));
      assert.equal((await test.send('POST', `/api/v1/rooms/${table.id}/sit`, { seat: 0 })).status, 200);
      assert.equal(gate.armed(), false, 'the stand never ran in the gap, so this proved nothing');
      assert.equal(test.registry.get(table.id)?.table.seatOf(test.userId), null, 'precondition: stood up');
      assert.equal(await units(tx, test.userId), 2_000, 'the sit happened, so the room holds 2,000 for them');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  /**
   * Runs `inTheGap` once between `rooms.seatMember`'s UPDATE and its read back. A store wrapper
   * cannot reach inside that call, so this wraps the connection.
   */
  function gateSeatReadback(tx: TransactionSql): {
    readonly tx: TransactionSql;
    arm: (inTheGap: () => Promise<void>) => void;
    readonly armed: () => boolean;
  } {
    let pending: (() => Promise<void>) | null = null;
    const isSeatUpdate = (first: unknown): boolean => {
      if (!Array.isArray(first) || !('raw' in first)) return false;
      const text = first.join('?');
      return text.includes('update prl.room_members m') && text.includes('set seat = ?');
    };
    const gated = new Proxy(tx, {
      apply: (target, self, args: unknown[]) => {
        const inTheGap = pending;
        if (inTheGap === null || !isSeatUpdate(args[0])) return Reflect.apply(target, self, args);
        pending = null;
        return (async () => {
          const rows: unknown = await Reflect.apply(target, self, args);
          await inTheGap();
          return rows;
        })();
      },
    });
    return {
      tx: gated,
      arm: (inTheGap) => {
        pending = inTheGap;
      },
      armed: () => pending !== null,
    };
  }

  async function assertLeftDuringSit(
    test: Harness,
    tx: TransactionSql,
    tableId: string,
    friendId: string,
  ): Promise<void> {
    const room = test.registry.get(tableId);
    assert.ok(room !== null);
    assert.equal(room.member(friendId), null, 'the learner who left used to be put back on the roster');
    assert.equal(room.table.seatOf(friendId), null, 'and seated at the live table');
    assert.throws(
      () => test.registry.require(tableId, friendId),
      (error: unknown) => error instanceof AppError && error.code === 'room_not_found_or_not_permitted',
      'require let a learner who had left into the room',
    );
    const rows = await tx<{ left: boolean; sat: boolean }[]>`
      select left_at is not null as left, first_seated_at is not null as sat
        from prl.room_members
       where room_id = ${tableId} and user_id = ${friendId}
    `;
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ left: true, sat: false }],
      'one membership, left, never sat',
    );
    assert.equal(await units(tx, friendId), 1_000, 'the allowance, and nothing from a table they left');
    assert.deepEqual(test.problems, [], 'a refused sit is not a problem to report');
    // The departed row keeps its seat number, outside both partial indexes.
    await test.registry.sitAtTable(tableId, { userId: test.userId, displayName: 'Reader' }, 3);
    assert.equal(room.table.seatOf(test.userId), 3, 'the owner takes the chair the leaver was refused');
  }

  it('a leave between taking the durable seat and reading it back refuses the sit', async () => {
    await inRollback(async (rawTx) => {
      // Reading back by id whether left or not would seat a leaver and put them back on the roster.
      const gate = gateSeatReadback(rawTx);
      const tx = gate.tx;
      const test = await harness(tx);
      const table = await createTable(test, { ...FRIENDS_TABLE, bots: undefined });
      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      const principal = { userId: friend.id, displayName: 'Friend' };
      await test.registry.joinByInviteCode(principal, table.inviteCode);
      gate.arm(() => test.registry.leaveRoom(table.id, friend.id));
      await assert.rejects(test.registry.sitAtTable(table.id, principal, 3), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'not_room_member', 'a sit by somebody who left is a non-member sit');
        return true;
      });
      assert.equal(gate.armed(), false, 'the leave never ran in the gap, so this proved nothing');
      await assertLeftDuringSit(test, tx, table.id, friend.id);

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('rooms.seatMember answers a membership that left before its read back as not a member', async () => {
    await inRollback(async (rawTx) => {
      // `sitAtTable` also checks the roster, so only this test holds `seatMember` itself to the rule.
      const gate = gateSeatReadback(rawTx);
      const tx = gate.tx;
      const owner = await usersRepository.createGuest(tx, { displayName: 'Owner' });
      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      const { room } = await roomsRepository.create(tx, {
        name: 'Private table',
        ownerUserId: owner.id,
        maxSeats: 6,
        smallBlind: 5,
        bigBlind: 10,
        startingStack: 1_000,
      });
      const notAMember = (error: unknown): boolean => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'not_room_member', 'a seat taken by a membership that has left');
        return true;
      };

      await roomsRepository.addMember(tx, { roomId: room.id, userId: friend.id });
      gate.arm(async () => {
        await roomsRepository.unseatMember(tx, room.id, friend.id);
        await roomsRepository.removeMember(tx, room.id, friend.id);
      });
      await assert.rejects(roomsRepository.seatMember(tx, room.id, friend.id, 3), notAMember);
      assert.equal(gate.armed(), false, 'the leave never ran in the gap, so this proved nothing');

      // A rejoin must not make `diagnoseMembershipFailure` answer `invalid_request`.
      await roomsRepository.addMember(tx, { roomId: room.id, userId: friend.id });
      gate.arm(async () => {
        await roomsRepository.removeMember(tx, room.id, friend.id);
        await roomsRepository.addMember(tx, { roomId: room.id, userId: friend.id });
      });
      await assert.rejects(roomsRepository.seatMember(tx, room.id, friend.id, 3), notAMember);
      assert.equal(gate.armed(), false, 'the leave and rejoin never ran in the gap, so this proved nothing');
      assert.equal(
        (await roomsRepository.memberOf(tx, room.id, friend.id))?.seat,
        null,
        'rejoined, unseated',
      );

      // The control.
      assert.equal((await roomsRepository.seatMember(tx, room.id, friend.id, 3)).seat, 3);
    });
  });

  it('a leave while the live table takes the seat refuses the sit', async () => {
    await inRollback(async (tx) => {
      // The gap between `seatMember` and `addMember`, where a leave must not be put back on the roster.
      let inTheGap: (() => Promise<void>) | null = null;
      const test = await harness(tx, {
        wrap: (store) => ({
          ...store,
          seatMember: async (...args: Parameters<RoomStore['seatMember']>) => {
            const id = await store.seatMember(...args);
            const gap = inTheGap;
            inTheGap = null;
            if (gap !== null) await gap();
            return id;
          },
        }),
      });
      const table = await createTable(test, { ...FRIENDS_TABLE, bots: undefined });
      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      const principal = { userId: friend.id, displayName: 'Friend' };
      await test.registry.joinByInviteCode(principal, table.inviteCode);
      inTheGap = () => test.registry.leaveRoom(table.id, friend.id);
      await assert.rejects(test.registry.sitAtTable(table.id, principal, 3), (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'not_room_member', 'a sit by somebody who left is a non-member sit');
        return true;
      });
      assert.equal(inTheGap, null, 'the leave never ran in the gap, so this proved nothing');
      await assertLeftDuringSit(test, tx, table.id, friend.id);

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a row with no first sit recorded still counts by the old evidence', async () => {
    await inRollback(async (tx) => {
      // Rows from before migration 0008, or from the previous build during a roll, have no `first_seated_at`.
      const test = await harness(tx);
      const table = await createTable(test, { ...FRIENDS_TABLE, startingStack: 2_000 });
      const forget = async (): Promise<void> => {
        await tx`
          update prl.room_members set first_seated_at = null
           where room_id = ${table.id} and user_id = ${test.userId} and left_at is null
        `;
      };
      assert.equal((await test.send('POST', `/api/v1/rooms/${table.id}/sit`, { seat: 0 })).status, 200);
      await forget();
      assert.equal(await units(tx, test.userId), 2_000, 'seated now, by a build that wrote no first sit');

      const room = test.registry.get(table.id);
      assert.ok(room !== null);
      await room.table.startHand();
      await test.registry.standFromTable(table.id, test.userId);
      await playOut(test, table.id);
      await forget();
      const played = (await roomsRepository.memberOf(tx, table.id, test.userId))?.stack;
      assert.equal(await units(tx, test.userId), played, 'dealt in here since joining');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a learner who left and rejoined a table starts uncounted there again', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const table = await createTable(test, { ...FRIENDS_TABLE, startingStack: 2_000 });
      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      const principal = { userId: friend.id, displayName: 'Friend' };
      await test.registry.joinByInviteCode(principal, table.inviteCode);
      await test.registry.sitAtTable(table.id, principal, 3);
      const room = test.registry.get(table.id);
      assert.ok(room !== null);
      await room.table.startHand();
      await test.registry.standFromTable(table.id, friend.id);
      await playOut(test, table.id);
      const played = (await roomsRepository.memberOf(tx, table.id, friend.id))?.stack;
      assert.equal(await units(tx, friend.id), played, 'dealt in here: counted');

      await test.registry.leaveRoom(table.id, friend.id);
      await test.registry.joinByInviteCode(principal, table.inviteCode);
      // `now()` is fixed inside one transaction, so `joined_at` would equal the old hand's `started_at`.
      await tx`
        update prl.room_members set joined_at = joined_at + interval '1 minute'
         where room_id = ${table.id} and user_id = ${friend.id} and left_at is null
      `;
      assert.equal(await units(tx, friend.id), 1_000, 'the new membership was counted by the old hands');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a table another person has joined is never retired, even when it has a practice shape', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const shared = await createTable(test, HEADS_UP_TABLE);
      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      // Inserted directly, because while the owner is a member `joinByInviteCode` answers `room_full`.
      await tx`
        insert into prl.room_members (id, room_id, user_id, seat, stack)
        values (${newRoomMemberId()}, ${shared.id}, ${friend.id}, null, 1000)
      `;
      const alone = await createTable(test, HEADS_UP_TABLE);
      assert.equal(await statusOf(tx, shared.id), 'open', 'a joined table survives a bot-filled create');

      await startMatch(test, 'calling-station');
      assert.equal(await statusOf(tx, shared.id), 'open', 'and survives a match');
      assert.equal(await statusOf(tx, alone.id), 'closed', 'the control: the same shape with nobody else');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a friend who joins after the retire read the roster keeps their table', async () => {
    await inRollback(async (tx) => {
      // The close statement must re-check the roster, or a join after the retire's read loses its table.
      let gate: string | null = null;
      let joinInTheGap: () => Promise<void> = () => Promise.resolve();
      const test = await harness(tx, {
        wrap: (store) => ({
          ...store,
          membersOfRooms: async (ids) => {
            const roster = await store.membersOfRooms(ids);
            if (gate !== null && ids.includes(gate)) {
              gate = null;
              await joinInTheGap();
            }
            return roster; // read before the join, as the retire's read was
          },
        }),
      });
      const shared = await createTable(test, HEADS_UP_TABLE);
      await test.registry.leaveRoom(shared.id, test.userId);
      const friend = await usersRepository.createGuest(tx, { displayName: 'Friend' });
      const principal = { userId: friend.id, displayName: 'Friend' };
      joinInTheGap = async () => {
        await test.registry.joinByInviteCode(principal, shared.inviteCode);
      };
      gate = shared.id;

      await startMatch(test, 'calling-station');
      assert.equal(gate, null, 'the join was never made in the gap, so this proved nothing');
      assert.ok(await roomsRepository.memberOf(tx, shared.id, friend.id), 'the friend joined');
      assert.equal(await statusOf(tx, shared.id), 'open', "the friend's table was closed under them");
      assert.ok(test.registry.get(shared.id) !== null, 'and its live table with it');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('POST /rooms retires the previous practice table only when its bots fill every other chair', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const match = await startMatch(test, 'calling-station');
      await createTable(test, FRIENDS_TABLE);
      assert.equal(await statusOf(tx, match), 'open', 'a table with a free chair retires nothing');
      await createTable(test, { ...FRIENDS_TABLE, bots: undefined });
      assert.equal(await statusOf(tx, match), 'open', 'nor does a table with no bots');
      const headsUp = await createTable(test, HEADS_UP_TABLE);
      assert.equal(await statusOf(tx, match), 'closed', 'a bot-filled table replaces the match');
      assert.equal(await statusOf(tx, headsUp.id), 'open');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a retire racing a re-open of the same table does not leave it live', async () => {
    await inRollback(async (tx) => {
      // Holds `ensureOpen` after it reads the row as open, while the retire runs to completion.
      let gate: string | null = null;
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => undefined;
      const atGate = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const test = await harness(tx, {
        wrap: (store) => ({
          ...store,
          membersOfRooms: async (ids) => {
            if (gate !== null && ids.length === 1 && ids[0] === gate) {
              gate = null;
              reached();
              await released;
            }
            return store.membersOfRooms(ids);
          },
        }),
      });
      const match = await startMatch(test, 'calling-station');
      assert.equal((await test.send('POST', `/api/v1/rooms/${match}/sit`, { seat: 0 })).status, 200);
      test.registry.close(match); // the process restarted: the row is open and nothing is live
      gate = match;
      const reopening = test.send('GET', `/api/v1/rooms/${match}`); // tab A reconnects
      await atGate;
      assert.deepEqual(await test.registry.retirePracticeTables(test.userId), [match]); // tab B
      release();

      const read = await reopening;
      assert.equal(read.status, 404, `a closed room was served: ${JSON.stringify(read.body)}`);
      assert.equal(test.registry.get(match), null, 'the re-open published a live table for a closed row');
      assert.equal(await statusOf(tx, match), 'closed');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('two matches started at once leave one practice table', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const first = await startMatch(test, 'calling-station');
      const [a, b] = await Promise.all([
        startMatch(test, 'vocal-aggressor'),
        startMatch(test, 'patient-technician'),
      ]);
      const open = [];
      for (const id of [first, a, b]) if ((await statusOf(tx, id)) === 'open') open.push(id);
      assert.equal(open.length, 1, `two tabs each kept a table: ${open.join(', ')}`);

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a hand that ends under a retire does not fail the request or skip the listeners', async () => {
    await inRollback(async (tx) => {
      // Fired after `retire` decides to close and before it asks whether the reader is seated, so the
      // bot's ending fold is queued ahead of the `stand`.
      let race: (() => void) | null = null;
      const test = await harness(tx, {
        wrap: (store) => ({
          ...store,
          closePracticeTable: async (roomId, ownerUserId) => {
            const closed = await store.closePracticeTable(roomId, ownerUserId);
            race?.();
            race = null;
            return closed;
          },
        }),
      });
      const retired: string[] = [];
      test.registry.onRetirement((roomId) => retired.push(roomId));
      const first = await startMatch(test, 'calling-station');
      assert.equal((await test.send('POST', `/api/v1/rooms/${first}/sit`, { seat: 0 })).status, 200);
      const room = test.registry.get(first);
      assert.ok(room !== null);
      await room.table.startHand();
      let view = room.table.viewFor(test.userId);
      assert.ok(view !== null && view.toAct !== null);
      if (view.toAct === view.viewerSeat) {
        await room.table.submitAction(test.userId, {
          action: { type: 'call' },
          actionId: 'act-racecall01',
          expectedSequence: view.actionSequence,
        });
        view = room.table.viewFor(test.userId);
        assert.ok(view !== null && view.toAct !== null);
      }
      await test.registry.standFromTable(first, test.userId);
      const toAct = view.toAct;
      const actor = view.seats.find((seat) => seat.seat === toAct);
      assert.ok(actor !== undefined && actor.playerId !== test.userId);
      const sequence = view.actionSequence;
      race = () => {
        for (let i = 0; i < 8; i += 1) void room.table.restack('usr_nobody', 1);
        void room.table.submitAction(actor.playerId, {
          action: { type: 'fold' },
          actionId: 'act-racefold01',
          expectedSequence: sequence,
        });
      };

      const second = await test.send('POST', '/api/v1/legends/matches', matchAgainst('vocal-aggressor'));
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.deepEqual(retired, [first], 'the sockets on the retired table are told');
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(test.registry.get(first), null, 'the live table closed on the settling notice');
      assert.equal(await statusOf(tx, first), 'closed');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a socket watching a retired table is closed with 1000', { timeout: 15_000 }, async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx, { hub: true });
      const first = await startMatch(test, 'calling-station');
      assert.ok(test.wsUrl !== null);
      const socket = new WebSocket(test.wsUrl, {
        headers: { cookie: `prl_session=${test.app.signCookie(TOKEN)}`, origin: ALLOWED_ORIGIN },
      });
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        socket.on('close', (code: number, reason: Buffer) =>
          resolve({ code, reason: reason.toString('utf8') }),
        );
      });
      const welcomed = new Promise<void>((resolve) => {
        socket.on('message', (data: Buffer) => {
          if (Reflect.get(JSON.parse(data.toString('utf8')) as object, 'type') === 'welcome') resolve();
        });
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      });
      socket.send(
        JSON.stringify({ type: 'hello', protocolVersion: 1, roomId: first, clientNonce: 'nonce-retire001' }),
      );
      await welcomed;

      await startMatch(test, 'vocal-aggressor');
      const close = await closed;
      assert.equal(close.code, WS_CLOSE.normal, JSON.stringify(close));

      await test.registry.shutdown();
      await test.app.close();
    });
  });
});

describe('a reset made during a hand', () => {
  it('is held until the hand settles, and the settled stack is the reset one', async () => {
    const table = new LiveTable({
      roomId: 'room_reset_mid_hand',
      config: { smallBlind: 5, bigBlind: 10, ante: 0, maxSeats: 2, actionTimeoutSeconds: 300 },
      clock: createManualClock(),
      random: createSecureRandom(),
      nextHandId: () => 'hand_reset_mid_hand',
    });
    const settled: (readonly SettledStack[])[] = [];
    table.subscribe((notice) => {
      if (notice.settledStacks !== null) settled.push(notice.settledStacks);
    });
    await table.sit({ userId: 'usr_ada', displayName: 'Ada', seat: 0, stack: 1_000 });
    await table.sit({ userId: 'usr_bo', displayName: 'Bo', seat: 1, stack: 1_000 });
    await table.startHand();

    assert.equal(await table.restack('usr_ada', 1_000), 'deferred');

    const view = table.viewFor('usr_ada');
    assert.ok(view !== null && view.toAct !== null);
    const actor = view.seats.find((seat) => seat.seat === view.toAct);
    assert.ok(actor !== undefined);
    // Without the reset Ada ends a blind up or down, never on 1,000.
    await table.submitAction(actor.playerId, {
      action: { type: 'fold' },
      actionId: 'act-resetfold1',
      expectedSequence: view.actionSequence,
    });

    assert.equal(settled.length, 1, 'the hand settled once');
    assert.equal(settled[0]?.find((entry) => entry.userId === 'usr_ada')?.stack, 1_000);
    assert.notEqual(settled[0]?.find((entry) => entry.userId === 'usr_bo')?.stack, 1_000);
    const stackOf = (userId: string): number | undefined =>
      table.snapshot().seats.find((seat) => seat.userId === userId)?.stack;
    assert.equal(stackOf('usr_ada'), 1_000);

    // Between hands, with the finished hand still retained for the review.
    assert.equal(await table.restack('usr_bo', 1_000), 'applied');
    assert.equal(stackOf('usr_bo'), 1_000, 'the retained hand must not mask the reset seat');
    assert.equal(await table.restack('usr_nobody', 1_000), 'notSeated');
    table.close();
  });
});
