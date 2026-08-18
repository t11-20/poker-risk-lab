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
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { IOC_HASHES, IOC_PATHS, IOC_STRINGS } from './denied-packages.mjs';
import { Gate, REPO_ROOT, runGate } from './lib.mjs';

const gate = new Gate('ioc-sweep');

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
]);

const MAX_SCAN_BYTES = 8 * 1024 * 1024;

/**
 * Files whose presence is *always* a compromise indicator in this repo, versus
 * files that are legitimate elsewhere and so are reported as warnings.
 */
const ALWAYS_MALICIOUS = new Set(['.claude/setup.mjs', '.vscode/setup.mjs', 'cat.py']);

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

await runGate(gate, () => {
  let filesScanned = 0;
  let bytesScanned = 0;
  const stringHits = [];
  const hashHits = [];

  // This scanner necessarily contains the IOC strings it searches for, so
  // skip it and its sibling definition/doc files to avoid a guaranteed self-hit.
  const SELF = new Set([
    'scripts/supply-chain/ioc-scan.mjs',
    'scripts/supply-chain/denied-packages.mjs',
    'docs/security/shai-hulud-snapshot-2026-08-17.md',
  ]);

  const scanFile = (full) => {
    const rel = relative(REPO_ROOT, full).split('\\').join('/');
    if (SELF.has(rel)) return;
    let size;
    try {
      size = statSync(full).size;
    } catch {
      return;
    }
    if (size > MAX_SCAN_BYTES) return;

    const ext = extensionOf(full);
    const isText = TEXT_EXTENSIONS.has(ext) || ext === '';
    if (!isText) return;

    let buf;
    try {
      buf = readFileSync(full);
    } catch {
      return;
    }
    filesScanned += 1;
    bytesScanned += buf.length;

    const sha256 = createHash('sha256').update(buf).digest('hex');
    const knownHash = IOC_HASHES.get(sha256);
    if (knownHash) hashHits.push({ rel, sha256, what: knownHash });

    const text = buf.toString('utf8');
    for (const { marker, why } of IOC_STRINGS) {
      if (text.includes(marker)) stringHits.push({ rel, marker, why });
    }
  };

  for (const full of walk(REPO_ROOT)) scanFile(full);
  const store = join(REPO_ROOT, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    for (const full of walk(store, { includeNodeModules: true })) scanFile(full);
  } else {
    gate.warn(
      'node_modules/.pnpm not present — the installed store was not swept',
      'run `pnpm install` before relying on this gate',
    );
  }

  for (const hit of hashHits) {
    gate.fail(`KNOWN MALICIOUS FILE HASH: ${hit.rel}`, `sha256 ${hit.sha256} — ${hit.what}`);
  }
  for (const hit of stringHits) {
    gate.fail(`IOC string in ${hit.rel}`, `"${hit.marker}" — ${hit.why}`);
  }

  // Persistence artefact paths, checked against the repo root and every installed package root.
  const roots = [REPO_ROOT];
  if (existsSync(store)) {
    for (const dir of readdirSync(store, { withFileTypes: true })) {
      if (!dir.isDirectory() && !dir.isSymbolicLink()) continue;
      roots.push(join(store, dir.name));
    }
  }
  for (const root of roots) {
    for (const iocPath of IOC_PATHS) {
      const candidate = join(root, iocPath);
      if (!existsSync(candidate)) continue;
      const rel = relative(REPO_ROOT, candidate).split('\\').join('/');
      if (ALWAYS_MALICIOUS.has(iocPath)) {
        gate.fail(
          `Mini Shai-Hulud persistence artefact present: ${rel}`,
          'this path has no legitimate use in this repository — treat the host as compromised and rotate credentials',
        );
      } else {
        gate.warn(
          `path matching a campaign IOC exists: ${rel}`,
          'the campaign injects a file at this path to name-squat a legitimate one. ' +
            'Confirm it is yours and was added deliberately; if not, treat the host as compromised.',
        );
      }
    }
  }

  gate.note(
    `swept ${filesScanned} files (${(bytesScanned / 1_048_576).toFixed(1)} MiB) for ${IOC_STRINGS.length} string markers, ${IOC_HASHES.size} hashes, ${IOC_PATHS.length} artefact paths`,
  );
});
