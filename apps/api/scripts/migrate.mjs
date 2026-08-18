#!/usr/bin/env node
/**
 * migrate.mjs — the migration runner for Poker Risk Lab.
 *
 *   node apps/api/scripts/migrate.mjs up [--allow-missing]
 *   node apps/api/scripts/migrate.mjs status
 *   node apps/api/scripts/migrate.mjs seed
 *   node apps/api/scripts/migrate.mjs reset
 *
 * Dependency-free apart from `postgres` (porsager/postgres), which the API already
 * depends on. A migration runner that pulls in a framework to move some SQL
 * around is a second thing that can break on the day the first one does.
 *
 * ## Design decisions
 *
 * **A checksum mismatch aborts; it never reapplies.** Every applied migration is
 * recorded with the sha256 of its contents. If a file that has already run no
 * longer hashes to what the ledger says, this runner stops and says so. The
 * alternative — reapply, or shrug and continue — means production and the
 * repository disagree about the schema and nobody finds out until a query fails
 * at 3am. Migrations are immutable once applied, contents *and* filename: to
 * change something already shipped, write the next migration.
 *
 * The hash is taken with CRLF collapsed to LF and any BOM stripped, so a checkout
 * on a machine that rewrites line endings is not mistaken for a tampered file.
 * Anything that actually changes the SQL still changes the hash.
 *
 * **Out-of-order migrations abort too.** Two branches that each add 0007 merge
 * cleanly in git and diverge in the database, so a pending file numbered below the
 * highest applied one is refused rather than silently slotted in behind it.
 *
 * **One transaction per file.** A migration either happened or it did not.
 * PostgreSQL's transactional DDL is the reason this runner can be this small.
 * A `lock_timeout` is set inside each transaction so a migration queued behind a
 * long-running query fails in seconds instead of holding an exclusive lock and
 * blocking every request in the meantime. The trade-off: `CREATE INDEX
 * CONCURRENTLY` cannot be used inside a transaction, so it is not available here —
 * see the note at the top of 0002.
 *
 * **A session advisory lock, on a single connection.** Two deploys racing would
 * otherwise both read "0007 is pending" and both apply it. The pool is capped at
 * `max: 1` precisely because `pg_advisory_lock` is session-scoped: on a larger
 * pool the lock could be taken on one connection and the migration run on
 * another, which is a lock that looks like it works. Acquisition uses
 * `pg_try_advisory_lock` in a bounded retry loop rather than blocking forever, so
 * a stuck deploy fails with an explanation instead of hanging a pipeline.
 *
 * **Values are always parameterised.** Whole SQL files go through `.unsafe()`
 * because DDL cannot be parameterised, but every *value* this script sends —
 * version, checksum, lock key, timeout — travels as a bind parameter. That
 * includes `SET`, which takes no parameters, so it is done with
 * `select set_config($1, $2, true)` rather than by concatenating a string.
 *
 * **Nothing secret is ever printed.** The connection string is read from the
 * environment, never echoed, and every message this script prints (including
 * errors thrown from inside the driver) is passed through a redactor that strips
 * anything shaped like a connection URL or a password parameter first.
 *
 * **`seed` and `reset` refuse to run when NODE_ENV=production.** `seed` writes
 * fixture rows; `reset` drops the schema. Neither has any business near real
 * learner data. `reset` leaves the cluster-wide roles alone — they may be shared
 * with other databases, and dropping them is not this script's decision.
 *
 * Seed files are deliberately *not* recorded in the ledger. They are fixtures,
 * they are written to be idempotent, and being able to re-run them after poking
 * at the dev database by hand is the point.
 *
 * The migrating identity needs CREATE on the target database (it creates schema
 * `prl` and the ledger table) and enough authority to create roles the first time
 * 0001 runs. The runtime role, `prl_app`, needs none of that — see the privilege
 * matrix at the bottom of 0001.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');
const SEEDS_DIR = join(REPO_ROOT, 'db', 'seeds');

/** NNNN_lower_snake_case.sql — anything else is a naming mistake, not a migration. */
const FILE_NAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** Namespaces the advisory lock so it cannot collide with another app's key. */
const LOCK_NAMESPACE = 'poker-risk-lab/db/migrations';
const DEFAULT_LOCK_WAIT_MS = 30_000;
/** How long a migration waits for a table lock before giving up. */
const STATEMENT_LOCK_TIMEOUT = '10s';

