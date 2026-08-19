/**
 * The one place that decides whether the database-backed suites run, and what happens when they
 * cannot.
 *
 * ## Why this file exists
 *
 * Before it, four suites plus half of `repositories.test.ts` each decided for themselves, with
 * their own copy of `process.env['DATABASE_URL'] === undefined ? reason : false`. The documented
 * developer command (`pnpm run test`) passed no `--env-file`, so `DATABASE_URL` was unset, so all
 * of them skipped — and the run still exited 0 while reporting 357 green tests. Fifty-seven tests
 * did not run, six of them the ones that assert the release-blocking guardrail that one player
 * never receives another player's private cards. A suite that omits its own most important
 * assertions and exits 0 does not merely fail to help; it manufactures confidence.
 *
 * ## The policy, in one sentence
 *
 * A test that cannot run because infrastructure is missing must fail loudly, or be excluded by an
 * explicitly named script — it must never silently pass.
 *
 * So:
 *
 *   - `pnpm --filter @prl/api test` loads `../../.env` (the same file every `db:*` script reads),
 *     so a developer who has run `pnpm run db:setup` gets the database suites automatically.
 *   - With no reachable database and no waiver, `test/database-availability.test.ts` FAILS. The
 *     run exits non-zero and names the fix.
 *   - `pnpm --filter @prl/api test:without-database` sets `PRL_TESTS_WITHOUT_DATABASE=1` through
 *     `test/without-database.env`. That waives the failure, prints a banner saying the run proves
 *     nothing about SQL, and is the only supported way to get a green run without a database.
 *   - In CI the waiver is ignored: `CI` is set by every CI provider, and CI must never be allowed
 *     to skip these. A developer without Docker is a local inconvenience; a release pipeline
 *     without Postgres is a release with no evidence behind it.
 *
 * Not a `.test.ts` file, so the runner's glob does not pick it up.
 */

import { loadConfig } from '../../src/config.ts';
import { createDatabaseClient, type Sql } from '../../src/db.ts';

/** `DATABASE_URL`, or undefined when it is absent or blank. Blank is absent, not a URL. */
export const TEST_DATABASE_URL = ((): string | undefined => {
  const raw = process.env['DATABASE_URL'];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
})();

/**
 * The DSN a fixture teardown may use for the statements the RUNTIME role must never be able to
 * issue — read lazily, so a test can set it around a call.
 *
 * ## Why a second identity exists at all
 *
 * `db/migrations/0001_initial.sql` gives `prl_app` SELECT/INSERT/UPDATE on `prl.rooms`,
 * `prl.hands`, `prl.hand_seats` and INSERT-only on `prl.hand_actions`: the hand history is an
 * append-only ledger, and the application genuinely cannot retract a room or a hand. That is the
 * privilege model working, not a gap in it.
 *
 * A fixture, though, has to be able to put the database back. Doing that with the application's
 * own connection is what forced CI's `test` job to keep connecting as a superuser, so the whole
 * least-privilege model went unexercised by the one job that runs the SQL (audit finding OPS-008).
 * Splitting the identities is what lets the suite run its *application* statements as `prl_app`
 * while its *teardown* runs as the migrating identity that owns the schema — which is exactly the
 * split `.github/workflows/ci.yml` already makes for the `end-to-end` and `a11y` jobs.
 *
 * Unset, it falls back to `DATABASE_URL`, so a developer whose single DSN is privileged (the
 * default `docker compose` credentials are) sees no change at all.
 */
export function adminDatabaseUrl(): string | undefined {
  const raw = process.env['DATABASE_URL_ADMIN'];
  if (raw !== undefined && raw.trim() !== '') return raw;
  return TEST_DATABASE_URL;
}

/**
 * True when the caller ran the explicitly named `test:without-database` script.
 *
 * Set from a checked-in env file rather than an inline `FOO=1 node ...` assignment so the script
 * works the same whatever shell pnpm spawns.
 */
export const DATABASE_TESTS_WAIVED = process.env['PRL_TESTS_WITHOUT_DATABASE'] === '1';

/**
 * True on GitHub Actions and every other provider that sets `CI`.
 *
 * `CI=false` is treated as "not CI" because that is what a developer who exports it means.
 */
export const RUNNING_IN_CI = ((): boolean => {
  const raw = process.env['CI'];
  return raw !== undefined && raw !== '' && raw !== 'false' && raw !== '0';
})();

/** Whether a missing database is a hard failure for this run. */
export const DATABASE_REQUIRED = RUNNING_IN_CI || !DATABASE_TESTS_WAIVED;

/** Why the database suites are skipped, or `false` when they run. */
export function databaseSkip(what: string): string | false {
  if (TEST_DATABASE_URL !== undefined) return false;
  return `DATABASE_URL is not set, so ${what} cannot be exercised against a real schema`;
}

/**
 * How a run with no database should be fixed, as one sentence a reader can act on.
 *
 * Deliberately names the setup command and the waiver in the same breath: the two honest options
 * are "get a database" and "say out loud that you are not testing SQL", and nothing else.
 */
export const DATABASE_FIX_HINT =
  'run `pnpm run db:setup` (docker compose + migrate + seed), or, if you genuinely have no ' +
  'Docker, run `pnpm run test:no-database` — which prints a banner saying the run proves ' +
  'nothing about SQL and is refused in CI.';

/**
 * A pool of two, for one short job, closed by its caller.
 *
 * Deliberately not `configureDatabase`: that installs the process-wide client and refuses to be
 * called twice, and its callers run alongside a suite that has already installed one. Exported so
 * that a test connecting as a DIFFERENT identity — the least-privilege role, say — does not have
 * to keep its own copy of what the test configuration is.
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
 * Runs one job on the schema-owning identity, on a connection opened and closed around it.
 *
 * Only for teardown — never for a statement a test is asserting about. The point of the split is
 * that everything the *application* does keeps going through the application's own connection, so
 * a missing GRANT still fails the suite; borrowing this handle for an application path would put
 * the finding straight back.
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
  /** True when a `select` against `prl.users` succeeded. */
  readonly ok: boolean;
  /** Present when it did not: what to do about it. */
  readonly problem?: string;
}

/**
 * Connects and reads one row, so "the database is available" is a fact rather than the presence
 * of an environment variable.
 *
 * A URL that points at nothing, a database with no migrations applied and a typo in the variable
 * name all have to be distinguishable from a healthy connection, because they need different
 * fixes and because the first two are exactly how this suite could go back to proving nothing.
 */
export async function probeSchema(): Promise<SchemaProbe> {
  if (TEST_DATABASE_URL === undefined) {
    return { ok: false, problem: `DATABASE_URL is not set. ${DATABASE_FIX_HINT}` };
  }
  const client = testClientFor(TEST_DATABASE_URL);
  try {
    await client`select 1 from prl.users limit 1`;
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
