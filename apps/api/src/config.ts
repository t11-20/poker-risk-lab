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
   * Guest-session creation, per window. Address-keyed rather than session-keyed — see the
   * long note above `clientKeyedRateLimit` in `plugins/security.ts` for why a route that
   * *issues* a session cannot be limited by that session.
   *
   * Configurable rather than a literal because it is the one limit whose correct value
   * genuinely differs by deployment: a public instance wants the shipped default, while a
   * CI job or a staging smoke run drives the same address far harder than any person does
   * and has no abuse risk to speak of. Before this was configurable, `RATE_LIMIT_MAX` in CI
   * raised only the global bucket and had no effect here, so the one limit a test run
   * actually hits was the one it could not tune.
   */
  readonly guestMax: number;
  readonly guestWindowMs: number;
  /**
   * The CEILING on `/auth/oidc/start` and, separately, on `/auth/oidc/callback`, per window,
   * per address. Address-keyed for the same reason as guests.
   *
   * Sized for a classroom rather than for a person, because these are the two requests a whole
   * cohort makes in the same ten seconds and they all arrive from one campus egress address.
   * The arithmetic is in `.env.example`: at least two per learner, a start plus one retry.
   *
   * This is deliberately NOT the anti-abuse control any more — `oidcFailureMax` below is. A
   * ceiling that a cohort must fit under cannot also be the number that stops a script, which is
   * what the shipped 15 was trying to be and why fifteen of thirty learners were refused.
   */
  readonly oidcMax: number;
  readonly oidcWindowMs: number;
  /**
   * OIDC requests per window per address that END IN AN ERROR — a start that could not reach the
   * provider, a callback whose state, PKCE, issuer or token exchange did not check out.
   *
   * This is the tight one, and the one an abusive caller actually meets: completing a sign-in
   * needs an authorization code only the identity provider can mint, so a script's every attempt
   * lands here while a cohort's attempts never do. Shares `oidcWindowMs` with the ceiling above,
   * because two windows on one route would give `Retry-After` two answers.
   *
   * The default is 15 — the same number the shipped `RATE_LIMIT_OIDC_MAX` was, and not a
   * coincidence: 15 failed callbacks per address per minute is exactly what the shipped
   * configuration permitted (measured), so splitting the budget in two does not loosen the
   * expensive path at all. It only stops a cohort's SUCCESSES from spending it.
   */
  readonly oidcFailureMax: number;
  /**
   * How far past the limit a caller may go before being blocked outright rather than
   * merely told to slow down. Blunts a script that ignores `retryAfterSeconds`.
   */
  readonly banAfter: number;
}

/**
 * Which doors a declared cohort comes through.
 *
 * `both` is the default because it is the safe one: it checks every entrance, so an operator who
 * declares a cohort and forgets that half the class clicks "Play as guest" is told at boot rather
 * than by thirty students at once. Narrowing it is an explicit act.
 */
export type CohortEntry = 'oidc' | 'guest' | 'both';

/**
 * The operator's declaration of how many learners arrive together from ONE address.
 *
 * ## Why this exists at all, rather than just a comment in `.env.example`
 *
 * Every limit that a classroom trips is address-keyed, and it has to be: `POST /auth/guest` and
 * `GET /auth/oidc/callback` both ISSUE a session, so a session-keyed limit on them never
 * accumulates (measured — see `clientKeyedRateLimit` in `plugins/security.ts`). That makes a
 * campus, office or VPN egress address a single caller as far as every one of these limits is
 * concerned, and it makes the correct SIZE of those limits a fact about the deployment that this
 * process cannot discover for itself.
 *
 * An operator who gets it wrong does not find out from a log line. They find out from a cohort:
 * against the shipped defaults, thirty learners signing in through the identity provider from one
 * address produced fifteen sign-ins and fifteen 429s, the first at learner sixteen. That is a
 * discovery made in front of paying students, once, and it is the reason this is a boot refusal
 * in the same style as `RATE_LIMIT_RESET_TOKEN` rather than a warning.
 *
 * ## Why it is a declaration rather than an inference
 *
 * The limits could have been raised until nothing plausible trips them, which is the shape of fix
 * that quietly hands a script the same headroom. Instead the operator says how big the class is,
 * and `checkCohortSizing` refuses to boot when the configured limits cannot serve it. Nothing is
 * raised automatically: declaring a cohort of thirty tells you that guest creation is set to ten,
 * it does not set it to thirty behind your back. What the limits permit stays something a person
 * chose and can be held to.
 *
 * Unset (`0`) means "no cohort is declared", the shipped defaults apply and nothing is checked —
 * which is right for a public instance, where thirty accounts a minute from one address is not a
 * classroom.
 */
