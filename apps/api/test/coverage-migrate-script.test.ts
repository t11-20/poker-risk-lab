/**
 * Drives `apps/api/scripts/migrate.mjs` as a CLI (it exports nothing, and importing it runs `main()`).
 * Each case works in a throwaway database it may destroy, which needs a role with CREATEDB.
 * `--help` is not asserted to list only four verbs, so a future rollback verb does not fail this file.
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

/** Copied from `migrate.mjs` on purpose, so a disagreement between the two is caught. */
function checksumOf(contents: string): string {
  const normalised = contents.replace(/^/, '').replace(/\r\n/g, '\n');
  return `sha256:${createHash('sha256').update(normalised, 'utf8').digest('hex')}`;
}

const MIGRATION_FILES = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith('.sql') && !name.startsWith('.'))
  .sort()
  .map((name) => ({ version: name, checksum: checksumOf(readFileSync(join(MIGRATIONS_DIR, name), 'utf8')) }));

const databaseUrl = adminDatabaseUrl();
let maintenance: Sql | null = null;
let skipReason: string | false = databaseSkip('the migration runner');

/** `CREATE DATABASE` cannot run inside the database it creates, so it is issued from `postgres`. */
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

interface Throwaway {
  readonly name: string;
  readonly url: string;
  readonly sql: Sql;
}

/** `CREATE DATABASE` takes no bind parameter, so the name is pattern-checked and identifier-quoted. */
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
  // `with (force)` so a leaked connection cannot leave the database behind.
  await handle`drop database if exists ${handle(throwaway.name)} with (force)`;
}

async function withThrowaway(use: (throwaway: Throwaway) => Promise<void>): Promise<void> {
  const throwaway = await createThrowaway();
  try {
    await use(throwaway);
  } finally {
    await dropThrowaway(throwaway);
  }
}

interface RunResult {
  readonly code: number;
  readonly output: string;
}

/**
 * `DATABASE_URL` is never inherited, so a case without one really has none. `DATABASE_MIGRATION_URL`
 * is always removed because the runner prefers it, and a developer's `.env` could aim `reset` at a real
 * database.
 */
