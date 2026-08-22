#!/usr/bin/env node
/**
 * Gate: sweep the working tree and the installed store for Mini Shai-Hulud
 * indicators of compromise.
 *
 * The campaign's persistence artefacts are the reason this exists as a separate
 * gate rather than a note in a doc: it writes `.claude/setup.mjs` and
 * `.vscode/tasks.json` into repositories so that opening the project in an agent
 * or editor re-runs the payload. A dependency audit alone would not see that.
 *
 * IOC definitions live in ./denied-packages.mjs so there is one place to update
 * when the next advisory lands.
 *
 * ## Two defects this file used to have, so they are not reintroduced
 *
 * 1. The persistence-path sweep looked at `<store>/<pkg>@<ver>/`. pnpm puts the
 *    package's own files one level further down, at
 *    `<store>/<pkg>@<ver>/node_modules/<pkg>/`, so the sweep read directories
 *    that contain nothing but a `node_modules` entry and found nothing by
 *    construction. A dependency shipping `.claude/setup.mjs` — the exact
 *    scenario in the paragraph above — was undetectable by path. It now sweeps
 *    the physical package roots (`installedPackageDirs()` in lib.mjs).
 *
 * 2. A missing store produced a warning and exit 0. "The store is clean" and
 *    "there is no store" printed differently and exited identically, which makes
 *    the sweep's green light unreadable. A missing or materially incomplete
 *    store is now a failure.
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

/** Directories never worth walking. `node_modules/.pnpm` IS walked, separately. */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'coverage', '.turbo', '.pnpm-store']);

/** Only text-ish files are string-scanned. */
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
  // Proxy and server configuration: `deploy/staging/nginx.conf` is executable
  // policy, and a config file is a perfectly good place to hide a fetch to a C2
  // host in an `add_header` or a `proxy_pass`.
  '.conf',
]);

/**
 * Text files whose NAME identifies them rather than their extension.
 *
 * `extensionOf('Dockerfile.api')` is `.api` and `extensionOf('.dockerignore')` is
 * `.dockerignore`; neither is in the set above, so the sweep skipped both. That is
 * a real gap rather than a tidy-up: a `RUN curl … | sh` line pointing at a
 * campaign host, or a `.dockerignore` edited to stop excluding `.env` so that
 * credentials ship in an image layer, are both exactly the kind of change this
 * sweep is meant to notice, and both live in files it could not read. The bare
 * `Dockerfile` and `Caddyfile` were already covered only by the extensionless
 * fallback below, which is luck rather than intent.
 */
const TEXT_NAMES = /^(?:Dockerfile(?:\..+)?|\.dockerignore|Caddyfile)$/;

const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Files whose presence is *always* a compromise indicator, wherever they appear.
 * Everything else in IOC_PATHS is a file that is legitimate in somebody's
 * repository — but not inside a published npm tarball, which is why the
 * dependency sweep treats the whole list as blocking (see `artefactSeverity`).
 */
const ALWAYS_MALICIOUS = new Set(['.claude/setup.mjs', '.vscode/setup.mjs', 'cat.py']);

/**
 * This scanner necessarily contains the IOC strings it searches for, so skip it
 * and its sibling definition/doc files to avoid a guaranteed self-hit.
 */
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
 * String- and hash-scans a tree.
 *
 * Takes its roots as arguments rather than reading REPO_ROOT directly, so a test
 * can point it at a fixture tree containing a real payload marker.
 *
 * @param {{repoRoot: string, trees: Array<{dir: string, includeNodeModules?: boolean}>}} options
 */
export function sweepForMarkers({ repoRoot, trees }) {
  let filesScanned = 0;
  let bytesScanned = 0;
  /**
   * Counted separately and reported by the gate, because "0 container files
   * swept" and "the container files are clean" printed identically for as long as
   * `TEXT_NAMES` did not exist, and a coverage number is the only thing that tells
   * those two apart from the outside.
   */
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
    // The extensionless fallback stays: a shell script or a config file with no
    // suffix is still text, and the campaign's own artefacts do not advertise
    // themselves with a helpful extension.
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
 * Looks for campaign persistence artefacts under a set of roots.
 *
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
        // Inside a published dependency every one of these paths is anomalous:
        // a tarball has no business carrying editor or agent task configuration,
        // and that is precisely the campaign's persistence vector. At the repo
        // root, the two editor/agent *config* files are ordinary developer files,
        // so they warn instead of blocking.
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

    // Persistence artefacts: the repo root, and every *physical package root* in
    // the store — not the store's own subdirectories, which hold no package files.
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

    // A sweep of an absent store is not a clean sweep. Report the coverage the
    // same way the other store-reading gates do, and fail rather than warn.
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

    // Three today: Dockerfile.api, Dockerfile.web and .dockerignore, plus the
    // proxy configuration. A lower bound rather than an equality, for the same
    // reason repo-hygiene states one: adding a Dockerfile must not fail the gate,
    // but losing one from the sweep is the defect this count exists to catch.
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
