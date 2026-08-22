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
  listWorkflowFiles,
  parsePinnedReference,
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
    assert.match(failureText(gate), /declared workflow is missing: \.github\/workflows\/supply-chain\.yml/);
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

  it('FAILS on a floating runner label', () => {
    const gate = new Gate('t');
    checkWorkflowPinning(gate, 'ci.yml', 'jobs:\n  a:\n    runs-on: ubuntu-latest\n');
    assert.match(failureText(gate), /floating runner image at ci\.yml:3: ubuntu-latest/);
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
