#!/usr/bin/env node
/**
 * Every glob in a `test` script matches files, and every filter matches projects.
 *
 * Run with:  node --test scripts/test-inventory.test.mjs
 *
 * ## The defect this exists for
 *
 * An adversarial review of the CI workflows executed these two, and they are the whole reason this
 * file is here:
 *
 *     pnpm -r --filter "./nosuchdir/**" test   ->  "No projects matched the filters"   EXIT 0
 *     node --test 'nosuch/**\/*.test.mjs'      ->  "pass 0"                            EXIT 0
 *
 * `pnpm run test` composes four such invocations. A renamed directory, a workspace that stops
 * matching a filter, or a glob that quietly matches nothing produces a **green `Tests` job over
 * nothing at all** — which is the "a sweep of nothing is not a pass" rule this repository applies
 * to every scanner it owns, applied for the first time to the thing that runs the scanners.
 *
 * It is the most dangerous instance of that shape, because every other guard in the repo is
 * downstream of it: a test runner that silently runs zero tests makes every other green tick a
 * statement about nothing.
 *
 * ## What this does NOT do
 *
 * It does not count assertions or pin a total. A total drifts on every honest change and would be
 * edited to whatever the run produced, which is a number that agrees with itself. This asserts the
 * weaker, stable property: **the runner was pointed at something that exists.**
 *
 * ## Would it fail if the behaviour broke?
 *
 * The negative controls below run the real resolvers against a directory that does not exist and a
 * filter that matches no workspace, and require each to be reported as empty.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files under `dir` matching `test/**\/*.test.<ext>`, resolved without a glob library. */
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

/** The workspaces `pnpm -r --filter "./packages/**"` would select. */
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
    // 'scripts/**/*.test.mjs' and 'apps/api/scripts/*.test.mjs'. The second is the one that would
    // vanish unnoticed: it is one directory, named once, in one script.
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
    // The two shapes the CI review executed, run here against the real resolvers. Without this,
    // every assertion above passes on a walker that always returned a non-empty list.
    assert.deepEqual(testFilesUnder(join(REPO, 'nosuchdir'), ['ts']), []);
    assert.deepEqual(testFilesUnder(join(REPO, 'scripts'), ['nosuchext']), []);
    assert.throws(
      () => workspacePackages('nosuchdir'),
      /ENOENT/u,
      'a filter naming a directory that does not exist must throw, not resolve to nothing',
    );
  });
});
