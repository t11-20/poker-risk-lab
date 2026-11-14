/**
 * `prl.cohorts` and `prl.enrolments`. Records that somebody is entitled and who said so, nothing
 * else. `reference` is an opaque external string and nothing here parses it.
 *
 * An entitlement is live when unrevoked and inside both windows, from
 * `greatest(enrolment.starts_at, cohort.starts_at)` until `least(enrolment.expires_at, cohort.ends_at)`.
 * `least`/`greatest` ignore NULLs in PostgreSQL, so NULL means unbounded.
 *
 * Writes require a transaction so the row and its `prl.audit_log` entry land together or not at all.
 * `prl_app` holds SELECT only on both tables, so `grant`/`revoke` fail with `permission denied` on a
 * request handle. The writes run from `apps/api/scripts/enrolments.mjs` as the migrating identity.
 */

import { AppError } from '../errors.ts';
import * as audit from './audit.ts';
import { newCohortId, newEnrolmentId } from './ids.ts';
import { type Db, requireTransaction, violationError } from './sql.ts';

const WITH_ITS_AUDIT_ENTRY =
  'a transaction so that the enrolment row and its audit entry cannot land separately';

/** Tells a superseded row apart from a deliberate withdrawal. */
export const SUPERSEDED_REASON = 'superseded by a later grant';

export interface Cohort {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly startsAt: Date;
  readonly endsAt: Date | null;
}

interface CohortRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly starts_at: Date;
  readonly ends_at: Date | null;
}

const toCohort = (row: CohortRow): Cohort => ({
  id: row.id,
  key: row.key,
  name: row.name,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
});

/**
 * `until` null means "no end recorded", not "forever". The enrolment can still be revoked, so a
 * caller must not cache this without a ceiling.
 */
export interface Entitlement {
  readonly enrolmentId: string;
  readonly cohortId: string;
  readonly cohortKey: string;
  readonly cohortName: string;
  readonly from: Date;
  readonly until: Date | null;
}

export interface EnrolmentRecord {
  readonly id: string;
  readonly cohortId: string;
  readonly cohortKey: string;
  readonly cohortName: string;
  readonly userId: string;
  readonly displayName: string | null;
  readonly grantedAt: Date;
  readonly grantedBy: string;
  readonly reference: string;
  readonly startsAt: Date;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly revokedReason: string | null;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
  readonly entitledNow: boolean;
}

interface EnrolmentRecordRow {
  readonly id: string;
  readonly cohort_id: string;
  readonly cohort_key: string;
  readonly cohort_name: string;
  readonly user_id: string;
  readonly display_name: string | null;
  readonly granted_at: Date;
  readonly granted_by: string;
  readonly reference: string;
  readonly starts_at: Date;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_by: string | null;
  readonly revoked_reason: string | null;
  readonly effective_from: Date;
  readonly effective_until: Date | null;
  readonly entitled_now: boolean;
}

const toRecord = (row: EnrolmentRecordRow): EnrolmentRecord => ({
  id: row.id,
  cohortId: row.cohort_id,
  cohortKey: row.cohort_key,
  cohortName: row.cohort_name,
  userId: row.user_id,
  displayName: row.display_name,
  grantedAt: row.granted_at,
  grantedBy: row.granted_by,
  reference: row.reference,
  startsAt: row.starts_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  revokedBy: row.revoked_by,
  revokedReason: row.revoked_reason,
  effectiveFrom: row.effective_from,
  effectiveUntil: row.effective_until,
  entitledNow: row.entitled_now,
});

/**
 * The window arithmetic for the operator reads. It must match `entitlementFor` exactly, or the
 * operator tool and the entitlement check will disagree about who is in. `entitled_now` is computed
 * by the database so only one clock decides it.
 */
