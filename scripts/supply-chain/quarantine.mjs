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
 *   3. writes the result to `pnpm-lock.yaml.new` — it does NOT touch the
 *      committed lockfile
 *   4. runs the acquisition-channel checks against the candidate, then tells you
 *      how to review and adopt it
 *
 * ## Why it writes `.new` instead of the lockfile
 *
 * It used to copy the freshly resolved lockfile straight over `pnpm-lock.yaml`
 * and *then* print "review the diff before installing". The change it asked you
 * to review had already been applied, so the honest reading of that advice was
 * "review this after the fact, using git". Worse, the audit it ran afterwards was
 * `audit.mjs --offline`, which exited 0 with two of eight gates unrun (and, on a
 * machine that had not installed yet, with three of the remaining six inspecting
 * an empty store). The word "success" was doing a great deal of work.
 *
 * Now nothing is overwritten. The candidate sits beside the lockfile, the
 * acquisition-channel checks — the ones that can be answered from the lockfile
 * text alone, and the ones that matter for a *newly resolved* graph — run against
 * the candidate, and the swap is an explicit command the operator types after
 * reading the diff.
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
 * Everything this script sets *itself*, with a value it computed rather than one
 * it inherited.
 *
 * They are listed separately because the leak check below asks "did anything
 * from the surrounding environment survive that should not have?", and three of
 * these are named `npm_config_ignore_scripts`, `NPM_CONFIG_USERCONFIG` and
 * `NPM_CONFIG_GLOBALCONFIG` — which match the `/^NPM_/i` forbidden pattern. The
 * check ran over the finished environment, so it flagged the quarantine's own
 * hardening as a leak and the script exited 1 before resolving anything. It has
 * therefore never been able to run: `pnpm run deps:quarantine` printed
 * "refusing to run: secret-shaped variables reached the quarantine env:
 * npm_config_ignore_scripts, NPM_CONFIG_USERCONFIG, NPM_CONFIG_GLOBALCONFIG"
 * and stopped. Weakening the patterns would have been the wrong fix — the
 * patterns are right; what was wrong is asking them a question about values this
 * script chose.
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

/** The variables inherited from the caller — the only ones that could carry a secret. */
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

/**
 * The whole workflow. A function rather than top-level statements so the env
 * helpers above can be imported and asserted on without resolving anything.
 */
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
  // An existing lockfile is copied in so that resolution is incremental rather
  // than a full re-resolve, which would churn versions unnecessarily.
  if (existsSync(join(REPO_ROOT, 'pnpm-lock.yaml'))) {
    cpSync(join(REPO_ROOT, 'pnpm-lock.yaml'), join(workdir, 'pnpm-lock.yaml'));
    copied.push('pnpm-lock.yaml (existing)');
  }

  console.log(dim(`  quarantine: ${quarantine}`));
  console.log(
    dim(`  copied ${copied.length} manifest file(s); no source, no .env, no .git, no node_modules`),
  );
  console.log(dim(`  env: ${ENV_ALLOWLIST.join(', ')} + throwaway HOME — every token/secret dropped`));

  // The check that matters: did anything from the *caller's* environment survive
  // that should not have? Asking it of the finished environment instead asked it of
  // this script's own hardening, which is what stopped the tool from ever running.
  const env = scrubbedEnv(fakeHome);
  const leaked = Object.keys(inheritedEnv()).filter((k) => FORBIDDEN_PATTERNS.some((p) => p.test(k)));
  if (leaked.length > 0) {
    console.log(
      red(`  ✗ refusing to run: secret-shaped variables reached the quarantine env: ${leaked.join(', ')}`),
    );
    process.exit(1);
  }
  // And nothing outside the allowlist and this script's own settings gets through.
  const deliberate = new Set(Object.keys(quarantineSettings(fakeHome)));
  const unexpected = Object.keys(env).filter((k) => !deliberate.has(k) && !ENV_ALLOWLIST.includes(k));
  if (unexpected.length > 0) {
    console.log(
      red(`  ✗ refusing to run: unexpected variables in the quarantine env: ${unexpected.join(', ')}`),
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

  // The committed lockfile is never written here. Adopting the candidate is a
  // decision the operator makes after reading the diff, not a side effect of
  // resolving one.
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

  // Only the checks that can be answered from the lockfile text alone. Everything
  // else (the store, the resolved graph, the registry) describes the tree that is
  // installed right now, which is not the tree this candidate would produce —
  // running those here would attribute the current tree's clean bill of health to
  // a lockfile nobody has installed.
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
    console.log('  1. audit:   pnpm run security:audit    (the full eight-gate release audit)');
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
