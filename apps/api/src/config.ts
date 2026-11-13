/**
 * Configuration, parsed, validated and frozen once at startup.
 * Every variable is read here, so a typo such as `SESSION_COOKE_SECRET` is caught at boot rather
 * than read as `undefined`. Every problem is collected and reported together.
 * Production refuses what development tolerates or substitutes, such as a missing cookie secret.
 * `loadConfig(env)` is a pure function of the record it is given, and `getConfig()` memoises it.
 */

import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** Pino's levels, plus `silent`. Kept as a local union so config does not import pino. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The shortest turn clock a person alone at a table of bots gets, in seconds.
 * A live flop's Coach panel runs to about 5,700 characters plus two tables, around four minutes of
 * reading, and a 60-second clock folded two hands while the learner read it. 240 is that reading
 * time rounded to whole minutes. `LiveTable.turnSecondsFor` applies it only when no other person
 * is waiting, and it is a floor, so a room with a longer clock keeps it. An untimed first action
 * was rejected because an abandoned seat could then stall a table indefinitely.
 * Override with `LEARNER_TURN_SECONDS`.
 */
export const DEFAULT_LEARNER_TURN_SECONDS = 240;

export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

export interface RateLimitConfig {
  /** Requests allowed per window for ordinary routes. */
  readonly globalMax: number;
  readonly globalWindowMs: number;
  /** Requests allowed per window for routes that cost real CPU (Monte Carlo, Coach). */
  readonly expensiveMax: number;
  readonly expensiveWindowMs: number;
  /**
   * Guest-session creation, per window. Address-keyed, because a route that issues a session
   * cannot be limited by that session (see `clientKeyedRateLimit` in `plugins/security.ts`).
   * Configurable because CI and staging smoke runs drive one address far harder than a person.
   */
  readonly guestMax: number;
  readonly guestWindowMs: number;
  /**
   * The ceiling on `/auth/oidc/start` and, separately, `/auth/oidc/callback`, per window, per
   * address. Sized for a classroom behind one egress address, two per learner (`.env.example`).
   * It is not the anti-abuse control. `oidcFailureMax` is.
   */
  readonly oidcMax: number;
  readonly oidcWindowMs: number;
  /**
   * OIDC requests per window per address that end in an error.
   * A script's every attempt lands here, because completing a sign-in needs a code only the
   * identity provider can mint. Shares `oidcWindowMs` so `Retry-After` has one answer.
   * The default 15 is what the old single limit permitted for failures, so splitting it loosened
   * nothing.
   */
  readonly oidcFailureMax: number;
  /** How far past the limit a caller may go before a block. Blunts a script ignoring `retryAfterSeconds`. */
  readonly banAfter: number;
}

/**
 * Which doors a declared cohort comes through. `both` is the default because it checks every
 * entrance, so a forgotten "Play as guest" door is reported at boot.
 */
export type CohortEntry = 'oidc' | 'guest' | 'both';

/**
 * How many learners the operator declares will arrive together from one address.
 * Every limit a classroom trips is address-keyed, because guest creation and the OIDC callback
 * issue the session. Against the shipped defaults, thirty learners from one address got fifteen
 * sign-ins and fifteen 429s. `checkCohortSizing` refuses to boot when the limits cannot serve the
 * declared size, and raises nothing itself. `0` means none declared, right for a public instance.
 */
export interface CohortConfig {
  /** `0` when nothing was declared. */
  readonly size: number;
  /** Only the declared doors are size-checked. */
  readonly entry: CohortEntry;
}

/**
 * Whether a live enrolment is required to take a seat (`PRL_ENROLMENT_REQUIRED`).
 * `enforced` makes `RoomRegistry.sitAtTable` refuse a learner with no entitlement, with
 * `enrolment_required`. Nothing else is gated, so lessons, the Lab and watching stay open.
 * The default is `off` so the migration did not close existing open deployments. Staging runs it
 * `enforced`, and `scripts/smoke-test.mjs` section 13 drives both directions over TLS.
 * An enum rather than a boolean so a third value, such as warn-only, can be added.
 */
export type EnrolmentRequirement = 'off' | 'enforced';

