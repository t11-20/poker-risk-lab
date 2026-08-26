/**
 * `prl.cohorts` and `prl.enrolments` — who is entitled, until when, and on whose authority.
 *
 * ## What this module is for
 *
 * A compliance audit established by exhaustive search that this system held no record of
 * entitlement of any kind, so a person admitted to a taught cohort and a person who wandered in
 * off the internet were indistinguishable to every query it could run. `db/migrations/0006` adds
 * the two tables; this is every statement that touches them.
 *
 * It records THAT somebody is entitled and WHO SAID SO. There is no amount, no currency and no
 * external processor anywhere in this file, in those tables, or in this schema — 0001 opens by
 * saying so about the whole database and 0006 says so again. `reference` is an opaque external
 * string (a purchase-order number, a row id in a system nobody here can read, or the word
 * `scholarship`) and nothing in this module parses it.
 *
 * ## Two clocks bound an entitlement, not one
 *
 * A person is entitled at an instant when their enrolment is unrevoked and that instant falls
 * inside BOTH windows:
 *
 *     from   greatest(enrolment.starts_at, cohort.starts_at)
 *     until  least(enrolment.expires_at, cohort.ends_at)      -- NULL means unbounded
 *
 * `least`/`greatest` ignore NULLs in PostgreSQL and answer NULL only when every argument is NULL,
 * which is exactly the arithmetic wanted. The reason the cohort's period is enforcing rather than
 * decorative is in the migration: enrol thirty people and forget `--expires`, and under the other
 * design every one of them is entitled forever with nothing anywhere saying so.
 *
 * ## Why `grant` and `revoke` insist on a transaction handle
 *
 * ############################################################################
 * ## THE ROW AND ITS AUDIT ENTRY LAND TOGETHER OR NEITHER LANDS             ##
 * ############################################################################
 *
 * `prl.enrolments` is current state — the row says what is true now, and a revocation rewrites
 * three of its columns. The HISTORY is `prl.audit_log`, which is append-only by grant and is the
 * only place that will still say "granted on 3 March by J. Okafor against reference PO-4471, and
 * withdrawn on 2 May because the place was transferred". An entitlement written without that
 * entry is an entitlement nobody can account for; an entry written without the row is a claim
 * about a grant that never happened. Either half alone is worse than the failure, so both go
 * through one transaction and the handle is checked rather than trusted — the same test
 * `deleteAccount` uses, and for the same reason.
 *
 * ## Why an expired enrolment is superseded rather than refused
 *
 * `enrolments_live_cohort_user_key` is UNIQUE on `(cohort_id, user_id) WHERE revoked_at IS NULL`,
 * which is the invariant that matters: at most one unrevoked enrolment per person per cohort, with
 * revoked ones kept so that a later re-grant works. An index predicate cannot say "not currently
 * effective", though, because `now()` is not immutable — so an enrolment that has merely EXPIRED
 * still occupies the slot, and a straight insert would refuse a re-grant to somebody entitled to
 * nothing. `grant` closes the expired predecessor out first, in the same transaction, with a
 * reason that says what happened. Both rows survive.
 *
 * ## Why both writes take the learner's row first
 *
 * The index adjudicates who holds the slot. It does NOT make `grant` and `revoke` serialisable
 * against each other, and two interleavings that proved it — one of which reported a successful
 * withdrawal of nobody while the learner stayed entitled — are written out on `lockLearner`.
 *
 * ## Why nothing here can be reached from an HTTP handler
 *
 * `prl_app` — the role the request path connects as — holds SELECT and nothing else on both
 * tables. So `entitlementFor` works on a request handle and `grant`/`revoke` fail on one with
 * `permission denied`, by design and by grant rather than by convention. The writes run from
 * `apps/api/scripts/enrolments.mjs` as the migrating identity, whose reasoning for existing as a
 * CLI instead of an authenticated route is in that file's header.
 */

import { AppError } from '../errors.ts';
import * as audit from './audit.ts';
import { newCohortId, newEnrolmentId } from './ids.ts';
import { type Db, violationError } from './sql.ts';

/**
 * The reason written onto an enrolment that a later grant replaced.
 *
 * A constant rather than a literal at the call site because it is also what an operator reading
 * `list` sees, and because a test asserts that a superseded row is distinguishable from one a
 * person deliberately withdrew.
 */
export const SUPERSEDED_REASON = 'superseded by a later grant';

/** One row of `prl.cohorts`, as the callers of this module want it. */
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
 * The answer the request path needs: is this person entitled right now, and until when.
 *
 * `until` is `null` for an entitlement neither the enrolment nor the cohort bounds. A caller must
 * read that as "no end recorded", never as "forever" — the enrolment can still be revoked, and a
 * caller that caches this without a ceiling would keep somebody entitled after it was.
 */
