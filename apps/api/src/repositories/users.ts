/**
 * `prl.users` — the learner. Guests and federated accounts, in one table.
 *
 * A guest is a first-class account here, exactly as the migration says: its own row, its own
 * id, its own progress. Signing in with OIDC later is an upgrade path, never a prerequisite
 * for learning anything.
 *
 * ############################################################################
 * ## THERE IS NO `units` COLUMN, AND THAT IS DELIBERATE                     ##
 * ############################################################################
 *
 * `SessionUser.units`, `ResetUnitsResponse.units` and `ProgressResponse.unitsNetLifetime` are
 * all on the wire, so the obvious reading of "units live on the user" is a `users.units`
 * integer. There is no such column, in this table or any other, and adding one is not an
 * option:
 *
 *   - `db/migrations/0001_initial.sql`, first paragraph: "there is deliberately no balance,
 *     currency, price, purchase, payout, prize or transfer column anywhere in the schema, and
 *     no table that could serve as a ledger of value. Adding one would be a product decision,
 *     not a migration."
 *   - `docs/PRODUCT-GUARDRAILS.md` section 1, under Enforcement: "There is no transfer
 *     endpoint and no schema column that could represent one."
 *
 * So units are **derived**, from the two chip quantities the schema really does hold:
 *
 *   units       = SUM(prl.room_members.stack) over the learner's live memberships,
 *                 or DEFAULT_UNIT_ALLOWANCE when they are not at any table.
 *   netLifetime = SUM(prl.hand_seats.net_result) over their seats in completed hands.
 *
 * That is not a workaround, it is the model the schema describes. A learner's units are the
 * chips in front of them; a learner at no table has the standing allowance, which is what the
 * badge in `docs/frontend-design-system.md` shows. `resetUnits` puts every live seat back to
 * its room's `starting_stack`, which satisfies the guardrail that reset is "always available
 * and never penalised" — and, unlike a reset of a lifetime sum, it is something the runtime
 * role is actually granted the privilege to do (there is no DELETE on `prl.hand_seats`; a
 * played hand is history).
 *
 * The consequence for whoever writes `routes/auth.ts` and `routes/progress.ts`: read units
 * through `readUnits` here rather than expecting a column on the row, and do not add one.
 */

import { randomBytes } from 'node:crypto';
import type { UserKind } from '@prl/contracts';
import { AppError } from '../errors.ts';
import { newUserId } from './ids.ts';
import { revokeAllForUser } from './sessions.ts';
import { type Db, isForeignKeyViolation, sqlViolation, violationError } from './sql.ts';

/**
 * Units a learner has when they are not sitting at any table.
 *
 * 1,000 matches the figure in `docs/frontend-design-system.md`. It is a code constant rather
 * than a row because it is not per-learner state: every learner has the same standing
 * allowance, always, and there is nothing to store.
 */
export const DEFAULT_UNIT_ALLOWANCE = 1_000;

/** Display-name bounds, copied from `users_display_name_shape` in migration 0001. */
const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 24;

/**
 * The columns every read here projects.
 *
 * Written out rather than `select *` so that a column added by a later migration does not
 * silently start crossing this boundary. Snake case, because `db.ts` deliberately does not
 * install postgres.js's camel-case transform — the SQL and the type spell the column the same
 * way, and a typo is a compile error instead of an `undefined`.
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

/** What `readUnits` answers. Both numbers are derived; see the header note. */
export interface UnitsSnapshot {
  /** Chips in front of the learner right now, or the standing allowance. Never negative. */
  readonly units: number;
  /** Chips won minus chips committed across every completed hand. May be negative. */
  readonly netLifetime: number;
}

