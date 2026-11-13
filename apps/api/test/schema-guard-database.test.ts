/**
 * The schema guard against a ledger the real `migrate.mjs up` wrote, and through the real boot path.
 * It corrupts ledger rows on purpose, so it uses its own scratch databases and drops them at the end.
 * Migrating from empty is the negative control for 0010: on a fresh database the ledger changes owner
 * after the files run, so a grant made in the wrong order fails here. Reads run as `prl_app`, and a
 * spawned server must exit 78 when behind, serve when current, and come up degraded when unreachable.
 */

import assert from 'node:assert/strict';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, getSql, ping, type Sql } from '../src/db.ts';
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
const SERVED = 'prl_schema_guard_served';
const OLDER = 'prl_schema_guard_older';
const REPLACED = 'prl_schema_guard_replaced';
const TEST_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

const dbOptions = { skip: databaseSkip('the schema guard against a real migration ledger') };

const SHIPPED = readShippedMigrations();
const NEWEST = SHIPPED.at(-1) as MigrationRecord;

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function asRuntimeRole(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('options', '-c role=prl_app');
  return parsed.toString();
}

/**
 * This process's environment minus every connection string. `migrate.mjs` prefers
 * DATABASE_MIGRATION_URL, so an inherited `.env` value would migrate that database, not the scratch one.
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
    async () => (await readLedger(runtimeSql())).rows,
    () => SHIPPED,
  );

before(async () => {
  if (dbOptions.skip !== false) {
    console.info(`[schema-guard-database.test.ts] skipping: ${dbOptions.skip}`);
    return;
  }
  const url = adminDatabaseUrl();
  assert.ok(url !== undefined);
  // Not a skip on failure: DATABASE_URL is set, so a cluster that refuses a scratch database fails.
  maintenance = testClientFor(withDatabase(url, 'postgres'));
  await maintenance`drop database if exists ${maintenance(SCRATCH)} with (force)`;
  await maintenance`create database ${maintenance(SCRATCH)}`;
  scratchUrl = withDatabase(url, SCRATCH);

  const migrated = await execFileAsync(process.execPath, [MIGRATE, 'up'], {
    cwd: REPO_ROOT,
    env: childEnv({ DATABASE_URL: scratchUrl }),
  }).catch((error: { stdout?: string; stderr?: string }) => {
    assert.fail(`migrate.mjs up failed on the scratch database:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  });
  assert.match(migrated.stdout, new RegExp(`Applying ${SHIPPED.length} migration`));

  // Copies for the swap case, made now because `template` refuses a source with a session open.
  // OLDER is one migration behind.
  for (const copy of [SERVED, OLDER, REPLACED]) {
    await maintenance`drop database if exists ${maintenance(copy)} with (force)`;
  }
  await maintenance`create database ${maintenance(SERVED)} template ${maintenance(SCRATCH)}`;
  await maintenance`create database ${maintenance(OLDER)} template ${maintenance(SCRATCH)}`;
  const older = testClientFor(withDatabase(url, OLDER));
  try {
    await older`delete from prl.schema_migrations where version = ${NEWEST.version}`;
  } finally {
    await older.end({ timeout: 5 });
  }

  admin = testClientFor(scratchUrl);
  runtime = testClientFor(asRuntimeRole(scratchUrl));
});

after(async () => {
  await runtime?.end({ timeout: 5 }).catch(() => undefined);
  await admin?.end({ timeout: 5 }).catch(() => undefined);
  if (maintenance !== null) {
    for (const name of [SCRATCH, SERVED, OLDER, REPLACED]) {
      await maintenance`drop database if exists ${maintenance(name)} with (force)`;
    }
    await maintenance.end({ timeout: 5 });
  }
});

/** Applies `change`, runs `use`, then restores the ledger and its grant for the next case. */
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
    // Restore the grant as it WAS. An unconditional re-grant let later cases pass without 0010.
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
    // 0010's grant survives the ledger being handed to prl_migrator after the files ran.
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
    // The state of a database without 0010, and the negative control for its grant.
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
    // A "current" verdict holds only for the database identity whose ledger gave it.
    const probe = { ok: true, identity: (await readLedger(runtimeSql())).identity };
    await withLedger('drop-newest', async () => {
      const degraded = await gate.readiness(probe);
      assert.equal(degraded.ok, false);
      assert.ok((degraded.detail ?? '').includes(NEWEST.version), degraded.detail);
    });
    // `withLedger` put the row back, as `migrate up` would while degraded.
    assert.deepEqual(await gate.readiness(probe), probe);
  });
});

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
  // `development`, because `logging.ts` silences the logger under `test` and the log lines are asserted.
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
 * Every server this file started, also killed in `after`. A case cancelled by the runner's timeout
 * skips its `finally`, and against an unguarded server that left the run hanging on a live child.
 */
