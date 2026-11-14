#!/usr/bin/env node
/**
 * Migration runner. Roll-forward only. `down` refuses with the policy, and `up` refuses a destructive
 * statement unless the file carries a `prl:irreversible` reason (docs/RUNBOOK.md §11.3).
 * Applied files are immutable. A checksum mismatch or an out-of-order pending file aborts the run.
 * One transaction per file, under a session advisory lock on one connection.
 * Every line printed is redacted.
 * `roles` creates the cluster-wide roles a single-database pg_dump restore needs and pg_dump omits.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { FILE_NAME_PATTERN, migrationChecksum } from '../src/migration-files.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');
const SEEDS_DIR = join(REPO_ROOT, 'db', 'seeds');
const ROLES_DIR = join(REPO_ROOT, 'db', 'roles');

const LOCK_NAMESPACE = 'poker-risk-lab/db/migrations';
const DEFAULT_LOCK_WAIT_MS = 30_000;
const STATEMENT_LOCK_TIMEOUT = '10s';
// The dot makes this custom GUC settable without a prior definition. See `applyFile`.
const TRANSACTION_WITNESS = 'prl.migration_transaction';

const COMMANDS = ['up', 'down', 'status', 'roles', 'seed', 'reset'];

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, text) => (NO_COLOR ? text : `\x1b[${code}m${text}\x1b[0m`);
const red = (text) => paint('31', text);
const green = (text) => paint('32', text);
const yellow = (text) => paint('33', text);
const dim = (text) => paint('2', text);
const bold = (text) => paint('1', text);

// Driver errors and PostgreSQL notices go through this too, since this script does not write them.
function redact(value) {
  return String(value ?? '')
    .replace(/\b(?:postgres|postgresql):\/\/\S*/gi, 'postgres://[redacted]')
    .replace(/\bpassword=[^\s&;'"]*/gi, 'password=[redacted]');
}

/**
 * Field by field, not `util.inspect(error)`. A postgres.js error also carries `query` and
 * `parameters`, so dumping the whole object would print every bound value.
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

class MigrateError extends Error {
  name = 'MigrateError';
}

/**
 * `DATABASE_MIGRATION_URL` comes first because `DATABASE_URL` names a `prl_app` member, which has
 * no CREATE and no grant on prl.schema_migrations. DATABASE_URL stays as the fallback for
 * deployments that set only one variable.
 */
function databaseUrl() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (typeof migrationUrl === 'string' && migrationUrl.trim() !== '') return migrationUrl;

  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new MigrateError(
      // No literal example URL, because redact() would print it as [redacted].
      [
        'Neither DATABASE_MIGRATION_URL nor DATABASE_URL is set, so there is nothing to migrate.',
        '',
        'Point one at your development database with a libpq URL of the form',
        '  <postgres|postgresql>://<user>:<password>@<host>:5432/<database>',
        '',
        'either exported in your shell or as a line in .env at the repo root — the pnpm db:*',
        'scripts load that file if it exists. DATABASE_MIGRATION_URL should name the migrating',
        'identity (a member of prl_migrator); DATABASE_URL names the API, which cannot migrate.',
      ].join('\n'),
    );
  }
  return url;
}

// `IF NOT EXISTS` raises these two on every run.
const BORING_NOTICE_CODES = new Set(['42P06', '42P07']);