function enrolmentSelect(sql: Db) {
  return sql`
    select e.id,
           e.cohort_id,
           c.key  as cohort_key,
           c.name as cohort_name,
           e.user_id,
           u.display_name,
           e.granted_at,
           e.granted_by,
           e.reference,
           e.starts_at,
           e.expires_at,
           e.revoked_at,
           e.revoked_by,
           e.revoked_reason,
           greatest(e.starts_at, c.starts_at) as effective_from,
           least(e.expires_at, c.ends_at)     as effective_until,
           (
                 e.revoked_at is null
             and greatest(e.starts_at, c.starts_at) <= now()
             and (least(e.expires_at, c.ends_at) is null or least(e.expires_at, c.ends_at) > now())
           ) as entitled_now
      from prl.enrolments e
      join prl.cohorts c on c.id = e.cohort_id
      join prl.users   u on u.id = e.user_id
  `;
}

export interface CreateCohortInput {
  readonly key: string;
  readonly name: string;
  readonly startsAt: Date;
  readonly endsAt?: Date | null;
}

/**
 * A duplicate `key` reaches the caller as the raw unique violation on purpose. The only caller is
 * the CLI, which names the taken key, so a wire code would serve nothing.
 */
export async function createCohort(sql: Db, input: CreateCohortInput): Promise<Cohort> {
  requireTransaction(sql, 'createCohort', WITH_ITS_AUDIT_ENTRY);
  const id = newCohortId();
  const endsAt = input.endsAt ?? null;
  const rows = await sql<CohortRow[]>`
    insert into prl.cohorts (id, key, name, starts_at, ends_at)
    values (${id}, ${input.key}, ${input.name}, ${input.startsAt}, ${endsAt})
    returning id, key, name, starts_at, ends_at
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('internal_error', { logDetail: 'inserting a cohort returned no row' });
  }
  await audit.record(sql, {
    event: 'cohort.created',
    detail: { cohortId: id, cohortKey: input.key, startsAt: input.startsAt.toISOString() },
  });
  return toCohort(row);
}

export async function cohortByKey(sql: Db, key: string): Promise<Cohort | null> {
  const rows = await sql<CohortRow[]>`
    select id, key, name, starts_at, ends_at from prl.cohorts where key = ${key}
  `;
  const row = rows[0];
  return row === undefined ? null : toCohort(row);
}

/** For the operator tool. Nothing on a request path reads it. */
export async function listCohorts(sql: Db): Promise<readonly Cohort[]> {
  const rows = await sql<CohortRow[]>`
    select id, key, name, starts_at, ends_at from prl.cohorts order by starts_at asc, key asc
  `;
  return rows.map(toCohort);
}

/**
 * Is this person entitled right now, and until when? Cheap enough for a request path, because
 * `enrolments_live_user_idx` is `(user_id) WHERE revoked_at IS NULL` and the joins are key lookups.
 *
 * With several live enrolments, the longest-running wins. `desc` puts NULL first in PostgreSQL, so
 * an unbounded entitlement outranks every dated one. Null covers every way of not being entitled;
 * `forUser` is the call that tells them apart.
 */
export async function entitlementFor(sql: Db, userId: string): Promise<Entitlement | null> {
  const rows = await sql<
    {
      id: string;
      cohort_id: string;
      cohort_key: string;
      cohort_name: string;
      from: Date;
      until: Date | null;
    }[]
  >`
    select e.id,
           e.cohort_id,
           c.key  as cohort_key,
           c.name as cohort_name,
           greatest(e.starts_at, c.starts_at) as "from",
           least(e.expires_at, c.ends_at)     as until
      from prl.enrolments e
      join prl.cohorts c on c.id = e.cohort_id
     where e.user_id = ${userId}
       and e.revoked_at is null
       and greatest(e.starts_at, c.starts_at) <= now()
       and (least(e.expires_at, c.ends_at) is null or least(e.expires_at, c.ends_at) > now())
     order by least(e.expires_at, c.ends_at) desc, e.granted_at desc
     limit 1
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    enrolmentId: row.id,
    cohortId: row.cohort_id,
    cohortKey: row.cohort_key,
    cohortName: row.cohort_name,
    from: row.from,
    until: row.until,
  };
}