const spawned = new Set<ChildProcess>();

after(() => {
  for (const child of spawned) if (child.exitCode === null) child.kill('SIGKILL');
});

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
        // Bounded, so an unguarded server that listens fails as an assertion, not a runner timeout.
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

/**
 * A TCP forwarder that can refuse or drop every connection, so one server sees its database go away,
 * return and be replaced behind ONE unchanging `DATABASE_URL`. A refusal looks to the driver like a
 * database that is down.
 */
interface Forwarder {
  readonly port: number;
  open: () => void;
  shut: () => void;
  end: () => Promise<void>;
}

async function forwarder(target: URL): Promise<Forwarder> {
  let open = false;
  const carried = new Set<Socket>();
  const server: Server = createServer((client) => {
    if (!open) {
      client.destroy();
      return;
    }
    const upstream = connect(Number(target.port || 5432), target.hostname);
    carried.add(client);
    carried.add(upstream);
    const drop = (): void => {
      client.destroy();
      upstream.destroy();
      carried.delete(client);
      carried.delete(upstream);
    };
    for (const socket of [client, upstream]) {
      socket.on('error', drop);
      socket.on('close', drop);
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const shut = (): void => {
    open = false;
    for (const socket of carried) socket.destroy();
    carried.clear();
  };
  return {
    port: address.port,
    open: () => {
      open = true;
    },
    shut,
    end: async () => {
      shut();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function throughForwarder(via: Forwarder, database: string): string {
  const parsed = new URL(asRuntimeRole(withDatabase(scratchUrl, database)));
  parsed.hostname = '127.0.0.1';
  parsed.port = String(via.port);
  return parsed.toString();
}

/** A feature route that reads no table, so its status is the gate's answer and nothing else's. */
const FEATURE = '/api/v1/content/glossary';

async function statusOf(booted: Booted, path: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${booted.port}${path}`);
  await response.arrayBuffer();
  return response.status;
}

async function untilStatus(booted: Booted, path: string, status: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await statusOf(booted, path);
    if (last === status) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail(
    `${path} answered ${last}, not ${status}, for ${timeoutMs} ms:\n${booted.output().slice(-3000)}`,
  );
}

async function upgradeStatus(booted: Booted): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${booted.port}/api/v1/ws`, {
      headers: { origin: 'http://localhost:3000' },
    });
    socket.once('unexpected-response', (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.once('upgrade', () => {
      resolve(101);
      socket.terminate();
    });
    socket.once('error', (error) => {
      if (!/Unexpected server response/.test(error.message)) reject(error);
    });
  });
}

async function emptied(names: readonly string[]): Promise<void> {
  const sql = maintenance;
  assert.ok(sql !== null);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await sql`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = any(${names as string[]}) and pid <> pg_backend_pid()
    `;
    const [left] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity where datname = any(${names as string[]})
    `;
    if (left?.n === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`sessions on ${names.join(', ')} would not end`);
}

describe('schema guard — the probe and the ledger name the same database', dbOptions, () => {
  it('returns one identity from ping() and from the ledger read, or every probe would look like a swap', async () => {
    configureDatabase(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: asRuntimeRole(scratchUrl),
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
        SESSION_COOKIE_SECRET: TEST_SECRET,
        DATABASE_POOL_MAX: '3',
      }),
    );
    try {
      const probe = await ping();
      assert.equal(probe.ok, true, probe.detail);
      const reading = await readLedger(getSql());
      assert.ok(probe.identity !== undefined && probe.identity.length > 0);
      assert.equal(probe.identity, reading.identity);
      assert.equal(reading.rows.length, SHIPPED.length);
    } finally {
      await closeDatabase(1_000);
    }
  });
});

describe(
  'schema guard — feature routes wait for a verdict, for the database in front of them',
  dbOptions,
  () => {
    it('boots degraded, refuses features while the returning database is behind, serves once migrated', async () => {
      // A degraded boot must not leave feature routes open to a database that returns behind.
      const via = await forwarder(new URL(scratchUrl));
      const booted = boot(throughForwarder(via, SCRATCH), await freePort());
      try {
        await waitFor(booted, /"msg":"listening"/);
        assert.match(booted.output(), /database schema not verified at boot/);

        const refused = await fetch(`http://127.0.0.1:${booted.port}${FEATURE}`);
        assert.equal(refused.status, 503, 'a feature route must not be served before any verdict');
        assert.equal(refused.headers.get('retry-after'), '5');
        const body = (await refused.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'service_unavailable');
        assert.equal(await statusOf(booted, '/api/v1/health'), 200);
        assert.equal(await statusOf(booted, '/api/v1/ready'), 503);
        assert.equal(await upgradeStatus(booted), 503, 'no socket may open onto an unverified schema');

        await withLedger('drop-newest', async () => {
          via.open();
          const deadline = Date.now() + 20_000;
          let detail = '';
          while (!detail.includes(NEWEST.version) && Date.now() < deadline) {
            const ready = await fetch(`http://127.0.0.1:${booted.port}/api/v1/ready`);
            assert.equal(ready.status, 503);
            detail = JSON.stringify(await ready.json());
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          assert.ok(detail.includes(NEWEST.version), `readiness never named the pending file: ${detail}`);
          assert.equal(await statusOf(booted, FEATURE), 503);
          assert.equal(await upgradeStatus(booted), 503);
        });

        // Nothing probes `/ready` from here, so recovery must come from the server's own re-check.
        await untilStatus(booted, FEATURE, 200);
        assert.equal(await statusOf(booted, '/api/v1/ready'), 200);
        assert.equal(await upgradeStatus(booted), 101, 'the upgrade completes once the schema is verified');
        assert.match(booted.output(), /database schema verified; serving/);
      } finally {
        await stop(booted);
        await via.end();
      }
    });

    it('re-verifies when an older database replaces the verified one behind the same DSN', async () => {
      // A verdict holds for one database. The verified one is renamed away and an older one takes its
      // name, so the DSN is byte-for-byte unchanged.
      const via = await forwarder(new URL(scratchUrl));
      via.open();
      const booted = boot(throughForwarder(via, SERVED), await freePort());
      try {
        await waitFor(booted, /"msg":"listening"/);
        assert.match(booted.output(), /database schema matches this build/);
        assert.equal(await statusOf(booted, FEATURE), 200);
        assert.equal(await statusOf(booted, '/api/v1/ready'), 200);

        via.shut();
        await emptied([SERVED, OLDER]);
        const sql = maintenance;
        assert.ok(sql !== null);
        await sql`alter database ${sql(SERVED)} rename to ${sql(REPLACED)}`;
        await sql`alter database ${sql(OLDER)} rename to ${sql(SERVED)}`;
        via.open();

        // Polled on the feature route alone: the server's own re-check has to find the swap.
        await untilStatus(booted, FEATURE, 503);
        assert.match(booted.output(), /a different database is answering DATABASE_URL/);
        const ready = await fetch(`http://127.0.0.1:${booted.port}/api/v1/ready`);
        assert.equal(ready.status, 503);
        assert.ok(JSON.stringify(await ready.json()).includes(NEWEST.version));

        // Migrated in place, it serves again without a restart.
        const swapped = testClientFor(withDatabase(scratchUrl, SERVED));
        try {
          await swapped`
          insert into prl.schema_migrations (version, checksum) values (${NEWEST.version}, ${NEWEST.checksum})
        `;
        } finally {
          await swapped.end({ timeout: 5 });
        }
        await untilStatus(booted, FEATURE, 200);
      } finally {
        await stop(booted);
        await via.end();
      }
    });
  },
);
