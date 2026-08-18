#!/usr/bin/env node
/**
 * Blocks until PostgreSQL actually accepts a connection and answers a query, or
 * gives up with a non-zero exit code and a reason.
 *
 * This is what `pnpm run db:wait` does, and it is the middle step of
 * `pnpm run db:setup` (`db:up && db:wait && db:migrate && db:seed`).
 *
 * ## Why this is not `sleep 5`
 *
 * A freshly-created PostgreSQL container runs initdb, starts the server, shuts it
 * down, and starts it again. During that sequence the port is intermittently open
 * while the server is not ready, so anything that waits on a TCP connect — or on
 * a fixed number of seconds — will sometimes hand a half-started database to
 * `db:migrate`. The failure surfaces as a migration error, which is the wrong
 * place to look. So this opens a real connection, runs a real query, and only
 * then reports success.
 *
 * ## Why some failures are not retried
 *
 * Waiting only helps when the thing you are waiting for is on its way. "Connection
 * refused" and "the database system is starting up" are worth retrying. A wrong
 * password, or a database that does not exist, will still be wrong in thirty
 * seconds — retrying those just converts an immediate, precise error into a
 * timeout that says nothing. Those exit straight away with the fix in the message.
 *
 * ## Why the `postgres` package is imported the awkward way
 *
 * `postgres` (porsager) is a dependency of `apps/api`, not of the workspace root,
 * and `pnpm run db:wait` runs from the root. With `nodeLinker: isolated` and
 * `hoistPattern: []` there is no root-level node_modules/postgres, so a plain
 * `import 'postgres'` here fails with ERR_MODULE_NOT_FOUND. Rather than add a
 * root dependency — which would mean two places to bump the version, and a second
 * copy of a database driver in the dependency graph for the sake of one script —
 * this resolves the module through `apps/api`'s own resolution scope. That is the
 * same physical package the server uses, so this script cannot drift onto a
 * different driver version than the code it is clearing the way for.
 */

import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);

// --- options --------------------------------------------------------------

const DEFAULTS = {
  timeoutSeconds: 60,
  intervalMs: 500,
  /** Per-attempt connect timeout, in seconds, passed to the driver. */
  connectTimeoutSeconds: 5,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS, url: null, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      // `pnpm run db:wait -- --timeout 5` forwards the `--` itself; absorb it so
      // the conventional invocation is not rejected as an unknown option.
      case '--':
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-q':
      case '--quiet':
        options.quiet = true;
        break;
      case '--url':
        options.url = next();
        break;
      case '--timeout':
        options.timeoutSeconds = Number(next());
        break;
      case '--interval':
        options.intervalMs = Number(next());
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
    throw new Error('--timeout must be a positive number of seconds');
  }
  if (!Number.isFinite(options.intervalMs) || options.intervalMs < 50) {
    throw new Error('--interval must be at least 50 (milliseconds)');
  }
  return options;
}

const HELP = `
${bold('pnpm run db:wait')} — block until PostgreSQL answers a query

  Options:
    --url <conn>       connection string (default: $DATABASE_URL, then dev defaults)
    --timeout <secs>   give up after this long          (default ${DEFAULTS.timeoutSeconds})
    --interval <ms>    delay between attempts           (default ${DEFAULTS.intervalMs})
    -q, --quiet        only print the final line
    -h, --help         this text

  Connection settings are read in this order:
    1. --url
    2. DATABASE_URL
    3. POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD /
       POSTGRES_DB  (PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE are
       accepted as aliases)
    4. the dev defaults in docker-compose.yml

  Exit codes: 0 ready, 1 timed out or a non-retryable failure.
`;

/**
 * Builds the connection string.
 *
 * The dev defaults deliberately mirror docker-compose.yml exactly, so that the
 * documented first-run sequence works with no .env file at all. If you change one,
 * change the other; there is no third place these live.
 */
