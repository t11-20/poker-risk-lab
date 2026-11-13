#!/usr/bin/env node
/**
 * Gate: sweep the working tree and the installed store for Mini Shai-Hulud indicators. The campaign
 * writes `.claude/setup.mjs` and `.vscode/tasks.json` into repositories so that opening the project
 * in an agent or editor re-runs the payload. IOC definitions live in ./denied-packages.mjs.
 *
 * Package files sit at `<store>/<pkg>@<ver>/node_modules/<pkg>/`, so the sweep walks physical
 * package roots; it once looked one level too high and found nothing. A missing or incomplete store
 * fails rather than warns.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { IOC_HASHES, IOC_PATHS, IOC_STRINGS } from './denied-packages.mjs';
import {
  Gate,
  installedManifests,
  installedPackageDirs,
  REPO_ROOT,
  requireStoreCoverage,
  resolvedGraph,
  runGate,
  storeCoverage,
} from './lib.mjs';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', '.turbo', '.pnpm-store']);

const TEXT_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.md',
  '.txt',
  '.toml',
  '.ini',
  '.env',
  '.lock',
  '.html',
  '.css',
  '.sql',
  // A config file can hide a C2 fetch in an `add_header` or a `proxy_pass`.
  '.conf',
]);

/**
 * Files identified by name. `extensionOf` gives `Dockerfile.api` `.api`, so the sweep once skipped
 * a `RUN curl … | sh` line or a `.dockerignore` that stopped excluding `.env`.
 */
const TEXT_NAMES = /^(?:Dockerfile(?:\..+)?|\.dockerignore|Caddyfile)$/;

const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Always a compromise indicator. The rest of IOC_PATHS is legitimate in a repository but not in a
 * published tarball (see `artefactSeverity`).
 */
const ALWAYS_MALICIOUS = new Set(['.claude/setup.mjs', '.vscode/setup.mjs', 'cat.py']);

/** This scanner contains the strings it searches for, so it and its definition files are skipped. */
const SELF = new Set([
  'scripts/supply-chain/ioc-scan.mjs',
  'scripts/supply-chain/denied-packages.mjs',
  'scripts/supply-chain/ioc-scan.test.mjs',
  'docs/security/shai-hulud-snapshot-2026-08-17.md',
]);

function* walk(dir, { includeNodeModules = false } = {}) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!includeNodeModules && SKIP_DIRS.has(entry.name)) continue;
      if (includeNodeModules && (entry.name === '.git' || entry.name === '.bin')) continue;
      yield* walk(full, { includeNodeModules });
      continue;
    }
    if (entry.isFile()) yield full;
  }
}

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(dot) : '';
}

/**
 * Takes roots as arguments so a test can point it at a fixture with a real payload marker.
 *
 * @param {{repoRoot: string, trees: Array<{dir: string, includeNodeModules?: boolean}>}} options
 */
export function sweepForMarkers({ repoRoot, trees }) {
  let filesScanned = 0;
  let bytesScanned = 0;
  // Counted so "0 container files swept" cannot read as "the container files are clean".
  let containerFilesScanned = 0;
  const stringHits = [];
  const hashHits = [];

  const scanFile = (full) => {
    const rel = relative(repoRoot, full).split('\\').join('/');
    if (SELF.has(rel)) return;
    let size;
    try {
      size = statSync(full).size;
    } catch {
      return;
    }
    if (size > MAX_SCAN_BYTES) return;

    const ext = extensionOf(full);
    const name = full.split(/[\\/]/).pop() ?? full;
    // The campaign's artefacts do not always carry an extension.
    const isText = TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.test(name) || ext === '';
    if (!isText) return;

    let buf;
    try {
      buf = readFileSync(full);
    } catch {
      return;
    }
    filesScanned += 1;
    bytesScanned += buf.length;
    if (TEXT_NAMES.test(name) || ext === '.conf') containerFilesScanned += 1;

    const sha256 = createHash('sha256').update(buf).digest('hex');
    const knownHash = IOC_HASHES.get(sha256);
    if (knownHash) hashHits.push({ rel, sha256, what: knownHash });

    const text = buf.toString('utf8');
    for (const { marker, why } of IOC_STRINGS) {
      if (text.includes(marker)) stringHits.push({ rel, marker, why });
    }
  };

  for (const tree of trees) {
    for (const full of walk(tree.dir, { includeNodeModules: tree.includeNodeModules === true })) {
      scanFile(full);
    }
  }
  return { filesScanned, bytesScanned, containerFilesScanned, stringHits, hashHits };
}

