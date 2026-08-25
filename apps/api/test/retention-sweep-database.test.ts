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
 * That asymmetry is the whole reason the abandoned-guest section below is the longest one in the
 * file. Those cases delete ACCOUNTS, so the "leaves alone" half stops being about a row and starts
 * being about a person: a guest holding a live session, sitting at an open table, owning one, or
 * named in a hand four other people played is not abandoned at any age, and a federated account is
 * never in scope however long it has been idle. Each of those is asserted against a fixture built
 * to look exactly like the mistake — old enough to be swept, live enough that it must not be.
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

  // -------------------------------------------------------------------------
  // Abandoned guest accounts
  //
  // The sweep that `docs/production/legal-register.md` D4 found documented in four places and
  // implemented in none. Every case below is a NEGATIVE CONTROL in the sense that file means:
  // the mistake it catches is a *deletion*, and a deletion of an account is not recoverable from
  // a running system. The shipped retention period is asserted from both sides — 61 days goes,
  // 59 days stays — so the number cannot drift without this failing.
  //
  // No `guestRetentionSeconds` is passed anywhere in this section, deliberately. A test that
  // shortened the cutoff to make its fixtures convenient would assert that the loop works and
  // nothing at all about the period the product actually ships.
  // -------------------------------------------------------------------------

  /** A guest account with an explicit "last seen", which is what the sweep keys on. */
  async function makeGuest(lastSeen: string): Promise<string> {
    const id = `usr_sweep${randomBytes(6).toString('hex')}`;
    await sql()`
      insert into prl.users (id, display_name, kind, created_at, last_seen_at)
      values (${id}, ${'Sweep probe'}, ${'guest'},
              now() + (${lastSeen}::text)::interval, now() + (${lastSeen}::text)::interval)
    `;
    return id;
  }

  /** A federated account, idle for just as long. Nothing here may ever touch one. */
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

  /** An open room owned by `ownerId`. Returned so the teardown can take it back out. */
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

  /**
   * A hand in progress with `userId` in seat 0 — the worst row to delete in the schema.
   *
   * Live rather than finished, because the predicate treats both the same way and this is the more
   * expensive half to get wrong: a finished hand is four other people's record and erasing the
   * account silently blanks a name in it, while a hand still being played is somebody at the table
   * right now. `hand_seats` is checked so that neither can happen.
   */
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
   * Removes the fixtures, as the identity that owns the schema.
   *
   * `prl_app` holds no DELETE on `prl.rooms`, `prl.hands` or `prl.hand_seats` — hand history is
   * append-only by grant, not by convention — so a fixture that creates a room cannot take it
   * back out through the application's own connection. `withAdminSql` is the suite's existing
   * answer to exactly that, and using it here keeps every APPLICATION statement in this file on
   * the application's role, which is what makes a missing grant fail the suite instead of hiding.
   */
  async function dropFixtures(roomIds: string[], userIds: string[]): Promise<void> {
    await withAdminSql(async (admin) => {
      // Rooms first: hands, hand seats and memberships all cascade from a room, so this leaves
      // nothing pointing at the users about to go.
      if (roomIds.length > 0) await admin`delete from prl.rooms where id in ${admin(roomIds)}`;
      if (userIds.length > 0) await admin`delete from prl.users where id in ${admin(userIds)}`;
    });
  }

  it('removes a guest nobody can reach any more, and keeps one still inside the period', async () => {
    // Sixty days is the ceiling on a session's whole life, so a guest unseen for longer than that
    // holds no cookie that can still work and has no other credential to sign in with — there is
    // no email column and no password column in the schema. One day either side of that line is
    // the entire policy, so both sides are asserted in one case: a sweep that took the wrong one
    // would otherwise pass half of a pair of tests.
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
    // The difference is not how long it has been: it is that somebody with an identity provider
    // can come back tomorrow. An idle federated account is dormant, not abandoned, and erasing one
    // would delete a learner who still has a working way in. The partial index the sweep reads is
    // built `WHERE kind = 'guest'` for the same reason.
    const federated = await makeFederatedUser('-400 days');
    try {
      await runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 });

      assert.equal(await userAlive(federated), true, 'the sweep erased a signed-in learner');
    } finally {
      await dropFixtures([], [federated]);
    }
  });

  it('never touches a guest that is still live, whatever its age says', async () => {
    // ########################################################################
    // ## THE CASE THIS WHOLE SWEEP IS BOUNDED BY                            ##
    // ########################################################################
    //
    // Four guests, all of them a year past the cutoff, each live in a different way: one holding a
    // valid session, one holding a seat at an open table, one who owns the table, and one whose
    // seat is in a hand that has already been played. Every one of them is `last_seen_at` old,
    // because `touchLastSeen` only lands when a session slides — so a sweep that trusted the
    // timestamp alone would take all four. The first would be signed out mid-hand; the second's
    // chair would vanish from under them; the third's table would be left ownerless and
    // unclosable; the fourth would be silently blanked out of a record four other people share.
    //
    // Retaining a dead row is a defect that costs a byte. This is the one that costs a learner.
    const withSession = await makeGuest('-400 days');
    const seated = await makeGuest('-400 days');
    const owner = await makeGuest('-400 days');
    const played = await makeGuest('-400 days');
    const rooms: string[] = [];
    try {
      // A session that is live now against an account last *seen* a year ago. Contrived on
      // purpose: it is the shape the timestamp can take when the two disagree, and the sweep must
      // resolve that disagreement in favour of the row that says somebody is here.
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
    // ########################################################################
    // ## THE CASE THAT WAS MISSING FOR AS LONG AS prl.enrolments EXISTED    ##
    // ########################################################################
    //
    // Found by the legal review of `db/migrations/0006_cohort_enrolments.sql` as D9, not by a test,
    // and the sequence is ordinary rather than contrived. `enrolments.starts_at` exists so that a
    // class can be enrolled BEFORE the day it opens; a student whose only visit was the one that
    // minted their guest account is unseen for sixty days some weeks later; and until the clause in
    // `abandonedGuestPredicate` existed, this sweep erased them — taking their place with them,
    // because `enrolments_user_id_fkey` is ON DELETE CASCADE.
    //
    // What makes it the worst case in this file is that it is unreconstructable afterwards. The
    // audit entry survives with `user_id` NULL, so the operator still has "somebody was granted a
    // place on this authority against this reference" and no way at all to learn who.
    //
    // Deliberately a REVOKED enrolment and a cohort that has not started: both are the shapes a
    // predicate written to look only at live entitlements would miss, and neither makes the account
    // an anonymous sign-up.
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
    // ########################################################################
    // ## THE DOOR D9's FIX LEFT OPEN, AND THE ONE THE COMMENT SAID WAS SHUT ##
    // ########################################################################
    //
    // `abandonedGuestPredicate` re-runs inside the deleting transaction, and the reasoning written
    // beside it was: `FOR UPDATE` conflicts with the `FOR KEY SHARE` an INSERT referencing the row
    // must take, so "an instructor enrolling a class at the same instant as a sweep tick either
    // lands before the lock and is seen, or blocks until the sweep has finished with that row".
    //
    // The lock conflict is real. The conclusion is not. Measured on a scratch database before the
    // fix: the sweep's statement blocked for 1,124 ms on exactly that conflict, and then returned
    // the account as ABANDONED — because under READ COMMITTED a statement's snapshot is taken when
    // the statement starts, waiting on a row lock does not refresh it, and PostgreSQL re-checks a
    // qual after such a wait only when the locked tuple was itself UPDATED. An insert into
    // `prl.enrolments` locks `prl.users`; it does not update it. So the `not exists` had already
    // been answered against a snapshot without the student's place in it, and the answer survived
    // the wait. The account went, and the place cascaded away with it.
    //
    // This case is that sequence, and nothing about it is contrived: `enrolments grant` holds one
    // transaction open across a whole class list, so its window is as long as it takes to write
    // thirty rows and thirty audit entries — and the sweep ticks four times a day into it.
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

      // The instructor's transaction: insert, then hold, exactly as a class list does.
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

      // Give the INSERT time to land and take its lock, without committing.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const startedAt = Date.now();
      const sweep = runRetentionSweep({ sql, batchSize: 500, maxPasses: 10 }).then((result) => {
        sawTheLock = Date.now() - startedAt;
        return result;
      });

      // The sweep is now blocked on the instructor's row lock. Let the class list commit.
      await new Promise((resolve) => setTimeout(resolve, 500));
      releaseInstructor();
      await instructor;
      const result = await sweep;

      // A sweep of nothing is not a pass: if it never reached the lock this proves nothing, so the
      // wait itself is asserted before the outcome is.
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
    // The same property the session sweep has, and it is not free here: the guest sweep chooses a
    // bounded batch and then erases each account in its own transaction, so "kept going" has to be
    // decided from how many were OFFERED. Three abandoned guests against a batch of two proves the
    // second pass happens; a loop that stopped after one batch reports two.
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
    // The sweep reaches the schema through `deleteAccount`, so the erasure a learner gets when
    // they ask for one and the erasure an abandoned account gets are the same operation — and
    // `deleteAccount` verifies itself, counting the rows that name the learner after the delete
    // and refusing to commit if any survived. This asserts the part a reader would otherwise have
    // to take on trust: progress rows belonging to the account go with it, through a CASCADE that
    // `prl_app` holds no DELETE privilege of its own to reproduce.
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
