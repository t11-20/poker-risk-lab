#!/usr/bin/env node
/**
 * Gate: the committed keyless-signing identity policy and the workflow it names agree. The identity
 * is built from the repository, the workflow file name and the ref. Renaming the workflow, adding a
 * `push:` trigger, or granting `id-token: write` at workflow level each breaks it, and none needs a
 * network to detect, so this runs hermetically on every push. `scripts/keyless-identity.test.mjs`
 * drives all three.
 *
 * Exactly one workflow may hold `id-token: write`, the one the policy names. This gate verifies no
 * signature; `image-provenance.mjs` does. The keyless posture is implemented and unexercised.
 *
 * Exit codes: 0 the policy and the workflow agree; 1 anything else, including a refusal to run.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SIGNATURES_PATH } from '../image-signing.mjs';
import {
  expectedCertificateIdentity,
  grantsIdTokenWrite,
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

/** Every workflow granting `id-token: write`, at either scope, so the message can name file and job. */
export function workflowsThatCanMintTokens(files) {
  const found = [];
  for (const { name, text } of files) {
    const structure = parseWorkflowStructure(text);
    // `permissions: write-all` grants id-token without the words, as do flow-mapping and quoted
    // forms. See `permissionsFrom` in keyless-identity.mjs.
    if (grantsIdTokenWrite(structure.topLevelPermissions)) {
      found.push({ name, scope: 'the workflow top level', job: null });
    }
    for (const [job, permissions] of structure.jobs) {
      if (grantsIdTokenWrite(permissions)) found.push({ name, scope: 'job', job });
    }
  }
  return found;
}

export function runKeylessPolicyGate(options) {
  const gate = new Gate('keyless-signing-identity');
  const report = { checkedAt: new Date().toISOString(), policy: null, identity: null, workflows: [] };

  return runGate(gate, () => {
    // `resolve`, not `join`, so an absolute --policy path works. The gate's test passes a temp dir.
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

    const resolved = resolveRepository(policy, process.env);
    if ('problem' in resolved) {
      // Not a failure: `repository: null` is legal with no git remote. Reported every run, because an
      // outsider cannot check a policy with no owner.
      gate.warn(
        'the policy names no repository owner, so the exact identity is not yet pinned',
        `${resolved.problem}\n      Everything else below is checked. What is NOT checked is the ` +
          'owner half of the identity — and THIS gate refuses outright if a committed ' +
          'release-signatures.json is in the keyless posture while it stays null, because an ' +
          'outsider has no environment to resolve it from.\n      `security:image-provenance` only ' +
          'WARNS about the same fallback, so that the signing workflow can verify its own signature ' +
          'on the run that made it. Do not read that warning as a second refusal.',
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

    // A committed keyless record nobody outside this machine can reconstruct. Checked here because
    // the verifier only runs where release images exist.
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
