/**
 * `postgresRoomStore` against a real database.
 *
 * ## The hole this closes
 *
 * `src/rooms/registry.ts` says out loud why the store is a port: "every test in
 * `test/rooms.test.ts` and `test/ws-router.test.ts` runs against a `Map`-backed fake, so the whole
 * of rooms, seating, the socket protocol and the bots is exercised with no database anywhere."
 * That is a good reason for the port and a bad place to stop: `postgresRoomStore` — the binding
 * every production request actually goes through — had no test at all. A binding that returned the
 * wrong row, dropped an argument, or forgot to await would have been invisible to a suite made
 * entirely of fakes, because the fakes cannot be wrong in the way the binding can.
 *
 * So this file exercises the store's whole declared surface through `postgresRoomStore` itself,
 * never through `roomsRepository` directly. The repository has its own suite; this one is about
 * the *binding* and about the SQL agreeing with the behaviour the fakes promise.
 *
 * ## Every case runs inside a transaction that is rolled back
 *
 * `postgresRoomStore` takes `() => Db`, and `Db` is `Sql | TransactionSql` — so the store can be
 * bound to a transaction handle exactly as easily as to the pool. That is what lets each case
 * create its own rooms, members and accounts and leave nothing behind: nothing here is ever
 * committed, so the file is safe to run repeatedly, alongside other suites, and against a seeded
 * development database.
 *
 * Two consequences worth stating because they shape the assertions:
 *
 *   - `now()` does not advance inside a transaction, so every row this file writes shares one
 *     `created_at`. Anything that would assert an ordering by time is therefore asserted as set
 *     membership instead — an ordering that only holds because of a tie-break on a random id is
 *     not a property worth pinning.
 *   - A failed statement aborts the transaction, so every expected rejection runs inside a
 *     savepoint (`rejectsWith`). Without it the first expected `seat_taken` would make every later
 *     assertion in the same case fail with `25P02` instead.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { ErrorCode } from '@prl/contracts';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { sha256 } from '../src/repositories/hashing.ts';
import { generateId } from '../src/repositories/ids.ts';
import type { RoomRow } from '../src/repositories/rooms.ts';
import * as usersRepository from '../src/repositories/users.ts';
import {
  type CreateRoomSpec,
  durableProfile,
  postgresRoomStore,
  type RoomStore,
} from '../src/rooms/registry.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

/**
 * Connects once, or records why the suite cannot run.
 *
 * The shape (and the reason for the probe rather than a bare `DATABASE_URL` check) is
 * `test/repositories.test.ts`'s, deliberately: a URL that points at nothing and a database with no
 * migrations need different fixes, and `test/database-availability.test.ts` is what makes a run
 * with neither fail loudly rather than skip in silence.
 */
const databaseUrl = TEST_DATABASE_URL;
let client: Sql | null = null;
let skipReason: string | false = databaseSkip('the Postgres room store');

if (databaseUrl !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: databaseUrl,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
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
  console.info(`[coverage-room-store.test.ts] skipping database-backed tests: ${skipReason}`);
}

const dbOptions = { skip: skipReason };

after(async () => {
  if (client !== null) await client.end({ timeout: 5 });
});

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

