/**
 * `prl.audit_log` — security-relevant events, append-only, pre-redacted before they are written.
 *
 * ## Why there is a redaction pass here at all
 *
 * The table has a CHECK that refuses a top-level `detail` key named `token`, `sessionToken`,
 * `password`, `authorization`, `cookie`, `ip`, `userAgent`, `inviteCode`, `deck`, `salt`, `salts`
 * or `holeCards`. The migration is honest that it "cannot see inside nested objects, so it is a
 * backstop for the obvious mistake, not a substitute for redacting at the boundary".
 *
 * This is that boundary. `record` walks the whole detail object, **removes** any key that looks
 * sensitive (removes, not overwrites — see `REDACTED_KEYS_FIELD` for why that distinction is
 * load-bearing), and bounds the result. Three properties fall out of that, and each one is a bug
 * this would otherwise be:
 *
 * 1. **Nested secrets go too.** `{ context: { sessionToken: '...' } }` passes the CHECK — the
 *    forbidden key is not at the top level — and would be written verbatim.
 * 2. **A refused write does not become a 500.** Without the pass, a caller that logged one
 *    forbidden key would get a check violation on the audit write and take the request down with
 *    it. An audit entry that had to drop a field is still a useful audit entry.
 * 3. **The row stays small.** An unbounded `detail` is an unbounded row, and the thing being
 *    audited is often a rejected request whose size the caller chose.
 *
 * The key test is `isSensitiveKey` from `logging.ts` **plus** this table's own forbidden list.
 * Reusing `isSensitiveKey` is most of the answer — it already carries the pattern this project
 * maintains (`/token|secret|password|cookie|authorization|invite|credential|.../i`) and the
 * explicit names whose sensitivity is not visible in the name (`holeCards`, `deck`, `salt`,
 * `displayName`) — but it is not all of it, and the gap was found by a test rather than by reading:
 *
 *     isSensitiveKey('userAgent') === false
 *     isSensitiveKey('ip')        === false
 *
 * Both are in `audit_log_detail_has_no_forbidden_keys`. `logging.ts` handles them a different way —
 * its `req` serializer replaces the whole request object, so no key called `userAgent` ever reaches
 * the scrub — which is correct there and leaves this table uncovered. Without the second list, an
 * audit entry with a top-level `ip` or `userAgent` is a check violation, and a check violation on
 * an audit write takes down the request it was auditing.
 *
 * So both are consulted, and `AUDIT_FORBIDDEN_KEYS` is matched case-insensitively while the CHECK
 * is exact — `IP` and `UserAgent` would slip past the database and are dropped here anyway.
 *
 * ## Append-only means append-only
 *
 * `prl.audit_log` is granted SELECT and INSERT and nothing more. A role that can edit the audit
 * log has no audit log, which is why there is no `update` and no `delete` in this file, and why
 * there is nothing to add.
 *
 * ## Failures are not swallowed
 *
 * `record` throws if the write fails. It is tempting to make an audit write best-effort so a
 * logging problem cannot fail a login — but "the security event was not recorded and nobody knows"
 * is worse than a failed request, and a caller that genuinely must not fail can decide that for
 * itself at the call site.
 */

import { AppError } from '../errors.ts';
import { isSensitiveKey } from '../logging.ts';
import { newAuditEventId } from './ids.ts';
import { type Db, jsonbText, violationError } from './sql.ts';

/**
 * `audit_log_event_shape`, copied from migration 0001: 3 to 64 characters, dot-separated lowercase
 * segments. `auth.guest.created`, `room.invite.rejected`, `hand.action.stale`.
 */
const EVENT_NAME = /^[a-z0-9]+([.][a-z0-9_]+)*$/;
const EVENT_MIN = 3;
const EVENT_MAX = 64;

/**
 * `audit_log_detail_has_no_forbidden_keys`, copied from migration 0001 and lower-cased.
 *
 * Copied rather than derived, so that a key added to the CHECK and not added here fails a test
 * instead of failing a live audit write. **That test did not exist until 2026-08-27** — this
 * sentence described one for months and nothing compared the two lists, so they could drift in
 * exactly the way this paragraph promised they could not. `audit-forbidden-keys.test.ts` reads
 * `pg_get_constraintdef` off the live database and holds this set to what PostgreSQL actually
 * enforces, which is stronger than parsing a migration and survives any number of them. Held lower-cased because the CHECK's `?|` is exact and
 * this is not: `UserAgent` would satisfy the database and is still the thing we promised not to
 * store.
 */
