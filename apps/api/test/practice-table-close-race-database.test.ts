/**
 * Retiring a practice table and a friend joining it, on two connections at once.
 *
 * ## The defect
 *
 * Devin Review on PR #25: `RoomRegistry.retirePracticeTables` read the roster, decided nobody else
 * was a member, and closed the row with `rooms.close`, which does not look at the roster. A friend
 * whose join committed in between had their table closed under them. `practice-table-units.test.ts`
 * makes that join inside the registry's gap, in one rolled-back transaction, which proves the
 * registry asks again at the close. What it cannot prove is that asking again in SQL is enough
 * when the join is on another connection, still uncommitted, at the instant the close runs.
 *
 * That is this file. Connection A joins and holds its transaction open — the room-row lock
 * `rooms.addMember` takes, and an uncommitted member. Connection B runs
 * `rooms.closePracticeTable`, which must wait for A and then see A's member.
 *
 * ## Why the data is committed, and removed after
 *
 * Two connections cannot share a rolled-back transaction, so the room and both users are real
 * rows. They are removed through the schema-owning identity (`withAdminSql`), because `prl_app`
 * holds no DELETE on `prl.rooms` and must not.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import * as roomsRepository from '../src/repositories/rooms.ts';
import * as usersRepository from '../src/repositories/users.ts';
import { databaseSkip, TEST_DATABASE_URL, withAdminSql } from './helpers/database.ts';

let client: Sql | undefined;
let skipReason: string | false = databaseSkip('retiring a practice table while a friend joins it');

if (TEST_DATABASE_URL !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
        // One held by the joining transaction, one for the close that waits on it.
        DATABASE_POOL_MAX: '4',
      }),
    );
    await probe`select 1 from prl.rooms limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `the database is configured but the prl schema is not reachable: ${String(error)}`;
  }
}

after(async () => {
  await client?.end({ timeout: 5 });
});

describe('closing a practice table against a concurrent join', { skip: skipReason }, () => {
  const sql = (): Sql => client as Sql;

  it('a join holding the room lock is seen by the close that waited for it', async () => {
    const owner = await usersRepository.createGuest(sql(), { displayName: 'Owner' });
    const friend = await usersRepository.createGuest(sql(), { displayName: 'Friend' });
    const { room } = await roomsRepository.create(sql(), {
      name: 'Heads-up practice',
      ownerUserId: owner.id,
      maxSeats: 2,
      smallBlind: 5,
      bigBlind: 10,
      startingStack: 1_000,
    });
    try {
      let joined!: () => void;
      const holding = new Promise<void>((wake) => {
        joined = wake;
      });
      let commit!: () => void;
      const untilCommit = new Promise<void>((wake) => {
        commit = wake;
      });
      const join = sql().begin(async (tx) => {
        await roomsRepository.addMember(tx, { roomId: room.id, userId: friend.id });
        joined();
        await untilCommit;
      });
      await holding;

      const closing = roomsRepository.closePracticeTable(sql(), room.id, owner.id);
      // The close must be WAITING on the join's lock before the join commits, or this case has not
      // produced the interleaving it is about and would pass on any implementation.
      await withAdminSql(async (watcher) => {
        for (let attempt = 0; attempt < 250; attempt += 1) {
          const rows = await watcher<{ waiting: number }[]>`
            select count(*)::int as waiting
              from pg_locks
             where not granted and pid <> pg_backend_pid()
          `;
          if ((rows[0]?.waiting ?? 0) > 0) return;
          await new Promise((wake) => setTimeout(wake, 20));
        }
        assert.fail('the close never blocked on the join, so this case did not produce its race');
      });
      commit();
      await join;

      assert.equal(await closing, false, "the close did not see the friend's join it had waited for");
      assert.equal((await roomsRepository.byId(sql(), room.id))?.status, 'open');
      assert.ok(await roomsRepository.memberOf(sql(), room.id, friend.id), 'the friend is a member');

      // The control: the same close with nobody else in the room does close it.
      await roomsRepository.removeMember(sql(), room.id, friend.id);
      assert.equal(await roomsRepository.closePracticeTable(sql(), room.id, owner.id), true);
      assert.equal((await roomsRepository.byId(sql(), room.id))?.status, 'closed');
    } finally {
      await withAdminSql(async (admin) => {
        await admin`delete from prl.rooms where id = ${room.id}`;
        await admin`delete from prl.users where id in ${admin([owner.id, friend.id])}`;
      });
    }
  });
});
