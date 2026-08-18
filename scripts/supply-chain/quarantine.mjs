#!/usr/bin/env node
/**
 * Acquires or refreshes the lockfile inside an ephemeral, secret-free quarantine.
 *
 * Why this exists: the Mini Shai-Hulud payload's whole purpose is to read
 * credentials out of the environment and process memory of whatever machine runs
 * `install`. Resolution is the moment of exposure. So resolution happens here —
 * in a throwaway directory, with a throwaway HOME, and with an environment
 * scrubbed down to an explicit allowlist, so that even if something did execute
 * there is nothing worth stealing in reach.
 *
 * What it does:
 *   1. copies only the manifests + workspace config into a temp dir (no source,
 *      no .env, no .git, no node_modules)
 *   2. runs `pnpm install --lockfile-only` there with a scrubbed env and a
 *      throwaway HOME/store, scripts disabled
 *   3. copies the resulting pnpm-lock.yaml back
 *   4. runs the offline gates against it, then tells you to run the full audit
 *
 * Usage:  pnpm run deps:quarantine
 *         pnpm run deps:quarantine -- --keep     (leave the temp dir for inspection)
 */

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { bold, dim, green, REPO_ROOT, red, yellow } from './lib.mjs';

const keep = process.argv.includes('--keep');

/**
 * Environment variables the package manager legitimately needs. Everything else
 * — every token, key, cloud credential and CI secret — is dropped.
 */
const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'];

/** Names that must never survive into the quarantine, even if allowlisted upstream. */
const FORBIDDEN_PATTERNS = [
  /TOKEN/i,
  /SECRET/i,
  /PASSWORD/i,
  /_KEY$/i,
  /CREDENTIAL/i,
  /^AWS_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^NPM_/i,
  /^VAULT/i,
  /^KUBE/i,
  /^OP_/i,
];

function scrubbedEnv(home) {
  const env = Object.create(null);
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined && !FORBIDDEN_PATTERNS.some((p) => p.test(name))) env[name] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = join(home, '.config');
  env.XDG_DATA_HOME = join(home, '.local', 'share');
  env.XDG_CACHE_HOME = join(home, '.cache');
  env.npm_config_ignore_scripts = 'true';
  env.CI = 'true';
  // Never let a user-level pnpm/npm config leak in.
  env.NPM_CONFIG_USERCONFIG = join(home, '.npmrc');
  env.NPM_CONFIG_GLOBALCONFIG = join(home, '.npmrc-global');
  return env;
}

/** Files that define the dependency graph — and nothing else. */
function manifestPaths() {
  const paths = ['package.json', 'pnpm-workspace.yaml', '.npmrc'];
  const workspace = readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const globs = [...workspace.matchAll(/^\s*-\s*(\S+)\s*$/gm)].map((m) => m[1]);
  for (const glob of globs) {
    const base = glob.replace(/\/\*+$/, '');
    const baseDir = join(REPO_ROOT, base);
    if (!existsSync(baseDir)) continue;
    for (const entry of readdirSyncSafe(baseDir)) {
      const candidate = join(base, entry, 'package.json');
      if (existsSync(join(REPO_ROOT, candidate))) paths.push(candidate);
    }
  }
  return paths;
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

console.log(bold('\nQuarantined dependency acquisition'));

const quarantine = mkdtempSync(join(tmpdir(), 'prl-quarantine-'));
const fakeHome = join(quarantine, 'home');
const workdir = join(quarantine, 'work');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(join(fakeHome, '.config'), { recursive: true });
mkdirSync(workdir, { recursive: true });
writeFileSync(join(fakeHome, '.npmrc'), '# intentionally empty: no credentials in the quarantine\n');

const copied = [];
for (const rel of manifestPaths()) {
  const from = join(REPO_ROOT, rel);
  if (!existsSync(from)) continue;
  const to = join(workdir, rel);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to);
  copied.push(rel);
}
// An existing lockfile is copied in so that resolution is incremental rather
// than a full re-resolve, which would churn versions unnecessarily.
if (existsSync(join(REPO_ROOT, 'pnpm-lock.yaml'))) {
  cpSync(join(REPO_ROOT, 'pnpm-lock.yaml'), join(workdir, 'pnpm-lock.yaml'));
  copied.push('pnpm-lock.yaml (existing)');
}

console.log(dim(`  quarantine: ${quarantine}`));
console.log(dim(`  copied ${copied.length} manifest file(s); no source, no .env, no .git, no node_modules`));
console.log(dim(`  env: ${ENV_ALLOWLIST.join(', ')} + throwaway HOME — every token/secret dropped`));

const env = scrubbedEnv(fakeHome);
const leaked = Object.keys(env).filter((k) => FORBIDDEN_PATTERNS.some((p) => p.test(k)));
if (leaked.length > 0) {
  console.log(
    red(`  ✗ refusing to run: secret-shaped variables reached the quarantine env: ${leaked.join(', ')}`),
  );
  process.exit(1);
}

console.log(bold('\n▸ resolving (lockfile only, scripts disabled)'));
const install = spawnSync(
  'pnpm',
  [
    'install',
    '--lockfile-only',
    '--ignore-scripts',
    '--store-dir',
    join(quarantine, 'store'),
    '--no-frozen-lockfile',
  ],
  { cwd: workdir, env, stdio: 'inherit' },
);

if (install.status !== 0) {
  console.log(red(`\n  ✗ resolution failed (exit ${install.status}).`));
  console.log(dim(`  quarantine left at ${quarantine} for inspection`));
  process.exit(1);
}

const producedLock = join(workdir, 'pnpm-lock.yaml');
if (!existsSync(producedLock)) {
  console.log(red('\n  ✗ resolution produced no pnpm-lock.yaml'));
  process.exit(1);
}

const before = existsSync(join(REPO_ROOT, 'pnpm-lock.yaml'))
  ? readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'), 'utf8')
  : '';
const after = readFileSync(producedLock, 'utf8');
cpSync(producedLock, join(REPO_ROOT, 'pnpm-lock.yaml'));

if (before === after) {
  console.log(green('\n  ✓ lockfile unchanged'));
} else {
  console.log(yellow('\n  ! lockfile CHANGED — review the diff before installing'));
  console.log(dim('    git diff -- pnpm-lock.yaml'));
}

if (!keep) rmSync(quarantine, { recursive: true, force: true });
else console.log(dim(`\n  quarantine kept at ${quarantine}`));

console.log(bold('\n▸ offline gates against the new lockfile'));
const gates = spawnSync(
  process.execPath,
  [join(REPO_ROOT, 'scripts', 'supply-chain', 'audit.mjs'), '--offline'],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  },
);

console.log(bold('\nNext steps'));
console.log('  1. review:  git diff -- pnpm-lock.yaml');
console.log('  2. install: pnpm install --frozen-lockfile');
console.log('  3. audit:   pnpm run security:audit    (runs the network gates too)');
console.log('');

process.exit(gates.status === 0 ? 0 : 1);