const AUDIT_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'token',
  'sessiontoken',
  'password',
  'secret',
  'authorization',
  'cookie',
  'ip',
  'ipaddress',
  'useragent',
  'invitecode',
  'deck',
  'salt',
  'salts',
  'holecards',
  // Widened by db/migrations/0007 to the spellings this codebase actually uses. `holecards` alone
  // missed `hole_cards` — the column name in `prl.hand_seats`, and the first thing anybody writing
  // SQL reaches for — as well as the four fields `poker-engine`'s `types.ts` calls the hand's
  // secrets. Held to the database's own list by `apps/api/test/audit-forbidden-keys.test.ts`.
  'holecard',
  'hole_cards',
  'hole_card',
  'cards',
  'holecardpositions',
  'hole_card_positions',
  'board',
  'boardpositions',
  'board_positions',
  'decksalts',
  'deck_salts',
  'deckcursor',
  'deck_cursor',
  'deckorder',
  'deck_order',
  'reveal',
]);

/**
 * True when a key must not reach `prl.audit_log.detail`.
 *
 * Two lists, deliberately: the project-wide one in `logging.ts` catches the families (anything
 * containing "token", "secret", "cookie"), and this table's own catches the specific names the
 * schema forbids that the pattern does not match. Either one is enough to drop the value.
 */
export function isForbiddenAuditKey(key: string): boolean {
  return isSensitiveKey(key) || AUDIT_FORBIDDEN_KEYS.has(key.toLowerCase());
}

/**
 * Bounds on the redacted detail.
 *
 * Deliberately tighter than `logging.ts` uses for a log line, because a row is kept for as long as
 * the incident-response retention policy says and a log line is not. Anything deeper or wider than
 * this is a caller trying to store a document in an audit trail.
 */
const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_ARRAY = 16;
const MAX_DETAIL_STRING = 200;
const TRUNCATED = '[truncated]';

/**
 * Where the names of dropped keys are recorded.
 *
 * ############################################################################
 * ## A FORBIDDEN KEY IS REMOVED, NOT OVERWRITTEN                            ##
 * ############################################################################
 *
 * The first version of this file replaced the value with `'[redacted]'` and kept the key, which is
 * what `logging.ts` does and is wrong here. `audit_log_detail_has_no_forbidden_keys` is
 * `NOT (detail ?| array[...])`, and `?|` asks whether the **key** exists — it never looks at the
 * value. So `{"holeCards": "[redacted]"}` trips the CHECK just as surely as the real thing, and the
 * audit write fails, taking the request it was auditing with it. A test caught it; reading the
 * constraint would also have caught it, and did not.
 *
 * So the key goes and its *name* is recorded here as a value in an array. A name in a value is
 * invisible to `?|`, so the row still says "something called holeCards was dropped" — which is
 * exactly what an incident responder wants — without naming it in a position the schema forbids.
 *
 * A caller that passes its own `_redacted` key has it overwritten. That is a fair trade for a
 * reserved name beginning with an underscore, and it is the only key in this file with that
 * property besides `_truncated`.
 */
const REDACTED_KEYS_FIELD = '_redacted';
const TRUNCATED_FIELD = '_truncated';

/** What a redacted detail may contain. Nothing that is not one of these can reach the column. */
type AuditValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditValue[]
  | { readonly [key: string]: AuditValue };

export interface RecordEventInput {
  /** Dotted lowercase name, e.g. `auth.session.revoked`. A code constant, never user input. */
  readonly event: string;
  /** The account involved, or null for an event with no account (a rejected invite code). */
  readonly userId?: string | null;
  /** Arbitrary context. Redacted and bounded before it is written; see the file header. */
  readonly detail?: Record<string, unknown>;
}

/**
 * Writes one audit entry.
 *
 * The event name is validated against the column's own CHECK and a failure is a plain
 * `internal_error`, not `invalid_request`: event names are constants in the calling code, so a bad
 * one is a programming mistake and there is no client to tell about it.
 */
export async function record(sql: Db, input: RecordEventInput): Promise<void> {
  const event = input.event.trim();
  const length = [...event].length;
  if (length < EVENT_MIN || length > EVENT_MAX || !EVENT_NAME.test(event)) {
    throw new AppError('internal_error', {
      logDetail: `refusing an audit event name that the schema would reject (${length} characters)`,
    });
  }
  const detail = input.detail === undefined ? null : redactDetail(input.detail);
  const userId = input.userId ?? null;
  try {
    await sql`
      insert into prl.audit_log (id, user_id, event, detail)
      values (
        ${newAuditEventId()}, ${userId}, ${event},
        ${detail === null ? null : jsonbText(detail, 'detail')}::text::jsonb
      )
    `;
  } catch (error) {
    const mapped = violationError(error, 'writing an audit entry');
    if (mapped !== null) throw mapped;
    throw error;
  }
}

