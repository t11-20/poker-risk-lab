/**
 * The schema guard against a ledger the real migration runner wrote, and through the real boot path.
 *
 * ## Why this needs its own database
 *
 * The incident: two PRs in one day added a migration the development database did not have, the
 * API booted green against it, and the first sign was `column "automatic_reason" does not exist`
 * from an archive write. Proving the guard catches that means making a database behind, ahead and
 * drifted on purpose — deleting, adding and corrupting ledger rows — and none of that may happen
 * in the suite's own database or anybody's development one. So this file creates
 * `prl_schema_guard_scratch` on the same cluster, migrates it from EMPTY with `migrate.mjs up`, and
 * drops it at the end however the run ended.
 *
 * From empty matters, and is the negative control for 0010's own header: on a fresh database the
 * ledger belongs to the connecting identity while the files run, and only afterwards to
 * prl_migrator. A grant made the wrong way round passes against a copy of a long-lived database
 * and fails here.
 *
 * ## What it proves that `schema-guard.test.ts` cannot
 *
 *   * The checksum this build computes is the one `migrate.mjs` records — every row matches.
 *   * The runtime role can read the ledger: every read below is made as `prl_app`, through the
 *     `options=-c role=prl_app` startup parameter `coverage-verify-schema.test.ts` explains.
 *   * `src/server.ts` actually consults the guard: a spawned server exits 78 against a ledger one
 *     file behind, serves against a current one, and against a database that does not answer
 *     comes up degraded instead of exiting. A rule the boot path never reaches is no rule.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Sql } from '../src/db.ts';
import {
  createSchemaGate,
  LEDGER_GRANT_MIGRATION,
  type MigrationRecord,
  readLedger,
  readShippedMigrations,
  type SchemaVerdict,
  verifySchema,
} from '../src/schema-guard.ts';
import { adminDatabaseUrl, databaseSkip, testClientFor } from './helpers/database.ts';

const execFileAsync = promisify(execFile);

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..', '..');
const MIGRATE = join(API_DIR, 'scripts', 'migrate.mjs');
const SERVER = join(API_DIR, 'src', 'server.ts');
const SCRATCH = 'prl_schema_guard_scratch';
const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

const dbOptions = { skip: databaseSkip('the schema guard against a real migration ledger') };

const SHIPPED = readShippedMigrations();
const NEWEST = SHIPPED.at(-1) as MigrationRecord;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** The same DSN, connected as the runtime role. See the header. */
function asRuntimeRole(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', '-c role=prl_app');
  return parsed.toString();
}

/**
 * The environment a child gets: this process's, minus every connection string.
 *
 * `migrate.mjs` reads DATABASE_MIGRATION_URL in preference to DATABASE_URL, and the test command
 * loads the repository's `.env`, so inheriting it would send `up` to whatever database it names
 * instead of the scratch one. Dropped always, and DATABASE_URL re-added explicitly by the caller.
 */
function childEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const dropped = new Set(['DATABASE_URL', 'DATABASE_MIGRATION_URL', 'DATABASE_URL_ADMIN']);
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined && !dropped.has(entry[0]),
      ),
    ),
    NO_COLOR: '1',
    ...extra,
  };
}

let maintenance: Sql | null = null;
let admin: Sql | null = null;
let runtime: Sql | null = null;
let scratchUrl = '';

function adminSql(): Sql {
  assert.ok(admin !== null, 'the scratch database was not created');
  return admin;
}

function runtimeSql(): Sql {
  assert.ok(runtime !== null, 'the scratch database was not created');
  return runtime;
}

const verifyAsRuntime = (): Promise<SchemaVerdict> =>
  verifySchema(
    () => readLedger(runtimeSql()),
    () => SHIPPED,
  );

