/**
 * Logging: enough to debug a hand, never enough to replay a session.
 *
 * A log pipeline is a copy of production data with weaker access control and a longer
 * retention period than the database. Everything in this file exists because of that
 * one sentence.
 *
 * ## Three layers, deliberately overlapping
 *
 * 1. **Serializers** for `req`, `res` and `err` replace the whole object with a chosen
 *    subset. Fastify's default `req` serializer logs `url` and `remoteAddress`; the
 *    first carries the OIDC `code` on the callback route and the second is an IP
 *    address, so both are replaced here rather than filtered later.
 * 2. **A recursive scrub** (`formatters.log`) walks every other merged object and
 *    censors any key whose *name* looks sensitive. This is the layer that catches the
 *    object nobody thought about — a repository logging a row, a plugin logging its own
 *    options.
 * 3. **Pino's `redact` paths** run last, over the serialized output, as the net under
 *    layers 1 and 2.
 *
 * Three layers is not paranoia. Layer 1 only covers keys we predicted, layer 2 only
 * covers key *names* (not a token stuffed into a field called `note`), and layer 3 only
 * covers fixed paths. A leak has to get past all three.
 *
 * ## What is deliberately not logged
 *
 * - Raw IP addresses. A keyed hash goes out instead; see `plugins/request-context.ts`.
 * - Query string *values*. The parameter names are logged, which is enough to know that
 *   an OIDC callback happened without logging the authorization code.
 * - `displayName`, and anything else a user typed. User-supplied text in a log line is
 *   how a log viewer ends up rendering someone else's markup, and it is personal data
 *   we have no reason to keep.
 * - Hole cards, decks and commitment salts. Hidden state must not leave the server, and
 *   a log file is a way out.
 */

import type { FastifyRequest, FastifyServerOptions } from 'fastify';
import type { AppConfig } from './config.ts';
import { clientKeyFor } from './plugins/request-context.ts';

/**
 * Fastify's logger option, minus the `boolean` shorthand.
 *
 * Derived from `FastifyServerOptions` rather than imported from pino, because `pino` is a
 * transitive dependency of Fastify and not a declared dependency of this app — importing
 * it directly would be an undeclared dependency (which the linter rejects, correctly:
 * today's transitive dependency is tomorrow's removed one).
 */
type LoggerOptions = Exclude<NonNullable<FastifyServerOptions['logger']>, boolean>;

/** What replaces a censored value. Fixed string, so it is greppable. */
export const CENSOR = '[redacted]';

/**
 * Key names that are censored wherever they appear.
 *
 * Written as one case-insensitive pattern rather than a list of exact names because the
 * things that need censoring get invented constantly (`idToken`, `access_token`,
 * `refreshToken`, `oidcCodeVerifier`) and an exact-match list is always one commit out of
 * date. No `g` flag: a global regex keeps `lastIndex` between `.test()` calls and starts
 * silently returning false.
 */
export const SENSITIVE_KEY_PATTERN =
  /token|secret|password|passwd|cookie|authorization|invite|credential|bearer|assertion|signature|apikey|api_key|privatekey|private_key|databaseurl|database_url|connectionstring|connection_string|dsn|deck|salt|hole_?card/i;