export interface DatabaseConfig {
  readonly url: string;
  /** See the pool note in `db.ts`. */
  readonly poolMax: number;
  /** Postgres cancels a statement that exceeds it. */
  readonly statementTimeoutMs: number;
  readonly idleTimeoutSeconds: number;
  readonly connectTimeoutSeconds: number;
}

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly isProduction: boolean;
  readonly isTest: boolean;

  readonly port: number;
  readonly host: string;
  readonly logLevel: LogLevel;

  /**
   * Exact allowlist of browser origins, normalised to `scheme://host[:port]`. One list serves
   * CORS and the WebSocket `Origin` check, so the two cannot disagree.
   */
  readonly webOrigins: readonly string[];

  /** Never logged, never returned by any route. */
  readonly sessionCookieSecret: string;
  /** A production boot with this false is refused, because a cookie without `Secure` leaks over plaintext. */
  readonly cookieSecure: boolean;

  readonly database: DatabaseConfig;

  /** True only when all four OIDC variables are present. */
  readonly oidcEnabled: boolean;
  readonly oidc: OidcConfig | null;

  /** Hard ceiling on Monte Carlo samples per request, whatever the client asks for. */
  readonly monteCarloMaxSamples: number;
  readonly monteCarloWorkers: number;
  /** Wall-clock budget for one Coach analysis before it is abandoned. */
  readonly coachTimeoutMs: number;

  /**
   * Floor on the turn clock of a person alone at a table of bots, in seconds. Bots and tables
   * with a second person keep the room's setting. See `DEFAULT_LEARNER_TURN_SECONDS`.
   */
  readonly learnerTurnSeconds: number;

  readonly rateLimit: RateLimitConfig;

  readonly cohort: CohortConfig;

  /**
   * Read only by `routes/index.ts`, which binds the registry's entitlement port. A second reader
   * would be a second place to make the enforcement decision.
   */
  readonly enrolmentRequired: EnrolmentRequirement;

  /**
   * SECURITY: makes `request.ip` client-controlled unless a trusted proxy overwrites
   * `X-Forwarded-For`. A forged header defeats address-based rate limiting and poisons the hashed
   * client key in logs.
   */
  readonly trustProxy: boolean;

  /**
   * Bearer token for `GET /metrics`, or null when the endpoint is off. Metrics disclose the shape
   * and load of the deployment, so they are authenticated, by token because the caller is a
   * scraper. Absent in production means the route is not registered at all, since a 403 would
   * still identify the application. Development serves it without a token and warns.
   */
  readonly metricsToken: string | null;

  /**
   * Enables the rate-limit reset control, for test isolation only. Production refuses to start
   * with it set (`readRateLimitResetToken`).
   */
  readonly rateLimitResetToken: string | null;

  /** Bytes. */
  readonly bodyLimitBytes: number;
  readonly requestTimeoutMs: number;
  readonly shutdownGraceMs: number;

  /** Non-fatal observations from parsing, logged by `server.ts` at boot. */
  readonly warnings: readonly string[];
}

/** Thrown when configuration cannot be used. Carries every problem, not just the first. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `Refusing to start: ${problems.length} configuration problem${problems.length === 1 ? '' : 's'}.\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    this.problems = problems;
  }
}

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * Never accepted as a real secret. A value in an example file or a tutorial is public the
 * moment it is written down.
 */
const FORBIDDEN_SECRET_SUBSTRINGS = [
  'change',
  'example',
  'placeholder',
  'insecure',
  'password',
  'secret',
  'default',
  'todo',
  'xxxx',
  'test',
  'dev-only',
] as const;

const GENERATE_SECRET =
  "`node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"`";

/** 32 base64url characters carry about 192 bits. */
const MIN_SECRET_LENGTH = 32;
/** Below this, a long secret is a short one repeated. */
const MIN_SECRET_DISTINCT_CHARS = 12;

interface Collector {
  readonly problems: string[];
  readonly warnings: string[];
}

function trimmed(env: EnvRecord, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function requireString(env: EnvRecord, key: string, collect: Collector): string {
  const value = trimmed(env, key);
  if (value === undefined) {
    collect.problems.push(`${key} is required but missing or empty`);
    return '';
  }
  return value;
}

interface IntBounds {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

function readInt(env: EnvRecord, key: string, bounds: IntBounds, collect: Collector): number {
  const value = trimmed(env, key);
  if (value === undefined) return bounds.fallback;
  // Number() rather than parseInt(), because parseInt('3001abc') is 3001 and hides the typo.
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    collect.problems.push(`${key} must be an integer, got "${value}"`);
    return bounds.fallback;
  }
  if (parsed < bounds.min || parsed > bounds.max) {
    collect.problems.push(`${key} must be between ${bounds.min} and ${bounds.max}, got ${parsed}`);
    return bounds.fallback;
  }
  return parsed;
}

function readBoolean(env: EnvRecord, key: string, fallback: boolean, collect: Collector): boolean {
  const value = trimmed(env, key)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  collect.problems.push(`${key} must be true or false, got "${value}"`);
  return fallback;
}

function readNodeEnv(env: EnvRecord, collect: Collector): NodeEnv {
  const value = trimmed(env, 'NODE_ENV') ?? 'development';
  if ((NODE_ENVS as readonly string[]).includes(value)) {
    // find() narrows for the compiler without a cast.
    const match = NODE_ENVS.find((candidate) => candidate === value);
    if (match !== undefined) return match;
  }
  collect.problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}, got "${value}"`);
  return 'development';
}