/**
 * @param {{repoRoot: string, roots: Array<{dir: string, kind: 'repo'|'dependency', label?: string}>}} options
 * @returns {Array<{rel: string, iocPath: string, kind: string, label: string|undefined, blocking: boolean}>}
 */
export function findPersistenceArtefacts({ repoRoot, roots }) {
  const hits = [];
  for (const root of roots) {
    for (const iocPath of IOC_PATHS) {
      const candidate = join(root.dir, iocPath);
      if (!existsSync(candidate)) continue;
      hits.push({
        rel: relative(repoRoot, candidate).split('\\').join('/'),
        iocPath,
        kind: root.kind,
        label: root.label,
        // Any of these paths in a published dependency blocks. At the repo root the editor and agent
        // config files are ordinary developer files, so they warn.
        blocking: root.kind === 'dependency' || ALWAYS_MALICIOUS.has(iocPath),
      });
    }
  }
  return hits;
}

export function runIocScanGate() {
  const gate = new Gate('ioc-sweep');

  return runGate(gate, () => {
    const store = join(REPO_ROOT, 'node_modules', '.pnpm');
    const storePresent = existsSync(store);

    const trees = [{ dir: REPO_ROOT }];
    if (storePresent) trees.push({ dir: store, includeNodeModules: true });

    const { filesScanned, bytesScanned, containerFilesScanned, stringHits, hashHits } = sweepForMarkers({
      repoRoot: REPO_ROOT,
      trees,
    });

    for (const hit of hashHits) {
      gate.fail(`KNOWN MALICIOUS FILE HASH: ${hit.rel}`, `sha256 ${hit.sha256} — ${hit.what}`);
    }
    for (const hit of stringHits) {
      gate.fail(`IOC string in ${hit.rel}`, `"${hit.marker}" — ${hit.why}`);
    }

    const packageDirs = installedPackageDirs();
    const roots = [
      { dir: REPO_ROOT, kind: /** @type {const} */ ('repo') },
      ...[...packageDirs.values()].map((p) => ({
        dir: p.dir,
        kind: /** @type {const} */ ('dependency'),
        label: p.name === null ? p.dir : `${p.name}@${p.version ?? '0.0.0'}`,
      })),
    ];
    for (const hit of findPersistenceArtefacts({ repoRoot: REPO_ROOT, roots })) {
      if (hit.blocking) {
        gate.fail(
          hit.kind === 'dependency'
            ? `Mini Shai-Hulud persistence artefact shipped by ${hit.label}: ${hit.rel}`
            : `Mini Shai-Hulud persistence artefact present: ${hit.rel}`,
          hit.kind === 'dependency'
            ? 'a published package has no legitimate reason to carry editor/agent task configuration; ' +
                'this is the campaign persistence vector — treat the host as compromised and rotate credentials'
            : 'this path has no legitimate use in this repository — treat the host as compromised and rotate credentials',
        );
      } else {
        gate.warn(
          `path matching a campaign IOC exists: ${hit.rel}`,
          'the campaign injects a file at this path to name-squat a legitimate one. ' +
            'Confirm it is yours and was added deliberately; if not, treat the host as compromised.',
        );
      }
    }

    if (!storePresent) {
      gate.fail(
        'node_modules/.pnpm not present — the installed store was not swept',
        'this gate exists to find payloads inside dependencies; with no store it examined ' +
          'first-party files only. Run `pnpm install --frozen-lockfile` and re-run the audit.',
      );
    } else {
      const { packages } = resolvedGraph();
      requireStoreCoverage(gate, storeCoverage(packages, installedManifests()), 'the IOC store sweep');
      gate.note(`swept ${packageDirs.size} physical package directories for persistence artefacts`);
    }

    gate.note(
      `swept ${filesScanned} files (${(bytesScanned / 1_048_576).toFixed(1)} MiB) for ${IOC_STRINGS.length} string markers, ${IOC_HASHES.size} hashes, ${IOC_PATHS.length} artefact paths`,
    );

    // A lower bound. Three today: Dockerfile.api, Dockerfile.web and .dockerignore, plus proxy config.
    if (containerFilesScanned < 3) {
      gate.fail(
        `only ${containerFilesScanned} container/config file(s) were swept`,
        'Dockerfile.api, Dockerfile.web and .dockerignore were invisible to this sweep until the ' +
          'name-based rule was added, and they are where a build-time fetch to a campaign host would ' +
          'live. Fewer than three means one has dropped out again.',
      );
    } else {
      gate.note(`${containerFilesScanned} of those were Dockerfiles, .dockerignore or proxy configuration`);
    }
  });
}

if (import.meta.main) await runIocScanGate();
