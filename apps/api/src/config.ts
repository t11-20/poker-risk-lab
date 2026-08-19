/**
 * Configuration: parsed, validated and frozen once, at startup.
 *
 * ## Why this is a single fail-fast parse and not `process.env.X` at the point of use
 *
 * A server that reads `process.env.PORT` in one file and `process.env.DATABASE_URL`
 * in another boots happily with half a configuration and then fails at 3am on the
 * first request that touches the missing half. Worse, a typo in a security-relevant
 * variable (`SESSION_COOKE_SECRET`) silently reads as `undefined`, and a plugin that
 * treats `undefined` as "feature off" quietly disables cookie signing.
 *
 * So: every variable is read here, once. Every problem is collected and reported
 * together — one boot, one complete list of what is wrong — and the result is frozen
 * so nothing can mutate configuration after the fact.
 *
 * ## Why the checks are stricter in production
 *
 * Development needs to be pleasant: a missing `SESSION_COOKIE_SECRET` gets a random
 * one for this process. Production needs to be safe: the same missing value is a
 * refusal to start. Every place the two diverge is marked, because "it worked on my
 * machine" is exactly the failure mode this file exists to prevent.
 *
 * ## Nothing here reads a file or opens a socket
 *
 * `loadConfig(env)` is a pure function of the environment record it is handed, which
 * is what makes the config tests possible without a live process environment. The
 * process-wide singleton (`getConfig()`) is a thin memoised wrapper over it.
 */

import { randomBytes } from 'node:crypto';
import { availableParallelism } from 'node:os';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** Pino's levels, plus `silent`. Kept as a local union so config does not import pino. */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The shortest turn clock a person alone at a table of bots is given, in seconds.
 *
 * ## Why this number exists at all
 *
 * The product has two headline features and, at a 60-second clock, they are in direct
 * tension: you cannot read the analysis and still act. A browser-level verification pass
 * lost two hands to `seat 0 | fold | was_automatic = t` while the learner was reading the
 * Coach panel, which for a live flop runs to roughly **5,700 characters** of prose plus a
 * five-row EV table and a card-by-card table with one row per unseen card. At 200-250
 * words per minute — and slower for dense numeric material — the prose alone is around
 * four minutes of reading before a single table is looked at.
 *
 * Nothing about that was hidden: the countdown is on screen, and folding rather than
 * calling on expiry is the correct rule (`timeoutAction` in `@prl/poker-engine`). The
 * clock was simply shorter than the thing it was asking the learner to read.
 *
 * ## Why 240 and not something else
 *
 * It is the reading time of the panel, rounded to a whole number of minutes. Not longer,
 * because the clock still has a job — the number below is a floor on how long an
 * abandoned seat can hold a table, and every extra minute is a minute the other players
 * wait. Not shorter, because a clock that expires mid-panel is the defect this replaces.
 *
 * ## Why it is free, and where it therefore stops applying
 *
 * The cost of a longer clock is other people's patience, and at a table of bots there is
 * nobody to be patient: this is play money against bots with nothing at stake. That is the
 * whole justification, so `LiveTable.turnSecondsFor` applies it only where the
 * justification holds — a person with no other person waiting on them. A room with two
 * humans in it keeps the pace they agreed to, and can configure up to 300 seconds of it
 * for itself (`repositories/rooms.ts`). It is also a floor rather than a replacement: a
 * room that already allows longer keeps what it chose.
 *
 * ## Why a longer clock rather than "no clock until the learner has acted once"
 *
 * The alternative considered was leaving the first decision of a hand untimed. It was
 * rejected: the first decision is precisely when a seat is most likely to have been
 * abandoned — the tab was closed before the hand started — so an untimed first action
 * lets one absent player stall a table indefinitely, which is a worse failure than a
 * clock that is too short. The timeout mechanism stays; only its floor moves.
 *
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
   * How far past the limit a caller may go before being blocked outright rather than
   * merely told to slow down. Blunts a script that ignores `retryAfterSeconds`.
   */
  readonly banAfter: number;
}

export interface DatabaseConfig {
  readonly url: string;
  /** Upper bound on server-side connections. See the pool note in `db.ts`. */
  readonly poolMax: number;
  /** Per-statement ceiling. A query that exceeds it is cancelled by Postgres. */
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
   * Exact allowlist of browser origins, normalised to `scheme://host[:port]`.
   * Used for CORS and for the WebSocket `Origin` check — one list, so the two can
   * never disagree about who is allowed to talk to this server.
   */
  readonly webOrigins: readonly string[];

