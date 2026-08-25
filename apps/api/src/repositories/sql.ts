/**
 * The driver seam every repository shares: the handle type they take as a first argument,
 * and the translation from a PostgreSQL integrity error into an `ErrorCode`.
 *
 * ## Why the handle is a parameter and never an import
 *
 * `postgres.Sql` and `postgres.TransactionSql` are siblings in the driver's types — the
 * transaction handle does NOT extend the pool handle — so a repository that wanted to work
 * both inside and outside `withTransaction` would otherwise need two overloads each. `Db`
 * is the union, declared once, and every repository function takes it first. That is the
 * whole reason any of them composes inside `withTransaction(tx => ...)`.
 *
 * ## Why violations are translated rather than prevented
 *
 * Two players tapping "sit in seat 3" at the same instant both pass every application-level
 * check: the check and the write are two statements and the race lives between them. The
 * partial unique indexes in `db/migrations/0002_indexes_and_constraints.sql` close that
 * window in one statement, which means the loser learns about it as a thrown Postgres error.
 * Letting that error reach the generic handler would answer a perfectly ordinary race with
 * `internal_error` and a 500. Translating it here answers `seat_taken` with a 409, which is
 * both true and actionable.
 *
 * The map is deliberately short. A constraint that is not in it is one nobody has reasoned
 * about, and the right answer for that is a loud 500 with the whole error in the log — not a
 * plausible-looking 4xx that hides a bug.
 *
 * ## Why the error is read structurally instead of with `instanceof`
 *
 * `postgres.PostgresError` is a class exported by the driver. In a pnpm workspace it is
 * entirely possible to end up with two resolved copies of `postgres`, at which point
 * `instanceof` silently stops matching and every 409 in this file quietly becomes a 500.
 * Reading `code` and `constraint_name` off an unknown object cannot break that way.
 */

import type { ErrorCode } from '@prl/contracts';
import type { Sql, TransactionSql } from '../db.ts';
import { AppError } from '../errors.ts';

/**
 * The handle a repository function takes as its first argument: the pool, or a transaction.
 *
 * Repositories never call `getSql()` themselves. Passing the handle in is what lets a route
 * compose several of them into one atomic unit, and what lets a test run each case inside a
 * transaction it rolls back afterwards.
 */
export type Db = Sql | TransactionSql;

/**
 * Runs `fn` so that a failing statement inside it does not poison an enclosing transaction.
 *
 * ############################################################################
 * ## A TRANSLATED VIOLATION STILL LEAVES THE TRANSACTION ABORTED            ##
 * ############################################################################
 *
 * This is the one thing about `violationError` that is not obvious and will bite somebody. Catching
 * a unique violation and turning it into `seat_taken` recovers the *error*; it does not recover the
 * *transaction*. Postgres aborts a transaction on any failed statement, and every statement after
 * it answers `25P02 current transaction is aborted, commands ignored until end of transaction
 * block`. So this, inside `withTransaction`, does not work:
 *
 * ```ts
 * for (const bot of bots) {
 *   try { await rooms.addMember(tx, bot); } catch { continue; }   // BROKEN
 * }
 * ```
 *
 * The first conflict kills the transaction and every later statement fails for an unrelated reason.
 *
 * Most callers do not care, and that is why this is not applied everywhere: a route that catches
 * `seat_taken` answers 409 and abandons the transaction anyway, and a savepoint per statement would
 * be a wasted round trip on the hot path. It matters only where the code genuinely intends to
 * continue — the invite-code retry in `rooms.create` — and there it is mandatory.
 *
 * `'savepoint' in handle` narrows the union: `TransactionSql` declares it and `Sql` does not. On the
 * pool there is no transaction to protect and `fn` runs directly, which is both correct and one
 * fewer round trip.
 */
export async function insideSavepoint<T>(handle: Db, fn: (handle: Db) => Promise<T>): Promise<T> {
  if (!('savepoint' in handle)) return fn(handle);
  // Boxed for the same reason `withTransaction` in `db.ts` boxes: postgres.js types `savepoint` as
  // `UnwrapPromiseArray<T>`, so a callback returning an array would come back with a different type
  // from one returning a row. Wrapping makes the return type unconditionally `T`.
  const boxed = await handle.savepoint(async (sp) => ({ value: await fn(sp) }));
  return boxed.value;
}

/**
 * SQLSTATE classes this layer reacts to. Spelled out rather than inlined so a query that
 * catches "unique violation" says so in words.
 */
export const SQL_STATE = {
  notNullViolation: '23502',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
  exclusionViolation: '23P01',
} as const;

/** The fields of a Postgres error this module reads. Everything else stays in the log. */
export interface SqlViolation {
  readonly sqlState: string;
  /** The constraint or index name, or `''` when the server did not name one. */
  readonly constraint: string;
  readonly table: string;
}

function stringField(source: object, key: string): string {
  const value: unknown = Reflect.get(source, key);
  return typeof value === 'string' ? value : '';
}

