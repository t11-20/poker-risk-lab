#!/usr/bin/env node
/**
 * Blocks until PostgreSQL accepts a connection and answers a query (`pnpm run db:wait`).
 *
 * A TCP check is not enough: a new container opens its port while initdb restarts the server.
 * Wrong credentials and a missing database are not retried, because waiting cannot fix them.
 * `postgres` resolves through apps/api's scope because the root has no node_modules/postgres under
 * `hoistPattern: []`, and this keeps the script on the server's driver version.
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

const DEFAULTS = {
  timeoutSeconds: 60,
  intervalMs: 500,
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
      // `pnpm run db:wait -- --timeout 5` forwards the `--` itself.
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
    --url <conn>       connection string (default: $DATABASE_MIGRATION_URL, then
                       $DATABASE_URL, then dev defaults)
    --timeout <secs>   give up after this long          (default ${DEFAULTS.timeoutSeconds})
    --interval <ms>    delay between attempts           (default ${DEFAULTS.intervalMs})
    -q, --quiet        only print the final line
    -h, --help         this text

  Connection settings are read in this order:
    1. --url
    2. DATABASE_MIGRATION_URL
    3. DATABASE_URL
    4. POSTGRES_HOST / POSTGRES_PORT / POSTGRES_USER / POSTGRES_PASSWORD /
       POSTGRES_DB  (PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE are
       accepted as aliases)
    5. the dev defaults in docker-compose.yml

  \`pnpm run db:wait\` loads .env first, as db:migrate and db:seed do.

  Exit codes: 0 ready, 1 timed out or a non-retryable failure.
`;

// The dev defaults mirror docker-compose.yml so the first run works with no .env. Change both together.
function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function connectionStringFrom(env, override) {
  if (override) return { url: override, source: '--url' };
  // DATABASE_MIGRATION_URL first, as in migrate.mjs, because db:wait clears the way for db:migrate
  // (docs/audit/production-audit.md P2-1). DATABASE_URL alone would fail a fresh cluster with a
  // non-retried 28P01, since db:seed creates prl_api later. A blank value counts as unset.
  if (isSet(env.DATABASE_MIGRATION_URL)) {
    return { url: env.DATABASE_MIGRATION_URL.trim(), source: 'DATABASE_MIGRATION_URL' };
  }
  if (isSet(env.DATABASE_URL)) return { url: env.DATABASE_URL.trim(), source: 'DATABASE_URL' };

  const host = env.POSTGRES_HOST ?? env.PGHOST ?? '127.0.0.1';
  const port = env.POSTGRES_PORT ?? env.PGPORT ?? '5432';
  const user = env.POSTGRES_USER ?? env.PGUSER ?? 'poker';
  const password = env.POSTGRES_PASSWORD ?? env.PGPASSWORD ?? 'poker-dev-only';
  const database = env.POSTGRES_DB ?? env.PGDATABASE ?? 'poker_risk_lab';
  // A password may legally contain @ / : or ?.
  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return { url: `postgres://${auth}@${host}:${port}/${database}`, source: 'environment' };
}

// The raw connection string is never printed, since this runs in CI logs.
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

// A file URL, because a bare Windows path like C:\... is not a valid ESM specifier.
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

// 57P03 cannot_connect_now means the server is up and still starting. A TCP check would call it ready.
const RETRYABLE_SQLSTATE = new Set([
  '57P03', // cannot_connect_now — "the database system is starting up"
  '57P01', // admin_shutdown — the initdb restart, mid-sequence
  '57P02', // crash_shutdown
  '53300', // too_many_connections — transient during startup storms
]);

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
  // An unrecognised error is retried, because the driver wraps startup races in several shapes. The
  // timeout is the backstop and prints the last error.
  return { retry: true, why: err?.message ?? String(err), code };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ignore() {
  // Deliberately empty.
}

async function attempt(postgres, url, connectTimeoutSeconds) {
  const sql = postgres(url, {
    max: 1,
    connect_timeout: connectTimeoutSeconds,
    idle_timeout: 1,
    onnotice: ignore,
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
    // `timeout: 0` closes without draining, so a failed attempt cannot hang the script past its timeout.
    await sql.end({ timeout: 0 }).catch(ignore);
  }
}

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
    const short = info.version.split(' ').slice(0, 2).join(' ');
    if (info.inRecovery) {
      // A server in recovery cannot accept writes, so db:migrate would fail next.
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
      console.error(red(`\n  x not retryable — ${verdict.why}`));
      console.error(dim(`      target: ${describeTarget(target.url)} (from ${target.source})\n`));
      process.exit(1);
    }
    if (Date.now() + options.intervalMs >= deadline) break;
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
