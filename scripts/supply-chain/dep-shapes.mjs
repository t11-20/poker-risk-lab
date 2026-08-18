#!/usr/bin/env node
/**
 * Gate: every dependency must have an acceptable *shape*.
 *
 * Fails on:
 *   - resolution from anywhere other than registry.npmjs.org (git, remote tarball, CDN, file:)
 *   - any package declaring an install-time lifecycle hook (preinstall/install/postinstall)
 *   - a store that cannot account for the resolved graph, so the hook scan means something
 *   - any workspace manifest declaring a version range instead of an exact version
 *   - any first-party (`@prl/…`) specifier that does not use the `workspace:` protocol
 *   - a lockfile whose version we do not understand
 *
 * Warns on source-time hooks (`prepare` etc.), which registry installs do not run
 * but which would run if the dependency were ever switched to a git reference.
 *
 * ## The acquisition-channel check reads structure, not text
 *
 * It used to be six regexes over the raw lockfile. Four were anchored to the
 * start of a line and pnpm writes `resolution:` inline on one line, so they were
 * unreachable; the other two looked for `git+ssh://` and an off-registry `.tgz`
 * URL, and pnpm records a git dependency as `repo: github.com/owner/repo` with no
 * scheme and a directory dependency with no URL at all. Against a lockfile
 * carrying a real pnpm-format git resolution and a real pnpm-format directory
 * resolution, **0 of the 6 matched**. This is the control
 * `docs/security/shai-hulud-snapshot-2026-08-17.md` §5 names against the
 * campaign's delivery Pattern B (poisoned git dependency with a `prepare` hook),
 * and it could not fail.
 *
 * So the resolution is parsed into an object and every key is judged, with an
 * explicit allowlist of the two keys a registry acquisition may carry. A new
 * acquisition channel therefore fails the gate loudly instead of passing through
 * a gap between patterns. `scripts/supply-chain/dep-shapes.test.mjs` feeds it the
 * exact bytes pnpm emits for both hostile shapes and asserts it fails.
 *
 * Usage:
 *   node scripts/supply-chain/dep-shapes.mjs
 *   node scripts/supply-chain/dep-shapes.mjs --lockfile <path>   (acquisition-channel checks only)
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
 * The only two keys a registry acquisition may carry in `resolution: {…}`.
 *
 * Fail-closed on purpose. `type`, `repo`, `commit`, `directory`, `path` are the
 * keys pnpm writes for git, remote-tarball and local-directory resolutions, and
 * an unknown key means pnpm has learned an acquisition channel this gate has not
 * been taught to judge. Failing on it is the safe direction: the message says
 * what to do, and the alternative is a channel that passes because nobody
 * thought to forbid it.
 */
const ALLOWED_RESOLUTION_KEYS = new Set(['integrity', 'tarball']);

/** Why each known non-registry resolution key is a finding, in the gate's words. */
const NON_REGISTRY_KEYS = new Map([
  ['type', 'non-registry resolution type'],
  ['repo', 'git repository resolution'],
  ['commit', 'git commit resolution'],
  ['directory', 'local directory resolution'],
  ['path', 'local path resolution'],
]);

/**
 * Version strings pnpm writes in `importers:` for a registry dependency —
 * `5.11.3`, or `5.11.3(react@19.2.8)` with the peer suffix.
 */
const IMPORTER_REGISTRY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?(?:\(.*\))?$/;

/**
 * Check 1 — the lockfile acquired everything from the registry.
 *
 * Pure over the lockfile text so a test (and `--lockfile`, which quarantine.mjs
 * uses on a freshly resolved candidate) can run it without an installed tree.
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

  // ---- resolution objects, key by key ------------------------------------
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

  // ---- importer edges ------------------------------------------------------
  // A git, `file:` or directory dependency also shows up here, and this is where
  // a first-party name resolved off the public registry would be visible.
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

  // ---- raw-text backstop ---------------------------------------------------
  // Kept because it sees the whole file, including anything outside the two
  // sections parsed above. It is a backstop, NOT the check: every pattern here
  // missed the real pnpm-format attack, which is why the structured check exists.
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
 * Check 2 — every resolved package came from an allowed host.
 *
 * @param {Gate} gate
 * @param {Map<string, {name: string, resolved: string|null, importers: Set<string>}>} packages
 */
export function checkResolutionHosts(gate, packages) {
  for (const [key, pkg] of packages) {
    if (!pkg.resolved) {
      // No resolution URL: either a genuine workspace link (filtered out already,
      // by resolution and not by name — see lib.mjs) or a link:/file: dependency.
      // The latter is unexpected for a third-party package.
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
 * Check 3 — no installed package declares an install-time lifecycle hook.
 *
 * This is the control against the campaign's delivery Pattern A. It used to
 * report `✓ pass` over an empty store with no output whatsoever, so
 * `requireStoreCoverage` runs first: the hook scan is only allowed to mean
 * anything once the store demonstrably accounts for the resolved graph.
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
 * Check 4 — workspace manifests pin exactly, and first-party names never
 * resolve from a registry.
 *
 * The second half is the manifest-level half of the dependency-confusion fix.
 * The `@prl` scope is unclaimed on npm and `.npmrc` maps it to the *public*
 * registry, so `"@prl/poker-math": "1.0.0"` — one character away from
 * `"workspace:*"`, and a perfectly plausible typo or malicious PR — fetches a
 * stranger's package. The first-party names and scopes are derived from the
 * workspace itself rather than hardcoded, so adding a package extends the
 * protection automatically.
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

/** The whole gate, against the real repository. */
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

/** `--lockfile <path>`: acquisition-channel checks only, against an arbitrary file. */
function runLockfileOnly(path) {
  const gate = new Gate(`dependency-shapes (lockfile only: ${path})`);
  return runGate(gate, () => {
    checkLockfileShape(gate, readFileSync(path, 'utf8'));
  });
}

// Only self-executes as a CLI, so the checks above can be imported and fed
// hostile fixtures by scripts/supply-chain/dep-shapes.test.mjs.
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
