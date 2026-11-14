/**
 * Logging. A log pipeline is a copy of production data with weaker access control and longer
 * retention, so three overlapping layers keep secrets out. Serializers replace `req`, `res`, `err`
 * with an allowlist. A recursive scrub censors sensitive key names. Pino `redact` paths are the net.
 * Never logged are raw IPs (a keyed hash instead), query values, user-typed text such as
 * `displayName`, and hole cards, decks or commitment salts.
 */

import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.ts';
import { clientKeyFor } from './plugins/request-context.ts';

/** From `FastifyServerOptions`, because `pino` is only a transitive dependency. */
type LoggerOptions = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>;

export const CENSOR = '[redacted]';

/**
 * A substring pattern, because new sensitive names (`idToken`, `deckSalts`, `holeCardPositions`)
 * appear constantly. No `g` flag, since a global regex keeps `lastIndex` between `.test()` calls.
 * `deck`, `salt` and `hole_?card` are substrings because an exact list matches only `deck` of the
 * five secret `HandState` fields, which lets 32-byte commitment salts reach a log verbatim.
 */
export const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|cookie|authorization|invite|credential|bearer|assertion|signature|apikey|api_key|privatekey|private_key|databaseurl|database_url|connectionstring|connection_string|dsn|deck|salt|hole_?card/i;

/** Names that give no hint. `boardPositions` is the one secret field the pattern misses. */
export const EXPLICIT_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'displayname',
  'boardpositions',
  'csrf',
]);

/** Left for their serializers, so the scrub does not deep-copy a request or flatten an Error. */
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(['req', 'res', 'err']);

/** So a cyclic or huge object cannot stall a log line. */
const MAX_SCRUB_DEPTH = 6;
const MAX_SCRUB_NODES = 400;
const MAX_KEYS_PER_OBJECT = 64;
const MAX_STACK_CHARACTERS = 4_000;
const MAX_LOGGED_PATH_LENGTH = 200;
const MAX_LOGGED_QUERY_KEYS = 8;

export function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return EXPLICIT_SENSITIVE_KEYS.has(lowered) || SENSITIVE_KEY_PATTERN.test(lowered);
}

/**
 * A control character can forge a second log line. Matched by code point so none has to appear in
 * source, which the hygiene gate forbids. Also used by `errors.ts`.
 */
export function withoutControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out;
}

export function pathOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return withoutControlCharacters(path).slice(0, MAX_LOGGED_PATH_LENGTH);
}

/** Names only, so an OIDC callback shows `["code","state"]` without the exchangeable code. */
export function queryKeysOf(url: unknown): readonly string[] {
  if (typeof url !== 'string') return [];
  const queryAt = url.indexOf('?');
  if (queryAt === -1) return [];
  const keys: string[] = [];
  for (const pair of url.slice(queryAt + 1).split('&')) {
    if (keys.length >= MAX_LOGGED_QUERY_KEYS) break;
    const [rawKey = ''] = pair.split('=');
    // Caller-controlled, so filtered to a safe alphabet.
    const key = rawKey.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

interface ScrubState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function scrubValue(value: unknown, depth: number, state: ScrubState): unknown {
  if (value === null || typeof value !== 'object') return value;
  state.nodes += 1;
  if (depth >= MAX_SCRUB_DEPTH || state.nodes > MAX_SCRUB_NODES) return '[truncated]';
  if (state.seen.has(value)) return '[circular]';
  state.seen.add(value);

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry: unknown) => {
      const next = scrubValue(entry, depth + 1, state);
      if (next !== entry) changed = true;
      return next;
    });
    // Copy-on-write keeps the common case allocation-free.
    return changed ? out : value;
  }

  return scrubRecord(value, depth, state);
}

function scrubRecord(value: object, depth: number, state: ScrubState): unknown {
  const entries = Object.entries(value);
  let changed = entries.length > MAX_KEYS_PER_OBJECT;
  const out: Record<string, unknown> = {};
  let kept = 0;

  for (const [key, entry] of entries) {
    if (kept >= MAX_KEYS_PER_OBJECT) break;
    kept += 1;
    if (isSensitiveKey(key)) {
      out[key] = CENSOR;
      changed = true;
      continue;
    }
    const next = scrubValue(entry, depth + 1, state);
    if (next !== entry) changed = true;
    out[key] = next;
  }

  return changed ? out : value;
}

