/**
 * The guard that stops this suite quietly skipping its database tests, which once skipped 57 on
 * every documented command. It fails when a database is required and absent, asserts
 * `databaseSkip()` is false when one is present, and scans this tree for a guard that bypasses
 * `test/helpers/database.ts`. It also proves `deadlineBound` changes nothing about a healthy request,
 * including the driver's `code` and `constraint_name`, which `repositories/sql.ts` maps to 409s.
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

const HELPER_FILE = 'helpers/database.ts';

/** The `process.env` prefix is in the pattern, so `DATABASE_URL:` as an object key does not match. */
const READS_DATABASE_URL = /process\.env(?:\[['"`]DATABASE_URL['"`]\]|\.DATABASE_URL)/;

/** Printed once, at the end where the summary is read, so a waived run says what it did not prove. */
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
      // Reachable only through `test:without-database` outside CI.
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
 * The floor `config.ts` accepts. `queryDeadlineMs` is this plus two seconds, so this is where a
 * client deadline would pre-empt the server if it could.
 */
const TIGHT_STATEMENT_TIMEOUT_MS = 100;

/** Ten seconds, so the sleep cannot finish on its own on a slow machine. */
const LONGER_THAN_ANY_TIMEOUT_SECONDS = 10;

describe('the request-path deadline leaves a healthy database alone', () => {
  /**
   * Returns early without a database rather than using `skip:`. The first test in this file fails
   * the run when a database is required and missing.
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

      // `sql(name)` in a template builds an identifier, not a query, so it must pass through untouched.
      const sql = getSql();
      const identified = await sql<{ n: number }[]>`select ${sql('n')} from (select 7 as n) as t`;
      assert.deepEqual([...identified], [{ n: 7 }], 'sql(identifier) must still build a fragment');

      const committed = await withTransaction(async (tx) => {
        const [row] = await tx<{ answer: number }[]>`select 42 as answer`;
        return row?.answer ?? null;
      });
      assert.equal(committed, 42, 'a transaction must still return its callback’s value');

      // A rollback must propagate the callback's own error unchanged.
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
      // The control runs the same statement through an unwrapped client, so this is no tautology.
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
    // The client bound sits above `statement_timeout`. A tighter client deadline would show
    // `service_unavailable` instead of `57014`.
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
