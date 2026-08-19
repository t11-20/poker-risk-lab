/**
 * The hand-route fixtures, run end to end as the RUNTIME role.
 *
 * ## The finding this closes (OPS-008)
 *
 * `db/migrations/0001_initial.sql` defines two roles: `prl_migrator` owns the schema, `prl_app` is
 * the runtime identity and holds the narrowest verb set the API actually needs — no DELETE on the
 * append-only tables, `prl.rooms` among them. CI's `end-to-end` and `a11y` jobs run the server as
 * a member of `prl_app` and so prove the model holds. The `test` job — the only job that runs the
 * SQL-backed suites at all — did not, and could not: `test/helpers/hands-app.ts` cleaned its
 * fixtures up with `delete from prl.rooms`, which `prl_app` may not do. So the job kept the
 * superuser, and the privilege model went unexercised by the one job in a position to exercise it.
 *
 * The fix was not to widen the grant. It was for the teardown to say which identity it needs: the
 * room delete goes to the schema-owning identity through `withAdminSql`, and everything the
 * application legitimately does stays on the application's own connection.
 *
 * ## What this file actually does
 *
 * It builds the real thing rather than asserting about it. A throwaway LOGIN role is created,
 * granted `prl_app` and nothing else, and proved bounded before it is trusted — it must not be a
 * superuser, must not be able to create objects, and must NOT be able to delete a room. The hand
 * fixtures are then written and torn down through that connection, exactly as the suite would in a
 * CI job configured for least privilege.
 *
 * The negative control is the third assertion in `the role is genuinely bounded`: if a future
 * migration quietly granted DELETE on `prl.rooms` to `prl_app`, the teardown below would pass for
 * the wrong reason and nothing else in the repository would notice. That assertion fails instead.
 *
 * ## Why the role is created here rather than in CI
 *
 * Because a test that depends on the CI job being configured a particular way proves nothing when
 * run anywhere else, and the whole lesson of this finding is that a gate nobody runs is not a gate.
 * Creating the role needs CREATEROLE; when the connected identity has not got it the file says so
 * out loud and skips, rather than passing quietly.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Sql } from '../src/db.ts';
import { generateOpaqueSecret, newHandId, newRoomId, newUserId } from '../src/repositories/ids.ts';
import { databaseSkip, TEST_DATABASE_URL, testClientFor } from './helpers/database.ts';
import { persistHand } from './helpers/hand-rows.ts';
import { deleteFixtures, insertGuest, insertHand, insertRoom } from './helpers/hands-app.ts';

const DB_SKIP = databaseSkip('the fixture teardown under the least-privilege role');

/** A role name unique to this run, so two suites on one cluster cannot collide or race a DROP. */
const ROLE = `prl_w3_app_${generateOpaqueSecret()
  .slice(0, 12)
  .toLowerCase()
  .replace(/[^a-z0-9]/gu, 'x')}`;

/** The connection every APPLICATION statement below goes through. Null when the role could not be made. */
let appSql: Sql | null = null;
let adminSql: Sql | null = null;
let setupProblem: string | null = null;
/** Restored in `after`, because `withAdminSql` reads it at call time and other files share nothing. */
let previousAdminUrl: string | undefined;

/** The same DSN, as a different user. `URL` is used rather than string surgery on a password. */
function asUser(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/** The database the DSN points at, for the CONNECT grant. */
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
    // Identifiers cannot be parameters, hence `adminSql(...)`, which is the driver's identifier
    // escape and not string interpolation. The password IS a parameter, quoted by the driver.
    await adminSql`create role ${adminSql(ROLE)} login password ${adminSql.unsafe(`'${password.replace(/'/gu, "''")}'`)}`;
    await adminSql`grant prl_app to ${adminSql(ROLE)}`;
    await adminSql`grant connect on database ${adminSql(databaseNameOf(TEST_DATABASE_URL))} to ${adminSql(ROLE)}`;
  } catch (error) {
    // No CREATEROLE, most likely. Named rather than swallowed: this suite proving nothing has to
    // look different from this suite passing.
    setupProblem =
      `could not create the least-privilege role ${ROLE} ` +
      `(${error instanceof Error ? error.message : String(error)}). ` +
      'This suite needs an identity with CREATEROLE — the same identity CI uses to run migrations.';
    console.info(`skipping the least-privilege teardown suite: ${setupProblem}`);
    return;
  }
  appSql = testClientFor(asUser(TEST_DATABASE_URL, ROLE, password));
  // The teardown's admin handle. Set here rather than in the environment of the whole run so that
  // this file states the CI shape — DATABASE_URL least-privilege, DATABASE_URL_ADMIN privileged —
  // instead of relying on somebody remembering to configure it.
  previousAdminUrl = process.env['DATABASE_URL_ADMIN'];
  process.env['DATABASE_URL_ADMIN'] = TEST_DATABASE_URL;
});

after(async () => {
  if (previousAdminUrl === undefined) delete process.env['DATABASE_URL_ADMIN'];
  else process.env['DATABASE_URL_ADMIN'] = previousAdminUrl;
  await appSql?.end({ timeout: 5 }).catch(() => undefined);
  if (adminSql !== null && setupProblem === null && DB_SKIP === false) {
    // A role that still holds a grant cannot be dropped, so the grants go first. Left behind, it
    // would be a stray login role on a shared development cluster.
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

/** The suite runs only when there is a database AND a role to run it as. */
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

    // THE assertion this file exists for. `prl.rooms` carries other learners' hand history and the
    // application must never be able to remove one; if this ever starts succeeding, the grant
    // matrix has been widened and the teardown below is passing for the wrong reason.
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

    // Every insert here is an APPLICATION statement and goes through the application's own
    // connection on purpose: a missing GRANT on any of them has to fail this suite.
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

    // The teardown. Before the fix this threw `permission denied for table rooms`, which is the
    // whole reason CI's test job could not drop the superuser.
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
