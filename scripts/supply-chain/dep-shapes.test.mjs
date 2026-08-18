#!/usr/bin/env node
/**
 * Tests for the `dependency-shapes` gate.
 *
 * Run with:  node --test scripts/supply-chain/dep-shapes.test.mjs
 *
 * ## What these exist to prevent
 *
 * The acquisition-channel check was six regexes over the raw lockfile and it was
 * **dead code**. Four patterns were anchored to the start of a line while pnpm
 * writes `resolution:` inline on one line; the other two looked for `git+ssh://`
 * and an off-registry `.tgz` URL while pnpm records git as
 * `repo: github.com/owner/repo` (no scheme) and a directory dependency with no
 * URL at all. Fed a lockfile carrying a real pnpm-format git resolution and a
 * real pnpm-format directory resolution, **0 of the 6 patterns matched** — and
 * the gate printed `✓ dependency-shapes — pass`. It had a positive test once, in
 * the sense that somebody had watched it fire; but the input they fired it with
 * was hand-written in a format pnpm does not emit.
 *
 * So the fixtures below are the bytes pnpm actually writes. Every one of them is
 * a negative control: feed the gate the real attack, assert it FAILS. A test that
 * only ever asserts the clean repo passes cannot tell a working gate from a gate
 * that has stopped matching anything.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkInstalledLifecycleHooks, checkLockfileShape, checkWorkspaceManifests } from './dep-shapes.mjs';
import { Gate, lockfileText, requireStoreCoverage } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const temporary = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'prl-dep-shapes-'));
  temporary.push(dir);
  return dir;
}

/** All failure messages a gate produced, joined for `assert.match`. */
function failureText(gate) {
  return gate.failures.map((f) => `${f.message} ${f.detail ?? ''}`).join('\n');
}

/**
 * A lockfile in the exact format pnpm 9/10/11 emits, into which a caller can
 * splice hostile entries. The clean part is copied in shape from the real
 * pnpm-lock.yaml so a fixture cannot drift away from the format being audited.
 */