function connectionStringFrom(env, override) {
  if (override) return { url: override, source: '--url' };
  if (env.DATABASE_URL) return { url: env.DATABASE_URL, source: 'DATABASE_URL' };

  const host = env.POSTGRES_HOST ?? env.PGHOST ?? '127.0.0.1';
  const port = env.POSTGRES_PORT ?? env.PGPORT ?? '5432';
  const user = env.POSTGRES_USER ?? env.PGUSER ?? 'poker';
  const password = env.POSTGRES_PASSWORD ?? env.PGPASSWORD ?? 'poker-dev-only';
  const database = env.POSTGRES_DB ?? env.PGDATABASE ?? 'poker_risk_lab';
  // encodeURIComponent on both credentials: a password containing @ / : or ? is
  // legal and would otherwise be parsed as part of the host or the query string.
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return { url: `postgres://${auth}@${host}:${port}/${database}`, source: 'environment' };
}

/**
 * A printable form of the target with the password removed.
 *
 * Never print the raw connection string. This runs in CI logs, and a dev password
 * that leaks into a build log teaches everyone reading it that leaked credentials
 * are normal.
 */
function describeTarget(url) {
  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${decodeURIComponent(parsed.username)}@` : '';
    const database = parsed.pathname.replace(/^\//, '') || '(default)';
    return `${user}${parsed.hostname}:${parsed.port || '5432'}/${database}`;
  } catch {
    return '(unparseable connection string)';
  }
}

// --- the driver -----------------------------------------------------------

/**
 * Loads `postgres` from apps/api's resolution scope. See the module comment.
 *
 * The resolved specifier is turned into a file URL before `import()`: on Windows a
 * bare absolute path like C:\... is not a valid ESM specifier, and the failure is
 * an obscure ERR_UNSUPPORTED_ESM_URL_SCHEME rather than anything about paths.
 */
async function loadPostgres() {
  const apiManifest = join(REPO_ROOT, 'apps', 'api', 'package.json');
  let resolved;
  try {
    resolved = createRequire(pathToFileURL(apiManifest)).resolve('postgres');
  } catch (err) {
    throw new Error(
      `could not resolve the 'postgres' package from apps/api (${err.message}). ` +
        'Run `pnpm install --frozen-lockfile` first.',
    );
  }
  const module = await import(pathToFileURL(resolved).href);
  const factory = module.default ?? module;
  if (typeof factory !== 'function') {
    throw new Error("the 'postgres' package did not export a callable default");
  }
  return factory;
}

/**
 * PostgreSQL SQLSTATE codes that mean "not ready yet, ask again".
 *
 * 57P03 cannot_connect_now is the interesting one: the server is up and speaking
 * the protocol, and is telling us it is still starting. A TCP check would call
 * that success.
 */
const RETRYABLE_SQLSTATE = new Set([
  '57P03', // cannot_connect_now — "the database system is starting up"
  '57P01', // admin_shutdown — the initdb restart, mid-sequence
  '57P02', // crash_shutdown
  '53300', // too_many_connections — transient during startup storms
]);

/** Socket-level errors that mean the listener is not there (yet). */
const RETRYABLE_SYSCALL = new Set([
  'ECONNREFUSED',
  'ENOTFOUND', // DNS for a compose service name that has not been created yet
  'EAI_AGAIN',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CONNECT_TIMEOUT', // the driver's own connect_timeout
]);

/**
 * Non-retryable failures, with the actual fix rather than a generic message.
 * Waiting cannot turn any of these into a success.
 */
const FATAL_SQLSTATE = new Map([
  ['28P01', 'password authentication failed — check POSTGRES_PASSWORD / DATABASE_URL'],
  ['28000', 'the server rejected this role — check POSTGRES_USER / DATABASE_URL'],
  [
    '3D000',
    'that database does not exist. If the data volume was created with different ' +
      'settings, `docker compose down -v` and run `pnpm run db:setup` again.',
  ],
  ['42501', 'this role lacks permission to connect to that database'],
]);

function classify(err) {
  const code = typeof err?.code === 'string' ? err.code : null;
  if (code && FATAL_SQLSTATE.has(code)) {
    return { retry: false, why: FATAL_SQLSTATE.get(code), code };
  }
  if (code && RETRYABLE_SQLSTATE.has(code)) return { retry: true, why: err.message, code };
  if (code && RETRYABLE_SYSCALL.has(code)) return { retry: true, why: code, code };
  // An unrecognised error is retried rather than treated as fatal: the driver
  // wraps startup races in several shapes, and a false "fatal" here would break
  // `db:setup` on a slow machine. The timeout is the backstop, and the last error
  // is printed when it fires, so nothing is swallowed.
  return { retry: true, why: err?.message ?? String(err), code };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Swallows a value on purpose. Named so the intent is not mistaken for a stub. */
function ignore() {
  // Deliberately empty. See the call sites for why the value is not wanted.
}

/** One attempt: connect, run a query, close. Returns the server version. */
async function attempt(postgres, url, connectTimeoutSeconds) {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: connectTimeoutSeconds,
    idle_timeout: 1,
    // The driver would otherwise print server NOTICEs to stderr, which during
    // startup is pure noise on top of our own progress output.
    onnotice: ignore,
    // No prepared statements: this connection lives for one query, and preparing
    // it is a second round trip for nothing.
    prepare: false,
  });
  try {
    const rows = await sql`select version() as version, pg_is_in_recovery() as in_recovery`;
    const row = rows[0];
    return {
      version: typeof row?.version === 'string' ? row.version : 'unknown',
      inRecovery: row?.in_recovery === true,
    };
  } finally {
    // `end({ timeout: 0 })` closes immediately instead of draining, so a failed
    // attempt cannot keep the event loop alive and hang the script past its own
    // timeout. A failure to close a connection that already failed to open is not
    // news, hence the swallow.
    await sql.end({ timeout: 0 }).catch(ignore);
  }
}

// --- run ------------------------------------------------------------------

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(red(`db:wait — ${err.message}`));
  process.exit(1);
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

const target = connectionStringFrom(process.env, options.url);
const say = (line) => {
  if (!options.quiet) console.log(line);
};

say(bold('\ndb:wait'));
say(dim(`  target   ${describeTarget(target.url)}  (from ${target.source})`));
say(dim(`  giving up after ${options.timeoutSeconds}s, retrying every ${options.intervalMs}ms\n`));

let postgres;
try {
  postgres = await loadPostgres();
} catch (err) {
  console.error(red(`  x ${err.message}\n`));
  process.exit(1);
}

const startedAt = Date.now();
const deadline = startedAt + options.timeoutSeconds * 1000;
let attempts = 0;
let lastReason = 'no attempt completed';

for (;;) {
  attempts += 1;
  try {
    const info = await attempt(postgres, target.url, DEFAULTS.connectTimeoutSeconds);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!options.quiet && attempts > 1) process.stdout.write('\n');
    // Trim the version banner to something that fits on a line; the full string
    // includes the compiler and the architecture and is rarely what you want.
    const short = info.version.split(' ').slice(0, 2).join(' ');
    if (info.inRecovery) {
      // Connected, but this server cannot accept writes, so `db:migrate` — the
      // very next step of db:setup — would fail. That is a failure, not a warning
      // dressed up as success.
      console.error(red(`  x ${short} is in recovery: it will not accept writes`));
      console.error(dim('      point db:wait at the primary, or promote this one\n'));
      process.exit(1);
    }
    say(`  ${green('ready')}  ${short} after ${attempts} attempt(s), ${elapsed}s`);
    say('');
    process.exit(0);
  } catch (err) {
    const verdict = classify(err);
    lastReason =
      verdict.code && verdict.code !== verdict.why ? `${verdict.code}: ${verdict.why}` : verdict.why;
    if (!verdict.retry) {
      console.error(red(`\n  x not retryable — ${verdict.why}\n`));
      process.exit(1);
    }
    if (Date.now() + options.intervalMs >= deadline) break;
    // One line per attempt would bury the useful output on a slow start, so
    // progress is a growing dot line with the reason on the first attempt only.
    if (attempts === 1) say(dim(`  waiting — ${lastReason}`));
    if (!options.quiet) process.stdout.write(dim('.'));
    await sleep(options.intervalMs);
  }
}

if (!options.quiet) process.stdout.write('\n');
console.error(red(`  x timed out after ${options.timeoutSeconds}s and ${attempts} attempt(s)`));
console.error(dim(`      last error: ${lastReason}`));
console.error(dim(`      target:     ${describeTarget(target.url)}`));
console.error(dim('      is it running? `docker compose ps postgres` / `pnpm run db:up`\n'));
process.exit(1);