/**
 * Trims and checks a display name against the database's own rule.
 *
 * `users_display_name_shape` requires 2..24 characters and `display_name = btrim(...)`, so an
 * untrimmed name is a check violation — which would surface as `internal_error` and a 500 for
 * what is really a bad field. Trimming here means the ordinary case just works, and rejecting
 * here means the bad case gets `invalid_request` with the field named.
 *
 * Counted by code point (`[...name].length`) rather than by `String.length`, because Postgres'
 * `char_length` counts characters: a name of 24 astral characters is 24 to the database and 48
 * to `String.length`, and using the wrong one would reject a name the schema accepts.
 *
 * Control characters are rejected rather than stripped. `DISPLAY_NAME_SCHEMA` in the contracts
 * already excludes them at the route boundary; repeating the check here — and refusing instead
 * of silently rewriting — means a name that arrives through some other path cannot end up
 * forging a line in a log viewer, and the learner is told rather than surprised.
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

/**
 * A name for a guest who did not choose one.
 *
 * Six hex characters from the CSPRNG, so two guests in the same second are still told apart in
 * a room list. Deliberately not a counter and not a sequence: "Guest 41" tells everyone how
 * many guests there have been.
 */
export function defaultGuestDisplayName(): string {
  return `Guest ${randomBytes(3).toString('hex').toUpperCase()}`;
}

export interface CreateGuestInput {
  /** Optional; a name is generated when absent. Trimmed and checked either way. */
  readonly displayName?: string;
}

/**
 * Creates a guest account.
 *
 * `kind = 'guest'` with both OIDC columns NULL, which is the only combination
 * `users_kind_matches_identity` permits for a guest. The check exists because "both null or
 * both set" would allow a row claiming `kind = 'oidc'` with no issuer — a row no
 * authentication lookup would ever find and no code path would ever notice.
 */
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
  /** Used only when the account is being created. An existing name is never overwritten. */
  readonly displayName: string;
}

export interface FindOrCreateOidcResult {
  readonly user: UserRow;
  /** True when this call created the account, false when it matched an existing one. */
  readonly created: boolean;
}

/**
 * Finds the account for an issuer and subject, creating it on first sign-in.
 *
 * ## One statement, and why that matters
 *
 * The obvious version is SELECT, then INSERT if nothing came back. Two concurrent first
 * sign-ins both select nothing, both insert, and one of them gets a unique violation and a
 * 500 on what should be an ordinary login. `ON CONFLICT ... DO UPDATE` has no such window:
 * whichever transaction arrives second finds the conflict and updates instead, and both get a
 * row back.
 *
 * The conflict target repeats the index predicate — `where oidc_issuer is not null and
 * oidc_subject is not null` — because `users_oidc_identity_key` is a *partial* unique index
 * and Postgres will only infer a partial index when the statement restates its predicate.
 * Without it this raises "no unique or exclusion constraint matching the ON CONFLICT
 * specification" at runtime, which is a query that typechecks and never works.
 *
 * ## How `created` is known without an `xmax` trick
 *
 * The id is minted before the statement runs, and `DO UPDATE` returns the *existing* row when
 * it conflicts. So the returned id equals the minted one exactly when this call did the
 * insert. No `xmax = 0` folklore, no second query, no guessing from timestamps.
 *
 * ## What the update deliberately does not touch
 *
 * `display_name`. A learner may have renamed themselves here, and letting the identity
 * provider's `name` claim overwrite that on every sign-in would silently undo their choice.
 * Only `last_seen_at` moves (and `updated_at`, via the trigger).
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

/** One account by id, or null. */
export async function byId(sql: Db, userId: string): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    select id, kind, display_name, oidc_issuer, oidc_subject, last_seen_at, created_at
      from prl.users
     where id = ${userId}
  `;
  return rows[0] ?? null;
}

/**
 * Marks the account as seen now.
 *
 * Used by the guest reaper's counterpart: `users_guest_last_seen_idx` exists so that "which
 * guest accounts have not been seen since <cutoff>" is an index scan, and this is what keeps
 * an active learner out of that answer. Returns false when the id does not exist, which lets a
 * caller notice a session pointing at a deleted account instead of assuming the write landed.
 */
export async function touchLastSeen(sql: Db, userId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update prl.users set last_seen_at = now() where id = ${userId} returning id
  `;
  return rows.length > 0;
}