export interface Entitlement {
  readonly enrolmentId: string;
  readonly cohortId: string;
  readonly cohortKey: string;
  readonly cohortName: string;
  /** When it began: the later of the two starts. Always in the past for a returned row. */
  readonly from: Date;
  readonly until: Date | null;
}

/** One enrolment, with its cohort and the computed window, for an operator and for a test. */
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
  /** `greatest(enrolment.starts_at, cohort.starts_at)`. */
  readonly effectiveFrom: Date;
  /** `least(enrolment.expires_at, cohort.ends_at)`, or null when neither bounds it. */
  readonly effectiveUntil: Date | null;
  /** Decided by the database, in the same statement, so it cannot disagree with the columns. */
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
 * The join, the computed window and the "is it live" predicate, written once.
 *
 * Three callers read enrolments — the request path, "show one person" and "list a cohort" — and
 * the window arithmetic has to be identical in all three or the operator tool and the entitlement
 * check will one day disagree about whether somebody is in. The copy that drifts is always the one
 * nobody looks at, and here that is the request path, whose failure mode is silent: a person kept
 * entitled after a cohort ended, or refused while it is running.
 *
 * `entitled_now` is computed by the database rather than in TypeScript for the same reason. Two
 * clocks would otherwise decide it — the server's and PostgreSQL's — and `room_ownership.ts` has
 * the long version of why that is never worth doing.
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

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

export interface CreateCohortInput {
  readonly key: string;
  readonly name: string;
  readonly startsAt: Date;
  readonly endsAt?: Date | null;
}

/**
 * Creates a cohort and records that it was created.
 *
 * Insists on a transaction for the reason at the top of the file: the row and its audit entry are
 * one fact. A duplicate `key` reaches the caller as the raw unique violation rather than a mapped
 * `AppError`, deliberately — `VIOLATION_CODES` in `sql.ts` maps constraints whose meaning is fixed
 * for every caller, and there is exactly one caller of this, a CLI, which turns the violation into
 * a sentence naming the key that is taken. A wire code for it would be a wire code for something
 * with no wire.
 */
