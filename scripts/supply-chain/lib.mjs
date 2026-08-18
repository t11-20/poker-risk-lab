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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

  const visit = (node, name, dev, importer, parentKey) => {
    // A workspace link has no `resolved` registry URL; recurse but do not treat it
    // as a third-party package.
    const decoded = decodeStoreLink(node.version, node.path);
    const version = decoded ? decoded.version : (node.version ?? '0.0.0');
    const viaStoreLink = decoded?.viaStoreLink === true;
    const key = `${name}@${version}`;
    if (parentKey) edges.add(`${parentKey} ${key}`);
    const isWorkspaceLink = name.startsWith('@prl/');
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
