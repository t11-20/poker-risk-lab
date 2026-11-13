#!/usr/bin/env node
/**
 * Tests for which database `pnpm run db:wait` waits on.
 *
 * Run with:  node --test scripts/db-wait.test.mjs
 *
 * ## The defect this exists for
 *
 * A fresh clone whose `.env` pointed both connection strings at a scratch database ran
 * `pnpm run db:setup`, and db:wait printed
 *
 *     target   poker@127.0.0.1:5432/poker_risk_lab  (from environment)
 *
 * then reported ready — against a different database from the one db:migrate went on to open,
 * because `db:wait` was the only db:* script in package.json without `--env-file-if-exists=.env`.
 * docs/audit/production-audit.md had recorded it as P2-1 and left it. Its suggested fix (load
 * .env and nothing else) would have been worse: DATABASE_URL names prl_api, which db:seed creates
 * two steps later, so on a fresh cluster db:wait would stop at a non-retryable 28P01.
 *
 * ## How it is tested without a database
 *
 * The script prints its target before its first attempt, and port 1 refuses every connection, so
 * each case is a one-second timeout whose first lines say what was being waited on. The command is
 * read out of package.json and run as pnpm would run it, from a directory holding a `.env`, so a
 * package.json that stops loading the file fails here rather than only in somebody's first run.
 *
 * Negative control, run before this was committed: against the old package.json line and the old
 * precedence the first case fails with `(from environment)` and poker_risk_lab, and with the old
 * precedence alone it fails naming prl_api.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

/** Port 1: nothing binds it without root, so every attempt is ECONNREFUSED, which is retried. */
const MIGRATION_URL = 'postgres://dbwait_migrator:x@127.0.0.1:1/dbwait_migration_db';
const API_URL = 'postgres://dbwait_api:x@127.0.0.1:1/dbwait_api_db';

const work = mkdtempSync(join(tmpdir(), 'prl-db-wait-'));
// The command names `scripts/db-wait.mjs` relative to its cwd; the link lets it run from a
// directory whose .env this test owns. Node resolves the main module through the link, so the
// script still finds apps/api's `postgres` from the real repository.
symlinkSync(join(REPO_ROOT, 'scripts'), join(work, 'scripts'), 'dir');
after(() => rmSync(work, { recursive: true, force: true }));

/** The environment of a shell with no database variables of its own. */
function cleanEnv() {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

/** Runs package.json's `db:wait` the way `pnpm run db:wait` does, with `dotenv` as the .env. */
function runDbWait(dotenv, extraArgs = []) {
  const command = PKG.scripts['db:wait'];
  const [program, ...args] = command.split(/\s+/);
  assert.equal(program, 'node', `db:wait is no longer a plain node command: ${command}`);
  writeFileSync(join(work, '.env'), dotenv);
  const result = spawnSync(process.execPath, [...args, '--timeout', '1', '--interval', '50', ...extraArgs], {
    cwd: work,
    env: cleanEnv(),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const targetLine = result.stdout.split('\n').find((line) => line.trim().startsWith('target'));
  assert.ok(targetLine, `db:wait printed no target line:\n${result.stdout}\n${result.stderr}`);
  return { ...result, targetLine };
}

describe('db:wait waits on the database db:migrate is about to open', () => {
  it('reads .env, and prefers DATABASE_MIGRATION_URL over DATABASE_URL (REGRESSION)', () => {
    const run = runDbWait(`DATABASE_URL=${API_URL}\nDATABASE_MIGRATION_URL=${MIGRATION_URL}\n`);
    assert.match(run.targetLine, /dbwait_migrator@127\.0\.0\.1:1\/dbwait_migration_db/);
    assert.match(run.targetLine, /\(from DATABASE_MIGRATION_URL\)/);
    // It must still have WAITED and given up, not treated a refused port as ready.
    assert.equal(run.status, 1, run.stdout);
  });

  it('falls back to DATABASE_URL when that is all there is, which is how CI calls it', () => {
    const run = runDbWait(`DATABASE_URL=${API_URL}\n`);
    assert.match(run.targetLine, /dbwait_api@127\.0\.0\.1:1\/dbwait_api_db/);
    assert.match(run.targetLine, /\(from DATABASE_URL\)/);
  });

  it('treats a blank DATABASE_MIGRATION_URL as unset, as migrate.mjs does (REGRESSION)', () => {
    const run = runDbWait(`DATABASE_MIGRATION_URL="   "\nDATABASE_URL=${API_URL}\n`);
    assert.match(run.targetLine, /dbwait_api@127\.0\.0\.1:1\/dbwait_api_db/);
    assert.match(run.targetLine, /\(from DATABASE_URL\)/);
  });

  it('lets --url override both', () => {
    const override = 'postgres://dbwait_override:x@127.0.0.1:1/dbwait_override_db';
    const run = runDbWait(`DATABASE_MIGRATION_URL=${MIGRATION_URL}\n`, ['--url', override]);
    assert.match(run.targetLine, /dbwait_override@127\.0\.0\.1:1\/dbwait_override_db/);
    assert.match(run.targetLine, /\(from --url\)/);
  });

  it('never prints the password', () => {
    const run = runDbWait(`DATABASE_MIGRATION_URL=${MIGRATION_URL}\n`);
    assert.doesNotMatch(run.stdout + run.stderr, /:x@/);
  });
});