/**
 * Reads the integrity-error fields off whatever was thrown, or null when it is not one.
 *
 * `Reflect.get` rather than a cast: these properties are assigned onto the error by the
 * driver (`Object.assign(this, x)` in its `errors.js`), so they genuinely are own
 * properties of an object of unknown shape, and reading them that way needs no `any`.
 */
export function sqlViolation(error: unknown): SqlViolation | null {
  if (typeof error !== 'object' || error === null) return null;
  const sqlState = stringField(error, 'code');
  // Every integrity violation is in class 23. Connection failures, syntax errors and the
  // driver's own generic errors also carry a `code`, and none of them belongs here.
  if (!sqlState.startsWith('23')) return null;
  return {
    sqlState,
    constraint: stringField(error, 'constraint_name'),
    table: stringField(error, 'table_name'),
  };
}

/** True when `error` is a unique violation, optionally of one named index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const violation = sqlViolation(error);
  if (violation === null || violation.sqlState !== SQL_STATE.uniqueViolation) return false;
  return constraint === undefined || violation.constraint === constraint;
}

/** True when `error` is a check violation, optionally of one named constraint. */
export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const violation = sqlViolation(error);
  if (violation === null || violation.sqlState !== SQL_STATE.checkViolation) return false;
  return constraint === undefined || violation.constraint === constraint;
}

/**
 * True when `error` is a foreign-key violation, optionally of one named constraint.
 *
 * The predicate a caller needs because `VIOLATION_CODES` deliberately carries no foreign key:
 * see the note above it. The statement that raised the error is what decides what the violation
 * means, and only the call site knows the statement.
 *
 * The concrete case this exists for: `deleteAccount` in `users.ts`. Nine foreign keys reference
 * `prl.users`, and two of them were `ON DELETE RESTRICT` before migration 0004 — so on a database
 * that has not had it applied, deleting an account raises 23503 and the honest answer is
 * `account_deletion_blocked` rather than a 500 that leaves a learner unable to tell whether their
 * record still exists.
 */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const violation = sqlViolation(error);
  if (violation === null || violation.sqlState !== SQL_STATE.foreignKeyViolation) return false;
  return constraint === undefined || violation.constraint === constraint;
}

/**
 * Serialises a value for a `jsonb` parameter, refusing the one thing `jsonb` cannot hold.
 *
 * ############################################################################
 * ## ALWAYS WRITE `${jsonbText(x, 'field')}::text::jsonb`. NOT `::jsonb`.   ##
 * ############################################################################
 *
 * The double cast is not redundant, and getting it wrong does not fail — it writes the wrong data.
 * postgres.js reads the `::type` suffix that follows a placeholder and uses it to **type the
 * parameter**, so `${'{"a":1}'}::jsonb` tells the driver "this parameter is jsonb", and the driver
 * JSON-encodes the JavaScript string it was given. The row ends up holding the jsonb *string*
 * `"{\"a\":1}"` rather than the object `{"a": 1}`:
 *
 *     select jsonb_typeof(${text}::jsonb)          -- 'string'   WRONG, and silent
 *     select jsonb_typeof(${text}::json::jsonb)    -- 'string'   also wrong
 *     select jsonb_typeof(${text}::text::jsonb)    -- 'object'   correct
 *
 * `::text` first types the parameter as text, so the server parses it. This was found by a test —
 * every `jsonb_typeof(...) = 'object'` CHECK in the schema rejected the write — and those CHECKs
 * are the only reason it was found at all. On `prl.hands.board`, which has no type CHECK, the same
 * mistake would have written a string into a card array and been discovered by whatever tried to
 * read it back weeks later.
 *
 * The other reason to serialise here rather than call the driver's `sql.json()`: `jsonb` cannot
 * store a NUL character. Postgres raises "unsupported Unicode escape sequence" for one inside a
 * string, and the failure surfaces as an opaque 500 from whatever wrote it. `JSON.stringify`
 * renders a NUL as the six-character escape backslash-u-0-0-0-0, so it is cheap to find and refuse
 * here, with a message naming the field. (The escape is spelled out in words on purpose: `pnpm run
 * security:hygiene` rejects a literal control character in source, which is the same problem one
 * step earlier.)
 *
 * Throws `invalid_request` rather than `internal_error`, because for the two callers that pass
 * caller-influenced data — a quiz answer, an audit detail — a NUL in the input is a bad request
 * and not a server fault.
 */
export function jsonbText(value: unknown, field: string): string {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') {
    throw new AppError('invalid_request', {
      fields: { [field]: 'is not serialisable as JSON' },
      logDetail: `${field} could not be serialised to jsonb`,
    });
  }
  if (text.includes('\\u0000')) {
    throw new AppError('invalid_request', {
      fields: { [field]: 'must not contain a NUL character' },
      logDetail: `${field} contained a NUL, which jsonb cannot store`,
    });
  }
  return text;
}

