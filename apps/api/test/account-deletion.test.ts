/**
 * Account deletion against a real PostgreSQL. `deleteAccount` issues one `delete from prl.users`
 * and the schema's referential actions decide the rest, so a fake store would prove nothing.
 * Every table is read back by name, not through the summary the code under test produces.
 * The policy cases run in a rolled-back transaction. The route cases commit, because `app.inject`
 * uses the process pool, and each one ends by erasing the account it created.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ACCOUNT_DELETE_CONFIRMATION, API_PATHS, type DeleteAccountResponse } from '@prl/contracts';
import { parseCard } from '@prl/poker-engine';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { type AppConfig, loadConfig } from '../src/config.ts';
import {
  closeDatabase,
  configureDatabase,
  createDatabaseClient,
  type Sql,
  type TransactionSql,
} from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import * as audit from '../src/repositories/audit.ts';
import * as enrolments from '../src/repositories/enrolments.ts';
import * as hands from '../src/repositories/hands.ts';
import { generateId } from '../src/repositories/ids.ts';
import * as progress from '../src/repositories/progress.ts';
import * as rooms from '../src/repositories/rooms.ts';
import * as sessions from '../src/repositories/sessions.ts';
import * as users from '../src/repositories/users.ts';
import { registerApiRoutes } from '../src/routes/index.ts';
import { closeSharedPool } from '../src/workers/pool.ts';
import { adminDatabaseUrl, databaseSkip, TEST_DATABASE_URL, testClientFor } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';
const ALLOWED_ORIGIN = 'http://localhost:3000';
/** Nothing here verifies a proof. The hand only has to exist. */
const ROOT = 'b'.repeat(64);

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: TEST_SECRET,
    // The route allows five per fifteen minutes and the cases below spend four. Only the global
    // limit is raised.
    RATE_LIMIT_MAX: '5000',
    DATABASE_POOL_MAX: '2',
  });
}

const databaseUrl = TEST_DATABASE_URL;
let client: Sql | null = null;
let skipReason: string | false = databaseSkip('account deletion');

