/**
 * Cohorts and entitlements against a real database. The window, the one-live-enrolment index, the
 * grant-plus-audit transaction and the SELECT-only grant are all PostgreSQL's, so a fake proves nothing.
 * Reads run on the ordinary client (`prl_ci_app` in CI), so a missing `GRANT SELECT` fails here.
 * Writes run through `withAdminSql`, because `prl_app` holds SELECT only on both tables.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import * as audit from '../src/repositories/audit.ts';
import * as enrolments from '../src/repositories/enrolments.ts';
import type { Db } from '../src/repositories/sql.ts';
import { deleteAccount } from '../src/repositories/users.ts';
import { postgresSeatEntitlement } from '../src/rooms/entitlement.ts';
import { databaseSkip, TEST_DATABASE_URL, withAdminSql } from './helpers/database.ts';

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

let client: Sql | undefined;
let skipReason: string | false = databaseSkip('cohorts and entitlements against a real schema');

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
    // On a database migrated before 0006 this fails here, not one assertion at a time below.
    await probe`select 1 from prl.enrolments limit 1`;
    client = probe;
  } catch (error) {
    skipReason = `the database is configured but unreachable: ${String(error)}`;
  }
}

after(async () => {
  await client?.end({ timeout: 5 });
});

describe('cohorts and entitlements, against a real database', { skip: skipReason }, () => {
  /** `prl_app` with its SELECT-only grants. Every read goes through it. */
  const sql = () => client as Sql;

  /** Boxed because postgres.js types `begin` as `UnwrapPromiseArray<T>`. */
  function asOperator<T>(use: (tx: Db) => Promise<T>): Promise<T> {
    return withAdminSql(async (admin) => {
      const boxed = await admin.begin(async (tx) => ({ value: await use(tx) }));
      return boxed.value;
    });
  }

  const created: { cohorts: string[]; users: string[] } = { cohorts: [], users: [] };

  const at = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

  async function makeUser(): Promise<string> {
    const id = `usr_enrol${randomBytes(6).toString('hex')}`;
    await withAdminSql(async (admin) => {
      await admin`
        insert into prl.users (id, display_name, kind) values (${id}, ${'Enrol probe'}, ${'guest'})
      `;
    });
    created.users.push(id);
    return id;
  }

  async function makeCohort(period: { startsAt?: Date; endsAt?: Date | null } = {}): Promise<string> {
    const key = `probe-${randomBytes(6).toString('hex')}`;
    const cohort = await asOperator((tx) =>
      enrolments.createCohort(tx, {
        key,
        name: 'Enrolment probe cohort',
        startsAt: period.startsAt ?? at(-60),
        endsAt: period.endsAt ?? at(60 * 24 * 30),
      }),
    );
    created.cohorts.push(cohort.id);
    return cohort.id;
  }

  after(async () => {
    // As the schema owner, because `prl_app` holds no DELETE here. Users first so enrolments cascade.
    await withAdminSql(async (admin) => {
      if (created.users.length > 0) await admin`delete from prl.users where id in ${admin(created.users)}`;
      if (created.cohorts.length > 0) {
        // Every entry names its cohort in `detail`, which also reaches entries whose `user_id` the
        // erasure case already NULLed.
        await admin`delete from prl.audit_log where detail->>'cohortId' in ${admin(created.cohorts)}`;
        await admin`delete from prl.enrolments where cohort_id in ${admin(created.cohorts)}`;
        await admin`delete from prl.cohorts where id in ${admin(created.cohorts)}`;
      }
    });
  });

  function grantTo(
    cohortId: string,
    userId: string,
    overrides: { startsAt?: Date | null; expiresAt?: Date | null; reference?: string; by?: string } = {},
  ): Promise<enrolments.GrantOutcome> {
    return asOperator((tx) =>
      enrolments.grant(tx, {
        cohortId,
        userId,
        grantedBy: overrides.by ?? 'J. Okafor',
        reference: overrides.reference ?? 'registry-row-88',
        startsAt: overrides.startsAt ?? null,
        expiresAt: overrides.expiresAt ?? null,
      }),
    );
  }

  /** Read as the schema owner so no grant can hide a row. */
  function rowsFor(userId: string): Promise<readonly { id: string; revoked_reason: string | null }[]> {
    return withAdminSql(
      (admin) => admin<{ id: string; revoked_reason: string | null }[]>`
        select id, revoked_reason from prl.enrolments where user_id = ${userId} order by granted_at
      `,
    );
  }

  it('entitles a live enrolment, and says until when', async () => {
    const cohortId = await makeCohort({ endsAt: at(60 * 24 * 30) });
    const userId = await makeUser();
    const expiresAt = at(60 * 24);
    await grantTo(cohortId, userId, { expiresAt });

    const entitlement = await enrolments.entitlementFor(sql(), userId);
    assert.notEqual(entitlement, null, 'a live enrolment did not entitle');
    assert.equal(entitlement?.cohortId, cohortId);
    assert.equal(entitlement?.until?.toISOString(), expiresAt.toISOString());
  });

  it("takes the cohort's end when the enrolment carries none", async () => {
    // Enrolling thirty people and forgetting --expires must not entitle them forever.
    const endsAt = at(60 * 24 * 10);
    const cohortId = await makeCohort({ endsAt });
    const userId = await makeUser();
    await grantTo(cohortId, userId, { expiresAt: null });

    const entitlement = await enrolments.entitlementFor(sql(), userId);
    assert.equal(
      entitlement?.until?.toISOString(),
      endsAt.toISOString(),
      'an enrolment with no expiry must still end when its cohort does',
    );
  });

  it('does not entitle a REVOKED enrolment, and does not delete it (NEGATIVE CONTROL)', async () => {
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await grantTo(cohortId, userId);
    assert.notEqual(await enrolments.entitlementFor(sql(), userId), null, 'the fixture must start live');

    const revoked = await asOperator((tx) =>
      enrolments.revoke(tx, { cohortId, userId, revokedBy: 'J. Okafor', reason: 'place transferred' }),
    );

    assert.equal(await enrolments.entitlementFor(sql(), userId), null, 'a revoked enrolment entitled');
    // A revocation implemented as a delete would pass above and destroy the record of the withdrawal.
    const rows = await rowsFor(userId);
    assert.equal(rows.length, 1, 'revocation removed the row instead of marking it');
    assert.equal(revoked?.revokedReason, 'place transferred');
    assert.equal(revoked?.revokedBy, 'J. Okafor');
    assert.notEqual(revoked?.revokedAt, null);
    // `entitled_now` is a second expression in `enrolmentSelect`. With its `e.revoked_at is null` term
    // dropped, the rest of this file still passed, and `enrolments list` counted a withdrawn learner.
    const [record] = await enrolments.forUser(sql(), userId);
    assert.equal(record?.entitledNow, false, 'the operator view still calls a revoked place live');
    assert.notEqual(record?.revokedAt, null, 'the operator view lost the withdrawal itself');
  });

  it('does not entitle an EXPIRED enrolment (NEGATIVE CONTROL)', async () => {
    const cohortId = await makeCohort();
    const userId = await makeUser();
    // The schema refuses an expiry before the start, so both timestamps are in the past.
    await grantTo(cohortId, userId, { startsAt: at(-120), expiresAt: at(-1) });

    assert.equal(await enrolments.entitlementFor(sql(), userId), null, 'an expired enrolment entitled');
    const [record] = await enrolments.forUser(sql(), userId);
    assert.equal(record?.entitledNow, false);
    assert.equal(record?.revokedAt, null, 'expiry is not revocation and must not be recorded as one');
  });

  it('does not entitle one that has NOT STARTED (NEGATIVE CONTROL)', async () => {
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await grantTo(cohortId, userId, { startsAt: at(60) });

    assert.equal(await enrolments.entitlementFor(sql(), userId), null, 'a future enrolment entitled');
  });

  it('does not entitle inside a cohort that has not begun (NEGATIVE CONTROL)', async () => {
    const cohortId = await makeCohort({ startsAt: at(60 * 24), endsAt: at(60 * 24 * 30) });
    const userId = await makeUser();
    await grantTo(cohortId, userId);

    assert.equal(await enrolments.entitlementFor(sql(), userId), null, 'a cohort entitled before it began');
  });

  it('does not entitle inside a cohort that has ended (NEGATIVE CONTROL)', async () => {
    const cohortId = await makeCohort({ startsAt: at(-60 * 24 * 30), endsAt: at(-1) });
    const userId = await makeUser();
    await grantTo(cohortId, userId, { startsAt: at(-60 * 24 * 20), expiresAt: null });

    assert.equal(await enrolments.entitlementFor(sql(), userId), null, 'a cohort entitled after it ended');
  });

  it('returns the entitlement that runs longest when somebody is in two cohorts', async () => {
    // The caller needs "until when can they get in", so the latest-ending row must be returned.
    const userId = await makeUser();
    const shortCohort = await makeCohort({ endsAt: at(60 * 24) });
    const longCohort = await makeCohort({ endsAt: at(60 * 24 * 20) });
    await grantTo(shortCohort, userId);
    await grantTo(longCohort, userId);

    const entitlement = await enrolments.entitlementFor(sql(), userId);
    assert.equal(entitlement?.cohortId, longCohort, 'the shorter entitlement was reported');
  });

  it('allows a re-grant after a revocation, keeping both rows (NEGATIVE CONTROL)', async () => {
    // `UNIQUE (cohort_id, user_id)` passes every other case and fails only here. The index is
    // partial on `revoked_at IS NULL` so a wrong withdrawal can be undone without editing its row.
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await grantTo(cohortId, userId);
    await asOperator((tx) =>
      enrolments.revoke(tx, { cohortId, userId, revokedBy: 'J. Okafor', reason: 'entered in error' }),
    );

    const again = await grantTo(cohortId, userId, { by: 'A. Reyes', reference: 'scholarship' });

    assert.equal(again.outcome, 'granted', 'a re-grant after a revocation was refused');
    assert.notEqual(await enrolments.entitlementFor(sql(), userId), null, 're-granting did not entitle');
    const rows = await rowsFor(userId);
    assert.equal(rows.length, 2, 'the revoked row must survive the re-grant');
    assert.equal(rows[0]?.revoked_reason, 'entered in error', 'the original revocation was rewritten');
  });

  it('refuses a second grant while an unrevoked one exists, and changes nothing', async () => {
    const cohortId = await makeCohort();
    const userId = await makeUser();
    const first = await grantTo(cohortId, userId, { reference: 'registry-row-1' });

    const second = await grantTo(cohortId, userId, { reference: 'registry-row-2' });

    assert.equal(second.outcome, 'already_enrolled');
    assert.equal(second.enrolmentId, first.outcome === 'granted' ? first.enrolmentId : '');
    const rows = await rowsFor(userId);
    assert.equal(rows.length, 1, 'a refused grant still wrote a row');
    const [record] = await enrolments.forUser(sql(), userId);
    assert.equal(record?.reference, 'registry-row-1', 'the refused grant overwrote the live one');
  });

  it('supersedes an EXPIRED enrolment rather than refusing the re-grant (NEGATIVE CONTROL)', async () => {
    // `now()` is not immutable, so an expired row still occupies the unique slot. A straight insert
    // would answer `already_enrolled` for somebody entitled to nothing.
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await grantTo(cohortId, userId, { startsAt: at(-120), expiresAt: at(-1) });

    const again = await grantTo(cohortId, userId, { expiresAt: at(60 * 24) });

    assert.equal(again.outcome, 'granted', 'a re-grant over an expired enrolment was refused');
    assert.notEqual(again.outcome === 'granted' ? again.supersededId : null, null, 'nothing was superseded');
    assert.notEqual(await enrolments.entitlementFor(sql(), userId), null, 'the re-grant did not entitle');
    const rows = await rowsFor(userId);
    assert.equal(rows.length, 2, 'the expired row was replaced instead of closed out');
    assert.equal(rows[0]?.revoked_reason, enrolments.SUPERSEDED_REASON);
  });

  // The partial unique index does not serialise `grant` against `revoke`. Both cases below were
  // reproduced on PostgreSQL 16 before `lockLearner` existed, and each waits for a backend to block.

  /** Throws if no backend blocks, because a case with no contention has not tested the race. */
  async function untilABackendBlocks(): Promise<void> {
    const blocked = await withAdminSql(async (watcher) => {
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const rows = await watcher<{ waiting: number }[]>`
          select count(*)::int as waiting
            from pg_locks
           where not granted and pid <> pg_backend_pid()
        `;
        if ((rows[0]?.waiting ?? 0) > 0) return true;
        await new Promise((wake) => setTimeout(wake, 20));
      }
      return false;
    });
    assert.equal(blocked, true, 'nothing ever blocked, so this case interleaved nothing');
  }

  it('withdraws the place a concurrent re-grant created, instead of reporting nothing to withdraw', async () => {
    // NEGATIVE CONTROL, measured on PostgreSQL 16. With an expired unrevoked row in the slot, A's
    // `grant` closed it out and inserted an unbounded row. B's `revoke` waited on A's row lock,
    // re-checked a now-revoked tuple, and could not see A's new row. It returned NULL while
    // `entitlementFor` still answered entitled. No serial order produces that.
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await grantTo(cohortId, userId, { startsAt: at(-120), expiresAt: at(-1) });

    let grantWritten!: () => void;
    const written = new Promise<void>((wake) => {
      grantWritten = wake;
    });
    let letTheGrantCommit!: () => void;
    const revokeIsWaiting = new Promise<void>((wake) => {
      letTheGrantCommit = wake;
    });

    const withdrawn = await withAdminSql(async (admin) => {
      const granting = admin.begin(async (tx) => {
        const out = await enrolments.grant(tx, {
          cohortId,
          userId,
          grantedBy: 'J. Okafor',
          reference: 'registry-row-91',
          startsAt: null,
          expiresAt: null,
        });
        grantWritten();
        await revokeIsWaiting;
        return { value: out };
      });

      await written;
      const revoking = admin.begin(async (tx) => ({
        value: await enrolments.revoke(tx, {
          cohortId,
          userId,
          revokedBy: 'A. Reyes',
          reason: 'place transferred',
        }),
      }));
      await untilABackendBlocks();
      letTheGrantCommit();

      const [, revoked] = await Promise.all([granting, revoking]);
      return revoked.value;
    });

    assert.notEqual(withdrawn, null, 'the withdrawal reported that there was nothing to withdraw');
    assert.equal(
      await enrolments.entitlementFor(sql(), userId),
      null,
      'the learner is still entitled after a withdrawal that was told it had succeeded',
    );
    const rows = await rowsFor(userId);
    assert.equal(rows.length, 2, 'the re-grant did not leave both rows');
    assert.equal(rows[0]?.revoked_reason, enrolments.SUPERSEDED_REASON);
    assert.equal(rows[1]?.revoked_reason, 'place transferred', 'the live row was not the one withdrawn');
  });

  it('withdraws an enrolment granted after the withdrawing transaction opened', async () => {
    // NEGATIVE CONTROL. `now()` is `transaction_timestamp()`. A withdrawal from a transaction opened
    // before the grant wrote `revoked_at` before `granted_at`, and `enrolments_revoked_after_grant`
    // aborted it with an unmapped 23514. Reproduced with a 400 ms lead. Serialising on the learner's
    // row makes that the ordinary case.
    const cohortId = await makeCohort();
    const userId = await makeUser();

    await withAdminSql(async (admin) => {
      const boxed = await admin.begin(async (tx) => {
        // Fixes this transaction's `now()` before anything is granted.
        await tx`select 1`;
        await withAdminSql((other) =>
          other.begin(async (inner) => {
            await enrolments.grant(inner, {
              cohortId,
              userId,
              grantedBy: 'J. Okafor',
              reference: 'registry-row-92',
              startsAt: null,
              expiresAt: null,
            });
          }),
        );
        return {
          value: await enrolments.revoke(tx, {
            cohortId,
            userId,
            revokedBy: 'A. Reyes',
            reason: 'entered in error',
          }),
        };
      });
      assert.notEqual(boxed.value, null, 'there was nothing to withdraw');
      assert.equal(boxed.value?.revokedReason, 'entered in error');
    });

    assert.equal(await enrolments.entitlementFor(sql(), userId), null, 'the withdrawal did not take');
  });

  it('refuses a pool handle, so a grant cannot be written without its audit entry', async () => {
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await assert.rejects(
      () =>
        enrolments.grant(sql(), {
          cohortId,
          userId,
          grantedBy: 'J. Okafor',
          reference: 'registry-row-88',
        }),
      /must run inside a transaction/u,
      'grant accepted a pool handle, on which each statement commits alone',
    );
  });

  it('rolls back the enrolment AND its audit entry together (NEGATIVE CONTROL)', async () => {
    // The grant and its audit entry are one fact. This fails if the audit write leaves the caller's
    // transaction.
    const cohortId = await makeCohort();
    const userId = await makeUser();
    const marker = `deliberate failure ${randomBytes(4).toString('hex')}`;

    await assert.rejects(
      () =>
        asOperator(async (tx) => {
          await enrolments.grant(tx, {
            cohortId,
            userId,
            grantedBy: 'J. Okafor',
            reference: 'registry-row-88',
          });
          throw new Error(marker);
        }),
      new RegExp(marker, 'u'),
    );

    assert.equal((await rowsFor(userId)).length, 0, 'an enrolment survived a rolled-back transaction');
    const entries = await audit.readRecent(sql(), { userId, event: 'enrolment.granted' });
    assert.equal(entries.length, 0, 'an audit entry survived for a grant that was rolled back');
  });

  it('writes exactly one audit entry per grant and per revocation', async () => {
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await grantTo(cohortId, userId, { reference: 'registry-row-88' });
    await asOperator((tx) =>
      enrolments.revoke(tx, { cohortId, userId, revokedBy: 'A. Reyes', reason: 'withdrew' }),
    );

    const granted = await audit.readRecent(sql(), { userId, event: 'enrolment.granted' });
    const revoked = await audit.readRecent(sql(), { userId, event: 'enrolment.revoked' });
    assert.equal(granted.length, 1);
    assert.equal(revoked.length, 1);
    // Authority and reference are what survive an account erasure.
    const detail = granted[0]?.detail as Record<string, unknown>;
    assert.equal(detail['by'], 'J. Okafor');
    assert.equal(detail['reference'], 'registry-row-88');
  });

  it('refuses a write from the request-path role', async () => {
    // `set local role` rather than trusting DATABASE_URL, which is usually a superuser on a dev machine.
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await assert.rejects(
      () =>
        sql().begin(async (tx) => {
          await tx`set local role prl_app`;
          await tx`
            insert into prl.enrolments (id, cohort_id, user_id, granted_by, reference)
            values (${`enr_${randomBytes(13).toString('hex')}`}, ${cohortId}, ${userId},
                    ${'an injection'}, ${'none'})
          `;
        }),
      /permission denied/u,
      'the request-path role could write an enrolment',
    );
  });

  it('lets the request-path role read an entitlement', async () => {
    // A missing `GRANT SELECT` would make every entitlement check a 500.
    const cohortId = await makeCohort();
    const userId = await makeUser();
    await grantTo(cohortId, userId);
    const entitlement = await sql().begin(async (tx) => {
      await tx`set local role prl_app`;
      return { value: await enrolments.entitlementFor(tx, userId) };
    });
    assert.notEqual(entitlement.value, null, 'prl_app could not read an entitlement it must read');
  });

  /**
   * `postgresSeatEntitlement` on the real schema as `prl_app`, over every state of the window.
   * `seat-entitlement.test.ts` proves what a `false` does, and this proves the window produces one.
   */
  it('is the seat guard: postgresSeatEntitlement answers false for every way of not being in', async () => {
    const live = await makeUser();
    const revoked = await makeUser();
    const expired = await makeUser();
    const notStarted = await makeUser();
    const neverEnrolled = await makeUser();
    const cohortId = await makeCohort();
    const endedCohort = await makeCohort({ startsAt: at(-120), endsAt: at(-60) });
    const inEndedCohort = await makeUser();

    await grantTo(cohortId, live);
    await grantTo(cohortId, revoked);
    await asOperator((tx) =>
      enrolments.revoke(tx, { cohortId, userId: revoked, revokedBy: 'J. Okafor', reason: 'transferred' }),
    );
    await grantTo(cohortId, expired, { startsAt: at(-60), expiresAt: at(-30) });
    await grantTo(cohortId, notStarted, { startsAt: at(60) });
    await grantTo(endedCohort, inEndedCohort, { startsAt: at(-120) });

    const answers = await sql().begin(async (tx) => {
      await tx`set local role prl_app`;
      const guard = postgresSeatEntitlement(() => tx);
      return {
        value: {
          live: await guard.entitledToSit(live),
          revoked: await guard.entitledToSit(revoked),
          expired: await guard.entitledToSit(expired),
          notStarted: await guard.entitledToSit(notStarted),
          neverEnrolled: await guard.entitledToSit(neverEnrolled),
          inEndedCohort: await guard.entitledToSit(inEndedCohort),
        },
      };
    });

    assert.deepEqual(answers.value, {
      live: true,
      revoked: false,
      expired: false,
      notStarted: false,
      neverEnrolled: false,
      inEndedCohort: false,
    });
  });

  it('takes the enrolment with the account, and leaves the record of it behind', async () => {
    // `enrolments_user_id_fkey` is ON DELETE CASCADE. The operator's audit record survives with
    // `user_id` NULL. `docs/production/legal-register.md` §3.1 states it.
    const cohortId = await makeCohort();
    const userId = await makeUser();
    const reference = `registry-row-${randomBytes(4).toString('hex')}`;
    await grantTo(cohortId, userId, { reference });

    const summary = await asOperator((tx) => deleteAccount(tx, userId));
    assert.equal(summary?.deleted.enrolments, 1, 'the erasure did not report the enrolment it removed');
    assert.equal((await rowsFor(userId)).length, 0, 'an entitlement outlived the account it entitled');

    const entries = await withAdminSql(
      (admin) => admin<{ user_id: string | null; detail: Record<string, unknown> }[]>`
        select user_id, detail from prl.audit_log
         where event = 'enrolment.granted' and detail->>'reference' = ${reference}
      `,
    );
    assert.equal(entries.length, 1, 'the record of the grant went with the account');
    assert.equal(entries[0]?.user_id, null, 'the surviving record still names the erased account');
    assert.equal(entries[0]?.detail['by'], 'J. Okafor', 'the authority must survive the erasure');
  });
});