function readLogLevel(env: EnvRecord, nodeEnv: NodeEnv, collect: Collector): LogLevel {
  const fallback: LogLevel = nodeEnv === 'test' ? 'silent' : 'info';
  const value = trimmed(env, 'LOG_LEVEL')?.toLowerCase();
  if (value === undefined) return fallback;
  const match = LOG_LEVELS.find((candidate) => candidate === value);
  if (match === 'silent' && nodeEnv === 'production') {
    // Refused, because `silent` gives Fastify no logger, so no warning or crash reason is written.
    // Measured with NODE_ENV=production on a taken port, `silent` exited 1 with zero bytes on
    // stdout and stderr. `fatal` is the quietest level that still says why the process died.
    collect.problems.push(
      'LOG_LEVEL=silent is not allowed in production: the process would log nothing, including why ' +
        'it failed to start or crashed. Use fatal for the quietest level that still does.',
    );
    return fallback;
  }
  if (match !== undefined) return match;
  collect.problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
  return fallback;
}

/**
 * Normalises one origin to `scheme://host[:port]` and rejects anything else.
 * Matching is exact (`isAllowedOrigin` in `plugins/security.ts`), so a trailing slash, a path, a
 * wildcard or a trailing dot would match nothing and fail closed with no diagnostic. A wildcard
 * in first position would also break the post-sign-in redirect (`safeRedirectTarget` uses
 * `webOrigins[0]`). The browser never sends the trailing dot that `URL` keeps.
 */
export function normaliseOrigin(raw: string): { readonly origin: string } | { readonly problem: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { problem: `"${raw}" is not a URL` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { problem: `"${raw}" must use http or https` };
  }
  if (url.username !== '' || url.password !== '') {
    return { problem: `"${raw}" must not contain credentials` };
  }
  if (url.search !== '' || url.hash !== '') {
    return { problem: `"${raw}" must not contain a query string or fragment` };
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    return { problem: `"${raw}" must be a bare origin with no path (drop "${url.pathname}")` };
  }
  if (url.hostname.includes('*')) {
    return {
      problem:
        `"${raw}" contains a wildcard. Origins are matched exactly, so this would match ` +
        'nothing at all; list every origin in full, comma-separated',
    };
  }
  if (url.hostname.endsWith('.')) {
    return {
      problem: `"${raw}" ends in a trailing dot, which no browser sends as an origin (drop the dot)`,
    };
  }
  return { origin: url.origin.toLowerCase() };
}

function readWebOrigins(env: EnvRecord, nodeEnv: NodeEnv, collect: Collector): readonly string[] {
  const raw = trimmed(env, 'PUBLIC_WEB_ORIGIN');
  if (raw === undefined) {
    if (nodeEnv === 'production') {
      collect.problems.push('PUBLIC_WEB_ORIGIN is required in production (comma-separated allowlist)');
      return [];
    }
    const fallback = 'http://localhost:3000';
    collect.warnings.push(`PUBLIC_WEB_ORIGIN not set; allowing only ${fallback}`);
    return [fallback];
  }

  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (candidate === '') continue;
    const result = normaliseOrigin(candidate);
    if ('problem' in result) {
      collect.problems.push(`PUBLIC_WEB_ORIGIN entry ${result.problem}`);
      continue;
    }
    seen.add(result.origin);
  }
  if (seen.size === 0) collect.problems.push('PUBLIC_WEB_ORIGIN contained no usable origins');

  if (nodeEnv === 'production') {
    for (const origin of seen) {
      if (origin.startsWith('http://')) {
        collect.problems.push(
          `PUBLIC_WEB_ORIGIN entry "${origin}" is plaintext http; a Secure session cookie ` +
            'would never be sent to it, so sign-in could not work',
        );
      }
    }
  }
  return [...seen];
}

