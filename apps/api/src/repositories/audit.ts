/**
 * `prl.audit_log`, security events, append-only (the role has SELECT and INSERT only), redacted here
 * before writing. The table's CHECK sees only top-level keys, so `record` walks the whole detail,
 * removes sensitive keys at every depth, and bounds the size. A forbidden key reaching the CHECK would
 * fail the audit write and the request with it. `record` throws on a failed write, because an
 * unrecorded security event is worse than a failed request.
 */

import { AppError } from '../errors.ts';
import { isSensitiveKey } from '../logging.ts';
import { newAuditEventId } from './ids.ts';
import { type Db, jsonbText, violationError } from './sql.ts';

/** `audit_log_event_shape`, copied from migration 0001. */
const EVENT_NAME = /^[a-z0-9]+([.][a-z0-9_]+)*$/;
const EVENT_MIN = 3;
const EVENT_MAX = 64;

/**
 * `audit_log_detail_has_no_forbidden_keys`, lower-cased. `isSensitiveKey` misses `ip` and `userAgent`,
 * so this list is needed too. Matched case-insensitively because the CHECK's `?|` is exact and
 * `UserAgent` would pass it. `audit-forbidden-keys.test.ts` holds it to the live constraint.
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
  // Added by db/migrations/0007, covering the column spellings and the engine's secret field names.
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

/** `isSensitiveKey` catches the families, this table's list catches the names it misses. */
export function isForbiddenAuditKey(key: string): boolean {
  return isSensitiveKey(key) || AUDIT_FORBIDDEN_KEYS.has(key.toLowerCase());
}

/** Tighter than a log line, because an audit row is retained for incident response. */
const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_KEYS = 24;
const MAX_DETAIL_ARRAY = 16;
const MAX_DETAIL_STRING = 200;
const TRUNCATED = '[truncated]';

/**
 * A FORBIDDEN KEY IS REMOVED, NOT OVERWRITTEN. The CHECK's `?|` tests key existence, so
 * `{"holeCards": "[redacted]"}` still fails the write. The dropped key's name is stored as a value
 * here, where `?|` cannot see it. A caller's own `_redacted` key is overwritten.
 */
const REDACTED_KEYS_FIELD = '_redacted';
const TRUNCATED_FIELD = '_truncated';

type AuditValue =
  | string
  | number
  | boolean
  | null
  | readonly AuditValue[]
  | { readonly [key: string]: AuditValue };

export interface RecordEventInput {
  /** A code constant, never user input. */
  readonly event: string;
  readonly userId?: string | null;
  readonly detail?: Record<string, unknown>;
}

/** A bad event name is `internal_error`, because names are code constants and there is no client to tell. */
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
 * Exported so the redaction is tested directly rather than through Postgres. Always returns an object,
 * because `audit_log_detail_is_object` requires one.
 */
export function redactDetail(detail: Record<string, unknown>): Record<string, AuditValue> {
  return redactRecord(detail, 1);
}

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
    // `JSON.stringify` would turn NaN and Infinity into an unexplained null.
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
    // A symbol, bigint or function, which `JSON.stringify` would drop or throw on.
    return TRUNCATED;
  }
  return redactRecord(value, depth + 1);
}

/**
 * Caps a string and replaces control characters, by code point, because `security:hygiene` rejects a
 * literal control character in source.
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
 * Newest first. For an operator during an incident, not for a route. Each filter is
 * `($n is null or column = $n)`, so one statement serves all combinations of the 0002 indexes.
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