before(async () => {
  if (dbOptions.skip !== false) {
    console.info(`[schema-guard-database.test.ts] skipping: ${dbOptions.skip}`);
    return;
  }
  const url = adminDatabaseUrl();
  assert.ok(url !== undefined);
  // Not a skip when this fails. DATABASE_URL is set, so the database is required, and a cluster
  // that will not let this file make a scratch database is a failure with the reason attached.
  maintenance = testClientFor(withDatabase(url, 'postgres'));
  // A run killed half-way leaves the scratch database behind; `with (force)` and `if exists` mean
  // the next run starts clean rather than tripping over it.
  await maintenance`drop database if exists ${maintenance(SCRATCH)} with (force)`;
  await maintenance`create database ${maintenance(SCRATCH)}`;
  scratchUrl = withDatabase(url, SCRATCH);

  const migrated = await execFileAsync(process.execPath, [MIGRATE, 'up'], {
    cwd: REPO_ROOT,
    env: childEnv({ DATABASE_URL: scratchUrl }),
  }).catch((error: { stdout?: string; stderr?: string }) => {
    assert.fail(`migrate.mjs up failed on the scratch database:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  });
  // From empty: every shipped file, including 0010, ran against this database just now.
  assert.match(migrated.stdout, new RegExp(`Applying ${SHIPPED.length} migration`));

  admin = testClientFor(scratchUrl);
  runtime = testClientFor(asRuntimeRole(scratchUrl));
});

after(async () => {
  await runtime?.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  if (maintenance !== null) {
    await maintenance`drop database if exists ${maintenance(SCRATCH)} with (force)`;
    await maintenance.end({ timeout: 5 });
  }
});

/** Runs `change`, then `use`, then `revert`, so one case cannot leave the ledger broken for the next. */
async function withLedger(change: string, use: () => Promise<void>): Promise<void> {
  const sql = adminSql();
  const saved = await sql<{ version: string; checksum: string; applied_at: Date }[]>`
    select version, checksum, applied_at from prl.schema_migrations
  `;
  const [acl] = await sql<{ readable: boolean }[]>`
    select has_table_privilege('prl_app', 'prl.schema_migrations', 'SELECT') as readable
  `;
  try {
    if (change === 'drop-newest') {
      await sql`delete from prl.schema_migrations where version = ${NEWEST.version}`;
    } else if (change === 'edit-first') {
      await sql`update prl.schema_migrations set checksum = 'sha256:edited' where version = '0001_initial.sql'`;
    } else if (change === 'newer-build') {
      await sql`
        insert into prl.schema_migrations (version, checksum) values ('9999_from_a_newer_build.sql', 'sha256:x')
      `;
    } else if (change === 'revoke-read') {
      await sql`revoke select on prl.schema_migrations from prl_app`;
    } else {
      assert.fail(`unknown ledger change ${change}`);
    }
    await use();
  } finally {
    // The grant goes back to what it WAS, not to what 0010 makes it. An unconditional re-grant here
    // once made every later case pass against a database that had never applied 0010 — found by
    // removing 0010 and watching the boot case still serve.
    if (acl?.readable === true) await sql`grant select on prl.schema_migrations to prl_app`;
    else await sql`revoke select on prl.schema_migrations from prl_app`;
    await sql`delete from prl.schema_migrations`;
    for (const row of saved) {
      await sql`
        insert into prl.schema_migrations (version, checksum, applied_at)
        values (${row.version}, ${row.checksum}, ${row.applied_at})
      `;
    }
  }
}

describe('schema guard — a ledger the real runner wrote, read as prl_app', dbOptions, () => {
  it('finds a freshly migrated database current, matching every checksum migrate.mjs recorded', async () => {
    assert.deepEqual(await verifyAsRuntime(), { kind: 'current', applied: SHIPPED.length, ahead: [] });
    // The grant 0010 made survived the ledger being handed to prl_migrator after the files ran.
    const [state] = await adminSql()<{ owner: string; readable: boolean; writable: boolean }[]>`
      select pg_catalog.pg_get_userbyid(c.relowner) as owner,
             has_table_privilege('prl_app', 'prl.schema_migrations', 'SELECT') as readable,
             has_table_privilege('prl_app', 'prl.schema_migrations', 'INSERT') as writable
      from pg_catalog.pg_class c where c.oid = 'prl.schema_migrations'::regclass
    `;
    assert.deepEqual(state, { owner: 'prl_migrator', readable: true, writable: false });
  });

  it('refuses a ledger one migration behind, naming the file and the command', async () => {
    await withLedger('drop-newest', async () => {
      const verdict = await verifyAsRuntime();
      assert.equal(verdict.kind, 'refused');
      assert.match(JSON.stringify(verdict), new RegExp(NEWEST.version.replace('.', '\\.')));
      assert.match(JSON.stringify(verdict), /pnpm run db:migrate/);
    });
  });

  it('refuses an applied migration whose recorded checksum is not the file', async () => {
    await withLedger('edit-first', async () => {
      const verdict = await verifyAsRuntime();
      assert.equal(verdict.kind, 'refused');
      assert.match(JSON.stringify(verdict), /0001_initial\.sql: the ledger recorded edited/);
    });
  });

  it('serves a ledger ahead of this build, and names what it does not know', async () => {
    await withLedger('newer-build', async () => {
      assert.deepEqual(await verifyAsRuntime(), {
        kind: 'current',
        applied: SHIPPED.length,
        ahead: ['9999_from_a_newer_build.sql'],
      });
    });
  });

  it('refuses when the runtime role cannot read the ledger, naming the migration that grants it', async () => {
    // The state of every database that has not applied 0010 — and the negative control for it:
    // without the grant, the guard cannot run as the API at all.
    await withLedger('revoke-read', async () => {
      const verdict = await verifyAsRuntime();
      assert.equal(verdict.kind, 'refused');
      assert.ok(JSON.stringify(verdict).includes(LEDGER_GRANT_MIGRATION));
    });
  });

  it('keeps readiness degraded while behind and ready once migrated, without a restart', async () => {
    const gate = createSchemaGate({
      readLedger: () => readLedger(runtimeSql()),
      shipped: () => SHIPPED,
      probeDeadlineMs: 2_000,
    });
    await withLedger('drop-newest', async () => {
      const degraded = await gate.readiness({ ok: true });
      assert.equal(degraded.ok, false);
      assert.ok((degraded.detail ?? '').includes(NEWEST.version), degraded.detail);
    });
    // `withLedger` put the row back: somebody ran `migrate up` while the instance was degraded.
    assert.deepEqual(await gate.readiness({ ok: true }), { ok: true });
  });
});

// ---------------------------------------------------------------------------
// The boot path
// ---------------------------------------------------------------------------

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0));
    });
  });
}

interface Booted {
  readonly child: ChildProcess;
  readonly port: number;
  output: () => string;
  exited: Promise<number | null>;
}

function boot(databaseUrl: string, port: number): Booted {
  // `development`, because `logging.ts` silences the logger under `test` and the log lines are
  // half of what is asserted. Values here beat `.env`, which is not loaded at all.
  const child = spawn(process.execPath, [SERVER], {
    cwd: REPO_ROOT,
    env: childEnv({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: TEST_SECRET,
      DATABASE_URL: databaseUrl,
      DATABASE_CONNECT_TIMEOUT_SECONDS: '2',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  spawned.add(child);
  return { child, port, output: () => text, exited };
}

/**
 * Every server this file started, killed in `after` as well as in each case's `finally`.
 *
 * A case that hits the runner's timeout is cancelled without running its `finally`. Measured with
 * `src/server.ts` reverted to before the guard: the "exits 78" case waited out the timeout, its
 * server — which had booted, being unguarded — kept the test process alive holding a port and a
 * pool, and the run never finished until it was killed by hand.
 */
const spawned = new Set<ChildProcess>();

after(() => {
  for (const child of spawned) if (child.exitCode === null) child.kill('SIGKILL');
});

/** The exit code, or `undefined` if the child is still running after `timeoutMs`. */
async function exitWithin(booted: Booted, timeoutMs: number): Promise<number | null | undefined> {
  let timer: NodeJS.Timeout | null = null;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([booted.exited, late]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Resolves when the output matches, or rejects with the output when the child exits first. */
async function waitFor(booted: Booted, pattern: RegExp, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let gone = false;
  void booted.exited.then(() => {
    gone = true;
  });
  while (!pattern.test(booted.output())) {
    if (gone) assert.fail(`the server exited before printing ${pattern}:\n${booted.output()}`);
    if (Date.now() > deadline) assert.fail(`no ${pattern} within ${timeoutMs} ms:\n${booted.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stop(booted: Booted): Promise<void> {
  if (booted.child.exitCode !== null) return;
  booted.child.kill('SIGKILL');
  await booted.exited;
}

describe('schema guard — src/server.ts consults it at boot', dbOptions, () => {
  it('exits 78 against a ledger one migration behind, before it listens', async () => {
    await withLedger('drop-newest', async () => {
      const booted = boot(asRuntimeRole(scratchUrl), await freePort());
      try {
        // Bounded, so the unguarded server — which boots and listens — fails this as an
        // assertion rather than as a runner timeout.
        const code = await exitWithin(booted, 20_000);
        assert.equal(
          code,
          78,
          `expected exit 78, the server ${code === undefined ? 'is still running' : `exited ${code}`}:\n${booted.output()}`,
        );
        assert.match(booted.output(), /Refusing to start: the database schema does not match this build/);
        assert.ok(booted.output().includes(NEWEST.version), booted.output());
        assert.match(booted.output(), /pnpm run db:migrate/);
        assert.doesNotMatch(booted.output(), /"msg":"listening"/);
      } finally {
        await stop(booted);
      }
    });
  });

  it('serves a current database, and says it compared every file', async () => {
    const booted = boot(asRuntimeRole(scratchUrl), await freePort());
    try {
      await waitFor(booted, /"msg":"listening"/);
      assert.match(
        booted.output(),
        new RegExp(`"applied":${SHIPPED.length},"msg":"database schema matches this build"`),
      );
      const ready = await fetch(`http://127.0.0.1:${booted.port}/api/v1/ready`);
      assert.equal(ready.status, 200, await ready.text());
    } finally {
      await stop(booted);
    }
  });

  it('comes up degraded, not refused, when the database does not answer at all', async () => {
    // Port 1: nothing can bind it without root, so the connection is refused at once.
    const booted = boot('postgresql://nobody:nothing@127.0.0.1:1/absent', await freePort());
    try {
      await waitFor(booted, /"msg":"listening"/);
      assert.match(booted.output(), /database schema not verified at boot/);
      const health = await fetch(`http://127.0.0.1:${booted.port}/api/v1/health`);
      assert.equal(health.status, 200);
      const ready = await fetch(`http://127.0.0.1:${booted.port}/api/v1/ready`);
      assert.equal(ready.status, 503);
    } finally {
      await stop(booted);
    }
  });
});
