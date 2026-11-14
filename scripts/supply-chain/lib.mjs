/**
 * Shared helpers for the supply-chain gates. Node standard library only, because a checker that
 * depends on third-party packages is checking the thing it depends on.
 *
 * `pnpm list -r` answers what we depend on, the manifests under `node_modules/.pnpm` answer what is
 * installed, and `pnpm-lock.yaml` answers how it was acquired and with which integrity hash.
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
 * Decodes a `link:` into the virtual store (how `pnpm list -r` reports a root devDependency seen
 * from a child project) back to its real version. A link outside the store is returned unchanged
 * so the caller fails on it.
 */
export function decodeStoreLink(version, nodePath) {
  if (typeof version !== 'string' || !version.startsWith('link:')) return null;
  if (typeof nodePath !== 'string') return { version, viaStoreLink: false };
  const storeRoot = join(REPO_ROOT, STORE_SEGMENT);
  if (!nodePath.startsWith(storeRoot)) return { version, viaStoreLink: false };
  const dirName = nodePath.slice(storeRoot.length).split(sep)[0];
  if (!dirName) return { version, viaStoreLink: false };
  // Strip pnpm's peer suffix, e.g. `next@16.3.0_@types+node@24.13.3_react@19.2.8`.
  const withoutPeers = dirName.split('_')[0] ?? dirName;
  const at = withoutPeers.lastIndexOf('@');
  if (at <= 0) return { version, viaStoreLink: false };
  return { version: withoutPeers.slice(at + 1), viaStoreLink: true };
}

function realpathOr(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True only for a link to one of this repository's workspace projects. Not `@prl/` by name: the
 * scope is unclaimed on npm, `.npmrc` maps it to the public registry, and pnpm 10 defaults
 * `link-workspace-packages` to false, so a name check would hide a dependency-confusion package
 * from every gate. An attacker controls the name, not the resolution.
 */
function isWorkspaceProjectLink(node, viaStoreLink, projectPaths) {
  if (viaStoreLink) return false;
  if (typeof node.version !== 'string' || !node.version.startsWith('link:')) return false;
  if (typeof node.resolved === 'string' && node.resolved !== '') return false;
  if (typeof node.path !== 'string' || node.path === '') return false;
  return projectPaths.has(realpathOr(node.path));
}

/**
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

  const projectPaths = new Set();
  for (const project of projects) {
    if (typeof project.path === 'string') projectPaths.add(realpathOr(project.path));
  }

  const visit = (node, name, dev, importer, parentKey) => {
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

/** Every package.json installed under node_modules/.pnpm, deduplicated by name@version. */
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
 * Every physical package root in the virtual store, deduplicated by realpath. pnpm gives one
 * directory per peer-dependency variant, and a file sweep must look inside each, at
 * `<store>/<pkg>@<ver>/node_modules/<pkg>/`. One level higher cannot see `.claude/setup.mjs` in any
 * dependency.
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
        // The deny-list gate reports an unparseable manifest; the directory is still swept.
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
 * Versions pnpm skipped for this platform (`os`/`cpu`/`libc` optionals), from the `skipped:` list in
 * `node_modules/.modules.yaml`. On macOS that is every Linux binary, which is what the release
 * container installs. Takes a root so `dep-shapes.test.mjs` can build the present, absent and
 * no-`skipped:` states on disk.
 *
 * @returns {{present: boolean, skipped: Set<string>}} `present:false` when the file is missing or
 *   unreadable.
 */
export function platformSkippedVersions(root = REPO_ROOT) {
  const path = join(root, 'node_modules', '.modules.yaml');
  if (!existsSync(path)) return { present: false, skipped: new Set() };
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { present: false, skipped: new Set() };
  }
  // pnpm 11 writes JSON, a subset of YAML. Block YAML falls back to a line read.
  try {
    const parsed = JSON.parse(raw);
    const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];
    return { present: true, skipped: new Set(skipped.map(String)) };
  } catch {
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

/** How much of the resolved graph the on-disk store accounts for. */
export function storeCoverage(resolvedPackages, installed, root = REPO_ROOT) {
  const storePresent = existsSync(join(root, 'node_modules', '.pnpm'));
  const { present: manifestPresent, skipped } = platformSkippedVersions(root);
  const uninspected = [];
  const platformSkipped = [];
  for (const key of resolvedPackages.keys()) {
    if (installed.has(key)) continue;
    if (skipped.has(key)) platformSkipped.push(key);
    else uninspected.push(key);
  }
  return {
    storePresent,
    // Drives only the diagnosis `requireStoreCoverage` prints. An unreadable file already fails
    // through `uninspected`. `dep-shapes.test.mjs` pins each state's text.
    skippedManifestPresent: manifestPresent,
    resolvedCount: resolvedPackages.size,
    installedCount: installed.size,
    platformSkipped: platformSkipped.sort(),
    uninspected: uninspected.sort(),
  };
}

/**
 * Refuses a pass over an empty or unexplained-partial store. Without it the lifecycle-hook scan
 * passed with no `node_modules`, having examined zero packages. Platform-skipped optionals are named,
 * and `provenance.mjs` inspects them from the registry.
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
    // The same headline has two causes. A readable skipped record means the store diverged from the
    // lockfile; an unreadable one means only pnpm's record is missing.
    const diagnosis = coverage.skippedManifestPresent
      ? 'pnpm DOES record a platform-skipped set for this machine and these versions are not in it, ' +
        'so the store and the lockfile genuinely disagree — reinstall with ' +
        '`pnpm install --frozen-lockfile` rather than trusting a partial scan.'
      : 'node_modules/.modules.yaml could not be read, so pnpm records NO platform-skipped set at ' +
        'all and the list above is every version absent from disk, not the unexplained ones. Do NOT ' +
        'read this as the store and the lockfile disagreeing: the store may be intact and only the ' +
        'pnpm record of it missing, which on a machine whose optionals are mostly other-platform ' +
        'binaries is the likelier reading. Restore the record with `pnpm install --frozen-lockfile` ' +
        'and re-run; if the list empties, the store was never the problem.';
    gate.fail(
      `${what} could not inspect ${coverage.uninspected.length} resolved package version(s) that are not on disk`,
      `${sample}${coverage.uninspected.length > 10 ? ', …' : ''}\n      ` +
        `These are in the resolved graph and absent from node_modules/.pnpm. ${diagnosis}`,
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

export const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'];
export const SOURCE_HOOKS = ['prepare', 'preprepare', 'postprepare', 'prepack', 'postpack'];

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
