/**
 * The hand-route fixtures, written and torn down as a throwaway role holding only `prl_app` (OPS-008).
 * The role is proved bounded first. It is not a superuser, cannot create objects, cannot delete a room.
 * If a migration granted DELETE on `prl.rooms` to `prl_app`, that third assertion fails. The role is
 * created here, not in CI, so the check runs anywhere. Without CREATEROLE the file skips loudly.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Sql } from '../src/db.ts';
import { generateOpaqueSecret, newHandId, newRoomId, newUserId } from '../src/repositories/ids.ts';
import { databaseSkip, TEST_DATABASE_URL, testClientFor } from './helpers/database.ts';
import { persistHand } from './helpers/hand-rows.ts';
import { deleteFixtures, insertGuest, insertHand, insertRoom } from './helpers/hands-app.ts';

const DB_SKIP = databaseSkip('the fixture teardown under the least-privilege role');

/** Unique per run, so two suites on one cluster cannot race a DROP. */
const ROLE = `prl_w3_app_${generateOpaqueSecret()
  .slice(0, 12)
  .toLowerCase()
  .replace(/[^a-z0-9]/gu, 'x')}`;

let appSql: Sql | null = null;
let adminSql: Sql | null = null;
let setupProblem: string | null = null;
/** Restored in `after`, because `withAdminSql` reads it at call time. */
let previousAdminUrl: string | undefined;

function asUser(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

function databaseNameOf(url: string): string {
  const path = new URL(url).pathname;
  return path.startsWith('/') ? path.slice(1) : path;
}

before(async () => {
  if (DB_SKIP !== false || TEST_DATABASE_URL === undefined) {
    console.info(`skipping the least-privilege teardown suite: ${String(DB_SKIP)}`);
    return;
  }
  adminSql = testClientFor(TEST_DATABASE_URL);
  const password = generateOpaqueSecret();
  try {
    // `adminSql(...)` is the driver's identifier escape. Identifiers cannot be parameters.
    await adminSql`create role ${adminSql(ROLE)} login password ${adminSql.unsafe(`'${password.replace(/'/gu, "''")}'`)}`;
    await adminSql`grant prl_app to ${adminSql(ROLE)}`;
    await adminSql`grant connect on database ${adminSql(databaseNameOf(TEST_DATABASE_URL))} to ${adminSql(ROLE)}`;
  } catch (error) {
    // Named rather than swallowed, so proving nothing looks different from passing.
    setupProblem =
      `could not create the least-privilege role ${ROLE} ` +
      `(${error instanceof Error ? error.message : String(error)}). ` +
      'This suite needs an identity with CREATEROLE — the same identity CI uses to run migrations.';
    console.info(`skipping the least-privilege teardown suite: ${setupProblem}`);
    return;
  }
  appSql = testClientFor(asUser(TEST_DATABASE_URL, ROLE, password));
  // Set here, so this file states the CI shape instead of relying on configuration.
  previousAdminUrl = process.env['DATABASE_URL_ADMIN'];
  process.env['DATABASE_URL_ADMIN'] = TEST_DATABASE_URL;
});

after(async () => {
  if (previousAdminUrl === undefined) delete process.env['DATABASE_URL_ADMIN'];
  else process.env['DATABASE_URL_ADMIN'] = previousAdminUrl;
  await appSql?.end({ timeout: 5 }).catch(() => undefined);
  if (adminSql !== null && setupProblem === null && DB_SKIP === false) {
    // A role that holds a grant cannot be dropped, so the grants go first.
    const revoke = async (statement: Promise<unknown>): Promise<void> => {
      await statement.catch(() => undefined);
    };
    await revoke(
      adminSql`revoke all on database ${adminSql(databaseNameOf(TEST_DATABASE_URL ?? ''))} from ${adminSql(ROLE)}`,
    );
    await revoke(adminSql`revoke prl_app from ${adminSql(ROLE)}`);
    await revoke(adminSql`drop role if exists ${adminSql(ROLE)}`);
  }
  await adminSql?.end({ timeout: 5 }).catch(() => undefined);
});

function skipReason(): string | false {
  if (DB_SKIP !== false) return DB_SKIP;
  if (setupProblem !== null) return setupProblem;
  return false;
}

function live(): Sql {
  assert.ok(appSql !== null, 'the least-privilege connection was never opened');
  return appSql;
}

describe('the fixture harness under the least-privilege role', () => {
  it('has a role that is genuinely bounded, or this file proves nothing', async (t) => {
    const reason = skipReason();
    if (reason !== false) return t.skip(reason);
    const sql = live();

    const [attributes] = await sql<{ elevated: boolean }[]>`
      select (rolsuper or rolcreatedb or rolcreaterole) as elevated
        from pg_roles where rolname = current_user
    `;
    assert.equal(attributes?.elevated, false, 'the test identity must not be a privileged role');

    await assert.rejects(
      async () => sql`create table prl.w3_should_not_be_allowed (x int)`,
      /permission denied/iu,
      'a role that can create objects in the prl schema makes this whole file theatre',
    );

    // The assertion this file exists for. If this succeeds, the grant matrix has been widened.
    await assert.rejects(
      async () => sql`delete from prl.rooms where id = 'room_thisdoesnotexistatall'`,
      /permission denied/iu,
      'prl_app must NOT hold DELETE on prl.rooms — that is the finding, not the workaround',
    );
  });

  it('writes and removes a whole hand fixture without ever needing more than prl_app', async (t) => {
    const reason = skipReason();
    if (reason !== false) return t.skip(reason);
    const sql = live();

    const aliceId = newUserId();
    const borysId = newUserId();
    const roomId = newRoomId();
    const handId = newHandId();

    // Application statements go through the app connection, so a missing GRANT fails here.
    await insertGuest(sql, aliceId, 'Alice');
    await insertGuest(sql, borysId, 'Borys');
    await insertRoom(sql, roomId, aliceId);
    await insertHand(
      sql,
      persistHand({
        handId,
        roomId,
        handNumber: 1,
        seats: [
          { seat: 0, userId: aliceId, displayName: 'Alice', stack: 200 },
          { seat: 1, userId: borysId, displayName: 'Borys', stack: 200 },
        ],
        holeCards: { 0: 'AhKs', 1: '7c2d' },
        steps: [{ seat: 0, action: { type: 'fold' } }],
      }),
    );

    const [before] = await sql<{ hands: number }[]>`
      select count(*)::int as hands from prl.hands where room_id = ${roomId}
    `;
    assert.equal(before?.hands, 1, 'the fixture hand was not written');

    // Through the app connection this throws `permission denied for table rooms`.
    await deleteFixtures(sql, [roomId], [aliceId, borysId]);

    const [rooms] = await sql<{ count: number }[]>`
      select count(*)::int as count from prl.rooms where id = ${roomId}
    `;
    const [hands] = await sql<{ count: number }[]>`
      select count(*)::int as count from prl.hands where id = ${handId}
    `;
    const [seats] = await sql<{ count: number }[]>`
      select count(*)::int as count from prl.hand_seats where hand_id = ${handId}
    `;
    const [users] = await sql<{ count: number }[]>`
      select count(*)::int as count from prl.users where id in (${aliceId}, ${borysId})
    `;
    assert.equal(rooms?.count, 0, 'the room row survived the teardown');
    assert.equal(hands?.count, 0, 'the hand did not cascade away with its room');
    assert.equal(seats?.count, 0, 'the hand seats did not cascade away with the hand');
    assert.equal(users?.count, 0, 'the fixture accounts survived the teardown');
  });
});
