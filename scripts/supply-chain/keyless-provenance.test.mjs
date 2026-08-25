#!/usr/bin/env node
/**
 * Tests for the keyless-identity GATE: the states in which it must refuse to run at all.
 *
 * Run with:  node --test scripts/supply-chain/keyless-provenance.test.mjs
 *
 * ## The split, which mirrors the one next door
 *
 * The pure decisions — the policy shape, identity matching, the certificate parse, and every
 * mutation of the real signing workflow — are in `scripts/keyless-identity.test.mjs`, which needs
 * nothing but Node and covers eleven ways the policy and the workflow can stop agreeing. This file
 * covers the gate as a PROCESS: the exit code, and the sentence a reader gets. That is the same
 * split `image-provenance.test.mjs` and `image-signing.test.mjs` use, for the same reason — a gate
 * that computes the right answer and exits 0 anyway is a gate that has never stopped a release.
 *
 * ## What is deliberately not here
 *
 * Anything needing Fulcio or Rekor. The identity in a keyless signature IS a GitHub Actions job, so
 * no test on a workstation can produce a real certificate, and the keyless posture stays
 * IMPLEMENTED AND UNEXERCISED until the workflow runs. The nearest thing that CAN be demonstrated
 * offline — cosign refusing a certificate whose identity or issuer is not the one demanded — is
 * `node scripts/supply-chain/image-provenance.mjs --negative-control`, which mints a throwaway CA
 * and needs a running registry, so it is not run from a unit test either.
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
    // The owner is deliberately NOT resolved from the ambient environment here: a test whose
    // outcome depends on whether it happens to be running inside Actions is a test that reports
    // different things on two machines.
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
    // The claim this repository must not make by omission. Until the workflow has run there is no
    // Fulcio certificate and no Rekor entry, and a gate that printed only "pass" would be read as
    // saying otherwise.
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
    // Not a skip. Without the policy the only available verification is "some Fulcio certificate
    // signed this", which accepts anybody's GitHub Actions job.
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
    // The rename, seen from the policy's side: the identity it demands can then never be minted by
    // anything, and a policy pointing at a file nobody has still reads as though it binds something.
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
    // The promise ci.yml and release.yml make in prose, read off the files. A grant in the test
    // workflow would be worse than one in the signing workflow: that job installs a dependency
    // graph, so the credential would be one compromised package away from being usable.
    const files = [...EXPECTED_WORKFLOWS].map((name) => ({
      name,
      text: readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8'),
    }));
    assert.ok(files.length >= 4, 'the sweep must actually read the workflows');
    const minting = workflowsThatCanMintTokens(files);
    assert.deepEqual(minting, [{ name: 'release-sign.yml', scope: 'job', job: 'sign' }]);
  });

  it('sees a grant added to another workflow', () => {
    // The negative control for the finder itself: a sweep that returns one entry proves nothing
    // unless it would return two when there are two.
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
   * The four spellings this finder could not see, each one a real grant (REGRESSION).
   *
   * Found by an adversarial review. The two tests above use the block-mapping form, which is the
   * form this repository's own workflows happen to use — so the rule "exactly one workflow may hold
   * `id-token: write`" was enforced against one spelling and blind to every other. Measured against
   * the code as it stood: all four cases below returned `[]`, and `security:keyless` reported a pass
   * over a workflow that could mint a certificate carrying this repository's identity.
   *
   * `write-all` is the one that matters most. It is GitHub's documented shorthand for *every* scope,
   * it is what somebody reaches for when a job fails with a permissions error, and it never writes
   * the words `id-token` anywhere — so it is simultaneously the most likely edit and the one a
   * substring search would never catch.
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
    // The other direction. A finder that answered "yes" to everything would pass all four cases
    // above and would fail the repository's own workflows, which is a gate nobody can keep green.
    for (const text of [
      'permissions: read-all\njobs:\n  build:\n    steps: []\n',
      'jobs:\n  build:\n    permissions: {contents: read, packages: write}\n    steps: []\n',
      "jobs:\n  build:\n    permissions:\n      id-token: 'read'\n    steps: []\n",
    ]) {
      assert.deepEqual(workflowsThatCanMintTokens([{ name: 'fine.yml', text }]), [], text);
    }
  });
});