const COMMANDS = ['up', 'status', 'seed', 'reset'];

// ---------------------------------------------------------------------------
// Output. Colour only when a human is watching.
// ---------------------------------------------------------------------------

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, text) => (NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);
const red = (text) => paint('31', text);
const green = (text) => paint('32', text);
const yellow = (text) => paint('33', text);
const dim = (text) => paint('2', text);
const bold = (text) => paint('1', text);

/**
 * Strips anything that could be a credential from a string before it is printed.
 * Driver errors and PostgreSQL notices are written by code this script does not
 * own, so they go through here too rather than being trusted.
 */
function redact(value) {
  return String(value ?? '')
    .replace(/\b(?:postgres|postgresql):\/\/\S*/gi, 'postgres://[redacted]')
    .replace(/\bpassword=[^\s&;'"]*/gi, 'password=[redacted]');
}

/**
 * The diagnostic fields of a driver error, as a plain string so it can be
 * redacted before it is printed.
 *
 * Deliberately field-by-field rather than `util.inspect(error)`: a postgres.js
 * error also carries `query` and `parameters`, i.e. the statement that failed
 * and every value bound into it. None of the values this script binds is a
 * secret today, but printing a whole error object is a promise that whoever
 * adds the next parameter has to remember to keep. Listing the fields means the
 * default is to say nothing.
 */
function inspectError(error) {
  if (error === null || typeof error !== 'object') return `  ${String(error)}`;
  const fields = [
    'name',
    'code',
    'severity',
    'routine',
    'schema_name',
    'table_name',
    'column_name',
    'constraint_name',
    'detail',
    'hint',
    'where',
    'position',
    'file',
    'line',
  ];
  const shown = fields
    .filter((field) => error[field] !== undefined && error[field] !== null)
    .map((field) => `  ${field}: ${String(error[field])}`);
  return shown.length === 0 ? '  (no diagnostic fields)' : shown.join('\n');
}

const line = (text = '') => console.log(redact(text));
const note = (text) => line(`${dim('  ·')} ${text}`);
const ok = (text) => line(`${green('  ✓')} ${text}`);
const warn = (text) => line(`${yellow('  !')} ${text}`);

/** An error with a message meant for a human, printed without a stack trace. */
class MigrateError extends Error {
  name = 'MigrateError';
}

// ---------------------------------------------------------------------------
// Environment and connection.
// ---------------------------------------------------------------------------

function databaseUrl() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new MigrateError(
      // Written without a literal example URL on purpose: every line this script
      // prints goes through redact(), which would replace one with [redacted] and
      // leave the reader worse off than a description does.
      [
        'DATABASE_URL is not set, so there is nothing to migrate.',
        '',
        'Point it at your development database with a libpq URL of the form',
        '  <postgres|postgresql>://<user>:<password>@<host>:5432/<database>',
        '',
        'either exported in your shell or as a line in .env at the repo root — the pnpm db:*',
        'scripts load that file if it exists.',
      ].join('\n'),
    );
  }
  return url;
}

/**
 * PostgreSQL notices worth showing (a role being created, say) and the two that
 * are just `IF NOT EXISTS` doing its job on every single run.
 */
const BORING_NOTICE_CODES = new Set(['42P06', '42P07']);

