/**
 * `prl.users`. Guests and federated accounts in one table. A guest is a first-class account.
 *
 * There is no `units` column, and adding one is not an option (`db/migrations/0001_initial.sql`,
 * `docs/PRODUCT-GUARDRAILS.md` section 1). Units are derived by `readUnits` from
 * `prl.room_members.stack` and `prl.hand_seats.net_result`. Read them there.
 */

import { randomBytes } from 'node:crypto';
import type { UserKind } from '@prl/contracts';
import { AppError } from '../errors.ts';
import * as audit from './audit.ts';
import { newUserId } from './ids.ts';
import { revokeAllForUser } from './sessions.ts';
import { type Db, isForeignKeyViolation, sqlViolation, violationError } from './sql.ts';

/** Units at no table. Matches `docs/frontend-design-system.md`, and is the same for every learner. */
export const DEFAULT_UNIT_ALLOWANCE = 1_000;

/** Copied from `users_display_name_shape` in migration 0001. */
const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 24;

/**
 * Columns are listed explicitly, never `select *`, so a new column does not cross this boundary
 * unnoticed. Snake case because `db.ts` installs no camel-case transform.
 */
export interface UserRow {
  readonly id: string;
  readonly kind: UserKind;
  readonly display_name: string;
  readonly oidc_issuer: string | null;
  readonly oidc_subject: string | null;
  readonly last_seen_at: Date;
  readonly created_at: Date;
}

export interface UnitsSnapshot {
  /** Never negative. */
  readonly units: number;
  /** Across completed hands. May be negative. */
  readonly netLifetime: number;
}

/**
 * Trims and checks a display name against `users_display_name_shape`, so a bad name is
 * `invalid_request` instead of a check violation. Counted by code point to match Postgres'
 * `char_length`. Control characters are refused, not stripped, so no path can forge a log line.
 */
export function normaliseDisplayName(raw: string): string {
  const trimmed = raw.trim();
  const length = [...trimmed].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) {
    throw new AppError('invalid_request', {
      fields: { displayName: `must be ${DISPLAY_NAME_MIN} to ${DISPLAY_NAME_MAX} characters` },
      logDetail: `display name length ${length} is outside ${DISPLAY_NAME_MIN}..${DISPLAY_NAME_MAX}`,
    });
  }
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      throw new AppError('invalid_request', {
        fields: { displayName: 'must not contain control characters' },
        logDetail: 'display name contained a control character',
      });
    }
  }
  return trimmed;
}

/** Random, not a counter, because "Guest 41" would reveal how many guests there have been. */
export function defaultGuestDisplayName(): string {
  return `Guest ${randomBytes(3).toString('hex').toUpperCase()}`;
}

export interface CreateGuestInput {
  readonly displayName?: string;
}

