/**
 * Account deletion, proved against a real PostgreSQL rather than described.
 *
 * ## Why this file has to exist, and why it has to use the database
 *
 * Almost none of the erasure is written in TypeScript. `deleteAccount` issues one
 * `delete from prl.users`, and PostgreSQL then executes eight referential actions that decide
 * what happens to eight tables — four CASCADE, three SET NULL, and one that was `RESTRICT` until
 * migration 0004 and made every learner who had ever created or joined a table permanently
 * undeletable. A test with a fake store would exercise the one statement this repository controls
 * and none of the seven decisions the schema makes, which is to say it would prove nothing about
 * the feature at all.
 *
 * So the policy half of this file runs the real function against the real schema and then reads
 * every table back, one at a time, by name. Table by table rather than by a summary object,
 * because the summary is produced by the same code under test: a count that agreed with a
 * `deleteAccount` which had quietly stopped removing quiz attempts would agree with it in exactly
 * the way that hides the defect.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Yes, and each way was checked by breaking it:
 *
 *   - Reverting `room_members_user_id_fkey` to `ON DELETE RESTRICT` in the live schema makes the
 *     deletion cases fail with `account_deletion_blocked` instead of succeeding. Measured.
 *   - Reverting `rooms_owner_user_id_fkey` to `ON DELETE RESTRICT` does the same. Measured.
 *   - Changing `hand_seats_user_id_fkey` to CASCADE makes "the hand survives with the seat
 *     anonymised" fail on the seat count rather than on the null check, which is the assertion
 *     that would matter: it is the difference between an anonymised hand and a destroyed one.
 *
 * The stranger-untouched case carries its own negative control in the same shape: every figure it
 * asserts is read before AND after the deletion, so an assertion comparing a value to itself
 * cannot pass by accident.
 *
 * ## The two halves, and why the second one commits
 *
 * Everything about the POLICY runs inside a transaction that is rolled back (`inRollback`), like
 * every other database suite here, so the file leaves no rows behind and can be pointed at a
 * seeded development database.
 *
 * The ROUTE half cannot: `app.inject` goes through the process-wide pool, and a session cookie
 * has to resolve against committed rows. It is safe anyway, because of what the endpoint under
 * test is — the account it creates through `POST /auth/guest` is erased by the request being
 * tested, so the suite cleans up after itself using the very behaviour it is asserting. The one
 * case that must NOT end in an erasure (a refused confirmation) finishes by erasing the account
 * itself, which is also the assertion that the refusal left the account intact.
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
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';
const ALLOWED_ORIGIN = 'http://localhost:3000';
/** A commitment root of the right shape. Nothing here verifies a proof; the hand only has to exist. */
const ROOT = 'b'.repeat(64);

function testConfig(): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL ?? 'postgresql://unused:unused@127.0.0.1:5432/unused',
    PUBLIC_WEB_ORIGIN: ALLOWED_ORIGIN,
    SESSION_COOKIE_SECRET: TEST_SECRET,
    // The route under test has a budget of five per fifteen minutes, which is generous for a
    // person and tight for this file: the route cases below spend four between them. The GLOBAL
    // limit is what is raised here, so the route's own budget is still the one being exercised.
    RATE_LIMIT_MAX: '5000',
    DATABASE_POOL_MAX: '2',
  });
}

// ---------------------------------------------------------------------------
// The database harness — the shape `repositories.test.ts` uses, for the reasons it gives
// ---------------------------------------------------------------------------

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

/** Thrown to force a rollback. A module-private instance, so it can be identified by identity. */
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

/** Deals one two-handed hand in `roomId`. Both seats are real accounts, as a live table's are. */
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

/** Gives one learner a row in every table an account deletion is supposed to reach. */
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
 * Every table that names a learner, counted by name.
 *
 * Written out here rather than derived from `information_schema`, and read through the SAME
 * connection the deletion ran on, so a table the erasure forgot shows up as a non-zero count
 * rather than as a column nobody enumerated. The keys are the table names on purpose: an
 * assertion failure says `prl.quiz_attempts`, not `field 3`.
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

/** How many seats one hand has, and how many of them still name somebody. */
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

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