/** Includes revoked enrolments. */
export async function forUser(sql: Db, userId: string): Promise<readonly EnrolmentRecord[]> {
  const rows = await sql<EnrolmentRecordRow[]>`
    ${enrolmentSelect(sql)}
     where e.user_id = ${userId}
     order by e.granted_at desc
  `;
  return rows.map(toRecord);
}

export interface ListForCohortOptions {
  readonly includeRevoked?: boolean;
}

export async function listForCohort(
  sql: Db,
  cohortId: string,
  options: ListForCohortOptions = {},
): Promise<readonly EnrolmentRecord[]> {
  const includeRevoked = options.includeRevoked === true;
  const rows = await sql<EnrolmentRecordRow[]>`
    ${enrolmentSelect(sql)}
     where e.cohort_id = ${cohortId}
       and (${includeRevoked}::boolean or e.revoked_at is null)
     order by e.granted_at desc, e.id asc
  `;
  return rows.map(toRecord);
}

export async function byId(sql: Db, enrolmentId: string): Promise<EnrolmentRecord | null> {
  const rows = await sql<EnrolmentRecordRow[]>`
    ${enrolmentSelect(sql)}
     where e.id = ${enrolmentId}
  `;
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export interface GrantInput {
  readonly cohortId: string;
  readonly userId: string;
  readonly grantedBy: string;
  readonly reference: string;
  /** Defaults to the database's `now()`. */
  readonly startsAt?: Date | null;
  readonly expiresAt?: Date | null;
}

/** Not an exception, because the bulk path needs a per-person answer inside one transaction. */
export type GrantOutcome =
  | {
      readonly outcome: 'granted';
      readonly enrolmentId: string;
      /** Set when an expired enrolment was closed out to make room for this one. */
      readonly supersededId: string | null;
    }
  | {
      readonly outcome: 'already_enrolled';
      readonly enrolmentId: string;
    };

/**
 * Grants an entitlement, or reports that an unrevoked one already exists.
 *
 * 1. Lock the learner's row (see `lockLearner`).
 * 2. Close out an EXPIRED predecessor. `enrolments_live_cohort_user_key` cannot exclude expired rows
 *    because `now()` is not immutable, so an expired row still holds the slot. A live one is left
 *    alone, because extending access needs its own command.
 * 3. Insert with `on conflict ... do nothing` and let the partial unique index decide. A prior read
 *    would let two operators both find nobody and both write.
 * 4. Audit, inside the caller's transaction.
 *
 * `already_enrolled` is not an error, because re-running a class list is how an operator recovers a
 * half-finished run.
 */
export async function grant(sql: Db, input: GrantInput): Promise<GrantOutcome> {
  requireTransaction(sql, 'grant', WITH_ITS_AUDIT_ENTRY);
  await lockLearner(sql, input.userId);

  const superseded = await sql<{ id: string }[]>`
    update prl.enrolments
       set revoked_at = clock_timestamp(),
           revoked_by = ${input.grantedBy},
           revoked_reason = ${SUPERSEDED_REASON}
     where cohort_id = ${input.cohortId}
       and user_id = ${input.userId}
       and revoked_at is null
       and expires_at is not null
       and expires_at <= now()
    returning id
  `;

  const id = newEnrolmentId();
  const startsAt = input.startsAt ?? null;
  const expiresAt = input.expiresAt ?? null;
  let inserted: { id: string }[];
  try {
    inserted = await sql<{ id: string }[]>`
      insert into prl.enrolments
        (id, cohort_id, user_id, granted_by, reference, starts_at, expires_at)
      values (
        ${id}, ${input.cohortId}, ${input.userId}, ${input.grantedBy}, ${input.reference},
        coalesce(${startsAt}::timestamptz, now()), ${expiresAt}::timestamptz
      )
      on conflict (cohort_id, user_id) where revoked_at is null do nothing
      returning id
    `;
  } catch (error) {
    const mapped = violationError(error, 'granting an enrolment');
    if (mapped !== null) throw mapped;
    throw error;
  }

  const row = inserted[0];
  if (row === undefined) {
    const existing = await sql<{ id: string }[]>`
      select id from prl.enrolments
       where cohort_id = ${input.cohortId} and user_id = ${input.userId} and revoked_at is null
    `;
    const held = existing[0];
    if (held === undefined) {
      // Unreachable while `lockLearner` holds the row. Without it a concurrent `revoke` could
      // empty the slot between the refused insert and this read.
      throw new AppError('internal_error', {
        logDetail: 'granting an enrolment: the insert was refused and no conflicting row exists',
      });
    }
    return { outcome: 'already_enrolled', enrolmentId: held.id };
  }

  const supersededId = superseded[0]?.id ?? null;
  if (supersededId !== null) {
    await audit.record(sql, {
      event: 'enrolment.superseded',
      userId: input.userId,
      detail: {
        enrolmentId: supersededId,
        cohortId: input.cohortId,
        replacedBy: row.id,
        reason: SUPERSEDED_REASON,
        by: input.grantedBy,
      },
    });
  }
  await audit.record(sql, {
    event: 'enrolment.granted',
    userId: input.userId,
    detail: {
      enrolmentId: row.id,
      cohortId: input.cohortId,
      by: input.grantedBy,
      reference: input.reference,
      startsAt: startsAt === null ? null : startsAt.toISOString(),
      expiresAt: expiresAt === null ? null : expiresAt.toISOString(),
      supersededId,
    },
  });
  return { outcome: 'granted', enrolmentId: row.id, supersededId };
}

export interface RevokeInput {
  readonly cohortId: string;
  readonly userId: string;
  readonly revokedBy: string;
  readonly reason: string;
}

/**
 * Withdraws an entitlement with an UPDATE, never a delete, so the withdrawal stays on record and the
 * partial unique index still allows a re-grant. Returns null when there was nothing to withdraw, so a
 * re-run is not a failure.
 */
export async function revoke(sql: Db, input: RevokeInput): Promise<EnrolmentRecord | null> {
  requireTransaction(sql, 'revoke', WITH_ITS_AUDIT_ENTRY);
  await lockLearner(sql, input.userId);

  const rows = await sql<{ id: string }[]>`
    update prl.enrolments
       set revoked_at = clock_timestamp(),
           revoked_by = ${input.revokedBy},
           revoked_reason = ${input.reason}
     where cohort_id = ${input.cohortId}
       and user_id = ${input.userId}
       and revoked_at is null
    returning id
  `;
  const row = rows[0];
  if (row === undefined) return null;

  await audit.record(sql, {
    event: 'enrolment.revoked',
    userId: input.userId,
    detail: {
      enrolmentId: row.id,
      cohortId: input.cohortId,
      by: input.revokedBy,
      reason: input.reason,
    },
  });
  return byId(sql, row.id);
}

/**
 * Serialises every write about one learner on the learner's row. The partial unique index decides
 * who holds the slot but does not make `grant` and `revoke` serialisable under READ COMMITTED.
 * Without this lock, on PostgreSQL 16:
 *
 * - A `revoke` blocked behind a `grant`'s supersede matches nothing after it commits, because the
 *   new row is a phantom to its snapshot. It returns null while the learner stays entitled.
 * - A `revoke` committing between `grant`'s refused insert and its read-back makes `grant` throw
 *   `internal_error`, aborting the whole bulk transaction.
 *
 * `prl.users` is the same row `deleteAccount` and `deleteAbandonedGuest` lock, so erasure and grants
 * share one lock order. An unknown learner returns no row, and the foreign key or "nothing to
 * withdraw" handles it.
 *
 * The writes use `clock_timestamp()` for `revoked_at` because a queued transaction's `now()` can
 * predate the grant it waited for, and `enrolments_revoked_after_grant` then refuses it with 23514.
 */
async function lockLearner(sql: Db, userId: string): Promise<void> {
  await sql`select id from prl.users where id = ${userId} for update`;
}