export async function createCohort(sql: Db, input: CreateCohortInput): Promise<Cohort> {
  requireTransaction(sql, 'createCohort');
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

/** Every cohort, soonest-starting last. For the operator tool; nothing on a request path reads it. */
export async function listCohorts(sql: Db): Promise<readonly Cohort[]> {
  const rows = await sql<CohortRow[]>`
    select id, key, name, starts_at, ends_at from prl.cohorts order by starts_at asc, key asc
  `;
  return rows.map(toCohort);
}

// ---------------------------------------------------------------------------
// The request-path read
// ---------------------------------------------------------------------------

/**
 * Is this person entitled right now, and until when? One statement, one index.
 *
 * ## Why this is cheap enough for a request path
 *
 * `enrolments_live_user_idx` is `(user_id) WHERE revoked_at IS NULL`, so the scan starts from the
 * handful of rows that can still entitle THIS person — never from the table, which grows by one
 * row per grant for the life of the product and is never pruned. The two joins are primary-key
 * lookups. There is no aggregate, no sort over more than those rows and no subquery.
 *
 * ## Which enrolment it returns when there are several
 *
 * A person can hold live enrolments in more than one cohort at once (two courses), so this is a
 * `limit 1` over an ordering rather than a lookup that assumes uniqueness. The one that runs
 * LONGEST wins: `order by effective_until desc` puts NULL first under PostgreSQL's default
 * `NULLS FIRST` for `DESC`, which is what is wanted — an unbounded entitlement outlasts every
 * dated one. Returning the earliest-ending row instead would tell a caller that access ends on a
 * date on which it demonstrably does not.
 *
 * Returns null for "not entitled", which covers every way of not being: never enrolled, revoked,
 * expired, not started yet, or enrolled in a cohort that has ended. A caller must not try to tell
 * those apart from this — `forUser` is the call that can.
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

// ---------------------------------------------------------------------------
// Operator reads
// ---------------------------------------------------------------------------

/** Every enrolment this person has ever held, newest first. Includes the revoked ones. */
export async function forUser(sql: Db, userId: string): Promise<readonly EnrolmentRecord[]> {
  const rows = await sql<EnrolmentRecordRow[]>`
    ${enrolmentSelect(sql)}
     where e.user_id = ${userId}
     order by e.granted_at desc
  `;
  return rows.map(toRecord);
}

export interface ListForCohortOptions {
  /** Include withdrawn enrolments. Default false: a class list is who is in it. */
  readonly includeRevoked?: boolean;
}

/** Who is in a cohort, newest grant first. */
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

/** One enrolment by id, with its window. For a CLI that has just written one. */
export async function byId(sql: Db, enrolmentId: string): Promise<EnrolmentRecord | null> {
  const rows = await sql<EnrolmentRecordRow[]>`
    ${enrolmentSelect(sql)}
     where e.id = ${enrolmentId}
  `;
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface GrantInput {
  readonly cohortId: string;
  readonly userId: string;
  /** On whose authority. Recorded verbatim; see the column comment in 0006. */
  readonly grantedBy: string;
  /** The opaque external string. Never parsed here. */
  readonly reference: string;
  /** When access begins. Defaults to the database's `now()`. */
  readonly startsAt?: Date | null;
  /** When access ends, or null/undefined for an enrolment this row does not time-limit. */
  readonly expiresAt?: Date | null;
}

/**
 * What a grant did. Not an exception, because the bulk path enrols thirty people in one
 * transaction and needs a per-person answer rather than a failure that discards twenty-nine.
 */
export type GrantOutcome =
  | {
      readonly outcome: 'granted';
      readonly enrolmentId: string;
      /** Set when an EXPIRED enrolment was closed out to make room for this one. */
      readonly supersededId: string | null;
    }
  | {
      readonly outcome: 'already_enrolled';
      /** The unrevoked enrolment that is in the way, so the caller can say until when. */
      readonly enrolmentId: string;
    };

/**
 * Grants an entitlement, or reports that an unrevoked one already exists.
 *
 * ## The four statements, and why they are in this order
 *
 * 0. **Take the learner's row.** `lockLearner` — the index adjudicates who holds the slot, and it
 *    does not make this function serialisable against `revoke`. The two interleavings that proved
 *    that are written out there.
 * 1. **Close out an expired predecessor.** Scoped by `expires_at is not null and expires_at <=
 *    now()`, so it can only ever touch a row that entitles nobody. A LIVE enrolment is left
 *    strictly alone, which is what makes step 2 able to refuse a duplicate rather than silently
 *    extending somebody's access — extending is a decision, and a decision needs a command that
 *    says so.
 * 2. **Insert, and let the index adjudicate.** `on conflict ... do nothing` rather than a prior
 *    "is anybody enrolled?" read: that read and the insert are two statements with a window
 *    between them, and two operators running the same class list at the same moment both find
 *    nobody and both write. The partial unique index decides instead, under a row lock it takes
 *    itself, which is the same argument `rooms.ts` gives for letting the seating index decide who
 *    got the chair. Zero rows back means somebody else's row is there.
 * 3. **Audit.** Inside the caller's transaction, so it cannot be separated from the row.
 *
 * ## Why `already_enrolled` is not an error
 *
 * Re-running a class list is the normal way an operator recovers from a half-finished run, a lost
 * terminal or a list they were not sure had been applied. Making that throw would make the safe
 * action look like a failure, and the CLI would need to distinguish a duplicate from a real fault
 * by parsing a message.
 */
export async function grant(sql: Db, input: GrantInput): Promise<GrantOutcome> {
  requireTransaction(sql, 'grant');
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
    // The slot is held by an enrolment that is not expired, so it is live or not yet started.
    // Read it back to say which, rather than telling the operator only that something is there.
    const existing = await sql<{ id: string }[]>`
      select id from prl.enrolments
       where cohort_id = ${input.cohortId} and user_id = ${input.userId} and revoked_at is null
    `;
    const held = existing[0];
    if (held === undefined) {
      // Nothing inserted and nothing in the way. This WAS reachable, and the claim that it was
      // not is why it read as an assertion: `on conflict do nothing` takes no lock on the row it
      // conflicted with, so a concurrent `revoke` could commit in the gap and empty the slot the
      // insert had just been refused for. `lockLearner` above is what makes it unreachable now —
      // no other transaction can be revoking this learner while we hold their row.
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
  /** On whose authority the entitlement is withdrawn. */
  readonly revokedBy: string;
  /** Why. Required by the schema, and it is the column that is worth most six months later. */
  readonly reason: string;
}

/**
 * Withdraws an entitlement. An UPDATE, never a delete.
 *
 * The row stays with `revoked_at`, `revoked_by` and `revoked_reason` set, which is what makes
 * "was their access withdrawn, when, and why?" answerable at all — and the partial unique index is
 * what makes a later re-grant possible in spite of it. `prl_app` holds no DELETE on this table, so
 * a delete is not merely discouraged here; it is not available to the request path even if
 * somebody wrote one.
 *
 * Returns null when there was no unrevoked enrolment to withdraw. Not an error, for the same
 * reason `deleteAccount` returns null for an account that is already gone: an operator re-running
 * a withdrawal should reach "there is nothing to withdraw" rather than a failure.
 */
export async function revoke(sql: Db, input: RevokeInput): Promise<EnrolmentRecord | null> {
  requireTransaction(sql, 'revoke');
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
 * Serialises every write about one learner's entitlements on the learner's own row.
 *
 * ############################################################################
 * ## THE PARTIAL UNIQUE INDEX DECIDES WHO HOLDS THE SLOT. IT DOES NOT MAKE  ##
 * ## `grant` AND `revoke` SERIALISABLE AGAINST EACH OTHER.                  ##
 * ############################################################################
 *
 * Both writes are check-then-act spread over more than one statement, and under READ COMMITTED
 * each statement takes its own snapshot. Two interleavings were reproduced against a real
 * PostgreSQL 16 with two operator sessions, and neither is equivalent to running the two commands
 * in either order:
 *
 *   * **A revocation that withdrew nothing and said so.** The learner held an EXPIRED, unrevoked
 *     enrolment. Operator A ran `grant`, whose supersede closed that row out and whose insert
 *     wrote a fresh unbounded one. Operator B ran `revoke` and blocked on the supersede's row
 *     lock. When A committed, B's `UPDATE ... where revoked_at is null` re-checked the tuple it
 *     had waited for — now revoked — and matched nothing; A's new row was inserted after B's
 *     statement snapshot, so it was a phantom B could not see. `revoke` returned null, the CLI
 *     told the operator there was nothing to withdraw, and `entitlementFor` still answered
 *     ENTITLED, with no expiry at all. Withdrawal is the one operation here whose failure has to
 *     be loud, and this one was silent in the direction that keeps somebody in.
 *   * **`grant` reaching its own "this cannot happen" branch.** `on conflict do nothing` takes no
 *     lock on the row it conflicted with, so a concurrent `revoke` can commit between the insert
 *     and the read-back that explains the refusal. The read-back then finds no unrevoked row and
 *     throws `internal_error` — aborting the operator's whole transaction, which on the bulk path
 *     is the other twenty-nine grants in the same class list.
 *
 * `prl.users` is the anchor rather than an advisory lock because the row already exists, because
 * it is the same row `deleteAccount` and `deleteAbandonedGuest` take `FOR UPDATE` on — so an
 * erasure and a grant serialise too, in the same lock order, with no new deadlock cycle — and
 * because a lock on a row survives in exactly the scope a transaction does. Cost: two operator
 * commands touching one learner run one after the other. This is a CLI with a class of thirty.
 *
 * A learner that does not exist returns no row and is deliberately not an error here: `grant`'s
 * foreign key already refuses it with a message about the reference that is wrong, and `revoke`
 * for an unknown account must reach "there is nothing to withdraw" rather than a fault.
 *
 * ## Why `clock_timestamp()` writes `revoked_at`, and why the lock made that necessary
 *
 * `now()` is `transaction_timestamp()`. Once these writes queue behind each other, the waiting
 * transaction's `now()` is older than the grant it is waiting for — so `revoked_at` lands BEFORE
 * `granted_at` and `enrolments_revoked_after_grant` refuses the update with a raw 23514 that
 * nothing here maps. Reproduced without the lock as well, with a transaction opened 400 ms before
 * the grant it then withdrew; adding the lock turns that from a race into the ordinary case, which
 * is why the two changes ship together. `clock_timestamp()` is the instant the statement actually
 * ran, which is after every commit this transaction can see, and it is a truer record of when the
 * withdrawal happened than the moment the operator's transaction opened.
 */
async function lockLearner(sql: Db, userId: string): Promise<void> {
  await sql`select id from prl.users where id = ${userId} for update`;
}

/**
 * Refuses a pool handle.
 *
 * `Db` is `Sql | TransactionSql`, and on the pool each statement commits alone — so a failure
 * between the row and its audit entry would leave exactly the half-written state the file header
 * says must not exist. `TransactionSql` declares `savepoint` and `Sql` does not, which is the same
 * narrowing `insideSavepoint` and `deleteAccount` use.
 */
function requireTransaction(sql: Db, what: string): void {
  if (!('savepoint' in sql)) {
    throw new AppError('internal_error', {
      logDetail:
        `${what} was given a pool handle; it must run inside a transaction so that the ` +
        'enrolment row and its audit entry cannot land separately',
    });
  }
}
