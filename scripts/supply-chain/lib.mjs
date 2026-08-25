/**
 * Shared helpers for the supply-chain gates.
 *
 * Deliberately dependency-free: a supply-chain checker that pulls in third-party
 * packages to do its job is checking the thing it depends on. Everything here uses
 * only the Node standard library.
 *
 * Three sources of truth, used for different questions:
 *   1. `pnpm list -r --depth Infinity --json` — the *logical* resolved graph
 *      (names, versions, registry URLs, dev vs prod). Authoritative for "what do we depend on".
 *   2. The on-disk manifests under `node_modules/.pnpm` — the *actual installed* packages.
 *      Authoritative for "what does this code declare" (lifecycle scripts, bin entries).
 *   3. `pnpm-lock.yaml` text — authoritative for "how was this acquired"
 *      (registry tarball vs git vs remote tarball) and for integrity hashes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LOCKFILE = join(REPO_ROOT, 'pnpm-lock.yaml');
export const WORKSPACE_YAML = join(REPO_ROOT, 'pnpm-workspace.yaml');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
export const red = (s) => paint('31', s);
export const green = (s) => paint('32', s);
export const yellow = (s) => paint('33', s);
export const dim = (s) => paint('2', s);
export const bold = (s) => paint('1', s);

/** A gate reports findings; a non-empty `failures` array fails the build. */
export class Gate {
  constructor(name) {
    this.name = name;
    this.failures = [];
    this.warnings = [];
    this.notes = [];
  }

  fail(message, detail) {
    this.failures.push(detail === undefined ? { message } : { message, detail });
  }

  warn(message, detail) {
    this.warnings.push(detail === undefined ? { message } : { message, detail });
  }

  note(message) {
    this.notes.push(message);
  }

  /** Print a human-readable report and return the process exit code. */
  report() {
    const head = `${bold(this.name)}`;
    for (const n of this.notes) console.log(`${dim('  ·')} ${n}`);
    for (const w of this.warnings) {
      console.log(`${yellow('  ! ')}${w.message}`);
      if (w.detail) console.log(dim(`      ${w.detail}`));
    }
    for (const f of this.failures) {
      console.log(`${red('  ✗ ')}${f.message}`);
      if (f.detail) console.log(dim(`      ${f.detail}`));
    }
    if (this.failures.length === 0) {
      console.log(
        `${green('  ✓')} ${head} — pass${this.warnings.length ? ` (${this.warnings.length} warning(s))` : ''}`,
      );
      return 0;
    }
    console.log(`${red('  ✗')} ${head} — ${this.failures.length} failure(s)`);
    return 1;
  }
}

export function runGate(gate, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      const code = gate.report();
      process.exitCode = code;
      return code;
    })
    .catch((err) => {
      console.log(`${red('  ✗')} ${bold(gate.name)} — gate crashed: ${err?.message ?? err}`);
      if (process.env.PRL_DEBUG) console.error(err);
      process.exitCode = 1;
      return 1;
    });
}

/** Read the pnpm lockfile as text. Fails closed if it is missing. */
export function lockfileText() {
  if (!existsSync(LOCKFILE)) {
    throw new Error(`pnpm-lock.yaml not found at ${LOCKFILE}. Run \`pnpm install\` first.`);
  }
  return readFileSync(LOCKFILE, 'utf8');
}

export function workspaceYamlText() {
  if (!existsSync(WORKSPACE_YAML)) throw new Error(`pnpm-workspace.yaml not found at ${WORKSPACE_YAML}`);
  return readFileSync(WORKSPACE_YAML, 'utf8');
}

const STORE_SEGMENT = `${join('node_modules', '.pnpm')}${sep}`;

/**
 * `pnpm list -r` reports a root devDependency, as seen from a child workspace
 * project, as a `link:` into the virtual store rather than as a registry
 * resolution — e.g. version `link:../../node_modules/.pnpm/axe-core@4.13.0/...`.
 * That is not a real off-registry dependency, so decode it back to the true
 * name@version instead of treating it as a policy violation.
 *
 * A `link:` whose realpath is NOT inside this repo's virtual store is a genuine
 * finding and is returned unchanged so the caller fails on it.
 *
 * @returns {{version: string, viaStoreLink: boolean} | null}
 */
