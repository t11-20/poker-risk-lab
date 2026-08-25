/**
 * Cohorts and entitlements, against a real database.
 *
 * ## Why every case here needs a schema
 *
 * Nothing in `repositories/enrolments.ts` can be usefully proved with a fake handle. The window is
 * `greatest(starts_at, cohort.starts_at)` and `least(expires_at, cohort.ends_at)` evaluated by
 * PostgreSQL against PostgreSQL's own `now()`; the "one live enrolment per person per cohort" rule
 * is a partial unique index; the atomicity of a grant and its audit entry is a transaction; and the
 * fact that the request path cannot write an enrolment is a GRANT. A fake would have to reimplement
 * all four, and would then be asserting that the reimplementation agrees with itself.
 *
 * ## Which identity runs which statement, and why it matters
 *
 * The reads — `entitlementFor`, `forUser`, `listForCohort` — run on the ORDINARY test client, which
 * in CI is `prl_ci_app`, a member of `prl_app` and nothing else. So a missing `GRANT SELECT` on
 * either new table fails this suite rather than surfacing as a 500 on the first request that asks.
 *
 * The writes run through `withAdminSql`, the migrating identity, because `prl_app` holds SELECT and
 * nothing else on both tables — that is the whole privilege argument in
 * `db/migrations/0006_cohort_enrolments.sql`, and `refuses a write from the request-path role`
 * below asserts it directly rather than taking it on trust.
 *
 * ## The shape of a negative control here
 *
 * Four of these cases exist because the mistake they catch is SILENT and expensive in the same
 * direction: somebody entitled who should not be. A revoked enrolment that still entitles, an
 * expired one that still entitles, one that entitles before it begins, and a cohort that has ended
 * but whose members are still in — none of those produces an error anywhere. They produce a person
 * with access nobody granted them, and the only thing that will ever notice is a test like this.
 *
 * The fifth is the opposite failure and is worse to ship: a unique index that forbade re-enrolment
 * after a revocation would make the revocation permanent, and the operator's only way out would be
 * to edit the row that records it.
 *
 * Skips, loudly, when there is no test database. `databaseSkip` is the suite's own mechanism.
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
    // Reads `prl.enrolments` specifically: on a database migrated before 0006 this is the error
    // that says so, rather than a suite that fails one assertion at a time further down.
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
  /** The request path's handle: `prl_app` and its SELECT-only grants. Every READ goes through it. */
  const sql = () => client as Sql;

  /**
   * One operator action, on the migrating identity, in one transaction.
   *
   * Boxed for `db.ts`'s reason: postgres.js types `begin` as `UnwrapPromiseArray<T>`, so a callback
   * returning an array would come back with a different type from one returning a row.
   */
  function asOperator<T>(use: (tx: Db) => Promise<T>): Promise<T> {
    return withAdminSql(async (admin) => {
      const boxed = await admin.begin(async (tx) => ({ value: await use(tx) }));
      return boxed.value;
    });
  }

  const created: { cohorts: string[]; users: string[] } = { cohorts: [], users: [] };

  /** Minutes from now, as a Date, so a fixture reads as its own timeline. */
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

  /** A cohort whose period is wide open unless a case says otherwise. */
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
    // As the schema owner: `prl_app` holds no DELETE on any of these three tables, which is the
    // privilege model working rather than a gap in it. Users go first so the enrolments cascade,
    // then the audit rows this suite's own operations wrote, then the cohorts they pointed at.
    await withAdminSql(async (admin) => {
      if (created.users.length > 0) await admin`delete from prl.users where id in ${admin(created.users)}`;
      if (created.cohorts.length > 0) {
        // Every entry this suite wrote names its cohort in `detail`, including `cohort.created`,
        // so one predicate reaches all of them — and reaches the ones whose `user_id` was already
        // NULLed by the erasure case, which the user delete above cannot.
        await admin`delete from prl.audit_log where detail->>'cohortId' in ${admin(created.cohorts)}`;
        await admin`delete from prl.enrolments where cohort_id in ${admin(created.cohorts)}`;
        await admin`delete from prl.cohorts where id in ${admin(created.cohorts)}`;
      }
    });
  });

  /** One grant, with the defaults every case that is not about the grant itself wants. */
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

  /** The rows as they actually are, read as the schema owner so no grant can hide one. */
  function rowsFor(userId: string): Promise<readonly { id: string; revoked_reason: string | null }[]> {
    return withAdminSql(
      (admin) => admin<{ id: string; revoked_reason: string | null }[]>`
        select id, revoked_reason from prl.enrolments where user_id = ${userId} order by granted_at
      `,
    );
  }

  // -------------------------------------------------------------------------
  // The window
  // -------------------------------------------------------------------------

  it('entitles a live enrolment, and says until when', async () => {
    const cohortId = await makeCohort({ endsAt: at(60 * 24 * 30) });
    const userId = await makeUser();
    const expiresAt = at(60 * 24);
    await grantTo(cohortId, userId, { expiresAt });

    const entitlement = await enrolments.entitlementFor(sql(), userId);
    assert.notEqual(entitlement, null, 'a live enrolment did not entitle');
    assert.equal(entitlement?.cohortId, cohortId);
    // The enrolment ends before the cohort does, so it is the enrolment that decides.
    assert.equal(entitlement?.until?.toISOString(), expiresAt.toISOString());
  });

  it("takes the cohort's end when the enrolment carries none", async () => {
    // The operator mistake this exists for: enrol thirty people and forget --expires. Under a
    // design where the cohort period were documentation, every one of them would be entitled
    // forever, silently, with nothing anywhere saying so.
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
    // The half that is easy to get wrong in the other direction: a revocation implemented as a
    // delete would pass the assertion above and destroy the only record of the withdrawal.
    const rows = await rowsFor(userId);
    assert.equal(rows.length, 1, 'revocation removed the row instead of marking it');
    assert.equal(revoked?.revokedReason, 'place transferred');
    assert.equal(revoked?.revokedBy, 'J. Okafor');
    assert.notEqual(revoked?.revokedAt, null);
  });

  it('does not entitle an EXPIRED enrolment (NEGATIVE CONTROL)', async () => {
    const cohortId = await makeCohort();
    const userId = await makeUser();
    // Started two hours ago, ended one minute ago. Both timestamps are in the past, which is the
    // only way an expired row can exist: the schema refuses one that expires before it starts.
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
    // The same failure reached through the other clock. A class list loaded in August for a course
    // that starts in September must not open the course in August.
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
    // Two courses at once is ordinary, and the answer a caller needs is "until when can they get
    // in" — so the earliest-ending row is the wrong one to return. It would name a date on which
    // access demonstrably does not end.
    const userId = await makeUser();
    const shortCohort = await makeCohort({ endsAt: at(60 * 24) });
    const longCohort = await makeCohort({ endsAt: at(60 * 24 * 20) });
    await grantTo(shortCohort, userId);
    await grantTo(longCohort, userId);

    const entitlement = await enrolments.entitlementFor(sql(), userId);
    assert.equal(entitlement?.cohortId, longCohort, 'the shorter entitlement was reported');
  });

  // -------------------------------------------------------------------------
  // Two enrolments in one cohort, over time
  // -------------------------------------------------------------------------

  it('allows a re-grant after a revocation, keeping both rows (NEGATIVE CONTROL)', async () => {
    // ########################################################################
    // ## THE BUG A FULL UNIQUE INDEX WOULD HAVE SHIPPED SILENTLY            ##
    // ########################################################################
    //
    // `UNIQUE (cohort_id, user_id)` passes every other case in this file. It fails only here, weeks
    // later, when a withdrawal turns out to have been wrong — and the operator's only route back
    // would be to edit the row that records the revocation, which is the one thing that must never
    // happen. The index is partial on `revoked_at IS NULL` precisely so this works.
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
    // The same silent bug in its second disguise. An index predicate cannot say "not currently
    // effective" — `now()` is not immutable — so an expired row still occupies the unique slot, and
    // a straight insert would answer `already_enrolled` to an operator re-enrolling somebody who is
    // entitled to nothing at all. Both rows must survive, and the closed-out one must say why.
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

  // -------------------------------------------------------------------------
  // The grant and its record are one fact
  // -------------------------------------------------------------------------

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
    // The two halves are one fact: an entitlement nobody can account for, and a record of a grant
    // that never happened, are both worse than the failure that produced them. This drives a
    // transaction that grants and then fails, and asserts that NEITHER survives — which is what
    // fails if the audit write is ever moved out of the caller's transaction to make it
    // "best-effort".
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
    // The authority and the external reference are the two facts an operator needs six months
    // later, and they are the two that survive an account erasure — see the case below.
    const detail = granted[0]?.detail as Record<string, unknown>;
    assert.equal(detail['by'], 'J. Okafor');
    assert.equal(detail['reference'], 'registry-row-88');
  });

  // -------------------------------------------------------------------------
  // Least privilege, and erasure
  // -------------------------------------------------------------------------

  it('refuses a write from the request-path role', async () => {
    // `prl_app` holds SELECT and nothing else on both tables, so no HTTP handler can grant anybody
    // anything however it is written. Asserted through the application's own connection, because
    // that is the identity a route would have.
    //
    // `set local role` rather than trusting DATABASE_URL to be unprivileged: a developer's single
    // DSN is usually the superuser the compose file creates, and this case would then assert
    // nothing at all on the machine where it runs most often.
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
    // The other half of the same grant, and the one whose absence would be a runtime 500 rather
    // than a security problem: a missing `GRANT SELECT` makes every entitlement check fail.
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
   * The seat guard, on the real schema, as `prl_app` — the whole join from a row to a refusal.
   *
   * `test/seat-entitlement.test.ts` proves what a `false` does to both transports and drives a real
   * `sit` frame to prove it; what it cannot prove is that the four ways of not being entitled
   * actually produce a `false`, because that arithmetic is `greatest(...)`/`least(...)` against
   * PostgreSQL's own `now()` and a fake would only be agreeing with itself. This is the joint: the
   * binding a deployment actually runs (`postgresSeatEntitlement`), on the request-path role, over
   * every state of the window.
   *
   * Run under `set local role prl_app` for the reason the read case above is: a missing
   * `GRANT SELECT` must fail here rather than as a 500 the first time somebody sits down.
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
    // The retention decision, asserted rather than described. `enrolments_user_id_fkey` is ON
    // DELETE CASCADE, so the entitlement goes: it describes one person, nobody else's record is in
    // it, and one naming an account that no longer exists entitles nobody. What survives is the
    // operator's record in `prl.audit_log`, with `user_id` NULL — so "on whose authority, against
    // which reference, and was it withdrawn" is still answerable about an erased account, and the
    // person is no longer named. `docs/production/legal-register.md` §3.1 states it.
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