/**
 * Renames an account.
 *
 * Not in the original brief, and included because `users` is granted UPDATE for exactly this
 * ("sign-up, rename, guest sweep" in the grant matrix) and because a guest who wants a name
 * after the fact has no other path to one.
 */
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

// ---------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------

/**
 * What an account deletion actually did, counted table by table.
 *
 * Returned rather than assumed. Every figure below is read back from the database AFTER the
 * delete has run, inside the same transaction, so this is a report on the state that is about to
 * be committed and not a prediction made before it. That matters because most of the work is done
 * by referential actions rather than by statements in this function: `deleteAccount` issues one
 * DELETE and PostgreSQL decides what happens to the other seven tables. A summary composed from
 * what the code intended would be exactly as wrong as the schema, and it is the schema that was
 * wrong before migration 0004.
 */
export interface AccountDeletionSummary {
  /** The account that went. Kept so a caller logging this cannot attribute it to the wrong id. */
  readonly userId: string;
  /**
   * Sessions explicitly revoked before the row was removed.
   *
   * Always equal to the number of LIVE sessions, which is at most `deleted.sessions` — the rest
   * were already revoked or expired. See the note on the revocation step for why it happens at
   * all when the rows are about to be deleted anyway.
   */
  readonly sessionsRevoked: number;
  /** Tables this learner created, closed before their ownership was detached. */
  readonly roomsClosed: number;
  /** Rows that no longer exist. Each described this learner and nobody else. */
  readonly deleted: {
    readonly sessions: number;
    readonly lessonsCompleted: number;
    readonly quizAttempts: number;
    readonly scenarioAttempts: number;
    readonly roomMemberships: number;
  };
  /** Rows that still exist and no longer name this learner. */
  readonly anonymised: {
    readonly handSeats: number;
    readonly auditEvents: number;
    readonly roomsCreated: number;
  };
}

/** The `::int` casts are the same precaution `readUnits` documents: `count(*)` is a bigint. */
interface AccountFootprintRow {
  readonly sessions: number;
  readonly lesson_progress: number;
  readonly quiz_attempts: number;
  readonly scenario_attempts: number;
  readonly room_members: number;
  readonly hand_seats: number;
  readonly audit_events: number;
  readonly rooms_owned: number;
}

/**
 * Counts every row in the schema that names this learner.
 *
 * One statement rather than eight round trips, and one shape used both before the delete (to
 * report what went) and after it (to prove it went). Sharing the query is what makes the second
 * call a real check: a table the first call forgot would be missing from both, and a table added
 * to the count later is checked automatically.
 */
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
      (select count(*) from prl.rooms  where owner_user_id = ${userId})::int as rooms_owned
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new AppError('internal_error', { logDetail: 'account footprint aggregate returned no row' });
  }
  return row;
}

