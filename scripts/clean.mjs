#!/usr/bin/env node
/**
 * Deletes build output across the workspace: `dist/`, `.next/`, `coverage/` and `*.tsbuildinfo`.
 *
 * Unlike `find . -name dist -exec rm -rf`, the walk never enters `node_modules` (installed packages
 * ship `dist/` too), never follows symlinks, and refuses anything outside the repository root.
 * `--dry-run` deletes nothing. `node_modules`, `.env` and `docs/sbom/*.json` are not touched.
 */

import { readdirSync, rmSync, statSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const yellow = (s) => paint('33', s);
const green = (s) => paint('32', s);

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
${bold('pnpm run clean')} — remove build output from this workspace

  Deletes, anywhere under the repository root except node_modules:
    dist/          compiled TypeScript output
    .next/         Next.js build output
    coverage/      coverage reports
    *.tsbuildinfo  incremental compilation state

  Options:
    -n, --dry-run   list what would be deleted, delete nothing
    -h, --help      this text

  Does not touch node_modules. To reset dependencies instead:
    rm -rf node_modules && pnpm install --frozen-lockfile
`);
  process.exit(0);
}

const DO_NOT_DESCEND = new Set(['node_modules', '.git', '.pnpm-store']);

// Make sure a new target cannot appear inside a dependency for a legitimate reason.
const DELETE_DIRS = new Set(['dist', '.next', 'coverage']);
const DELETE_SUFFIX = '.tsbuildinfo';

// The `+ sep` stops /x/poker-risk-lab from accepting /x/poker-risk-lab-backup.
function isInsideRepo(candidate) {
  if (candidate === REPO_ROOT) return true;
  return candidate.startsWith(REPO_ROOT + sep);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function sizeOf(path) {
  let total = 0;
  const stack = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      try {
        total += statSync(current).size;
      } catch {
        // Vanished between listing and stat.
      }
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      try {
        total += statSync(full).size;
      } catch {
        // Vanished between listing and stat.
      }
    }
  }
  return total;
}

function collect(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.log(yellow(`  ! cannot read ${relative(REPO_ROOT, dir)}: ${err.message}`));
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (DO_NOT_DESCEND.has(entry.name)) continue;
      if (DELETE_DIRS.has(entry.name)) {
        found.push({ path: full, kind: 'dir' });
        continue;
      }
      collect(full, found);
      continue;
    }
    // A symlink where a build directory should be is refused loudly below.
    if (entry.isSymbolicLink()) {
      if (DELETE_DIRS.has(entry.name) || entry.name.endsWith(DELETE_SUFFIX)) {
        found.push({ path: full, kind: 'symlink' });
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(DELETE_SUFFIX)) {
      found.push({ path: full, kind: 'file' });
    }
  }
}

// Canonicalises the candidate's parent, not the candidate: the candidate may be a symlink, and what
// matters is that the entry being removed lives inside the repository.
async function verifySafe(candidatePath, realRoot) {
  const parentReal = await realpath(dirname(candidatePath));
  const resolvedCandidate = join(parentReal, basename(candidatePath));

  if (!(parentReal === realRoot || parentReal.startsWith(realRoot + sep))) {
    return { ok: false, reason: `parent resolves outside the repository (${parentReal})` };
  }
  if (!isInsideRepo(resolvedCandidate)) {
    return { ok: false, reason: 'resolves outside the repository' };
  }
  // Nothing under node_modules is deleted, even if the walk above changes.
  const segments = relative(realRoot, resolvedCandidate).split(sep);
  if (segments.includes('node_modules')) {
    return { ok: false, reason: 'inside node_modules' };
  }
  const stats = await lstat(resolvedCandidate);
  if (stats.isSymbolicLink()) {
    return { ok: false, reason: 'is a symlink — refusing to delete it, look at it by hand' };
  }
  return { ok: true, resolved: resolvedCandidate };
}

const realRoot = await realpath(REPO_ROOT);

console.log(bold(`\nclean${dryRun ? ' (dry run)' : ''}`));
console.log(dim(`  root ${realRoot}\n`));

const candidates = [];
collect(realRoot, candidates);
candidates.sort((a, b) => a.path.localeCompare(b.path));

let deleted = 0;
let freed = 0;
let refused = 0;

for (const candidate of candidates) {
  const rel = relative(realRoot, candidate.path) || '.';
  let verdict;
  try {
    verdict = await verifySafe(candidate.path, realRoot);
  } catch (err) {
    console.log(yellow(`  ! skipped ${rel} — ${err.message}`));
    refused += 1;
    continue;
  }
  if (!verdict.ok) {
    console.log(red(`  ! refused ${rel} — ${verdict.reason}`));
    refused += 1;
    continue;
  }

  const bytes = sizeOf(verdict.resolved);
  if (dryRun) {
    console.log(`  ${dim('would delete')} ${rel} ${dim(`(${formatBytes(bytes)})`)}`);
    deleted += 1;
    freed += bytes;
    continue;
  }
  try {
    rmSync(verdict.resolved, { recursive: true, force: true });
  } catch (err) {
    console.log(red(`  ! failed to delete ${rel} — ${err.message}`));
    refused += 1;
    continue;
  }
  console.log(`  ${green('deleted')} ${rel} ${dim(`(${formatBytes(bytes)})`)}`);
  deleted += 1;
  freed += bytes;
}

if (candidates.length === 0) {
  console.log(dim('  nothing to clean'));
}

console.log(
  `\n${bold('Summary')}  ${deleted} ${dryRun ? 'would be removed' : 'removed'}, ${formatBytes(freed)} ${
    dryRun ? 'would be freed' : 'freed'
  }${refused > 0 ? `, ${refused} refused` : ''}\n`,
);

process.exitCode = refused > 0 ? 1 : 0;
