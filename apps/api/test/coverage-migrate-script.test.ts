/**
 * `apps/api/scripts/migrate.mjs`, driven as the operational tool it is.
 *
 * ## The hole this closes
 *
 * Twenty-eight kilobytes of migration runner, run by `pnpm run db:migrate`, by `db:setup`, by the
 * Docker entrypoint and by CI, and it had no test of any kind. Every safety property it documents
 * at length — a checksum mismatch aborts rather than reapplying, an out-of-order file is refused, a
 * second runner waits on an advisory lock instead of applying the same file twice, `seed` and
 * `reset` refuse in production before they so much as connect — was asserted only by its own
 * comments. Those are the properties that matter at three in the morning, and they were all
 * untested.
 *
 * ## How this is run, and why it needs its own database
 *
 * The runner is a CLI. It exports nothing, and importing it would execute `main()`. So every case
 * spawns it exactly as an operator would, reads its exit code and its output, and then inspects the
 * database it acted on.
 *
 * Those databases are created for the test and dropped afterwards. That is not fastidiousness:
 * `up` from empty, a tampered ledger and `reset` all need a database whose schema this file is free
 * to destroy, and doing any of it in the suite's own database would take every other test with it.
 * Creating one needs a role with CREATEDB — which the documented development role and the CI role
 * both are — and the failure message below says so if it is ever not true.
 *
 * ## What is deliberately not asserted
 *
 * The set of verbs. `--help` is checked to list the four documented commands; nothing here asserts
 * that no fifth exists, because a rollback verb is being considered and a test that fails on its
 * arrival would be a test that punishes the fix. See the note at the end of this file for what
 * would be worth adding when it lands.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createDatabaseClient, type Sql } from '../src/db.ts';
import { generateOpaqueSecret } from '../src/repositories/ids.ts';
import { adminDatabaseUrl, databaseSkip } from './helpers/database.ts';

const execFileAsync = promisify(execFile);

const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';
const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..', '..');
const MIGRATE = join(API_DIR, 'scripts', 'migrate.mjs');
const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');

/**
 * The checksum rule from `migrate.mjs`, copied rather than imported.
 *
 * Copied on purpose, and for the same reason `test/repositories.test.ts` copies the id domain: if
 * the runner and this file ever disagree about what a migration hashes to, one of the two literals
 * is wrong and the test says which. Importing it would make the assertion vacuous — and the runner
 * exports nothing anyway.
 */
function checksumOf(contents: string): string {
  const normalised = contents.replace(/^/, '').replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}

/** Every migration on disk, in the order the runner will apply them. */
const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql') && !name.startsWith('.'))
  .sort()
  .map((name) => ({ version: name, checksum: checksumOf(readFileSync(join(MIGRATIONS_DIR, name), 'utf8')) }));

const databaseUrl = adminDatabaseUrl();
let maintenance: Sql | null = null;
let skipReason: string | false = databaseSkip('the migration runner');

/**
 * A connection to the cluster's maintenance database, used only to create and drop the throwaway
 * databases each case works in.
 *
 * `postgres` is the database every PostgreSQL cluster has and the one `CREATE DATABASE` has to be
 * issued from — it cannot run inside the database it creates, and it cannot run in a transaction.
 */
function maintenanceUrlFor(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = '/postgres';
  return parsed.toString();
}

function clientFor(url: string): Sql {
  return createDatabaseClient(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: TEST_SECRET,
      DATABASE_POOL_MAX: '2',
      // Creating a database copies a template; on a busy machine that is not instant.
      DATABASE_STATEMENT_TIMEOUT_MS: '30000',
    }),
  );
}

if (databaseUrl !== undefined) {
  try {
    const probe = clientFor(maintenanceUrlFor(databaseUrl));
    await probe`select 1`;
    maintenance = probe;
  } catch (error) {
    skipReason = `the cluster's maintenance database is not reachable (${
      error instanceof Error ? error.name : 'error'
    })`;
  }
}

if (skipReason !== false) {
  console.info(`[coverage-migrate-script.test.ts] skipping database-backed tests: ${skipReason}`);
}

const dbOptions = { skip: skipReason };

