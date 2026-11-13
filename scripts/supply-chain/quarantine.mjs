#!/usr/bin/env node
/**
 * Resolves the lockfile in a throwaway directory with a throwaway HOME and an environment scrubbed
 * to an allowlist, because the Mini Shai-Hulud payload steals credentials at install time. It copies
 * only manifests and workspace config, runs `pnpm install --lockfile-only` with scripts disabled,
 * and writes `pnpm-lock.yaml.new` beside the committed lockfile. Only the lockfile-text checks run
 * on the candidate. Adopting it is a command the operator types after reading the diff.
 *
 * Usage:  pnpm run deps:quarantine [-- --keep]   (--keep leaves the temp dir for inspection)
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

/** Variables the package manager needs. Every other name is dropped. */
export const ENV_ALLOWLIST = ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'];

/** Names that must never survive into the quarantine, even if allowlisted upstream. */
export const FORBIDDEN_PATTERNS = [
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

/**
 * Variables this script sets itself. Kept apart from the leak check because three of them match
 * `/^NPM_/i`, and checking the finished environment once flagged this hardening as a leak and
 * stopped every run.
 */
export function quarantineSettings(home) {
  return {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    npm_config_ignore_scripts: 'true',
    CI: 'true',
    // Never let a user-level pnpm/npm config leak in.
    NPM_CONFIG_USERCONFIG: join(home, '.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(home, '.npmrc-global'),
  };
}

/**
 * The inherited variables. This filter is the security property: a forbidden name is dropped here,
 * allowlisted or not. Everything below is an alarm on top of it.
 */
export function inheritedEnv() {
  const env = Object.create(null);
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined && !FORBIDDEN_PATTERNS.some((p) => p.test(name))) env[name] = value;
  }
  return env;
}

export function scrubbedEnv(home) {
  return { ...inheritedEnv(), ...quarantineSettings(home) };
}

/**
 * Secret-shaped names on `ENV_ALLOWLIST`. The previous check ran over `inheritedEnv()` output,
 * which had already dropped every forbidden name, so it could never fire. This checks the committed
 * policy instead, so adding `NPM_TOKEN` to the allowlist stops the run whether or not it is set.
 * Takes the list so the test can pass a poisoned one.
 *
 * @param {string[]} allowlist
 * @returns {string[]}
 */
export function forbiddenAllowlistEntries(allowlist = ENV_ALLOWLIST) {
  return allowlist.filter((name) => FORBIDDEN_PATTERNS.some((p) => p.test(name)));
}

/**
 * Secret-shaped names in a finished environment, excluding this script's own settings. Takes the
 * environment so the test can pass a leaky one.
 *
 * @param {Record<string, string>} env
 * @param {string} home
 * @returns {string[]}
 */
export function leakedNames(env, home) {
  const deliberate = new Set(Object.keys(quarantineSettings(home)));
  return Object.keys(env).filter(
    (name) => !deliberate.has(name) && FORBIDDEN_PATTERNS.some((p) => p.test(name)),
  );
}

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

// A function so the env helpers can be imported without resolving anything.
function main() {
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
  // Copying the existing lockfile keeps resolution incremental.
  if (existsSync(join(REPO_ROOT, 'pnpm-lock.yaml'))) {
    cpSync(join(REPO_ROOT, 'pnpm-lock.yaml'), join(workdir, 'pnpm-lock.yaml'));
    copied.push('pnpm-lock.yaml (existing)');
  }

  console.log(dim(`  quarantine: ${quarantine}`));
  console.log(
    dim(`  copied ${copied.length} manifest file(s); no source, no .env, no .git, no node_modules`),
  );
  console.log(dim(`  env: ${ENV_ALLOWLIST.join(', ')} + throwaway HOME — every token/secret dropped`));

  const admitted = forbiddenAllowlistEntries();
  if (admitted.length > 0) {
    console.log(
      red(`  ✗ refusing to run: ENV_ALLOWLIST admits secret-shaped name(s): ${admitted.join(', ')}`),
    );
    console.log(
      dim(
        '    inheritedEnv() would drop them anyway, so nothing has leaked — but the allowlist is the\n' +
          '    committed statement of what this quarantine carries, and it must not say this.',
      ),
    );
    process.exit(1);
  }

  const env = scrubbedEnv(fakeHome);
  // A regression guard on how `scrubbedEnv` is assembled. The test shows the function can fail.
  const leaked = leakedNames(env, fakeHome);
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

  const currentLock = join(REPO_ROOT, 'pnpm-lock.yaml');
  const candidateLock = join(REPO_ROOT, 'pnpm-lock.yaml.new');
  const before = existsSync(currentLock) ? readFileSync(currentLock, 'utf8') : '';
  const after = readFileSync(producedLock, 'utf8');

  const unchanged = before === after;
  if (unchanged) {
    rmSync(candidateLock, { force: true });
    console.log(green('\n  ✓ lockfile unchanged — nothing to adopt'));
  } else {
    writeFileSync(candidateLock, after);
    console.log(yellow('\n  ! lockfile CHANGED — the candidate is pnpm-lock.yaml.new, NOT yet adopted'));
    console.log(dim('    git diff --no-index -- pnpm-lock.yaml pnpm-lock.yaml.new'));
  }

  if (!keep) rmSync(quarantine, { recursive: true, force: true });
  else console.log(dim(`\n  quarantine kept at ${quarantine}`));

  // Only lockfile-text checks. The store and registry checks describe the installed tree, not the
  // tree this candidate would produce.
  console.log(bold('\n▸ acquisition-channel checks against the candidate lockfile'));
  const shapes = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, 'scripts', 'supply-chain', 'dep-shapes.mjs'),
      '--lockfile',
      unchanged ? currentLock : candidateLock,
    ],
    { cwd: REPO_ROOT, stdio: 'inherit', env: process.env },
  );

  console.log(bold('\nNext steps'));
  if (unchanged) {
    console.log('  1. audit:   pnpm run security:audit    (the full eleven-gate release audit)');
  } else {
    console.log('  1. review:  git diff --no-index -- pnpm-lock.yaml pnpm-lock.yaml.new');
    console.log('  2. adopt:   mv pnpm-lock.yaml.new pnpm-lock.yaml');
    console.log('  3. install: pnpm install --frozen-lockfile');
    console.log('  4. audit:   pnpm run security:audit    (the full release audit; this run was not one)');
  }
  console.log('');

  if (shapes.status !== 0) {
    console.log(
      red(bold('  ✗ the candidate lockfile failed the acquisition-channel checks — do not adopt it.\n')),
    );
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) main();
