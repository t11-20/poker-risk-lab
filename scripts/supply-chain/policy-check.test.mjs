#!/usr/bin/env node
/**
 * Tests for the `policy-in-effect` supply-chain gate.
 *
 * Run with:  node --test scripts/supply-chain/policy-check.test.mjs
 *
 * The gate had a defect that only manifested through its documented entry point:
 * `pnpm run security:policy` failed 100% of the time while `node
 * scripts/supply-chain/policy-check.mjs` passed, because pnpm injects
 * `pnpm_config_verify_deps_before_run=false` into the environment of every script
 * it spawns and the gate read that as the repository's policy. Every check the
 * project had invoked the gate the way that happened to work.
 *
 * So the discrimination these tests exist to make is:
 *
 *   - the verdict must be identical through `pnpm run` and through `node`; and
 *   - the gate must still FAIL when a policy is genuinely absent or genuinely
 *     overridden, so "stop asserting" can never be mistaken for a fix.
 *
 * The negative cases that need a mutated workspace run against a throwaway copy of
 * the gate in a temp directory: `REPO_ROOT` is derived from the script's own
 * location, so a copied gate audits the copy and the real repository is never
 * touched.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const GATE = join(HERE, 'policy-check.mjs');

/**
 * A bare environment: no pnpm/npm variables at all, so a test controls exactly
 * what the gate sees. PATH and HOME are kept because pnpm needs them.
 */
function bareEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm|pnpm|NPM|PNPM)_/.test(key)) continue;
    env[key] = value;
  }
  env['NO_COLOR'] = '1';
  return { ...env, ...extra };
}

/** The variables pnpm 11 puts on a `pnpm run` child, reproduced exactly. */
const PNPM_RUN_ENV = {
  npm_command: 'run-script',
  npm_config_user_agent: 'pnpm/11.10.0 npm/? node/v24.18.0 darwin arm64',
  npm_lifecycle_event: 'security:policy',
  pnpm_config_verify_deps_before_run: 'false',
  PNPM_PACKAGE_NAME: 'poker-risk-lab',
};

function runGate({ cwd = REPO_ROOT, gate = GATE, env = bareEnv() } = {}) {
  const res = spawnSync(process.execPath, [gate], { cwd, env, encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

/**
 * A minimal standalone workspace containing a copy of the gate, so a test can
 * mutate `pnpm-workspace.yaml` / `.npmrc` without touching the real repository.
 */
const sandboxes = [];
function sandbox({ workspaceYaml, npmrc } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'prl-policy-gate-'));
  sandboxes.push(root);
  cpSync(join(REPO_ROOT, 'scripts', 'supply-chain'), join(root, 'scripts', 'supply-chain'), {
    recursive: true,
  });
  cpSync(join(REPO_ROOT, 'package.json'), join(root, 'package.json'));
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    workspaceYaml ?? readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8'),
  );
  writeFileSync(join(root, '.npmrc'), npmrc ?? readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8'));
  return { root, gate: join(root, 'scripts', 'supply-chain', 'policy-check.mjs') };
}

after(() => {
  for (const root of sandboxes) rmSync(root, { recursive: true, force: true });
});

describe('policy-in-effect gate', () => {
  it('passes through `pnpm run security:policy` — the documented entry point', () => {
    const res = spawnSync('pnpm', ['run', 'security:policy'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    assert.equal(res.status, 0, `expected exit 0, got ${res.status}:\n${res.stdout}${res.stderr}`);
  });

  it('reaches the same verdict from a bare environment and from inside a pnpm-run child', () => {
    const bare = runGate({ env: bareEnv() });
    const wrapped = runGate({ env: bareEnv(PNPM_RUN_ENV) });
    assert.equal(bare.status, 0, `bare run failed:\n${bare.out}`);
    assert.equal(
      wrapped.status,
      bare.status,
      `pnpm-wrapped run disagreed with the bare run:\n${wrapped.out}`,
    );
    // And it must say so, rather than silently swallowing the variable.
    assert.match(wrapped.out, /re-entrancy suppression: pnpm_config_verify_deps_before_run/);
  });

  it('still fails when verifyDepsBeforeRun is genuinely overridden outside a pnpm child', () => {
    const res = runGate({ env: bareEnv({ pnpm_config_verify_deps_before_run: 'false' }) });
    assert.equal(res.status, 1, `expected the override to be caught:\n${res.out}`);
    assert.match(res.out, /policy setting not in effect: verifyDepsBeforeRun/);
    assert.match(res.out, /comes from the environment variable pnpm_config_verify_deps_before_run/);
  });

  it('still fails when other policy settings are overridden through the environment', () => {
    const res = runGate({
      env: bareEnv({
        ...PNPM_RUN_ENV,
        pnpm_config_ignore_scripts: 'false',
        pnpm_config_minimum_release_age: '0',
        pnpm_config_verify_store_integrity: 'false',
      }),
    });
    assert.equal(res.status, 1, `expected the overrides to be caught:\n${res.out}`);
    for (const key of ['ignoreScripts', 'minimumReleaseAge', 'verifyStoreIntegrity']) {
      assert.match(res.out, new RegExp(`policy setting not in effect: ${key}`));
    }
  });

  it('fails when a policy key is deleted from pnpm-workspace.yaml', () => {
    const original = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
    const withoutKey = original
      .split('\n')
      .filter((line) => !line.startsWith('verifyDepsBeforeRun:'))
      .join('\n');
    assert.notEqual(withoutKey, original, 'fixture is stale: no top-level verifyDepsBeforeRun line');
    const { root, gate } = sandbox({ workspaceYaml: withoutKey });
    const res = runGate({ cwd: root, gate, env: bareEnv(PNPM_RUN_ENV) });
    assert.equal(res.status, 1, `expected the deletion to be caught:\n${res.out}`);
    assert.match(res.out, /policy setting not in effect: verifyDepsBeforeRun/);
    // The blame must not land on the variable the gate deliberately ignored.
    assert.doesNotMatch(res.out, /comes from the environment variable/);
  });

  it('fails when a policy key is moved into .npmrc, where pnpm 11 ignores it', () => {
    const npmrc = `${readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8')}ignore-scripts=true\nverify-deps-before-run=error\n`;
    const { root, gate } = sandbox({ npmrc });
    const res = runGate({ cwd: root, gate, env: bareEnv(PNPM_RUN_ENV) });
    assert.equal(res.status, 1, `expected the inert .npmrc keys to be caught:\n${res.out}`);
    assert.match(res.out, /policy setting "ignore-scripts" found in \.npmrc/);
    assert.match(res.out, /policy setting "verify-deps-before-run" found in \.npmrc/);
  });

  it('asserts every policy setting the workspace file declares', () => {
    // A guard against the fix regressing into "stop asserting": the gate must keep
    // covering each key the supply-chain policy names.
    const source = readFileSync(GATE, 'utf8');
    for (const key of [
      'ignoreScripts',
      'onlyBuiltDependencies',
      'minimumReleaseAge',
      'verifyStoreIntegrity',
      'verifyDepsBeforeRun',
      'saveExact',
      'strictPeerDependencies',
      'autoInstallPeers',
      'engineStrict',
      'packageManagerStrict',
    ]) {
      assert.match(source, new RegExp(`key: '${key}'`), `gate no longer asserts ${key}`);
    }
  });
});
