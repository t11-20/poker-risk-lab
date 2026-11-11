/**
 * Units are the chips in front of a learner — and starting a practice table must not change that
 * into something else.
 *
 * ## The defect, from the UI audit of 2026-11
 *
 * **Every Legends match minted a stack.** A fresh visitor's header read 1,000; after one match
 * 1,000; after a second 2,000 with 995 on the screen; a third, 3,000; "Back → Deal me in" from a hand
 * review, 3,960. `createRoom` gives the owner a membership holding `starting_stack` before they sit
 * anywhere, `users.readUnits` summed every live membership with no regard to whether its room was
 * still open, and nothing ever closed a match the web client had walked away from.
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
import type { ProblemDetail } from '../src/observability/telemetry.ts';
import * as roomsRepository from '../src/repositories/rooms.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { postgresArchive, postgresRoomStore, RoomRegistry } from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
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

/** The room routes over one transaction, with only the session lookup replaced. */
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
  const app = await buildApp({ config: testConfig(), database: stubDatabase });
  app.get(CSRF_ROUTE, async (_request, reply) => ({ token: reply.generateCsrf() }));
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
});