export function decodeStoreLink(version, nodePath) {
  if (typeof version !== 'string' || !version.startsWith('link:')) return null;
  if (typeof nodePath !== 'string') return { version, viaStoreLink: false };
  const storeRoot = join(REPO_ROOT, STORE_SEGMENT);
  if (!nodePath.startsWith(storeRoot)) return { version, viaStoreLink: false };
  // <storeRoot><dirName>/node_modules/<pkg name>
  const dirName = nodePath.slice(storeRoot.length).split(sep)[0];
  if (!dirName) return { version, viaStoreLink: false };
  // Strip the peer-dependency suffix pnpm appends after the first underscore,
  // e.g. `next@16.3.0_@types+node@24.13.3_react@19.2.8`.
  const withoutPeers = dirName.split('_')[0] ?? dirName;
  const at = withoutPeers.lastIndexOf('@');
  if (at <= 0) return { version, viaStoreLink: false };
  return { version: withoutPeers.slice(at + 1), viaStoreLink: true };
}

/** Best-effort realpath: an unresolvable path is returned as given. */
function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when a `pnpm list` node is genuinely a link to a workspace project in
 * this repository, rather than a third-party package that merely *looks* like
 * one.
 *
 * ## Why this is not `name.startsWith('@prl/')`
 *
 * It used to be. Every name in the first-party scope was dropped from the
 * resolved graph, which meant it was invisible to the deny list, the resolution
 * host check, the integrity and release-age checks, the OSV query and the
 * third-party half of the SBOM. Meanwhile the `@prl` scope is **unclaimed on
 * npm** (404 for every name), `.npmrc` maps `@prl:registry` to the *public*
 * registry, and pnpm ≥ 10 defaults `link-workspace-packages` to false — so a
 * specifier of `"@prl/x": "1.0.0"` instead of `"workspace:*"` resolves a
 * stranger's package off the public registry, and not one of the eight gates
 * would have looked at it. That is textbook dependency confusion, made worse by
 * the auditor going quiet at exactly the moment it mattered.
 *
 * A name is what an attacker controls. The *resolution* is not. So the test is:
 * pnpm resolved this to a `link:`, the link does not point into the virtual
 * store (which is how a real registry package can appear as a link), and the
 * directory it points at is one of this repository's own workspace projects.
 *
 * @param {{version?: string, path?: string, resolved?: string}} node
 * @param {boolean} viaStoreLink  the link decodes to a package in node_modules/.pnpm
 * @param {Set<string>} projectPaths  realpaths of every workspace project
 */
function isWorkspaceProjectLink(node, viaStoreLink, projectPaths) {
  if (viaStoreLink) return false;
  if (typeof node.version !== 'string' || !node.version.startsWith('link:')) return false;
  // A workspace link is resolved from disk, never downloaded.
  if (typeof node.resolved === 'string' && node.resolved !== '') return false;
  if (typeof node.path !== 'string' || node.path === '') return false;
  return projectPaths.has(realpathOr(node.path));
}

/**
 * Flattened resolved dependency graph.
 *
 * @returns {{
 *   packages: Map<string, {name: string, version: string, resolved: string|null, path: string|null, dev: boolean, viaStoreLink: boolean, importers: Set<string>}>,
 *   edges: Set<string>,
 *   workspaceProjects: Array<{name: string, version: string, path: string}>,
 * }}
 */