  /** Secret used to sign cookies. Never logged, never returned by any route. */
  readonly sessionCookieSecret: string;
  /**
   * Whether cookies get the `Secure` attribute. Always true in production; a
   * production boot with this false is refused, because a session cookie without
   * `Secure` is one plaintext request away from being stolen.
   */
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
   * Floor on the turn clock of a person alone at a table of bots, in seconds.
   *
   * Bots keep the room's own setting, and so does a table with a second person at it. A
   * room configured with a longer clock than this keeps it — the floor only raises a clock
   * that is shorter than the Coach panel takes to read. See `DEFAULT_LEARNER_TURN_SECONDS`
   * for the reasoning and `LiveTable.turnSecondsFor` for exactly where it applies.
   */
  readonly learnerTurnSeconds: number;

  readonly rateLimit: RateLimitConfig;

  /**
   * Whether to believe `X-Forwarded-For`.
   *
   * SECURITY: enabling this makes `request.ip` client-controlled unless a trusted
   * proxy overwrites the header on the way in. A forged header defeats IP-based rate
   * limiting and poisons the hashed client key in the logs, so leave it false unless
   * this process is genuinely unreachable except through a proxy you control.
   */
  readonly trustProxy: boolean;

  /** Largest request body accepted, in bytes. */
  readonly bodyLimitBytes: number;
  /** How long a single request may take before the socket is closed. */
  readonly requestTimeoutMs: number;
  /** How long a shutdown waits for in-flight requests before giving up. */
  readonly shutdownGraceMs: number;

  /**
   * Non-fatal observations from parsing — insecure-but-tolerated development
   * settings, defaults that were substituted. `server.ts` logs these at boot so a
   * surprising default is visible rather than silent.
   */
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

/** The shape `process.env` has, without depending on it. */
export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * Values that must never be accepted as a real secret. A secret that ships in an
 * example file, a README or a tutorial is public knowledge the moment it is written
 * down, and "we meant to change it before launch" is how sessions get forged.
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

/** Minimum secret length. 32 base64url characters carry ~192 bits; 32 bytes is the floor. */
const MIN_SECRET_LENGTH = 32;
/** Below this many distinct characters, a "long" secret is really a short one repeated. */
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
  // Number() rather than parseInt(): parseInt('3001abc') is 3001, which silently
  // accepts a typo. Number('3001abc') is NaN, which we can report.
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
    // The includes() check above is the narrowing; find() keeps that provable to the
    // compiler without a cast.
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
  if (match !== undefined) return match;
  collect.problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${value}"`);
  return fallback;
}

/**
 * Normalises one origin to `scheme://host[:port]` and rejects anything that is not
 * an origin.
 *
 * A configured "origin" with a path or a trailing slash is the classic way an
 * allowlist comparison starts failing silently: the browser sends
 * `https://app.example` and the config holds `https://app.example/`, they never
 * match, and CORS mysteriously stops working. Reject it at boot instead.
 *
 * The host shape is checked for the same reason, and it is worth spelling out why an
 * entry that can never match is a problem rather than merely useless. Matching is exact
 * (`isAllowedOrigin` in `plugins/security.ts`), so `https://*.example` matches nothing
 * and the system fails closed — but it fails closed *silently*: the operator sees every
 * CORS request refused and every WebSocket closed with 4406, with no diagnostic naming
 * the cause, and `.env.example` told them a wildcard would be rejected at boot. It says
 * so because that is the right behaviour, and now it is the actual behaviour. There is
 * also one case where a wildcard is worse than inert: `safeRedirectTarget`
 * (`auth/oidc.ts`) uses `webOrigins[0]`, so a wildcard in first position produces a
 * broken post-sign-in redirect.
 *
 * A trailing dot goes the same way. `https://app.example.` is the fully-qualified form
 * of the same name and resolves to the same server, but `URL` keeps the dot and the
 * browser sends the origin without it, so it is a second spelling that matches nothing.
 * This is the trailing-slash mistake in the host instead of the path.
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
 * Reads the cookie-signing secret, with the production/development split spelled out.
 *
 * Production: must be present, long, and not recognisably a placeholder.
 * Elsewhere: a missing secret is replaced with a fresh random one for this process
 * (sessions do not survive a restart, which is noisy but safe), and a short secret is
 * tolerated with a warning so tests can use a fixed literal.
 */
