/**
 * The guard for the defect class this whole workstream is about: a test that exists and that
 * nothing executes.
 *
 * ## Why a guard rather than four more fixes
 *
 * Four separate instances turned up in one review, each found by hand:
 *
 *   - `packages/poker-ai`'s `test:simulation` — 19 tests and the only statistical evidence that the
 *     opponent profiles differ measurably — was run by no root script and no CI job.
 *   - `apps/web`'s suite was excluded by `test:unit`'s `./packages/**` filter.
 *   - `scripts/supply-chain/policy-check.test.mjs` matched no runner's glob at all.
 *   - `packages/contracts` shipped an EMPTY `test/` directory whose suite reported `tests 0` and
 *     exited 0, which is indistinguishable from a package that passed.
 *
 * They share a cause with the defect that started all this — 57 database tests skipping in silence:
 * **nothing in the repository asserted that the suite CI runs is the suite the repository
 * contains.** So this file asserts exactly that, three ways:
 *
 *   1. Every `test`/`test:*` script in every workspace manifest is reachable from a root script.
 *   2. Every `*.test.*` file in the repository is matched by some runner's glob.
 *   3. No package's `test` script can report zero tests, because every one of them has files to run.
 *
 * ## Reachability, concretely
 *
 * A script is reachable when a root script names it — directly (`pnpm --filter @prl/api test`), or
 * through a `pnpm -r --filter ...` sweep that selects the package, or transitively through another
 * reachable root script. The resolver below is deliberately literal about pnpm's filter syntax
 * rather than clever: an unrecognised filter makes this test FAIL rather than assume coverage,
 * because assuming coverage is the bug.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Checked by reverting each fix in turn: with `test:unit` back to `./packages/**` only, `apps/web`
 * is reported unreachable; with `test:scripts` removed from the root manifest,
 * `policy-check.test.mjs` is reported as matched by no runner; with `test:simulation` removed from
 * `test:all`, poker-ai's simulation script is reported unreachable.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..', '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.pnpm-store']);

interface Manifest {
  /** Directory relative to the repo root, POSIX separators. `''` for the root manifest. */
  readonly dir: string;
  readonly name: string;
  readonly scripts: Readonly<Record<string, string>>;
}

function readManifest(dir: string): Manifest | null {
  const full = join(REPO_ROOT, dir, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(full, 'utf8');
  } catch {
    return null;
  }
  const parsed: unknown = JSON.parse(raw);
  assert.ok(parsed !== null && typeof parsed === 'object', `${dir}/package.json is not an object`);
  const record = parsed as { name?: unknown; scripts?: unknown };
  const scripts =
    record.scripts !== null && typeof record.scripts === 'object'
      ? (record.scripts as Record<string, string>)
      : {};
  return { dir, name: typeof record.name === 'string' ? record.name : dir, scripts };
}

/** Every workspace manifest: the root, plus each `apps/*` and `packages/*`. */
function workspaceManifests(): Manifest[] {
  const found: Manifest[] = [];
  const root = readManifest('');
  assert.ok(root !== null, 'the root package.json must be readable');
  found.push(root);
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(REPO_ROOT, group), { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      const manifest = readManifest(`${group}/${entry.name}`);
      if (manifest !== null) found.push(manifest);
    }
  }
  return found;
}