/**
 * Production requires a long, non-placeholder secret.
 * Elsewhere a missing secret becomes a random per-process one, and a short or placeholder secret
 * is tolerated with a warning. The placeholder warning exists because `.env.example`'s 55-character
 * value passed the length check and the API booted silently signing with a public string.
 */
function readSessionCookieSecret(env: EnvRecord, nodeEnv: NodeEnv, collect: Collector): string {
  const value = trimmed(env, 'SESSION_COOKIE_SECRET');
  const isProduction = nodeEnv === 'production';

  if (value === undefined) {
    if (isProduction) {
      collect.problems.push(
        `SESSION_COOKIE_SECRET is required in production; generate one with ${GENERATE_SECRET}`,
      );
      return '';
    }
    collect.warnings.push(
      'SESSION_COOKIE_SECRET not set; using a random per-process secret, so every ' +
        'restart invalidates existing sessions',
    );
    return randomBytes(32).toString('base64url');
  }

  if (!isProduction) {
    if (value.length < MIN_SECRET_LENGTH) {
      collect.warnings.push(
        `SESSION_COOKIE_SECRET is only ${value.length} characters; production requires ` +
          `at least ${MIN_SECRET_LENGTH}`,
      );
      return value;
    }
    const placeholder = FORBIDDEN_SECRET_SUBSTRINGS.find((needle) => value.toLowerCase().includes(needle));
    if (placeholder !== undefined) {
      collect.warnings.push(
        `SESSION_COOKIE_SECRET looks like a placeholder (it contains "${placeholder}"), so this ` +
          'process signs sessions with a public development secret, such as the one .env.example ' +
          'ships, and anyone who has read it can forge a session. Tolerated outside production, ' +
          `refused in it. Set a real one in .env: ${GENERATE_SECRET}`,
      );
    }
    return value;
  }

  if (value.length < MIN_SECRET_LENGTH) {
    collect.problems.push(
      `SESSION_COOKIE_SECRET must be at least ${MIN_SECRET_LENGTH} characters ` +
        `(>= 32 bytes of entropy) in production, got ${value.length}`,
    );
  }
  const lowered = value.toLowerCase();
  const forbidden = FORBIDDEN_SECRET_SUBSTRINGS.find((needle) => lowered.includes(needle));
  if (forbidden !== undefined) {
    collect.problems.push(
      `SESSION_COOKIE_SECRET looks like a placeholder (it contains "${forbidden}"); ` +
        'generate a real one and never reuse an example value',
    );
  }
  if (new Set(value).size < MIN_SECRET_DISTINCT_CHARS) {
    collect.problems.push(
      `SESSION_COOKIE_SECRET has only ${new Set(value).size} distinct characters, so its ` +
        'length is padding rather than entropy',
    );
  }
  return value;
}

/**
 * An optional secret that, when present, must pass the production rules of
 * `readSessionCookieSecret`. Missing means the feature is off. Applied in every environment,
 * because a weak token in development reaches the staging deployment that copies its `.env`.
 */
function readOptionalSecret(env: EnvRecord, key: string, collect: Collector): string | null {
  const value = trimmed(env, key);
  if (value === undefined) return null;
  if (value.length < MIN_SECRET_LENGTH) {
    collect.problems.push(
      `${key} must be at least ${MIN_SECRET_LENGTH} characters when set, got ${value.length}`,
    );
  }
  const lowered = value.toLowerCase();
  const forbidden = FORBIDDEN_SECRET_SUBSTRINGS.find((needle) => lowered.includes(needle));
  if (forbidden !== undefined) {
    collect.problems.push(
      `${key} looks like a placeholder (it contains "${forbidden}"); generate a real one`,
    );
  }
  if (new Set(value).size < MIN_SECRET_DISTINCT_CHARS) {
    collect.problems.push(
      `${key} has only ${new Set(value).size} distinct characters, so its length is padding rather than entropy`,
    );
  }
  return value;
}

/**
 * Refuses to start production if the reset token is present.
 * The control empties the rate limiter, so its holder has no rate limit at all. The realistic
 * failure is a `.env` copied from staging, so the check is fatal with no override. Production-mode
 * staging therefore waits out its windows instead (`scripts/smoke-test.mjs`).
 */
