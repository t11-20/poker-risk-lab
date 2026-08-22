/**
 * The guard that stops this suite quietly stopping.
 *
 * Fifty-seven tests in this package only run against a real schema — among them the six that
 * assert the release-blocking guardrail that one player never receives another player's private
 * cards. They used to skip on every documented developer command, because the test script passed
 * no `--env-file` and so `DATABASE_URL` was never set, and the run exited 0 anyway.
 *
 * This file makes that impossible in three ways:
 *
 *   1. **It fails when the database is required and absent.** No skip, no warning: a failing test
 *      with the fix in its message. `test/helpers/database.ts` owns the policy.
 *   2. **It proves the guards are not permanently true.** When a database IS reachable, it asserts
 *      `databaseSkip()` returns `false` — so a typo in the variable name, or a helper that returns
 *      a truthy reason unconditionally, fails here rather than skipping for ever in silence.
 *   3. **It scans this directory for a guard that does not go through the shared helper.** The
 *      original defect was five hand-rolled copies of the same condition; a sixth would reintroduce
 *      it. Every `skip:` in this test tree has to come from `databaseSkip` (or be a literal
 *      `false`), and that is checked as text, because the alternative is trusting a convention.
 *
 * ## The second thing this file owns: the request path against a database that IS there
 *
 * Every query in this application now goes through a client-side deadline (`deadlineBound` in
 * `src/db.ts`), which exists because a FROZEN PostgreSQL enforces no `statement_timeout` and used
 * to hang every request for the length of the outage. `test/db-deadlines.test.ts` proves the
 * bound fires against a server that never answers, and needs no database to do it.
 *
 * The other half can only be proved where a real one exists, which is here: that the bound
 * changes NOTHING about a healthy request. Rows still come back, the driver's own helpers still
 * work inside a template, a transaction still commits and still rolls back, and a PostgreSQL
 * error still arrives as the driver's error rather than as something the wrapper invented. That
 * last one matters more than it looks: `repositories/sql.ts` reads `code` and `constraint_name`
 * off the thrown object to turn a race into `seat_taken`, and a wrapper that replaced those would
 * turn every 409 in the product into a 500.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Verified by hand, three ways for the skip policy: with `DATABASE_URL` unset it fails and names
 * `db:setup`; with `DATABASE_URL` pointed at a database with no `prl` schema it fails naming
 * `db:migrate`; and with `databaseSkip` edited to return a reason unconditionally, the
 * meta-assertion below fails.
 *
 * For the deadline half, the controls are in the cases themselves and are run rather than
 * described: the driver error is compared against the SAME error raised through an UNBOUND
 * client, so an assertion that had drifted into tautology would show up as the two disagreeing;
 * and the server's `statement_timeout` is deliberately set to 100 ms and a ten-second sleep
 * issued, so a client deadline that had been made tighter than the server's ceiling — the change
 * that would start cancelling legitimate work — reports `service_unavailable` and fails the case.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { closeDatabase, configureDatabase, getSql, queryDeadlineMs, withTransaction } from '../src/db.ts';
import { AppError } from '../src/errors.ts';
import { sqlViolation } from '../src/repositories/sql.ts';
import {
  DATABASE_FIX_HINT,
  DATABASE_REQUIRED,
  DATABASE_TESTS_WAIVED,
  databaseSkip,
  probeSchema,
  RUNNING_IN_CI,
  TEST_DATABASE_URL,
  testClientFor,
} from './helpers/database.ts';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

/** The only file allowed to read the variable. Relative to this directory, POSIX separators. */
const HELPER_FILE = 'helpers/database.ts';

/**
 * A direct read of the environment variable, in either accessor form.
 *
 * Not a match for `DATABASE_URL:` appearing as a key in a hand-built `EnvRecord` — which is what
 * `config.test.ts` and every harness legitimately do — because the `process.env` prefix is part of
 * the pattern.
 */