function readSessionCookieSecret(env: EnvRecord, nodeEnv: NodeEnv, collect: Collector): string {
  const value = trimmed(env, 'SESSION_COOKIE_SECRET');
  const isProduction = nodeEnv === 'production';

  if (value === undefined) {
    if (isProduction) {
      collect.problems.push(
        'SESSION_COOKIE_SECRET is required in production; generate one with ' +
          "`node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"`",
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
 * OIDC is all-or-nothing.
 *
 * Three of four variables present is the dangerous state: the sign-in button appears,
 * the redirect happens, and the token exchange fails in a way that looks like the
 * identity provider's fault. Either the whole flow is configured or the feature is
 * off and `oidc_not_configured` is returned honestly.
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

/**
 * Default worker count: leave a core for the event loop, and never spawn more than
 * four. Equity work is CPU-bound, and a pool larger than the machine turns one
 * expensive request into latency for every other request.
 */
function defaultMonteCarloWorkers(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

/** Parses and validates an environment record. Pure: no I/O, no process access. */
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

  const trustProxy = readBoolean(env, 'TRUST_PROXY', false, collect);
  if (trustProxy) {
    collect.warnings.push(
      'TRUST_PROXY is enabled: X-Forwarded-For is believed. Ensure this process is ' +
        'only reachable through a proxy that overwrites that header.',
    );
  }

  const config: AppConfig = {
    nodeEnv,
    isProduction,
    isTest,

    port: readInt(env, 'PORT', { min: 1, max: 65_535, fallback: 3001 }, collect),
    // 127.0.0.1 rather than 0.0.0.0: binding every interface by default is how a
    // development server ends up reachable from the local network. Deployments that
    // need it (containers) set HOST explicitly.
    host: trimmed(env, 'HOST') ?? '127.0.0.1',
    logLevel: readLogLevel(env, nodeEnv, collect),

    webOrigins,
    sessionCookieSecret,
    cookieSecure,

    database: readDatabase(env, collect),

    oidcEnabled: false,
    oidc: null,

    // 500_000 matches the ceiling in `equityBodySchema`. Keeping them equal means a
    // request the schema accepts is never silently clamped by a lower server limit.
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

    // The bounds are wider than `prl.rooms.action_timeout_seconds` accepts (5..300,
    // `repositories/rooms.ts`) on purpose: this is not a room setting, it is the floor
    // applied on top of one, and a deployment that wants to give a learner ten minutes
    // with the panel should not be blocked by a limit written for the per-room field.
    // The lower bound matches that field's, so setting this to 5 turns the floor off
    // rather than making it unreachable.
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
      banAfter: readInt(env, 'RATE_LIMIT_BAN_AFTER', { min: 0, max: 100_000, fallback: 200 }, collect),
    },

    trustProxy,

    // 64 KiB is generous for this API: the largest legitimate body is a Monte Carlo
    // request with five ranges. Anything larger is a mistake or an attempt to make
    // the JSON parser do the attacking.
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

  if (collect.problems.length > 0) throw new ConfigError(collect.problems);

  // Rebuilt rather than mutated so the exported object is genuinely immutable, and so
  // `oidcEnabled` cannot drift from `oidc`.
  return Object.freeze({
    ...config,
    oidcEnabled: oidc !== null,
    oidc,
    rateLimit: Object.freeze(config.rateLimit),
    database: Object.freeze(config.database),
    webOrigins: Object.freeze(config.webOrigins),
    warnings: Object.freeze(config.warnings),
  });
}

let cached: AppConfig | null = null;

/**
 * The process-wide configuration, parsed on first use.
 *
 * Memoised so that `loadConfig` runs exactly once even though several modules ask
 * for it, and so the random development secret is stable within one process.
 */
export function getConfig(): AppConfig {
  cached ??= loadConfig(process.env);
  return cached;
}

/** Test seam: drops the memoised config so a later `getConfig()` re-parses. */
export function resetConfigForTests(): void {
  cached = null;
}