/** Every `*.test.*` file in first-party source, relative to the repo root. */
function testFiles(dir = REPO_ROOT, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      testFiles(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (/\.test\.(?:ts|tsx|mts|mjs|js)$/.test(entry.name)) {
      out.push(relative(REPO_ROOT, join(dir, entry.name)).split('\\').join('/'));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Which packages a root script sweeps
// ---------------------------------------------------------------------------

/**
 * The packages a `pnpm -r --filter <f> ...` invocation selects.
 *
 * Only the two filter forms this repository actually uses are understood — a path glob
 * (`"./packages/**"`) and a package name (`@prl/web`) — and anything else throws. A resolver that
 * guessed would report coverage that does not exist, which is the failure being guarded against.
 */
function packagesSelectedBy(filter: string, manifests: readonly Manifest[]): string[] {
  const cleaned = filter.replace(/^["']|["']$/g, '');
  if (cleaned.startsWith('./')) {
    const prefix = cleaned.replace(/^\.\//, '').replace(/\/\*\*$/, '');
    return manifests.filter((m) => m.dir.startsWith(`${prefix}/`)).map((m) => m.dir);
  }
  if (cleaned.startsWith('@') || /^[a-z]/.test(cleaned)) {
    return manifests.filter((m) => m.name === cleaned).map((m) => m.dir);
  }
  throw new Error(`this test does not understand the pnpm filter "${filter}"; teach it rather than guess`);
}

interface Invocation {
  /** Package directory, or `''` for a root script. */
  readonly dir: string;
  readonly script: string;
}

/** Every `--filter X` in a command, in order. */
function filtersIn(command: string): string[] {
  return [...command.matchAll(/--filter\s+((?:"[^"]*")|(?:'[^']*')|(?:\S+))/g)].map(
    (match) => match[1] ?? '',
  );
}

/**
 * What one root script command reaches: other root scripts, and package scripts through filters.
 *
 * `pnpm -r <script>` with no filter selects every workspace project, which is how `typecheck`
 * reaches all of them.
 */
function invocationsOf(command: string, manifests: readonly Manifest[]): Invocation[] {
  const reached: Invocation[] = [];
  for (const match of command.matchAll(/pnpm run ([\w:-]+)/g)) {
    reached.push({ dir: '', script: match[1] ?? '' });
  }
  for (const segment of command.split('&&')) {
    const pnpm = /pnpm\s+(?:-r\s+)?(?:--filter[^\n]*?)?\s*([\w:-]+)\s*$/.exec(segment.trim());
    if (pnpm === null) continue;
    const script = pnpm[1] ?? '';
    if (script === 'run' || script === '') continue;
    const filters = filtersIn(segment);
    if (filters.length === 0) {
      if (!/\bpnpm\s+-r\b/.test(segment)) continue;
      for (const manifest of manifests) {
        if (manifest.dir !== '') reached.push({ dir: manifest.dir, script });
      }
      continue;
    }
    for (const filter of filters) {
      for (const dir of packagesSelectedBy(filter, manifests)) reached.push({ dir, script });
    }
  }
  return reached;
}

/**
 * The commands a human or CI actually types, as the roots of the reachability walk.
 *
 * This list is deliberately tiny, and that is the whole design. An earlier draft seeded it with
 * every root `test:*` script, which made the guard vacuous: `test:simulation` counted as reachable
 * because it was named here, even after it was removed from `test:all` and no job ran it — exactly
 * the defect being guarded against. So the only seeds are the three documented top-level commands,
 * plus the waiver, plus whatever `.github/workflows/**` actually invokes. Everything else has to
 * earn its place by being called.
 *
 * `test:no-database` is a seed because it is the documented waiver for a developer with no Docker
 * and `@prl/api`'s `test:without-database` is its implementation, so nothing else will ever reach
 * it. What stops the waiver becoming a hiding place is `test/database-availability.test.ts`, which
 * fails inside it whenever `CI` is set.
 */
const DOCUMENTED_ENTRY_POINTS = ['test', 'test:all', 'verify', 'test:no-database'];

/** Every `pnpm run <script>` named anywhere in the CI workflows. */
function scriptsInvokedByCi(): string[] {
  const dir = join(REPO_ROOT, '.github', 'workflows');
  const found = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
    const source = readFileSync(join(dir, entry.name), 'utf8');
    for (const match of source.matchAll(/pnpm run ([\w:-]+)/g)) found.add(match[1] ?? '');
  }
  return [...found];
}

interface Reachable {
  /** `dir#script` for each package script a reachable root script runs. */
  readonly packageScripts: Set<string>;
  /** Root scripts that are actually invoked, transitively. */
  readonly rootScripts: Set<string>;
}

function reachableScripts(manifests: readonly Manifest[]): Reachable {
  const root = manifests.find((manifest) => manifest.dir === '');
  assert.ok(root !== undefined);
  const packageScripts = new Set<string>();
  const rootScripts = new Set<string>();
  const queue = [...DOCUMENTED_ENTRY_POINTS, ...scriptsInvokedByCi()];
  while (queue.length > 0) {
    const name = queue.shift() ?? '';
    if (rootScripts.has(name)) continue;
    const command = root.scripts[name];
    if (command === undefined) continue;
    rootScripts.add(name);
    for (const invocation of invocationsOf(command, manifests)) {
      if (invocation.dir === '') {
        queue.push(invocation.script);
        continue;
      }
      packageScripts.add(`${invocation.dir}#${invocation.script}`);
    }
  }
  return { packageScripts, rootScripts };
}

// ---------------------------------------------------------------------------
// Which files a runner glob matches
// ---------------------------------------------------------------------------

/**
 * The globs every `node --test` invocation in the repository passes, as regular expressions
 * anchored to the package that runs them.
 */
function runnerPatterns(
  manifests: readonly Manifest[],
  reachable: Reachable,
): { readonly dir: string; readonly pattern: RegExp }[] {
  const patterns: { dir: string; pattern: RegExp }[] = [];
  for (const manifest of manifests) {
    for (const [script, command] of Object.entries(manifest.scripts)) {
      // Only globs belonging to a script something actually runs. A runner nobody invokes does not
      // cover a file — that is the whole defect: `scripts/**/*.test.mjs` existed and no root script
      // named it, and `test:simulation` existed and no job called it.
      const isReachable =
        manifest.dir === ''
          ? reachable.rootScripts.has(script)
          : reachable.packageScripts.has(`${manifest.dir}#${script}`);
      if (!isReachable) continue;
      // `node`, then `--test` somewhere in its flags, then the quoted glob. Written this way rather
      // than as the literal `node --test` because @prl/api's script has `--env-file-if-exists`
      // between the two, and the first draft of this matcher silently registered no glob for it —
      // which would have reported every api test file as unreachable.
      for (const match of command.matchAll(/node\b[^\n&]*?--test\b[^\n&]*?'([^']+)'/g)) {
        const glob = match[1] ?? '';
        const source = glob
          .split('/')
          .map((part) =>
            part === '**'
              ? '(?:.+/)?'
              : `${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}/`,
          )
          .join('')
          .replace(/\/$/, '');
        patterns.push({ dir: manifest.dir, pattern: new RegExp(`^${source}$`) });
      }
    }
  }
  return patterns;
}

// ---------------------------------------------------------------------------

describe('every test in this repository is reachable from a root script', () => {
  const manifests = workspaceManifests();

  it('found the workspace it means to check', () => {
    assert.ok(
      manifests.length >= 8,
      `expected the root plus apps/* and packages/*, found ${manifests.length}`,
    );
    assert.ok(
      manifests.some((manifest) => manifest.name === '@prl/web'),
      'apps/web must be among the manifests, or its exclusion cannot be detected',
    );
  });

  it('runs every test script every workspace package declares', () => {
    const reached = reachableScripts(manifests).packageScripts;
    const orphans: string[] = [];
    let declared = 0;
    for (const manifest of manifests) {
      if (manifest.dir === '') continue;
      for (const script of Object.keys(manifest.scripts)) {
        if (script !== 'test' && !script.startsWith('test:')) continue;
        declared += 1;
        if (!reached.has(`${manifest.dir}#${script}`)) {
          orphans.push(`${manifest.name} (${manifest.dir}) declares "${script}" and no root script runs it`);
        }
      }
    }
    assert.ok(declared >= 6, `expected several test scripts to check, found ${declared}`);
    assert.deepEqual(
      orphans,
      [],
      `a test suite nobody runs is not evidence of anything. Add it to a root script (and to CI):\n${orphans.join('\n')}`,
    );
  });

  it('matches every test file in the repository to a runner glob that something invokes', () => {
    const patterns = runnerPatterns(manifests, reachableScripts(manifests));
    assert.ok(patterns.length >= 6, `expected several node --test globs, found ${patterns.length}`);
    const files = testFiles();
    assert.ok(files.length >= 30, `expected the repo's test files, found ${files.length}`);

    const unmatched = files.filter((file) => {
      return !patterns.some(({ dir, pattern }) => {
        if (dir !== '' && !file.startsWith(`${dir}/`)) return false;
        const local = dir === '' ? file : file.slice(dir.length + 1);
        return pattern.test(local);
      });
    });
    assert.deepEqual(
      unmatched,
      [],
      `these test files match no runner glob, so they have never executed:\n${unmatched.join('\n')}`,
    );
  });

  it('leaves no package whose test script would report zero tests', () => {
    const patterns = runnerPatterns(manifests, reachableScripts(manifests));
    const files = testFiles();
    const empty: string[] = [];
    for (const manifest of manifests) {
      const command = manifest.scripts['test'];
      if (command === undefined || !/node\b[^\n&]*?--test\b/.test(command)) continue;
      const owned = patterns.filter((entry) => entry.dir === manifest.dir);
      const matched = files.filter((file) => {
        const prefix = manifest.dir === '' ? '' : `${manifest.dir}/`;
        if (!file.startsWith(prefix)) return false;
        const local = file.slice(prefix.length);
        return owned.some((entry) => entry.pattern.test(local));
      });
      if (matched.length === 0) {
        empty.push(`${manifest.name}: "${command}" matches no file, so it reports "tests 0" and exits 0`);
      }
    }
    assert.deepEqual(
      empty,
      [],
      `a package whose suite runs nothing must not be indistinguishable from one that passed:\n${empty.join('\n')}`,
    );
  });
});
