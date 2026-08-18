#!/usr/bin/env node
/**
 * Gate: the supply-chain policy is actually in effect.
 *
 * This gate exists because of a real footgun: pnpm 11 reads ONLY auth and registry
 * settings from `.npmrc`. A policy written into `.npmrc` — `ignore-scripts=true`,
 * `minimum-release-age=...` — is silently ignored, and the repo looks hardened
 * while being wide open. So rather than trusting the file, this asks pnpm for its
 * *effective* configuration and asserts on that.
 *
 * It also fails if a policy setting appears in `.npmrc`, where it would be inert.
 *
 * READ THIS BEFORE CHANGING THE SUBPROCESS BELOW.
 *
 * `pnpm run <script>` injects configuration into the environment of the child it
 * spawns. Most of that injection reflects real configuration, but pnpm also uses
 * the same channel to suppress its *own* re-entrant behaviour in nested
 * invocations. Measured on pnpm 11.10.0 (`pnpm exec env | grep -iE '^(p?npm)_'`):
 *
 *   PNPM_PACKAGE_NAME=poker-risk-lab
 *   npm_command=exec
 *   npm_config_user_agent=pnpm/11.10.0 npm/? node/v24.18.0 darwin arm64
 *   pnpm_config_verify_deps_before_run=false      <-- self-suppression, not policy
 *
 * That last line is pnpm telling its own children "do not re-verify node_modules,
 * the parent already did". It is not a statement about this repository's policy.
 * A nested `pnpm config list --json` inherits it and reports
 * `verifyDepsBeforeRun: false`, so a gate that reads the child's answer verbatim
 * measures its own wrapper and fails 100% of the time when invoked the documented
 * way (`pnpm run security:policy` / `pnpm run security:audit`).
 *
 * The fix is deliberately narrow: exactly the keys pnpm is known to self-suppress
 * are removed from the child environment, and only when this process really is a
 * pnpm-spawned child. Every other `pnpm_config_*` override is left in place, so an
 * operator or a CI job that genuinely weakens a policy through the environment is
 * still caught. `npm_config_*`-prefixed variables do not override
 * pnpm-workspace.yaml at all and are therefore left alone.
 *
 * If a future pnpm release self-suppresses a different key, this gate fails loudly
 * (the safe direction) and prints the environment variable responsible — see the
 * `from the environment` hint below. Add the key to PNPM_SELF_SUPPRESSED then.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

const gate = new Gate('policy-in-effect');

/** setting → assertion over the effective value */
const REQUIRED = [
  {
    key: 'ignoreScripts',
    expect: (v) => v === true,
    why: 'lifecycle scripts are the Mini Shai-Hulud delivery path',
  },
  {
    key: 'dangerouslyAllowAllBuilds',
    expect: (v) => v === false || v === undefined,
    why: 'must not blanket-approve builds',
  },
  {
    key: 'onlyBuiltDependencies',
    expect: (v) => Array.isArray(v) && v.length === 0,
    why: 'no package may opt back into running build scripts',
  },
  {
    key: 'minimumReleaseAge',
    expect: (v) => typeof v === 'number' && v >= 10_080,
    why: 'registry cooldown of at least 7 days',
  },
  {
    key: 'minimumReleaseAgeExclude',
    expect: (v) => v === undefined || (Array.isArray(v) && v.length === 0),
    why: 'no package may skip the cooldown',
  },
  { key: 'verifyStoreIntegrity', expect: (v) => v === true, why: 'detect tampered tarballs in the store' },
  { key: 'saveExact', expect: (v) => v === true, why: 'ranges allow unreviewed version drift' },
  { key: 'strictPeerDependencies', expect: (v) => v === true, why: 'fail loudly rather than invent a graph' },
  {
    key: 'autoInstallPeers',
    expect: (v) => v === false,
    why: 'never silently acquire an undeclared package',
  },
  { key: 'engineStrict', expect: (v) => v === true, why: 'pin the runtime the code was tested on' },
  { key: 'packageManagerStrict', expect: (v) => v === true, why: 'enforce the packageManager pin' },
  {
    key: 'verifyDepsBeforeRun',
    expect: (v) => v === 'error' || v === true,
    why: 'refuse to run against a stale node_modules',
  },
];

/** Keys that are pnpm policy settings and therefore MUST NOT live in .npmrc. */
const INERT_IN_NPMRC = [
  'ignore-scripts',
  'ignorescripts',
  'minimum-release-age',
  'minimumreleaseage',
  'only-built-dependencies',
  'onlybuiltdependencies',
  'verify-store-integrity',
  'verifystoreintegrity',
  'save-exact',
  'saveexact',
  'strict-peer-dependencies',
  'strictpeerdependencies',
  'auto-install-peers',
  'autoinstallpeers',
  'node-linker',
  'nodelinker',
  'frozen-lockfile',
  'frozenlockfile',
  'dangerously-allow-all-builds',
  'engine-strict',
  'enginestrict',
  'package-manager-strict',
  'verify-deps-before-run',
];