export interface CohortConfig {
  /** Learners expected to arrive together from one address. `0` when nothing was declared. */
  readonly size: number;
  /** Which sign-in doors that cohort uses. Only the declared ones are size-checked. */
  readonly entry: CohortEntry;
}

/**
 * Whether a live enrolment is required to take a seat at a table (`PRL_ENROLMENT_REQUIRED`).
 *
 * ## What it gates, and what it deliberately does not
 *
 * `enforced` means one thing: `RoomRegistry.sitAtTable` refuses a learner for whom
 * `enrolments.entitlementFor` answers null, with `enrolment_required`. It gates TAKING A SEAT and
 * nothing else. `/learn`, the Lab, the glossary, the Legends pages, creating a room, joining one
 * by invite code and watching a table from a socket all stay exactly as open as they were, because
 * that is the surface a prospective student browses and gating it would be gating the shop window
 * rather than the course.
 *
 * ## Why the default is `off`, and why that does not make this decoration
 *
 * An open public instance is a legitimate deployment of this product — most of what it teaches is
 * free reading — and every deployment that exists today runs without an enrolment table having
 * meant anything. A default of `enforced` would turn one migration into an outage for all of them.
 *
 * The usual cost of a default-off guard is that nobody ever sees it refuse, so it rots. That is
 * closed by running staging with it ON: `docker-compose.staging.yml` sets `enforced` on the api
 * service, and `scripts/smoke-test.mjs` section 13 drives both directions over TLS — an enrolled
 * learner seated, an unenrolled one refused, over REST and over the socket — on every
 * `pnpm run staging up`. The switch's `off` behaviour is covered by the unit tests, which run the
 * whole matrix regardless of what any deployment is set to.
 *
 * ## Why an enum of two rather than a boolean
 *
 * `readBoolean` accepts `true/1/yes` and `false/0/no`, and this is a value an operator will one
 * day want a third setting for — "warn but allow", to find out how many learners a cohort list
 * missed before the class starts. A boolean would have to be replaced to get there; an enum gets
 * a value added. Nothing here promises that third value exists, and adding one means writing what
 * it does at the refusal site.
 */
export type EnrolmentRequirement = 'off' | 'enforced';

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

  /** The declared classroom behind one address, and which doors it uses. See `CohortConfig`. */
  readonly cohort: CohortConfig;

  /**
   * Whether a live enrolment is required to TAKE A SEAT at a table. See `EnrolmentRequirement`.
   *
   * Read by `routes/index.ts`, which binds the registry's entitlement port accordingly. Nothing
   * else in the process reads it, and nothing else may: a second reader is a second place for the
   * enforcement decision to be made, and one of them would eventually be the one nobody looks at.
   */
  readonly enrolmentRequired: EnrolmentRequirement;

  /**
   * Whether to believe `X-Forwarded-For`.
   *
   * SECURITY: enabling this makes `request.ip` client-controlled unless a trusted
   * proxy overwrites the header on the way in. A forged header defeats IP-based rate
   * limiting and poisons the hashed client key in the logs, so leave it false unless
   * this process is genuinely unreachable except through a proxy you control.
   */
  readonly trustProxy: boolean;

  /**
   * Bearer token required to scrape `GET /metrics`, or null when the endpoint is off.
   *
   * A metrics endpoint is an information disclosure surface: route names, error-code
   * frequencies, live connection counts and process uptime together describe both the shape
   * of the deployment and how loaded it is. So it is authenticated, and it is authenticated
   * with a token rather than a session because the caller is a scraper, not a person.
   *
   * Absent means the route is never registered at all in production — not registered and
   * answering 403, which would still confirm the service is this application. In development
   * the route is registered without a token, and a boot warning says so.
   */
  readonly metricsToken: string | null;

  /**
   * Token that enables the rate-limit reset control, or null.
   *
   * Test isolation, and nothing else. See `RATE_LIMIT_RESET_PATH` in `plugins/security.ts`
   * for what it does and `readRateLimitResetToken` below for why a production process
   * carrying this variable REFUSES TO START rather than warning.
   */
  readonly rateLimitResetToken: string | null;

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

