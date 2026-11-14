/**
 * Asserts that the suite CI runs is the suite the repository contains, and that each test file
 * would execute an assertion. Every workspace `test*` script must be a `node --test` runner, every
 * `*.test.*` file must declare a `test()`/`it()`, and no declaration may be skipped by a literal
 * reason (`{ skip: DB_SKIP_REASON }` is the allowed no-database waiver). An unrecognised pnpm filter
 * fails rather than assumes coverage. It is a static reader, so a test that asserts nothing still counts.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripComments } from './helpers/source-scan.ts';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(API_DIR, '..', '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', '.git', 'coverage', '.pnpm-store']);

interface Manifest {
  /** POSIX path relative to the repo root. `''` for the root manifest. */
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

/** Understands only a path glob (`"./packages/**"`) and a package name, and throws on anything else. */
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
  /** `''` for a root script. */
  readonly dir: string;
  readonly script: string;
}

function filtersIn(command: string): string[] {
  return [...command.matchAll(/--filter\s+((?:"[^"]*")|(?:'[^']*')|(?:\S+))/g)].map(
    (match) => match[1] ?? '',
  );
}

/**
 * `verify` loops over a literal gate list so that one failing gate does not skip the rest. If the
 * list becomes dynamic this returns nothing and the checks below fail.
 */
function loopedRootScripts(command: string): string[] {
  const loop = /\bfor\s+([A-Za-z_][\w]*)\s+in\s+([^;]+);\s*do\b([\s\S]*)/.exec(command);
  if (loop === null) return [];
  const variable = loop[1] ?? '';
  const list = loop[2] ?? '';
  const body = loop[3] ?? '';
  // `for f in *.md; do cat "$f"` reaches no script.
  if (!new RegExp(`pnpm\\s+run\\s+["']?\\$\\{?${variable}\\b`).test(body)) return [];
  return list
    .trim()
    .split(/\s+/)
    .filter((word) => /^[\w:-]+$/.test(word));
}

/** `pnpm -r <script>` with no filter selects every workspace project. */
function invocationsOf(command: string, manifests: readonly Manifest[]): Invocation[] {
  const reached: Invocation[] = [];
  for (const match of command.matchAll(/pnpm run ([\w:-]+)/g)) {
    reached.push({ dir: '', script: match[1] ?? '' });
  }
  for (const script of loopedRootScripts(command)) {
    reached.push({ dir: '', script });
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
 * Deliberately tiny. Seeding every root `test:*` script made the guard vacuous. `test:no-database`
 * is the waiver seed, and `test/database-availability.test.ts` fails inside it whenever `CI` is set.
 */
const DOCUMENTED_ENTRY_POINTS = ['test', 'test:all', 'verify', 'test:no-database'];

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

/**
 * Not the literal `node --test`, because @prl/api puts `--env-file-if-exists` between the two.
 * `[^\n&]` keeps a match inside one `&&` segment.
 */
const RUNNER_INVOCATION = /node\b[^\n&]*?--test\b([^\n&]*)/g;

/** `node --test` takes several globs, and `test:scripts` passes two. */
function globsIn(invocationTail: string): string[] {
  return [...invocationTail.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

function isRunnerScript(command: string): boolean {
  RUNNER_INVOCATION.lastIndex = 0;
  return RUNNER_INVOCATION.test(command);
}

function globToPattern(glob: string): RegExp {
  const source = glob
    .split('/')
    .map((part) =>
      part === '**' ? '(?:.+/)?' : `${part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}/`,
    )
    .join('')
    .replace(/\/$/, '');
  return new RegExp(`^${source}$`);
}

function runnerPatterns(
  manifests: readonly Manifest[],
  reachable: Reachable,
): { readonly dir: string; readonly pattern: RegExp }[] {
  const patterns: { dir: string; pattern: RegExp }[] = [];
  for (const manifest of manifests) {
    for (const [script, command] of Object.entries(manifest.scripts)) {
      // A runner nobody invokes covers nothing.
      const isReachable =
        manifest.dir === ''
          ? reachable.rootScripts.has(script)
          : reachable.packageScripts.has(`${manifest.dir}#${script}`);
      if (!isReachable) continue;
      for (const match of command.matchAll(RUNNER_INVOCATION)) {
        for (const glob of globsIn(match[1] ?? '')) {
          patterns.push({ dir: manifest.dir, pattern: globToPattern(glob) });
        }
      }
    }
  }
  return patterns;
}

function filesMatchedByPackage(
  manifest: Manifest,
  patterns: readonly { readonly dir: string; readonly pattern: RegExp }[],
  files: readonly string[],
): string[] {
  const owned = patterns.filter((entry) => entry.dir === manifest.dir);
  const prefix = manifest.dir === '' ? '' : `${manifest.dir}/`;
  return files.filter((file) => {
    if (!file.startsWith(prefix)) return false;
    const local = file.slice(prefix.length);
    return owned.some((entry) => entry.pattern.test(local));
  });
}

/**
 * `describe`/`suite` do not count, because a file of suites alone executes nothing. Anchored to the
 * line start so a quoted `test(` in a fixture string is not read as a declaration.
 */
const EXECUTING_DECLARATION = /^[ \t]*(?:await\s+)?(?:test|it)\s*\(/;

const DOTTED_SKIP = /\b(?:describe|suite|test|it)\s*\.\s*(?:skip|todo)\s*\(/;

/**
 * An identifier skip value is not matched. It is the no-database waiver, and
 * `database-availability.test.ts` stops it hiding a suite in CI. Node does not count literal skips
 * in `skipped`.
 */
const LITERAL_SKIP = /\{[^{}]*\b(?:skip|todo)\s*:\s*(?:'|"|`|true\b)/;

interface FileVerdict {
  readonly declaresTest: boolean;
  /** `line: text` for each permanently disabled declaration. */
  readonly literalSkips: string[];
}

function inspectTestSource(source: string): FileVerdict {
  const lines = stripComments(source).split('\n');
  let declaresTest = false;
  const literalSkips: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (EXECUTING_DECLARATION.test(line)) declaresTest = true;
    if (DOTTED_SKIP.test(line) || LITERAL_SKIP.test(line)) {
      literalSkips.push(`line ${index + 1}: ${line.trim().slice(0, 100)}`);
    }
  }
  return { declaresTest, literalSkips };
}

function orphanTestScripts(manifests: readonly Manifest[]): string[] {
  const reached = reachableScripts(manifests).packageScripts;
  const orphans: string[] = [];
  for (const manifest of manifests) {
    if (manifest.dir === '') continue;
    for (const script of Object.keys(manifest.scripts)) {
      if (script !== 'test' && !script.startsWith('test:')) continue;
      if (!reached.has(`${manifest.dir}#${script}`)) {
        orphans.push(`${manifest.name} (${manifest.dir}) declares "${script}" and no root script runs it`);
      }
    }
  }
  return orphans;
}

/**
 * Catches `echo 'no tests here' && exit 0`, which passes every other check. The root manifest is
 * exempt because its `test*` scripts are aggregators.
 */
function scriptsThatAreNotRunners(manifests: readonly Manifest[]): string[] {
  const bad: string[] = [];
  for (const manifest of manifests) {
    if (manifest.dir === '') continue;
    for (const [script, command] of Object.entries(manifest.scripts)) {
      if (script !== 'test' && !script.startsWith('test:')) continue;
      if (!isRunnerScript(command)) {
        bad.push(
          `${manifest.name} (${manifest.dir}) "${script}": ${command} — not a \`node --test '<glob>'\` ` +
            'invocation, so nothing proves it executed a single assertion',
        );
      }
      // `--test-only` runs only `.only` declarations, so one stray `.only` disables the rest.
      if (/--test-only\b/.test(command)) {
        bad.push(`${manifest.name} (${manifest.dir}) "${script}" passes --test-only`);
      }
    }
  }
  return bad;
}

function packagesWhoseSuiteMatchesNothing(
  manifests: readonly Manifest[],
  patterns: readonly { readonly dir: string; readonly pattern: RegExp }[],
  files: readonly string[],
): string[] {
  const empty: string[] = [];
  for (const manifest of manifests) {
    const command = manifest.scripts['test'];
    if (command === undefined) continue;
    if (filesMatchedByPackage(manifest, patterns, files).length === 0) {
      empty.push(`${manifest.name}: "${command}" matches no file, so it reports "tests 0" and exits 0`);
    }
  }
  return empty;
}

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
    let declared = 0;
    for (const manifest of manifests) {
      if (manifest.dir === '') continue;
      for (const script of Object.keys(manifest.scripts)) {
        if (script === 'test' || script.startsWith('test:')) declared += 1;
      }
    }
    assert.ok(declared >= 6, `expected several test scripts to check, found ${declared}`);
    const orphans = orphanTestScripts(manifests);
    assert.deepEqual(
      orphans,
      [],
      `a test suite nobody runs is not evidence of anything. Add it to a root script (and to CI):\n${orphans.join('\n')}`,
    );
  });

  it('reaches the release gate\u2019s own list of gates', () => {
    // If the `verify` gate list stops being literal words, say so rather than report every gate unreachable.
    const reached = reachableScripts(manifests).rootScripts;
    for (const gate of ['db:verify', 'design:contrast', 'test:a11y', 'test:exhaustive']) {
      assert.ok(
        reached.has(gate),
        `"${gate}" is not reachable from a documented entry point. Either it was dropped from ` +
          '`verify`, or `verify` is no longer written in a form loopedRootScripts() can read.',
      );
    }
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
    const empty = packagesWhoseSuiteMatchesNothing(manifests, patterns, testFiles());
    assert.deepEqual(
      empty,
      [],
      `a package whose suite runs nothing must not be indistinguishable from one that passed:\n${empty.join('\n')}`,
    );
  });

  it('declares every test script as a real runner, so none can be an `echo` that exits 0', () => {
    const bad = scriptsThatAreNotRunners(manifests);
    assert.deepEqual(
      bad,
      [],
      `a "test" script that is not a runner reports a green package having executed nothing:\n${bad.join('\n')}`,
    );
  });

  it('declares at least one executing test in every test file', () => {
    const files = testFiles();
    const barren: string[] = [];
    for (const file of files) {
      const verdict = inspectTestSource(readFileSync(join(REPO_ROOT, file), 'utf8'));
      if (!verdict.declaresTest) {
        barren.push(`${file} declares no test()/it(), so it contributes "tests 0"`);
      }
    }
    assert.deepEqual(
      barren,
      [],
      `a .test file that declares nothing matches every glob and executes nothing:\n${barren.join('\n')}`,
    );
  });

  it('has no permanently disabled test or suite', () => {
    const disabled: string[] = [];
    for (const file of testFiles()) {
      const verdict = inspectTestSource(readFileSync(join(REPO_ROOT, file), 'utf8'));
      for (const site of verdict.literalSkips) disabled.push(`${file} ${site}`);
    }
    assert.deepEqual(
      disabled,
      [],
      'a declaration skipped by a literal reason never runs again, and node does not even count it ' +
        `in "skipped". Delete it or fix it:\n${disabled.join('\n')}`,
    );
  });
});

/**
 * The `skip` key is assembled because this file is itself scanned by `LITERAL_SKIP`, and a literal
 * fixture would fail the guard it proves.
 */
const SKIP_KEY = 'skip';

const FIXTURE_NO_TESTS = '// TODO: write tests\nexport {};\n';

const FIXTURE_SKIPPED_SUITE = [
  "import { describe, it } from 'node:test';",
  `describe('critical security invariants', { ${SKIP_KEY}: 'temporarily' }, () => {`,
  "  it('a player never receives another player\\u2019s hole cards', () => {",
  "    throw new Error('never runs');",
  '  });',
  '});',
  '',
].join('\n');

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prl-reachability-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * `NODE_TEST_CONTEXT` is cleared because a child runner that sees it refuses to run files and prints
 * nothing. `undefined` works because `child_process` drops undefined entries.
 */
function runNodeTest(file: string): { readonly status: number; readonly counts: Map<string, number> } {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_TEST_CONTEXT: undefined };
  const result = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env });
  const counts = new Map<string, number>();
  for (const match of (result.stdout ?? '').matchAll(/^\u2139 (tests|pass|fail|skipped) (\d+)$/gm)) {
    counts.set(match[1] ?? '', Number(match[2] ?? -1));
  }
  assert.ok(counts.size > 0, `node printed no summary for ${file}:\n${result.stdout}\n${result.stderr}`);
  return { status: result.status ?? -1, counts };
}

describe('the guard fails for each of the three bypasses that defeated it', () => {
  it('bypass 1 — a `test` script of `echo ... && exit 0`', () => {
    const ghost: Manifest = {
      dir: 'packages/ghost',
      name: '@prl/ghost',
      scripts: { test: "echo 'no tests here' && exit 0" },
    };
    const bad = scriptsThatAreNotRunners([ghost]);
    assert.equal(bad.length, 1, `expected the echo script to be reported, got ${JSON.stringify(bad)}`);
    assert.match(bad[0] ?? '', /not a `node --test/);
    // The glob check alone cannot see it.
    assert.deepEqual(packagesWhoseSuiteMatchesNothing([ghost], [], []).length, 1);
  });

  it('bypass 2 — a .test.ts file with no test() calls at all', () => {
    const dir = scratch();
    const file = join(dir, 'ghost.test.ts');
    writeFileSync(file, FIXTURE_NO_TESTS);

    // Node counts a file that registers no test as one passing test.
    const ran = runNodeTest(file);
    assert.equal(ran.status, 0, 'node exits 0 for a test file that declares nothing');
    assert.equal(ran.counts.get('fail'), 0, 'and reports no failure');
    assert.equal(ran.counts.get('pass'), 1, 'while reporting the file itself as a pass');

    const verdict = inspectTestSource(FIXTURE_NO_TESTS);
    assert.equal(verdict.declaresTest, false, 'the guard must report this file as declaring no test');
  });

  it('bypass 3 — describe(..., { skip: <literal> })', () => {
    const dir = scratch();
    const file = join(dir, 'skipped.test.ts');
    writeFileSync(file, FIXTURE_SKIPPED_SUITE);

    // Node reports `tests 0` and `skipped 0`.
    const ran = runNodeTest(file);
    assert.equal(ran.status, 0, 'node exits 0 for a suite skipped by a literal reason');
    assert.equal(ran.counts.get('tests'), 0, 'node reports "tests 0"');
    assert.equal(ran.counts.get('skipped'), 0, 'and "skipped 0" — they are not even counted as skipped');

    const verdict = inspectTestSource(FIXTURE_SKIPPED_SUITE);
    assert.equal(verdict.literalSkips.length, 1, 'the guard must report the literal skip');
    assert.match(verdict.literalSkips[0] ?? '', /critical security invariants/);
  });

  it('does not report the conditional database waiver, which is not a bypass', () => {
    // If this were reported, the detector would be a blanket ban on skipping and would get worked around.
    const waiver = "describe('GET /hands', { skip: DB_SKIP_REASON }, () => {\n  it('a', () => {});\n});\n";
    const verdict = inspectTestSource(waiver);
    assert.deepEqual(verdict.literalSkips, []);
    assert.equal(verdict.declaresTest, true);
  });

  it('would notice a package whose test directory is empty, and an orphan test file', () => {
    const emptyPackage: Manifest = {
      dir: 'packages/ghost',
      name: '@prl/ghost',
      scripts: { test: "node --test 'test/**/*.test.ts'" },
    };
    const patterns = [{ dir: 'packages/ghost', pattern: globToPattern('test/**/*.test.ts') }];
    assert.equal(packagesWhoseSuiteMatchesNothing([emptyPackage], patterns, []).length, 1);
    assert.equal(
      packagesWhoseSuiteMatchesNothing([emptyPackage], patterns, ['packages/ghost/test/a.test.ts']).length,
      0,
    );

    const orphanDir = scratch();
    mkdirSync(join(orphanDir, 'test'), { recursive: true });
    assert.equal(
      filesMatchedByPackage(emptyPackage, patterns, ['db/test/orphan.test.ts']).length,
      0,
      'a file outside every runner glob must match nothing',
    );
  });
});