function connect(url) {
  return postgres(url, {
    // pg_advisory_lock is session-scoped, so the lock and the migrations must share one session.
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

const shortChecksum = (checksum) =>
  String(checksum)
    .replace(/^sha256:/, '')
    .slice(0, 12);

// A file this runner cannot order is refused, not skipped, so no migration goes missing unnoticed.
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
    files.push({ version: entry.name, number, path, sql: contents, checksum: migrationChecksum(contents) });
  }

  files.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
  if (files.length === 0) throw new MigrateError(`No ${label} files found in ${dir}.`);
  return files;
}

/**
 * A SQL comment such as `-- prl:irreversible: <what is lost>`. A bare marker with no reason fails.
 * The reason must start on the marker's own line. A plain \s* would cross the newline and read
 * the next SQL statement as the reason.
 */
const IRREVERSIBLE_MARKER = /--[^\S\n]*prl:irreversible[^\S\n]*:[^\S\n]*(\S[^\n]*)/i;

/**
 * Only statements a later migration cannot put back. `DROP INDEX`, `REVOKE` and `SET DEFAULT` are
 * left out on purpose, because a gate that fires on ordinary DDL gets a marker pasted into every file.
 */
const DESTRUCTIVE_STATEMENTS = [
  {
    re: /\bdrop\s+(?:table|schema|database|sequence|type|domain|materialized\s+view|view)\b/i,
    why: 'drops an object and everything in it',
  },
  { re: /\balter\s+[\s\S]{0,200}?\bdrop\s+(?:column|constraint)\b/i, why: 'drops a column or a constraint' },
  { re: /\btruncate\b/i, why: 'empties a table' },
  { re: /\bdelete\s+from\b/i, why: 'deletes rows' },
  {
    re: /\brename\s+(?:column\s+\S+\s+)?to\b/i,
    why: 'renames something the currently deployed code still queries by its old name',
  },
];

/**
 * Blanks comments and quoted values so the scan reads only code. 0001's comments mention DROP and
 * TRUNCATE, and a `RAISE NOTICE 'dropping ...'` is a message.
 * Dollar-quoted bodies stay as code, because `DO $$ ... $$` and function bodies can hold a real DROP.
 */
export function stripSqlComments(sql) {
  const out = [];
  let index = 0;

  while (index < sql.length) {
    const run = runAt(sql, index);
    out.push(run.kind === 'code' ? sql.slice(index, index + run.length) : blankOut(sql, index, run));
    index += run.length;
  }
  return out.join('');
}

// Newlines survive so offsets and line numbers still match the file.
function blankOut(sql, index, run) {
  const keep = run.kind === 'quoted' ? 1 : 0;
  return sql.slice(index, index + keep) + sql.slice(index + keep, index + run.length).replace(/[^\n]/g, ' ');
}

const DOLLAR_TAG = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;

/** @returns {{kind: 'code' | 'comment' | 'quoted', length: number}} */
function runAt(sql, index) {
  if (sql.startsWith('--', index)) {
    const newline = sql.indexOf('\n', index);
    return { kind: 'comment', length: (newline === -1 ? sql.length : newline) - index };
  }
  if (sql.startsWith('/*', index)) {
    return { kind: 'comment', length: blockCommentLength(sql, index) };
  }
  const quote = sql[index];
  if (quote === "'" || quote === '"') {
    return { kind: 'quoted', length: quotedRunLength(sql, index) };
  }
  DOLLAR_TAG.lastIndex = index;
  const tag = DOLLAR_TAG.exec(sql);
  // Only the delimiter is consumed, so the loop then classifies comments and strings inside the body.
  if (tag !== null) return { kind: 'code', length: tag[0].length };
  return { kind: 'code', length: 1 };
}

/**
 * PostgreSQL block comments nest, so this counts depth. Stopping at the first close would read the
 * rest of an outer comment as statements.
 * Do not write a literal close delimiter in this JS comment. It would end the comment.
 */
function blockCommentLength(sql, index) {
  let depth = 0;
  let cursor = index;
  while (cursor < sql.length) {
    if (sql.startsWith('/*', cursor)) {
      depth += 1;
      cursor += 2;
    } else if (sql.startsWith('*/', cursor)) {
      depth -= 1;
      cursor += 2;
      if (depth === 0) break;
    } else {
      cursor += 1;
    }
  }
  return cursor - index;
}

/**
 * Only an E'' string honours backslash escapes, under standard_conforming_strings. A doubled quote
 * closes and reopens, which blanks the same characters, so it needs no special case.
 */
function quotedRunLength(sql, index) {
  const quote = sql[index];
  const previous = index > 0 ? sql[index - 1] : '';
  const escaped = quote === "'" && (previous === 'E' || previous === 'e');
  let cursor = index + 1;
  while (cursor < sql.length) {
    if (escaped && sql[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (sql[cursor] === quote) {
      cursor += 1;
      break;
    }
    cursor += 1;
  }
  return cursor - index;
}

/** @returns {{why: string, snippet: string}[]} */
export function findIrreversibleStatements(sql) {
  const code = stripSqlComments(sql);
  const found = [];
  for (const { re, why } of DESTRUCTIVE_STATEMENTS) {
    const match = re.exec(code);
    if (match === null) continue;
    found.push({ why, snippet: match[0].replace(/\s+/g, ' ').trim() });
  }
  return found;
}

export function declaresIrreversible(sql) {
  const match = IRREVERSIBLE_MARKER.exec(sql);
  return match !== null && match[1].trim().length > 0;
}

// Takes the whole pending set so one run reports every offending file.
function refuseUndeclaredIrreversible(pending) {
  const offenders = [];
  for (const file of pending) {
    if (declaresIrreversible(file.sql)) continue;
    const found = findIrreversibleStatements(file.sql);
    if (found.length === 0) continue;
    offenders.push(
      `  ${file.version}\n${found.map(({ why, snippet }) => `    "${snippet}" — ${why}`).join('\n')}`,
    );
  }
  if (offenders.length === 0) return;

  throw new MigrateError(
    `${offenders.length} pending migration(s) destroy something and do not say so:\n${offenders.join('\n')}\n\n` +
      'Nothing has been applied. This project is roll-forward only: there is no `down`, so a ' +
      'migration that removes data or renames an object the deployed code still uses cannot be ' +
      'undone by anything but a restore from backup.\n\n' +
      'If the change is genuinely intended, make it additive and ship the removal in a later ' +
      'release (docs/RUNBOOK.md §11.3). If it has to happen now, say so in the file:\n' +
      '  -- prl:irreversible: <what is lost, and why a restore is the only way back>',
  );
}

async function ledgerExists(sql) {
  const [row] = await sql`select to_regclass('prl.schema_migrations') is not null as present`;
  return row?.present === true;
}

async function ensureLedger(sql) {
  const [present] = await sql`
    select to_regnamespace('prl') is not null                  as schema_present,
           to_regclass('prl.schema_migrations') is not null    as ledger_present
  `;

  // Fixed DDL, no interpolation. This script is the only writer of the ledger. 0010 grants prl_app
  // SELECT for apps/api/src/schema-guard.ts.
  // Each statement runs only when needed. PostgreSQL checks CREATE on the database before
  // `if not exists`, so running it every time would make every deploy need CREATE, not just the first.
  if (present?.schema_present !== true) {
    await sql.unsafe('create schema if not exists prl');
  }
  if (present?.ledger_present !== true) {
    await sql.unsafe(`
      create table if not exists prl.schema_migrations (
        version text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      );
      comment on table prl.schema_migrations is
        'Applied migrations, with a sha256 of the file that was applied. Written only by apps/api/scripts/migrate.mjs.';
    `);
  }
}

/**
 * The ledger otherwise belongs to whoever ran `up` first (or pg_restore), and the next deploy as
 * `prl_deployer` (docs/RUNBOOK.md §5) fails with `permission denied for table schema_migrations`.
 * Runs after applying, because prl_migrator does not exist until 0001 creates it.
 * An identity outside prl_migrator only warns. Changing that is a DBA decision.
 */
async function alignLedgerOwnership(sql) {
  const [state] = await sql`
    select
      pg_catalog.pg_get_userbyid(rel.relowner) as owner,
      exists (select 1 from pg_catalog.pg_roles where rolname = 'prl_migrator') as role_exists,
      pg_catalog.pg_has_role(current_user, 'prl_migrator', 'USAGE') as is_member
    from pg_catalog.pg_class rel
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'prl' and rel.relname = 'schema_migrations'
  `;
  if (state === undefined || state.owner === 'prl_migrator') return;
  if (state.role_exists !== true || state.is_member !== true) {
    warn(
      `prl.schema_migrations is owned by "${state.owner}", not prl_migrator, and this identity ` +
        'cannot change that. Another migrating identity will not be able to read the ledger — a DBA ' +
        'needs to run: ALTER TABLE prl.schema_migrations OWNER TO prl_migrator;',
    );
    return;
  }
  // Fixed DDL, nothing interpolated.
  await sql.unsafe('alter table prl.schema_migrations owner to prl_migrator');
  note(`ledger ownership moved from "${state.owner}" to prl_migrator`);
}

async function appliedMigrations(sql) {
  const rows = await sql`select version, checksum, applied_at from prl.schema_migrations`;
  return [...rows].sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

// pg_advisory_lock takes a signed 64-bit key.
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
    // A failed unlock must not replace the original error. The lock is session-scoped, so it
    // goes when the connection closes anyway.
    try {
      await releaseLock(sql, key);
    } catch (error) {
      warn(`could not release the migration lock: ${error?.message ?? String(error)}`);
    }
  }
}

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

/** @returns {{version: string, sql: string, checksum: string}[]} files to apply, in order */
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

// A failed migration must name its file and line, not just print the driver error.

const MAX_ECHOED_LINE = 140;

/**
 * PostgreSQL's 1-based `position` indexes the whole file, since `applyFile` sends it in one call.
 * Null when there is no position, which most errors (42P07, constraint violations) lack.
 * PostgreSQL counts characters and JS counts UTF-16 units, so an astral character shifts the column.
 *
 * @returns {{line: number, column: number, text: string} | null}
 */
export function locateInSource(sql, position) {
  const index = Number(position);
  if (!Number.isInteger(index) || index < 1 || index > sql.length + 1) return null;
  const before = sql.slice(0, index - 1);
  const lineStart = before.lastIndexOf('\n') + 1;
  const newline = sql.indexOf('\n', lineStart);
  return {
    line: before.split('\n').length,
    column: index - lineStart,
    text: sql.slice(lineStart, newline === -1 ? sql.length : newline),
  };
}

function pointAtFault(spot) {
  const start = Math.max(0, spot.column - 1 - Math.floor(MAX_ECHOED_LINE / 2));
  const windowed = spot.text.slice(start, start + MAX_ECHOED_LINE);
  const prefix = start === 0 ? '' : '...';
  return [`    ${prefix}${windowed}`, `    ${' '.repeat(prefix.length + (spot.column - 1 - start))}^`];
}

// `file` and `line` are left out because they are PostgreSQL's C source location, not the migration's.
const REPORTED_FIELDS = [
  ['code', 'code'],
  ['detail', 'detail'],
  ['hint', 'hint'],
  ['where', 'context'],
  ['constraint_name', 'constraint'],
  ['table_name', 'table'],
  ['column_name', 'column'],
];

function displayPath(path) {
  // Absolute outside the repository, because `../../../../var/folders/...` is harder to read.
  const inside = relative(REPO_ROOT, path);
  return inside === '' || inside.startsWith('..') ? path : inside;
}

// Its own class, because unlike an ordinary SQL error this one did not roll everything back.
class TransactionEscaped extends Error {
  name = 'TransactionEscaped';
}

function applyFailure(file, label, error) {
  const path = displayPath(file.path);
  // The headline must not claim a rollback that did not happen. See `applyFile`.
  const escaped = error instanceof TransactionEscaped;
  const lines = [
    escaped
      ? `${label} ${file.version} ENDED ITS OWN TRANSACTION. Part of it is already committed.`
      : `${label} ${file.version} failed. Nothing it contained was applied.`,
    '',
    `  file:   ${path}`,
    `  error:  ${error?.message ?? String(error)}`,
  ];

  const spot = locateInSource(file.sql, error?.position);
  if (spot !== null) {
    lines.push(`  at:     ${path}:${spot.line}:${spot.column}`, ...pointAtFault(spot));
  }
  for (const [field, shown] of REPORTED_FIELDS) {
    const value = error?.[field];
    if (value === undefined || value === null || value === '') continue;
    lines.push(`  ${`${shown}:`.padEnd(7)} ${String(value)}`);
  }

  lines.push(
    '',
    escaped
      ? 'This runner opens ONE transaction per file, and this file closed it — a bare `COMMIT;` ' +
          '(or a `ROLLBACK;`, or a procedure that commits) does that. Everything the file executed ' +
          'before that point is DURABLE, and nothing was recorded in prl.schema_migrations, so a ' +
          'retry will replay the whole file and fail on what the first half already created.\n\n' +
          'Nothing this runner can do will undo it. Inspect the database, undo the committed half ' +
          'by hand, and remove the transaction-control statement from the file. If the file needs ' +
          'a statement that cannot run inside a transaction (`CREATE INDEX CONCURRENTLY` is the ' +
          'usual one), it cannot be a migration here — see the note at the top of 0002.'
      : 'Each file is applied inside one transaction, so that transaction has been rolled back ' +
          'and this database is exactly as it was before the run started. Fix the file and run ' +
          'again; files that had already been applied are recorded in the ledger and will not be ' +
          'repeated.',
  );
  return new MigrateError(lines.join('\n'));
}

export async function applyFile(sql, file, recordInLedger, label) {
  const startedAt = Date.now();
  try {
    await sql.begin(async (tx) => {
      // SET takes no parameters, and set_config does.
      await tx`select set_config('lock_timeout', ${STATEMENT_LOCK_TIMEOUT}, true)`;
      // A file containing `COMMIT;` ends this transaction and leaves its first half durable.
      // A transaction-local setting cannot survive that COMMIT, so its absence afterwards detects it.
      // The token is per call so a leftover session GUC cannot satisfy the check.
      const witness = createHash('sha256')
        .update(`${file.version}${startedAt}${Math.random()}`)
        .digest('hex');
      await tx`select set_config(${TRANSACTION_WITNESS}, ${witness}, true)`;
      await tx.unsafe(file.sql);
      const [seen] = await tx`select current_setting(${TRANSACTION_WITNESS}, true) as value`;
      if (seen?.value !== witness) {
        throw new TransactionEscaped(
          'the transaction this runner opened for the file was closed by the file itself',
        );
      }
      if (recordInLedger) {
        await tx`
          insert into prl.schema_migrations (version, checksum)
          values (${file.version}, ${file.checksum})
        `;
      }
    });
  } catch (error) {
    throw applyFailure(file, label, error);
  }
  return Date.now() - startedAt;
}

async function commandUp(sql, options) {
  const files = await readSqlDir(MIGRATIONS_DIR, 'migration');

  await withLock(sql, options.lockWaitMs, async () => {
    // Create and read the ledger inside the lock. `create table if not exists` is not race-safe.
    await ensureLedger(sql);
    const applied = await appliedMigrations(sql);
    const pending = planMigrations(files, applied, options);
    // Before the first apply, so one undeclared destructive file stops the whole set.
    refuseUndeclaredIrreversible(pending);

    if (pending.length === 0) {
      ok(`up to date — ${applied.length} migration(s) applied, nothing pending`);
      // Also on a no-op run, for databases migrated before this alignment existed.
      await alignLedgerOwnership(sql);
      return;
    }

    line(`${bold('Applying')} ${pending.length} migration(s)`);
    for (const file of pending) {
      const elapsed = await applyFile(sql, file, true, 'migration');
      ok(`${file.version} ${dim(`(${elapsed} ms, ${shortChecksum(file.checksum)})`)}`);
    }
    await alignLedgerOwnership(sql);
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

// Always throws, so a rollback request gets the policy, not `Unknown command "down"`.
function commandDown() {
  throw new MigrateError(
    [
      'There is no `down`. Poker Risk Lab is roll-forward only, and this is the policy, not a',
      'missing feature.',
      '',
      'Why: a rollback script is code that has never run against the database it is one day asked',
      'to save, and the first execution would be during an incident. It also cannot bring back data',
      'a forward migration removed, so in the case that actually needs undoing, the answer is a',
      'restore from backup and not a reversed migration.',
      '',
      'What to do instead:',
      '  * The schema is wrong          write the next migration. Applied files are immutable;',
      '                                 the fix is 0008, never an edit to 0007.',
      '  * The release is bad           roll the APPLICATION back and leave the schema. Migrations',
      '                                 are additive-first (docs/RUNBOOK.md §11.3), so the previous',
      '                                 release runs against the newer schema.',
      '  * Data is gone                 restore from backup (docs/RUNBOOK.md §11.4). Nothing this',
      '                                 script can do would recover it.',
      '  * A development database       `reset` drops schema prl and reapplies everything. It',
      '                                 refuses to run with NODE_ENV=production.',
      '',
      '`up` enforces the other half of the policy: it refuses a migration that destroys data or',
      'renames an object unless the file declares itself irreversible in as many words.',
    ].join('\n'),
  );
}

async function commandRoles(sql, options) {
  const files = await readSqlDir(ROLES_DIR, 'role');

  // Named from the server, so the connection string is never parsed or printed.
  const [target] = await sql`select current_database() as database, current_user as role`;
  line(`${bold('Ensuring roles')} in database "${target.database}" as "${target.role}"`);

  await withLock(sql, options.lockWaitMs, async () => {
    for (const file of files) {
      const elapsed = await applyFile(sql, file, false, 'role file');
      ok(`${file.version} ${dim(`(${elapsed} ms)`)}`);
    }
  });

  const roles = await sql`
    select rolname, rolcanlogin, rolsuper
    from pg_catalog.pg_roles
    where rolname in ('prl_migrator', 'prl_app')
    order by rolname
  `;
  for (const role of roles) {
    note(`${role.rolname}: ${role.rolcanlogin ? 'LOGIN' : 'NOLOGIN'}${role.rolsuper ? ', SUPERUSER' : ''}`);
  }
  if (roles.length < 2) {
    warn('expected both prl_migrator and prl_app to exist by now — check the notices above');
  }
  note('roles are cluster-wide, so they are not recorded in the migration ledger');
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
      const elapsed = await applyFile(sql, file, false, 'seed file');
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

/**
 * NODE_ENV is not a guard for `reset`. It runs from an operator host, and the repo's `.env` sets
 * development, so without this check a reset empties whatever it points at with no prompt.
 * The confirmation names the target, not a bare `--yes`, so a command recalled from shell history
 * refuses against any other database.
 */
export function refuseUnconfirmedReset(database, confirmed) {
  if (confirmed === database) return;
  throw new MigrateError(
    [
      `\`reset\` drops schema prl and everything in it. It is connected to "${database}".`,
      '',
      confirmed === null
        ? '  Say which database you mean, and it has to be that one:'
        : `  You named "${confirmed}", but this connection is to "${database}".`,
      '',
      `    node apps/api/scripts/migrate.mjs reset --confirm-database ${database}`,
      '',
      'NODE_ENV is not a guard here: `reset` runs from an operator host, where NODE_ENV is',
      "whatever that shell has, and the repository's own .env sets it to development.",
      'DATABASE_MIGRATION_URL is what decides which database this empties, so the',
      'acknowledgement names the database rather than the intent.',
    ].join('\n'),
  );
}

async function commandReset(sql, options) {
  refuseInProduction('reset');

  const [target] = await sql`select current_database() as database, current_user as role`;
  // Before the lock and the drop, so a refusal has changed nothing.
  refuseUnconfirmedReset(target.database, options.confirmDatabase ?? null);
  warn(`dropping schema prl in database "${target.database}" as "${target.role}"`);

  await withLock(sql, options.lockWaitMs, async () => {
    await dropSchema(sql);
    ok('schema prl dropped (roles prl_migrator and prl_app are cluster-wide and left alone)');
  });

  await commandUp(sql, options);
}

function usage() {
  line(`${bold('migrate.mjs')} — Poker Risk Lab database migrations`);
  line();
  line('  up [--allow-missing]   apply pending migrations');
  line('  down                   refuses: this project is roll-forward only. Explains what to do');
  line('  status                 show applied and pending migrations');
  line('  roles                  create the cluster-wide prl_migrator/prl_app roles (before a restore)');
  line('  seed                   apply db/seeds/*.sql (never with NODE_ENV=production)');
  line('  reset --confirm-database <name>');
  line('                         drop schema prl, then apply every migration again. The name must');
  line('                         match the database the connection is actually on.');
  line();
  line(`${dim('  DATABASE_MIGRATION_URL')}     the migrating identity; preferred over DATABASE_URL`);
  line(`${dim('  DATABASE_URL')}               fallback; never printed`);
  line(`${dim('  PRL_MIGRATE_LOCK_WAIT_MS')}   how long to wait for the migration lock (default 30000)`);
}

export function parseArgs(argv) {
  const options = { command: null, allowMissing: false, help: false, confirmDatabase: null };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--allow-missing') {
      options.allowMissing = true;
    } else if (arg === '--confirm-database') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new MigrateError('--confirm-database needs the name of the database to drop.');
      }
      options.confirmDatabase = value;
      index += 1;
    } else if (arg.startsWith('--confirm-database=')) {
      options.confirmDatabase = arg.slice('--confirm-database='.length);
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
  // Refuse before connecting. The in-command checks remain as the backstop.
  if (options.command === 'seed' || options.command === 'reset') refuseInProduction(options.command);
  if (options.command === 'down') commandDown();

  const sql = connect(databaseUrl());
  try {
    const withTimeouts = { ...options, lockWaitMs: lockWaitMs() };
    // No bare `else` fallthrough, so a command added to COMMANDS without a branch cannot run `reset`.
    if (options.command === 'up') await commandUp(sql, withTimeouts);
    else if (options.command === 'status') await commandStatus(sql);
    else if (options.command === 'roles') await commandRoles(sql, withTimeouts);
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

// Lets the test import this module without running `main()`. realpath handles a symlinked clone.
function startedFromCommandLine() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (startedFromCommandLine()) {
  try {
    await main();
  } catch (error) {
    line();
    if (error instanceof MigrateError) {
      line(`${red('  ✗')} ${error.message}`);
    } else {
      // A driver or PostgreSQL error. The stack stays behind PRL_DEBUG.
      const detail = [error?.detail, error?.hint, error?.where].filter(Boolean).join(' | ');
      line(`${red('  ✗')} ${error?.message ?? String(error)}`);
      if (error?.position) note(`at character ${error.position}`);
      if (detail !== '') note(detail);
      // Redacted too. Driver errors carry the failing statement and its bind parameters.
      if (process.env.PRL_DEBUG) {
        console.error(redact(error?.stack ?? String(error)));
        console.error(redact(inspectError(error)));
      }
    }
    line();
    process.exitCode = 1;
  }
}