/**
 * Erases an account: the learner's own record goes, everybody else's record of them survives with
 * their identity detached.
 *
 * ## The policy, because a reader here should not have to open the migration
 *
 *   REMOVED     `prl.sessions`, `prl.lesson_progress`, `prl.quiz_attempts`,
 *               `prl.scenario_attempts` and `prl.room_members` — every seat at every table, live
 *               or long departed.
 *   DETACHED    `prl.hand_seats.user_id`, `prl.audit_log.user_id` and
 *               `prl.rooms.owner_user_id` become NULL. The hand, its actions, its board, its
 *               commitment root and its reveal proofs are untouched.
 *   KEPT        every hand, in full. A hand is a shared record: the other seats are other
 *               people's history, and `prl.hands` cascades from `prl.rooms`, so destroying either
 *               would edit records that are not this learner's to destroy.
 *
 * `db/migrations/0004_account_deletion.sql` is where that is argued at length, including why
 * `rooms.owner_user_id` is SET NULL rather than CASCADE (the latter would delete other players'
 * hands) or RESTRICT (which is what made this operation impossible in the first place).
 *
 * ## Almost none of the work is in this function, deliberately
 *
 * Five of the eight foreign keys referencing `prl.users` do their half by themselves — four
 * CASCADE, three SET NULL — and PostgreSQL executes a referential action with the CONSTRAINT
 * owner's privileges rather than the connected role's. So the erasure removes rows from tables
 * `prl_app` holds no DELETE on (`prl.quiz_attempts`, `prl.scenario_attempts`, `prl.room_members`)
 * and nulls a column in a table it holds no UPDATE on (`prl.audit_log`) without any of those
 * grants being made. Writing the deletes out by hand here would have required exactly those
 * grants, and would then have let any other request path remove any other learner's rows.
 *
 * The consequence is that the schema, not this function, decides what erasure means — which is
 * why the summary is verified rather than composed, and why
 * `apps/api/scripts/verify-schema.mjs` check 9 asserts the eight referential actions.
 *
 * ## Why it insists on a transaction handle
 *
 * `Db` is `Sql | TransactionSql`, and on the pool each statement below would commit on its own:
 * a failure between the room closures and the DELETE would leave a learner whose tables are shut
 * and whose account still exists, with no record anywhere of a half-finished erasure. There is no
 * partial state that is acceptable here, so the handle is checked rather than trusted. The test
 * for it is the same one `insideSavepoint` uses in `sql.ts`: `TransactionSql` declares
 * `savepoint`, `Sql` does not.
 *
 * Returns null when the id names no account. Not an error: a client retrying a deletion whose
 * response it never saw should be able to reach "there is no such account" rather than a failure.
 */
export async function deleteAccount(sql: Db, userId: string): Promise<AccountDeletionSummary | null> {
  if (!('savepoint' in sql)) {
    throw new AppError('internal_error', {
      logDetail: 'deleteAccount was given a pool handle; it must run inside withTransaction',
    });
  }

  // `for update` rather than a bare select. Two deletions of the same account racing would
  // otherwise both count a full footprint and both report having removed everything, and a
  // deletion racing a hand settlement would count rows the other transaction is still writing.
  // The lock is taken on the account row, which every statement below is reached through.
  const locked = await sql<{ id: string }[]>`
    select id from prl.users where id = ${userId} for update
  `;
  if (locked[0] === undefined) return null;

  const before = await accountFootprint(sql, userId);

  // Closed BEFORE the delete, while `owner_user_id` still says who these tables belong to.
  //
  // A room whose owner has been erased has no owner and no way to acquire one: `rooms.close`
  // authorises on `owner_user_id`, and nothing in the product transfers ownership. Left open, it
  // would stay joinable by its invite code for ever with nobody able to shut it. Closing it is
  // also what keeps a NULL owner off the live-table wire, since a closed room is never re-opened.
  const closed = await sql<{ id: string }[]>`
    update prl.rooms
       set status = 'closed', closed_at = now()
     where owner_user_id = ${userId}
       and status <> 'closed'
    returning id
  `;

  // Unconditional, and not made redundant by the CASCADE that is about to remove these rows.
  // Two reasons. The revocation is what makes the sessions unusable at the instant this
  // transaction commits, whatever a later migration decides `sessions` should do on delete. And
  // it leaves `revoked_at` set on the rows for however long the delete takes, so a concurrent
  // request that resolved a token a moment ago cannot slide its expiry against a row that is
  // about to stop existing.
  const sessionsRevoked = await revokeAllForUser(sql, userId);

  try {
    await sql`delete from prl.users where id = ${userId}`;
  } catch (error) {
    // A foreign-key violation on THIS statement can only mean one thing: some table still holds
    // the account back, which is what `ON DELETE RESTRICT` on `prl.rooms.owner_user_id` and
    // `prl.room_members.user_id` did before migration 0004 and what a ninth reference added
    // without a clause would do again. It is decided here rather than in `VIOLATION_CODES`
    // because the same constraint names also refuse an INSERT that points at a user who does not
    // exist, and that is a caller bug with a completely different answer.
    if (isForeignKeyViolation(error)) {
      // The constraint name goes to the log and never to the client, for the reason
      // `violationError` states: a body naming a constraint is a free schema diagram.
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

  // The verification, and the reason the summary is worth anything. Reading the same counts back
  // proves the referential actions did what the policy says they do, rather than assuming it —
  // and it fails INSIDE the transaction, so a schema that half-erased an account rolls the whole
  // thing back instead of reporting a deletion that did not happen.
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
    },
    anonymised: {
      handSeats: before.hand_seats,
      auditEvents: before.audit_events,
      roomsCreated: before.rooms_owned,
    },
  };
}

