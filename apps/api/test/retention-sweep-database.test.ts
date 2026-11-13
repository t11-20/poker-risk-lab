/**
 * The retention sweep's SQL against a real database. It removes what expired and leaves what did
 * not. The guest section deletes accounts, so each "leave alone" case is a fixture old enough to be
 * swept and live enough that it must not be. Rows are inserted directly with explicit timestamps,
 * because `issueSession` cannot mint an expired session.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import { runRetentionSweep } from '../src/maintenance/retention-sweep.ts';
import { databaseSkip, TEST_DATABASE_URL, withAdminSql } from './helpers/database.ts';

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

  async function makeUser(): Promise<string> {
    const id = `usr_sweep${randomBytes(6).toString('hex')}`;
    await sql()`
      insert into prl.users (id, display_name, kind)
      values (${id}, ${'Sweep probe'}, ${'guest'})
    `;
    return id;
  }

  /** `sessions_expires_after_creation` forbids inserting an expired row, so `created_at` is backdated. */
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
      // One second ahead catches an off-by-one on the comparison.
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
    // Both sides of the 24 h window, because the far side alone passes a sweep that ignores
    // `revoked_at` and takes the row by expiry.
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
    const liveId = `oidc_sweep${randomBytes(6).toString('hex')}`;
    const deadId = `oidc_sweep${randomBytes(6).toString('hex')}`;
    // Backdated, because `oidc_login_attempts_expires_after_creation` forbids an expired insert.
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

  // Abandoned guest accounts. A wrong deletion here is not recoverable. No
  // `guestRetentionSeconds` is passed, so the shipped period is what is asserted (61 days goes,
  // 59 stays).

  async function makeGuest(lastSeen: string): Promise<string> {
    const id = `usr_sweep${randomBytes(6).toString('hex')}`;
    await sql()`
      insert into prl.users (id, display_name, kind, created_at, last_seen_at)
      values (${id}, ${'Sweep probe'}, ${'guest'},
              now() + (${lastSeen}::text)::interval, now() + (${lastSeen}::text)::interval)
    `;
    return id;
  }

  async function makeFederatedUser(lastSeen: string): Promise<string> {
    const id = `usr_sweep${randomBytes(6).toString('hex')}`;
    await sql()`
      insert into prl.users
        (id, display_name, kind, oidc_issuer, oidc_subject, created_at, last_seen_at)
      values (${id}, ${'Sweep probe'}, ${'oidc'},
              ${'https://idp.invalid/realms/prl'}, ${`sub-${randomBytes(6).toString('hex')}`},
              now() + (${lastSeen}::text)::interval, now() + (${lastSeen}::text)::interval)
    `;
    return id;
  }

  const userAlive = async (id: string): Promise<boolean> => {
    const rows = await sql()<{ id: string }[]>`select id from prl.users where id = ${id}`;
    return rows.length === 1;
  };

  async function makeRoom(ownerId: string): Promise<string> {
    const id = `room_${randomBytes(8).toString('hex')}`;
    await sql()`
      insert into prl.rooms
        (id, name, owner_user_id, invite_code_hash, max_seats, small_blind, big_blind,
         starting_stack, action_timeout_seconds)
      values (${id}, ${'Sweep probe room'}, ${ownerId}, ${randomBytes(32)}, 6, 1, 2, 200, 30)
    `;
    return id;
  }

  async function seatIn(roomId: string, userId: string): Promise<void> {
    await sql()`
      insert into prl.room_members (id, room_id, user_id, seat, stack)
      values (${`mem_${randomBytes(8).toString('hex')}`}, ${roomId}, ${userId}, 0, 200)
    `;
  }

  /** A hand in progress with `userId` in seat 0. `hand_seats` must keep the account. */
  async function handSeatIn(roomId: string, userId: string): Promise<void> {
    const handId = `hand_${randomBytes(8).toString('hex')}`;
    const config = JSON.stringify({
      smallBlind: 1,
      bigBlind: 2,
      ante: 0,
      maxSeats: 6,
      actionTimeoutSeconds: 30,
    });
    await sql()`
      insert into prl.hands
        (id, room_id, hand_number, button_seat, config, commitment_root, commitment_context,
         random_source_kind, street)
      values (${handId}, ${roomId}, 1, 0, ${config}::text::jsonb, ${'a'.repeat(64)},
              ${'retention sweep probe'}, ${'deterministic-test-only'}, ${'preflop'})
    `;
    await sql()`
      insert into prl.hand_seats (id, hand_id, seat, user_id, starting_stack, status)
      values (${`hseat_${randomBytes(8).toString('hex')}`}, ${handId}, 0, ${userId}, 200, ${'active'})
    `;
  }

  /**
   * `prl_app` holds no DELETE on rooms or hand history, so teardown uses the owner role. Every
   * application statement stays on `prl_app`, so a missing grant fails the suite.
   */
  async function dropFixtures(roomIds: string[], userIds: string[]): Promise<void> {
    await withAdminSql(async (admin) => {
      if (roomIds.length > 0) await admin`delete from prl.rooms where id in ${admin(roomIds)}`;
      if (userIds.length > 0) await admin`delete from prl.users where id in ${admin(userIds)}`;
    });
  }

  it('removes a guest nobody can reach any more, and keeps one still inside the period', async () => {
    // Sixty days is a session's whole life and a guest has no other credential. One day either
    // side is the whole policy, so both are asserted together.
    const gone = await makeGuest('-61 days');
    const kept = await makeGuest('-59 days');
    try {
      const result = await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await userAlive(gone), false, 'an abandoned guest account was retained');
      assert.equal(await userAlive(kept), true, 'a guest inside the retention period was erased');
      assert.ok(result.guestAccounts >= 1, `the sweep reported ${result.guestAccounts} guests removed`);
      assert.equal(result.guestAccountsBlocked, 0);
    } finally {
      await dropFixtures([], [gone, kept]);
    }
  });

  it('never touches a federated account, however long it has been idle', async () => {
    // A federated account can come back tomorrow, so it is dormant, not abandoned.
    const federated = await makeFederatedUser('-400 days');
    try {
      await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await userAlive(federated), true, 'the sweep erased a signed-in learner');
    } finally {
      await dropFixtures([], [federated]);
    }
  });

  it('never touches a guest that is still live, whatever its age says', async () => {
    // Four guests a year past the cutoff, each live in a different way. `touchLastSeen` lands only
    // when a session slides, so a sweep that trusted the timestamp alone would take all four.
    const withSession = await makeGuest('-400 days');
    const seated = await makeGuest('-400 days');
    const owner = await makeGuest('-400 days');
    const played = await makeGuest('-400 days');
    const rooms: string[] = [];
    try {
      // The sweep must side with the live session over the stale timestamp.
      await makeSession(withSession, { createdAt: '-1 hour', expiresAt: '14 days' });

      const ownedRoom = await makeRoom(owner);
      rooms.push(ownedRoom);
      const table = await makeRoom(seated);
      rooms.push(table);
      await seatIn(table, seated);

      const finished = await makeRoom(played);
      rooms.push(finished);
      await handSeatIn(finished, played);

      const result = await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await userAlive(withSession), true, 'a guest with a live session was erased');
      assert.equal(await userAlive(seated), true, 'a guest sitting at a table was erased');
      assert.equal(await userAlive(owner), true, 'a guest who owns a table was erased, orphaning it');
      assert.equal(await userAlive(played), true, "a guest's seat in a played hand was erased");
      assert.equal(result.guestAccountsBlocked, 0, 'none of these should have been attempted at all');
    } finally {
      await dropFixtures(rooms, [withSession, seated, owner, played]);
    }
  });

  it('never touches a guest holding an enrolment, however long it has been (NEGATIVE CONTROL)', async () => {
    // Legal review D9. A class can be enrolled before it opens, and `enrolments_user_id_fkey` is
    // ON DELETE CASCADE, so the sweep erased the student and the place, leaving an audit entry with
    // `user_id` NULL. A revoked enrolment and an unstarted cohort are the shapes a predicate over
    // live entitlements would miss.
    const enrolled = await makeGuest('-400 days');
    const withdrawn = await makeGuest('-400 days');
    const cohortId = `coh_sweep${randomBytes(6).toString('hex')}`;
    try {
      await withAdminSql(async (admin) => {
        await admin`
          insert into prl.cohorts (id, key, name, starts_at, ends_at)
          values (${cohortId}, ${`sweep-probe-${randomBytes(4).toString('hex')}`},
                  ${'Sweep probe cohort'}, now() + interval '30 days', now() + interval '120 days')
        `;
        await admin`
          insert into prl.enrolments (id, cohort_id, user_id, granted_by, reference)
          values (${`enr_sweep${randomBytes(6).toString('hex')}`}, ${cohortId}, ${enrolled},
                  ${'J. Okafor'}, ${'registry-row-88'})
        `;
        await admin`
          insert into prl.enrolments
            (id, cohort_id, user_id, granted_by, reference, revoked_at, revoked_by, revoked_reason)
          values (${`enr_sweep${randomBytes(6).toString('hex')}`}, ${cohortId}, ${withdrawn},
                  ${'J. Okafor'}, ${'registry-row-89'}, now(), ${'J. Okafor'}, ${'place transferred'})
        `;
      });

      const result = await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await userAlive(enrolled), true, 'the sweep erased a student with a place waiting');
      assert.equal(await userAlive(withdrawn), true, 'the sweep erased an account with a withdrawn place');
      assert.equal(result.guestAccountsBlocked, 0, 'neither should have been attempted at all');
    } finally {
      await withAdminSql(async (admin) => {
        await admin`delete from prl.enrolments where cohort_id = ${cohortId}`;
        await admin`delete from prl.cohorts where id = ${cohortId}`;
      });
      await dropFixtures([], [enrolled, withdrawn]);
    }
  });

  it('never erases a guest whose enrolment was written while the sweep waited (NEGATIVE CONTROL)', async () => {
    // Under READ COMMITTED a statement's snapshot is fixed at its start, and waiting on a row lock
    // does not refresh it unless the locked tuple was UPDATED. Measured before the fix, the sweep
    // blocked 1,124 ms on the enrolment INSERT's lock and still returned the account as abandoned.
    // `enrolments grant` holds one transaction across a whole class list, so the window is real.
    const racer = await makeGuest('-400 days');
    const cohortId = `coh_race${randomBytes(6).toString('hex')}`;
    let sawTheLock = 0;
    try {
      await withAdminSql(async (admin) => {
        await admin`
          insert into prl.cohorts (id, key, name, starts_at, ends_at)
          values (${cohortId}, ${`race-probe-${randomBytes(4).toString('hex')}`},
                  ${'Race probe cohort'}, now() + interval '30 days', now() + interval '120 days')
        `;
      });

      let releaseInstructor: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        releaseInstructor = resolve;
      });
      const instructor = withAdminSql((admin) =>
        admin.begin(async (tx) => {
          await tx`
            insert into prl.enrolments (id, cohort_id, user_id, granted_by, reference)
            values (${`enr_race${randomBytes(6).toString('hex')}`}, ${cohortId}, ${racer},
                    ${'J. Okafor'}, ${'registry-row-90'})
          `;
          await held;
          return { ok: true };
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 250));

      const startedAt = Date.now();
      const sweep = runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 }).then((result) => {
        sawTheLock = Date.now() - startedAt;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 500));
      releaseInstructor();
      await instructor;
      const result = await sweep;

      // A sweep of nothing is not a pass, so the wait itself is asserted first.
      assert.ok(
        sawTheLock >= 400,
        `the sweep finished in ${sawTheLock} ms, so it never blocked on the instructor's lock and ` +
          'this case did not exercise the race it exists for',
      );
      assert.equal(
        await userAlive(racer),
        true,
        'the sweep erased a student whose place was granted while it waited for the lock',
      );
      assert.equal(result.guestAccountsBlocked, 0, 'the refusal must be a clean decline, not a failure');
    } finally {
      await withAdminSql(async (admin) => {
        await admin`delete from prl.enrolments where cohort_id = ${cohortId}`;
        await admin`delete from prl.cohorts where id = ${cohortId}`;
      });
      await dropFixtures([], [racer]);
    }
  });

  it('works through a backlog larger than one batch', async () => {
    // Termination counts guests offered, so three against a batch of two proves a second pass.
    const guests = [await makeGuest('-90 days'), await makeGuest('-91 days'), await makeGuest('-92 days')];
    try {
      const result = await runRetentionSweep({ sql, batchSize: 2, maxPasses: 10 });

      for (const id of guests) {
        assert.equal(await userAlive(id), false, 'a guest was left behind by a batched sweep');
      }
      assert.ok(result.guestAccounts >= 3, `the sweep reported ${result.guestAccounts} guests removed`);
      assert.equal(result.incomplete, false);
    } finally {
      await dropFixtures([], guests);
    }
  });

  it('erases everything the account owned, exactly as POST /me/delete would', async () => {
    // The sweep goes through `deleteAccount`, the same self-verifying path as POST /me/delete.
    // Progress rows go by a CASCADE that `prl_app` has no DELETE privilege to reproduce.
    const guest = await makeGuest('-61 days');
    try {
      await sql()`
        insert into prl.lesson_progress (id, user_id, lesson_id, completed_at)
        values (${`lprog_${randomBytes(8).toString('hex')}`}, ${guest}, ${'pot-odds'}, now())
      `;
      await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await userAlive(guest), false, 'the abandoned guest survived');
      const leftovers = await sql()<{ id: string }[]>`
        select id from prl.lesson_progress where user_id = ${guest}
      `;
      assert.equal(leftovers.length, 0, "the account went and its owner's progress rows did not");
    } finally {
      await dropFixtures([], [guest]);
    }
  });
});
