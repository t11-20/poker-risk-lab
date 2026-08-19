/**
 * Every AI Legend must survive the death of the process that seated it.
 *
 * ## The defect
 *
 * `room_members.bot_profile` was CHECK-constrained to the five values of `OPPONENT_PROFILES` —
 * the Scenario Lab's *range* vocabulary — and the write path squeezed a strategy profile through
 * it with `persistableProfile`, which answered the literal string `unknown` for anything those
 * five names could not express. Seven of the twelve. The live registry held the real id, so the
 * mismatch was invisible for exactly as long as the process lived.
 *
 * Then `ensureOpen` re-took every recorded seat and registered no bots at all — deliberately, on
 * the reasoning that an inert seat is more honest than one playing a different style. So a
 * restart turned a Legends table into six seats that do nothing until the turn clock folds them,
 * and for seven of the twelve profiles there was not even a name left to say who had been there.
 *
 * ## What this file proves, and why in this shape
 *
 * The first suite runs against a REAL database, because the defect was half a CHECK constraint:
 * a fake store cannot reject a value, so a fake store cannot prove the column accepts one. All
 * twelve profiles are written and read back, and the read is asserted field by field.
 *
 * The second suite builds a room in one `RoomRegistry`, throws that registry away, and opens the
 * same rows in a SECOND registry. That second object is what "after a process restart" means
 * here: the live table, the bot runner and every `OpponentModel` are new, and the only thing
 * carried across is the durable rows — which is exactly the carry a real restart gets.
 *
 * `specOf` is asserted rather than `profileOf`, because a seat is `(profile, difficulty, seed)`
 * and a restart that restored only the first would look right and play differently.
 *
 * The third suite is the negative half. A row this build cannot reproduce must produce an inert
 * seat and a logged reason — never a substituted strategy. Fixing "the bots do not come back" is
 * one careless line away from "the bots come back as somebody else", which would be worse: the
 * learner would be studying an opponent nobody chose, with nothing on screen to say so.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { PROFILES } from '@prl/poker-ai';
import { createSecureRandom } from '@prl/poker-engine';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql, type TransactionSql } from '../src/db.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { PERSISTABLE_BOT_PROFILES, UNRECOVERABLE_BOT_PROFILE } from '../src/rooms/bot-profile.ts';
import { seedFor } from '../src/rooms/bots.ts';
import {
  type CreateRoomSpec,
  postgresRoomStore,
  RoomRegistry,
  type RoomStore,
} from '../src/rooms/registry.ts';
import { createManualClock } from '../src/rooms/timers.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

const databaseUrl = TEST_DATABASE_URL;
let client: Sql | null = null;
let skipReason: string | false = databaseSkip('bot seat recovery across a restart');

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
    await probe`select 1 from prl.room_members limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `prl schema is not reachable (${error instanceof Error ? error.name : 'error'}): run pnpm db:migrate`;
  }
}

if (skipReason !== false) {
  console.info(`[z3-bot-restart-recovery.test.ts] skipping database-backed tests: ${skipReason}`);
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

const ROOM_SPEC: Omit<CreateRoomSpec, 'ownerUserId'> = {
  name: 'Legends practice',
  maxSeats: 6,
  smallBlind: 1,
  bigBlind: 2,
  startingStack: 200,
};

function registryOn(store: RoomStore, problems: string[]): RoomRegistry {
  return new RoomRegistry({
    store,
    clock: createManualClock(),
    random: createSecureRandom(),
    onProblem: (message, detail) => problems.push(`${message} ${JSON.stringify(detail ?? {})}`),
  });
}

// ---------------------------------------------------------------------------
// 1. The column can name every profile this build carries
// ---------------------------------------------------------------------------

describe('room_members can durably name every strategy profile', dbOptions, () => {
  it('writes and reads back all twelve, with difficulty and seed intact', async () => {
    await inRollback(async (tx) => {
      const store = postgresRoomStore(() => tx);
      const owner = await usersRepository.createGuest(tx, { displayName: 'Owner' });
      const created = await store.create({ ...ROOM_SPEC, ownerUserId: owner.id });
      const roomId = created.room.id;

      // Six seats to a table, twelve profiles: two rooms. Written through the real store, so the
      // CHECK constraint is the thing being tested rather than a TypeScript union.
      const rooms = [roomId];
      const second = await store.create({ ...ROOM_SPEC, ownerUserId: owner.id });
      rooms.push(second.room.id);

      const written = new Map<string, { difficulty: string; seed: number; roomId: string }>();
      for (const [index, profile] of PROFILES.entries()) {
        const target = rooms[Math.floor(index / 6)] as string;
        const seat = index % 6;
        const difficulty = (['educational', 'realistic', 'expert'] as const)[index % 3] as
          | 'educational'
          | 'realistic'
          | 'expert';
        const seed = seedFor(target, seat, index);
        const bot = await store.createBotUser(`Bot ${index}`);
        await store.addMember({
          roomId: target,
          userId: bot.id,
          isBot: true,
          bot: { profileId: profile.naming.id, difficulty, seed },
        });
        await store.seatMember(target, bot.id, seat);
        written.set(profile.naming.id, { difficulty, seed, roomId: target });
      }

      const members = await store.membersOfRooms(rooms);
      for (const profile of PROFILES) {
        const expected = written.get(profile.naming.id);
        assert.ok(expected !== undefined);
        const row = members.find((member) => member.bot_profile === profile.naming.id);
        assert.ok(
          row !== undefined,
          `${profile.naming.id} did not survive the round trip — this is the original defect: ` +
            'seven of the twelve used to come back as the string "unknown"',
        );
        assert.equal(row.bot_difficulty, expected.difficulty);
        assert.equal(row.bot_seed, expected.seed, 'the seed must round-trip through the bigint column');
        assert.equal(
          typeof row.bot_seed,
          'number',
          'postgres.js returns int8 as a string; it must be converted',
        );
      }

      const stored = new Set(members.filter((m) => m.is_bot).map((m) => m.bot_profile));
      assert.equal(
        stored.has(UNRECOVERABLE_BOT_PROFILE),
        false,
        'nothing this build writes may fall back to "unknown"',
      );
      assert.equal(stored.size, PROFILES.length, 'every profile must be distinguishable in the roster');
    });
  });

  it('refuses a profile the runtime does not carry, at the column', async () => {
    await inRollback(async (tx) => {
      const owner = await usersRepository.createGuest(tx, { displayName: 'Owner' });
      const store = postgresRoomStore(() => tx);
      const created = await store.create({ ...ROOM_SPEC, ownerUserId: owner.id });
      const bot = await store.createBotUser('Retired');

      // Straight SQL, bypassing `durableProfile`, so it is the CHECK constraint answering.
      await assert.rejects(
        tx.savepoint(
          async () =>
            await tx`
              insert into prl.room_members (id, room_id, user_id, seat, stack, is_bot, bot_profile)
              values ('mem_z3retired', ${created.room.id}, ${bot.id}, 0, 200, true, 'a-retired-legend')
            `,
        ),
        /room_members_bot_profile_allowed/,
        'the database itself must reject a profile no build carries',
      );
    });
  });

  it('keeps the persisted vocabulary and the runtime one in step', () => {
    assert.deepEqual(
      [...PERSISTABLE_BOT_PROFILES].sort(),
      [...PROFILES.map((profile) => profile.naming.id), UNRECOVERABLE_BOT_PROFILE].sort(),
      'PERSISTABLE_BOT_PROFILES is derived from PROFILES; if this fails the derivation was replaced ' +
        'by a hand-written list, which is how the two drifted apart the first time',
    );
  });
});

// ---------------------------------------------------------------------------
// 2. A second registry over the same rows is the restart
// ---------------------------------------------------------------------------

describe('a restarted process puts every Legend back', dbOptions, () => {
  it('rehydrates profile, difficulty and seed for all twelve', async () => {
    await inRollback(async (tx) => {
      const store = postgresRoomStore(() => tx);
      const owner = await usersRepository.createGuest(tx, { displayName: 'Owner' });

      for (const [index, profile] of PROFILES.entries()) {
        const difficulty = (['educational', 'realistic', 'expert'] as const)[index % 3] as
          | 'educational'
          | 'realistic'
          | 'expert';

        // ---- the process that seats the bot -------------------------------------------
        const before: string[] = [];
        const first = registryOn(store, before);
        const created = await first.createRoom(
          { userId: owner.id, displayName: 'Owner' },
          { ...ROOM_SPEC, maxSeats: 2 },
        );
        const roomId = created.room.record.id;
        const bot = await store.createBotUser(`Bot ${index}`);
        const seed = seedFor(roomId, 1, undefined);
        await store.addMember({
          roomId,
          userId: bot.id,
          isBot: true,
          bot: { profileId: profile.naming.id, difficulty, seed },
        });
        await store.seatMember(roomId, bot.id, 1);
        await first.seatBot(roomId, {
          userId: bot.id,
          displayName: `Bot ${index}`,
          seat: 1,
          profileId: profile.naming.id,
          difficulty,
          seed,
        });
        assert.equal(
          created.room.bots.seatCount,
          1,
          'precondition: the bot is registered before the restart',
        );

        // ---- the process ends. Everything in memory goes with it. ---------------------
        first.closeAll();

        // ---- a new process, the same rows ---------------------------------------------
        const problems: string[] = [];
        const restarted = registryOn(store, problems);
        const reopened = await restarted.ensureOpen(roomId);
        assert.ok(reopened !== null, `${profile.naming.id}: the room did not reopen`);

        assert.equal(
          reopened.bots.seatCount,
          1,
          `${profile.naming.id}: the seat came back with no bot on it — a timeout-folder, which is ` +
            'the defect this test exists for',
        );
        const spec = reopened.bots.specOf(bot.id);
        assert.ok(spec !== null, `${profile.naming.id}: the runner does not know this seat`);
        assert.equal(spec.profileId, profile.naming.id, 'the exact profile, not a nearest match');
        assert.equal(spec.difficulty, difficulty, 'difficulty scales every trait, so it is part of identity');
        assert.equal(spec.seed, seed, 'the seed fixes the decision stream');
        assert.equal(spec.seat, 1);
        assert.deepEqual(problems, [], `${profile.naming.id}: rehydration should not have logged a problem`);

        // The roster the client is served must agree with the runner.
        assert.equal(
          restarted.summary(roomId).members.find((m) => m.userId === bot.id)?.botProfile,
          profile.naming.id,
        );
        restarted.closeAll();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 3. What must NOT happen: a substituted opponent
// ---------------------------------------------------------------------------

describe('an unrehydratable bot seat fails safely and explicitly', dbOptions, () => {
  for (const broken of [
    {
      what: 'a pre-0003 row whose profile was destroyed at write time',
      profile: UNRECOVERABLE_BOT_PROFILE,
      difficulty: null,
      seed: null,
    },
    {
      what: 'a row with a profile but no difficulty or seed',
      profile: 'adaptive-exploiter',
      difficulty: null,
      seed: null,
    },
  ]) {
    it(`refuses ${broken.what} without substituting a strategy`, async () => {
      await inRollback(async (tx) => {
        const store = postgresRoomStore(() => tx);
        const owner = await usersRepository.createGuest(tx, { displayName: 'Owner' });
        const seeding: string[] = [];
        const first = registryOn(store, seeding);
        const created = await first.createRoom(
          { userId: owner.id, displayName: 'Owner' },
          { ...ROOM_SPEC, maxSeats: 2 },
        );
        const roomId = created.room.record.id;
        first.closeAll();

        // Written with raw SQL: `addMember` refuses these shapes on purpose, which is the forward
        // guarantee. This is the row a database that predates migration 0003 already contains.
        const bot = await store.createBotUser('Legacy');
        await tx`
          insert into prl.room_members
                 (id, room_id, user_id, seat, stack, is_bot, bot_profile, bot_difficulty, bot_seed)
          values (${`mem_z3${Math.abs(broken.what.length)}${bot.id.slice(-6)}`}, ${roomId}, ${bot.id},
                  1, 200, true, ${broken.profile}, ${broken.difficulty}, ${broken.seed})
        `;

        const problems: string[] = [];
        const restarted = registryOn(store, problems);
        const reopened = await restarted.ensureOpen(roomId);
        assert.ok(reopened !== null);

        assert.equal(
          reopened.bots.seatCount,
          0,
          'no strategy may be invented for a row that cannot name one',
        );
        assert.equal(reopened.bots.specOf(bot.id), null);
        assert.equal(problems.length, 1, 'the refusal must be logged, not silent');
        assert.match(problems[0] ?? '', /could not be restored and will not act/);

        // The seat itself is still occupied, so the table is consistent and the turn clock can
        // resolve it. Losing the room over one unrepairable row would be the other failure.
        const roster = restarted.summary(roomId).members;
        const seated = roster.find((member) => member.userId === bot.id);
        assert.ok(seated !== undefined, 'the seat must still be part of the room');
        assert.equal(seated.isBot, true);
        restarted.closeAll();
      });
    });
  }
});
