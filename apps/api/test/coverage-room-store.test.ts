/**
 * `postgresRoomStore` against a real database, through the binding itself rather than
 * `roomsRepository`, because every other rooms suite uses a `Map` fake. Each case runs in a
 * rolled-back transaction. `now()` is frozen there, so time orderings are asserted as set
 * membership, and expected rejections run in a savepoint (`rejectsWith`) to avoid `25P02`.
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

/** A URL that reaches nothing and an unmigrated database need different fixes, so they are told apart. */
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

      // Only a digest is stored. Both halves are asserted, because a later `invite_code` column
      // would pass the first and destroy the property.
      const stored = await tx<{ invite_code_hash: Buffer }[]>`
        select invite_code_hash from prl.rooms where id = ${room.id}
      `;
      assert.deepEqual(stored[0]?.invite_code_hash, sha256(created.inviteCode));
      const plaintextColumns = await tx<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'prl' and table_name = 'rooms' and column_name = 'invite_code'
      `;
      // postgres.js returns a `Result` subclass, and `deepStrictEqual` compares prototypes.
      assert.deepEqual(
        plaintextColumns.map((column) => column.column_name),
        [],
        'there must be no column holding a raw invite code',
      );

      assert.equal((await store.byId(room.id))?.id, room.id);
      assert.equal(await store.byId(generateId('room')), null, 'an unknown room id is null');

      assert.equal((await store.byInviteCode(created.inviteCode))?.id, room.id);
      // A code pasted from chat picks up case and whitespace, which `normaliseInviteCode` folds.
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

      // A CHECK the request schema cannot express, so it must map to `invalid_request`, not a 500.
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

      // Two players tapping one chair at once must get `seat_taken` from the index, not a 500.
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

      // An unknown room and a forbidden room give the same error.
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

      // `left_at` is a timestamp, not a DELETE, because the hands played there reference the row.
      const kept = await tx<{ left_at: Date | null; seat: number | null }[]>`
        select left_at, seat from prl.room_members where room_id = ${room.id} and user_id = ${guest}
      `;
      assert.equal(kept.length, 1, 'leaving must not delete the membership row');
      assert.ok(kept[0]?.left_at instanceof Date, 'left_at records when they left');
      assert.equal(kept[0]?.seat, 3, 'the seat number stays as the record of where they sat');

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

      // Migration 0003 widened the column, so a Legends id goes in verbatim.
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

      assert.throws(() => durableProfile('some-legends-profile-id'));

      // A bot seat with no strategy configuration could not be rehydrated.
      const halfBot = await store.createBotUser('Half');
      await rejectsWith(tx, 'invalid_request', () =>
        store.addMember({ roomId: room.id, userId: halfBot.id, isBot: true }),
      );

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

  it('closes a practice table only while no other person is a member', async () => {
    await inRollback(async (tx) => {
      const store = storeOn(tx);
      const owner = await makeGuest(tx, 'Owner');
      const friend = await makeGuest(tx, 'Friend');
      const bot = await store.createBotUser('Bot');
      const { room } = await store.create({ ...ROOM_SPEC, ownerUserId: owner });
      await store.addMember({
        roomId: room.id,
        userId: bot.id,
        isBot: true,
        bot: { profileId: 'calling-station', difficulty: 'educational', seed: 7 },
      });
      await store.addMember({ roomId: room.id, userId: friend });

      assert.equal(await store.closePracticeTable(room.id, owner), false, 'a friend is a member');
      assert.equal(await store.closePracticeTable(room.id, friend), false, 'only for the owner');
      assert.equal((await store.byId(room.id))?.status, 'open');
      await store.removeMember(room.id, friend);
      assert.equal(await store.closePracticeTable(room.id, owner), true, 'the owner and a bot only');
      assert.equal((await store.byId(room.id))?.status, 'closed');
      assert.equal(await store.closePracticeTable(room.id, owner), false, 'twice is not two closures');
      assert.equal(await store.closePracticeTable(generateId('room'), owner), false, 'an unknown room');
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
      // A membership counts only once the learner has sat (`users.readUnits`).
      await store.seatMember(room.id, owner, 0);
      assert.equal(await store.readUnits(owner), 175, 'units are the chips in front of them');

      // No `units` column. The figure is derived from live seats.
      await store.removeMember(room.id, owner);
      assert.equal(await store.readUnits(owner), usersRepository.DEFAULT_UNIT_ALLOWANCE);
    });
  });
});
