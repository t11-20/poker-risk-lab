#!/usr/bin/env node
/**
 * Gate: every dependency must have an acceptable *shape*.
 *
 * Fails on:
 *   - resolution from anywhere other than registry.npmjs.org (git, remote tarball, CDN, file:)
 *   - any package declaring an install-time lifecycle hook (preinstall/install/postinstall)
 *   - any workspace manifest declaring a version range instead of an exact version
 *   - a lockfile whose version we do not understand
 *
 * Warns on source-time hooks (`prepare` etc.), which registry installs do not run
 * but which would run if the dependency were ever switched to a git reference.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWED_RESOLUTION_HOSTS } from './denied-packages.mjs';
import {
  Gate,
  INSTALL_HOOKS,
  installedManifests,
  lockfileText,
  REPO_ROOT,
  resolvedGraph,
  runGate,
  SOURCE_HOOKS,
} from './lib.mjs';

const gate = new Gate('dependency-shapes');

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SUPPORTED_LOCKFILE_VERSIONS = new Set(['9.0', '10.0', '11.0']);

await runGate(gate, () => {
  // ---- 1. Lockfile shape ---------------------------------------------------
  const lock = lockfileText();
  const lockVersion = /^lockfileVersion:\s*'?([\d.]+)'?/m.exec(lock)?.[1];
  if (!lockVersion) {
    gate.fail('could not determine lockfileVersion from pnpm-lock.yaml');
  } else if (!SUPPORTED_LOCKFILE_VERSIONS.has(lockVersion)) {
    gate.fail(
      `unrecognised lockfileVersion ${lockVersion}`,
      'the shape checks below were written against ' +
        `${[...SUPPORTED_LOCKFILE_VERSIONS].join('/')}; review this gate before bumping pnpm`,
    );
  } else {
    gate.note(`lockfileVersion ${lockVersion}`);
  }

  // Non-registry acquisition channels, as they appear in a pnpm lockfile.
  const forbiddenLockPatterns = [
    { re: /^\s*tarball:\s*(\S+)/gm, what: 'remote tarball resolution' },
    { re: /^\s*repo:\s*(\S+)/gm, what: 'git repository resolution' },
    { re: /^\s*commit:\s*(\S+)/gm, what: 'git commit resolution' },
    { re: /^\s*type:\s*(git|directory)\s*$/gm, what: 'non-registry resolution type' },
    { re: /(?:^|['"\s])(git\+(?:ssh|https?):\/\/\S+)/gm, what: 'git protocol dependency' },
    {
      re: /(?:^|['"\s])(https?:\/\/(?!registry\.npmjs\.org\/)[^\s'"]+\.tgz)/gm,
      what: 'off-registry tarball URL',
    },
  ];
  for (const { re, what } of forbiddenLockPatterns) {
    for (const match of lock.matchAll(re)) {
      gate.fail(`${what} in pnpm-lock.yaml`, match[0].trim());
    }
  }

  // ---- 2. Resolution hosts -------------------------------------------------
  const { packages, workspaceProjects } = resolvedGraph();
  for (const [key, pkg] of packages) {
    if (!pkg.resolved) {
      // No resolution URL: either a workspace link (filtered out already) or a
      // link:/file: dependency. Both are unexpected for a third-party package.
      gate.fail(`package with no registry resolution: ${key}`, `importers: ${[...pkg.importers].join(', ')}`);
      continue;
    }
    let host;
    try {
      host = new URL(pkg.resolved).host;
    } catch {
      gate.fail(`unparseable resolution URL for ${key}`, pkg.resolved);
      continue;
    }
    if (!ALLOWED_RESOLUTION_HOSTS.has(host)) {
      gate.fail(`disallowed resolution host for ${key}: ${host}`, pkg.resolved);
    }
  }

  // ---- 3. Lifecycle hooks in installed packages ---------------------------
  const installed = installedManifests();
  let sourceHookCount = 0;
  for (const [key, entry] of installed) {
    if (!entry.manifest) continue;
    const scripts = entry.manifest.scripts ?? {};
    const installHooks = INSTALL_HOOKS.filter((h) => typeof scripts[h] === 'string');
    if (installHooks.length > 0) {
      gate.fail(
        `install-time lifecycle hook declared by ${key}`,
        installHooks.map((h) => `${h}: ${scripts[h]}`).join('\n      ') +
          '\n      Install scripts are disabled repo-wide, but a dependency that *wants* to run ' +
          'code at install time requires human approval and a hermetic review (see docs/SECURITY.md).',
      );
    }
    const srcHooks = SOURCE_HOOKS.filter((h) => typeof scripts[h] === 'string');
    if (srcHooks.length > 0) sourceHookCount += 1;
  }
  if (sourceHookCount > 0) {
    gate.note(
      `${sourceHookCount} package(s) declare source-time hooks (prepare/prepack). ` +
        'Registry installs do not run these; they would only run for a git/local dependency, which shape check 1 forbids.',
    );
  }

  // ---- 4. Exact versions in every workspace manifest ----------------------
  for (const project of workspaceProjects) {
    const manifestPath = join(project.path ?? REPO_ROOT, 'package.json');
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      gate.fail(`cannot read workspace manifest for ${project.name}`, `${manifestPath}: ${err.message}`);
      continue;
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (range.startsWith('workspace:')) continue;
        if (!EXACT_VERSION.test(range)) {
          gate.fail(
            `non-exact version range in ${project.name} → ${section}.${name}: "${range}"`,
            'a range lets `pnpm install` drift onto a newly published (possibly compromised) version ' +
              'without a reviewable lockfile change',
          );
        }
      }
    }
  }
});
