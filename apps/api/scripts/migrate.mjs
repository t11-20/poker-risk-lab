#!/usr/bin/env node
/**
 * migrate.mjs — the migration runner for Poker Risk Lab.
 *
 *   node apps/api/scripts/migrate.mjs up [--allow-missing]
 *   node apps/api/scripts/migrate.mjs status
 *   node apps/api/scripts/migrate.mjs down
 *   node apps/api/scripts/migrate.mjs roles
 *   node apps/api/scripts/migrate.mjs seed
 *   node apps/api/scripts/migrate.mjs reset
 *
 * Dependency-free apart from `postgres` (porsager/postgres), which the API already
 * depends on. A migration runner that pulls in a framework to move some SQL
 * around is a second thing that can break on the day the first one does.
 *
 * ## Rollback: there is none, and that is a decision rather than an omission
 *
 * **This project is roll-forward only.** There are no `*.down.sql` files, `down`
 * exists solely to say so, and nothing in this runner will ever undo an applied
 * migration. The reasoning is the same one that makes an applied migration
 * immutable: a `down` script is code that has, by construction, never run against
 * the database it is one day asked to save, and the first time anybody executes it
 * is the worst possible moment to find out it was wrong. A rollback also cannot
 * restore data a forward migration dropped, so the rollback that operators
 * actually need in that case is a restore from backup, not a `down` file that
 * recreates an empty column.
 *
 * A policy is only real if something enforces it, so two things do:
 *
 *   * `down` is a **first-class command that refuses**, with the policy and the
 *     alternatives in the message. A deploy pipeline that asks for a rollback gets
 *     an answer, not `Unknown command "down"`, which reads like a version skew and
 *     sends the operator looking for the wrong problem.
 *   * `up` **refuses to apply a migration containing a destructive statement**
 *     unless that file declares itself irreversible in as many words — see
 *     `findIrreversibleStatements` below. Roll-forward-only is safe exactly as long
 *     as migrations are additive; the day one is not, the person writing it has to
 *     say so, which is when the two-release plan in docs/RUNBOOK.md §11.3 gets
 *     thought about rather than discovered.
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
 *
 * **`roles` exists for the one path where no migration will run: a restore.**
 * `prl_migrator` and `prl_app` are cluster-wide objects, and `pg_dump` of a single
 * database does not contain them — only `pg_dumpall --globals-only` does. A dump
 * that kept its ownership and its ACLs (which it must, or the restored database
 * grants the runtime role nothing) therefore fails on a fresh cluster with "role
 * prl_migrator does not exist". `roles` applies db/roles/*.sql, which creates just
 * those two roles, so the restore has somewhere to attach its owners and grants.
 * It is not recorded in the ledger: it describes the cluster, not the schema.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');
const SEEDS_DIR = join(REPO_ROOT, 'db', 'seeds');
const ROLES_DIR = join(REPO_ROOT, 'db', 'roles');

/** NNNN_lower_snake_case.sql — anything else is a naming mistake, not a migration. */
const FILE_NAME_PATTERN = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

/** Namespaces the advisory lock so it cannot collide with another app's key. */
const LOCK_NAMESPACE = 'poker-risk-lab/db/migrations';
const DEFAULT_LOCK_WAIT_MS = 30_000;
/** How long a migration waits for a table lock before giving up. */
const STATEMENT_LOCK_TIMEOUT = '10s';

const COMMANDS = ['up', 'down', 'status', 'roles', 'seed', 'reset'];

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

/**
 * The connection string, preferring the migration identity over the runtime one.
 *
 * `DATABASE_URL` is the API's connection, and after the least-privilege change it
 * names a member of `prl_app`: DML only, no CREATE, and no grant at all on
 * prl.schema_migrations. Migrating as that identity cannot work, and the failure
 * would be a permission error four statements into 0001 rather than a sentence.
 * `DATABASE_MIGRATION_URL` is therefore read first, and DATABASE_URL remains the
 * fallback so a deployment that has only ever set one variable keeps working.
 */