// ---------------------------------------------------------------------------
// Units — derived, for the reason set out at the top of this file
// ---------------------------------------------------------------------------

interface UnitsRow {
  readonly live_stack: number | null;
  readonly net_lifetime: number;
}

/**
 * The learner's units, in one query.
 *
 * `live_stack` is NULL rather than 0 when the learner has no live membership, which is the
 * distinction that makes the fallback correct: a learner at no table gets the standing
 * allowance, while a learner who is at a table and has been felted gets 0, and those must not
 * look the same. `filter (where ...)` on the sum would have collapsed them.
 *
 * `net_lifetime` counts only completed hands. A hand in progress has `net_result` NULL by
 * design — the migration is explicit that writing a placeholder 0 would make an unfinished
 * hand indistinguishable from a break-even one — so there is nothing to add for it anyway,
 * and joining on `completed_at is not null` says so out loud.
 *
 * Both sums are cast to `int` because Postgres widens `sum(int)` to `bigint`, which
 * postgres.js hands back as a *string* to avoid losing precision. A units figure that is
 * sometimes a number and sometimes "1000" is a bug waiting in the JSON response.
 */
export async function readUnits(sql: Db, userId: string): Promise<UnitsSnapshot> {
  const rows = await sql<UnitsRow[]>`
    select
      (select sum(m.stack)::int
         from prl.room_members m
        where m.user_id = ${userId} and m.left_at is null) as live_stack,
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
 * Puts every seat the learner currently occupies back to its room's starting stack.
 *
 * This is the reset the guardrails promise: always available, never penalised, and it asks no
 * questions about how the stack got low. Closed rooms are excluded because their stacks are
 * history now, and a reset that rewrote a finished table's numbers would be editing the
 * record.
 *
 * What it deliberately does not do is touch `prl.hand_seats.net_result`. Those rows are the
 * hand ledger, the runtime role holds no DELETE on the table, and a reset that erased played
 * hands would be a reset of the learner's own history — which is a different feature with a
 * different consent conversation.
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
  /** Which table's stack moves. Units are per-seat; there is no account-wide pool. */
  readonly roomId: string;
  /** Signed. Negative takes chips off the stack and is the direction that can refuse. */
  readonly delta: number;
}

/**
 * Moves a live seat's stack by `delta`, refusing to take it below zero.
 *
 * ## The guard is in the WHERE clause, not in JavaScript
 *
 * Read-then-check-then-write leaves a window: two concurrent debits both read 100, both decide
 * -60 is fine, and the seat ends at -20. `where m.stack + ${delta} >= 0` is evaluated against
 * the row the UPDATE actually locks, so the second one sees the first one's result and matches
 * nothing. `room_members_stack_non_negative` is the backstop underneath that, and
 * `violationCode` maps it to `insufficient_units` in case a future caller writes the
 * unguarded version.
 *
 * Returns null when nothing was updated: no live membership, or the adjustment would have gone
 * negative. Those two are deliberately not distinguished here — the caller knows whether the
 * learner is seated, and a repository that returns "you have 40 units, you needed 60" has
 * turned a stack size into a probe.
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
