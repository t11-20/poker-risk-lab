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
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  checkComposePinning,
  checkDockerfilePinning,
  checkWorkflowInventory,
  checkWorkflowPinning,
  listWorkflowFiles,
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

  it('passes on every real Dockerfile and compose file', () => {
    const names = readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name);
    let baseImages = 0;
    for (const name of names.filter((n) => /^Dockerfile(\..+)?$/.test(n))) {
      const gate = new Gate('t');
      baseImages += checkDockerfilePinning(gate, name, readFileSync(join(REPO_ROOT, name), 'utf8'));
      assert.deepEqual(gate.failures, [], `${name}:\n${failureText(gate)}`);
    }
    assert.ok(baseImages > 0, 'no external base image was judged — the check found nothing to check');

    for (const name of names.filter((n) => /^docker-compose(\..+)?\.ya?ml$/.test(n))) {
      const gate = new Gate('t');
      const judged = checkComposePinning(gate, name, readFileSync(join(REPO_ROOT, name), 'utf8'));
      assert.deepEqual(gate.failures, [], `${name}:\n${failureText(gate)}`);
      assert.ok(judged > 0, `${name}: no image reference was judged`);
    }
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
