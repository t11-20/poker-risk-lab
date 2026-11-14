#!/usr/bin/env node
/**
 * Gate: every dependency has an acceptable shape. Fails on a non-registry resolution, an
 * install-time lifecycle hook, a store that cannot account for the resolved graph, a version range
 * in a workspace manifest, a first-party specifier without `workspace:`, or an unknown lockfile
 * version. Warns on source-time hooks such as `prepare`.
 *
 * Resolutions are parsed and every key judged against an allowlist, because the old six text
 * regexes matched 0 of 6 real pnpm git and directory resolutions (shai-hulud snapshot §5, Pattern B).
 *
 * Usage: node scripts/supply-chain/dep-shapes.mjs [--lockfile <path>]   (--lockfile: channel checks only)
 */

import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ALLOWED_RESOLUTION_HOSTS } from './denied-packages.mjs';
import {
  Gate,
  INSTALL_HOOKS,
  installedManifests,
  lockfileText,
  REPO_ROOT,
  requireStoreCoverage,
  resolvedGraph,
  runGate,
  SOURCE_HOOKS,
  storeCoverage,
} from './lib.mjs';
import { parseLockfile } from './lockfile-integrity.mjs';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SUPPORTED_LOCKFILE_VERSIONS = new Set(['9.0', '10.0', '11.0']);

/**
 * The only keys a registry resolution may carry. Fail-closed: an unknown key is a channel this gate
 * has not been taught to judge.
 */
const ALLOWED_RESOLUTION_KEYS = new Set(['integrity', 'tarball']);

const NON_REGISTRY_KEYS = new Map([
  ['type', 'non-registry resolution type'],
  ['repo', 'git repository resolution'],
  ['commit', 'git commit resolution'],
  ['directory', 'local directory resolution'],
  ['path', 'local path resolution'],
]);

/** `5.11.3`, or `5.11.3(react@19.2.8)` with a peer suffix. */
const IMPORTER_REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\(.*\))?$/;

/**
 * Check 1: everything was acquired from the registry. Pure over the lockfile text, so `--lockfile`
 * and quarantine.mjs can run it without an installed tree.
 *
 * @param {Gate} gate
 * @param {string} lock raw pnpm-lock.yaml text
 */