/**
 * Constraint name to wire code.
 *
 * Read this as a list of races and mistakes the API has an honest answer for:
 *
 * - `room_members_live_seat_key` — somebody else took the seat between the check and the
 *   write. `seat_taken`, 409.
 * - `room_members_live_user_key` — a double-tapped join. `already_seated`, 409, and
 *   emphatically not a duplicate row: one learner acting out of two seats is a cheat.
 * - `hand_actions_hand_sequence_key` — two actions claimed the same sequence, so one of
 *   them was decided against a view of the hand that no longer exists.
 * - `hands_room_hand_number_key` — two deals raced for the same hand number in one room.
 *   From the loser's point of view the table moved on while they were asking, which is
 *   exactly what `stale_action_sequence` says.
 * - `room_members_stack_non_negative` — an adjustment tried to take a seat below zero.
 *   `insufficient_units`, which is also the only place in this product where a chip count
 *   can refuse anything.
 * - the `rooms_*` and `users_display_name_shape` checks — a table configuration or a name
 *   the schema refuses. The repositories validate these before writing, so reaching one is
 *   a caller bug; `invalid_request` still beats a 500, and the log line names the
 *   constraint.
 *
 * ## No foreign key is in this table, and that is not an oversight
 *
 * A constraint name is enough to decide the answer for a unique or a check violation: there
 * is one way to break `room_members_live_seat_key`, and it means one thing. A foreign key is
 * not like that, because the SAME constraint fires from both ends. `room_members_user_id_fkey`
 * refuses an INSERT naming a user who does not exist — a caller bug, and a loud 500 — and it
 * also refuses a DELETE of a user who still has a seat, which under `ON DELETE RESTRICT` is
 * `account_deletion_blocked`. One name, two truthful answers, and this table can only give
 * one. Mapping it here would make every mis-wired insert tell the caller their account could
 * not be deleted, which is the wrong-reason failure this file exists to prevent.
 *
 * So foreign keys are decided at the call site, where the statement is known, with
 * `isForeignKeyViolation` below. `repositories/users.ts` is the only caller today.
 *
 * Deliberately absent: `sessions_token_hash_key`, `rooms_invite_code_hash_key` and
 * `hand_seats_hand_seat_key`. A digest collision on a freshly generated 256-bit token means
 * the random source is broken, and the migration is explicit that it must fail loudly
 * rather than be smoothed over. `rooms_invite_code_hash_key` is retried by `rooms.create`
 * instead. Also absent: `hand_actions_client_action_id_key`, which is not a failure at all
 * — it is the idempotency guarantee, and `hands.appendAction` reports it as "not applied".
 */
const VIOLATION_CODES: Readonly<Record<string, ErrorCode>> = {
  room_members_live_seat_key: 'seat_taken',
  room_members_live_user_key: 'already_seated',
  hand_actions_hand_sequence_key: 'stale_action_sequence',
  hands_room_hand_number_key: 'stale_action_sequence',
  room_members_stack_non_negative: 'insufficient_units',
  rooms_name_shape: 'invalid_request',
  rooms_max_seats_range: 'invalid_request',
  rooms_small_blind_positive: 'invalid_request',
  rooms_big_blind_positive: 'invalid_request',
  rooms_ante_range: 'invalid_request',
  rooms_starting_stack_positive: 'invalid_request',
  rooms_action_timeout_range: 'invalid_request',
  rooms_big_blind_above_small_blind: 'invalid_request',
  rooms_ante_within_big_blind: 'invalid_request',
  rooms_stack_covers_blinds: 'invalid_request',
  room_members_seat_range: 'invalid_request',
  users_display_name_shape: 'invalid_request',
};

/**
 * The wire code for a violation, or null when nothing in the map covers it.
 *
 * Null is the important half of the return type: it means "let this reach the error handler
 * as `internal_error`", which is the correct answer for a constraint nobody has thought
 * about yet.
 */
export function violationCode(error: unknown): ErrorCode | null {
  const violation = sqlViolation(error);
  if (violation === null || violation.constraint === '') return null;
  return VIOLATION_CODES[violation.constraint] ?? null;
}

/**
 * The `AppError` for a violation, or null when there is no mapping.
 *
 * Every repository catch block in this directory reads:
 *
 * ```ts
 * } catch (error) {
 *   const mapped = violationError(error, 'seating a member');
 *   if (mapped !== null) throw mapped;
 *   throw error;
 * }
 * ```
 *
 * Three lines rather than a one-line `throw translate(error)`, because the untouched rethrow
 * has to be visible. A helper that returned "something to throw" for every input would make
 * it impossible to see, at the call site, that an unrecognised error keeps its identity all
 * the way to the handler in `errors.ts` — which is what gets it logged in full instead of
 * quietly relabelled as a plausible 409.
 *
 * `what` goes to `logDetail`, so the log line says which operation the constraint refused
 * while the client still gets only the contract's message. The constraint name itself reaches
 * the log through `cause`, never through the response: a body naming
 * `room_members_live_seat_key` would be a free schema diagram.
 */
export function violationError(error: unknown, what: string): AppError | null {
  const code = violationCode(error);
  if (code === null) return null;
  const violation = sqlViolation(error);
  const constraint = violation === null ? 'unknown' : violation.constraint;
  return new AppError(code, {
    logDetail: `${what}: refused by database constraint ${constraint}`,
    cause: error,
  });
}