if (databaseUrl !== undefined) {
  try {
    const probe = createDatabaseClient(testConfig());
    await probe`select 1 from prl.users limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `prl schema is not reachable (${error instanceof Error ? error.name : 'error'}): run pnpm db:migrate`;
  }
}

if (skipReason !== false) {
  console.info(`[account-deletion.test.ts] skipping database-backed tests: ${skipReason}`);
}

const dbOptions = { skip: skipReason };

/** Module-private, so it can be identified by identity. */
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

/**
 * For fixtures `prl_app` may not build. On `DATABASE_URL` these failed in CI, where the login is
 * `prl_ci_app`. The case drops to `prl_app` with `actAsRuntimeRole` before the code under test runs.
 */
async function inOwnerRollback(fn: (tx: TransactionSql) => Promise<void>): Promise<void> {
  const url = adminDatabaseUrl();
  if (url === undefined) throw new Error('inOwnerRollback called without a database');
  const owner = testClientFor(url);
  try {
    await owner.begin(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  } finally {
    await owner.end({ timeout: 5 }).catch(() => undefined);
  }
}

/** For the rest of the transaction, the role `/me/delete` runs as. */
async function actAsRuntimeRole(tx: TransactionSql): Promise<void> {
  await tx`set local role prl_app`;
}

async function makeGuest(tx: TransactionSql, name: string): Promise<string> {
  const user = await users.createGuest(tx, { displayName: name });
  return user.id;
}

function makeRoom(tx: TransactionSql, ownerId: string) {
  return rooms.create(tx, {
    name: 'Kitchen table',
    ownerUserId: ownerId,
    maxSeats: 6,
    smallBlind: 1,
    bigBlind: 2,
    startingStack: 200,
  });
}

async function dealHand(
  tx: TransactionSql,
  roomId: string,
  seatZero: string,
  seatOne: string,
): Promise<string> {
  const handId = generateId('hand');
  await hands.start(tx, {
    handId,
    roomId,
    handNumber: await hands.nextHandNumber(tx, roomId),
    buttonSeat: 0,
    config: { smallBlind: 1, bigBlind: 2, ante: 0, maxSeats: 6, actionTimeoutSeconds: 30 },
    commitmentRoot: ROOT,
    commitmentContext: `prl-deck-v2|${handId}`,
    randomSourceKind: 'csprng',
    seats: [
      {
        seat: 0,
        userId: seatZero,
        isBot: false,
        startingStack: 200,
        holeCards: [parseCard('Ah'), parseCard('Kh')],
        status: 'active',
      },
      {
        seat: 1,
        userId: seatOne,
        isBot: false,
        startingStack: 200,
        holeCards: [parseCard('7c'), parseCard('2d')],
        status: 'active',
      },
    ],
  });
  return handId;
}

async function giveEveryKindOfRow(tx: TransactionSql, userId: string): Promise<void> {
  await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
  await sessions.create(tx, { userId, ipHash: null, userAgentHash: null });
  await progress.upsertLessonProgress(tx, { userId, lessonId: 'pot-odds', completed: true });
  await progress.recordQuizAttempt(tx, {
    userId,
    quizId: 'quiz-pot-odds',
    questionId: 'q-one',
    answer: { kind: 'choice', index: 1 },
    wasCorrect: true,
  });
  await progress.recordScenarioAttempt(tx, {
    userId,
    scenarioId: 'scenario-one',
    action: 'call',
    matchedExpected: null,
  });
  await audit.record(tx, { event: 'auth.session.created', userId });
}

/**
 * Written out rather than derived from `information_schema`, and keyed by table name so a failure
 * names the table.
 */
interface RowsNaming {
  readonly sessions: number;
  readonly lesson_progress: number;
  readonly quiz_attempts: number;
  readonly scenario_attempts: number;
  readonly room_members: number;
  readonly hand_seats: number;
  readonly audit_log: number;
  readonly rooms_owned: number;
  readonly users: number;
}

async function rowsNaming(tx: TransactionSql, userId: string): Promise<RowsNaming> {
  const rows = await tx<RowsNaming[]>`
    select
      (select count(*) from prl.sessions          where user_id = ${userId})::int as sessions,
      (select count(*) from prl.lesson_progress   where user_id = ${userId})::int as lesson_progress,
      (select count(*) from prl.quiz_attempts     where user_id = ${userId})::int as quiz_attempts,
      (select count(*) from prl.scenario_attempts where user_id = ${userId})::int as scenario_attempts,
      (select count(*) from prl.room_members      where user_id = ${userId})::int as room_members,
      (select count(*) from prl.hand_seats        where user_id = ${userId})::int as hand_seats,
      (select count(*) from prl.audit_log         where user_id = ${userId})::int as audit_log,
      (select count(*) from prl.rooms  where owner_user_id = ${userId})::int as rooms_owned,
      (select count(*) from prl.users  where id = ${userId})::int as users
  `;
  const row = rows[0];
  assert.ok(row !== undefined, 'the count aggregate returned no row');
  return row;
}

async function seatCensus(
  tx: TransactionSql,
  handId: string,
): Promise<{ readonly seats: number; readonly named: number }> {
  const rows = await tx<{ seats: number; named: number }[]>`
    select count(*)::int as seats,
           count(user_id)::int as named
      from prl.hand_seats
     where hand_id = ${handId}
  `;
  const row = rows[0];
  assert.ok(row !== undefined, 'the seat census returned no row');
  return row;
}

describe('account deletion — what goes, what is detached, what stays', dbOptions, () => {
  /** Both blocking foreign keys in one case, so a half-applied migration cannot pass. */
  it('deletes a learner who created a table and joined one, and empties every table naming them', async () => {
    await inRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const hostId = await makeGuest(tx, 'Host');

      const ownTable = (await makeRoom(tx, leaverId)).room;
      await rooms.addMember(tx, { roomId: ownTable.id, userId: leaverId });
      await rooms.seatMember(tx, ownTable.id, leaverId, 0);

      const hostTable = (await makeRoom(tx, hostId)).room;
      await rooms.addMember(tx, { roomId: hostTable.id, userId: hostId });
      await rooms.seatMember(tx, hostTable.id, hostId, 0);
      await rooms.addMember(tx, { roomId: hostTable.id, userId: leaverId });
      await rooms.seatMember(tx, hostTable.id, leaverId, 1);

      await giveEveryKindOfRow(tx, leaverId);
      const handId = await dealHand(tx, hostTable.id, hostId, leaverId);

      // Every count is non-zero before, so the zeroes after are a change.
      const before = await rowsNaming(tx, leaverId);
      for (const [table, count] of Object.entries(before)) {
        assert.ok(count > 0, `${table} has no row for the learner, so emptying it proves nothing`);
      }

      const summary = await users.deleteAccount(tx, leaverId);
      assert.ok(summary !== null);

      const after = await rowsNaming(tx, leaverId);
      assert.equal(after.users, 0, 'prl.users still holds the account');
      assert.equal(after.sessions, 0, 'prl.sessions still holds a credential for a deleted account');
      assert.equal(after.lesson_progress, 0, 'prl.lesson_progress still records what they read');
      assert.equal(after.quiz_attempts, 0, 'prl.quiz_attempts still records their answers');
      assert.equal(after.scenario_attempts, 0, 'prl.scenario_attempts still records their decisions');
      assert.equal(after.room_members, 0, 'prl.room_members still seats them at a table');
      assert.equal(after.hand_seats, 0, 'prl.hand_seats still names them in a hand');
      assert.equal(after.audit_log, 0, 'prl.audit_log still attributes an event to them');
      assert.equal(after.rooms_owned, 0, 'prl.rooms still says they own a table');

      // Against `before`, not literals, so it survives fixture changes.
      assert.equal(summary.deleted.sessions, before.sessions);
      assert.equal(summary.deleted.lessonsCompleted, before.lesson_progress);
      assert.equal(summary.deleted.quizAttempts, before.quiz_attempts);
      assert.equal(summary.deleted.scenarioAttempts, before.scenario_attempts);
      assert.equal(summary.deleted.roomMemberships, before.room_members);
      assert.equal(summary.anonymised.handSeats, before.hand_seats);
      assert.equal(summary.anonymised.auditEvents, before.audit_log);
      assert.equal(summary.anonymised.roomsCreated, before.rooms_owned);

      const census = await seatCensus(tx, handId);
      assert.equal(census.seats, 2, 'the hand lost a seat, which is a destroyed hand not an erased one');
      assert.equal(census.named, 1, 'exactly one seat should still name a learner');
    });
  });

  it('leaves every hand intact, with the departing seat anonymised rather than removed', async () => {
    await inRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const hostId = await makeGuest(tx, 'Host');
      const table = (await makeRoom(tx, hostId)).room;
      await rooms.addMember(tx, { roomId: table.id, userId: hostId });
      await rooms.addMember(tx, { roomId: table.id, userId: leaverId });
      const handId = await dealHand(tx, table.id, hostId, leaverId);

      await users.deleteAccount(tx, leaverId);

      const hand = await tx<{ id: string; commitment_root: string; hand_number: number }[]>`
        select id, commitment_root, hand_number from prl.hands where id = ${handId}
      `;
      assert.equal(hand.length, 1, 'the hand itself must survive the departure of one of its players');
      assert.equal(hand[0]?.commitment_root, ROOT, 'the deck commitment must not be rewritten');

      const seats = await tx<
        { seat: number; user_id: string | null; hole_cards: unknown; starting_stack: number }[]
      >`
        select seat, user_id, hole_cards, starting_stack
          from prl.hand_seats
         where hand_id = ${handId}
         order by seat
      `;
      assert.equal(seats.length, 2);
      assert.equal(seats[0]?.user_id, hostId, 'the other player keeps their seat and their identity');
      assert.equal(seats[1]?.user_id, null, 'the departing seat is detached, not deleted');
      // The cards and stack belong to the hand, not to the departing learner.
      assert.notEqual(seats[1]?.hole_cards, null, 'the seat keeps what it was dealt');
      assert.equal(seats[1]?.starting_stack, 200);
    });
  });

  it('closes and detaches the tables the learner created, and touches nobody else table', async () => {
    await inRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const hostId = await makeGuest(tx, 'Host');
      const ownTable = (await makeRoom(tx, leaverId)).room;
      const hostTable = (await makeRoom(tx, hostId)).room;
      await rooms.addMember(tx, { roomId: hostTable.id, userId: leaverId });
      assert.equal(ownTable.status, 'open', 'the fixture must start from an open table');

      await users.deleteAccount(tx, leaverId);

      const detached = await rooms.byId(tx, ownTable.id);
      assert.ok(detached !== null, 'the table must survive: its hands cascade from it');
      assert.equal(detached.owner_user_id, null, 'the creator must not still be named on it');
      assert.equal(
        detached.status,
        'closed',
        'an ownerless table nobody can close must not be left open: rooms.close authorises on ' +
          'owner_user_id, so no session could ever shut this one',
      );
      assert.notEqual(detached.closed_at, null, 'rooms_closed_at_matches_status pairs the two');

      const untouched = await rooms.byId(tx, hostTable.id);
      assert.equal(untouched?.owner_user_id, hostId);
      assert.equal(untouched?.status, 'open');
    });
  });

  /** Every figure is read before and after, so it cannot pass on a fixture that happened to be zero. */
  it('leaves an unrelated learner completely untouched', async () => {
    await inRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const strangerId = await makeGuest(tx, 'Stranger');

      await giveEveryKindOfRow(tx, leaverId);
      await giveEveryKindOfRow(tx, strangerId);

      const strangerTable = (await makeRoom(tx, strangerId)).room;
      await rooms.addMember(tx, { roomId: strangerTable.id, userId: strangerId });
      const partnerId = await makeGuest(tx, 'Partner');
      await rooms.addMember(tx, { roomId: strangerTable.id, userId: partnerId });
      const strangerHand = await dealHand(tx, strangerTable.id, strangerId, partnerId);

      const leaverTable = (await makeRoom(tx, leaverId)).room;
      await rooms.addMember(tx, { roomId: leaverTable.id, userId: leaverId });

      const before = await rowsNaming(tx, strangerId);
      const beforeSeats = await seatCensus(tx, strangerHand);

      await users.deleteAccount(tx, leaverId);

      assert.deepEqual(
        await rowsNaming(tx, strangerId),
        before,
        'erasing one account changed the row counts of an unrelated one',
      );
      assert.deepEqual(await seatCensus(tx, strangerHand), beforeSeats);
      const snapshot = await progress.readProgress(tx, strangerId);
      assert.equal(snapshot.lessonsCompleted.length, 1);
      assert.equal(snapshot.quizQuestionsAnswered, 1);
      assert.equal(snapshot.scenariosAttempted.length, 1);
      // A WHERE clause that lost its predicate would revoke every session in the table.
      const live = await sessions.create(tx, {
        userId: strangerId,
        ipHash: null,
        userAgentHash: null,
      });
      const resolved = await sessions.findValidByToken(tx, live.token);
      assert.equal(resolved?.user.id, strangerId, 'an unrelated session must still be usable');
    });
  });

  it('revokes every session the learner held, not only the one that asked', async () => {
    await inRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const first = await sessions.create(tx, { userId: leaverId, ipHash: null, userAgentHash: null });
      const second = await sessions.create(tx, { userId: leaverId, ipHash: null, userAgentHash: null });

      const summary = await users.deleteAccount(tx, leaverId);
      assert.equal(summary?.sessionsRevoked, 2, 'both live sessions must be revoked before the row goes');
      assert.equal(await sessions.findValidByToken(tx, first.token), null);
      assert.equal(await sessions.findValidByToken(tx, second.token), null);
    });
  });

  /**
   * The pre-0004 schema, recreated inside a rolled-back transaction. It is what an API ahead of its
   * migration, or a restore of an older dump, looks like.
   */
  it('answers account_deletion_blocked when a foreign key still restricts the account', async () => {
    await inOwnerRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const table = (await makeRoom(tx, leaverId)).room;
      await rooms.addMember(tx, { roomId: table.id, userId: leaverId });

      // Literal DDL, so nothing here breaks the parameterisation rule in `src/db.ts`.
      await tx`set local role prl_migrator`;
      await tx`alter table prl.room_members drop constraint room_members_user_id_fkey`;
      await tx`
        alter table prl.room_members
          add constraint room_members_user_id_fkey
          foreign key (user_id) references prl.users (id) on delete restrict
      `;
      await tx`reset role`;
      await actAsRuntimeRole(tx);

      await assert.rejects(
        users.deleteAccount(tx, leaverId),
        (error: unknown) =>
          error instanceof AppError && error.code === 'account_deletion_blocked'
            ? true
            : (() => {
                throw error;
              })(),
        'the pre-0004 schema must produce a truthful 409, not an unexplained 500',
      );
    });
  });
});

let app: FastifyInstance | null = null;

before(async () => {
  if (skipReason !== false) return;
  configureDatabase(testConfig());
  app = await buildApp({ config: testConfig() });
  await registerApiRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  await closeSharedPool();
  await closeDatabase(1_000);
  if (client !== null) await client.end({ timeout: 5 });
});

interface Caller {
  readonly userId: string;
  readonly session: string;
  readonly csrfToken: string;
  readonly csrfCookie: string;
}

function cookiePair(response: { cookies: { name: string; value: string }[] }, name: string): string | null {
  const found = response.cookies.find((entry) => entry.name === name);
  return found === undefined ? null : `${name}=${found.value}`;
}

async function signUp(instance: FastifyInstance): Promise<Caller> {
  const minted = await instance.inject({ method: 'GET', url: API_PATHS.session() });
  assert.equal(minted.statusCode, 200, minted.body);
  const seedToken = String((minted.json() as { csrfToken: string }).csrfToken);
  const seedCookie = cookiePair(minted, 'prl_csrf');
  assert.ok(seedCookie !== null, 'the CSRF plugin issued no secret cookie');

  const created = await instance.inject({
    method: 'POST',
    url: API_PATHS.guest(),
    headers: {
      origin: ALLOWED_ORIGIN,
      'content-type': 'application/json',
      'x-csrf-token': seedToken,
      cookie: seedCookie,
    },
    payload: {},
  });
  assert.equal(created.statusCode, 201, created.body);
  const body = created.json() as { user: { id: string } | null; csrfToken: string };
  assert.ok(body.user !== null, 'guest creation returned no account');
  const session = cookiePair(created, 'prl_session');
  const csrfCookie = cookiePair(created, 'prl_csrf') ?? seedCookie;
  assert.ok(session !== null, 'guest creation issued no session cookie');
  return { userId: body.user.id, session, csrfToken: String(body.csrfToken), csrfCookie };
}

/** `await`ed inside because returning `inject` unresolved makes the compiler pick the builder overload. */
async function deleteRequest(
  instance: FastifyInstance,
  caller: Caller | null,
  payload: Record<string, unknown>,
) {
  const headers: Record<string, string> = {
    origin: ALLOWED_ORIGIN,
    'content-type': 'application/json',
  };
  if (caller !== null) {
    headers['x-csrf-token'] = caller.csrfToken;
    headers.cookie = `${caller.session}; ${caller.csrfCookie}`;
  }
  return await instance.inject({ method: 'POST', url: API_PATHS.accountDelete(), headers, payload });
}

function errorCodeOf(payload: string): string {
  const parsed: unknown = JSON.parse(payload);
  assert.ok(typeof parsed === 'object' && parsed !== null, payload.slice(0, 120));
  const error: unknown = Reflect.get(parsed, 'error');
  assert.ok(typeof error === 'object' && error !== null, payload.slice(0, 120));
  return String(Reflect.get(error, 'code'));
}

describe('an entitlement that ends because its holder erased themselves', dbOptions, () => {
  /**
   * `enrolments_user_id_fkey` is ON DELETE CASCADE, and a referential action writes no audit entry.
   * Without this the audit log showed a grant that nothing ever ended, so reconciling places
   * against it over-counted every erased learner.
   */
  it('writes an entry per enrolment, detached, before the rows go (REGRESSION)', async () => {
    await inOwnerRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const cohort = await enrolments.createCohort(tx, {
        key: 'erasure-record-cohort',
        name: 'Erasure record',
        startsAt: new Date(Date.now() - 86_400_000),
      });

      const live = await enrolments.grant(tx, {
        cohortId: cohort.id,
        userId: leaverId,
        grantedBy: 'registrar',
        reference: 'external-ref-live',
      });
      assert.equal(live.outcome, 'granted');

      // An already-withdrawn place too, because the record must tell a live place ending from one
      // that had already ended.
      const other = await enrolments.createCohort(tx, {
        key: 'erasure-record-cohort-two',
        name: 'Erasure record two',
        startsAt: new Date(Date.now() - 86_400_000),
      });
      const withdrawn = await enrolments.grant(tx, {
        cohortId: other.id,
        userId: leaverId,
        grantedBy: 'registrar',
        reference: 'external-ref-withdrawn',
      });
      assert.equal(withdrawn.outcome, 'granted');
      await enrolments.revoke(tx, {
        cohortId: other.id,
        userId: leaverId,
        revokedBy: 'registrar',
        reason: 'withdrew before the course began',
      });

      // Both rows exist before the deletion.
      const held = await enrolments.forUser(tx, leaverId);
      assert.equal(held.length, 2, 'the fixture did not create two enrolments');

      await actAsRuntimeRole(tx);
      const summary = await users.deleteAccount(tx, leaverId);
      assert.ok(summary !== null);
      assert.equal(summary.deleted.enrolments, 2, 'the cascade did not take both enrolments');
      // The runtime role may only append to the audit log.
      await tx`reset role`;

      const written = await tx<
        { user_id: string | null; cohort_key: string; reference: string; was_live: boolean }[]
      >`
        select user_id,
               detail->>'cohortKey'  as cohort_key,
               detail->>'reference'  as reference,
               (detail->>'wasLive')::boolean as was_live
          from prl.audit_log
         where event = 'enrolment.ended_by_erasure'
         order by detail->>'reference'
      `;
      assert.equal(written.length, 2, 'one entry per enrolment, and there were two');

      // The log must never point at an account that asked to stop existing.
      for (const entry of written) {
        assert.equal(entry.user_id, null, 'an erasure record named the person it erased');
      }

      assert.deepEqual(
        written.map((entry) => [entry.reference, entry.cohort_key, entry.was_live]),
        [
          ['external-ref-live', 'erasure-record-cohort', true],
          ['external-ref-withdrawn', 'erasure-record-cohort-two', false],
        ],
        'the external reference, the cohort and whether the place was still live must all survive',
      );

      const left = await tx<{ n: number }[]>`
        select count(*)::int as n from prl.enrolments where user_id = ${leaverId}`;
      assert.equal(left[0]?.n, 0);
    });
  });

  it('writes nothing for a learner who never held a place (NEGATIVE CONTROL)', async () => {
    // An entry for every account, enrolled or not, would pass the test above and say nothing.
    await inRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Never enrolled');
      await users.deleteAccount(tx, leaverId);
      const written = await tx<{ n: number }[]>`
        select count(*)::int as n from prl.audit_log where event = 'enrolment.ended_by_erasure'`;
      assert.equal(written[0]?.n, 0, 'an erasure with no enrolment wrote an entitlement record');
    });
  });
});

describe('POST /me/delete', dbOptions, () => {
  it('refuses an unauthenticated caller with not_authenticated', async () => {
    assert.ok(app !== null);
    // A CSRF pair is sent, so the refusal comes from the session check and not a 403 from the CSRF hook.
    const minted = await app.inject({ method: 'GET', url: API_PATHS.session() });
    const token = String((minted.json() as { csrfToken: string }).csrfToken);
    const cookie = cookiePair(minted, 'prl_csrf');
    assert.ok(cookie !== null);

    const response = await app.inject({
      method: 'POST',
      url: API_PATHS.accountDelete(),
      headers: {
        origin: ALLOWED_ORIGIN,
        'content-type': 'application/json',
        'x-csrf-token': token,
        cookie,
      },
      payload: { confirm: ACCOUNT_DELETE_CONFIRMATION },
    });
    assert.equal(response.statusCode, 401, response.body);
    assert.equal(errorCodeOf(response.body), 'not_authenticated');
  });

  it('refuses a signed-in caller who did not confirm, and leaves the account intact', async () => {
    assert.ok(app !== null);
    const instance = app;
    const caller = await signUp(instance);

    // Four refusals plus the acceptance is exactly the route's budget of five (`ACCOUNT_DELETE_MAX`).
    // A sixth case here would answer 429.
    for (const payload of [{}, { confirm: '' }, { confirm: 'yes' }, { confirm: 'Delete My Account' }]) {
      const refused = await deleteRequest(instance, caller, payload);
      assert.equal(refused.statusCode, 400, `${JSON.stringify(payload)} -> ${refused.body}`);
      assert.equal(errorCodeOf(refused.body), 'invalid_request');
    }

    // A refusal that had already deleted something would also answer 400.
    const session = await instance.inject({
      method: 'GET',
      url: API_PATHS.session(),
      headers: { cookie: caller.session },
    });
    assert.equal((session.json() as { user: { id: string } | null }).user?.id, caller.userId);

    // The cleanup proves the right phrase works.
    const accepted = await deleteRequest(instance, caller, { confirm: ACCOUNT_DELETE_CONFIRMATION });
    assert.equal(accepted.statusCode, 200, accepted.body);
  });

  /**
   * `RATE_LIMIT_MAX` is 5000, so a 429 on the sixth request comes from the per-route limit. Each
   * attempt takes `for update` on the victim's row. The rate-limited caller is removed through the
   * suite's own connection as teardown.
   */
  it('rate limits the destructive route on a budget of its own, so it cannot be attempted in a loop', async () => {
    assert.ok(app !== null);
    assert.ok(client !== null);
    const instance = app;
    const pool = client;
    const caller = await signUp(instance);
    try {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const refused = await deleteRequest(instance, caller, { confirm: 'not the phrase' });
        statuses.push(refused.statusCode);
      }
      assert.deepEqual(
        statuses,
        [400, 400, 400, 400, 400, 429],
        'the sixth attempt must be refused by the rate limiter, not answered again',
      );
      const last = await deleteRequest(instance, caller, { confirm: ACCOUNT_DELETE_CONFIRMATION });
      assert.equal(last.statusCode, 429, 'and a correct phrase does not buy past the limit');
      assert.equal(errorCodeOf(last.body), 'rate_limited');
    } finally {
      await pool`delete from prl.users where id = ${caller.userId}`;
    }
  });

  it('erases the account, clears the cookie, and leaves the session unusable', async () => {
    assert.ok(app !== null);
    const instance = app;
    const caller = await signUp(instance);

    const response = await deleteRequest(instance, caller, { confirm: ACCOUNT_DELETE_CONFIRMATION });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json() as DeleteAccountResponse;
    assert.equal(body.deleted.sessions, 1, 'the session they were holding is one of the rows removed');
    assert.equal(typeof body.anonymised.handSeats, 'number');

    const cleared = response.cookies.find((entry) => entry.name === 'prl_session');
    assert.ok(cleared !== undefined, 'the session cookie was not cleared');
    assert.equal(cleared.value, '', `the cookie was re-sent with a value: ${cleared.value.slice(0, 12)}`);

    // `session_expired`, not `not_authenticated`, because this server signed the cookie.
    const replayed = await instance.inject({
      method: 'GET',
      url: API_PATHS.session(),
      headers: { cookie: caller.session },
    });
    assert.equal(replayed.statusCode, 200, 'the session read never fails for a signed-out caller');
    assert.equal((replayed.json() as { user: unknown }).user, null, 'the revoked session still resolves');

    // The suite's own connection sees committed state.
    assert.ok(client !== null);
    const remaining = await client<{ users: number; sessions: number }[]>`
      select (select count(*) from prl.users    where id = ${caller.userId})::int as users,
             (select count(*) from prl.sessions where user_id = ${caller.userId})::int as sessions
    `;
    assert.equal(remaining[0]?.users, 0, 'the account row survived a committed deletion');
    assert.equal(remaining[0]?.sessions, 0, 'a session row survived a committed deletion');
  });
});
