#!/usr/bin/env node
/**
 * Tests for the keyless-identity gate as a process: the exit code and the sentence a reader gets.
 * The pure decisions are in `scripts/keyless-identity.test.mjs`. Nothing here needs Fulcio, Rekor
 * or a registry.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { KEYLESS_POLICY_PATH } from '../keyless-identity.mjs';
import { EXPECTED_WORKFLOWS } from './denied-packages.mjs';
import { workflowsThatCanMintTokens } from './keyless-provenance.mjs';
import { REPO_ROOT } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'keyless-provenance.mjs');

function runGate(args) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    // Not resolved from the ambient environment, so the result does not depend on running in Actions.
    env: { ...process.env, NO_COLOR: '1', PRL_KEYLESS_REPOSITORY: '', GITHUB_REPOSITORY: '' },
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const scratch = () => mkdtempSync(join(tmpdir(), 'prl-keyless-gate-'));
const policyText = readFileSync(join(REPO_ROOT, KEYLESS_POLICY_PATH), 'utf8');
const withPolicy = (mutate) => {
  const dir = scratch();
  const path = join(dir, 'policy.json');
  const policy = JSON.parse(policyText);
  mutate(policy);
  writeFileSync(path, JSON.stringify(policy, null, 2));
  return path;
};

describe('the gate as committed', () => {
  it('passes against the real policy and the real workflow', () => {
    const { status, out } = runGate([]);
    assert.equal(status, 0, out);
    assert.match(out, /keyless-signing-identity — pass/);
  });

  it('says out loud that no keyless signature exists yet', () => {
    // Until the workflow has run there is no certificate and no Rekor entry, and the gate must say so.
    const { out } = runGate([]);
    assert.match(out, /IMPLEMENTED AND UNEXERCISED/);
  });

  it('reports the unresolved owner as a warning every single run', () => {
    const { out } = runGate([]);
    assert.match(out, /names no repository owner/);
  });

  it('refuses an unknown option instead of ignoring it', () => {
    const { status, out } = runGate(['--polcy', 'x']);
    assert.equal(status, 1);
    assert.match(out, /unknown option/);
  });
});

describe('refusals', () => {
  it('FAILS when there is no policy at all', () => {
    const { status, out } = runGate(['--policy', join(scratch(), 'absent.json')]);
    assert.equal(status, 1);
    assert.match(out, /there is no keyless identity policy/);
  });

  it('FAILS on a policy that is not JSON', () => {
    const dir = scratch();
    const path = join(dir, 'policy.json');
    writeFileSync(path, '{ not json');
    const { status, out } = runGate(['--policy', path]);
    assert.equal(status, 1);
    assert.match(out, /is not valid JSON/);
  });

  it('FAILS on an issuer that is not GitHub', () => {
    const path = withPolicy((policy) => {
      policy.issuer = 'https://token.actions.githubusercontent.com.evil.example';
    });
    const { status, out } = runGate(['--policy', path]);
    assert.equal(status, 1);
    assert.match(out, /The issuer is half the claim/);
  });

  it('FAILS when the policy names a workflow that does not exist', () => {
    const path = withPolicy((policy) => {
      policy.workflow.path = '.github/workflows/release-sign-v2.yml';
    });
    const { status, out } = runGate(['--policy', path]);
    assert.equal(status, 1);
    assert.match(out, /no such workflow exists/);
  });

  it('FAILS when the policy names a job that does not hold the grant', () => {
    const path = withPolicy((policy) => {
      policy.workflow.job = 'publish';
    });
    const { status, out } = runGate(['--policy', path]);
    assert.equal(status, 1);
    assert.match(out, /id-token: write is on job sign|does not declare/);
  });

  it('FAILS on a wildcard ref, which is the widening that costs the most', () => {
    const path = withPolicy((policy) => {
      policy.workflow.ref = 'refs/heads/*';
    });
    const { status, out } = runGate(['--policy', path]);
    assert.equal(status, 1);
    assert.match(out, /Exact identities only|not a\s+refs/);
  });
});

describe('exactly one workflow may mint an OIDC token', () => {
  it('finds precisely one grant across every declared workflow, on the signing job', () => {
    // A grant in ci.yml would be worse than in the signing workflow, because that job installs a
    // dependency graph.
    const files = [...EXPECTED_WORKFLOWS].map((name) => ({
      name,
      text: readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8'),
    }));
    assert.ok(files.length >= 3, 'the sweep must actually read the workflows');
    const minting = workflowsThatCanMintTokens(files);
    assert.deepEqual(minting, [{ name: 'release-sign.yml', scope: 'job', job: 'sign' }]);
  });

  it('sees a grant added to another workflow', () => {
    // A finder that returns one entry proves nothing unless it returns two when there are two.
    const minting = workflowsThatCanMintTokens([
      { name: 'evil.yml', text: 'jobs:\n  build:\n    permissions:\n      id-token: write\n' },
    ]);
    assert.deepEqual(minting, [{ name: 'evil.yml', scope: 'job', job: 'build' }]);
  });

  it('sees a grant at the workflow top level, where a per-job scan would miss it', () => {
    const minting = workflowsThatCanMintTokens([
      { name: 'evil.yml', text: 'permissions:\n  id-token: write\njobs:\n  build:\n    steps: []\n' },
    ]);
    assert.equal(minting[0].scope, 'the workflow top level');
  });

  /**
   * Four spellings the finder once missed, each a real grant (REGRESSION). All four returned `[]`.
   * `write-all` never writes `id-token` and is what somebody reaches for after a permissions error.
   */
  const INVISIBLE_GRANTS = [
    ['write-all at the workflow top level', 'permissions: write-all\njobs:\n  build:\n    steps: []\n'],
    ['write-all on a job', 'jobs:\n  build:\n    permissions: write-all\n    steps: []\n'],
    [
      'a flow mapping on a job',
      'jobs:\n  build:\n    permissions: {contents: read, id-token: write}\n    steps: []\n',
    ],
    ['a quoted key', "jobs:\n  build:\n    permissions:\n      'id-token': write\n    steps: []\n"],
  ];

  for (const [label, text] of INVISIBLE_GRANTS) {
    it(`sees an OIDC grant written as ${label} (REGRESSION)`, () => {
      const minting = workflowsThatCanMintTokens([{ name: 'evil.yml', text }]);
      assert.equal(
        minting.length,
        1,
        `${label} grants id-token: write and this finder reported ${minting.length} grant(s). A ` +
          'workflow that can mint a certificate carrying this repository’s identity must be ' +
          'named whatever spelling it used to ask for the permission.',
      );
      assert.equal(minting[0].name, 'evil.yml');
    });
  }

  it('does not read read-all, or a scope that is not id-token, as a grant (NEGATIVE CONTROL)', () => {
    // A finder that answered yes to everything would fail the repository's own workflows.
    for (const text of [
      'permissions: read-all\njobs:\n  build:\n    steps: []\n',
      'jobs:\n  build:\n    permissions: {contents: read, packages: write}\n    steps: []\n',
      "jobs:\n  build:\n    permissions:\n      id-token: 'read'\n    steps: []\n",
    ]) {
      assert.deepEqual(workflowsThatCanMintTokens([{ name: 'fine.yml', text }]), [], text);
    }
  });
});