export function resolvedGraph() {
  let raw;
  try {
    raw = execFileSync('pnpm', ['list', '-r', '--depth', 'Infinity', '--json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    throw new Error(`\`pnpm list\` failed — cannot read the dependency graph: ${err?.message ?? err}`);
  }
  const projects = JSON.parse(raw);
  const packages = new Map();
  const edges = new Set();
  const workspaceProjects = [];

  // Collected before the walk, because deciding whether a node is a workspace
  // link needs the full set of project directories.
  const projectPaths = new Set();
  for (const project of projects) {
    if (typeof project.path === 'string') projectPaths.add(realpathOr(project.path));
  }

  const visit = (node, name, dev, importer, parentKey) => {
    // A workspace link has no `resolved` registry URL; recurse but do not treat it
    // as a third-party package.
    const decoded = decodeStoreLink(node.version, node.path);
    const version = decoded ? decoded.version : (node.version ?? '0.0.0');
    const viaStoreLink = decoded?.viaStoreLink === true;
    const key = `${name}@${version}`;
    if (parentKey) edges.add(`${parentKey} ${key}`);
    const isWorkspaceLink = isWorkspaceProjectLink(node, viaStoreLink, projectPaths);
    if (!isWorkspaceLink) {
      const existing = packages.get(key);
      if (existing) {
        existing.dev = existing.dev && dev;
        existing.importers.add(importer);
        // Prefer a real registry URL over a store link, in whichever order we met them.
        if (!existing.resolved && node.resolved) existing.resolved = node.resolved;
        if (!viaStoreLink) existing.viaStoreLink = false;
      } else {
        packages.set(key, {
          name,
          version,
          resolved: node.resolved ?? null,
          path: node.path ?? null,
          dev,
          viaStoreLink,
          importers: new Set([importer]),
        });
      }
    }
    if (node.dependencies) {
      for (const [childName, child] of Object.entries(node.dependencies)) {
        visit(child, childName, dev, importer, key);
      }
    }
  };

  for (const project of projects) {
    workspaceProjects.push({ name: project.name, version: project.version, path: project.path });
    const projKey = `${project.name}@${project.version}`;
    for (const [section, dev] of [
      ['dependencies', false],
      ['optionalDependencies', false],
      ['devDependencies', true],
      ['unsavedDependencies', true],
    ]) {
      const bag = project[section];
      if (!bag) continue;
      for (const [name, node] of Object.entries(bag)) {
        visit(node, name, dev, project.name, projKey);
      }
    }
  }
  return { packages, edges, workspaceProjects };
}

/**
 * Every package.json physically installed under node_modules/.pnpm, deduplicated
 * by name@version. This is what would actually execute.
 */
export function installedManifests() {
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  const found = new Map();
  if (!existsSync(store)) return found;

  const readManifestsIn = (nodeModulesDir) => {
    let entries;
    try {
      entries = readdirSync(nodeModulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name === '.pnpm') continue;
      const full = join(nodeModulesDir, entry.name);
      if (entry.name.startsWith('@')) {
        readManifestsIn(full);
        continue;
      }
      const manifestPath = join(full, 'package.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (typeof manifest.name !== 'string') continue;
        const key = `${manifest.name}@${manifest.version ?? '0.0.0'}`;
        if (!found.has(key)) found.set(key, { manifest, manifestPath, dir: full });
      } catch {
        // A package.json we cannot parse is itself suspicious; surface it.
        found.set(`UNPARSEABLE:${manifestPath}`, { manifest: null, manifestPath, dir: full });
      }
    }
  };

  for (const dir of readdirSync(store, { withFileTypes: true })) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const nm = join(store, dir.name, 'node_modules');
    if (existsSync(nm)) readManifestsIn(nm);
  }
  return found;
}

/**
 * Every *physical* package root in the virtual store, deduplicated by realpath.
 *
 * `installedManifests()` deduplicates by `name@version`, which is right for
 * "what would execute" but wrong for "sweep every directory on disk": pnpm gives
 * a package one physical directory per peer-dependency variant, and the sweep
 * has to look inside all of them.
 *
 * The distinction is exactly the bug this exists to fix. `ioc-scan.mjs` checked
 * for persistence artefacts at `<store>/<pkg>@<ver>/.claude/setup.mjs`, a
 * directory level pnpm never populates — the package's files live one level
 * further down, at `<store>/<pkg>@<ver>/node_modules/<pkg>/`. So the check that
 * the gate's own header gives as its reason to exist ("it writes
 * `.claude/setup.mjs` and `.vscode/tasks.json` into repositories") could not see
 * a dependency shipping either file.
 *
 * @returns {Map<string, {name: string|null, version: string|null, dir: string}>} keyed by realpath
 */
export function installedPackageDirs() {
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  /** @type {Map<string, {name: string|null, version: string|null, dir: string}>} */
  const dirs = new Map();
  if (!existsSync(store)) return dirs;

  const collectIn = (nodeModulesDir) => {
    let entries;
    try {
      entries = readdirSync(nodeModulesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.bin' || entry.name === '.pnpm') continue;
      const full = join(nodeModulesDir, entry.name);
      if (entry.name.startsWith('@')) {
        collectIn(full);
        continue;
      }
      const manifestPath = join(full, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const real = realpathOr(full);
      if (dirs.has(real)) continue;
      let name = null;
      let version = null;
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        name = typeof manifest.name === 'string' ? manifest.name : null;
        version = typeof manifest.version === 'string' ? manifest.version : null;
      } catch {
        // An unparseable manifest is reported by the deny-list gate; here we
        // still want the directory swept.
      }
      dirs.set(real, { name, version, dir: real });
    }
  };

  for (const dir of readdirSync(store, { withFileTypes: true })) {
    if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
    const nm = join(store, dir.name, 'node_modules');
    if (existsSync(nm)) collectIn(nm);
  }
  return dirs;
}

/**
 * Versions pnpm deliberately did not install because they do not apply to this
 * platform — the `os`/`cpu`/`libc`-gated optional dependencies. pnpm records them
 * in `node_modules/.modules.yaml` under `skipped:`.
 *
 * They matter because they are the difference between "the store contains
 * everything" and "the store contains 104 of 162 versions". On macOS the skipped
 * set is every Linux binary — precisely the set that IS installed in the release
 * container.
 *
 * @returns {{present: boolean, skipped: Set<string>}} `present:false` when the
 *   file is missing or unreadable, which is itself a reason not to trust a
 *   coverage claim.
 */
export function platformSkippedVersions() {
  const path = join(REPO_ROOT, 'node_modules', '.modules.yaml');
  if (!existsSync(path)) return { present: false, skipped: new Set() };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { present: false, skipped: new Set() };
  }
  // pnpm 11 writes this file as JSON (a subset of YAML), so it parses directly.
  // If a future pnpm reverts to block YAML, fall back to reading the `skipped:`
  // list line by line rather than pretending the set is empty.
  try {
    const parsed = JSON.parse(raw);
    const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];
    return { present: true, skipped: new Set(skipped.map(String)) };
  } catch {
    // Block-YAML fallback, read line by line: `skipped:` on its own line
    // followed by an indented `- name@version` list.
    const skipped = new Set();
    let sawKey = false;
    let inList = false;
    for (const line of raw.split('\n')) {
      if (/^\s*skipped:\s*$/.test(line)) {
        sawKey = true;
        inList = true;
        continue;
      }
      if (!inList) continue;
      const item = /^\s+-\s*(\S+)\s*$/.exec(line);
      if (item !== null && item[1] !== undefined) {
        skipped.add(item[1]);
        continue;
      }
      if (line.trim() !== '') inList = false;
    }
    return { present: sawKey, skipped };
  }
}

