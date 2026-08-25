#!/usr/bin/env node
/**
 * Gate: the committed keyless-signing identity policy and the workflow it names agree.
 *
 * Invoked by `pnpm run security:keyless`, and by `scripts/supply-chain/audit.mjs`.
 *
 * ## Why a gate rather than a comment
 *
 * A keyless signature is only worth something because a verifier demands a specific
 * `--certificate-identity` and `--certificate-oidc-issuer`. That identity is a string built out of
 * three facts — the repository, the workflow FILE NAME, and the ref the workflow ran on — and every
 * one of them can be changed by an ordinary-looking edit:
 *
 *   * rename `.github/workflows/release-sign.yml`, and the identity the policy demands can no
 *     longer be minted by anything. Verification fails closed, which is survivable, but the policy
 *     now points at a file nobody has and reads as though it were still binding something.
 *   * add a `push:` trigger, and the same workflow can run with `github.ref = refs/tags/v1.2.3`.
 *     The policy names one ref; a signature made on another is refused (loud) — and the obvious
 *     "fix" is to widen the policy to a regexp, at which point signatures made from any branch a
 *     contributor can push are accepted (silent).
 *   * grant `id-token: write` at the WORKFLOW level instead of the job, and every job in the file
 *     can mint a certificate carrying this repository's identity — including any that installs
 *     dependencies or runs a third-party action.
 *
 * None of those three needs a network, a registry or a signature to detect, which is why this gate
 * is hermetic and runs on every push alongside the other supply-chain gates. It is also the part of
 * keyless signing that is fully testable on a laptop: `scripts/keyless-identity.test.mjs` drives
 * each of the three above and asserts this refuses.
 *
 * ## The rule about every OTHER workflow
 *
 * `ci.yml` and `release.yml` declare `permissions: contents: read` and no `id-token` anywhere, and
 * their headers say so as a promise. This gate makes it a rule: exactly one workflow file in this
 * repository may hold an `id-token: write` grant, and it is the one the policy names. A signing
 * capability that appears in the test workflow is not a smaller problem than one in the signing
 * workflow — it is a larger one, because that job runs a dependency graph.
 *
 * ## What this gate does NOT do
 *
 * It does not verify a signature, reach Fulcio, or read Rekor. It cannot: no keyless signature
 * exists yet, and nothing on a workstation can produce one — the identity IS the workflow.
 * `scripts/supply-chain/image-provenance.mjs` is where a signature is verified against this policy,
 * and its `--negative-control` demonstrates the identity matching itself, offline, against a
 * certificate minted by a throwaway CA. Until a real run of `release-sign.yml` exists, the keyless
 * posture is IMPLEMENTED AND UNEXERCISED and every document in this repository says so.
 *
 * Usage:
 *     node scripts/supply-chain/keyless-provenance.mjs [--policy <path>] [--json]
 *
 * Exit codes: 0 the policy and the workflow agree; 1 anything else, including a refusal to run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SIGNATURES_PATH } from '../image-signing.mjs';
import {
  expectedCertificateIdentity,
  KEYLESS_POLICY_PATH,
  parseKeylessPolicy,
  parseWorkflowStructure,
  resolveRepository,
  workflowAgreementProblems,
} from '../keyless-identity.mjs';
import { EXPECTED_WORKFLOWS } from './denied-packages.mjs';
import { bold, dim, Gate, green, REPO_ROOT, red, runGate } from './lib.mjs';

const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

export function parseArgs(argv) {
  const options = { policy: KEYLESS_POLICY_PATH, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--policy') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--policy needs a value');
      options.policy = value;
      i += 1;
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }
  return options;
}

/**
 * Every workflow that grants `id-token: write`, at either scope.
 *
 * Returned as a list rather than a boolean because the message has to name the file and the job: an
 * OIDC grant in an unexpected place is not a lint finding, it is a workflow that can sign as this
 * repository, and a reader needs to know which one without going to look.
 */
export function workflowsThatCanMintTokens(files) {
  const found = [];
  for (const { name, text } of files) {
    const structure = parseWorkflowStructure(text);
    if (structure.topLevelPermissions.get('id-token') === 'write') {
      found.push({ name, scope: 'the workflow top level', job: null });
    }
    for (const [job, permissions] of structure.jobs) {
      if (permissions.get('id-token') === 'write') found.push({ name, scope: 'job', job });
    }
  }
  return found;
}