function readRateLimitResetToken(env: EnvRecord, nodeEnv: NodeEnv, collect: Collector): string | null {
  const value = readOptionalSecret(env, 'RATE_LIMIT_RESET_TOKEN', collect);
  if (value === null) return null;
  if (nodeEnv === 'production') {
    collect.problems.push(
      'RATE_LIMIT_RESET_TOKEN must not be set in production: it unlocks a control that empties ' +
        'the rate limiter, which is equivalent to disabling rate limiting for whoever holds it. ' +
        'Remove the variable from this environment.',
    );
    return null;
  }
  collect.warnings.push(
    'RATE_LIMIT_RESET_TOKEN is set: the rate-limit reset control is enabled on this process. ' +
      'It is for test isolation only and this process must not serve real users.',
  );
  return value;
}

/**
 * Unset is supported, so this only warns, and only in production, where it means no `/metrics`
 * route during an incident. A minimal valid development configuration starts silently.
 */
function readMetricsToken(env: EnvRecord, nodeEnv: NodeEnv, collect: Collector): string | null {
  const value = readOptionalSecret(env, 'METRICS_TOKEN', collect);
  if (value !== null) return value;
  if (nodeEnv === 'production') {
    collect.warnings.push(
      'METRICS_TOKEN is not set, so GET /metrics is not served. This process exports no metrics: ' +
        'latency, error rate, socket count and event-loop lag will be unavailable during an incident.',
    );
  }
  return null;
}

function readDatabase(env: EnvRecord, collect: Collector): DatabaseConfig {
  const url = requireString(env, 'DATABASE_URL', collect);
  if (url !== '' && !url.startsWith('postgres://') && !url.startsWith('postgresql://')) {
    collect.problems.push('DATABASE_URL must be a postgres:// or postgresql:// URL');
  }
  return {
    url,
    poolMax: readInt(env, 'DATABASE_POOL_MAX', { min: 1, max: 100, fallback: 10 }, collect),
    statementTimeoutMs: readInt(
      env,
      'DATABASE_STATEMENT_TIMEOUT_MS',
      { min: 100, max: 60_000, fallback: 5_000 },
      collect,
    ),
    idleTimeoutSeconds: readInt(
      env,
      'DATABASE_IDLE_TIMEOUT_SECONDS',
      { min: 1, max: 3_600, fallback: 30 },
      collect,
    ),
    connectTimeoutSeconds: readInt(
      env,
      'DATABASE_CONNECT_TIMEOUT_SECONDS',
      { min: 1, max: 120, fallback: 10 },
      collect,
    ),
  };
}

/**
 * All four OIDC variables or none. A partial set shows the sign-in button and then fails the
 * token exchange in a way that looks like the identity provider's fault.
 */
function readOidc(env: EnvRecord, collect: Collector): OidcConfig | null {
  const keys = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI'] as const;
  const present = keys.filter((key) => trimmed(env, key) !== undefined);
  if (present.length === 0) return null;
  if (present.length !== keys.length) {
    const missing = keys.filter((key) => trimmed(env, key) === undefined);
    collect.problems.push(
      `OIDC is partially configured: ${present.join(', ')} set but ${missing.join(', ')} missing. ` +
        'Set all four or none.',
    );
    return null;
  }

  const issuer = trimmed(env, 'OIDC_ISSUER') ?? '';
  const redirectUri = trimmed(env, 'OIDC_REDIRECT_URI') ?? '';
  for (const [key, value] of [
    ['OIDC_ISSUER', issuer],
    ['OIDC_REDIRECT_URI', redirectUri],
  ] as const) {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
        collect.problems.push(`${key} must use https (localhost excepted for development)`);
      }
    } catch {
      collect.problems.push(`${key} must be an absolute URL, got "${value}"`);
    }
  }

  return {
    issuer,
    clientId: trimmed(env, 'OIDC_CLIENT_ID') ?? '',
    clientSecret: trimmed(env, 'OIDC_CLIENT_SECRET') ?? '',
    redirectUri,
  };
}

/** In the order the refusal message lists them. */
const COHORT_ENTRIES = ['both', 'oidc', 'guest'] as const;

/** Defaults to `both`. See `CohortConfig`. */
function readCohortEntry(env: EnvRecord, collect: Collector): CohortEntry {
  const value = trimmed(env, 'COHORT_ENTRY');
  if (value === undefined) return 'both';
  const lowered = value.toLowerCase();
  const found = COHORT_ENTRIES.find((entry) => entry === lowered);
  if (found === undefined) {
    collect.problems.push(`COHORT_ENTRY must be one of ${COHORT_ENTRIES.join(', ')}, got "${value}"`);
    return 'both';
  }
  return found;
}