/**
 * How much of the resolved graph the on-disk store actually accounts for.
 *
 * @param {Map<string, unknown>} resolvedPackages  keyed `name@version`
 * @param {Map<string, unknown>} installed         keyed `name@version`
 */
export function storeCoverage(resolvedPackages, installed) {
  const storePresent = existsSync(join(REPO_ROOT, 'node_modules', '.pnpm'));
  const { present: manifestPresent, skipped } = platformSkippedVersions();
  const uninspected = [];
  const platformSkipped = [];
  for (const key of resolvedPackages.keys()) {
    if (installed.has(key)) continue;
    if (skipped.has(key)) platformSkipped.push(key);
    else uninspected.push(key);
  }
  return {
    storePresent,
    /**
     * Whether `node_modules/.modules.yaml` could be read. Computed here and, for
     * a while, read by nobody — which is the same shape as the gates that judged
     * fewer things than they claimed, so it is now reported in the failure detail
     * of `requireStoreCoverage`. It cannot be a gate of its own: when the file is
     * missing, `platformSkippedVersions()` returns an empty skipped set, so every
     * version absent from disk lands in `uninspected` and fails there. What it
     * adds is the reason — "pnpm's own record of what it skipped is missing" is a
     * different remedy from "the store and the lockfile disagree".
     */
    skippedManifestPresent: manifestPresent,
    resolvedCount: resolvedPackages.size,
    installedCount: installed.size,
    /** In the resolved graph, absent from disk, and pnpm says it skipped them for this platform. */
    platformSkipped: platformSkipped.sort(),
    /** In the resolved graph, absent from disk, and nothing explains why. */
    uninspected: uninspected.sort(),
  };
}

