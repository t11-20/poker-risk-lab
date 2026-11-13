#!/usr/bin/env node
/**
 * Every glob in a `test` script matches files, and every filter matches projects.
 * `pnpm -r --filter "./nosuchdir/**" test` and `node --test 'nosuch/**\/*.test.mjs'` both exit 0, so
 * a renamed directory would give a green Tests job over nothing. This does not pin a test total.
 *
 * Run with:  node --test scripts/test-inventory.test.mjs
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function testFilesUnder(dir, extensions) {
  const out = [];
  const walk = (path) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(full);
      } else if (extensions.some((ext) => entry.name.endsWith(`.test.${ext}`))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

function workspacePackages(relativeDir) {
  const root = join(REPO, relativeDir);
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, 'package.json'))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    })
    .map((path) => JSON.parse(readFileSync(path, 'utf8')));
}

describe('the test runner is pointed at something that exists', () => {
  it('every workspace selected by test:unit has a test script and test files (REGRESSION)', () => {
    const selected = workspacePackages('packages');
    assert.ok(selected.length >= 6, `only ${selected.length} packages matched ./packages/**`);
    for (const manifest of selected) {
      const name = manifest.name;
      assert.ok(
        typeof manifest.scripts?.test === 'string',
        `${name} is selected by test:unit and declares no test script, so it contributes silently nothing`,
      );
      const dir = join(REPO, 'packages', name.replace('@prl/', ''));
      const files = testFilesUnder(join(dir, 'test'), ['ts', 'tsx', 'mjs']);
      assert.ok(files.length > 0, `${name} declares a test script and has no test files under test/`);
    }
  });

  it('test:scripts globs match files in both of the directories they name', () => {
    // 'scripts/**/*.test.mjs' and 'apps/api/scripts/*.test.mjs'. The second is easy to lose unnoticed.
    const scripts = testFilesUnder(join(REPO, 'scripts'), ['mjs']);
    const apiScripts = testFilesUnder(join(REPO, 'apps', 'api', 'scripts'), ['mjs']);
    assert.ok(scripts.length >= 20, `scripts/**/*.test.mjs matched ${scripts.length} files`);
    assert.ok(apiScripts.length >= 1, `apps/api/scripts/*.test.mjs matched ${apiScripts.length} files`);
  });

  it('the api and web suites have test files where their scripts look', () => {
    for (const [name, dir] of [
      ['@prl/api', join(REPO, 'apps', 'api', 'test')],
      ['@prl/web', join(REPO, 'apps', 'web', 'test')],
    ]) {
      const files = testFilesUnder(dir, ['ts', 'tsx']);
      assert.ok(files.length >= 5, `${name} matched ${files.length} test files under ${dir}`);
    }
  });

  it('reports an absent directory and an unmatched filter as empty (NEGATIVE CONTROL)', () => {
    // Negative controls. Without them every assertion above passes on a walker that never returns empty.
    assert.deepEqual(testFilesUnder(join(REPO, 'nosuchdir'), ['ts']), []);
    assert.deepEqual(testFilesUnder(join(REPO, 'scripts'), ['nosuchext']), []);
    assert.throws(
      () => workspacePackages('nosuchdir'),
      /ENOENT/u,
      'a filter naming a directory that does not exist must throw, not resolve to nothing',
    );
  });
});
