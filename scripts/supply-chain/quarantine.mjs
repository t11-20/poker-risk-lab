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

/**
 * The variables inherited from the caller — the only ones that could carry a
 * secret.
 *
 * **This filter is where the security property lives.** A name that matches a
 * forbidden pattern is dropped here, allowlisted or not, and nothing downstream
 * can put it back. Everything below is an alarm on top of it, not the lock.
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
 * Names on `ENV_ALLOWLIST` that are secret-shaped — the check that can actually
 * fail, and the one this script used to only appear to run.
 *
 * ## What the previous check could not see
 *
 * The refusal below used to read:
 *
 *     const leaked = Object.keys(inheritedEnv())
 *       .filter((k) => FORBIDDEN_PATTERNS.some((p) => p.test(k)));
 *
 * and was commented "the check that matters". `inheritedEnv()` had already
 * dropped every name matching `FORBIDDEN_PATTERNS` while building its result, so
 * this asked the same question of an already-filtered object: `leaked` was `[]`
 * by construction, and the branch was unreachable. A second refusal — "nothing
 * outside the allowlist and this script's own settings gets through", over
 * `{...inheritedEnv(), ...quarantineSettings(home)}` — was unreachable for the
 * same reason, since that object is BUILT from exactly those two sources.
 *
 * Measured by driving the exported helpers with `GITHUB_TOKEN`,
 * `AWS_SECRET_ACCESS_KEY` and `NPM_TOKEN` set to real-looking values in the
 * environment and then pushing those three names onto `ENV_ALLOWLIST` to defeat
 * the allowlist itself: `leaked = []` and `unexpected = []` in every case, and
 * `quarantine.test.mjs`'s assertion that `leaked` is `[]` — whose failure message
 * was "the allowlist has grown a secret-shaped name" — passed while the allowlist
 * HAD grown exactly such a name. Three tautologies agreeing with each other.
 *
 * Nothing leaked: `inheritedEnv` did the work. But a guard whose failure mode has
 * never been observed is decoration, and this file's own comment called that one
 * the check that matters.
 *
 * ## What this asks instead
 *
 * The allowlist is committed policy, so the question is answerable before any
 * filtering and without reference to what happens to be exported on this machine:
 * does the list of names this script promises to carry through admit one that is
 * shaped like a credential? Adding `NPM_TOKEN` to `ENV_ALLOWLIST` now stops the
 * run, whether or not `NPM_TOKEN` is set. The value is never read.
 *
 * Takes the list as an argument so the test can hand it a poisoned allowlist and
 * watch this fail, rather than asserting a tautology about the current one.
 *
 * @param {string[]} allowlist
 * @returns {string[]}
 */
export function forbiddenAllowlistEntries(allowlist = ENV_ALLOWLIST) {
  return allowlist.filter((name) => FORBIDDEN_PATTERNS.some((p) => p.test(name)));
}

/**
 * Secret-shaped names present in a FINISHED quarantine environment, excluding the
 * hardening this script sets itself.
 *
 * Takes the environment as an argument for the reason the old check should have:
 * asked about `scrubbedEnv()`'s own output it is a tautology, because that object
 * is assembled from an allowlist-filtered inherit plus `quarantineSettings`. A
 * parameter makes it a real function with a real negative control — the test
 * hands it a deliberately leaky env and watches it name the leak — and keeps the
 * live assertion (`leakedNames(scrubbedEnv(home), home)` is empty) honest about
 * being a regression guard on the assembly, not the lock itself.
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

  // The check that matters, and that can now fail: is the POLICY sound? Asking
  // the same question of `inheritedEnv()`'s output was a tautology — see
  // `forbiddenAllowlistEntries` for what that could not see and how it was
  // measured.
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
  // A regression guard on the assembly, not the lock: `scrubbedEnv` is built from
  // an allowlist-filtered inherit plus this script's own settings, so this can
  // only fire if one of those two changes shape. It is here rather than deleted
  // because it is the assertion the whole quarantine rests on, and
  // `quarantine.test.mjs` proves the function itself can fail by handing it a
  // leaky environment.
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
