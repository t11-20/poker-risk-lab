/**
 * The handle type every repository takes first, and the translation from a PostgreSQL integrity error
 * into an `ErrorCode`. `Db` is a union because the driver's transaction handle does not extend the
 * pool handle. A race that passes every application check is closed by a unique index, and the loser
 * gets a 409 here instead of a 500. Errors are read structurally, not with `instanceof`, because two
 * resolved copies of `postgres` in the workspace would make `instanceof` silently stop matching.
 */

import type { ErrorCode } from '@prl/contracts';
import type { Sql, TransactionSql } from '../db.ts';
import { AppError } from '../errors.ts';

/** The pool or a transaction. Repositories never call `getSql()`, so a route can compose them atomically. */
export type Db = Sql | TransactionSql;

/** `TransactionSql` declares `savepoint` and `Sql` does not. */
export function isTransaction(handle: Db): handle is TransactionSql {
  return 'savepoint' in handle;
}

/** For writes that must not commit one statement at a time, which is what the pool does. */
export function requireTransaction(
  handle: Db,
  what: string,
  inside = 'a transaction',
): asserts handle is TransactionSql {
  if (!isTransaction(handle)) {
    throw new AppError('internal_error', {
      logDetail: `${what} was given a pool handle; it must run inside ${inside}`,
    });
  }
}

/**
 * Runs `fn` in a savepoint so a failing statement does not abort an enclosing transaction.
 *
 * Translating a violation recovers the error, not the transaction. After any failed statement
 * Postgres answers `25P02` to everything else in the transaction. Use this wherever code catches a
 * violation and continues (the invite-code retry in `rooms.create`). A route that answers 409 abandons
 * the transaction anyway and does not need it. On the pool there is no transaction, so `fn` runs directly.
 */
export async function insideSavepoint<T>(handle: Db, fn: (handle: Db) => Promise<T>): Promise<T> {
  if (!isTransaction(handle)) return fn(handle);
  // Boxed because postgres.js types `savepoint` as `UnwrapPromiseArray<T>`, as in `withTransaction`.
  const boxed = await handle.savepoint(async (sp) => ({ value: await fn(sp) }));
  return boxed.value;
}

export const SQL_STATE = {
  notNullViolation: '23502',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
  exclusionViolation: '23P01',
} as const;

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

/** The integrity-error fields of whatever was thrown, or null when it is not an integrity error. */
export function sqlViolation(error: unknown): SqlViolation | null {
  if (typeof error !== 'object' || error === null) return null;
  const sqlState = stringField(error, 'code');
  // Integrity violations are class 23. Connection and syntax errors also carry a `code`.
  if (!sqlState.startsWith('23')) return null;
  return {
    sqlState,
    constraint: stringField(error, 'constraint_name'),
    table: stringField(error, 'table_name'),
  };
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const violation = sqlViolation(error);
  if (violation === null || violation.sqlState !== SQL_STATE.uniqueViolation) return false;
  return constraint === undefined || violation.constraint === constraint;
}

export function isCheckViolation(error: unknown, constraint?: string): boolean {
  const violation = sqlViolation(error);
  if (violation === null || violation.sqlState !== SQL_STATE.checkViolation) return false;
  return constraint === undefined || violation.constraint === constraint;
}

/**
 * Foreign keys are decided at the call site because `VIOLATION_CODES` cannot map them (see there).
 * `deleteAccount` in `users.ts` uses this to answer `account_deletion_blocked` on a database
 * without migration 0004.
 */
export function isForeignKeyViolation(error: unknown, constraint?: string): boolean {
  const violation = sqlViolation(error);
  if (violation === null || violation.sqlState !== SQL_STATE.foreignKeyViolation) return false;
  return constraint === undefined || violation.constraint === constraint;
}

/** `ReturnType` because the driver's fragment type is internal. */
type SqlFragment = ReturnType<Db>;

/**
 * A complete `jsonb` parameter, serialised and cast, so no call site can write the cast wrong.
 * `jsonb` cannot store a NUL, so a value containing one is `invalid_request` with the field named.
 */
export function jsonbParam(sql: Db, value: unknown, field: string): SqlFragment {
  return jsonbCast(sql, jsonbText(value, field));
}

/** SQL NULL for `null`, which the column CHECKs tell apart from JSON `null`. */
export function jsonbParamOrNull(sql: Db, value: unknown, field: string): SqlFragment {
  return jsonbCast(sql, value === null ? null : jsonbText(value, field));
}

/** For a column whose CHECK requires an object, which would otherwise turn an array or scalar into a 500. */
export function jsonbObjectParam(sql: Db, value: unknown, field: string): SqlFragment {
  const text = jsonbText(value, field);
  if (!text.startsWith('{')) {
    throw new AppError('invalid_request', {
      fields: { [field]: 'must be an object' },
      logDetail: `${field} was not a JSON object`,
    });
  }
  return jsonbCast(sql, text);
}

/**
 * `::text::jsonb`, not `::jsonb`: postgres.js types a parameter by the cast after it, so `::jsonb`
 * would JSON-encode the text a second time and store a jsonb string. `::text` makes the server parse it.
 */
function jsonbCast(sql: Db, text: string | null): SqlFragment {
  return sql`${text}::text::jsonb`;
}

/**
 * `JSON.stringify` renders a NUL as the escape backslash-u-0-0-0-0, spelled in words because
 * `security:hygiene` rejects a literal control character in source.
 */
function jsonbText(value: unknown, field: string): string {
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
 * Maps the constraints of races and mistakes the API has an honest answer for to wire codes. An unmapped
 * constraint is one nobody has reasoned about and must reach the handler as a 500.
 *
 * `hands_room_hand_number_key` is two deals racing for one hand number, so the loser's table moved on.
 * The `rooms_*` and name checks are validated before writing, so reaching one is a caller bug.
 *
 * No foreign key is mapped. One FK fires on an INSERT of a missing user (a bug, 500) and on a DELETE
 * under `ON DELETE RESTRICT` (`account_deletion_blocked`), so the call site decides with
 * `isForeignKeyViolation`. Also absent: `sessions_token_hash_key` and `hand_seats_hand_seat_key` (a
 * collision means the random source is broken and must fail loudly), `rooms_invite_code_hash_key`
 * (retried by `rooms.create`), and `hand_actions_client_action_id_key` (the idempotency guarantee,
 * reported by `hands.appendAction` as not applied).
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

/** Null means the error reaches the handler as `internal_error`. */
export function violationCode(error: unknown): ErrorCode | null {
  const violation = sqlViolation(error);
  if (violation === null || violation.constraint === '') return null;
  return VIOLATION_CODES[violation.constraint] ?? null;
}

/**
 * The `AppError` for a violation, or null. Callers write `if (mapped !== null) throw mapped; throw error;`
 * so the untouched rethrow stays visible and an unrecognised error is logged in full. The constraint
 * name reaches the log through `cause`, never the response, which would otherwise expose the schema.
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