/**
 * Key names censored by exact match, where the name gives no hint that the value is
 * sensitive.
 *
 * `displayName` is user-supplied text. The rest is hidden game state that the server
 * authority rules say never leaves this process — see `redactFor()` in the engine. A log
 * line is an exit this project has to close explicitly.
 *
 * ## `deck`, `salt` and `holecard` moved to the pattern above, and why
 *
 * This list used to carry `deck`, `deckorder`, `salt`, `salts`, `commitmentsalt`, `holecards`
 * and `holecard`. `SeatState.holeCards` and `HandState.deck` are real; `deckOrder`,
 * `commitmentSalt`, `salt` and `salts` are names nothing in this repository has ever used. The
 * fields that actually hold a hand's secrets are `deck`, `deckCursor`, `deckSalts`,
 * `holeCardPositions` and `boardPositions`, and an exact-match list matched one of the five.
 * Measured on 2026-08-27 by handing a real dealt `HandState` to `scrubLogObject`:
 *
 *     deck=REDACTED  deckCursor=present  deckSalts=present  holeCardPositions=present
 *     deckSalts logged: {"0":208,"1":81,"2":117,...}  — identical to the real bytes
 *
 * `deckSalts` is a `Uint8Array`, so the recursive scrub walks it as an object and emits the
 * first `MAX_KEYS_PER_OBJECT` bytes: two complete 32-byte commitment salts, verbatim. The
 * header of this file promises "hole cards, decks and commitment salts" never reach a log. Hole
 * cards and the deck were censored; the salts — the third of the three, and the one `types.ts`
 * groups with the deck and the cursor as "the hand's secrets" — were not, and neither were the
 * cursor or the hole-card positions.
 *
 * So the three hidden-state families are substrings in the pattern above, for exactly the
 * reason that comment already gives: they get invented constantly (`deckCursor`, `deckSalts`,
 * `holeCardPositions`, `saltHex`) and an exact list is always one commit behind. `hole_?card`
 * covers `holeCardPositions` and the snake_case column name `hole_cards` that a row logged
 * straight out of the database would carry; `boardPositions` is the one remaining secret field
 * whose name contains none of the three, and it stays here.
 *
 * No production call site logs a `HandState` today. This is the layer that would have to
 * hold if one ever did, which is the whole reason it exists.
 */
export const EXPLICIT_SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  'displayname',
  'boardpositions',
  'csrf',
]);

/**
 * Top-level keys pino has a serializer for. The recursive scrub steps over them so it
 * does not deep-copy a Fastify request or flatten an Error before the serializer that
 * knows how to shrink them safely gets a look.
 */
const SERIALIZED_KEYS: ReadonlySet<string> = new Set(['req', 'res', 'err']);

/** Recursion limits, so a cyclic or enormous object cannot turn one log line into a stall. */
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
 * Replaces C0 control characters and DEL with spaces.
 *
 * Exported because both this file and `errors.ts` need it: a control character in a log
 * line can forge a second line, and one in an error body can do the same in whatever
 * reads it. Implemented by code point rather than by regex so that no control character
 * has to be typed into this repository — the hygiene gate rejects them in source, for
 * exactly the reason we are stripping them here.
 */
export function withoutControlCharacters(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : char;
  }
  return out;
}

/** The path part of a URL, with the query string dropped. Never throws. */
export function pathOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  return withoutControlCharacters(path).slice(0, MAX_LOGGED_PATH_LENGTH);
}

/**
 * The *names* of the query parameters, with no values.
 *
 * This is the compromise that keeps the OIDC callback debuggable: `["code","state"]`
 * tells an operator the provider came back with what it should have, while the values —
 * an authorization code that can be exchanged for a session — stay out of the log.
 */