/**
 * Environment variables pnpm sets on its own script children purely to suppress
 * re-entrant behaviour. Keyed by the (lower-case) variable name pnpm actually
 * writes; the value is the camelCase config key it shadows.
 *
 * Keep this list minimal. Every entry is a value this gate stops being able to
 * observe from the environment, so an entry must be justified by pnpm genuinely
 * writing it for its own bookkeeping rather than as configuration.
 */
const PNPM_SELF_SUPPRESSED = new Map([['pnpm_config_verify_deps_before_run', 'verifyDepsBeforeRun']]);

/** camelCase config key -> the environment variable name pnpm would read it from. */
function envNameFor(key) {
  return `pnpm_config_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
}

/**
 * True when this process was spawned by pnpm itself (`pnpm run`, `pnpm exec`,
 * a lifecycle script). Only then is pnpm's self-suppression variable pnpm's own,
 * rather than something a human or a CI job exported.
 */
function insidePnpmChild(env) {
  const agent = env['npm_config_user_agent'] ?? '';
  return agent.startsWith('pnpm/') || typeof env['npm_command'] === 'string';
}

/** The parent environment minus pnpm's self-suppression variables. */
function sanitisedEnv(env) {
  if (!insidePnpmChild(env)) return { env, stripped: [] };
  const child = { ...env };
  const stripped = [];
  for (const [name, key] of PNPM_SELF_SUPPRESSED) {
    for (const variant of [name, name.toUpperCase()]) {
      if (variant in child) {
        delete child[variant];
        stripped.push(`${variant} (shadowing ${key})`);
      }
    }
  }
  return { env: child, stripped };
}

await runGate(gate, () => {
  const { env: childEnv, stripped } = sanitisedEnv(process.env);

  let effective;
  try {
    const raw = execFileSync('pnpm', ['config', 'list', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv,
    });
    effective = JSON.parse(raw);
  } catch {
    // Older/newer pnpm may not accept --json for `config list`; fall back to the
    // default output, which is already JSON-shaped in pnpm 11.
    const raw = execFileSync('pnpm', ['config', 'list'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: childEnv,
    });
    effective = JSON.parse(raw);
  }

  if (stripped.length > 0) {
    gate.note(
      `ignored pnpm's own re-entrancy suppression: ${stripped.join(', ')} (set by the \`pnpm run\` wrapper, not by this repo)`,
    );
  }

  for (const { key, expect, why } of REQUIRED) {
    const value = effective[key];
    if (!expect(value)) {
      // If an environment variable is what produced the bad value, say so: that
      // turns "the policy is missing" into "this variable is overriding it".
      // Read from the sanitised environment, so a variable this gate deliberately
      // ignored is never blamed for a value pnpm did not take from it.
      const envName = envNameFor(key);
      const fromEnv = childEnv[envName] ?? childEnv[envName.toUpperCase()];
      const provenance =
        fromEnv === undefined
          ? ''
          : `\n      this value comes from the environment variable ${envName}=${fromEnv}, not from pnpm-workspace.yaml`;
      gate.fail(
        `policy setting not in effect: ${key} = ${JSON.stringify(value)}`,
        `required because: ${why}\n      set it in pnpm-workspace.yaml (NOT .npmrc — pnpm 11 ignores policy keys there)${provenance}`,
      );
    }
  }
  gate.note(`${REQUIRED.length} policy settings asserted against pnpm's effective config`);

  const registry = effective.registry;
  if (registry !== 'https://registry.npmjs.org/') {
    gate.fail(`unexpected default registry: ${registry}`, 'only the public npm registry is permitted');
  }

  // A policy key sitting in .npmrc is worse than absent: it reads as protection.
  const npmrcPath = join(REPO_ROOT, '.npmrc');
  if (existsSync(npmrcPath)) {
    const lines = readFileSync(npmrcPath, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
      const key = trimmed.split('=')[0]?.trim().toLowerCase();
      if (key && INERT_IN_NPMRC.includes(key)) {
        gate.fail(
          `policy setting "${key}" found in .npmrc (line ${i + 1}) where pnpm 11 ignores it`,
          'move it to pnpm-workspace.yaml — leaving it here gives false assurance',
        );
      }
    }
  }

  // The packageManager pin should carry an integrity hash so Corepack verifies the
  // package manager binary itself.
  const rootManifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const pm = rootManifest.packageManager;
  if (typeof pm !== 'string') {
    gate.fail('root package.json has no "packageManager" pin');
  } else if (!/\+sha(?:256|512)\.[0-9a-f]{32,}$/.test(pm)) {
    gate.fail(
      `packageManager pin has no integrity hash: ${pm}`,
      'use the form pnpm@<version>+sha256.<hex> so Corepack verifies the downloaded package manager',
    );
  } else {
    gate.note(`packageManager pinned with integrity hash (${pm.split('+')[0]})`);
  }
});
