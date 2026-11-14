#!/usr/bin/env node
/**
 * Gate: the supply-chain policy is in effect. pnpm 11 reads only auth and registry settings from
 * `.npmrc`, so this asks pnpm for its effective configuration and fails on a policy key in `.npmrc`.
 *
 * Read before changing the subprocess below. `pnpm run` sets
 * `pnpm_config_verify_deps_before_run=false` on its children to suppress its own re-verification
 * (measured on pnpm 11.10.0). A nested `pnpm config list` inherits it, so reading the child verbatim
 * would fail every run through `pnpm run security:policy`. Only the keys in PNPM_SELF_SUPPRESSED are
 * removed, and only for a pnpm-spawned child, so a real environment override is still caught. A new
 * self-suppressed key fails loudly with the variable named; add it to the list then.
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
 * Variables pnpm sets on its children to suppress re-entrant behaviour, keyed by the lower-case name
 * pnpm writes. Each entry is a value this gate stops observing, so keep the list minimal.
 */
const PNPM_SELF_SUPPRESSED = new Map([['pnpm_config_verify_deps_before_run', 'verifyDepsBeforeRun']]);

/** camelCase config key -> the environment variable name pnpm would read it from. */
function envNameFor(key) {
  return `pnpm_config_${key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}`;
}

/** True when pnpm spawned this process. Only then is the self-suppression variable pnpm's own. */
function insidePnpmChild(env) {
  const agent = env['npm_config_user_agent'] ?? '';
  return agent.startsWith('pnpm/') || typeof env['npm_command'] === 'string';
}

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
    // Fall back for a pnpm that rejects --json; pnpm 11's default output is JSON-shaped.
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
      // Blame an environment variable when it produced the bad value, reading from the sanitised
      // environment so a deliberately ignored variable is never blamed.
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

  // The packageManager pin carries an integrity hash so Corepack verifies pnpm itself.
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