/**
 * Checks an operator-supplied secret that is optional but, when present, must be real.
 *
 * Shares the rules `readSessionCookieSecret` applies in production — length, distinct
 * characters, no placeholder words — because a token that guards a scrape endpoint or a
 * test control is not less of a credential than a cookie key. It is a separate function
 * rather than a refactor of that one because the two differ in the case that matters: a
 * missing `SESSION_COOKIE_SECRET` is fatal in production and substituted elsewhere, while a
 * missing value here simply means the feature is off.
 *
 * Applied in EVERY environment, not just production. The session secret is lenient outside
 * production so that a fixed literal can be used in tests; these tokens have no such need,
 * and a weak one in development is a weak one in the staging environment that copied the
 * `.env` from it.
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
 * Reads the rate-limit reset token, and refuses to start production if one is present.
 *
 * ## Why this is a refusal and not a warning
 *
 * The control this token unlocks empties the rate limiter's counters. Anyone holding the
 * token can therefore issue unlimited guest sessions, unlimited Monte Carlo requests and
 * unlimited sign-in attempts, by resetting between bursts — which is to say the token is
 * equivalent to turning rate limiting off, for its holder, everywhere.
 *
 * A control with that reach cannot be governed by an operator's intention to keep it out of
 * production. It has to be *impossible* there, because the realistic failure is not somebody
 * deciding to enable it: it is a `.env` copied from staging to production with one variable
 * nobody re-read. So the check is at boot, it is fatal, and there is deliberately no
 * override variable — an escape hatch with an escape hatch is just a warning again.
 *
 * The cost is real and accepted: a production-`NODE_ENV` staging deployment cannot use this
 * control, and the smoke harness there falls back to waiting out the window it consumed
 * (`scripts/smoke-test.mjs`). That fallback is slower and it is honest, which is the right
 * trade against a token that can disable a security control in production.
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
 * Reads the metrics scrape token.
 *
 * Unset is a supported posture — see `metricsToken` on `AppConfig` — so this warns rather
 * than refusing, and only in production, where the consequence is real: no `/metrics` route
 * at all, and therefore no latency, error rate, socket count or event-loop lag to look at
 * during an incident. Outside production the endpoint is served openly, which is the
 * expected development behaviour and not worth a line on every boot; a minimal valid
 * configuration is supposed to start silently.
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

/** The three legal values of `COHORT_ENTRY`, in the order the refusal message lists them. */
const COHORT_ENTRIES = ['both', 'oidc', 'guest'] as const;

/** Parses `COHORT_ENTRY`. Defaults to the safe value, `both`; see `CohortConfig`. */
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

/** The legal values of `PRL_ENROLMENT_REQUIRED`, in the order the refusal message lists them. */
const ENROLMENT_REQUIREMENTS = ['off', 'enforced'] as const;