/** Asserts `run` rejects with `code`, inside a savepoint so the transaction survives it. */
async function rejectsWith(tx: TransactionSql, code: ErrorCode, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    tx.savepoint(async () => {
      await run();
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === code
        ? true
        : (() => {
            throw error;
          })(),
    `expected ${code}`,
  );
}

async function makeGuest(tx: TransactionSql, name: string): Promise<string> {
  const user = await usersRepository.createGuest(tx, { displayName: name });
  return user.id;
}

/** The store under test, bound to one transaction. */
function storeOn(tx: TransactionSql): RoomStore {
  return postgresRoomStore(() => tx);
}

const ROOM_SPEC: Omit<CreateRoomSpec, 'ownerUserId'> = {
  name: 'Kitchen table',
  maxSeats: 6,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
};

describe('postgresRoomStore — create and read', dbOptions, () => {
  it('creates a room, stores only the digest of the invite code, and finds it both ways', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');

      const created = await store.create({ ...ROOM_SPEC, ownerUserId: owner });
      const room: RoomRow = created.room;
      assert.equal(room.name, 'Kitchen table');
      assert.equal(room.owner_user_id, owner);
      assert.equal(room.max_seats, 6);
      assert.equal(room.small_blind, 1);
      assert.equal(room.big_blind, 2);
      assert.equal(room.ante, 0, 'an omitted ante defaults to none, not to null');
      assert.equal(room.starting_stack, 200);
      assert.equal(room.action_timeout_seconds, 30, 'the documented default');
      assert.equal(room.visibility, 'invite_only');
      assert.equal(room.status, 'open');
      assert.equal(room.closed_at, null);

      // The whole point of the one-time code: what is stored is a digest, and nothing anywhere
      // holds the plaintext. Both halves are asserted, because a column added later called
      // `invite_code` would satisfy the first and destroy the property.
      const stored = await tx<{ invite_code_hash: Buffer }[]>`
        select invite_code_hash from prl.rooms where id = ${room.id}
      `;
      assert.deepEqual(stored[0]?.invite_code_hash, sha256(created.inviteCode));
      const plaintextColumns = await tx<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'prl' and table_name = 'rooms' and column_name = 'invite_code'
      `;
      // `.map` rather than comparing the rows directly: postgres.js returns a `Result`, which is an
      // Array subclass, and `deepStrictEqual` compares prototypes.
      assert.deepEqual(
        plaintextColumns.map((column) => column.column_name),
        [],
        'there must be no column holding a raw invite code',
      );

      assert.equal((await store.byId(room.id))?.id, room.id);
      assert.equal(await store.byId(generateId('room')), null, 'an unknown room id is null');

      assert.equal((await store.byInviteCode(created.inviteCode))?.id, room.id);
      // A code pasted out of a chat message picks up case and whitespace; `normaliseInviteCode`
      // folds both, and a store that hashed the raw text would refuse the owner's own guests.
      assert.equal((await store.byInviteCode(` ${created.inviteCode.toLowerCase()} `))?.id, room.id);
      assert.equal(await store.byInviteCode('NOT-A-REAL-CODE'), null);
      assert.equal(await store.byInviteCode(''), null, 'a code that cannot be one is not an error');
    });
  });

  it('mints a different code per room, and refuses a table configuration the CHECKs would', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');

      const first = await store.create({ ...ROOM_SPEC, ownerUserId: owner });
      const second = await store.create({ ...ROOM_SPEC, ownerUserId: owner });
      assert.notEqual(first.inviteCode, second.inviteCode);
      assert.notEqual(first.room.id, second.room.id);
      assert.equal((await store.byInviteCode(first.inviteCode))?.id, first.room.id);
      assert.equal((await store.byInviteCode(second.inviteCode))?.id, second.room.id);

      // `bigBlind <= smallBlind` is a CHECK constraint the request schema cannot express, so a
      // store that passed it through would answer a plainly bad request with a 500.
      await rejectsWith(tx, 'invalid_request', () =>
        store.create({ ...ROOM_SPEC, ownerUserId: owner, smallBlind: 5, bigBlind: 5 }),
      );
    });
  });
});

describe('postgresRoomStore — membership and seating', dbOptions, () => {
  it('adds members, seats them, and lets the database refuse a taken seat', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const guest = await makeGuest(tx, 'Guest');
      const { room } = await store.create({ ...ROOM_SPEC, ownerUserId: owner });

      assert.equal(await store.memberOf(room.id, owner), null, 'creating a room is not joining it');

      const joined = await store.addMember({ roomId: room.id, userId: owner });
      assert.equal(joined.room_id, room.id);
      assert.equal(joined.user_id, owner);
      assert.equal(joined.display_name, 'Owner', 'the roster carries the name, joined from users');
      assert.equal(joined.seat, null, 'a new member is waiting, not seated');
      assert.equal(joined.stack, 200, "an omitted stack is the room's starting stack");
      assert.equal(joined.is_bot, false);
      assert.equal(joined.bot_profile, null);
      assert.equal(joined.left_at, null);

      await store.addMember({ roomId: room.id, userId: guest, stack: 150 });
      assert.equal((await store.memberOf(room.id, guest))?.stack, 150, 'an explicit stack is kept');

      await store.seatMember(room.id, owner, 0);
      assert.equal((await store.memberOf(room.id, owner))?.seat, 0);

      // The index is the arbiter, not an application check: this is the case two players tapping
      // the same chair in the same instant produce, and it must be `seat_taken`, not a 500.
      await rejectsWith(tx, 'seat_taken', () => store.seatMember(room.id, guest, 0));

      await store.seatMember(room.id, guest, 1);
      assert.equal((await store.memberOf(room.id, guest))?.seat, 1);

      await store.unseatMember(room.id, owner);
      assert.equal((await store.memberOf(room.id, owner))?.seat, null, 'standing frees the chair');
      await store.seatMember(room.id, guest, 0);
      assert.equal((await store.memberOf(room.id, guest))?.seat, 0, 'the freed seat is takeable');
    });
  });

  it('refuses a second live membership and a table with no free seats', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const guest = await makeGuest(tx, 'Guest');
      const latecomer = await makeGuest(tx, 'Latecomer');
      const { room } = await store.create({ ...ROOM_SPEC, ownerUserId: owner, maxSeats: 2 });

      await store.addMember({ roomId: room.id, userId: owner });
      await rejectsWith(tx, 'already_seated', () => store.addMember({ roomId: room.id, userId: owner }));

      await store.addMember({ roomId: room.id, userId: guest });
      await rejectsWith(tx, 'room_full', () => store.addMember({ roomId: room.id, userId: latecomer }));

      // "That room exists but is not yours" is the one answer the room codes exist to avoid, so an
      // unknown room and a room somebody may not touch produce the same error.
      await rejectsWith(tx, 'room_not_found_or_not_permitted', () =>
        store.addMember({ roomId: generateId('room'), userId: latecomer }),
      );
    });
  });

  it('leaving keeps the row, frees the seat, and stops the member being live', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const guest = await makeGuest(tx, 'Guest');
      const { room } = await store.create({ ...ROOM_SPEC, ownerUserId: owner });

      await store.addMember({ roomId: room.id, userId: owner });
      await store.addMember({ roomId: room.id, userId: guest });
      await store.seatMember(room.id, guest, 3);

      await store.removeMember(room.id, guest);
      assert.equal(await store.memberOf(room.id, guest), null, 'a departed member is not live');
      const roster = await store.membersOfRooms([room.id]);
      assert.deepEqual(
        roster.map((member) => member.user_id),
        [owner],
        'the default roster is the live one',
      );

      // The row itself survives: `left_at` is a timestamp, not a DELETE, because the roster of a
      // finished table is history and the hands played there still reference it.
      const kept = await tx<{ left_at: Date | null; seat: number | null }[]>`
        select left_at, seat from prl.room_members where room_id = ${room.id} and user_id = ${guest}
      `;
      assert.equal(kept.length, 1, 'leaving must not delete the membership row');
      assert.ok(kept[0]?.left_at instanceof Date, 'left_at records when they left');
      assert.equal(kept[0]?.seat, 3, 'the seat number stays as the record of where they sat');

      // And the freed seat is genuinely free, which is the property the partial index provides.
      await store.seatMember(room.id, owner, 3);
      assert.equal((await store.memberOf(room.id, owner))?.seat, 3);
    });
  });

  it('seats bots as real users, including a profile the CHECK predates', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const { room } = await store.create({ ...ROOM_SPEC, ownerUserId: owner });

      const bot = await store.createBotUser('Station');
      assert.ok(bot.id.startsWith('usr_'), `a bot needs a real user row, got ${bot.id}`);
      assert.equal(bot.displayName, 'Station');
      const row = await tx<{ kind: string }[]>`select kind from prl.users where id = ${bot.id}`;
      assert.equal(row[0]?.kind, 'guest', 'a bot is an ordinary account, so a seat is a seat');

      const seated = await store.addMember({
        roomId: room.id,
        userId: bot.id,
        isBot: true,
        bot: { profileId: durableProfile('calling-station'), difficulty: 'realistic', seed: 7 },
      });
      assert.equal(seated.is_bot, true);
      assert.equal(seated.bot_profile, 'calling-station');

      // Rewritten. This block used to assert that a Legends profile the CHECK could not name was
      // stored as the literal string `unknown`, and called that "the fallback working". It was the
      // defect: the learner's chosen opponent was destroyed at write time and no restart could
      // recover it. Migration 0003 widened the column, so the id goes in verbatim.
      const legend = await store.createBotUser('Legend');
      const legendMember = await store.addMember({
        roomId: room.id,
        userId: legend.id,
        isBot: true,
        bot: { profileId: durableProfile('adaptive-exploiter'), difficulty: 'expert', seed: 99 },
      });
      assert.equal(legendMember.bot_profile, 'adaptive-exploiter');
      assert.equal(legendMember.bot_difficulty, 'expert');
      assert.equal(legendMember.bot_seed, 99);

      // An id no build carries never reaches the column: `durableProfile` refuses it first.
      assert.throws(() => durableProfile('some-legends-profile-id'));

      // A bot seat with no strategy configuration is refused — it could not be rehydrated.
      const halfBot = await store.createBotUser('Half');
      await rejectsWith(tx, 'invalid_request', () =>
        store.addMember({ roomId: room.id, userId: halfBot.id, isBot: true }),
      );

      // The other half of `room_members_bot_profile_iff_bot`: a human seat may not carry one.
      const human = await makeGuest(tx, 'Human');
      await rejectsWith(tx, 'invalid_request', () =>
        store.addMember({
          roomId: room.id,
          userId: human,
          bot: { profileId: 'volume-grinder', difficulty: 'realistic', seed: 1 },
        }),
      );
    });
  });
});

describe('postgresRoomStore — rosters, listing and closing', dbOptions, () => {
  it('answers several rooms in one call, seated members first', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const guest = await makeGuest(tx, 'Guest');
      const first = await store.create({ ...ROOM_SPEC, ownerUserId: owner });
      const second = await store.create({ ...ROOM_SPEC, ownerUserId: owner, name: 'Second table' });

      await store.addMember({ roomId: first.room.id, userId: owner });
      await store.addMember({ roomId: first.room.id, userId: guest });
      await store.seatMember(first.room.id, guest, 2);
      await store.addMember({ roomId: second.room.id, userId: owner });

      assert.deepEqual(await store.membersOfRooms([]), [], 'no rooms is an empty answer, not an error');

      const both = await store.membersOfRooms([first.room.id, second.room.id]);
      assert.equal(both.length, 3);
      const inFirst = both.filter((member) => member.room_id === first.room.id);
      assert.deepEqual(
        inFirst.map((member) => member.user_id),
        [guest, owner],
        'seated members come before those waiting (seat asc nulls last)',
      );
      assert.deepEqual(
        both.filter((member) => member.room_id === second.room.id).map((member) => member.user_id),
        [owner],
      );
    });
  });

  it('lists the rooms a learner owns or sits at, and drops the closed ones', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const guest = await makeGuest(tx, 'Guest');
      const stranger = await makeGuest(tx, 'Stranger');
      const kept = await store.create({ ...ROOM_SPEC, ownerUserId: owner });
      const closing = await store.create({ ...ROOM_SPEC, ownerUserId: owner, name: 'Doomed table' });

      await store.addMember({ roomId: kept.room.id, userId: guest });

      // Set membership rather than order: `now()` is frozen inside a transaction, so both rooms
      // share a `created_at` and the list's ordering would fall to a tie-break on a random id.
      const ownerRooms = await store.listForUser(owner);
      assert.deepEqual(new Set(ownerRooms.map((room) => room.id)), new Set([kept.room.id, closing.room.id]));
      assert.deepEqual(
        (await store.listForUser(guest)).map((room) => room.id),
        [kept.room.id],
        'a member sees the room they joined and nothing else',
      );
      assert.deepEqual(
        (await store.listForUser(stranger)).map((room) => room.id),
        [],
        'a stranger sees nothing',
      );

      assert.equal(await store.close(closing.room.id, owner), true);
      assert.deepEqual(
        (await store.listForUser(owner)).map((room) => room.id),
        [kept.room.id],
        'a closed room leaves the list a learner goes to in order to play',
      );
      // Closed, not gone: the hands played there still reference it.
      const closed = await store.byId(closing.room.id);
      assert.equal(closed?.status, 'closed');
      assert.ok(closed?.closed_at instanceof Date, 'status and closed_at move together');
    });
  });

  it('closes only for the owner, and only once', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const stranger = await makeGuest(tx, 'Stranger');
      const { room } = await store.create({ ...ROOM_SPEC, ownerUserId: owner });

      assert.equal(await store.close(room.id, stranger), false, 'a non-owner cannot close a table');
      assert.equal((await store.byId(room.id))?.status, 'open');
      assert.equal(await store.close(room.id, owner), true);
      assert.equal(await store.close(room.id, owner), false, 'closing twice is not two closures');
      assert.equal(await store.close(generateId('room'), owner), false, 'an unknown room is false');
    });
  });
});

describe('postgresRoomStore — units', dbOptions, () => {
  it('reports the standing allowance until the learner has chips at a table', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');

      assert.equal(
        await store.readUnits(owner),
        usersRepository.DEFAULT_UNIT_ALLOWANCE,
        'a learner with no table has the standing allowance, not zero',
      );

      const { room } = await store.create({ ...ROOM_SPEC, ownerUserId: owner });
      await store.addMember({ roomId: room.id, userId: owner, stack: 175 });
      assert.equal(await store.readUnits(owner), 175, 'units are the chips in front of them');

      // There is no `units` column — the figure is derived from live seats — so a member who
      // leaves goes back to the allowance rather than to whatever their last stack was.
      await store.removeMember(room.id, owner);
      assert.equal(await store.readUnits(owner), usersRepository.DEFAULT_UNIT_ALLOWANCE);
    });
  });
});