/**
 * Refuses to let a store-reading gate report success over an empty or
 * unexplained-partial store.
 *
 * `repo-hygiene.mjs` already states the principle for its own scan — *"a scan of
 * nothing proves nothing"* — and it is the only gate that applied it. Three
 * others read the installed store and, with no `node_modules`, passed having
 * examined zero packages: the install-time lifecycle-hook scan (the control
 * against the campaign's delivery Pattern A) printed `✓ dependency-shapes —
 * pass` with no note and no warning. A green light that means "I found nothing"
 * and "I looked at nothing" indistinguishably is not a gate.
 *
 * Platform-skipped optionals are reported by name rather than waved through:
 * they are not inspected *here*, and `provenance.mjs` inspects them against the
 * registry, so the audit as a whole still covers every version.
 *
 * @param {Gate} gate
 * @param {ReturnType<typeof storeCoverage>} coverage
 * @param {string} what  what this gate reads the store for, named in the message
 */
export function requireStoreCoverage(gate, coverage, what) {
  if (!coverage.storePresent || coverage.installedCount === 0) {
    gate.fail(
      `${what} inspected 0 of ${coverage.resolvedCount} resolved package versions`,
      'node_modules/.pnpm is missing or empty, so this check examined nothing at all. ' +
        'A scan of nothing proves nothing — run `pnpm install --frozen-lockfile` and re-run the audit.',
    );
    return false;
  }
  if (coverage.uninspected.length > 0) {
    const sample = coverage.uninspected.slice(0, 10).join(', ');
    gate.fail(
      `${what} could not inspect ${coverage.uninspected.length} resolved package version(s) that are not on disk`,
      `${sample}${coverage.uninspected.length > 10 ? ', …' : ''}\n      ` +
        'These are in the resolved graph but absent from node_modules/.pnpm, and pnpm does not ' +
        'record them as platform-skipped. The store and the lockfile disagree — reinstall with ' +
        '`pnpm install --frozen-lockfile` rather than trusting a partial scan.' +
        (coverage.skippedManifestPresent === false
          ? '\n      node_modules/.modules.yaml could not be read either, so pnpm’s own record of what ' +
            'it skipped for this platform was unavailable: some of the above may be platform-skipped ' +
            'optionals rather than genuinely missing.'
          : ''),
    );
    return false;
  }
  if (coverage.platformSkipped.length > 0) {
    gate.note(
      `${what} covered ${coverage.installedCount}/${coverage.resolvedCount} versions on disk; ` +
        `${coverage.platformSkipped.length} are optional dependencies pnpm skipped for this platform ` +
        '(os/cpu/libc mismatch) and are inspected from the registry by the integrity+release-age gate',
    );
  } else {
    gate.note(`${what} covered all ${coverage.installedCount}/${coverage.resolvedCount} resolved versions`);
  }
  return true;
}

/** Lifecycle hooks that a package manager may execute at install time. */
export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
/** Hooks that run for git/local installs (not registry tarballs) but still matter. */
export const SOURCE_HOOKS = ['prepare', 'preprepare', 'postprepare', 'prepack', 'postpack'];

/** Small concurrency-limited map, for the network-backed gates. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** fetch with a hard timeout and bounded retries; no third-party HTTP client. */
export async function fetchJson(
  url,
  { method = 'GET', body, timeoutMs = 20_000, retries = 2, headers = {} } = {},
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json', ...headers } : headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}
