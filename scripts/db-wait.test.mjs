#!/usr/bin/env node
/**
 * Tests which database `pnpm run db:wait` waits on (docs/audit/production-audit.md P2-1).
 *
 * The script prints its target before its first attempt, and port 1 refuses every connection, so
 * each case is a short timeout whose first lines name the target. The command is read out of
 * package.json and run from a directory holding a `.env`.
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

// Nothing binds port 1 without root, so every attempt is a retried ECONNREFUSED.
const MIGRATION_URL = 'postgres://dbwait_migrator:x@127.0.0.1:1/dbwait_migration_db';
const API_URL = 'postgres://dbwait_api:x@127.0.0.1:1/dbwait_api_db';

const work = mkdtempSync(join(tmpdir(), 'prl-db-wait-'));
// Node resolves the main module through the link, so the script still finds apps/api's `postgres`.
symlinkSync(join(REPO_ROOT, 'scripts'), join(work, 'scripts'), 'dir');
after(() => rmSync(work, { recursive: true, force: true }));

function cleanEnv() {
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

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