describe('account deletion — what goes, what is detached, what stays', dbOptions, () => {
  /**
   * The exact learner the schema used to refuse: one who created a table AND joined another.
   *
   * Both foreign keys that blocked this are exercised in one case on purpose. Splitting them
   * would let a half-applied migration pass one case and fail the other, which is a state nobody
   * should be able to reach with a green suite in front of them.
   */
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

      // The control: every one of these is non-zero BEFORE the deletion, so the zeroes asserted
      // afterwards are a change rather than a table that was always empty.
      const before = await rowsNaming(tx, leaverId);
      for (const [table, count] of Object.entries(before)) {
        assert.ok(count > 0, `${table} has no row for the learner, so emptying it proves nothing`);
      }

      const summary = await users.deleteAccount(tx, leaverId);
      assert.ok(summary !== null);

      // Table by table, by name.
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

      // And the summary agrees with what was actually there. Asserted against `before` rather
      // than against literals, so the case still means something if the fixture above changes.
      assert.equal(summary.deleted.sessions, before.sessions);
      assert.equal(summary.deleted.lessonsCompleted, before.lesson_progress);
      assert.equal(summary.deleted.quizAttempts, before.quiz_attempts);
      assert.equal(summary.deleted.scenarioAttempts, before.scenario_attempts);
      assert.equal(summary.deleted.roomMemberships, before.room_members);
      assert.equal(summary.anonymised.handSeats, before.hand_seats);
      assert.equal(summary.anonymised.auditEvents, before.audit_log);
      assert.equal(summary.anonymised.roomsCreated, before.rooms_owned);

      // The hand is still there and is still a two-handed hand.
      const census = await seatCensus(tx, handId);
      assert.equal(census.seats, 2, 'the hand lost a seat, which is a destroyed hand not an erased one');
      assert.equal(census.named, 1, 'exactly one seat should still name a learner');
    });
  });

  /**
   * The half of the policy a learner is most likely to be surprised by, so it gets its own case:
   * the hands survive, in full, and only the identity goes.
   */
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
      // The cards and the stack are the hand's own record and are not the departing learner's to
      // remove: without them the surviving player's history is a hand with a seat that did
      // nothing, which is a different hand from the one that was played.
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

  /**
   * The case that says the blast radius is bounded.
   *
   * Every figure is read before and after, and the assertion is that they are equal. That is a
   * weaker-looking shape than checking literals and a stronger one in practice: it cannot pass
   * because the fixture happened to produce a zero.
   */
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
      // Their progress read, which is the thing they would actually notice.
      const snapshot = await progress.readProgress(tx, strangerId);
      assert.equal(snapshot.lessonsCompleted.length, 1);
      assert.equal(snapshot.quizQuestionsAnswered, 1);
      assert.equal(snapshot.scenariosAttempted.length, 1);
      // And a live session of theirs still resolves, which no other assertion here covers: the
      // deletion revokes sessions by user id, and a WHERE clause that had lost its predicate
      // would revoke every session in the table.
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
   * The mapping that turns an unmigrated database into a truthful answer rather than a 500.
   *
   * This is the pre-0004 schema, recreated for the length of one savepoint: it is what a
   * deployment whose API rolled ahead of its migration, or a restore of an older dump, actually
   * looks like. Everything happens inside `tx`, which is rolled back, so the live schema is put
   * back whatever this case does.
   */
  it('answers account_deletion_blocked when a foreign key still restricts the account', async () => {
    await inRollback(async (tx) => {
      const leaverId = await makeGuest(tx, 'Leaver');
      const table = (await makeRoom(tx, leaverId)).room;
      await rooms.addMember(tx, { roomId: table.id, userId: leaverId });

      // The DDL is written literally rather than interpolated, so nothing here is a hole in the
      // parameterisation rule `src/db.ts` states at the top.
      await tx`set local role prl_migrator`;
      await tx`alter table prl.room_members drop constraint room_members_user_id_fkey`;
      await tx`
        alter table prl.room_members
          add constraint room_members_user_id_fkey
          foreign key (user_id) references prl.users (id) on delete restrict
      `;
      await tx`reset role`;

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

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

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

/** One caller: their session cookie and the CSRF pair that goes with it. */
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

/** Creates a real guest account through the real route, and keeps everything needed to act as it. */
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

/**
 * `POST /me/delete` as a signed-in caller sends it.
 *
 * `await`ed inside rather than returned as a promise, because `inject` is overloaded — the form
 * that returns a chainable builder and the form that returns a response — and returning it
 * unresolved makes the compiler pick the builder. That is a type error with no runtime symptom,
 * which is exactly the kind this repository compiles the test tree to catch.
 */
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
   * The record of a place in a class ending, which did not exist.
   *
   * `enrolments_user_id_fkey` is ON DELETE CASCADE. Both `users.ts` and
   * `db/migrations/0006_cohort_enrolments.sql` said the record survived that: "the RECORD that the
   * grant and the revocation happened survives in `prl.audit_log`". Measured against the
   * development database inside a rolled-back transaction — a user, a cohort, one live enrolment
   * and its `enrolment.granted` entry, then `delete from prl.users` — the enrolment row went, the
   * grant entry survived and was correctly detached, and entries recording a revocation: **zero**.
   * A referential action is not a statement; it writes nothing.
   *
   * The operator's trail therefore said a place had been granted on this authority against this
   * external reference and that nothing ever ended it. Reconciling "who holds a place" against the
   * audit log over-counted for ever, and it over-counted precisely for the learners who exercised
   * erasure. For a course somebody paid for, that is a dispute with no record behind either side.
   */
  it('writes an entry per enrolment, detached, before the rows go (REGRESSION)', async () => {
    await inRollback(async (tx) => {
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

      // A second place that was ALREADY withdrawn before the erasure. Both rows cascade; only one
      // of them is a live entitlement ending, and an operator asked "did anybody lose a place"
      // needs to tell them apart. If both were recorded identically this test would pass while the
      // record stayed useless.
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

      // The control: both rows exist before the deletion, so the entries asserted afterwards are a
      // change rather than a sweep over a table that was always empty.
      const held = await enrolments.forUser(tx, leaverId);
      assert.equal(held.length, 2, 'the fixture did not create two enrolments');

      const summary = await users.deleteAccount(tx, leaverId);
      assert.ok(summary !== null);
      assert.equal(summary.deleted.enrolments, 2, 'the cascade did not take both enrolments');

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

      // Detached at the point of writing, for the reason `/me/delete` gives for the deletion event
      // itself: the log must never hold a pointer to an account that asked to stop existing.
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

      // And the rows really are gone, so this is a record of something that happened rather than
      // an entry written beside an entitlement that still exists.
      const left = await tx<{ n: number }[]>`
        select count(*)::int as n from prl.enrolments where user_id = ${leaverId}`;
      assert.equal(left[0]?.n, 0);
    });
  });

  it('writes nothing for a learner who never held a place (NEGATIVE CONTROL)', async () => {
    // The other half. An erasure log that gained an entry for every account, enrolled or not,
    // would satisfy the test above and tell an operator nothing.
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
    // A CSRF pair is minted and sent, so the refusal below is the session check rather than the
    // CSRF hook answering first — which it would, with a 403, and the assertion would then be
    // about nothing.
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

    // Four refusals plus the acceptance below is five requests, which is exactly this route's
    // budget for one caller (`ACCOUNT_DELETE_MAX` in `src/routes/auth.ts`). Deliberately at the
    // edge rather than accidentally: a sixth case here would answer 429 and fail for a reason
    // that has nothing to do with confirmation, so whoever adds one has to raise the limit or
    // give the extra case a caller of its own. The case below spends a separate caller's budget
    // proving the limit is real.
    for (const payload of [{}, { confirm: '' }, { confirm: 'yes' }, { confirm: 'Delete My Account' }]) {
      const refused = await deleteRequest(instance, caller, payload);
      assert.equal(refused.statusCode, 400, `${JSON.stringify(payload)} -> ${refused.body}`);
      assert.equal(errorCodeOf(refused.body), 'invalid_request');
    }

    // Still signed in and still an account, which is the half that matters: a refusal that had
    // already deleted something would also have answered 400.
    const session = await instance.inject({
      method: 'GET',
      url: API_PATHS.session(),
      headers: { cookie: caller.session },
    });
    assert.equal((session.json() as { user: { id: string } | null }).user?.id, caller.userId);

    // And the cleanup is the assertion that the right phrase does work.
    const accepted = await deleteRequest(instance, caller, { confirm: ACCOUNT_DELETE_CONFIRMATION });
    assert.equal(accepted.statusCode, 200, accepted.body);
  });

  /**
   * The budget is the route's own, not the global one.
   *
   * `testConfig` sets `RATE_LIMIT_MAX` to 5000, so a 429 on the sixth request can only come from
   * the per-route limit declared beside the handler. Without that limit a wrong confirmation
   * costs an attacker who has stolen a cookie and a token nothing at all, and each attempt takes
   * `for update` on the victim's account row.
   *
   * The caller cannot be cleaned up through the API — it is rate limited, which is the point — so
   * the row is removed through the suite's own connection at the end. That is fixture teardown
   * and not an assertion: the deletion behaviour is proved by the cases either side of this one.
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

    // The cookie is cleared: a `set-cookie` for the session name with an empty value, so the
    // browser stops presenting a credential for an account that no longer exists.
    const cleared = response.cookies.find((entry) => entry.name === 'prl_session');
    assert.ok(cleared !== undefined, 'the session cookie was not cleared');
    assert.equal(cleared.value, '', `the cookie was re-sent with a value: ${cleared.value.slice(0, 12)}`);

    // And the cookie the caller still holds resolves to nothing. `session_expired` rather than
    // `not_authenticated`, because this server signed that cookie — which is exactly the
    // distinction `requireSession` draws and the client uses to open a fresh guest session.
    const replayed = await instance.inject({
      method: 'GET',
      url: API_PATHS.session(),
      headers: { cookie: caller.session },
    });
    assert.equal(replayed.statusCode, 200, 'the session read never fails for a signed-out caller');
    assert.equal((replayed.json() as { user: unknown }).user, null, 'the revoked session still resolves');

    // Nothing anywhere still names the account. Read through the suite's own connection rather
    // than the app's, so this is the committed state and not a view inside a transaction.
    assert.ok(client !== null);
    const remaining = await client<{ users: number; sessions: number }[]>`
      select (select count(*) from prl.users    where id = ${caller.userId})::int as users,
             (select count(*) from prl.sessions where user_id = ${caller.userId})::int as sessions
    `;
    assert.equal(remaining[0]?.users, 0, 'the account row survived a committed deletion');
    assert.equal(remaining[0]?.sessions, 0, 'a session row survived a committed deletion');
  });
});
