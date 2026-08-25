/**
 * The retention sweep, against a real database.
 *
 * ## Why this exists beside `retention-sweep.test.ts`
 *
 * That file drives the scheduler with a fake `sql` and asserts the things a fake can prove: that a
 * backlog larger than one batch is worked through, that the pass ceiling is reported rather than
 * hit silently, that a failure does not kill the schedule, that two ticks do not overlap. Every one
 * of those is about the loop.
 *
 * None of them is about the SQL, and the SQL is where a retention promise actually lives. A sweep
 * that ran perfectly and deleted the wrong rows would satisfy that file completely. So this one
 * asks the only two questions that matter to a learner and to a regulator:
 *
 *   * does it remove what has expired, and
 *   * does it leave alone what has not?
 *
 * The second is the one worth losing sleep over. `prl.sessions` holds every live session; a sweep
 * that took one would sign somebody out mid-hand, and a bug in that direction is invisible in
 * staging until it is not.
 *
 * ## Why the rows are built here rather than through the repository
 *
 * `issueSession` cannot mint an already-expired session — it is written so that it cannot, which is
 * correct and makes it useless for this. Rows are inserted directly with explicit timestamps, which
 * is also how the state under test arises in production: time passes.
 *
 * Skips, loudly, when there is no test database. `databaseSkip` is the repository suite's own
 * mechanism and this uses it rather than inventing a quieter one.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import { runRetentionSweep } from '../src/maintenance/retention-sweep.ts';
import { databaseSkip, TEST_DATABASE_URL } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

let client: Sql | undefined;
let skipReason: string | false = databaseSkip('the retention sweep against a real database');

if (TEST_DATABASE_URL !== undefined) {
  try {
    const probe = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: TEST_DATABASE_URL,
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
        DATABASE_POOL_MAX: '2',
      }),
    );
    await probe`select 1 from prl.sessions limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `the database is configured but unreachable: ${String(error)}`;
  }
}

after(async () => {
  await client?.end({ timeout: 5 });
});

describe('the retention sweep, against a real database', { skip: skipReason }, () => {
  const sql = () => client as Sql;

  /** A user to hang sessions off. Deleted at the end of each case, cascading to its sessions. */
  async function makeUser(): Promise<string> {
    const id = `usr_sweep${randomBytes(6).toString('hex')}`;
    await sql()`
      insert into prl.users (id, display_name, kind)
      values (${id}, ${'Sweep probe'}, ${'guest'})
    `;
    return id;
  }

  /**
   * A session row with an explicit lifetime.
   *
   * `created_at` is set as well as `expires_at`, and it has to be: the schema carries
   * `CONSTRAINT sessions_expires_after_creation CHECK (expires_at > created_at)`, so a row cannot
   * be inserted already expired. That constraint is right — a session that expires before it is
   * issued is nonsense — and it means an expired row can only exist the way one does in
   * production: it was valid once, and then time passed. This backdates `created_at` to model
   * that rather than to get around the check.
   */
  async function makeSession(
    userId: string,
    when: { readonly createdAt: string; readonly expiresAt: string; readonly revokedAt?: string },
  ): Promise<string> {
    const id = `ses_sweep${randomBytes(6).toString('hex')}`;
    const revoked = when.revokedAt;
    await sql()`
      insert into prl.sessions (id, user_id, token_hash, created_at, expires_at, revoked_at)
      values (
        ${id}, ${userId}, ${randomBytes(32)},
        now() + (${when.createdAt}::text)::interval,
        now() + (${when.expiresAt}::text)::interval,
        ${revoked === undefined ? null : sql()`now() + (${revoked}::text)::interval`}
      )
    `;
    return id;
  }

  const alive = async (id: string): Promise<boolean> => {
    const rows = await sql()<{ id: string }[]>`select id from prl.sessions where id = ${id}`;
    return rows.length === 1;
  };

  it('removes expired sessions and leaves live ones alone', async () => {
    const userId = await makeUser();
    try {
      const expired = await makeSession(userId, { createdAt: '-15 days', expiresAt: '-1 hour' });
      const live = await makeSession(userId, { createdAt: '-1 hour', expiresAt: '14 days' });
      // One second in the future. A sweep with an off-by-one on the comparison takes it; a correct
      // one does not, and the difference is a learner signed out for no reason.
      const almost = await makeSession(userId, { createdAt: '-14 days', expiresAt: '1 second' });

      const result = await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await alive(expired), false, 'an expired session survived the sweep');
      assert.equal(await alive(live), true, 'the sweep deleted a live session');
      assert.equal(await alive(almost), true, 'the sweep deleted a session that had not expired yet');
      assert.ok(result.sessions >= 1, `the sweep reported ${result.sessions} removed`);
      assert.equal(result.incomplete, false);
    } finally {
      await sql()`delete from prl.users where id = ${userId}`;
    }
  });

  it('keeps a freshly revoked session for its grace period, then takes it', async () => {
    // `REVOKED_RETENTION_SECONDS` is 24 hours, and the reason it is not zero is in
    // `repositories/sessions.ts`: a row removed the instant it is revoked leaves nothing to
    // explain why a caller's cookie stopped working. Both sides of that window are asserted here,
    // because only testing the far side would pass against a sweep that ignored `revoked_at`
    // entirely — the row would have been taken by the expiry clause instead.
    const userId = await makeUser();
    try {
      const justRevoked = await makeSession(userId, {
        createdAt: '-1 hour',
        expiresAt: '14 days',
        revokedAt: '-1 minute',
      });
      const longRevoked = await makeSession(userId, {
        createdAt: '-2 days',
        expiresAt: '14 days',
        revokedAt: '-25 hours',
      });

      await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await alive(justRevoked), true, 'a session revoked a minute ago is still explicable');
      assert.equal(await alive(longRevoked), false, 'a session revoked over a day ago should be gone');
    } finally {
      await sql()`delete from prl.users where id = ${userId}`;
    }
  });

  it('removes expired sign-in attempts and leaves live ones alone', async () => {
    // The other table, and the one that grows fastest: a row per ATTEMPTED federated sign-in,
    // including every abandoned one.
    const liveId = `oidc_sweep${randomBytes(6).toString('hex')}`;
    const deadId = `oidc_sweep${randomBytes(6).toString('hex')}`;
    // `created_at` is backdated for the same reason it is on a session: this table carries
    // `oidc_login_attempts_expires_after_creation`, so an attempt cannot be inserted already
    // expired. It expires because ten minutes went by, which is what this models.
    const insert = async (id: string, createdAt: string, expiresAt: string) => {
      await sql()`
        insert into prl.oidc_login_attempts
          (id, state_hash, nonce_hash, pkce_verifier_hash, created_at, expires_at)
        values (${id}, ${randomBytes(32)}, ${randomBytes(32)}, ${randomBytes(32)},
                now() + (${createdAt}::text)::interval,
                now() + (${expiresAt}::text)::interval)
      `;
    };
    const attemptAlive = async (id: string) => {
      const rows = await sql()<{ id: string }[]>`select id from prl.oidc_login_attempts where id = ${id}`;
      return rows.length === 1;
    };

    try {
      await insert(deadId, '-11 minutes', '-1 minute');
      await insert(liveId, '-1 second', '10 minutes');

      await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await attemptAlive(deadId), false, 'an expired sign-in attempt survived');
      assert.equal(await attemptAlive(liveId), true, 'a live sign-in attempt was deleted');
    } finally {
      await sql()`delete from prl.oidc_login_attempts where id in (${liveId}, ${deadId})`;
    }
  });
});