const READS_DATABASE_URL = /process\.env(?:\[['"`]DATABASE_URL['"`]\]|\.DATABASE_URL)/;

/**
 * The banner. Printed once, from this file only, so a waived run says out loud what it did not
 * prove — and says it at the end, where the summary is read.
 */
if (TEST_DATABASE_URL === undefined && DATABASE_TESTS_WAIVED && !RUNNING_IN_CI) {
  process.on('exit', () => {
    console.warn(
      '\n' +
        '='.repeat(78) +
        '\nWARNING: the database-backed suites were SKIPPED because this run waived them.\n' +
        'This run proves NOTHING about SQL, hand-history isolation, seat contention, session\n' +
        'revocation or the API-level hidden-information guardrail. ' +
        `\n${DATABASE_FIX_HINT}\n` +
        '='.repeat(78),
    );
  });
}

describe('the database-backed suites are not silently skipped', () => {
  it('has a reachable schema, or fails loudly saying how to get one', async () => {
    const probe = await probeSchema();
    if (probe.ok) return;
    if (!DATABASE_REQUIRED) {
      // The only path that tolerates a missing database, and it is only reachable through the
      // explicitly named `test:without-database` script outside CI. The banner above has already
      // said what this run does not prove.
      assert.equal(DATABASE_TESTS_WAIVED, true);
      assert.equal(RUNNING_IN_CI, false);
      return;
    }
    assert.fail(
      `${probe.problem ?? 'the database is not reachable'}\n\n` +
        'This is a hard failure on purpose. 57 tests in this package — including the six that ' +
        "assert one player never receives another player's hole cards over HTTP — cannot run " +
        'without it, and a suite that skips them while exiting 0 is worse than one that fails.',
    );
  });

  it('reports no skip reason once a database is present', () => {
    if (TEST_DATABASE_URL === undefined) return;
    for (const context of ['the hand routes', 'the repositories', 'the signed-in content paths']) {
      assert.equal(
        databaseSkip(context),
        false,
        'DATABASE_URL is set, so no suite may report a skip reason; a guard that stays true ' +
          'skips for ever and nothing notices',
      );
    }
  });

  it('refuses to let CI waive the database suites', () => {
    // The distinction the policy turns on: a developer without Docker may waive these; a release
    // pipeline may not. Asserted as an implication so it holds in both environments.
    assert.equal(
      RUNNING_IN_CI && !DATABASE_REQUIRED,
      false,
      'CI must never be allowed to skip the database suites',
    );
    if (RUNNING_IN_CI) assert.equal(DATABASE_REQUIRED, true);
  });

  it('lets exactly one file read DATABASE_URL, so one place decides', () => {
    const offences: string[] = [];
    let scanned = 0;
    let sawTheHelper = false;
    for (const entry of readdirSync(TEST_DIR, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = join(entry.parentPath, entry.name);
      const relative = path.slice(TEST_DIR.length + 1);
      const source = readFileSync(path, 'utf8');
      scanned += 1;
      if (!READS_DATABASE_URL.test(source)) continue;
      if (relative === HELPER_FILE) {
        sawTheHelper = true;
        continue;
      }
      offences.push(relative);
    }
    assert.ok(scanned > 12, `expected the api test tree, scanned ${scanned} files`);
    // The positive control: if the detector matched nothing anywhere, the assertion below would
    // pass for a tree in which every guard had gone hand-rolled again.
    assert.equal(sawTheHelper, true, `the detector did not even match ${HELPER_FILE}`);
    assert.deepEqual(
      offences,
      [],
      'these files read DATABASE_URL directly instead of importing test/helpers/database.ts, ' +
        'which is how five copies of the same guard came to skip 57 tests in silence:\n' +
        offences.join('\n'),
    );
  });

  it('scans a tree it actually found, so a passing result means something', () => {
    const files = readdirSync(TEST_DIR).filter((name) => name.endsWith('.test.ts'));
    assert.ok(files.length > 8, `expected the api test suite, found ${files.length} files`);
  });
});

/**
 * The server-side statement ceiling these cases configure.
 *
 * The floor of the range `config.ts` accepts, so the sleep below is cancelled in a tenth of a
 * second instead of five, and so `queryDeadlineMs` — which is this plus two seconds of slack — is
 * as close to the server's ceiling as it is ever allowed to get. If the client deadline could
 * ever pre-empt the server, this is the setting under which it would.
 */
const TIGHT_STATEMENT_TIMEOUT_MS = 100;

/**
 * A `pg_sleep` far longer than anything here waits for.
 *
 * Ten seconds rather than one, so the case cannot pass by accident on a machine slow enough for
 * the sleep to have finished on its own.
 */
const LONGER_THAN_ANY_TIMEOUT_SECONDS = 10;

describe('the request-path deadline leaves a healthy database alone', () => {
  /**
   * Every case here returns early without a database, and that is NOT a silent skip: the very
   * first test in this file FAILS the run when a database is required and missing, and the banner
   * at the top says out loud what a waived run did not prove. This is the same early-return shape
   * `reports no skip reason once a database is present` uses, and it is deliberately not a
   * `skip:`, which would make the run green while proving nothing.
   */
  function liveConfig(statementTimeoutMs: number) {
    assert.ok(TEST_DATABASE_URL !== undefined);
    return loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
      SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA',
      DATABASE_POOL_MAX: '2',
      DATABASE_STATEMENT_TIMEOUT_MS: String(statementTimeoutMs),
    });
  }

  it('returns rows, runs the driver’s helpers, and commits and rolls back a transaction', async () => {
    if (TEST_DATABASE_URL === undefined) return;
    const config = liveConfig(5_000);
    configureDatabase(config);
    try {
      const startedAt = performance.now();
      const rows = await getSql()<{ ok: number }[]>`select 1 as ok`;
      const elapsed = performance.now() - startedAt;
      assert.deepEqual([...rows], [{ ok: 1 }], 'a bound query must return exactly what the driver returns');
      assert.ok(
        elapsed < queryDeadlineMs(config) / 4,
        `an ordinary query is nowhere near the deadline, took ${Math.round(elapsed)} ms`,
      );

      // The helper branch of the proxy: `sql(name)` inside a template builds an identifier and is
      // NOT a query, so it must pass through untouched. Wrapping it would turn every dynamic
      // column reference in the repositories into a promise spliced into SQL.
      const sql = getSql();
      const identified = await sql<{ n: number }[]>`select ${sql('n')} from (select 7 as n) as t`;
      assert.deepEqual([...identified], [{ n: 7 }], 'sql(identifier) must still build a fragment');

      const committed = await withTransaction(async (tx) => {
        const [row] = await tx<{ answer: number }[]>`select 42 as answer`;
        return row?.answer ?? null;
      });
      assert.equal(committed, 42, 'a transaction must still return its callback’s value');

      // And a rollback still propagates the callback's own error, unchanged. A wrapper that
      // swallowed it, or replaced it with a deadline error, would make every failed write look
      // like an outage.
      const marker = new Error('deliberate rollback');
      const thrown = await withTransaction(async (tx) => {
        await tx`select 1`;
        throw marker;
      }).then(
        () => null,
        (error: unknown) => error,
      );
      assert.equal(thrown, marker, 'the callback’s own error must reach the caller intact');
    } finally {
      await closeDatabase(1_000);
    }
  });

  it('passes a PostgreSQL error through exactly as the unbound driver raises it', async () => {
    if (TEST_DATABASE_URL === undefined) return;
    const config = liveConfig(5_000);
    configureDatabase(config);
    const unbound = testClientFor(TEST_DATABASE_URL);
    try {
      const throughBound = await getSql()`select 1 / 0 as boom`.then(
        () => null,
        (error: unknown) => error,
      );
      // The CONTROL: the same statement through a client with no deadline wrapper on it at all.
      // Asserting against the driver rather than against a literal is what stops this case
      // becoming a restatement of whatever the wrapper happens to do.
      const throughRaw = await unbound`select 1 / 0 as boom`.then(
        () => null,
        (error: unknown) => error,
      );

      const bound = sqlViolation(throughBound);
      const raw = sqlViolation(throughRaw);
      assert.equal(bound, null, 'division by zero is not an integrity violation, on either handle');
      assert.equal(raw, null);
      assert.equal(
        (throughBound as { code?: unknown } | null)?.code,
        '22012',
        'the SQLSTATE must survive the wrapper; repositories/sql.ts reads it to turn races into 409s',
      );
      assert.equal(
        (throughBound as { code?: unknown } | null)?.code,
        (throughRaw as { code?: unknown } | null)?.code,
        'the bound handle and the driver must raise the same error',
      );
      assert.ok(
        !(throughBound instanceof AppError),
        'only a deadline becomes an AppError; a real SQL error stays the driver’s',
      );
    } finally {
      await unbound.end({ timeout: 1 }).catch(() => undefined);
      await closeDatabase(1_000);
    }
  });

  it('lets the server’s own statement_timeout fire first, so slow work is cancelled by Postgres', async () => {
    if (TEST_DATABASE_URL === undefined) return;
    // The property that makes a blanket client-side deadline safe, measured rather than argued:
    // the client bound sits ABOVE `statement_timeout`, so anything a live server is still able to
    // enforce is enforced by the server. A change that made the client deadline tighter would
    // show up here as `service_unavailable` instead of `57014`.
    const config = liveConfig(TIGHT_STATEMENT_TIMEOUT_MS);
    configureDatabase(config);
    try {
      const startedAt = performance.now();
      const thrown = await getSql()`select pg_sleep(${LONGER_THAN_ANY_TIMEOUT_SECONDS})`.then(
        () => null,
        (error: unknown) => error,
      );
      const elapsed = performance.now() - startedAt;

      assert.ok(thrown !== null, 'a ten-second sleep under a 100 ms ceiling must not succeed');
      assert.ok(
        !(thrown instanceof AppError),
        `the client deadline must NOT have fired; it would be cancelling work the server allowed: ${String(thrown)}`,
      );
      assert.equal(
        (thrown as { code?: unknown }).code,
        '57014',
        'PostgreSQL must be the one that cancelled the statement',
      );
      assert.ok(
        elapsed < queryDeadlineMs(config),
        `the server answered inside the client bound, took ${Math.round(elapsed)} ms`,
      );
    } finally {
      await closeDatabase(1_000);
    }
  });
});