/** Both OIDC columns NULL, the only combination `users_kind_matches_identity` permits for a guest. */
export async function createGuest(sql: Db, input: CreateGuestInput = {}): Promise<UserRow> {
  const displayName =
    input.displayName === undefined ? defaultGuestDisplayName() : normaliseDisplayName(input.displayName);
  const id = newUserId();
  try {
    const rows = await sql<UserRow[]>`
      insert into prl.users (id, kind, display_name, oidc_issuer, oidc_subject)
      values (${id}, 'guest', ${displayName}, null, null)
      returning id, kind, display_name, oidc_issuer, oidc_subject, last_seen_at, created_at
    `;
    const row = rows[0];
    if (row === undefined)
      throw new AppError('internal_error', { logDetail: 'guest insert returned no row' });
    return row;
  } catch (error) {
    const mapped = violationError(error, 'creating a guest account');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

export interface FindOrCreateOidcInput {
  readonly issuer: string;
  readonly subject: string;
  /** Used only on creation. An existing name is never overwritten. */
  readonly displayName: string;
}

export interface FindOrCreateOidcResult {
  readonly user: UserRow;
  readonly created: boolean;
}

/**
 * Finds the account for an issuer and subject, creating it on first sign-in.
 *
 * One `ON CONFLICT ... DO UPDATE`, so two concurrent first sign-ins both get a row instead of one
 * hitting a unique violation. The conflict target restates the predicate of the partial index
 * `users_oidc_identity_key`, without which Postgres cannot infer it. `created` is known because the
 * pre-minted id comes back only on insert. `display_name` is not updated, so the provider's name
 * claim never undoes a rename.
 */
export async function findOrCreateOidcUser(
  sql: Db,
  input: FindOrCreateOidcInput,
): Promise<FindOrCreateOidcResult> {
  const displayName = normaliseDisplayName(input.displayName);
  const id = newUserId();
  try {
    const rows = await sql<UserRow[]>`
      insert into prl.users (id, kind, display_name, oidc_issuer, oidc_subject)
      values (${id}, 'oidc', ${displayName}, ${input.issuer}, ${input.subject})
      on conflict (oidc_issuer, oidc_subject) where oidc_issuer is not null and oidc_subject is not null
      do update set last_seen_at = now()
      returning id, kind, display_name, oidc_issuer, oidc_subject, last_seen_at, created_at
    `;
    const row = rows[0];
    if (row === undefined) {
      throw new AppError('internal_error', { logDetail: 'oidc upsert returned no row' });
    }
    return { user: row, created: row.id === id };
  } catch (error) {
    const mapped = violationError(error, 'resolving a federated account');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

export async function byId(sql: Db, userId: string): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    select id, kind, display_name, oidc_issuer, oidc_subject, last_seen_at, created_at
      from prl.users
     where id = ${userId}
  `;
  return rows[0] ?? null;
}

/**
 * Returns false when the id does not exist. This is a retention signal, not the safety check. A
 * live session keeps an account out of the sweep (`abandonedGuestPredicate`), so a lag here cannot
 * cost anybody their account.
 */
export async function touchLastSeen(sql: Db, userId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.users set last_seen_at = now() where id = ${userId} returning id
  `;
  return rows.length > 0;
}

export async function rename(sql: Db, userId: string, displayName: string): Promise<UserRow | null> {
  const name = normaliseDisplayName(displayName);
  try {
    const rows = await sql<UserRow[]>`
      update prl.users
         set display_name = ${name}
       where id = ${userId}
      returning id, kind, display_name, oidc_issuer, oidc_subject, last_seen_at, created_at
    `;
    return rows[0] ?? null;
  } catch (error) {
    const mapped = violationError(error, 'renaming an account');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * What an account deletion did, table by table. Counted from the database and verified after the
 * delete, because referential actions do most of the work.
 */
export interface AccountDeletionSummary {
  readonly userId: string;
  /** Live sessions revoked before the delete. At most `deleted.sessions`. */
  readonly sessionsRevoked: number;
  readonly roomsClosed: number;
  readonly deleted: {
    readonly sessions: number;
    readonly lessonsCompleted: number;
    readonly quizAttempts: number;
    readonly scenarioAttempts: number;
    readonly roomMemberships: number;
    /** Live or withdrawn. Removed by cascade, after `deleteAccount` audits each one. */
    readonly enrolments: number;
  };
  readonly anonymised: {
    readonly handSeats: number;
    readonly auditEvents: number;
    readonly roomsCreated: number;
  };
}

/** `count(*)` is a bigint, hence the `::int` casts. */
interface AccountFootprintRow {
  readonly sessions: number;
  readonly lesson_progress: number;
  readonly quiz_attempts: number;
  readonly scenario_attempts: number;
  readonly room_members: number;
  readonly hand_seats: number;
  readonly audit_events: number;
  readonly rooms_owned: number;
  readonly enrolments: number;
}

/** Every row that names this learner. Used before the delete to report and after it to verify. */
async function accountFootprint(sql: Db, userId: string): Promise<AccountFootprintRow> {
  const rows = await sql<AccountFootprintRow[]>`
    select
      (select count(*) from prl.sessions           where user_id = ${userId})::int as sessions,
      (select count(*) from prl.lesson_progress    where user_id = ${userId})::int as lesson_progress,
      (select count(*) from prl.quiz_attempts      where user_id = ${userId})::int as quiz_attempts,
      (select count(*) from prl.scenario_attempts  where user_id = ${userId})::int as scenario_attempts,
      (select count(*) from prl.room_members       where user_id = ${userId})::int as room_members,
      (select count(*) from prl.hand_seats         where user_id = ${userId})::int as hand_seats,
      (select count(*) from prl.audit_log          where user_id = ${userId})::int as audit_events,
      (select count(*) from prl.rooms  where owner_user_id = ${userId})::int as rooms_owned,
      (select count(*) from prl.enrolments        where user_id = ${userId})::int as enrolments
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('internal_error', { logDetail: 'account footprint aggregate returned no row' });
  }
  return row;
}

/**
 * Erases an account. The learner's own rows go, and other people's records of them survive with
 * the identity detached.
 *
 *   REMOVED   `prl.sessions`, `prl.lesson_progress`, `prl.quiz_attempts`, `prl.scenario_attempts`,
 *             `prl.room_members` and `prl.enrolments`.
 *   DETACHED  `prl.hand_seats.user_id`, `prl.audit_log.user_id` and `prl.rooms.owner_user_id`.
 *   KEPT      every hand in full, because it is other players' history too.
 *
 * Migrations 0004 and 0006 argue the policy. The foreign keys do the work, and referential actions
 * run with the constraint owner's privileges, so `prl_app` needs no DELETE grants that would let a
 * request path remove other learners' rows. `apps/api/scripts/verify-schema.mjs` asserts the
 * referential actions.
 *
 * Requires a transaction handle, because no partial erasure is acceptable. Returns null for an
 * unknown id, so a retried deletion is not a failure.
 */
export async function deleteAccount(sql: Db, userId: string): Promise<AccountDeletionSummary | null> {
  if (!('savepoint' in sql)) {
    throw new AppError('internal_error', {
      logDetail: 'deleteAccount was given a pool handle; it must run inside withTransaction',
    });
  }

  // Serialises racing deletions and settlements on the account row.
  const locked = await sql<{ id: string }[]>`
    select id from prl.users where id = ${userId} for update
  `;
  if (locked[0] === undefined) return null;

  const before = await accountFootprint(sql, userId);

  // Closed before the delete, because an ownerless room can never be closed by anybody.
  const closed = await sql<{ id: string }[]>`
    update prl.rooms
       set status = 'closed', closed_at = now()
     where owner_user_id = ${userId}
       and status <> 'closed'
    returning id
  `;

  // Not redundant with the cascade. It holds whatever a later migration does on delete, and stops
  // a concurrent request sliding an expiry while the delete runs.
  const sessionsRevoked = await revokeAllForUser(sql, userId);

  // A cascade writes nothing, so without this the audit log would show a live entitlement with no
  // end. A distinct event, because erasure is not an operator revocation. Written detached, since
  // `audit_log.user_id` is about to be nulled anyway.
  const ending = await sql<
    {
      id: string;
      cohort_id: string;
      cohort_key: string;
      reference: string;
      granted_by: string;
      was_live: boolean;
    }[]
  >`
    select e.id, e.cohort_id, c.key as cohort_key, e.reference, e.granted_by,
           (e.revoked_at is null) as was_live
      from prl.enrolments e
      join prl.cohorts c on c.id = e.cohort_id
     where e.user_id = ${userId}
     order by e.granted_at
  `;
  for (const enrolment of ending) {
    await audit.record(sql, {
      event: 'enrolment.ended_by_erasure',
      userId: null,
      detail: {
        enrolmentId: enrolment.id,
        cohortId: enrolment.cohort_id,
        cohortKey: enrolment.cohort_key,
        reference: enrolment.reference,
        grantedBy: enrolment.granted_by,
        // A live place ending is the case an operator has to answer for.
        wasLive: enrolment.was_live,
      },
    });
  }

  try {
    await sql`delete from prl.users where id = ${userId}`;
  } catch (error) {
    // Here, a foreign-key violation means a reference without an ON DELETE clause. Not in
    // `VIOLATION_CODES`, because the same constraints also refuse an INSERT for a missing user.
    if (isForeignKeyViolation(error)) {
      // The constraint name goes to the log, never to the client.
      const constraint = sqlViolation(error)?.constraint;
      throw new AppError('account_deletion_blocked', {
        logDetail:
          'deleting an account: the row is still referenced by ' +
          `${constraint === undefined || constraint === '' ? 'an unnamed foreign key' : constraint}`,
        cause: error,
      });
    }
    const mapped = violationError(error, 'deleting an account');
    if (mapped !== null) throw mapped;
    throw error;
  }

  // Fails inside the transaction, so a half-erased account rolls back.
  const after = await accountFootprint(sql, userId);
  const stillPresent = Object.entries(after)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `${table}=${String(count)}`);
  if (stillPresent.length > 0) {
    throw new AppError('internal_error', {
      logDetail: `account erasure left rows behind, so nothing was committed: ${stillPresent.join(', ')}`,
    });
  }

  return {
    userId,
    sessionsRevoked,
    roomsClosed: closed.length,
    deleted: {
      sessions: before.sessions,
      lessonsCompleted: before.lesson_progress,
      quizAttempts: before.quiz_attempts,
      scenarioAttempts: before.scenario_attempts,
      roomMemberships: before.room_members,
      enrolments: before.enrolments,
    },
    anonymised: {
      handSeats: before.hand_seats,
      auditEvents: before.audit_events,
      roomsCreated: before.rooms_owned,
    },
  };
}

/**
 * The definition of "abandoned", interpolated into both the choosing query and the deleting
 * transaction, so the two cannot drift.
 *
 * - `kind = 'guest'`. A federated account can sign in again, so it is never swept. The partial
 *   index `users_guest_last_seen_idx` uses the same predicate.
 * - `last_seen_at`. The caller supplies the cutoff (`maintenance/retention-sweep.ts`).
 * - No live session. This is the safety clause, because `last_seen_at` can lag activity by half the
 *   idle window. If the two disagree, this wins.
 * - No membership, hand seat or owned room. Those rows are other people's records, and whether to
 *   erase them is open with counsel (`docs/production/legal-register.md` §5 L5).
 * - No enrolment of any kind (legal review D9). A class can be enrolled before it opens, and the
 *   cascade would erase an idle student's place. Revoked rows count too. This clause has no index,
 *   which is accepted because `prl.hand_seats` dominates the plan.
 *
 * `deleteAbandonedGuest` must lock the row before re-asking, in a separate statement.
 */
function abandonedGuestPredicate(sql: Db, cutoffSeconds: number) {
  return sql`
        u.kind = 'guest'
    and u.last_seen_at <= now() - (${cutoffSeconds}::int * interval '1 second')
    and not exists (
      select 1
        from prl.sessions s
       where s.user_id = u.id
         and s.revoked_at is null
         and s.expires_at > now()
    )
    and not exists (select 1 from prl.room_members m where m.user_id = u.id)
    and not exists (select 1 from prl.hand_seats  h where h.user_id = u.id)
    and not exists (select 1 from prl.rooms       r where r.owner_user_id = u.id)
    and not exists (select 1 from prl.enrolments  e where e.user_id = u.id)
  `;
}

export interface AbandonedGuestQuery {
  readonly cutoffSeconds: number;
  readonly limit: number;
}

/**
 * Oldest first, bounded by `limit`, as a bounded index scan. Each deletion is its own transaction,
 * so one account that cannot be removed does not roll back or block the rest of the batch.
 */
export async function findAbandonedGuests(sql: Db, query: AbandonedGuestQuery): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select u.id
      from prl.users u
     where ${abandonedGuestPredicate(sql, query.cutoffSeconds)}
     order by u.last_seen_at
     limit ${query.limit}
  `;
  return rows.map((row) => row.id);
}

/**
 * Erases one abandoned guest, or returns null because it is not abandoned after all.
 *
 * Calls `deleteAccount` rather than a bulk DELETE, so the sweep shares its self-verification and the
 * one definition of erasure. The cost is one transaction per account, on a timer off the request
 * path.
 *
 * Lock, then ask. One `select ... where <predicate> for update` answers from the snapshot taken
 * before it blocked. Measured on Postgres 17: it blocked 1,124 ms behind an uncommitted enrolment
 * grant, then returned the account as abandoned anyway, because an INSERT that only locks
 * `prl.users` does not trigger EvalPlanQual. So the lock is a bare statement, and the predicate runs
 * in a new statement with a new snapshot. Requires a transaction handle.
 */
export async function deleteAbandonedGuest(
  sql: Db,
  userId: string,
  cutoffSeconds: number,
): Promise<AccountDeletionSummary | null> {
  if (!('savepoint' in sql)) {
    throw new AppError('internal_error', {
      logDetail: 'deleteAbandonedGuest was given a pool handle; it must run inside a transaction',
    });
  }

  // The lock alone. No predicate here.
  const locked = await sql<{ id: string }[]>`
    select u.id from prl.users u where u.id = ${userId} for update
  `;
  if (locked[0] === undefined) return null;

  // A new statement, so a snapshot taken after the lock was granted.
  const abandoned = await sql<{ id: string }[]>`
    select u.id
      from prl.users u
     where u.id = ${userId}
       and ${abandonedGuestPredicate(sql, cutoffSeconds)}
  `;
  if (abandoned[0] === undefined) return null;

  return deleteAccount(sql, userId);
}

interface UnitsRow {
  readonly live_stack: number | null;
  readonly net_lifetime: number;
}

/**
 * The learner's units, in one query.
 *
 * `live_stack` is NULL with no counted membership, so the allowance applies, while a felted learner
 * reads 0. Closed rooms are excluded, matching `resetUnits`, because their chips cannot be played.
 *
 * Only a membership the learner has sat at counts (`first_seated_at`, written by
 * `rooms.recordFirstSit`), because counting unsat memberships mints a stack per room created. An
 * unsat membership holds exactly `starting_stack`, so nothing is lost. `>=` because inside one test
 * transaction `now()` is one instant.
 *
 * `net_lifetime` counts completed hands only, since an unfinished hand has `net_result` NULL. Sums
 * are cast to `int` because postgres.js returns `bigint` as a string.
 */
export async function readUnits(sql: Db, userId: string): Promise<UnitsSnapshot> {
  const rows = await sql<UnitsRow[]>`
    select
      (select sum(m.stack)::int
         from prl.room_members m
         join prl.rooms r on r.id = m.room_id
        where m.user_id = ${userId}
          and m.left_at is null
          and r.status <> 'closed'
          and (
                m.first_seated_at is not null
                -- The evidence a row carries without that column: one written before migration
                -- 0008, or seated by the previous build between the migration and the API roll.
                or m.seat is not null
                or exists (
                     select 1
                       from prl.hand_seats s
                       join prl.hands h on h.id = s.hand_id
                      where s.user_id = m.user_id
                        and h.room_id = m.room_id
                        and h.started_at >= m.joined_at
                        and s.status <> 'sittingOut'
                   )
              )) as live_stack,
      coalesce(
        (select sum(s.net_result)::int
           from prl.hand_seats s
           join prl.hands h on h.id = s.hand_id
          where s.user_id = ${userId} and h.completed_at is not null),
        0
      ) as net_lifetime
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('internal_error', { logDetail: 'units aggregate returned no row' });
  }
  return {
    units: Math.max(0, row.live_stack ?? DEFAULT_UNIT_ALLOWANCE),
    netLifetime: row.net_lifetime,
  };
}

/**
 * The guardrail reset, always available and never penalised. Closed rooms are history and are left
 * alone. `prl.hand_seats.net_result` is not touched, because played hands are the learner's history.
 */
export async function resetUnits(sql: Db, userId: string): Promise<UnitsSnapshot> {
  await sql`
    update prl.room_members m
       set stack = r.starting_stack
      from prl.rooms r
     where m.room_id = r.id
       and m.user_id = ${userId}
       and m.left_at is null
       and r.status <> 'closed'
       and m.stack <> r.starting_stack
  `;
  return readUnits(sql, userId);
}

export interface AdjustUnitsInput {
  readonly userId: string;
  /** Units are per seat. There is no account-wide pool. */
  readonly roomId: string;
  /** Signed. Only a negative delta can be refused. */
  readonly delta: number;
}

/**
 * Moves a live seat's stack by `delta`, never below zero.
 *
 * The guard is in the WHERE clause, which EvalPlanQual re-checks against the locked row, so two
 * concurrent debits cannot both pass. `room_members_stack_non_negative` is the backstop, mapped to
 * `insufficient_units`. Null covers "not seated" and "would go negative" alike, so the result is not
 * a probe of the stack size.
 */
export async function adjustUnits(sql: Db, input: AdjustUnitsInput): Promise<number | null> {
  if (!Number.isSafeInteger(input.delta)) {
    throw new AppError('invalid_request', {
      fields: { delta: 'must be a whole number of units' },
      logDetail: `unit adjustment was not an integer: ${String(input.delta)}`,
    });
  }
  try {
    const rows = await sql<{ stack: number }[]>`
      update prl.room_members m
         set stack = m.stack + ${input.delta}
       where m.room_id = ${input.roomId}
         and m.user_id = ${input.userId}
         and m.left_at is null
         and m.stack + ${input.delta} >= 0
      returning m.stack
    `;
    return rows[0]?.stack ?? null;
  } catch (error) {
    const mapped = violationError(error, 'adjusting a seat stack');
    if (mapped !== null) throw mapped;
    throw error;
  }
}