function lockfile({ importerDeps = '', packageEntries = '' } = {}) {
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: false
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      typescript:
        specifier: 7.0.2
        version: 7.0.2

  apps/api:
    dependencies:
      fastify:
        specifier: 5.11.3
        version: 5.11.3
${importerDeps}
packages:

  typescript@7.0.2:
    resolution: {integrity: sha512-clean==}
    engines: {node: '>=14.17'}
    hasBin: true

  fastify@5.11.3:
    resolution: {integrity: sha512-alsoclean==}
${packageEntries}`;
}

describe('acquisition-channel checks (the check that could not fail)', () => {
  it("passes the repository's real lockfile", () => {
    const gate = new Gate('t');
    checkLockfileShape(gate, lockfileText());
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('FAILS on a git resolution written the way pnpm actually writes it', () => {
    // The exact shape pnpm emits for `optionalDependencies: {g2: "antvis/G2#<sha>"}`,
    // which is the campaign's documented delivery Pattern B.
    const gate = new Gate('t');
    checkLockfileShape(
      gate,
      lockfile({
        importerDeps: `      g2:
        specifier: github:antvis/G2
        version: github.com/antvis/G2/9f1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3
`,
        packageEntries: `
  g2@github.com/antvis/G2/9f1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3:
    resolution: {commit: 9f1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3, repo: github.com/antvis/G2, type: git}
    version: 5.5.8
`,
      }),
    );
    const text = failureText(gate);
    assert.ok(gate.failures.length > 0, 'a git resolution must fail the gate');
    assert.match(text, /git repository resolution/);
    assert.match(text, /git commit resolution/);
    assert.match(text, /non-registry resolution type/);
    // …and there is no `git+ssh://` anywhere in it, which is why the old
    // scheme-matching pattern missed.
    assert.doesNotMatch(text, /git\+ssh/);
  });

  it('FAILS on a directory resolution written the way pnpm actually writes it', () => {
    const gate = new Gate('t');
    checkLockfileShape(
      gate,
      lockfile({
        importerDeps: `      outside:
        specifier: file:../../../evil
        version: file:../../../evil
`,
        packageEntries: `
  outside@file:../../../evil:
    resolution: {directory: ../../../evil, type: directory}
    version: 1.0.0
`,
      }),
    );
    assert.ok(gate.failures.length > 0);
    assert.match(failureText(gate), /local directory resolution/);
    assert.match(failureText(gate), /non-registry resolution type/);
  });

  it('FAILS on an off-registry tarball resolution', () => {
    const gate = new Gate('t');
    checkLockfileShape(
      gate,
      lockfile({
        packageEntries: `
  evil@1.0.0:
    resolution: {integrity: sha512-x==, tarball: https://cdn.attacker.example/evil-1.0.0.tgz}
`,
      }),
    );
    assert.match(
      failureText(gate),
      /off-registry tarball resolution for evil@1\.0\.0: cdn\.attacker\.example/,
    );
  });

  it('FAILS on a block-style resolution, which pnpm does not emit but a hand edit can', () => {
    // A checker that only understands its generator's preferred formatting is a
    // checker an attacker reformats their way past.
    const gate = new Gate('t');
    checkLockfileShape(
      gate,
      lockfile({
        packageEntries: `
  gitdep@github.com/attacker/evil:
    resolution:
      type: git
      repo: github.com/attacker/evil
      commit: 9f1a2b3c4d5e6f708192a3b4c5d6e7f809a1b2c3
`,
      }),
    );
    assert.match(failureText(gate), /git repository resolution/);
  });

  it('FAILS on a resolution key it has not been taught to judge', () => {
    const gate = new Gate('t');
    checkLockfileShape(
      gate,
      lockfile({
        packageEntries: '\n  evil@1.0.0:\n    resolution: {integrity: sha512-x==, bundle: ipfs://Qm}\n',
      }),
    );
    assert.match(failureText(gate), /unrecognised resolution key "bundle"/);
  });

  it('FAILS on a workspace link whose specifier is not the workspace: protocol', () => {
    // The lockfile half of the dependency-confusion fix.
    const gate = new Gate('t');
    checkLockfileShape(
      gate,
      lockfile({
        importerDeps: `      '@prl/poker-math':
        specifier: 1.0.0
        version: link:../../packages/poker-math
`,
      }),
    );
    assert.match(failureText(gate), /is a link but its specifier is "1\.0\.0"/);
  });

  it('FAILS on a link that leaves the repository', () => {
    const gate = new Gate('t');
    checkLockfileShape(
      gate,
      lockfile({
        importerDeps: `      evil:
        specifier: workspace:*
        version: link:../../../../evil
`,
      }),
    );
    assert.match(failureText(gate), /links outside the workspace/);
  });

  it('FAILS on an empty lockfile rather than reporting a clean one', () => {
    const gate = new Gate('t');
    checkLockfileShape(gate, "lockfileVersion: '9.0'\n");
    assert.match(failureText(gate), /parsed zero package entries/);
  });

  it('runs from the CLI against an arbitrary lockfile and exits non-zero', () => {
    const dir = scratch();
    const path = join(dir, 'candidate-lock.yaml');
    writeFileSync(
      path,
      lockfile({
        packageEntries: `
  g2@github.com/antvis/G2/9f1a:
    resolution: {commit: 9f1a, repo: github.com/antvis/G2, type: git}
`,
      }),
    );
    const res = spawnSync(process.execPath, [join(HERE, 'dep-shapes.mjs'), '--lockfile', path], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(res.status, 1, `expected exit 1:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /git repository resolution/);
  });
});

describe('first-party specifiers must use the workspace: protocol', () => {
  /** A throwaway workspace whose manifests the check reads from disk. */
  function workspace(manifests) {
    const root = scratch();
    const projects = [];
    for (const [rel, manifest] of Object.entries(manifests)) {
      const dir = rel === '.' ? root : join(root, rel);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      projects.push({ name: manifest.name, path: dir });
    }
    return projects;
  }

  it('passes when every first-party edge is workspace:*', () => {
    const gate = new Gate('t');
    checkWorkspaceManifests(
      gate,
      workspace({
        '.': { name: 'poker-risk-lab', devDependencies: { typescript: '7.0.2' } },
        'packages/poker-math': { name: '@prl/poker-math' },
        'apps/api': {
          name: '@prl/api',
          dependencies: { '@prl/poker-math': 'workspace:*', fastify: '5.11.3' },
        },
      }),
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('FAILS on `"@prl/poker-math": "1.0.0"` — one character from correct, and dependency confusion', () => {
    // The @prl scope is unclaimed on npm (404) and .npmrc maps it to the PUBLIC
    // registry, so this specifier fetches whatever a stranger has published.
    const gate = new Gate('t');
    checkWorkspaceManifests(
      gate,
      workspace({
        '.': { name: 'poker-risk-lab' },
        'packages/poker-math': { name: '@prl/poker-math' },
        'apps/api': { name: '@prl/api', dependencies: { '@prl/poker-math': '1.0.0' } },
      }),
    );
    assert.match(
      failureText(gate),
      /first-party package @prl\/poker-math declared without the workspace: protocol/,
    );
    assert.match(failureText(gate), /dependency confusion/);
  });

  it('FAILS on a first-party name that is not a workspace project at all', () => {
    // The scope is derived from the workspace, so a name nobody publishes is
    // still caught: `@prl/anything` cannot come from anywhere but the registry.
    const gate = new Gate('t');
    checkWorkspaceManifests(
      gate,
      workspace({
        '.': { name: 'poker-risk-lab' },
        'packages/poker-math': { name: '@prl/poker-math' },
        'apps/api': { name: '@prl/api', dependencies: { '@prl/telemetry': '2.0.0' } },
      }),
    );
    assert.match(
      failureText(gate),
      /first-party package @prl\/telemetry declared without the workspace: protocol/,
    );
  });

  it('still FAILS on a non-exact range for a third-party package', () => {
    const gate = new Gate('t');
    checkWorkspaceManifests(
      gate,
      workspace({ '.': { name: 'poker-risk-lab', dependencies: { fastify: '^5.11.3' } } }),
    );
    assert.match(failureText(gate), /non-exact version range/);
  });
});

describe('the install-hook scan refuses to pass over nothing', () => {
  it('FAILS when the store holds no packages at all', () => {
    const gate = new Gate('t');
    const passed = requireStoreCoverage(
      gate,
      {
        storePresent: false,
        skippedManifestPresent: false,
        resolvedCount: 162,
        installedCount: 0,
        platformSkipped: [],
        uninspected: [],
      },
      'the install-hook scan',
    );
    assert.equal(passed, false);
    assert.match(failureText(gate), /inspected 0 of 162 resolved package versions/);
    assert.match(failureText(gate), /A scan of nothing proves nothing/);
  });

  it('FAILS when versions are missing from disk for no stated reason', () => {
    const gate = new Gate('t');
    requireStoreCoverage(
      gate,
      {
        storePresent: true,
        skippedManifestPresent: true,
        resolvedCount: 3,
        installedCount: 2,
        platformSkipped: [],
        uninspected: ['evil@1.0.0'],
      },
      'the on-disk deny check',
    );
    assert.match(failureText(gate), /could not inspect 1 resolved package version/);
    assert.match(failureText(gate), /evil@1\.0\.0/);
  });

  it('passes, but says so out loud, when the only gap is platform-skipped optionals', () => {
    const gate = new Gate('t');
    const passed = requireStoreCoverage(
      gate,
      {
        storePresent: true,
        skippedManifestPresent: true,
        resolvedCount: 162,
        installedCount: 104,
        platformSkipped: ['@img/sharp-linux-x64@0.35.3'],
        uninspected: [],
      },
      'the install-hook scan',
    );
    assert.equal(passed, true);
    assert.deepEqual(gate.failures, []);
    assert.match(gate.notes.join('\n'), /104\/162/);
    assert.match(gate.notes.join('\n'), /inspected from the registry/);
  });

  it('FAILS on an installed package that declares a postinstall hook', () => {
    // Delivery Pattern A, verbatim from the advisory snapshot §2.
    const gate = new Gate('t');
    const scanned = checkInstalledLifecycleHooks(
      gate,
      new Map([
        [
          'evil@1.0.0',
          {
            manifest: {
              name: 'evil',
              scripts: {
                preinstall: "node -e \"require('child_process').spawnSync('bun',['run','index.js'])\"",
              },
            },
            manifestPath: '/tmp/evil/package.json',
          },
        ],
      ]),
    );
    assert.equal(scanned, 1);
    assert.match(failureText(gate), /install-time lifecycle hook declared by evil@1\.0\.0/);
  });
});
