#!/usr/bin/env node
/**
 * Tests for the keyless signing identity: the policy, the certificate parse, and the agreement
 * between the committed policy and the real signing workflow. Each agreement test mutates the real
 * workflow. cosign's identity matching is shown by `image-provenance.mjs --negative-control`.
 * The Fulcio exchange and the Rekor entry cannot be tested off a GitHub Actions job.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSignatureRecord, SIGNATURES_SCHEMA } from './image-signing.mjs';
import {
  bundleCertificate,
  certificateIdentity,
  expectedCertificateIdentity,
  GITHUB_OIDC_ISSUER,
  identityProblems,
  KEYLESS_POLICY_SCHEMA,
  keylessPreflight,
  parseKeylessPolicy,
  parseWorkflowStructure,
  resolveRepository,
  workflowAgreementProblems,
} from './keyless-identity.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = JSON.parse(readFileSync(join(REPO_ROOT, 'deploy/signing/keyless-policy.json'), 'utf8'));
const WORKFLOW_TEXT = readFileSync(join(REPO_ROOT, '.github/workflows/release-sign.yml'), 'utf8');
const DECLARED = ['ci.yml', 'release.yml', 'release-sign.yml'];

const goodPolicy = () => JSON.parse(JSON.stringify(POLICY));
const parsed = () => {
  const { policy, problems } = parseKeylessPolicy(goodPolicy());
  assert.deepEqual(problems, [], 'the committed policy must parse');
  return policy;
};
const agree = (policy, text = WORKFLOW_TEXT, filename = 'release-sign.yml') =>
  workflowAgreementProblems(policy, { filename, text, declared: DECLARED });

describe('the committed policy', () => {
  it('parses, and demands GitHub as the issuer', () => {
    const policy = parsed();
    assert.equal(policy.issuer, GITHUB_OIDC_ISSUER);
    assert.equal(policy.workflow.path, '.github/workflows/release-sign.yml');
    assert.equal(policy.transparencyLog.required, true);
  });

  it('builds the identity GitHub would actually mint', () => {
    // A wrong SAN format gives a policy that accepts nothing and looks fine.
    assert.equal(
      expectedCertificateIdentity(parsed(), 'example-org/poker-risk-lab'),
      'https://github.com/example-org/poker-risk-lab/.github/workflows/release-sign.yml@refs/heads/main',
    );
  });

  it('REFUSES an issuer that is not GitHub', () => {
    const raw = goodPolicy();
    raw.issuer = 'https://gitlab.example.com';
    const { policy, problems } = parseKeylessPolicy(raw);
    assert.equal(policy, null);
    assert.ok(problems.some((p) => /issuer is/.test(p)));
  });

  it('REFUSES a wildcard in the ref — the widening that costs the most and shows the least', () => {
    const raw = goodPolicy();
    raw.workflow.ref = 'refs/heads/*';
    const { policy, problems } = parseKeylessPolicy(raw);
    assert.equal(policy, null);
    assert.ok(problems.some((p) => /not a\s+refs\/heads/.test(p.replace(/\s+/g, ' '))));
  });

  it('REFUSES a workflow path outside .github/workflows', () => {
    const raw = goodPolicy();
    raw.workflow.path = 'scripts/sign.yml';
    assert.equal(parseKeylessPolicy(raw).policy, null);
  });

  it('REFUSES a policy that does not require a transparency log', () => {
    const raw = goodPolicy();
    raw.transparencyLog.required = false;
    const { problems } = parseKeylessPolicy(raw);
    assert.ok(problems.some((p) => /transparency log/.test(p)));
  });

  it('REFUSES a repository that is neither null nor an owner/name slug', () => {
    const raw = goodPolicy();
    raw.repository = 'OWNER';
    assert.equal(parseKeylessPolicy(raw).policy, null);
  });
});

describe('resolving the owner, which this repository does not yet have', () => {
  it('says so rather than inventing one', () => {
    const resolved = resolveRepository(parsed(), {});
    assert.ok('problem' in resolved);
    assert.match(resolved.problem, /no git remote/);
  });

  it('takes it from GITHUB_REPOSITORY inside Actions, and names the source', () => {
    const resolved = resolveRepository(parsed(), { GITHUB_REPOSITORY: 'example-org/poker-risk-lab' });
    assert.equal(resolved.repository, 'example-org/poker-risk-lab');
    assert.match(resolved.source, /GITHUB_REPOSITORY/);
  });

  it('REFUSES an environment that names a DIFFERENT repository', () => {
    // Without this bound an ambient variable would decide whose signature is acceptable.
    const resolved = resolveRepository(parsed(), { GITHUB_REPOSITORY: 'attacker-org/something-else' });
    assert.ok('problem' in resolved);
    assert.match(resolved.problem, /not a repository called poker-risk-lab/);
  });

  it('prefers the committed owner over the environment once one exists', () => {
    const raw = goodPolicy();
    raw.repository = 'example-org/poker-risk-lab';
    const { policy } = parseKeylessPolicy(raw);
    const resolved = resolveRepository(policy, { GITHUB_REPOSITORY: 'someone-else/poker-risk-lab' });
    assert.equal(resolved.repository, 'example-org/poker-risk-lab');
    assert.match(resolved.source, /committed policy/);
  });
});

describe('identity matching — the check that turns arithmetic into provenance', () => {
  const policy = parsed();
  const repository = 'example-org/poker-risk-lab';
  const good = {
    identity: expectedCertificateIdentity(policy, repository),
    issuer: GITHUB_OIDC_ISSUER,
  };

  it('accepts the identity the policy names', () => {
    assert.deepEqual(identityProblems(good, policy, repository), []);
  });

  it("REJECTS the same workflow in somebody else's repository", () => {
    // Fulcio certifies any GitHub Actions job, so a fork's signature is cryptographically valid.
    const other = { ...good, identity: expectedCertificateIdentity(policy, 'attacker-org/poker-risk-lab') };
    const problems = identityProblems(other, policy, repository);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /certificate identity/);
    assert.match(problems[0], /attacker-org/);
  });

  it('REJECTS another workflow file in the same repository', () => {
    const other = { ...good, identity: good.identity.replace('release-sign.yml', 'ci.yml') };
    assert.equal(identityProblems(other, policy, repository).length, 1);
  });

  it('REJECTS another ref', () => {
    const other = { ...good, identity: good.identity.replace('refs/heads/main', 'refs/heads/attacker') };
    assert.equal(identityProblems(other, policy, repository).length, 1);
  });

  it('REJECTS a wrong ISSUER even when the identity is right', () => {
    // The issuer is what makes the SAN GitHub's statement.
    const other = { ...good, issuer: 'https://token.actions.githubusercontent.com.evil.example' };
    const problems = identityProblems(other, policy, repository);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /certificate issuer/);
  });

  it('REJECTS a signature that carries no identity at all', () => {
    assert.equal(identityProblems({}, policy, repository).length, 2);
  });
});

describe('the policy and the signing workflow must agree', () => {
  it('agrees with the workflow as committed', () => {
    assert.deepEqual(agree(parsed()), []);
  });

  it('FAILS when the workflow is RENAMED and the policy is not', () => {
    // A rename must fail rather than widen what is accepted.
    const problems = agree(parsed(), WORKFLOW_TEXT, 'release-sign-v2.yml');
    assert.ok(problems.some((p) => /must be the same string/.test(p)));
  });

  it('FAILS when the workflow is missing entirely', () => {
    const problems = workflowAgreementProblems(parsed(), {
      filename: null,
      text: null,
      declared: DECLARED,
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no such workflow exists/);
  });

  it('FAILS when the workflow is not declared in EXPECTED_WORKFLOWS', () => {
    const problems = workflowAgreementProblems(parsed(), {
      filename: 'release-sign.yml',
      text: WORKFLOW_TEXT,
      declared: ['ci.yml', 'release.yml'],
    });
    assert.ok(problems.some((p) => /EXPECTED_WORKFLOWS/.test(p)));
  });

  it('FAILS when the trigger changes so the workflow can run on ANOTHER REF', () => {
    // `workflow_run` always runs the default branch's copy, which is the only reason an exact
    // identity is expressible. A tag push produces `refs/tags/v…`, which the policy does not name:
    // signatures made there are refused, and the tempting fix is to widen the policy to a regexp.
    const text = WORKFLOW_TEXT.replace(
      "  workflow_run:\n    workflows: ['Release']\n    types: [completed]",
      "  push:\n    tags:\n      - 'v*'",
    );
    assert.notEqual(text, WORKFLOW_TEXT, 'the trigger mutation must actually apply');
    const problems = agree(parsed(), text);
    assert.ok(problems.some((p) => /can run on another ref|tag push/.test(p)));
  });

  it('FAILS when the trigger block cannot be read at all, rather than assuming a ref', () => {
    // `[].every(…)` is true, so an unreadable `on:` block would otherwise pass.
    const text = WORKFLOW_TEXT.replace(
      "on:\n  # Follows a completed `Release` run. Never `push`, `pull_request` or\n  # `pull_request_target`: a workflow that can mint a signing identity must never\n  # run on a ref a contributor controls.\n  workflow_run:\n    workflows: ['Release']\n    types: [completed]",
      'on:',
    );
    const problems = agree(parsed(), text);
    assert.ok(problems.some((p) => /declares no trigger this gate could read/.test(p)));
  });

  it('FAILS on a pull_request_target trigger', () => {
    const text = WORKFLOW_TEXT.replace('  workflow_run:', '  pull_request_target:\n  workflow_run:');
    const problems = agree(parsed(), text);
    assert.ok(problems.some((p) => /pull_request_target/.test(p)));
  });

  it('FAILS when id-token: write moves to the WORKFLOW TOP LEVEL', () => {
    // A grep passes this mutation, because the string is present either way.
    const text = WORKFLOW_TEXT.replace(
      'permissions:\n  contents: read',
      'permissions:\n  contents: read\n  id-token: write',
    );
    assert.notEqual(text, WORKFLOW_TEXT);
    const problems = agree(parsed(), text);
    assert.ok(problems.some((p) => /WORKFLOW top level/.test(p)));
  });

  it('FAILS when a SECOND job is granted id-token: write', () => {
    const text = `${WORKFLOW_TEXT}\n  helper:\n    runs-on: ubuntu-24.04\n    permissions:\n      id-token: write\n    steps:\n      - run: echo hello\n`;
    const problems = agree(parsed(), text);
    assert.ok(problems.some((p) => /2 jobs .* declare id-token: write/.test(p)));
  });

  it('FAILS when the signing job LOSES the grant', () => {
    const text = WORKFLOW_TEXT.replace('      id-token: write', '      # id-token: write');
    const problems = agree(parsed(), text);
    assert.ok(problems.some((p) => /no job in .* declares id-token: write/.test(p)));
  });

  it('FAILS when the policy names a job the workflow does not have', () => {
    const policy = parsed();
    policy.workflow.job = 'publish';
    const problems = agree(policy);
    assert.ok(problems.some((p) => /which release-sign\.yml does not declare/.test(p)));
  });

  it('FAILS when the workflow stops referring to the committed policy', () => {
    const text = WORKFLOW_TEXT.replaceAll('deploy/signing/keyless-policy.json', 'some/other/policy.json');
    const problems = agree(parsed(), text);
    assert.ok(problems.some((p) => /never mentions/.test(p)));
  });
});

describe('parsing a workflow, which is where a silent pass would come from', () => {
  it('reads the real workflow into exactly one OIDC grant, on the sign job', () => {
    const structure = parseWorkflowStructure(WORKFLOW_TEXT);
    assert.deepEqual(structure.triggers, ['workflow_run']);
    assert.equal(structure.topLevelPermissions.get('contents'), 'read');
    assert.equal(structure.topLevelPermissions.has('id-token'), false);
    assert.equal(structure.jobs.get('sign')?.get('id-token'), 'write');
  });

  it('reads ci.yml and release.yml as granting no id-token anywhere', () => {
    // A signing grant in the test workflow would be worse, because that job installs a dependency graph.
    for (const name of ['ci.yml', 'release.yml']) {
      const text = readFileSync(join(REPO_ROOT, '.github/workflows', name), 'utf8');
      const structure = parseWorkflowStructure(text);
      assert.equal(structure.topLevelPermissions.get('id-token'), undefined, name);
      for (const [job, permissions] of structure.jobs) {
        assert.equal(permissions.get('id-token'), undefined, `${name}:${job}`);
      }
    }
  });
});

describe('reading the identity back out of a real certificate', () => {
  // Minted with openssl so the parse runs on bytes a real X.509 tool produced.
  const scratch = mkdtempSync(join(tmpdir(), 'prl-keyless-cert-'));
  after(() => rmSync(scratch, { recursive: true, force: true }));

  const openssl = (args, cwd = scratch) => spawnSync('openssl', args, { cwd, encoding: 'utf8' });
  const available = openssl(['version']).status === 0;

  const mint = (identity, issuer, name) => {
    writeFileSync(
      join(scratch, `${name}.cnf`),
      '[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n' +
        'subjectAltName=critical,@san\n' +
        `1.3.6.1.4.1.57264.1.8=ASN1:UTF8String:${issuer}\n\n[san]\nURI.1=${identity}\n`,
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`]);
    const made = openssl([
      'req',
      '-x509',
      '-new',
      '-key',
      `${name}.key`,
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/O=prl-test',
      '-extensions',
      'leaf',
      '-config',
      `${name}.cnf`,
      '-out',
      `${name}.pem`,
    ]);
    assert.equal(made.status, 0, made.stderr);
    return readFileSync(join(scratch, `${name}.pem`));
  };

  it('reads the SAN URI and the Fulcio issuer extension', {
    skip: !available && 'openssl is not on PATH',
  }, () => {
    const identity =
      'https://github.com/example-org/poker-risk-lab/.github/workflows/release-sign.yml@refs/heads/main';
    const read = certificateIdentity(mint(identity, GITHUB_OIDC_ISSUER, 'good'));
    assert.deepEqual(read, { identity, issuer: GITHUB_OIDC_ISSUER });
  });

  it('reads a certificate for ANOTHER workflow as that other workflow, and the policy then refuses it', {
    skip: !available && 'openssl is not on PATH',
  }, () => {
    const identity =
      'https://github.com/attacker-org/poker-risk-lab/.github/workflows/release-sign.yml@refs/heads/main';
    const read = certificateIdentity(mint(identity, GITHUB_OIDC_ISSUER, 'other'));
    assert.equal(read.identity, identity);
    const problems = identityProblems(read, parsed(), 'example-org/poker-risk-lab');
    assert.equal(problems.length, 1);
  });

  it('REFUSES a certificate carrying no Fulcio issuer extension', {
    skip: !available && 'openssl is not on PATH',
  }, () => {
    writeFileSync(
      join(scratch, 'bare.cnf'),
      '[leaf]\nbasicConstraints=critical,CA:FALSE\nsubjectAltName=critical,@san\n\n' +
        '[san]\nURI.1=https://github.com/example-org/poker-risk-lab/.github/workflows/release-sign.yml@refs/heads/main\n',
    );
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'bare.key']);
    openssl([
      'req',
      '-x509',
      '-new',
      '-key',
      'bare.key',
      '-sha256',
      '-days',
      '1',
      '-subj',
      '/O=prl-test',
      '-extensions',
      'leaf',
      '-config',
      'bare.cnf',
      '-out',
      'bare.pem',
    ]);
    const read = certificateIdentity(readFileSync(join(scratch, 'bare.pem')));
    assert.ok('problem' in read);
    assert.match(read.problem, /no Fulcio OIDC-issuer extension/);
  });

  it('refuses bytes that are not a certificate at all', () => {
    const read = certificateIdentity(Buffer.from('not a certificate'));
    assert.ok('problem' in read);
  });

  it('reports a bundle with no certificate as the KEY posture rather than as an error', () => {
    const read = bundleCertificate({ verificationMaterial: { publicKey: { hint: 'x' } } });
    assert.ok('problem' in read);
    assert.match(read.problem, /KEY-posture signature/);
  });
});

describe('the two postures cannot be confused', () => {
  const image = {
    service: 'api',
    repository: 'prl-api',
    buildDigest: `sha256:${'a'.repeat(64)}`,
    registryDigest: `sha256:${'a'.repeat(64)}`,
    reference: `127.0.0.1:5001/prl-api@sha256:${'a'.repeat(64)}`,
    signed: true,
  };
  const base = { schema: SIGNATURES_SCHEMA, registry: '127.0.0.1:5001', images: { api: image } };

  it('reads a keyless record as keyless, and keeps the identity for the gate to judge', () => {
    const { meta, problems } = parseSignatureRecord({
      ...base,
      keyless: {
        identity: 'https://github.com/x/y/.github/workflows/release-sign.yml@refs/heads/main',
        issuer: GITHUB_OIDC_ISSUER,
      },
      transparencyLog: { used: true },
    });
    assert.deepEqual(problems, []);
    assert.equal(meta.posture, 'keyless');
    assert.equal(meta.keyless.issuer, GITHUB_OIDC_ISSUER);
  });

  it('REFUSES a record in NEITHER posture — which is what unsigned looks like', () => {
    // "Unsigned" must never read as "the other posture".
    const { problems, meta } = parseSignatureRecord(base);
    assert.equal(meta.posture, null);
    assert.ok(problems.some((p) => /names no signing posture/.test(p)));
  });

  it('REFUSES a record claiming BOTH', () => {
    const { problems } = parseSignatureRecord({
      ...base,
      publicKey: { fingerprint: 'f'.repeat(64) },
      keyless: { identity: 'x', issuer: 'y' },
    });
    assert.ok(problems.some((p) => /BOTH a public key and a keyless identity/.test(p)));
  });

  it('REFUSES a keyless record whose label and contents disagree', () => {
    const { problems } = parseSignatureRecord({
      ...base,
      posture: 'key',
      keyless: { identity: 'x', issuer: 'y' },
      transparencyLog: { used: true },
    });
    assert.ok(problems.some((p) => /the label is the part a human reads/.test(p)));
  });

  it('REFUSES a keyless record that claims no transparency-log entry', () => {
    const { problems } = parseSignatureRecord({
      ...base,
      keyless: { identity: 'x', issuer: 'y' },
      transparencyLog: { used: false },
    });
    assert.ok(problems.some((p) => /transparency-log entry/.test(p)));
  });
});

describe('the keyless signer refuses where it cannot possibly work', () => {
  it('refuses outside GitHub Actions', () => {
    const problems = keylessPreflight({});
    assert.equal(problems.length, 2);
    assert.match(problems[0], /outside GitHub Actions/);
  });

  it('refuses in an Actions job without id-token: write', () => {
    // Without the request variables cosign would open an interactive OAuth flow and hang.
    const problems = keylessPreflight({ GITHUB_ACTIONS: 'true' });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /ACTIONS_ID_TOKEN_REQUEST_URL/);
  });

  it('is satisfied by a job that holds the grant', () => {
    assert.deepEqual(
      keylessPreflight({
        GITHUB_ACTIONS: 'true',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'not-a-real-token',
      }),
      [],
    );
  });
});

describe('the policy schema is checked before the shape is trusted', () => {
  it('refuses an unknown schema rather than guessing', () => {
    const raw = goodPolicy();
    raw.schema = 'prl.keyless-identity-policy.v99';
    const { policy, problems } = parseKeylessPolicy(raw);
    assert.equal(policy, null);
    assert.match(problems[0], new RegExp(KEYLESS_POLICY_SCHEMA.replace(/\./g, '\\.')));
  });

  it('refuses a policy that is not an object', () => {
    assert.equal(parseKeylessPolicy(null).policy, null);
    assert.equal(parseKeylessPolicy([]).policy, null);
  });
});

// What may be signed. A `workflow_dispatch` rehearsal of release.yml (`dry_run: true` by default)
// concludes successfully, so the signer used to sign rehearsal images. The `if:` allows only a `push`
// run (a `v*` tag), and the job checks `release-promotable.json`, which only `promote` writes.
describe('a rehearsal must not be signed', () => {
  const RELEASE_TEXT = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');

  const signCondition = (text) => /\n {4}if:\s*(.+)\n/u.exec(text)?.[1] ?? '';

  it('signing requires BOTH a successful conclusion and a tag push (REGRESSION)', () => {
    const condition = signCondition(WORKFLOW_TEXT);
    assert.match(condition, /workflow_run\.conclusion == 'success'/u, 'a failed release could be signed');
    assert.match(
      condition,
      /workflow_run\.event == 'push'/u,
      'the signing job no longer requires a push, so a `workflow_dispatch` rehearsal — whose ' +
        'default is `dry_run: true` — concludes success and gets its branch images pushed to GHCR ' +
        "and signed under this repository's identity",
    );
    // In a folded scalar a more-indented continuation keeps its newline, which GitHub reads as a break.
    assert.ok(!condition.includes('\n'), 'the condition spans lines; fold it or GitHub sees a break');
  });

  it('signing consumes a promotion attestation from the triggering run', () => {
    assert.match(WORKFLOW_TEXT, /name: release-promotable/u, 'the attestation is no longer downloaded');
    assert.match(
      WORKFLOW_TEXT,
      /promotable !== true/u,
      'the attestation is downloaded and not CHECKED, which is a file nobody reads',
    );
    assert.match(
      WORKFLOW_TEXT,
      /attestation\.sha !== triggered/u,
      "a promotion of a DIFFERENT commit would satisfy the check; the artefact must name this run's sha",
    );
  });

  it('the promote job is the only thing that writes the attestation (REGRESSION)', () => {
    assert.match(RELEASE_TEXT, /name: release-promotable/u, 'release.yml no longer uploads it');
    assert.match(
      RELEASE_TEXT,
      /if-no-files-found: error/u,
      'an absent attestation must fail where it is produced, not silently at the signer',
    );
    // The artefact means nothing if the job writing it can run for a rehearsal.
    assert.match(
      RELEASE_TEXT,
      /if: \$\{\{ github\.event_name == 'push' \|\| inputs\.dry_run == false \}\}/u,
      'the `promote` job is no longer gated on a real release, so its attestation proves nothing',
    );
  });

  it('NEGATIVE CONTROL — dropping either guard is caught', () => {
    const withoutPush = WORKFLOW_TEXT.replace(" && github.event.workflow_run.event == 'push'", '');
    assert.notEqual(withoutPush, WORKFLOW_TEXT, 'the clause moved; this control is stale');
    assert.doesNotMatch(signCondition(withoutPush), /workflow_run\.event == 'push'/u);

    const withoutCheck = WORKFLOW_TEXT.replace('promotable !== true', 'promotable !== undefined');
    assert.notEqual(withoutCheck, WORKFLOW_TEXT, 'the attestation check moved; this control is stale');
    assert.doesNotMatch(withoutCheck, /promotable !== true/u);

    const withoutUpload = RELEASE_TEXT.replace('name: release-promotable', 'name: something-else');
    assert.doesNotMatch(withoutUpload, /name: release-promotable/u);
  });
});
