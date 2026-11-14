#!/usr/bin/env node
/**
 * Tests for the deciding parts of `scripts/release-artifacts.mjs`.
 * Importing the module must not run it. If the `startedFromCommandLine()` guard goes, this file
 * builds two Docker images, so `the module is inert on import` checks the structure from source.
 * The probe tests keep repository markdown such as `apps/web/AGENTS.md` out of the web image. An empty
 * walk must fail, and `probeRoot` returns the top-level ancestor of WorkingDir on purpose.
 *
 * Run with:  node --test scripts/release-artifacts.test.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { filesystemProbe, filesystemProblems, MANIFEST_SCHEMA, probeRoot } from './release-artifacts.mjs';
import { MUST_BE_IGNORED } from './supply-chain/secret-scan.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'release-artifacts.mjs'), 'utf8');

const probeResult = (overrides = {}) => ({
  root: '/app',
  exists: true,
  examined: 395,
  unreadable: [],
  markdown: [],
  dotenv: [],
  credentials: [],
  ...overrides,
});

describe('the module is inert on import', () => {
  it('reached the file it meant to read', () => {
    // A regex over an empty string proves nothing.
    assert.ok(SCRIPT.length > 20_000, `release-artifacts.mjs is only ${SCRIPT.length} bytes`);
    assert.ok(SCRIPT.includes("run('docker', args"), 'the file must still be the one that builds');
    assert.equal(MANIFEST_SCHEMA, 'prl.release-artifacts.v1', 'and the import must have resolved');
  });

  it('runs nothing at module scope: the whole command line lives in main()', () => {
    // `assert.match` would print the whole script on failure.
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
    // An argv-suffix guard matches a same-named file elsewhere, and a non-realpath guard fails inside
    // pnpm's symlinks, turning the command into a silent no-op.
    const guard = /function startedFromCommandLine\(\) \{[\s\S]*?\n\}/.exec(SCRIPT)?.[0] ?? '';
    assert.ok(guard.length > 0, 'the guard function must be findable');
    assert.match(guard, /realpathSync\(entry\) === realpathSync\(fileURLToPath\(import\.meta\.url\)\)/);
  });

  it('imports realpathSync, without which the guard fails closed and the script does nothing', () => {
    // Without the import the guard throws into its own `catch` and `--help` prints nothing with exit 0.
    assert.ok(
      /^\s*realpathSync,$/m.test(SCRIPT),
      'realpathSync must be imported from node:fs, or startedFromCommandLine() throws a ' +
        'ReferenceError into its own catch, returns false, and the script silently does nothing',
    );
  });

  it('keeps the reporter reachable from pushAll, which is defined outside main()', () => {
    // Moving `tick` and `cross` into `main()` breaks only the --push path.
    const mainAt = SCRIPT.indexOf('async function main() {');
    const failuresAt = SCRIPT.indexOf('const failures = [];');
    const pushAllAt = SCRIPT.indexOf('async function pushAll(');
    assert.ok(failuresAt > 0 && pushAllAt > 0 && mainAt > 0, 'all three must be present');
    assert.ok(failuresAt < pushAllAt, 'the reporter must be declared before pushAll uses it');
    assert.ok(failuresAt < mainAt, 'and outside main(), or pushAll cannot see it');
  });
});

describe('probeRoot', () => {
  it('returns the working directory itself when it is already top level', () => {
    // Positive control against a function that always returns null or '/app'.
    assert.equal(probeRoot('/app'), '/app');
    assert.equal(probeRoot('/srv'), '/srv');
  });

  it('collapses a nested working directory to the tree the image must not carry', () => {
    assert.equal(probeRoot('/app/apps/web'), '/app');
    assert.equal(probeRoot('/srv/api/dist'), '/srv');
  });

  // This fails if `probeRoot` is "simplified" to `return workingDir`.
  it('a probe rooted at the literal WorkingDir would miss a sibling of it', () => {
    const workingDir = '/app/apps/web';
    const sibling = '/app/apps/api/AGENTS.md';

    assert.equal(sibling.startsWith(`${workingDir}/`), false, 'the sibling is outside WorkingDir');
    assert.equal(sibling.startsWith(`${probeRoot(workingDir)}/`), true, 'and inside the probe root');
  });

  it('matches what the real Dockerfiles actually set, including the nested one', () => {
    const web = readFileSync(join(REPO_ROOT, 'Dockerfile.web'), 'utf8');
    const api = readFileSync(join(REPO_ROOT, 'Dockerfile.api'), 'utf8');
    assert.ok(web.length > 2_000 && api.length > 2_000, 'both Dockerfiles must be substantial');

    const workdirs = (text) => [...text.matchAll(/^WORKDIR\s+(\S+)\s*$/gm)].map((match) => match[1]);
    const webDirs = workdirs(web);
    const apiDirs = workdirs(api);
    assert.ok(webDirs.length >= 2, `Dockerfile.web declares ${webDirs.length} WORKDIRs`);
    assert.ok(apiDirs.length >= 1, `Dockerfile.api declares ${apiDirs.length} WORKDIRs`);

    // The runtime stage is last, so its WORKDIR is Config.WorkingDir.
    const webRuntime = webDirs.at(-1);
    assert.equal(webRuntime, '/app/apps/web', 'the web image still ends on a nested WORKDIR');
    assert.notEqual(webRuntime, '/app', 'which is the point: it is NOT the tree being checked');

    for (const dir of [...webDirs, ...apiDirs]) {
      assert.equal(probeRoot(dir), '/app', `${dir} must collapse to the application root`);
    }
  });

  it('refuses a WorkingDir that is not an absolute path, rather than guessing one', () => {
    // An image with no WorkingDir reports ''. `checkArtefact` records null as a failure.
    for (const value of ['', '   ', 'app', 'app/apps/web', './app', undefined, null, 42, {}]) {
      assert.equal(probeRoot(value), null, `${JSON.stringify(value)} must not yield a root`);
    }
  });

  it('does not turn a bare / into an empty root', () => {
    // A root of `/` would walk the whole image filesystem.
    assert.equal(probeRoot('/'), null);
    assert.equal(probeRoot('//'), null);
  });

  it('tolerates the trailing slash and surrounding space a format string can leave behind', () => {
    assert.equal(probeRoot('/app/'), '/app');
    assert.equal(probeRoot('  /app/apps/web  '), '/app');
  });
});

describe('filesystemProblems', () => {
  it('reports nothing for an image that was walked and is clean', () => {
    // Positive control against a function that always reports a problem.
    assert.deepEqual(filesystemProblems(probeResult(), '/app'), []);
  });

  it('an image that examined nothing is a failure, not a clean pass', () => {
    const problems = filesystemProblems(probeResult({ examined: 0 }), '/app');
    assert.equal(problems.length, 1, 'walking nothing must produce a problem');
    assert.match(problems[0], /examined 0 files under \/app/);
    assert.match(problems[0], /read that as a clean pass/, 'and must say why it used to not');

    // Asserted as a property so a reworded message still fails.
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
    const problems = filesystemProblems(
      probeResult({ markdown: ['/app/README.md'], dotenv: ['/app/.env'] }),
      '/app',
    );
    assert.equal(problems.length, 2);
  });

  it('does not let a hit list hide behind a probe that examined nothing', () => {
    // A walk that examined nothing cannot be trusted for what it did report.
    const problems = filesystemProblems(probeResult({ examined: 0, markdown: ['/app/README.md'] }), '/app');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /examined 0 files/);
  });

  it('treats a missing or malformed probe result as a failure rather than a pass', () => {
    for (const hits of [undefined, null, {}, { root: '/app' }, { exists: true }]) {
      const problems = filesystemProblems(hits, '/app');
      assert.ok(problems.length > 0, `${JSON.stringify(hits)} must not read as clean`);
    }
  });

  it('reports credential material that is not an .env, and says rotation is the remedy', () => {
    const problems = filesystemProblems(
      probeResult({ credentials: ['/app/deploy/signing/cosign.key'] }),
      '/app',
    );
    assert.equal(problems.length, 1);
    assert.match(problems[0], /cosign\.key/);
    assert.match(problems[0], /rotating it is the only remedy/, 'the message must say what to do');
  });

  it('refuses a probe result with no credentials list rather than reading it as clean', () => {
    // A missing bucket would look like an image with no key material.
    const { credentials, ...withoutBucket } = probeResult();
    assert.equal(Array.isArray(credentials), true, 'the helper must model the real probe output');
    const problems = filesystemProblems(withoutBucket, '/app');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no `credentials` list/);
  });
});

// The probe walk itself, run on the host with `node -e` as it runs in the image. An old probe
// passed an image carrying `cosign.key` and three other secrets.

describe('the in-image credential probe', () => {
  const runProbe = (files) => {
    const dir = mkdtempSync(join(tmpdir(), 'prl-probe-'));
    try {
      for (const relative of files) {
        const full = join(dir, relative);
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, 'placeholder, not a credential\n');
      }
      const out = execFileSync(process.execPath, ['-e', filesystemProbe(dir)], { encoding: 'utf8' });
      return { dir, hits: JSON.parse(out) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('finds every path MUST_BE_IGNORED names, at the depth the deployment writes it', () => {
    // Imported, so a new entry in secret-scan.mjs extends the probe on the same commit.
    assert.ok(MUST_BE_IGNORED.length >= 9, 'a shrunken list would make this assertion vacuous');
    const paths = MUST_BE_IGNORED.map((entry) => entry.path);
    const { dir, hits } = runProbe(paths);
    assert.equal(hits.examined, paths.length, 'the walk must have seen all of them');
    const found = new Set([...hits.credentials, ...hits.dotenv].map((full) => full.slice(dir.length + 1)));
    for (const path of paths) {
      assert.equal(found.has(path), true, `${path} must be reported by the probe`);
    }
  });

  it('finds key material by shape, wherever in the tree it landed', () => {
    const paths = ['a/b/c/server.pem', 'x/private.key', 'deep/id_rsa', 'y/keystore.p12'];
    const { dir, hits } = runProbe(paths);
    const found = new Set(hits.credentials.map((full) => full.slice(dir.length + 1)));
    for (const path of paths) assert.equal(found.has(path), true, `${path} must be reported`);
  });

  it('finds any *.env, not only names starting with a dot', () => {
    // `backup.env` holds PRL_BACKUP_KEY. The old `/^\.env/` test missed it.
    const { dir, hits } = runProbe(['deploy/backup/backup.env', 'deploy/signing/signing.env']);
    const found = new Set(hits.credentials.map((full) => full.slice(dir.length + 1)));
    assert.equal(found.has('deploy/backup/backup.env'), true);
    assert.equal(found.has('deploy/signing/signing.env'), true);
  });

  it('leaves an ordinary application tree alone', () => {
    // Positive control against a probe that flags everything.
    const { hits } = runProbe([
      'package.json',
      'apps/api/dist/server.js',
      'packages/content/data/glossary.json',
      'apps/web/.next/BUILD_ID',
    ]);
    assert.deepEqual(hits.credentials, [], 'no ordinary file may be called credential material');
    assert.deepEqual(hits.markdown, []);
  });
});
