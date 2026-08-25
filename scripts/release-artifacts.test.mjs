#!/usr/bin/env node
/**
 * Tests for the parts of `scripts/release-artifacts.mjs` that decide things.
 *
 * Run with:  node --test scripts/release-artifacts.test.mjs
 * Also run by:  pnpm run test:scripts
 *
 * ## This file could not exist until the script had an import guard
 *
 * That is not a preamble, it is the first thing being tested. Until very recently the whole
 * run block sat at module scope, so `import './release-artifacts.mjs'` RAN it: `docker build`
 * for both images, a push if `--push` happened to be in the importing process's argv, and
 * `deploy/staging/release-manifest.json` overwritten. It was discovered the hard way — a
 * one-line import written to check the filesystem probe started a real image build on a machine
 * with a staging stack running on it, and had to be interrupted.
 *
 * So the import at the bottom of this comment block is itself the negative control for the
 * guard: if `startedFromCommandLine()` is ever removed, or the run block is moved back out of
 * `main()`, running `node --test scripts/release-artifacts.test.mjs` builds two Docker images.
 * That is a loud enough failure that it does not need an assertion — but it is a slow and
 * destructive one, so `the module is inert on import` below asserts the structure directly,
 * from the source, and fails in milliseconds instead.
 *
 * ## What the other two describe blocks exist to prevent
 *
 * Both cover the artefact filesystem probe, which is the check that exists because
 * `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` — this repository's instructions to coding
 * agents — shipped inside the published web image once already.
 *
 * 1. **`filesystemProblems`, and specifically the `examined === 0` case.** The probe used to
 *    walk a hard-coded `/app` with its `readdirSync` inside `try { … } catch { return; }`. An
 *    image whose content had moved, or whose runtime stage never received the application,
 *    produced `{ markdown: [], dotenv: [] }` — byte-for-byte what a clean image produces — and
 *    the release passed. A check that cannot fail is not a check, so the probe now counts what
 *    it examined and examining nothing is a failure.
 *
 * 2. **`probeRoot`, and the decision that looks like a bug.** It returns the TOP-LEVEL ancestor
 *    of `WorkingDir`, not `WorkingDir` itself. Anybody who has not read the comment will try to
 *    "simplify" it to `return workingDir`, so the reason is pinned here against the real
 *    Dockerfile: `Dockerfile.web`'s runtime stage ends on `WORKDIR /app/apps/web` while the
 *    repository tree it must not carry is copied to `/app`. Probing the literal working
 *    directory would examine one subtree and never look at its siblings — a narrower check than
 *    the one that caught AGENTS.md.
 *
 * ## Would these fail if the behaviour broke?
 *
 * Checked by breaking each one on purpose while writing them:
 *
 *  * `probeRoot` reduced to `return workingDir` fails `collapses a nested working directory to
 *    the tree the image must not carry` and `a probe rooted at the literal WorkingDir would miss
 *    a sibling`, the second of which states the consequence rather than the value.
 *  * `filesystemProblems` with the `examined` branch deleted fails `an image that examined
 *    nothing is a failure, not a clean pass` — and, deliberately, still passes `reports nothing
 *    for an image that was walked and is clean`, which is the positive control that stops a
 *    function that refuses everything from satisfying this file.
 *  * The guard: reverting `main()` to top-level code fails `the module is inert on import` on
 *    the missing `startedFromCommandLine` call, before the much slower failure of actually
 *    building an image.
 *
 * Every scan-style assertion also checks that it scanned something: the script and both
 * Dockerfiles are asserted to be substantial and to contain the neighbouring code, so a
 * truncated or wrong file could not pass quietly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { filesystemProblems, MANIFEST_SCHEMA, probeRoot } from './release-artifacts.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'release-artifacts.mjs'), 'utf8');

/** A probe result as the in-image walk actually emits it. */
const probeResult = (overrides = {}) => ({
  root: '/app',
  exists: true,
  examined: 395,
  unreadable: [],
  markdown: [],
  dotenv: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// The import guard
// ---------------------------------------------------------------------------

describe('the module is inert on import', () => {
  it('reached the file it meant to read', () => {
    // The guard against a vacuous scan: every assertion below is a regex over `SCRIPT`, and a
    // regex over an empty string proves nothing.
    assert.ok(SCRIPT.length > 20_000, `release-artifacts.mjs is only ${SCRIPT.length} bytes`);
    assert.ok(SCRIPT.includes("run('docker', args"), 'the file must still be the one that builds');
    assert.equal(MANIFEST_SCHEMA, 'prl.release-artifacts.v1', 'and the import must have resolved');
  });

  it('runs nothing at module scope: the whole command line lives in main()', () => {
    // `assert.ok(regex.test(...))` rather than `assert.match(SCRIPT, regex)`: match prints the
    // ACTUAL value on failure, and the actual value here is the whole 38 KB script. A failure
    // nobody can read is a failure people delete.
    const has = (pattern, what) => assert.ok(pattern.test(SCRIPT), `release-artifacts.mjs ${what}`);
    has(/^async function main\(\) \{$/m, 'must keep the run block inside `async function main()`');
    has(
      /^if \(startedFromCommandLine\(\)\) await main\(\);$/m,
      'must call main() only behind `if (startedFromCommandLine())` — without that line, importing ' +
        'this module builds two Docker images',
    );
    has(/^function startedFromCommandLine\(\) \{$/m, 'must define the guard it calls');
  });

  it('decides "started from the command line" by comparing real paths, not argv text', () => {
    // A guard written as `process.argv[1].endsWith('release-artifacts.mjs')` passes for a file
    // of the same name in another directory, and one written against a non-realpath'd path
    // fails inside pnpm's symlink farm — which would silently turn `pnpm run release:artifacts`
    // into a no-op that exits 0.
    const guard = /function startedFromCommandLine\(\) \{[\s\S]*?\n\}/.exec(SCRIPT)?.[0] ?? '';
    assert.ok(guard.length > 0, 'the guard function must be findable');
    // Matched against the extracted function, not the file, so a failure prints ten lines.
    assert.match(guard, /realpathSync\(entry\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  });

  it('imports realpathSync, without which the guard fails closed and the script does nothing', () => {
    // Found the hard way while writing this: the guard was added before the import was, the
    // ReferenceError was swallowed by its own `catch`, and `--help` printed nothing at all
    // while still exiting 0. A guard that fails closed is silent, which is the worst way for
    // it to be wrong.
    assert.ok(
      /^\s*realpathSync,$/m.test(SCRIPT),
      'realpathSync must be imported from node:fs, or startedFromCommandLine() throws a ' +
        'ReferenceError into its own catch, returns false, and the script silently does nothing',
    );
  });

  it('keeps the reporter reachable from pushAll, which is defined outside main()', () => {
    // `pushAll` reports through `tick` and `cross`. Moving those inside `main()` is the obvious
    // tidy-up and it would put them out of `pushAll`'s scope — a ReferenceError on the --push
    // path only, which no other test here would reach.
    const mainAt = SCRIPT.indexOf('async function main() {');
    const failuresAt = SCRIPT.indexOf('const failures = [];');
    const pushAllAt = SCRIPT.indexOf('async function pushAll(');
    assert.ok(failuresAt > 0 && pushAllAt > 0 && mainAt > 0, 'all three must be present');
    assert.ok(failuresAt < pushAllAt, 'the reporter must be declared before pushAll uses it');
    assert.ok(failuresAt < mainAt, 'and outside main(), or pushAll cannot see it');
  });
});

// ---------------------------------------------------------------------------
// probeRoot
// ---------------------------------------------------------------------------

describe('probeRoot', () => {
  it('returns the working directory itself when it is already top level', () => {
    // The positive control. A function that always returned null, or always '/app', would pass
    // one of the blocks below and fail this.
    assert.equal(probeRoot('/app'), '/app');
    assert.equal(probeRoot('/srv'), '/srv');
  });

  it('collapses a nested working directory to the tree the image must not carry', () => {
    assert.equal(probeRoot('/app/apps/web'), '/app');
    assert.equal(probeRoot('/srv/api/dist'), '/srv');
  });

  /**
   * The decision, stated as its consequence rather than as its return value.
   *
   * This is the assertion that survives someone "simplifying" `probeRoot` to `return
   * workingDir`: that change keeps every value-equality test above arguably defensible-looking
   * and breaks this one, which says what the check would stop being able to see.
   */
  it('a probe rooted at the literal WorkingDir would miss a sibling of it', () => {
    const workingDir = '/app/apps/web';
    const sibling = '/app/apps/api/AGENTS.md';

    assert.equal(sibling.startsWith(`${workingDir}/`), false, 'the sibling is outside WorkingDir');
    assert.equal(sibling.startsWith(`${probeRoot(workingDir)}/`), true, 'and inside the probe root');
  });

  /**
   * Read out of the Dockerfile rather than restated here, so this notices the day somebody
   * changes it. The two files are checked to be real first — a scan of a missing file returns
   * no matches, and "no matches" must not read as "nothing to worry about".
   */
  it('matches what the real Dockerfiles actually set, including the nested one', () => {
    const web = readFileSync(join(REPO_ROOT, 'Dockerfile.web'), 'utf8');
    const api = readFileSync(join(REPO_ROOT, 'Dockerfile.api'), 'utf8');
    assert.ok(web.length > 2_000 && api.length > 2_000, 'both Dockerfiles must be substantial');

    const workdirs = (text) => [...text.matchAll(/^WORKDIR\s+(\S+)\s*$/gm)].map((match) => match[1]);
    const webDirs = workdirs(web);
    const apiDirs = workdirs(api);
    assert.ok(webDirs.length >= 2, `Dockerfile.web declares ${webDirs.length} WORKDIRs`);
    assert.ok(apiDirs.length >= 1, `Dockerfile.api declares ${apiDirs.length} WORKDIRs`);

    // The runtime stage is the last one, so its WORKDIR is what `docker image inspect` reports
    // as Config.WorkingDir. This is the case the whole decision is about.
    const webRuntime = webDirs.at(-1);
    assert.equal(webRuntime, '/app/apps/web', 'the web image still ends on a nested WORKDIR');
    assert.notEqual(webRuntime, '/app', 'which is the point: it is NOT the tree being checked');

    // Every WORKDIR either image declares collapses to the same probe root, so one root covers
    // both artefacts and neither is checked more narrowly than the other.
    for (const dir of [...webDirs, ...apiDirs]) {
      assert.equal(probeRoot(dir), '/app', `${dir} must collapse to the application root`);
    }
  });

  it('refuses a WorkingDir that is not an absolute path, rather than guessing one', () => {
    // An image with no WorkingDir set reports the empty string. Returning some default here
    // would put the guess back that the whole change removed; `checkArtefact` turns null into a
    // recorded failure instead.
    for (const value of ['', '   ', 'app', 'app/apps/web', './app', undefined, null, 42, {}]) {
      assert.equal(probeRoot(value), null, `${JSON.stringify(value)} must not yield a root`);
    }
  });

  it('does not turn a bare / into an empty root', () => {
    // `'/'.slice(1).split('/')` is `['']`, and a root of `/` — or worse, of `` — would walk the
    // entire image filesystem or nothing at all. Both are refusals.
    assert.equal(probeRoot('/'), null);
    assert.equal(probeRoot('//'), null);
  });

  it('tolerates the trailing slash and surrounding space a format string can leave behind', () => {
    assert.equal(probeRoot('/app/'), '/app');
    assert.equal(probeRoot('  /app/apps/web  '), '/app');
  });
});

// ---------------------------------------------------------------------------
// filesystemProblems
// ---------------------------------------------------------------------------

describe('filesystemProblems', () => {
  it('reports nothing for an image that was walked and is clean', () => {
    // The positive control, and it is load-bearing: a function that returned a problem for
    // every input would satisfy every other assertion in this block.
    assert.deepEqual(filesystemProblems(probeResult(), '/app'), []);
  });

  /**
   * THE defect. The old probe swallowed a missing directory and returned an empty hit list,
   * which is identical to what a clean image returns — so an image whose content had moved,
   * or a probe pointed at the wrong root, passed the check that exists to stop AGENTS.md
   * shipping. Zero files under an application root is not a state a working release image can
   * be in, so it is a failure.
   */
  it('an image that examined nothing is a failure, not a clean pass', () => {
    const problems = filesystemProblems(probeResult({ examined: 0 }), '/app');
    assert.equal(problems.length, 1, 'walking nothing must produce a problem');
    assert.match(problems[0], /examined 0 files under \/app/);
    assert.match(problems[0], /read that as a clean pass/, 'and must say why it used to not');

    // Stated as the property rather than as the message, so a reworded string still fails a
    // regression: the empty-hit result and the clean result must not be judged the same.
    assert.notDeepEqual(problems, filesystemProblems(probeResult(), '/app'));
  });

  it('fails when the probe root is not in the image at all, and names the WorkingDir', () => {
    const problems = filesystemProblems(
      probeResult({ exists: false, examined: 0, unreadable: ['/app: ENOENT'] }),
      '/app',
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /has no \/app directory/);
    assert.match(problems[0], /cannot pass by finding nothing to look at/);
  });

  it('says "(unset)" rather than an empty gap when the image declares no WorkingDir', () => {
    const problems = filesystemProblems(probeResult({ exists: false, examined: 0 }), '');
    assert.match(problems[0], /WorkingDir is \(unset\)/);
  });

  it('carries the reason a directory could not be read, so the operator is not left guessing', () => {
    const problems = filesystemProblems(
      probeResult({ examined: 0, unreadable: ['/app/apps: EACCES'] }),
      '/app',
    );
    assert.match(problems[0], /\/app\/apps: EACCES/);
  });

  it('still reports the markdown that this check was written for', () => {
    const problems = filesystemProblems(
      probeResult({ markdown: ['/app/apps/web/AGENTS.md', '/app/apps/web/CLAUDE.md'] }),
      '/app',
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /2 markdown file\(s\)/);
    assert.match(problems[0], /AGENTS\.md/);
    assert.match(problems[0], /this is how/, 'the message must carry the incident, not just a count');
  });

  it('truncates a long markdown list rather than printing a thousand paths', () => {
    const many = Array.from({ length: 9 }, (_, index) => `/app/doc-${index}.md`);
    const problems = filesystemProblems(probeResult({ markdown: many }), '/app');
    assert.match(problems[0], /9 markdown file\(s\)/, 'the COUNT must be the full one');
    assert.match(problems[0], /…/, 'and the list must be visibly abbreviated');
    assert.equal(problems[0].includes('/app/doc-8.md'), false, 'only the first five are listed');
  });

  it('reports an environment file, and says why it matters', () => {
    const problems = filesystemProblems(probeResult({ dotenv: ['/app/apps/api/.env'] }), '/app');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /\.env/);
    assert.match(problems[0], /credentials/);
  });

  it('reports markdown and .env together rather than stopping at the first', () => {
    // An image with both problems must show both: fixing one and re-running a build that takes
    // minutes to discover the other is how a gate becomes something people work around.
    const problems = filesystemProblems(
      probeResult({ markdown: ['/app/README.md'], dotenv: ['/app/.env'] }),
      '/app',
    );
    assert.equal(problems.length, 2);
  });

  it('does not let a hit list hide behind a probe that examined nothing', () => {
    // Ordering: `examined === 0` returns early, because a walk that examined no files cannot be
    // trusted to have found the files it did report. The failure it returns is the more
    // fundamental one and must be the one the operator sees.
    const problems = filesystemProblems(probeResult({ examined: 0, markdown: ['/app/README.md'] }), '/app');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /examined 0 files/);
  });

  it('treats a missing or malformed probe result as a failure rather than a pass', () => {
    // The probe runs `node -e` inside the image. A daemon or an image that returns something
    // unexpected must not produce an empty problem list.
    for (const hits of [undefined, null, {}, { root: '/app' }, { exists: true }]) {
      const problems = filesystemProblems(hits, '/app');
      assert.ok(problems.length > 0, `${JSON.stringify(hits)} must not read as clean`);
    }
  });
});