async function runMigrate(
  args: readonly string[],
  options: { readonly url?: string | undefined; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<RunResult> {
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && entry[0] !== 'DATABASE_URL' && entry[0] !== 'DATABASE_MIGRATION_URL',
      ),
    ),
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
      const times = ledger.map((row) => row.applied_at.getTime());
      for (let index = 1; index < times.length; index += 1) {
        const previous = times[index - 1];
        const current = times[index];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(current >= previous, `${ledger[index]?.version} was applied before its predecessor`);
      }

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
      // Two deploys at once. The advisory lock makes the second wait and find nothing to do.
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

describe('migrate.mjs — the ledger is what makes a schema reproducible', dbOptions, () => {
  it('refuses to run when an applied migration no longer matches its file', async () => {
    await withThrowaway(async (throwaway) => {
      assert.equal((await runMigrate(['up'], { url: throwaway.url })).code, 0);
      const target = MIGRATION_FILES[0];
      assert.ok(target !== undefined);

      // Tamper with the ledger, not the shared file. The runner compares the two either way.
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

      const status = await runMigrate(['status'], { url: throwaway.url });
      assert.equal(status.code, 0, status.output);
      assert.match(status.output, /CHANGED/);
      assert.match(status.output, /`up` will refuse/);

      // Restoring the checksum attributes the refusal to it alone.
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

      // Out of order, as two merged branches produce. Applying would diverge from an in-order build.
      await throwaway.sql`delete from prl.schema_migrations where version = ${last.version}`;
      const outOfOrder = await runMigrate(['up', '--allow-missing'], { url: throwaway.url });
      assert.equal(outOfOrder.code, 1, outOfOrder.output);
      assert.match(outOfOrder.output, /Out-of-order migration/);
      assert.match(outOfOrder.output, new RegExp(last.version.replace(/\./g, '\\.')));
      assert.match(outOfOrder.output, /9999_from_another_branch\.sql/);
    });
  });
});

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

      const ledger = await ledgerOf(throwaway);
      assert.equal(ledger.length, MIGRATION_FILES.length);
    });
  });

  it('reset drops the schema and applies every migration again', async () => {
    await withThrowaway(async (throwaway) => {
      assert.equal((await runMigrate(['up'], { url: throwaway.url })).code, 0);
      assert.equal((await runMigrate(['seed'], { url: throwaway.url })).code, 0);

      // `NODE_ENV` describes the process, not the target. Deciding from it alone let a recalled
      // `db:reset` empty a 944,297-row database, so reset must name the database it drops.
      const unconfirmed = await runMigrate(['reset'], { url: throwaway.url });
      assert.equal(unconfirmed.code, 1, 'reset without --confirm-database must refuse');
      assert.match(unconfirmed.output, /--confirm-database/);

      const wrongName = await runMigrate(['reset', '--confirm-database', 'poker_risk_lab'], {
        url: throwaway.url,
      });
      assert.equal(wrongName.code, 1, 'a name that is not the target must refuse');

      const reset = await runMigrate(['reset', '--confirm-database', throwaway.name], {
        url: throwaway.url,
      });
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

describe('migrate.mjs — what it refuses to do', () => {
  const DEAD_URL = 'postgresql://someone:sup3rsecretpassw0rd@127.0.0.1:1/nothing';

  it('will not seed or reset a production database, and does not connect to find out', async () => {
    for (const command of ['seed', 'reset']) {
      const refused = await runMigrate([command], {
        url: DEAD_URL,
        env: { NODE_ENV: 'production' },
      });
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, new RegExp(`\`${command}\` will not run with NODE_ENV=production`));
      // The refusal must come before any connection to production.
      assert.doesNotMatch(refused.output, /ECONNREFUSED|connect|getaddrinfo/i);
    }
  });

  it('still migrates a production database, because that is the one thing it is for', async () => {
    // A future tightening must not refuse `up` in production and so block deployments.
    const attempt = await runMigrate(['up'], { url: DEAD_URL, env: { NODE_ENV: 'production' } });
    assert.equal(attempt.code, 1, attempt.output);
    assert.doesNotMatch(attempt.output, /will not run with NODE_ENV=production/);
    assert.match(attempt.output, /ECONNREFUSED/);
  });

  it('names the variable it wanted when there is no connection string at all', async () => {
    const refused = await runMigrate(['up']);
    assert.equal(refused.code, 1, refused.output);
    // Matches fragments, not the sentence, so a wording improvement does not fail it.
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
    const bare = await runMigrate([]);
    assert.equal(bare.code, 0, 'no command at all is a usage message, not a failure');
    assert.match(bare.output, /Poker Risk Lab database migrations/);
  });

  it('never prints the connection string or the password, on any path that fails', async () => {
    const attempts = [
      await runMigrate(['up'], { url: DEAD_URL }),
      await runMigrate(['status'], { url: DEAD_URL }),
      await runMigrate(['seed'], { url: DEAD_URL, env: { NODE_ENV: 'production' } }),
      // The debug dump prints driver diagnostics and bind parameters, the likeliest leak path.
      await runMigrate(['up'], { url: DEAD_URL, env: { PRL_DEBUG: '1' } }),
    ];
    for (const attempt of attempts) {
      assert.doesNotMatch(attempt.output, /sup3rsecretpassw0rd/, 'a password reached the output');
      assert.doesNotMatch(attempt.output, /postgresql:\/\/someone/, 'a connection string reached the output');
    }
  });
});

// Not covered. A rollback verb (none exists). A migration failing halfway, which needs a broken file in
// the shared `db/migrations`. The lock-wait timeout expiring, which is a timing test.