after(async () => {
  if (maintenance !== null) await maintenance.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// Throwaway databases
// ---------------------------------------------------------------------------

interface Throwaway {
  readonly name: string;
  readonly url: string;
  /** A client connected to the throwaway database, for inspecting what the runner did. */
  readonly sql: Sql;
}

/**
 * A brand-new, empty database, and a client on it.
 *
 * The name is generated from the same CSPRNG the repositories use and matched against a strict
 * pattern before it is ever interpolated. `CREATE DATABASE` cannot take a bind parameter — the
 * identifier is part of the statement — so `sql(name)` is used, which is postgres.js's identifier
 * quoting rather than string concatenation. The assertion is the belt: a name that could not
 * possibly be an identifier never reaches the driver.
 */
async function createThrowaway(): Promise<Throwaway> {
  const handle = maintenance;
  assert.ok(handle !== null, 'the migration tests need a maintenance connection');
  const name = `prl_migrate_test_${generateOpaqueSecret(6)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')}`;
  assert.match(name, /^prl_migrate_test_[a-z0-9]{4,32}$/, 'refusing to use that as an identifier');
  assert.ok(databaseUrl !== undefined);
  try {
    await handle`create database ${handle(name)}`;
  } catch (error) {
    assert.fail(
      `could not create a throwaway database (${error instanceof Error ? error.message : String(error)}).\n` +
        'These tests drive the migration runner from empty, tamper with its ledger and run `reset`, ' +
        'so they need a database of their own — which means the role in DATABASE_URL needs CREATEDB. ' +
        'The documented development role and the CI role both have it.',
    );
  }
  const url = new URL(databaseUrl);
  url.pathname = `/${name}`;
  const target = url.toString();
  return { name, url: target, sql: clientFor(target) };
}

async function dropThrowaway(throwaway: Throwaway): Promise<void> {
  const handle = maintenance;
  assert.ok(handle !== null);
  await throwaway.sql.end({ timeout: 5 });
  // `with (force)` terminates anything still connected, so one leaked connection in a failing case
  // cannot leave a database behind for the next run to trip over.
  await handle`drop database if exists ${handle(throwaway.name)} with (force)`;
}

/** Creates a database, runs `use`, and drops it however that ended. */
async function withThrowaway(use: (throwaway: Throwaway) => Promise<void>): Promise<void> {
  const throwaway = await createThrowaway();
  try {
    await use(throwaway);
  } finally {
    await dropThrowaway(throwaway);
  }
}

// ---------------------------------------------------------------------------
// Running the script
// ---------------------------------------------------------------------------

interface RunResult {
  readonly code: number;
  /** stdout and stderr together: the script writes its findings to both. */
  readonly output: string;
}

/**
 * Spawns the runner exactly as an operator would.
 *
 * `DATABASE_URL` is set explicitly (or removed) rather than inherited, so a case that means to run
 * without one genuinely does — this process has one, and inheriting it would make that case pass
 * for the wrong reason.
 *
 * `DATABASE_MIGRATION_URL` is removed from the child's environment, always, and that is a safety
 * measure rather than tidiness. The runner reads it *in preference to* `DATABASE_URL`, and the
 * test command loads the repository's `.env`, so a developer machine where that variable is set
 * would send every command below — including `reset`, which drops schema prl — to whatever
 * database it names instead of to the throwaway one this file created. A case that wants to
 * exercise it can pass it in `env` explicitly.
 */
async function runMigrate(
  args: readonly string[],
  options: { readonly url?: string | undefined; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<RunResult> {
  const env: Record<string, string> = {
    // Built by filtering rather than by copying and deleting: a variable that is absent has to be
    // absent, and "assign undefined and hope the child_process layer drops it" is a promise made
    // somewhere else. Two connection strings are dropped here and re-added below only if a case
    // asked for them.
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'DATABASE_URL' && entry[0] !== 'DATABASE_MIGRATION_URL',
      ),
    ),
    // Colour codes would land in the middle of every assertion.
    NO_COLOR: '1',
    ...options.env,
  };
  if (options.url !== undefined) env['DATABASE_URL'] = options.url;

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [MIGRATE, ...args], {
      env,
      cwd: REPO_ROOT,
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    // `execFile` rejects on a non-zero exit, with the output attached.
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

interface LedgerRow {
  readonly version: string;
  readonly checksum: string;
  readonly applied_at: Date;
}

function ledgerOf(throwaway: Throwaway): Promise<readonly LedgerRow[]> {
  return throwaway.sql<LedgerRow[]>`
    select version, checksum, applied_at from prl.schema_migrations order by version
  `;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

describe('migrate.mjs — applying to a database that has never been migrated', dbOptions, () => {
  it('reports everything as pending before anything has run', async () => {
    await withThrowaway(async (throwaway) => {
      const status = await runMigrate(['status'], { url: throwaway.url });
      assert.equal(status.code, 0, status.output);
      assert.match(status.output, /prl\.schema_migrations does not exist yet/);
      for (const file of MIGRATION_FILES) {
        assert.match(status.output, new RegExp(`pending\\s+${file.version.replace(/\./g, '\\.')}`));
      }
      assert.match(status.output, new RegExp(`${MIGRATION_FILES.length} pending, 0 applied`));
    });
  });

  it('applies every migration in filename order and records each with its checksum', async () => {
    await withThrowaway(async (throwaway) => {
      const up = await runMigrate(['up'], { url: throwaway.url });
      assert.equal(up.code, 0, up.output);
      assert.match(up.output, new RegExp(`Applying ${MIGRATION_FILES.length} migration`));

      const ledger = await ledgerOf(throwaway);
      assert.deepEqual(
        ledger.map((row) => row.version),
        MIGRATION_FILES.map((file) => file.version),
      );
      assert.deepEqual(
        ledger.map((row) => row.checksum),
        MIGRATION_FILES.map((file) => file.checksum),
        'the ledger records the sha256 of the file that was applied',
      );
      // Applied in filename order, which is what makes a schema reproducible: 0002 adds indexes to
      // tables 0001 creates, so the reverse order does not merely look wrong, it fails.
      const times = ledger.map((row) => row.applied_at.getTime());
      for (let index = 1; index < times.length; index += 1) {
        const previous = times[index - 1];
        const current = times[index];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(current >= previous, `${ledger[index]?.version} was applied before its predecessor`);
      }

      // And the schema is genuinely there, not merely recorded.
      const tables = await throwaway.sql<{ table_name: string }[]>`
        select table_name from information_schema.tables where table_schema = 'prl'
      `;
      const names = new Set(tables.map((row) => row.table_name));
      for (const expected of ['users', 'sessions', 'rooms', 'room_members', 'hands', 'hand_actions']) {
        assert.ok(names.has(expected), `prl.${expected} was not created`);
      }
    });
  });

  it('is idempotent: a second run applies nothing and rewrites nothing', async () => {
    await withThrowaway(async (throwaway) => {
      assert.equal((await runMigrate(['up'], { url: throwaway.url })).code, 0);
      const first = await ledgerOf(throwaway);

      const again = await runMigrate(['up'], { url: throwaway.url });
      assert.equal(again.code, 0, again.output);
      assert.match(again.output, /up to date/);
      assert.match(again.output, new RegExp(`${MIGRATION_FILES.length} migration\\(s\\) applied`));

      const second = await ledgerOf(throwaway);
      assert.deepEqual(
        second.map((row) => `${row.version}@${row.applied_at.toISOString()}`),
        first.map((row) => `${row.version}@${row.applied_at.toISOString()}`),
        'a no-op run must not re-stamp the ledger; applied_at is when it was applied',
      );

      const status = await runMigrate(['status'], { url: throwaway.url });
      assert.equal(status.code, 0, status.output);
      assert.match(status.output, new RegExp(`${MIGRATION_FILES.length} applied and matching, 0 pending`));
    });
  });

  it('lets two runners race, and applies each migration exactly once', async () => {
    await withThrowaway(async (throwaway) => {
      // Two deploys starting together. Without the advisory lock both read "everything is pending"
      // and both apply, and the loser fails on the ledger's primary key — if it is lucky. The lock
      // is what makes the second one wait and then find nothing to do.
      const [first, second] = await Promise.all([
        runMigrate(['up'], { url: throwaway.url }),
        runMigrate(['up'], { url: throwaway.url }),
      ]);
      assert.equal(first.code, 0, first.output);
      assert.equal(second.code, 0, second.output);

      const outputs = [first.output, second.output];
      assert.equal(
        outputs.filter((output) => /Applying \d+ migration/.test(output)).length,
        1,
        'exactly one of the two runners may apply anything',
      );
      assert.equal(
        outputs.filter((output) => /up to date/.test(output)).length,
        1,
        'the other must find the work already done',
      );
      const ledger = await ledgerOf(throwaway);
      assert.equal(ledger.length, MIGRATION_FILES.length, 'no migration was recorded twice');
    });
  });
});

// ---------------------------------------------------------------------------
// Ledger integrity
// ---------------------------------------------------------------------------

describe('migrate.mjs — the ledger is what makes a schema reproducible', dbOptions, () => {
  it('refuses to run when an applied migration no longer matches its file', async () => {
    await withThrowaway(async (throwaway) => {
      assert.equal((await runMigrate(['up'], { url: throwaway.url })).code, 0);
      const target = MIGRATION_FILES[0];
      assert.ok(target !== undefined);

      // The ledger is tampered with rather than the file, because the file is shared with every
      // other engineer working in this tree — and the runner compares the two, so either direction
      // exercises the same check.
      await throwaway.sql`
        update prl.schema_migrations
           set checksum = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
         where version = ${target.version}
      `;

      const refused = await runMigrate(['up'], { url: throwaway.url });
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /no longer match the file that was applied/);
      assert.match(refused.output, new RegExp(target.version.replace(/\./g, '\\.')));
      assert.match(refused.output, /Nothing has been applied/);

      // `status` has to be able to say the same thing without refusing, or nobody can diagnose it.
      const status = await runMigrate(['status'], { url: throwaway.url });
      assert.equal(status.code, 0, status.output);
      assert.match(status.output, /CHANGED/);
      assert.match(status.output, /`up` will refuse/);

      // Put the ledger back, and the runner is content again — which is what proves the refusal
      // above was about the checksum and not about something else that happened to be broken.
      await throwaway.sql`
        update prl.schema_migrations set checksum = ${target.checksum} where version = ${target.version}
      `;
      const recovered = await runMigrate(['up'], { url: throwaway.url });
      assert.equal(recovered.code, 0, recovered.output);
      assert.match(recovered.output, /up to date/);
    });
  });

  it('refuses a ledger entry with no file unless told explicitly, and never applies out of order', async () => {
    await withThrowaway(async (throwaway) => {
      assert.equal((await runMigrate(['up'], { url: throwaway.url })).code, 0);
      const last = MIGRATION_FILES.at(-1);
      assert.ok(last !== undefined);

      // A migration this checkout does not have — a squashed file, or a branch that shipped one
      // this one has not seen. The database can no longer be rebuilt from the repository, and the
      // runner has to say so rather than carry on.
      await throwaway.sql`
        insert into prl.schema_migrations (version, checksum)
        values ('9999_from_another_branch.sql', 'sha256:deadbeef')
      `;
      const refused = await runMigrate(['up'], { url: throwaway.url });
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /9999_from_another_branch\.sql/);
      assert.match(refused.output, /cannot be rebuilt from the repository/);

      const allowed = await runMigrate(['up', '--allow-missing'], { url: throwaway.url });
      assert.equal(allowed.code, 0, allowed.output);
      assert.match(allowed.output, /allowed by --allow-missing/);

      // Now the out-of-order case, which is the one two merged branches produce: the ledger's
      // highest version sorts above a file that has not been applied. Applying it now would give
      // this database a different schema from one built in order.
      await throwaway.sql`delete from prl.schema_migrations where version = ${last.version}`;
      const outOfOrder = await runMigrate(['up', '--allow-missing'], { url: throwaway.url });
      assert.equal(outOfOrder.code, 1, outOfOrder.output);
      assert.match(outOfOrder.output, /Out-of-order migration/);
      assert.match(outOfOrder.output, new RegExp(last.version.replace(/\./g, '\\.')));
      assert.match(outOfOrder.output, /9999_from_another_branch\.sql/);
    });
  });
});

// ---------------------------------------------------------------------------
// Seeds and reset
// ---------------------------------------------------------------------------

describe('migrate.mjs — seeding and resetting', dbOptions, () => {
  it('will not seed a database that has not been migrated', async () => {
    await withThrowaway(async (throwaway) => {
      const refused = await runMigrate(['seed'], { url: throwaway.url });
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /Nothing has been migrated yet/);
    });
  });

  it('seeds fixtures, and seeding twice changes nothing', async () => {
    await withThrowaway(async (throwaway) => {
      assert.equal((await runMigrate(['up'], { url: throwaway.url })).code, 0);

      const first = await runMigrate(['seed'], { url: throwaway.url });
      assert.equal(first.code, 0, first.output);
      assert.match(first.output, /seeds are not recorded in the ledger/);
      const afterFirst = await throwaway.sql<{ count: number }[]>`
        select count(*)::int as count from prl.users
      `;
      assert.ok((afterFirst[0]?.count ?? 0) > 0, 'the seed inserted nothing');

      const second = await runMigrate(['seed'], { url: throwaway.url });
      assert.equal(second.code, 0, second.output);
      const afterSecond = await throwaway.sql<{ count: number }[]>`
        select count(*)::int as count from prl.users
      `;
      assert.equal(
        afterSecond[0]?.count,
        afterFirst[0]?.count,
        'seeds are written to be safe to re-run, which is why they are not in the ledger',
      );

      // And they are genuinely not recorded, so `status` still reports only the migrations.
      const ledger = await ledgerOf(throwaway);
      assert.equal(ledger.length, MIGRATION_FILES.length);
    });
  });

  it('reset drops the schema and applies every migration again', async () => {
    await withThrowaway(async (throwaway) => {
      assert.equal((await runMigrate(['up'], { url: throwaway.url })).code, 0);
      assert.equal((await runMigrate(['seed'], { url: throwaway.url })).code, 0);

      const reset = await runMigrate(['reset'], { url: throwaway.url });
      assert.equal(reset.code, 0, reset.output);
      assert.match(reset.output, /dropping schema prl/);
      assert.match(reset.output, /roles prl_migrator and prl_app are cluster-wide and left alone/);

      const ledger = await ledgerOf(throwaway);
      assert.deepEqual(
        ledger.map((row) => row.version),
        MIGRATION_FILES.map((file) => file.version),
        'reset ends with a fully migrated schema',
      );
      const users = await throwaway.sql<{ count: number }[]>`select count(*)::int as count from prl.users`;
      assert.equal(users[0]?.count, 0, 'reset drops the data with the schema; it does not re-seed');
    });
  });
});

// ---------------------------------------------------------------------------
// Refusals that do not need a database at all
// ---------------------------------------------------------------------------

describe('migrate.mjs — what it refuses to do', () => {
  /** A URL nothing is listening on, so a command that connects fails visibly. */
  const DEAD_URL = 'postgresql://someone:sup3rsecretpassw0rd@127.0.0.1:1/nothing';

  it('will not seed or reset a production database, and does not connect to find out', async () => {
    for (const command of ['seed', 'reset']) {
      const refused = await runMigrate([command], {
        url: DEAD_URL,
        env: { NODE_ENV: 'production' },
      });
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, new RegExp(`\`${command}\` will not run with NODE_ENV=production`));
      // The refusal happens before a connection is opened, which is why a URL that cannot be
      // reached still produces the production message rather than a connection error. A refusal
      // that authenticates against production first is a weaker refusal.
      assert.doesNotMatch(refused.output, /ECONNREFUSED|connect|getaddrinfo/i);
    }
  });

  it('still migrates a production database, because that is the one thing it is for', async () => {
    // `up` is not refused in production — only `seed` and `reset` are. Checked so that a future
    // tightening cannot quietly make deployments impossible: this fails with the production
    // refusal message rather than with a connection error if `up` is ever added to the list.
    const attempt = await runMigrate(['up'], { url: DEAD_URL, env: { NODE_ENV: 'production' } });
    assert.equal(attempt.code, 1, attempt.output);
    assert.doesNotMatch(attempt.output, /will not run with NODE_ENV=production/);
    assert.match(attempt.output, /ECONNREFUSED/);
  });

  it('names the variable it wanted when there is no connection string at all', async () => {
    const refused = await runMigrate(['up']);
    assert.equal(refused.code, 1, refused.output);
    // Matched on the variable name and the consequence rather than on the whole sentence: the
    // wording gained a second variable while this file was being written, and a test that pins
    // prose is a test that fails on an improvement to it.
    assert.match(refused.output, /DATABASE_URL/);
    assert.match(refused.output, /nothing to migrate/);
    assert.match(refused.output, /db:\*/, 'it names where the variable is normally read from');
  });

  it('rejects an unknown command and an unknown option', async () => {
    const command = await runMigrate(['rollbcak'], { url: DEAD_URL });
    assert.equal(command.code, 1, command.output);
    assert.match(command.output, /Unknown command "rollbcak"/);

    const option = await runMigrate(['up', '--yolo'], { url: DEAD_URL });
    assert.equal(option.code, 1, option.output);
    assert.match(option.output, /Unknown option "--yolo"/);

    const extra = await runMigrate(['up', 'status'], { url: DEAD_URL });
    assert.equal(extra.code, 1, extra.output);
    assert.match(extra.output, /One command at a time/);
  });

  it('rejects a lock wait that is not a number', async () => {
    const refused = await runMigrate(['up'], {
      url: DEAD_URL,
      env: { PRL_MIGRATE_LOCK_WAIT_MS: 'soon' },
    });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /PRL_MIGRATE_LOCK_WAIT_MS must be a non-negative number/);
  });

  it('prints usage, naming every documented command', async () => {
    const help = await runMigrate(['--help']);
    assert.equal(help.code, 0, help.output);
    for (const command of ['up', 'status', 'seed', 'reset']) {
      assert.match(help.output, new RegExp(`^\\s+${command}\\b`, 'm'), `--help does not mention ${command}`);
    }
    // Deliberately no assertion that nothing else is listed: a rollback verb is under
    // consideration, and a guard that failed when it arrived would be a guard against the fix.
    const bare = await runMigrate([]);
    assert.equal(bare.code, 0, 'no command at all is a usage message, not a failure');
    assert.match(bare.output, /Poker Risk Lab database migrations/);
  });

  it('never prints the connection string or the password, on any path that fails', async () => {
    const attempts = [
      await runMigrate(['up'], { url: DEAD_URL }),
      await runMigrate(['status'], { url: DEAD_URL }),
      await runMigrate(['seed'], { url: DEAD_URL, env: { NODE_ENV: 'production' } }),
      // The debug dump prints a stack and the driver's own diagnostic fields, and driver errors
      // carry the failing statement and its bind parameters. It is the one place "nothing secret
      // is ever printed" could stop being true, so it is exercised rather than assumed.
      await runMigrate(['up'], { url: DEAD_URL, env: { PRL_DEBUG: '1' } }),
    ];
    for (const attempt of attempts) {
      assert.doesNotMatch(attempt.output, /sup3rsecretpassw0rd/, 'a password reached the output');
      assert.doesNotMatch(attempt.output, /postgresql:\/\/someone/, 'a connection string reached the output');
    }
  });
});

/**
 * What is not covered here, stated rather than left as a gap:
 *
 *   - **A rollback verb.** None exists today. When one lands it needs: that it refuses in
 *     production like `seed` and `reset` do; that it takes the same advisory lock; that it removes
 *     the ledger row in the same transaction as the DDL it undoes, so a half-rolled-back migration
 *     is impossible; and that rolling back the last migration and applying it again leaves a schema
 *     identical to one built straight through — which is the only assertion that actually proves a
 *     down migration is the inverse of its up.
 *   - **A migration that fails halfway.** `applyFile` wraps each file in one transaction, so a
 *     failing statement should leave neither the DDL nor the ledger row. Testing it needs a
 *     deliberately broken .sql file in `db/migrations`, which is shared with every other engineer
 *     in this tree; the runner would have to take a directory argument for this to be testable
 *     without touching it.
 *   - **The lock-wait timeout expiring.** Reachable only by holding the advisory lock from another
 *     session for longer than `PRL_MIGRATE_LOCK_WAIT_MS`, which is a timing test; the lock's
 *     correctness is covered above by racing two runners, which is the case it exists for.
 */