function connect(url) {
  return postgres(url, {
    // One connection, deliberately: pg_advisory_lock is session-scoped, and the
    // lock has to live on the same session that runs the migrations.
    max: 1,
    connect_timeout: 15,
    connection: { application_name: 'prl-migrate' },
    onnotice: (notice) => {
      const message = notice?.message;
      if (BORING_NOTICE_CODES.has(notice?.code)) return;
      if (typeof message === 'string' && message !== '') note(`postgres: ${message}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Files on disk.
// ---------------------------------------------------------------------------

function checksumOf(contents) {
  const normalized = contents.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

const shortChecksum = (checksum) =>
  String(checksum)
    .replace(/^sha256:/, '')
    .slice(0, 12);

/**
 * Every .sql file in `dir`, in filename order, with contents and checksum.
 * A file this runner cannot order is refused rather than skipped: skipping is how
 * a migration goes missing from an environment without anyone noticing.
 */
async function readSqlDir(dir, label) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new MigrateError(`No ${label} directory at ${dir}.`);
    }
    throw error;
  }

  const numbers = new Map();
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const match = FILE_NAME_PATTERN.exec(entry.name);
    if (match === null) {
      throw new MigrateError(
        `${label} file "${entry.name}" is not named NNNN_lower_snake_case.sql.\n` +
          'Rename it, or move it out of the directory. This runner will not guess where an ' +
          'unordered file belongs, because both possible guesses — skip it, or apply it last — ' +
          'are worse than stopping.',
      );
    }
    const number = match[1];
    const clash = numbers.get(number);
    if (clash !== undefined) {
      throw new MigrateError(
        `Two ${label} files share the number ${number}: "${clash}" and "${entry.name}".\n` +
          'Renumber one of them; their apply order would otherwise depend on collation.',
      );
    }
    numbers.set(number, entry.name);
    const path = join(dir, entry.name);
    const contents = await readFile(path, 'utf8');
    files.push({ version: entry.name, number, path, sql: contents, checksum: checksumOf(contents) });
  }

  files.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  if (files.length === 0) throw new MigrateError(`No ${label} files found in ${dir}.`);
  return files;
}

// ---------------------------------------------------------------------------
// The ledger.
// ---------------------------------------------------------------------------

async function ledgerExists(sql) {
  const [row] = await sql`select to_regclass('prl.schema_migrations') is not null as present`;
  return row?.present === true;
}

async function ensureLedger(sql) {
  // Fixed DDL, no interpolation. The schema is created here so the very first
  // migration has somewhere to record itself; 0001 then hands ownership of the
  // schema to prl_migrator. The ledger itself stays with the migrating identity,
  // and prl_app is granted nothing on it.
  await sql.unsafe(`
    create schema if not exists prl;
    create table if not exists prl.schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
    comment on table prl.schema_migrations is
      'Applied migrations, with a sha256 of the file that was applied. Written only by apps/api/scripts/migrate.mjs.';
  `);
}

async function appliedMigrations(sql) {
  const rows = await sql`select version, checksum, applied_at from prl.schema_migrations`;
  return [...rows].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The advisory lock.
// ---------------------------------------------------------------------------

/** A stable signed 64-bit key from a namespace string, as pg_advisory_lock wants. */
function advisoryLockKey(namespace) {
  return createHash('sha256').update(namespace).digest().readBigInt64BE(0).toString();
}

async function acquireLock(sql, waitMs) {
  const key = advisoryLockKey(LOCK_NAMESPACE);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const [row] = await sql`select pg_try_advisory_lock(${key}::bigint) as locked`;
    if (row?.locked === true) return key;
    if (Date.now() >= deadline) {
      throw new MigrateError(
        `Another migration is already running: could not take the advisory lock within ${waitMs} ms.\n` +
          'If you are sure nothing else is migrating, look for a stuck session in pg_stat_activity ' +
          "with application_name = 'prl-migrate'.",
      );
    }
    note('waiting for the migration lock...');
    await new Promise((wake) => setTimeout(wake, 500));
  }
}

async function releaseLock(sql, key) {
  await sql`select pg_advisory_unlock(${key}::bigint)`;
}

async function withLock(sql, waitMs, run) {
  const key = await acquireLock(sql, waitMs);
  try {
    return await run();
  } finally {
    // Releasing must not be able to replace the reason we are unwinding. If the
    // body failed because the connection died or the transaction aborted, the
    // unlock fails too, and a `finally` that throws would discard the original
    // error and report the symptom instead of the cause. The lock is
    // session-scoped, so PostgreSQL drops it when this connection closes a
    // moment later either way.
    try {
      await releaseLock(sql, key);
    } catch (error) {
      warn(`could not release the migration lock: ${error?.message ?? String(error)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Planning: what to apply, and what to refuse.
// ---------------------------------------------------------------------------

function describeDrift(drifted) {
  const details = drifted
    .map(
      ({ file, record }) =>
        `  ${file.version}\n` +
        `    ledger: ${shortChecksum(record.checksum)}  applied ${record.applied_at.toISOString()}\n` +
        `    file:   ${shortChecksum(file.checksum)}`,
    )
    .join('\n');
  return (
    `${drifted.length} applied migration(s) no longer match the file that was applied:\n${details}\n\n` +
    'Nothing has been applied. An applied migration is immutable: reapplying it could not undo ' +
    'whatever the old version already did, and ignoring the difference would leave this database ' +
    'and the repository describing different schemas. Restore the file from git and write the ' +
    'change as a new migration.'
  );
}

/**
 * @returns {{version: string, sql: string, checksum: string}[]} files to apply, in order
 */
function planMigrations(files, applied, { allowMissing }) {
  const ledger = new Map(applied.map((row) => [row.version, row]));
  const drifted = [];
  const pending = [];

  for (const file of files) {
    const record = ledger.get(file.version);
    if (record === undefined) {
      pending.push(file);
      continue;
    }
    if (record.checksum !== file.checksum) drifted.push({ file, record });
    ledger.delete(file.version);
  }

  if (drifted.length > 0) throw new MigrateError(describeDrift(drifted));

  const orphans = [...ledger.keys()];
  if (orphans.length > 0) {
    const list = orphans.join(', ');
    if (!allowMissing) {
      throw new MigrateError(
        `The ledger records migration(s) with no file in db/migrations: ${list}.\n` +
          'This database cannot be rebuilt from the repository as it stands. If the files were ' +
          'squashed or removed on purpose, re-run with --allow-missing to say so explicitly.',
      );
    }
    warn(`applied migration(s) with no file, allowed by --allow-missing: ${list}`);
  }

  const highestApplied = applied.length === 0 ? null : applied[applied.length - 1].version;
  const outOfOrder = highestApplied === null ? [] : pending.filter((file) => file.version < highestApplied);
  if (outOfOrder.length > 0) {
    throw new MigrateError(
      `Out-of-order migration(s): ${outOfOrder.map((file) => file.version).join(', ')} ` +
        `sort before ${highestApplied}, which is already applied.\n` +
        'Two branches that each added a migration merge cleanly in git and diverge in the ' +
        'database. Renumber the pending file(s) to follow the applied ones so every environment ' +
        'ends up with the same schema by the same route.',
    );
  }

  return pending;
}

// ---------------------------------------------------------------------------
// Commands.
// ---------------------------------------------------------------------------

async function applyFile(sql, file, recordInLedger) {
  const startedAt = Date.now();
  await sql.begin(async (tx) => {
    // SET takes no parameters, so this is the parameterised way to set one.
    await tx`select set_config('lock_timeout', ${STATEMENT_LOCK_TIMEOUT}, true)`;
    await tx.unsafe(file.sql);
    if (recordInLedger) {
      await tx`
        insert into prl.schema_migrations (version, checksum)
        values (${file.version}, ${file.checksum})
      `;
    }
  });
  return Date.now() - startedAt;
}

async function commandUp(sql, options) {
  const files = await readSqlDir(MIGRATIONS_DIR, 'migration');

  await withLock(sql, options.lockWaitMs, async () => {
    // Create the ledger inside the lock, not before it. `create table if not
    // exists` is not race-safe: two first-time deploys can both find the table
    // absent and one then fails on a catalog unique index rather than on
    // anything this runner can explain. Everything that touches the ledger,
    // including bringing it into existence, belongs on this side of the lock.
    await ensureLedger(sql);
    // Read the ledger inside the lock too. Reading it outside would reintroduce
    // the race the lock exists to remove.
    const applied = await appliedMigrations(sql);
    const pending = planMigrations(files, applied, options);

    if (pending.length === 0) {
      ok(`up to date — ${applied.length} migration(s) applied, nothing pending`);
      return;
    }

    line(`${bold('Applying')} ${pending.length} migration(s)`);
    for (const file of pending) {
      const elapsed = await applyFile(sql, file, true);
      ok(`${file.version} ${dim(`(${elapsed} ms, ${shortChecksum(file.checksum)})`)}`);
    }
  });
}

async function commandStatus(sql) {
  const files = await readSqlDir(MIGRATIONS_DIR, 'migration');
  const present = await ledgerExists(sql);
  if (!present) {
    warn('prl.schema_migrations does not exist yet — nothing has been applied to this database');
    for (const file of files) line(`  ${yellow('pending')}  ${file.version}`);
    line();
    note(`${files.length} pending, 0 applied`);
    return;
  }

  const applied = await appliedMigrations(sql);
  const ledger = new Map(applied.map((row) => [row.version, row]));
  let pendingCount = 0;
  let driftCount = 0;

  for (const file of files) {
    const record = ledger.get(file.version);
    if (record === undefined) {
      pendingCount += 1;
      line(`  ${yellow('pending')}  ${file.version}`);
      continue;
    }
    ledger.delete(file.version);
    if (record.checksum === file.checksum) {
      line(`  ${green('applied')}  ${file.version}  ${dim(record.applied_at.toISOString())}`);
      continue;
    }
    driftCount += 1;
    line(
      `  ${red('CHANGED')}  ${file.version}  ${dim(
        `ledger ${shortChecksum(record.checksum)} != file ${shortChecksum(file.checksum)}`,
      )}`,
    );
  }

  for (const version of ledger.keys()) {
    line(`  ${red('NO FILE')}  ${version}  ${dim('recorded as applied, not present in db/migrations')}`);
  }

  line();
  const matching = files.length - pendingCount - driftCount;
  const changed = driftCount === 0 ? '' : `, ${driftCount} changed`;
  note(`${matching} applied and matching, ${pendingCount} pending${changed}`);
  if (driftCount > 0) warn(`${driftCount} applied migration(s) differ from their file — \`up\` will refuse`);
  if (ledger.size > 0) warn(`${ledger.size} applied migration(s) have no file — \`up\` will refuse`);
}

function refuseInProduction(command) {
  if (process.env.NODE_ENV === 'production') {
    throw new MigrateError(
      `\`${command}\` will not run with NODE_ENV=production.\n` +
        (command === 'seed'
          ? 'Seeds are fixtures. Writing them into a database with real learners in it is not ' +
            'something this script is willing to do by accident.'
          : 'Reset drops schema prl and everything in it. That is a development convenience, not ' +
            'an operation any script should offer against production.'),
    );
  }
}

async function commandSeed(sql, options) {
  refuseInProduction('seed');
  const files = await readSqlDir(SEEDS_DIR, 'seed');

  if (!(await ledgerExists(sql))) {
    throw new MigrateError('Nothing has been migrated yet. Run `up` before `seed`.');
  }

  await withLock(sql, options.lockWaitMs, async () => {
    line(`${bold('Seeding')} ${files.length} file(s)`);
    for (const file of files) {
      const elapsed = await applyFile(sql, file, false);
      ok(`${file.version} ${dim(`(${elapsed} ms)`)}`);
    }
    note('seeds are not recorded in the ledger; they are written to be safe to re-run');
  });
}

async function dropSchema(sql) {
  const [role] = await sql`
    select exists (select 1 from pg_catalog.pg_roles where rolname = 'prl_migrator') as present
  `;
  let assumedRole = false;
  if (role?.present === true) {
    const [membership] = await sql`
      select pg_catalog.pg_has_role(current_user, 'prl_migrator', 'USAGE') as ok
    `;
    if (membership?.ok === true) {
      await sql.unsafe('set role prl_migrator');
      assumedRole = true;
    }
  }
  await sql.unsafe('drop schema if exists prl cascade');
  if (assumedRole) await sql.unsafe('reset role');
}

async function commandReset(sql, options) {
  refuseInProduction('reset');

  // Named from the server, not parsed out of the connection string, so nothing
  // secret is anywhere near this line.
  const [target] = await sql`select current_database() as database, current_user as role`;
  warn(`dropping schema prl in database "${target.database}" as "${target.role}"`);

  await withLock(sql, options.lockWaitMs, async () => {
    await dropSchema(sql);
    ok('schema prl dropped (roles prl_migrator and prl_app are cluster-wide and left alone)');
  });

  await commandUp(sql, options);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function usage() {
  line(`${bold('migrate.mjs')} — Poker Risk Lab database migrations`);
  line();
  line('  up [--allow-missing]   apply pending migrations');
  line('  status                 show applied and pending migrations');
  line('  seed                   apply db/seeds/*.sql (never with NODE_ENV=production)');
  line('  reset                  drop schema prl, then apply every migration again');
  line();
  line(`${dim('  DATABASE_URL')}               required; never printed`);
  line(`${dim('  PRL_MIGRATE_LOCK_WAIT_MS')}   how long to wait for the migration lock (default 30000)`);
}

function parseArgs(argv) {
  const options = { command: null, allowMissing: false, help: false };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--allow-missing') {
      options.allowMissing = true;
    } else if (arg.startsWith('-')) {
      throw new MigrateError(`Unknown option "${arg}". Try --help.`);
    } else if (options.command === null) {
      options.command = arg;
    } else {
      throw new MigrateError(`Unexpected argument "${arg}". One command at a time.`);
    }
  }
  return options;
}

function lockWaitMs() {
  const raw = process.env.PRL_MIGRATE_LOCK_WAIT_MS;
  if (raw === undefined || raw === '') return DEFAULT_LOCK_WAIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new MigrateError(`PRL_MIGRATE_LOCK_WAIT_MS must be a non-negative number, got "${raw}".`);
  }
  return parsed;
}

async function run(options) {
  // Checked before a connection is opened as well as inside the command itself.
  // A refusal that never so much as authenticates against the production
  // database is a stronger refusal than one that connects first and thinks
  // afterwards, and the in-command check stays as the backstop that cannot be
  // routed around.
  if (options.command === 'seed' || options.command === 'reset') refuseInProduction(options.command);

  const sql = connect(databaseUrl());
  try {
    const withTimeouts = { ...options, lockWaitMs: lockWaitMs() };
    // Every command is dispatched by name, with no `else` fallthrough. A bare
    // `else` here would mean that adding a command to COMMANDS without adding a
    // branch silently ran `reset` — which drops schema prl — instead of failing.
    // The one destructive command in this file must never be something a
    // typo or an unfinished edit can reach.
    if (options.command === 'up') await commandUp(sql, withTimeouts);
    else if (options.command === 'status') await commandStatus(sql);
    else if (options.command === 'seed') await commandSeed(sql, withTimeouts);
    else if (options.command === 'reset') await commandReset(sql, withTimeouts);
    else throw new MigrateError(`Command "${options.command}" has no implementation.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === null) {
    usage();
    return;
  }
  if (!COMMANDS.includes(options.command)) {
    throw new MigrateError(`Unknown command "${options.command}". Expected one of: ${COMMANDS.join(', ')}.`);
  }
  await run(options);
}

try {
  await main();
} catch (error) {
  line();
  if (error instanceof MigrateError) {
    line(`${red('  ✗')} ${error.message}`);
  } else {
    // A driver or PostgreSQL error. Print the message and the useful PostgreSQL
    // fields, redacted, and keep the stack behind an opt-in flag so a normal
    // failure reads as a sentence instead of a wall.
    const detail = [error?.detail, error?.hint, error?.where].filter(Boolean).join(' | ');
    line(`${red('  ✗')} ${error?.message ?? String(error)}`);
    if (error?.position) note(`at character ${error.position}`);
    if (detail !== '') note(detail);
    // The debug dump goes through redact() like everything else. Driver error
    // objects carry the failing statement and its bind parameters, so handing
    // one straight to console.error would be the single place in this script
    // where "nothing secret is ever printed" stopped being true — and it would
    // be true right up until the run that failed while sending something worth
    // hiding.
    if (process.env.PRL_DEBUG) {
      console.error(redact(error?.stack ?? String(error)));
      console.error(redact(inspectError(error)));
    }
  }
  line();
  process.exitCode = 1;
}
