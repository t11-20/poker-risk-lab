/**
 * Units are the chips in front of a learner — and starting a practice table, or resetting, must not
 * change that into something else.
 *
 * ## The two defects, both from the UI audit of 2026-11
 *
 * 1. **Every Legends match minted a stack.** A fresh visitor's header read 1,000; after one match
 *    1,000; after a second 2,000 with 995 on the screen; a third, 3,000; "Back → Deal me in" from a
 *    hand review, 3,960. `createRoom` gives the owner a membership holding `starting_stack` before
 *    they sit anywhere, `users.readUnits` summed every live membership with no regard to whether its
 *    room was still open, and nothing ever closed a match the web client had walked away from.
 * 2. **A reset did not reach the table the learner was sitting at.** Busted to 0, they reset
 *    ("your units are back to 1000"), went back to the table and were welcomed with a stack of 0 —
 *    `room_members.stack` had moved and the live table, which is authoritative between hands, had
 *    not. The next bots-only hand settled their 0 back over the reset.
 *
 * ## Why these run against the real store
 *
 * `test/rooms.test.ts`'s fake answers `readUnits` from a constant, so the growth cannot happen there
 * at all. Here the routes run over `postgresRoomStore` and `postgresArchive` bound to one transaction
 * that is rolled back, so the units figure is the SQL's and nothing is ever committed — the file is
 * safe against any database the suite is pointed at.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createSecureRandom } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import type { ProblemDetail } from '../src/observability/telemetry.ts';
import * as roomsRepository from '../src/repositories/rooms.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { postgresArchive, postgresRoomStore, RoomRegistry } from '../src/rooms/registry.ts';
import { LiveTable, type SettledStack } from '../src/rooms/table.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { type AuthStore, createAuthRoutes } from '../src/routes/auth.ts';
import { createRoomRoutes } from '../src/routes/rooms.ts';
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
  readonly userId: string;
  readonly problems: { message: string; detail: ProblemDetail }[];
  /** A request as the browser sends it: the signed session cookie, a CSRF pair, the origin. */
  readonly send: (
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
  ) => Promise<{ status: number; body: unknown }>;
}

/**
 * The room routes and the auth routes over one transaction, sharing one registry — the way
 * `routes/index.ts` assembles them, with only the session lookup replaced.
 */
async function harness(tx: TransactionSql): Promise<Harness> {
  const user = await usersRepository.createGuest(tx, { displayName: 'Reader' });
  const problems: { message: string; detail: ProblemDetail }[] = [];
  const registry = new RoomRegistry({
    clock: createManualClock(),
    random: createSecureRandom(),
    store: postgresRoomStore(() => tx),
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
  await app.ready();

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
  return { app, registry, userId: user.id, problems, send };
}

/** What the web client sends for a Legends match: `openPracticeRoom` in `use-live-table.ts`. */
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
      assert.equal(await units(tx, owner.id), 400, 'the chips in front of them');

      // Not 1,000 by coincidence: 400 is what the old sum reported after the close, and the
      // allowance is what a learner at no OPEN table has.
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
      // The audit's sequence had a hand dealt and waiting on the reader when the next match began.
      // Its archive writes are drained by the retirement itself, which the hand assertions below
      // depend on — nothing here waits for them.
      await test.registry.get(first)?.table.startHand();
      assert.equal(await units(tx, test.userId), 1_000);

      const second = await startMatch(test, 'vocal-aggressor');
      const third = await startMatch(test, 'patient-technician');
      assert.equal(
        await units(tx, test.userId),
        1_000,
        'each match used to add a 1,000-unit membership: 1,000 → 2,000 → 3,000',
      );

      for (const retired of [first, second]) {
        assert.equal((await roomsRepository.byId(tx, retired))?.status, 'closed');
        assert.equal(test.registry.get(retired), null, 'the live table went with the row');
      }
      assert.equal((await roomsRepository.byId(tx, third))?.status, 'open');

      // The hand the reader walked away from is settled, not left open in their history forever.
      // Asserted over a non-empty set: a sweep of nothing would pass this whether or not the hand was
      // ever written.
      const hands = await tx<{ completed: boolean; reason: string | null }[]>`
        select completed_at is not null as completed, result ->> 'abandonedReason' as reason
          from prl.hands where room_id = ${first}
      `;
      assert.equal(hands.length, 1, 'the dealt hand was archived');
      assert.deepEqual(
        hands.map((hand) => ({ ...hand })),
        [{ completed: true, reason: 'replaced-by-a-new-practice-table' }],
        'no hand of a retired table is left in progress',
      );
      assert.deepEqual(test.problems, [], 'retiring wrote everything it meant to');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('never retires a table with a chair for another person', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      // `FRIENDS_TABLE_REQUEST` in `apps/web/src/lib/table-rooms.ts`: six seats, two bots, and an
      // invite code that may already be in a friend's hand.
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
      assert.equal(await units(tx, test.userId), 2_000, 'two open tables, two stacks — and no more');

      await test.registry.shutdown();
      await test.app.close();
    });
  });

  it('a reset reaches the table the reader is sitting at, so they are dealt in again', async () => {
    await inRollback(async (tx) => {
      const test = await harness(tx);
      const roomId = await startMatch(test, 'calling-station');
      assert.equal((await test.send('POST', `/api/v1/rooms/${roomId}/sit`, { seat: 0 })).status, 200);

      // Busted. Reached the way a restart reaches it — the roster says 0 and the re-opened table
      // re-seats the reader at what the roster says — so no hand has to be lost on purpose.
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

    // The chips are inside the engine's `HandState` now; the reset cannot reach them yet.
    assert.equal(await table.restack('usr_ada', 1_000), 'deferred');

    const view = table.viewFor('usr_ada');
    assert.ok(view !== null && view.toAct !== null);
    const actor = view.seats.find((seat) => seat.seat === view.toAct);
    assert.ok(actor !== undefined);
    // Whoever folds, Ada ends the hand a blind up or a blind down: anything but 1,000 without the
    // reset.
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

    // Between hands, with the finished hand still retained for the review: the shape the audit hit,
    // a reader whose last hand left them a figure and who then reset.
    assert.equal(await table.restack('usr_bo', 1_000), 'applied');
    assert.equal(stackOf('usr_bo'), 1_000, 'the retained hand must not mask the reset seat');
    assert.equal(await table.restack('usr_nobody', 1_000), 'notSeated');
    table.close();
  });
});