/**
 * Redacts and bounds one detail object.
 *
 * Exported because this is the part worth testing directly: the assertion that a nested
 * `sessionToken` does not survive is a test about a security property, and reaching it through a
 * live INSERT would make it a test about Postgres.
 *
 * Always returns an object, never an array or a scalar, because `audit_log_detail_is_object`
 * requires `jsonb_typeof(detail) = 'object'`.
 */
export function redactDetail(detail: Record<string, unknown>): Record<string, AuditValue> {
  return redactRecord(detail, 1);
}

/**
 * Walks one object level: drops forbidden keys, recurses into the rest, and bounds the width.
 *
 * The same key test runs at every level, which is the whole point — the database's CHECK sees only
 * the top level, and `{ context: { sessionToken: '...' } }` would sail past it.
 */
function redactRecord(source: object, depth: number): Record<string, AuditValue> {
  const out: Record<string, AuditValue> = {};
  const dropped: string[] = [];
  let kept = 0;
  for (const [key, value] of Object.entries(source)) {
    if (isForbiddenAuditKey(key)) {
      if (dropped.length < MAX_DETAIL_KEYS) dropped.push(clampString(key));
      continue;
    }
    if (kept >= MAX_DETAIL_KEYS) {
      out[TRUNCATED_FIELD] = true;
      break;
    }
    kept += 1;
    out[key] = redactValue(value, depth);
  }
  if (dropped.length > 0) out[REDACTED_KEYS_FIELD] = dropped;
  return out;
}

function redactValue(value: unknown, depth: number): AuditValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    // NaN and Infinity are not JSON, and `JSON.stringify` turns them into `null` silently. Saying
    // so out loud is more useful in an incident than a null nobody can explain.
    return Number.isFinite(value) ? value : TRUNCATED;
  }
  if (typeof value === 'string') return clampString(value);
  if (depth >= MAX_DETAIL_DEPTH) return TRUNCATED;
  if (Array.isArray(value)) {
    const entries: readonly unknown[] = value;
    const out: AuditValue[] = [];
    for (const entry of entries.slice(0, MAX_DETAIL_ARRAY)) out.push(redactValue(entry, depth + 1));
    if (entries.length > MAX_DETAIL_ARRAY) out.push(TRUNCATED);
    return out;
  }
  if (typeof value !== 'object') {
    // A symbol, a bigint or a function. None of them is JSON, and `JSON.stringify` would drop or
    // throw on them rather than record anything.
    return TRUNCATED;
  }
  return redactRecord(value, depth + 1);
}

/**
 * Caps a string and strips the characters that forge a line.
 *
 * Implemented by code point rather than by a regex containing the characters themselves, because
 * `pnpm run security:hygiene` rejects a literal control character in source — for the same reason
 * this function removes them from data.
 */
function clampString(value: string): string {
  let out = '';
  for (const char of value) {
    if (out.length >= MAX_DETAIL_STRING) {
      out += '...';
      break;
    }
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out;
}

export interface AuditEntryRow {
  readonly id: string;
  readonly user_id: string | null;
  readonly event: string;
  readonly detail: unknown;
  readonly created_at: Date;
}

export interface ReadAuditOptions {
  readonly userId?: string;
  readonly event?: string;
  readonly limit?: number;
}

/**
 * Reads the log, newest first. For an incident, not for a route.
 *
 * The three filters match the three indexes migration 0002 created for exactly this
 * (`audit_log_created_at_idx`, `audit_log_event_created_at_idx`, `audit_log_user_created_at_idx`),
 * and each is expressed as `($n is null or column = $n)` so one statement serves all four
 * combinations rather than four hand-assembled queries.
 *
 * Nothing in the REST contract exposes this. It exists so that an operator with a database session,
 * or a future internal tool, has a supported way to ask the question — and so that "read the audit
 * log" never becomes a reason to write ad-hoc SQL against a table with a redaction rule.
 */
export async function readRecent(sql: Db, options: ReadAuditOptions = {}): Promise<readonly AuditEntryRow[]> {
  const userId = options.userId ?? null;
  const event = options.event ?? null;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
  const rows = await sql<AuditEntryRow[]>`
    select id, user_id, event, detail, created_at
      from prl.audit_log
     where (${userId}::text is null or user_id = ${userId})
       and (${event}::text is null or event = ${event})
     order by created_at desc, id desc
     limit ${limit}
  `;
  return rows;
}
