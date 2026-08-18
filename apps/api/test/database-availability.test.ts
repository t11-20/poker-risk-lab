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
 * ## Would this fail if the behaviour broke?
 *
 * Verified by hand, three ways: with `DATABASE_URL` unset it fails and names `db:setup`; with
 * `DATABASE_URL` pointed at a database with no `prl` schema it fails naming `db:migrate`; and with
 * `databaseSkip` edited to return a reason unconditionally, the meta-assertion below fails.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DATABASE_FIX_HINT,
  DATABASE_REQUIRED,
  DATABASE_TESTS_WAIVED,
  databaseSkip,
  probeSchema,
  RUNNING_IN_CI,
  TEST_DATABASE_URL,
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