export function scrubLogObject(object: unknown): Record<string, unknown> {
  if (object === null || typeof object !== 'object') return {};
  const state: ScrubState = { nodes: 0, seen: new WeakSet<object>() };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(object)) {
    if (SERIALIZED_KEYS.has(key)) {
      out[key] = value;
      continue;
    }
    out[key] = isSensitiveKey(key) ? CENSOR : scrubValue(value, 1, state);
  }
  return out;
}

/**
 * `Reflect.get`, because `method` and `ip` are prototype accessors and spreading a request would
 * copy every property per line.
 */
function fieldOf(source: object, key: string): unknown {
  const value: unknown = Reflect.get(source, key);
  return value;
}

/**
 * An allowlist replacing Fastify's serializer, which emits `url` and `remoteAddress`. `path` drops
 * the query, `routePattern` stores no real ids, `clientKey` replaces the IP.
 */
type SerializedRequest = {
  method: string;
  path: string;
  queryKeys: readonly string[];
  routePattern: string | null;
  clientKey: string;
};

function serializeRequest(request: FastifyRequest, secret: string): SerializedRequest {
  return {
    method: request.method,
    path: pathOf(request.url),
    queryKeys: queryKeysOf(request.url),
    routePattern: request.routeOptions.url ?? null,
    // The request-context hook runs after Fastify logs "incoming request", so compute it here.
    clientKey: request.clientKey === '' ? clientKeyFor(secret, request.ip) : request.clientKey,
  };
}

/** `type`, `message` and `stack` are required by Fastify's logger option. */
type SerializedError = {
  type: string;
  message: string;
  stack: string;
  code: string | null;
  cause: SerializedError | null;
};

/**
 * Caps the stack and follows `cause` to depth 3. Takes `unknown` because anything can be thrown,
 * and a crash inside the logger is the worst place for one.
 */
export function serializeError(value: unknown, depth = 0): SerializedError {
  if (value === null || typeof value !== 'object') {
    return { type: typeof value, message: String(value), stack: '', code: null, cause: null };
  }
  const message = fieldOf(value, 'message');
  const code = fieldOf(value, 'code');
  const stack = fieldOf(value, 'stack');
  const cause = fieldOf(value, 'cause');
  return {
    type: value instanceof Error ? value.constructor.name : 'unknown',
    message: typeof message === 'string' ? withoutControlCharacters(message) : '',
    stack: typeof stack === 'string' ? stack.slice(0, MAX_STACK_CHARACTERS) : '',
    code: typeof code === 'string' ? code : null,
    cause: cause !== undefined && depth < 3 ? serializeError(cause, depth + 1) : null,
  };
}

/** Dashed keys need bracket notation, or the path parses as arithmetic and matches nothing. */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["proxy-authorization"]',
  'req.headers["x-csrf-token"]',
  'req.headers["x-forwarded-for"]',
  'req.headers["x-real-ip"]',
  'req.body.displayName',
  'req.body.inviteCode',
  'req.query.code',
  'req.query.state',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'headers["set-cookie"]',
  'headers["x-csrf-token"]',
  'cookies',
  'cookie',
  'authorization',
  'displayName',
  'inviteCode',
  'sessionToken',
  'sessionId',
  'csrfToken',
  'accessToken',
  'idToken',
  'refreshToken',
  'clientSecret',
  'sessionCookieSecret',
  'databaseUrl',
  'database.url',
  'config.database.url',
  'config.sessionCookieSecret',
  'oidc.clientSecret',
  'err.cookies',
  // Pino's `*` matches one level only, so these back up the recursive scrub.
  '*.token',
  '*.secret',
  '*.password',
  '*.cookie',
  '*.authorization',
  '*.inviteCode',
  '*.displayName',
  '*.sessionToken',
  '*.clientSecret',
];

/** Off in test, because a silent pino still serializes every line. */
export function buildLoggerOptions(config: AppConfig): NonNullable<FastifyServerOptions['logger']> {
  if (config.isTest || config.logLevel === 'silent') return false;

  const options: LoggerOptions = {
    level: config.logLevel,
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    formatters: {
      log: (object) => scrubLogObject(object),
    },
    serializers: {
      req: (request) => serializeRequest(request, config.sessionCookieSecret),
      res: (reply) => ({ statusCode: reply.statusCode }),
      err: (error) => serializeError(error),
    },
  };
  return options;
}