/** In the order the refusal message lists them. */
const ENROLMENT_REQUIREMENTS = ['off', 'enforced'] as const;

/**
 * Defaults to `off`. An unrecognised value refuses to boot, because the realistic typo is `true`
 * or `on` from an operator who meant to enforce, and falling back to `off` would leave tables open.
 */
function readEnrolmentRequirement(env: EnvRecord, collect: Collector): EnrolmentRequirement {
  const value = trimmed(env, 'PRL_ENROLMENT_REQUIRED');
  if (value === undefined) return 'off';
  const lowered = value.toLowerCase();
  const found = ENROLMENT_REQUIREMENTS.find((entry) => entry === lowered);
  if (found === undefined) {
    collect.problems.push(
      `PRL_ENROLMENT_REQUIRED must be one of ${ENROLMENT_REQUIREMENTS.join(', ')}, got "${value}". ` +
        'It is not a boolean: "enforced" means a learner needs a live enrolment to take a seat, ' +
        '"off" means seating is open to anybody with a session.',
    );
    return 'off';
  }
  return found;
}

/**
 * OIDC requests one learner makes per window. The start and the callback count on separate
 * routes, and the second unit is room for one retried start (a stale tab or re-consent).
 */
const OIDC_REQUESTS_PER_LEARNER = 2;

/**
 * Refuses to boot when a declared cohort cannot get in. A warning logged days before class would
 * not be read, and the shipped defaults let fifteen of thirty learners in from one address.
 * Nothing is raised automatically, because thirty guest accounts a minute from one address is a
 * security decision for the operator. `COHORT_ENTRY=oidc` keeps the tight guest default.
 */
function checkCohortSizing(
  cohort: CohortConfig,
  rateLimit: RateLimitConfig,
  oidcConfigured: boolean,
  collect: Collector,
): void {
  if (cohort.size === 0) return;

  const windowSeconds = Math.round(rateLimit.oidcWindowMs / 1_000);
  const wantsOidc = cohort.entry === 'oidc' || cohort.entry === 'both';
  const wantsGuest = cohort.entry === 'guest' || cohort.entry === 'both';

  if (wantsOidc && !oidcConfigured) {
    collect.problems.push(
      `COHORT_ENTRY=${cohort.entry} declares that a cohort of ${cohort.size} signs in through an ` +
        'identity provider, but OIDC is not configured on this process. Set OIDC_ISSUER, ' +
        'OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and OIDC_REDIRECT_URI, or set COHORT_ENTRY=guest.',
    );
  }

  if (wantsOidc && oidcConfigured) {
    const needed = cohort.size * OIDC_REQUESTS_PER_LEARNER;
    if (rateLimit.oidcMax < needed) {
      collect.problems.push(
        `RATE_LIMIT_OIDC_MAX is ${rateLimit.oidcMax}, which cannot serve the declared ` +
          `COHORT_SIZE of ${cohort.size}. Every learner behind one address shares this budget, ` +
          `and each needs ${OIDC_REQUESTS_PER_LEARNER} requests per ${windowSeconds}s window ` +
          `(a sign-in start plus one retry), so it must be at least ${needed}. Raise it, or ` +
          'lower COHORT_SIZE to what one egress address really carries.',
      );
    }
  }

  if (wantsGuest && rateLimit.guestMax < cohort.size) {
    collect.problems.push(
      `RATE_LIMIT_GUEST_MAX is ${rateLimit.guestMax}, which cannot serve the declared ` +
        `COHORT_SIZE of ${cohort.size}. Guest creation is a different case from sign-in and the ` +
        'shipped default of 10 is deliberately tight: every attempt on that endpoint SUCCEEDS, ' +
        'so there is no failed outcome to charge and the successful creations are themselves the ' +
        `abuse. Raising it to ${cohort.size} accepts that ${cohort.size} accounts a minute can be ` +
        'created from that address, which is only reasonable for an ingress you control. If this ' +
        'cohort signs in through the identity provider instead, set COHORT_ENTRY=oidc and leave ' +
        'guest creation at its public default.',
    );
  }
}