export function queryKeysOf(url: unknown): readonly string[] {
  if (typeof url !== 'string') return [];
  const queryAt = url.indexOf('?');
  if (queryAt === -1) return [];
  const keys: string[] = [];
  for (const pair of url.slice(queryAt + 1).split('&')) {
    if (keys.length >= MAX_LOGGED_QUERY_KEYS) break;
    const [rawKey = ''] = pair.split('=');
    // Parameter names are caller-controlled, so they are filtered to a safe alphabet
    // rather than trusted.
    const key = rawKey.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
    if (key !== '' && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// The recursive scrub
// ---------------------------------------------------------------------------

interface ScrubState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function scrubValue(value: unknown, depth: number, state: ScrubState): unknown {
  if (value === null || typeof value !== 'object') return value;
  state.nodes += 1;
  if (depth >= MAX_SCRUB_DEPTH || state.nodes > MAX_SCRUB_NODES) return '[truncated]';
  // A cycle would otherwise recurse until the stack ends. Reporting it is more useful
  // than pino's own circular handling, because it names the place it happened.
  if (state.seen.has(value)) return '[circular]';
  state.seen.add(value);

  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((entry: unknown) => {
      const next = scrubValue(entry, depth + 1, state);
      if (next !== entry) changed = true;
      return next;
    });
    // Copy-on-write: returning the original array when nothing was censored keeps the
    // common case allocation-free.
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

/**
 * Scrubs one merged log object.
 *
 * Exported so the redaction rules can be tested directly rather than by parsing log
 * output, which is the only way to be sure a rule still works after someone edits the
 * pattern above.
 */
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

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/**
 * Reads one property from an object of unknown shape.
 *
 * `Reflect.get` rather than an index signature or a cast: the values these serializers
 * want (`request.method`, `request.ip`) are accessor properties on Fastify's prototypes,
 * so `Object.getOwnPropertyDescriptor` would return nothing, and spreading the object to
 * get an index signature would copy every property of a Fastify request on every log
 * line. Assigning straight into an `unknown` binding contains `Reflect.get`'s loose
 * return type at the boundary instead of letting it spread through the file.
 */
function fieldOf(source: object, key: string): unknown {
  const value: unknown = Reflect.get(source, key);
  return value;
}

/**
 * What the `req` serializer emits. Every field here is a decision:
 *
 * - `path` and not `url`, so the query string cannot ride along.
 * - `queryKeys` and not the query itself.
 * - `routePattern` rather than the concrete path, so log searches group and no real room
 *   or hand id is stored.
 * - `clientKey` and not `remoteAddress`.
 *
 * Fastify's own serializer emits `url` and `remoteAddress`; this replaces it wholesale
 * rather than filtering it, because a filter would have to be updated every time Fastify
 * adds a field and an allowlist does not.
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
    // `clientKey` is set by the request-context hook, which runs *after* Fastify logs
    // "incoming request". Recomputing here costs one HMAC and means the very first line of
    // a request already carries the caller's bucket.
    clientKey: request.clientKey === '' ? clientKeyFor(secret, request.ip) : request.clientKey,
  };
}

/**
 * What the `err` serializer emits. `type`, `message` and `stack` are required because
 * Fastify's logger option requires them; the rest is ours.
 */
type SerializedError = {
  type: string;
  message: string;
  stack: string;
  code: string | null;
  cause: SerializedError | null;
};

/**
 * Error serializer.
 *
 * Written out rather than reusing pino's, for two reasons: the stack is capped (an
 * unbounded stack on every 500 is a lot of bytes for the same information), and `cause`
 * is followed to a fixed depth — which is where the real reason usually lives once an
 * error has been wrapped twice.
 *
 * Typed to take `unknown` because that is what it is really handed: Fastify types the
 * argument as `FastifyError`, but anything at all can be thrown, and a serializer that
 * assumes otherwise crashes inside the logger — which is the worst possible place.
 */
function serializeError(value: unknown, depth = 0): SerializedError {
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

// ---------------------------------------------------------------------------
// Redaction paths (the net under the two layers above)
// ---------------------------------------------------------------------------

/**
 * Fixed paths pino censors in the serialized output.
 *
 * Bracket notation is required for any key containing a dash — `req.headers.x-csrf-token`
 * parses as arithmetic and silently matches nothing, which is the classic way a redact
 * list looks complete and is not.
 */
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
  // One level of wildcard, for the common `{ something: { token: ... } }` shape. Pino's
  // `*` matches exactly one level, so these do not replace the recursive scrub — they
  // back it up.
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

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Builds the value for Fastify's `logger` option.
 *
 * In test the logger is switched off entirely rather than merely set to `silent`. A
 * silent pino still formats and serializes every line, which makes the test suite slower
 * for output nobody reads; `false` gives Fastify a no-op logger. The redaction rules stay
 * testable because `scrubLogObject` is exported and tested directly.
 */
export function buildLoggerOptions(config: AppConfig): NonNullable<FastifyServerOptions['logger']> {
  if (config.isTest || config.logLevel === 'silent') return false;

  const options: LoggerOptions = {
    level: config.logLevel,
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
    formatters: {
      // Runs before the serializers below, so `req`/`res`/`err` are stepped over here
      // and shrunk there.
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