export function runKeylessPolicyGate(options) {
  const gate = new Gate('keyless-signing-identity');
  const report = { checkedAt: new Date().toISOString(), policy: null, identity: null, workflows: [] };

  return runGate(gate, () => {
    // `resolve`, not `join`: an absolute --policy path joined onto the repo root produces a
    // nonsense path inside the repository, and the gate would report "there is no policy" for a file
    // that is plainly there. Measured by the gate's own test, which passes a temp directory.
    const policyPath = resolve(REPO_ROOT, options.policy);
    if (!existsSync(policyPath)) {
      gate.fail(
        `there is no keyless identity policy at ${options.policy}`,
        'This is a refusal and not a skip. The policy is the only thing that says WHICH builder a ' +
          'keyless signature must come from; without it a verifier can assert nothing, and a ' +
          'keyless signature that asserts no identity is a signature by "some GitHub Actions job".',
      );
      return;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(policyPath, 'utf8'));
    } catch (err) {
      gate.fail(`${options.policy} is not valid JSON`, err.message);
      return;
    }
    const { policy, problems } = parseKeylessPolicy(raw);
    for (const problem of problems) gate.fail('the keyless identity policy cannot be trusted', problem);
    if (policy === null) return;
    report.policy = policy;

    // The identity the policy demands, spelled out. A gate that checks a string nobody can read is
    // a gate whose finding nobody can act on.
    const resolved = resolveRepository(policy, process.env);
    if ('problem' in resolved) {
      // NOT a failure: `repository: null` is a legal, documented state for a repository with no git
      // remote, and this gate is hermetic. It IS reported every single run, because a policy whose
      // owner is unknown is a policy an outsider cannot check, and the day that stops being said
      // out loud is the day it stops being true that anybody knows.
      gate.warn(
        'the policy names no repository owner, so the exact identity is not yet pinned',
        `${resolved.problem}\n      Everything else below is checked. What is NOT checked is the ` +
          'owner half of the identity — and `security:image-provenance` refuses a committed keyless ' +
          'signature record while this is the case, because an outsider has no environment to ' +
          'resolve it from.',
      );
      report.identity = expectedCertificateIdentity(policy, '<OWNER>/poker-risk-lab');
    } else {
      report.identity = expectedCertificateIdentity(policy, resolved.repository);
      gate.note(`identity demanded: ${report.identity}  (${resolved.source})`);
    }
    gate.note(`issuer demanded:   ${policy.issuer}`);

    const files = [];
    for (const name of EXPECTED_WORKFLOWS) {
      const full = join(WORKFLOW_DIR, name);
      if (!existsSync(full)) continue;
      files.push({ name, text: readFileSync(full, 'utf8') });
    }
    if (files.length === 0) {
      gate.fail(
        'no workflow files were read',
        'the gate examined nothing and would otherwise report a pass for having found nothing to ' +
          'check. A sweep of nothing is not a pass.',
      );
      return;
    }
    report.workflows = files.map((file) => file.name);

    const expectedFile = policy.workflow.path.split('/').pop();
    const signing = files.find((file) => file.name === expectedFile) ?? null;
    for (const problem of workflowAgreementProblems(policy, {
      filename: signing?.name ?? null,
      text: signing?.text ?? null,
      declared: EXPECTED_WORKFLOWS,
    })) {
      gate.fail('the policy and the signing workflow do not agree', problem);
    }

    // Exactly one workflow may hold an OIDC grant, and it is the one the policy names.
    const minting = workflowsThatCanMintTokens(files);
    for (const entry of minting) {
      if (entry.name === expectedFile && entry.job === policy.workflow.job) continue;
      gate.fail(
        `id-token: write appears in ${entry.name}${entry.job === null ? '' : ` (job ${entry.job})`}`,
        `Only ${expectedFile}'s ${policy.workflow.job} job may mint an OIDC token. Anywhere else ` +
          "means another workflow can obtain a certificate carrying this repository's identity — " +
          'and in a job that installs a dependency graph, that is a signing credential handed to ' +
          'whatever the graph contains. This is exactly the promise the ci.yml header makes in ' +
          'prose; here it is a rule.',
      );
    }
    if (minting.length > 0) {
      gate.note(
        `${minting.length} OIDC grant(s) in ${files.length} workflow(s), all of them ${expectedFile}` +
          `'s ${policy.workflow.job} job`,
      );
    }

    // The dangerous state: a committed keyless record whose identity nobody outside this machine
    // can reconstruct. Checked here, statically, rather than only at verification time, because
    // this gate runs on every push and the verifier only runs where release images exist.
    const signaturesPath = resolve(REPO_ROOT, SIGNATURES_PATH);
    if (existsSync(signaturesPath) && policy.repository === null) {
      let record = null;
      try {
        record = JSON.parse(readFileSync(signaturesPath, 'utf8'));
      } catch {
        record = null;
      }
      if (record?.keyless != null) {
        gate.fail(
          `${SIGNATURES_PATH} records a KEYLESS signature and the policy names no repository owner`,
          'The committed record would then be verifiable only on a machine whose environment ' +
            'happens to resolve the owner. Commit the owner in ' +
            `${KEYLESS_POLICY_PATH} in the same change as the record.`,
        );
      }
    }

    gate.note(
      `${files.length} declared workflow(s) read; the signing workflow is ${expectedFile}, job ` +
        `${policy.workflow.job}`,
    );
  }).then((code) => {
    if (options.json) console.log(JSON.stringify(report, null, 2));
    console.log(
      dim(
        '\n  What this proves: the identity a verifier will demand is the identity the signing\n' +
          '  workflow can actually mint, and no other workflow can mint one at all.\n' +
          '  What it does NOT prove: that any keyless signature exists. None does — the first run\n' +
          '  of .github/workflows/release-sign.yml is what produces a Fulcio certificate and a\n' +
          '  Rekor entry, and it has never run. IMPLEMENTED AND UNEXERCISED.\n',
      ),
    );
    return code;
  });
}

if (import.meta.main) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`security:keyless — ${err.message}`));
    process.exit(1);
  }
  const code = await runKeylessPolicyGate(options);
  console.log(code === 0 ? green(bold('PASS')) : red(bold('FAIL')));
  console.log(dim(`  scripts/supply-chain/keyless-provenance.mjs exit ${code}\n`));
}
