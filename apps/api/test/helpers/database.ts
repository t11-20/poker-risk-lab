/**
 * Decides whether the database suites run. A test that cannot run for lack of infrastructure must
 * fail loudly or be excluded by a named script, never pass silently (57 tests once skipped and the
 * run exited 0). With no database and no waiver, `database-availability.test.ts` fails.
 * `test:without-database` sets the waiver through `test/without-database.env`, and CI ignores it.
 */

import { loadConfig } from '../../src/config.ts';
import { createDatabaseClient, type Sql } from '../../src/db.ts';
import { readLedger, readShippedMigrations, verifySchema } from '../../src/schema-guard.ts';

/** Blank counts as absent. */
export const TEST_DATABASE_URL = ((): string | undefined => {
  const raw = process.env['DATABASE_URL'];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
})();

/**
 * The DSN for teardown statements the runtime role must never issue, read lazily. `prl_app` cannot
 * retract rooms or hands, and teardown through the application connection forced CI onto a
 * superuser (OPS-008). Falls back to `DATABASE_URL`.
 */
export function adminDatabaseUrl(): string | undefined {
  const raw = process.env['DATABASE_URL_ADMIN'];
  if (raw !== undefined && raw.trim() !== '') return raw;
  return TEST_DATABASE_URL;
}

/** Set from a checked-in env file so it works under whatever shell pnpm spawns. */
export const DATABASE_TESTS_WAIVED = process.env['PRL_TESTS_WITHOUT_DATABASE'] === '1';

/** `CI=false` and `CI=0` mean "not CI". */
export const RUNNING_IN_CI = ((): boolean => {
  const raw = process.env['CI'];
  return raw !== undefined && raw !== '' && raw !== 'false' && raw !== '0';
})();

export const DATABASE_REQUIRED = RUNNING_IN_CI || !DATABASE_TESTS_WAIVED;

export function databaseSkip(what: string): string | false {
  if (TEST_DATABASE_URL !== undefined) return false;
  return `DATABASE_URL is not set, so ${what} cannot be exercised against a real schema`;
}

/** Names only the two honest options, get a database or say out loud that SQL is not tested. */
export const DATABASE_FIX_HINT =
  'run `pnpm run db:setup` (docker compose + migrate + seed), or, if you genuinely have no ' +
  'Docker, run `pnpm run test:no-database` — which prints a banner saying the run proves ' +
  'nothing about SQL and is refused in CI.';

/**
 * A pool of two, closed by its caller. Not `configureDatabase`, which installs the process-wide
 * client and refuses a second call.
 */
export function testClientFor(url: string): Sql {
  return createDatabaseClient(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
      DATABASE_POOL_MAX: '2',
    }),
  );
}

/**
 * Teardown only, never a statement under test. Application paths must keep using the
 * application's connection so a missing GRANT still fails the suite.
 */
export async function withAdminSql<T>(use: (sql: Sql) => Promise<T>): Promise<T> {
  const url = adminDatabaseUrl();
  if (url === undefined) {
    throw new Error(
      'no DSN for the schema-owning identity: set DATABASE_URL_ADMIN (or DATABASE_URL, which it ' +
        'falls back to). Fixture teardown removes rows from the append-only tables, which the ' +
        'runtime role prl_app cannot and must not be able to do.',
    );
  }
  const client = testClientFor(url);
  try {
    return await use(client);
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

export interface SchemaProbe {
  readonly ok: boolean;
  /** What to do about it, when not ok. */
  readonly problem?: string;
}

/**
 * Connects and reads, so availability is a fact rather than an environment variable. Then runs the
 * boot-time schema check (`src/schema-guard.ts`), so a database a migration behind fails here and
 * names the pending migration.
 */
export async function probeSchema(): Promise<SchemaProbe> {
  if (TEST_DATABASE_URL === undefined) {
    return { ok: false, problem: `DATABASE_URL is not set. ${DATABASE_FIX_HINT}` };
  }
  const client = testClientFor(TEST_DATABASE_URL);
  try {
    await client`select 1 from prl.users limit 1`;
    const verdict = await verifySchema(
      async () => (await readLedger(client)).rows,
      () => readShippedMigrations(),
    );
    if (verdict.kind === 'refused') {
      return { ok: false, problem: `${verdict.problems.join('; ')}. ${verdict.fix}` };
    }
    if (verdict.kind === 'unverified') {
      return { ok: false, problem: `DATABASE_URL answered, but ${verdict.reason}. ${DATABASE_FIX_HINT}` };
    }
    return { ok: true };
  } catch (error) {
    const name = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      ok: false,
      problem: `DATABASE_URL is set but the prl schema is not reachable (${name}). ${DATABASE_FIX_HINT}`,
    };
  } finally {
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}