/**
 * The failure budget must stay below the OIDC ceiling, or it can never refuse anything.
 * Checked on every boot, outside `checkCohortSizing`, which returns early when `COHORT_SIZE` is 0.
 * Inside it, `RATE_LIMIT_OIDC_FAILURE_MAX=10000` with a ceiling of 60 booted cleanly.
 */
function checkSignInBudgets(rateLimit: RateLimitConfig, collect: Collector): void {
  if (rateLimit.oidcFailureMax >= rateLimit.oidcMax) {
    collect.problems.push(
      `RATE_LIMIT_OIDC_FAILURE_MAX (${rateLimit.oidcFailureMax}) is not below RATE_LIMIT_OIDC_MAX ` +
        `(${rateLimit.oidcMax}), so it can never refuse anything the ceiling has not refused ` +
        'already. It is the budget that separates a classroom from a script: the ceiling is sized ' +
        'for the cohort and this one is sized for the abuse, and raising them together throws away ' +
        'the whole distinction.',
    );
  }
}

/**
 * Leaves a core for the event loop and never exceeds four, because equity work is CPU-bound and a
 * larger pool turns one expensive request into latency for every other.
 */
function defaultMonteCarloWorkers(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** Pure, with no I/O and no process access. */
export function loadConfig(env: EnvRecord): AppConfig {
  const collect: Collector = { problems: [], warnings: [] };

  const nodeEnv = readNodeEnv(env, collect);
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const webOrigins = readWebOrigins(env, nodeEnv, collect);
  const sessionCookieSecret = readSessionCookieSecret(env, nodeEnv, collect);

  const cookieSecure = readBoolean(env, 'COOKIE_SECURE', isProduction, collect);
  if (isProduction && !cookieSecure) {
    collect.problems.push(
      'COOKIE_SECURE=false is not allowed in production: a session cookie without the ' +
        'Secure attribute can be read from a single plaintext request',
    );
  }

  // Hoisted because the proxy warning needs it before the literal exists.
  const host = trimmed(env, 'HOST') ?? '127.0.0.1';

  const trustProxy = readBoolean(env, 'TRUST_PROXY', false, collect);
  if (trustProxy) {
    collect.warnings.push(
      'TRUST_PROXY is enabled: X-Forwarded-For is believed. Ensure this process is ' +
        'only reachable through a proxy that overwrites that header.',
    );
  }

  // Behind a reverse proxy with TRUST_PROXY off, `request.ip` is the proxy for every browser, so
  // guest creation and OIDC share one address-keyed bucket for the whole deployment. Binding every
  // interface usually means a container behind a proxy. A heuristic, so a warning.
  const bindsAllInterfaces = host === '0.0.0.0' || host === '::';
  if (!trustProxy && bindsAllInterfaces) {
    collect.warnings.push(
      'TRUST_PROXY is off while HOST binds every interface. If a reverse proxy is in front of ' +
        'this process, every client shares one address-keyed rate-limit bucket, so guest sign-in ' +
        'and OIDC are limited for the whole deployment at once. Set TRUST_PROXY=true and make the ' +
        'proxy overwrite X-Forwarded-For, or bind a loopback address.',
    );
  }

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    isTest,

    port: readInt(env, 'PORT', { min: 1, max: 65_535, fallback: 3001 }, collect),
    // 127.0.0.1 by default, so a development server is not reachable from the local network.
    host,
    logLevel: readLogLevel(env, nodeEnv, collect),

    webOrigins,
    sessionCookieSecret,
    cookieSecure,

    database: readDatabase(env, collect),

    oidcEnabled: false,
    oidc: null,

    // 500_000 matches `equityBodySchema`, so a request the schema accepts is never clamped.
    monteCarloMaxSamples: readInt(
      env,
      'MONTE_CARLO_MAX_SAMPLES',
      { min: 1_000, max: 500_000, fallback: 200_000 },
      collect,
    ),
    monteCarloWorkers: readInt(
      env,
      'MONTE_CARLO_WORKERS',
      { min: 1, max: 32, fallback: defaultMonteCarloWorkers() },
      collect,
    ),
    coachTimeoutMs: readInt(env, 'COACH_TIMEOUT_MS', { min: 100, max: 30_000, fallback: 3_000 }, collect),

    // Wider than the per-room `action_timeout_seconds` (5..300, `repositories/rooms.ts`) because
    // this is a floor on top of it. The lower bound of 5 turns the floor off.
    learnerTurnSeconds: readInt(
      env,
      'LEARNER_TURN_SECONDS',
      { min: 5, max: 900, fallback: DEFAULT_LEARNER_TURN_SECONDS },
      collect,
    ),

    rateLimit: {
      globalMax: readInt(env, 'RATE_LIMIT_MAX', { min: 1, max: 100_000, fallback: 300 }, collect),
      globalWindowMs: readInt(
        env,
        'RATE_LIMIT_WINDOW_MS',
        { min: 1_000, max: 3_600_000, fallback: 60_000 },
        collect,
      ),
      expensiveMax: readInt(env, 'RATE_LIMIT_EXPENSIVE_MAX', { min: 1, max: 10_000, fallback: 20 }, collect),
      expensiveWindowMs: readInt(
        env,
        'RATE_LIMIT_EXPENSIVE_WINDOW_MS',
        { min: 1_000, max: 3_600_000, fallback: 60_000 },
        collect,
      ),
      guestMax: readInt(env, 'RATE_LIMIT_GUEST_MAX', { min: 1, max: 10_000, fallback: 10 }, collect),
      guestWindowMs: readInt(
        env,
        'RATE_LIMIT_GUEST_WINDOW_MS',
        { min: 1_000, max: 3_600_000, fallback: 60_000 },
        collect,
      ),
      // 60 = 30 learners x 2 requests, the arithmetic `checkCohortSizing` enforces. The shipped 15
      // refused fifteen of a class of thirty. The anti-abuse limit is `oidcFailureMax`.
      oidcMax: readInt(env, 'RATE_LIMIT_OIDC_MAX', { min: 1, max: 10_000, fallback: 60 }, collect),
      oidcWindowMs: readInt(
        env,
        'RATE_LIMIT_OIDC_WINDOW_MS',
        { min: 1_000, max: 3_600_000, fallback: 60_000 },
        collect,
      ),
      oidcFailureMax: readInt(
        env,
        'RATE_LIMIT_OIDC_FAILURE_MAX',
        { min: 1, max: 10_000, fallback: 15 },
        collect,
      ),
      banAfter: readInt(env, 'RATE_LIMIT_BAN_AFTER', { min: 0, max: 100_000, fallback: 200 }, collect),
    },

    cohort: {
      // 0 means nothing declared. See `CohortConfig`.
      size: readInt(env, 'COHORT_SIZE', { min: 0, max: 10_000, fallback: 0 }, collect),
      entry: readCohortEntry(env, collect),
    },

    enrolmentRequired: readEnrolmentRequirement(env, collect),

    metricsToken: readMetricsToken(env, nodeEnv, collect),
    rateLimitResetToken: readRateLimitResetToken(env, nodeEnv, collect),

    trustProxy,

    // The largest legitimate body is a Monte Carlo request with five ranges.
    bodyLimitBytes: readInt(
      env,
      'BODY_LIMIT_BYTES',
      { min: 1_024, max: 1_048_576, fallback: 65_536 },
      collect,
    ),
    requestTimeoutMs: readInt(
      env,
      'REQUEST_TIMEOUT_MS',
      { min: 1_000, max: 120_000, fallback: 20_000 },
      collect,
    ),
    shutdownGraceMs: readInt(env, 'SHUTDOWN_GRACE_MS', { min: 100, max: 120_000, fallback: 10_000 }, collect),

    warnings: collect.warnings,
  };

  const oidc = readOidc(env, collect);

  // After `readOidc`, because a cohort's servability depends on OIDC, and before the throw so a
  // sizing problem is reported with every other one.
  checkCohortSizing(config.cohort, config.rateLimit, oidc !== null, collect);

  // Unconditional. See `checkSignInBudgets`.
  checkSignInBudgets(config.rateLimit, collect);

  if (collect.problems.length > 0) throw new ConfigError(collect.problems);

  // Rebuilt rather than mutated, so `oidcEnabled` cannot drift from `oidc`.
  return Object.freeze({
    ...config,
    oidcEnabled: oidc !== null,
    oidc,
    rateLimit: Object.freeze(config.rateLimit),
    cohort: Object.freeze(config.cohort),
    database: Object.freeze(config.database),
    webOrigins: Object.freeze(config.webOrigins),
    warnings: Object.freeze(config.warnings),
  });
}

let cached: AppConfig | null = null;

/** Memoised, so the random development secret is stable within one process. */
export function getConfig(): AppConfig {
  cached ??= loadConfig(process.env);
  return cached;
}