/**
 * Parses `PRL_ENROLMENT_REQUIRED`. Defaults to `off`; see `EnrolmentRequirement`.
 *
 * An unrecognised value is a boot refusal rather than a fallback to the default, and the direction
 * matters more here than for most of this file. The realistic typo is `PRL_ENROLMENT_REQUIRED=true`
 * or `=on` from somebody who expected a boolean — an operator who has decided to enforce and
 * believes they have. Silently taking `off` from that would leave a cohort's tables open to the
 * whole internet while the deployment's own configuration says otherwise, and nothing anywhere
 * would say so. So it names both legal values and stops the process (exit 78).
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
 * Requests one learner is expected to make against the OIDC ceiling inside one window.
 *
 * Two: the start that sends them to the identity provider, and the callback that brings them
 * back. `@fastify/rate-limit` gives each route its own counter, so the two do not in fact share a
 * bucket — but a learner who lands on a stale tab, presses back, or is bounced through a
 * re-consent screen makes a second start, and a ceiling with no room for that is a ceiling that
 * fails for the least confident student in the room. So the check demands two per learner on both
 * routes rather than one, and the spare is the retry.
 */
const OIDC_REQUESTS_PER_LEARNER = 2;

/**
 * Refuses to boot when a declared cohort cannot get in.
 *
 * ## Why this is a refusal and not a warning
 *
 * The same argument as `readRateLimitResetToken`, pointing the other way. There, a variable that
 * must never reach production is fatal because the realistic failure is a `.env` copied without
 * being re-read. Here, a limit that is too SMALL for the class it will serve is fatal because the
 * realistic failure is nobody thinking about it at all — the shipped defaults are correct for a
 * public instance and silently wrong for a classroom, and the difference is invisible until
 * thirty students are looking at it. Measured against the shipped defaults before this check
 * existed: thirty learners from one address, fifteen sign-ins, fifteen 429s.
 *
 * A warning would be logged at boot, into the same stream as everything else, days before the
 * class. It would not be read.
 *
 * ## Why nothing is raised automatically
 *
 * Declaring `COHORT_SIZE=30` does not set `RATE_LIMIT_GUEST_MAX` to thirty. It refuses to start
 * until somebody sets it, because raising it means this deployment will create thirty accounts a
 * minute for whoever is behind that address, and that is a decision with a security consequence.
 * The point of the check is to make the decision unavoidable, not to make it invisibly.
 *
 * ## Why `both` is the default entry
 *
 * `COHORT_ENTRY` narrows which doors are checked, and the default checks all of them. An operator
 * whose class signs in through the identity provider and never touches guest accounts says so
 * (`COHORT_ENTRY=oidc`) and keeps the tight public default on guest creation. An operator who
 * says nothing gets both checked, which costs them one line of configuration and cannot cost them
 * a room full of refused students.
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
 * The failed-outcome budget must stay below the ceiling. Checked on EVERY boot.
 *
 * ## Why this is not inside `checkCohortSizing`, which is where it used to live
 *
 * It was, and an adversarial review found that `checkCohortSizing` returns immediately when
 * `COHORT_SIZE` is 0 — the shipped default, and the state `.env.example` calls the right one for a
 * public instance. So the invariant was enforced only on the deployments that had declared a
 * classroom, and not on the deployments this budget was written to protect. Measured against the
 * code as it stood: `RATE_LIMIT_OIDC_FAILURE_MAX=10000` with the default ceiling of 60 and no
 * `COHORT_SIZE` booted cleanly, while `.env.example` said in as many words that "the process
 * refuses to boot if this is not below RATE_LIMIT_OIDC_MAX".
 *
 * The two checks were never the same kind of thing. Cohort sizing asks whether the configured
 * limits can serve a class somebody declared, and has no answer when nobody declared one. This asks
 * whether the two budgets still count different things, and the answer does not depend on who is
 * signing in: a failure budget at or above the ceiling can never refuse anything the ceiling has
 * not refused already, on any deployment at all.
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

  // Hoisted out of the config literal below because two checks need it before the object
  // exists: the proxy warning here, and the literal itself.
  const host = trimmed(env, 'HOST') ?? '127.0.0.1';

  const trustProxy = readBoolean(env, 'TRUST_PROXY', false, collect);
  if (trustProxy) {
    collect.warnings.push(
      'TRUST_PROXY is enabled: X-Forwarded-For is believed. Ensure this process is ' +
        'only reachable through a proxy that overwrites that header.',
    );
  }

  /**
   * The other half of the proxy decision, which is easy to get wrong in the safe-looking
   * direction.
   *
   * `TRUST_PROXY=false` is the right default because a forged `X-Forwarded-For` defeats
   * address-based rate limiting. But behind a reverse proxy it produces a different failure
   * with the same shape: `request.ip` is then the *proxy's* address for every browser in the
   * world, so every caller lands in one bucket. The routes that key on the address rather
   * than the session — guest creation and OIDC, see `clientKeyedRateLimit` — are exactly the
   * ones that stop working: the whole deployment shares ten guest sign-ups per minute, and
   * one script exhausts it for everybody. That is a self-inflicted denial of service that
   * looks, in the logs, like the limiter working correctly.
   *
   * A process that binds every interface is almost always containerised behind something.
   * The heuristic is not proof, so this is a warning rather than a refusal — but a boot line
   * naming the consequence is worth far more than the sentence in a deployment document that
   * nobody reads at 3am.
   */
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
    // 127.0.0.1 rather than 0.0.0.0: binding every interface by default is how a
    // development server ends up reachable from the local network. Deployments that
    // need it (containers) set HOST explicitly, and get the proxy warning above.
    host,
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
      // The shipped defaults are the values these limits have always had as literals in
      // `routes/auth.ts`; making them configurable changed nothing about what a deployment
      // that sets neither variable does.
      guestMax: readInt(env, 'RATE_LIMIT_GUEST_MAX', { min: 1, max: 10_000, fallback: 10 }, collect),
      guestWindowMs: readInt(
        env,
        'RATE_LIMIT_GUEST_WINDOW_MS',
        { min: 1_000, max: 3_600_000, fallback: 60_000 },
        collect,
      ),
      // 60, raised from the 15 that shipped as a literal. That 15 was the ceiling AND the
      // anti-abuse control at once, and it could not be both: a class of thirty behind one
      // campus address needs sixty of these requests in a minute, and fifteen of them were
      // refused. 60 = 30 learners x 2 requests, which is the arithmetic `.env.example` states
      // and `checkCohortSizing` enforces against a declared COHORT_SIZE. The anti-abuse job
      // moved to `oidcFailureMax`, which did NOT move.
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
      // 0 means "nothing declared": the shipped defaults apply and nothing is size-checked,
      // which is right for a public instance where thirty accounts a minute from one address
      // is not a classroom. See `CohortConfig`.
      size: readInt(env, 'COHORT_SIZE', { min: 0, max: 10_000, fallback: 0 }, collect),
      entry: readCohortEntry(env, collect),
    },

    enrolmentRequired: readEnrolmentRequirement(env, collect),

    metricsToken: readMetricsToken(env, nodeEnv, collect),
    rateLimitResetToken: readRateLimitResetToken(env, nodeEnv, collect),

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

  // After `readOidc`, because whether an identity provider is configured is half of what makes a
  // declared cohort servable, and before the throw so a sizing problem is reported alongside
  // every other one rather than on the next boot.
  checkCohortSizing(config.cohort, config.rateLimit, oidc !== null, collect);

  // Unconditional, and deliberately not inside the call above: that one returns early when no
  // cohort is declared, which is every public instance. See `checkSignInBudgets`.
  checkSignInBudgets(config.rateLimit, collect);

  if (collect.problems.length > 0) throw new ConfigError(collect.problems);

  // Rebuilt rather than mutated so the exported object is genuinely immutable, and so
  // `oidcEnabled` cannot drift from `oidc`.
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