export function checkLockfileShape(gate, lock) {
  const { lockfileVersion, packages, importers } = parseLockfile(lock);

  if (!lockfileVersion) {
    gate.fail('could not determine lockfileVersion from pnpm-lock.yaml');
  } else if (!SUPPORTED_LOCKFILE_VERSIONS.has(lockfileVersion)) {
    gate.fail(
      `unrecognised lockfileVersion ${lockfileVersion}`,
      'the shape checks below were written against ' +
        `${[...SUPPORTED_LOCKFILE_VERSIONS].join('/')}; review this gate before bumping pnpm`,
    );
  } else {
    gate.note(`lockfileVersion ${lockfileVersion}`);
  }

  if (packages.size === 0) {
    gate.fail(
      'parsed zero package entries from the lockfile',
      'either the lockfile is empty or this reader is out of step with the format it is auditing — ' +
        'both mean the acquisition-channel check below examined nothing',
    );
  }

  for (const entry of packages.values()) {
    const { resolution } = entry;
    if (resolution === null) {
      gate.fail(`lockfile entry with no resolution: ${entry.key}`, 'nothing records how this was acquired');
      continue;
    }
    for (const [key, value] of Object.entries(resolution)) {
      const what = NON_REGISTRY_KEYS.get(key);
      if (what !== undefined) {
        gate.fail(`${what} in pnpm-lock.yaml: ${entry.key}`, `resolution.${key}: ${value}`);
        continue;
      }
      if (!ALLOWED_RESOLUTION_KEYS.has(key)) {
        gate.fail(
          `unrecognised resolution key "${key}" for ${entry.key}`,
          `value: ${value}\n      Only ${[...ALLOWED_RESOLUTION_KEYS].join('/')} describe a registry ` +
            'acquisition. Failing closed: teach this gate what the new key means before allowing it.',
        );
      }
    }
    if (typeof resolution['tarball'] === 'string') {
      const tarball = resolution['tarball'];
      let host = null;
      try {
        host = new URL(tarball).host;
      } catch {
        gate.fail(`unparseable tarball resolution for ${entry.key}`, tarball);
      }
      if (host !== null && !ALLOWED_RESOLUTION_HOSTS.has(host)) {
        gate.fail(`off-registry tarball resolution for ${entry.key}: ${host}`, tarball);
      }
    }
    if (resolution['integrity'] === undefined && resolution['tarball'] === undefined) {
      gate.fail(
        `lockfile entry with neither an integrity hash nor a tarball: ${entry.key}`,
        'there is nothing here to verify a download against',
      );
    }
  }

  // A first-party name resolved off the public registry would show here.
  for (const dep of importers) {
    if (dep.version.startsWith('link:')) {
      const target = dep.version.slice('link:'.length);
      const absolute = resolve(REPO_ROOT, dep.importer === '.' ? '' : dep.importer, target);
      if (!absolute.startsWith(REPO_ROOT + sep) || absolute.includes(`${sep}node_modules${sep}`)) {
        gate.fail(
          `${dep.importer} → ${dep.section}.${dep.name} links outside the workspace: ${dep.version}`,
          'a link that leaves the repository is unreviewable and unreproducible',
        );
      }
      if (!dep.specifier.startsWith('workspace:')) {
        gate.fail(
          `${dep.importer} → ${dep.section}.${dep.name} is a link but its specifier is "${dep.specifier}"`,
          'a workspace dependency must be declared with the workspace: protocol so it can never ' +
            'silently resolve from a registry instead',
        );
      }
      continue;
    }
    if (!IMPORTER_REGISTRY_VERSION.test(dep.version)) {
      gate.fail(
        `${dep.importer} → ${dep.section}.${dep.name} resolved to a non-registry version: "${dep.version}"`,
        `specifier: ${dep.specifier}\n      Only an exact registry version or a workspace link is permitted.`,
      );
    }
  }

  // A raw-text backstop over the whole file. Not the check: every pattern here missed the real
  // pnpm-format attack.
  const forbiddenLockPatterns = [
    { re: /(?:^|['"\s{,])(git\+(?:ssh|https?):\/\/\S+)/gm, what: 'git protocol dependency' },
    {
      re: /(?:^|['"\s{,])(https?:\/\/(?!registry\.npmjs\.org\/)[^\s'"},]+\.tgz)/gm,
      what: 'off-registry tarball URL',
    },
  ];
  for (const { re, what } of forbiddenLockPatterns) {
    for (const match of lock.matchAll(re)) {
      gate.fail(`${what} in pnpm-lock.yaml`, match[0].trim());
    }
  }

  gate.note(`inspected ${packages.size} lockfile resolutions and ${importers.length} importer edges`);
}

/**
 * Check 2: every resolved package came from an allowed host.
 *
 * @param {Gate} gate
 * @param {Map<string, {name: string, resolved: string|null, importers: Set<string>}>} packages
 */
export function checkResolutionHosts(gate, packages) {
  for (const [key, pkg] of packages) {
    if (!pkg.resolved) {
      // Workspace links were filtered out by resolution, so a missing URL here is a link: or file:
      // dependency.
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
}

/**
 * Check 3: no installed package declares an install-time hook (Pattern A). `requireStoreCoverage`
 * runs first, because a sweep of an empty store is not a pass.
 *
 * @param {Gate} gate
 * @param {Map<string, {manifest: unknown, manifestPath: string}>} installed
 */
export function checkInstalledLifecycleHooks(gate, installed) {
  let scanned = 0;
  let sourceHookCount = 0;
  for (const [key, entry] of installed) {
    if (!entry.manifest) continue;
    scanned += 1;
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
  gate.note(`read ${scanned} installed manifest(s) for install-time lifecycle hooks`);
  return scanned;
}

/**
 * Check 4: workspace manifests pin exactly, and first-party names never resolve from a registry.
 * `@prl` is unclaimed on npm and `.npmrc` maps it to the public registry, so `"1.0.0"` in place of
 * `"workspace:*"` fetches a stranger's package. Names come from the workspace, not a list.
 *
 * @param {Gate} gate
 * @param {Array<{name: string, path: string}>} workspaceProjects
 */
export function checkWorkspaceManifests(gate, workspaceProjects) {
  const firstPartyNames = new Set(workspaceProjects.map((p) => p.name));
  const firstPartyScopes = new Set();
  for (const name of firstPartyNames) {
    if (!name.startsWith('@')) continue;
    const slash = name.indexOf('/');
    if (slash > 0) firstPartyScopes.add(name.slice(0, slash + 1));
  }
  const isFirstParty = (name) =>
    firstPartyNames.has(name) || [...firstPartyScopes].some((scope) => name.startsWith(scope));

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
        if (typeof range !== 'string') {
          gate.fail(`non-string specifier in ${project.name} → ${section}.${name}`, JSON.stringify(range));
          continue;
        }
        if (range.startsWith('workspace:')) continue;
        if (isFirstParty(name)) {
          gate.fail(
            `first-party package ${name} declared without the workspace: protocol in ${project.name} → ${section}: "${range}"`,
            'the first-party scope is not reserved on the public registry and .npmrc maps it there, ' +
              'so a non-workspace specifier resolves whatever a stranger publishes under that name ' +
              '(dependency confusion). Use "workspace:*".',
          );
          continue;
        }
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
  gate.note(
    `checked ${workspaceProjects.length} workspace manifest(s) for exact pins and ` +
      `${firstPartyScopes.size} first-party scope(s) for workspace-protocol use`,
  );
}

export function runDepShapesGate() {
  const gate = new Gate('dependency-shapes');
  return runGate(gate, () => {
    checkLockfileShape(gate, lockfileText());

    const { packages, workspaceProjects } = resolvedGraph();
    checkResolutionHosts(gate, packages);

    const installed = installedManifests();
    requireStoreCoverage(gate, storeCoverage(packages, installed), 'the install-hook scan');
    checkInstalledLifecycleHooks(gate, installed);

    checkWorkspaceManifests(gate, workspaceProjects);
  });
}

function runLockfileOnly(path) {
  const gate = new Gate(`dependency-shapes (lockfile only: ${path})`);
  return runGate(gate, () => {
    checkLockfileShape(gate, readFileSync(path, 'utf8'));
  });
}

if (import.meta.main) {
  const lockfileFlag = process.argv.indexOf('--lockfile');
  if (lockfileFlag !== -1) {
    const path = process.argv[lockfileFlag + 1];
    if (path === undefined) {
      console.error('--lockfile needs a path');
      process.exit(2);
    }
    await runLockfileOnly(path);
  } else {
    await runDepShapesGate();
  }
}