function databaseUrl() {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL;
  if (typeof migrationUrl === 'string' && migrationUrl.trim() !== '') return migrationUrl;

  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url.trim() === '') {
    throw new MigrateError(
      // Written without a literal example URL on purpose: every line this script
      // prints goes through redact(), which would replace one with [redacted] and
      // leave the reader worse off than a description does.
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
// Roll-forward-only enforcement.
//
// See the policy at the top of this file. `up` will not apply a migration that
// destroys data or renames something out from under a running process unless the
// file declares itself irreversible, because those are exactly the migrations for
// which "we can always roll back" is false and somebody needs to have noticed.
// ---------------------------------------------------------------------------

/**
 * The acknowledgement a genuinely irreversible migration has to carry, as a
 * comment anywhere in the file:
 *
 *   -- prl:irreversible: the invite_code column has been unused since 0014 and
 *   -- the values are not recoverable; restoring them means restoring a backup.
 *
 * A reason is required rather than a bare marker. The point of the gate is to
 * make somebody write down what cannot be undone, and a marker with no sentence
 * after it is a checkbox, not a decision.
 */
// The reason has to start on the marker's own line, so the horizontal-whitespace
// classes are deliberate: a plain \s* would cross the newline and read the next
// SQL statement as the justification for deleting the thing it operates on.
const IRREVERSIBLE_MARKER = /--[^\S\n]*prl:irreversible[^\S\n]*:[^\S\n]*(\S[^\n]*)/i;

/**
 * Statements that a later migration cannot put back.
 *
 * Deliberately narrow. `DROP INDEX`, `REVOKE` and `ALTER ... SET DEFAULT` are all
 * absent because a following migration really can restore them — the gate is about
 * data and about names the running application still holds, not about every
 * statement that changes something. A gate that fires on ordinary DDL is a gate
 * that gets a blanket marker pasted into every file, which is worse than no gate.
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
 * The SQL with comments removed and quoted *values* blanked, so the scan above
 * reads code and only code.
 *
 * Both halves matter and both were needed by the files already in db/migrations.
 * 0001's prose explains at length that the runtime role holds no DROP and no
 * TRUNCATE, so a scan of the raw text flags a migration that does neither. And a
 * `RAISE NOTICE 'dropping ...'` is a message, not a statement.
 *
 * Dollar-quoted bodies are deliberately treated as CODE rather than as strings:
 * `DO $$ ... $$` and a PL/pgSQL function body are the two places a real DROP can
 * hide, and PL/pgSQL applies the same comment syntax inside them. Single- and
 * double-quoted runs are treated as data, which is what they are.
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

/** Comment and string content become spaces; newlines survive so offsets and lines do. */
function blankOut(sql, index, run) {
  const keep = run.kind === 'quoted' ? 1 : 0;
  return sql.slice(index, index + keep) + sql.slice(index + keep, index + run.length).replace(/[^\n]/g, ' ');
}

/** A dollar-quote delimiter — `$$` or `$tag$` — anchored at the scan position. */
const DOLLAR_TAG = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/y;

/**
 * Classifies the run starting at `index`.
 *
 * @returns {{kind: 'code' | 'comment' | 'quoted', length: number}}
 */
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
  // A dollar-quoted body is passed through as code, and the loop then walks into
  // it, so the comments and strings inside are classified by the branches above.
  if (tag !== null) return { kind: 'code', length: tag[0].length };
  return { kind: 'code', length: 1 };
}

/**
 * PostgreSQL block comments nest, so this counts depth rather than searching for the first
 * closing delimiter. Opening two comments and closing them both is ONE comment in SQL, not one
 * and a half — searching for the first close would end it early and treat the remainder as
 * statements, which is how a scanner comes to see a DROP that is really prose.
 *
 * (The delimiters are deliberately described rather than written out: this is a JavaScript block
 * comment, and a literal close sequence inside it would end this comment here. That is not a
 * hypothetical — this file previously kept the illustration parseable with zero-width spaces
 * wedged into the delimiters, which `repo-hygiene.mjs` rejects as hidden characters, and removing
 * them turned the comment into a syntax error.)
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
 * An E'' string honours backslash escapes; a plain one does not, under the
 * standard_conforming_strings default this project relies on. Doubling ('' inside
 * '') closes and immediately reopens, which blanks the same characters either way,
 * so it needs no special case.
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

/**
 * @returns {{why: string, snippet: string}[]} destructive statements found in `sql`
 */
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

/** True when the file acknowledges, with a reason, that it cannot be undone. */
export function declaresIrreversible(sql) {
  const match = IRREVERSIBLE_MARKER.exec(sql);
  return match !== null && match[1].trim().length > 0;
}

/**
 * Refuses any pending migration that destroys something without saying so.
 * Called with the whole pending set so one run reports every offending file.
 */
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

// ---------------------------------------------------------------------------
// The ledger.
// ---------------------------------------------------------------------------

async function ledgerExists(sql) {
  const [row] = await sql`select to_regclass('prl.schema_migrations') is not null as present`;
  return row?.present === true;
}

async function ensureLedger(sql) {
  const [present] = await sql`
    select to_regnamespace('prl') is not null                  as schema_present,
           to_regclass('prl.schema_migrations') is not null    as ledger_present
  `;

  // Fixed DDL, no interpolation. The schema is created here so the very first
  // migration has somewhere to record itself; 0001 then hands ownership of the
  // schema to prl_migrator. prl_app is granted nothing on the ledger: the runtime
  // has no business reading, let alone editing, which migrations have run.
  //
  // Each statement is issued only when it has work to do, which is a privilege
  // decision rather than an optimisation. PostgreSQL checks CREATE on the DATABASE
  // before it checks the `if not exists`, so running `create schema if not exists
  // prl` unconditionally makes every deploy require a privilege that is genuinely
  // needed exactly once — on the first one. With this, a steady-state deploy as
  // prl_deployer needs nothing beyond what owning the schema already gives it.
  // `if not exists` is kept on both because this runs inside the advisory lock and
  // the belt-and-braces form costs nothing.
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
 * Hands the ledger to prl_migrator, if it is not already there.
 *
 * The ledger is created by this script rather than by a migration, so without
 * this it belongs to whichever identity happened to run `up` first — and nobody
 * else can read it. That is a defect with a delayed and very confusing symptom:
 * the first deploy works because it was bootstrapped by a superuser, and the
 * SECOND one, as the `prl_deployer` role docs/RUNBOOK.md §5 documents, fails with
 * `permission denied for table schema_migrations` before it has planned anything.
 * The same thing happens after a restore, where the ledger arrives owned by
 * whoever ran pg_restore.
 *
 * prl_migrator owns everything else in the schema, so the ledger belongs to it
 * too. Called after the pending files have been applied, because on a virgin
 * database prl_migrator does not exist until 0001 has created it.
 *
 * Silent when it cannot: an identity that is not a member of prl_migrator cannot
 * give an object away, and that is a privilege decision for a DBA rather than
 * something a migration runner should force or fail over.
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
  // Fixed DDL: both names are literals in this file, nothing is interpolated.
  await sql.unsafe('alter table prl.schema_migrations owner to prl_migrator');
  note(`ledger ownership moved from "${state.owner}" to prl_migrator`);
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

// ---------------------------------------------------------------------------
// Failure reporting.
//
// A migration that fails has to say WHICH ONE. Before this existed, `applyFile`
// let the raw driver error through and the top-level handler printed only its
// message — so with four files in db/migrations an operator saw `relation "users"
// already exists` and nothing at all naming the file, the line, or even which
// command had been running. At 3am that is the difference between a two-minute
// fix and an hour of `git log` on a schema.
// ---------------------------------------------------------------------------

/** The longest source line this will echo. Beyond it, a window around the fault. */
const MAX_ECHOED_LINE = 140;

/**
 * Maps PostgreSQL's `position` — a 1-based index into the statement it was given —
 * onto the file, because the statement it was given IS the file: `applyFile` sends
 * the whole `.sql` through one `.unsafe()` call.
 *
 * Returns null when there is no usable position, which is the common case: a great
 * many errors (`42P07 relation already exists`, every constraint violation) carry
 * no cursor at all, and inventing one would point at the wrong place with total
 * confidence.
 *
 * The caveat, stated because it is real and small: PostgreSQL counts characters and
 * JavaScript indexes UTF-16 code units, so a migration containing an astral-plane
 * character before the fault would report a column one too far for each. Every file
 * in db/migrations is ASCII, and a column that is off by one still names the right
 * line.
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

/** The source line and a caret under the fault, windowed so one long line cannot fill a terminal. */
function pointAtFault(spot) {
  const start = Math.max(0, spot.column - 1 - Math.floor(MAX_ECHOED_LINE / 2));
  const windowed = spot.text.slice(start, start + MAX_ECHOED_LINE);
  const prefix = start === 0 ? '' : '...';
  return [
    `    ${prefix}${windowed}`,
    // The caret is built from spaces only, so it lines up under the echoed text above.
    `    ${' '.repeat(prefix.length + (spot.column - 1 - start))}^`,
  ];
}

/**
 * The diagnostic fields worth putting in front of a person, as label/value pairs.
 *
 * A deliberate subset of what `inspectError` dumps under PRL_DEBUG. `file` and
 * `line` are absent because they are PostgreSQL's own C source location, which
 * looks exactly like the migration's file and line and is never what the reader
 * wants; `severity` and `routine` are absent for the same "true but not useful"
 * reason. `code` stays, because a SQLSTATE is the one thing that makes an error
 * searchable.
 */
const REPORTED_FIELDS = [
  ['code', 'code'],
  ['detail', 'detail'],
  ['hint', 'hint'],
  ['where', 'context'],
  ['constraint_name', 'constraint'],
  ['table_name', 'table'],
  ['column_name', 'column'],
];

/**
 * Turns whatever a file's transaction threw into an error that names the file.
 *
 * The whole message goes through `redact()` on its way out like every other line
 * this script prints, so a driver error that quoted a connection string cannot
 * reach a terminal or a CI log through here.
 */
function displayPath(path) {
  // Repository-relative when the file is inside the checkout, which is every real run;
  // absolute otherwise, because `../../../../var/folders/...` is worse than the truth.
  const inside = relative(REPO_ROOT, path);
  return inside === '' || inside.startsWith('..') ? path : inside;
}

function applyFailure(file, label, error) {
  const path = displayPath(file.path);
  const lines = [
    `${label} ${file.version} failed. Nothing it contained was applied.`,
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
    'Each file is applied inside one transaction, so that transaction has been rolled back and ' +
      'this database is exactly as it was before the run started. Fix the file and run again; ' +
      'files that had already been applied are recorded in the ledger and will not be repeated.',
  );
  return new MigrateError(lines.join('\n'));
}

/**
 * Applies one file inside one transaction, and names it if anything goes wrong.
 *
 * Exported for the same reason `stripSqlComments` and `findIrreversibleStatements` are: a
 * failure message an operator depends on at 3am is a behaviour, and a behaviour with no test
 * is a claim. `apps/api/scripts/migrate.test.mjs` drives this with a stub handle and a real
 * broken `.sql` file, which needs no database — see the note at the top of that file for what
 * that does and does not prove.
 */
export async function applyFile(sql, file, recordInLedger, label) {
  const startedAt = Date.now();
  try {
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
  } catch (error) {
    throw applyFailure(file, label, error);
  }
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
    // Checked after planning and before the first apply, so a set containing one
    // undeclared destructive file applies none of it rather than the first half.
    refuseUndeclaredIrreversible(pending);

    if (pending.length === 0) {
      ok(`up to date — ${applied.length} migration(s) applied, nothing pending`);
      // Still checked on a no-op run: a database migrated before this alignment
      // existed is exactly the one whose next deploy would fail on it.
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

/**
 * Always throws. `down` is a command so that asking for a rollback gets the policy
 * instead of `Unknown command "down"` — which reads like a version skew and sends
 * an operator hunting for a missing release rather than reading a decision.
 *
 * Deliberately never opens a connection: there is nothing to ask the database.
 */
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

  // Named from the server so the operator can see which cluster is about to gain
  // roles, without this script going anywhere near the connection string.
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
  line('  down                   refuses: this project is roll-forward only. Explains what to do');
  line('  status                 show applied and pending migrations');
  line('  roles                  create the cluster-wide prl_migrator/prl_app roles (before a restore)');
  line('  seed                   apply db/seeds/*.sql (never with NODE_ENV=production)');
  line('  reset                  drop schema prl, then apply every migration again');
  line();
  line(`${dim('  DATABASE_MIGRATION_URL')}     the migrating identity; preferred over DATABASE_URL`);
  line(`${dim('  DATABASE_URL')}               fallback; never printed`);
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
  // Same reasoning: `down` has no database work to do in any environment, so it
  // answers without a connection and without DATABASE_URL having to be set.
  if (options.command === 'down') commandDown();

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

/**
 * True when this file was started from the command line rather than imported.
 *
 * The pure helpers above (`stripSqlComments`, `findIrreversibleStatements`) are
 * exported so apps/api/scripts/migrate.test.mjs can assert on them directly; a
 * roll-forward-only policy whose enforcement has no test is a claim rather than a
 * gate. Without this guard, importing the module would run `main()` as a side
 * effect of the import. realpath on both sides so a checkout reached through a
 * symlink still recognises itself.
 */
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
}
