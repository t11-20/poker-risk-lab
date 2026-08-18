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
 * contains.** So this file asserts exactly that.
 *
 * ## The three bypasses this guard used to have, and now does not
 *
 * A release audit defeated the first version of this file three ways in a scratch copy. All three
 * passed the guard while `node --test` reported `tests 0 / skipped 0` and exited 0 — the exact
 * failure the file was written to prevent, reintroduced in one line each:
 *
 *   1. A package whose `test` script was `echo 'no tests here' && exit 0`. The zero-tests check
 *      began `if (!/node .. --test/.test(command)) continue;`, so **any script that was not literally
 *      a `node --test` invocation was exempted from the check entirely.**
 *   2. A `.test.ts` file whose entire content was `// TODO: write tests`. It matched a runner glob,
 *      so every check passed; it declares no test, so it executes nothing.
 *   3. `describe('critical security invariants', { skip: 'temporarily' }, ...)`. Node does not even
 *      count these in `skipped` — the suite reports `tests 0`, and a reader sees a green run.
 *
 * The guard now answers "would this execute an assertion?" as well as "does a glob match a file?":
 *
 *   1. Every workspace `test`/`test:*` script must BE a `node --test` runner (§`is a real runner`).
 *   2. Every `*.test.*` file must declare at least one `test()`/`it()` (§`declares a test`).
 *   3. No declaration may be skipped by a LITERAL reason (§`no permanently disabled`). A skip whose
 *      value is an identifier — `describe(..., { skip: DB_SKIP_REASON })` — is allowed, because that
 *      is the repository's documented no-database waiver, and `test/database-availability.test.ts`
 *      is what stops that waiver becoming a hiding place: it fails whenever `CI` is set.
 *
 * Each of the three has a negative control at the bottom of this file that builds the bypass in a
 * temporary directory, proves `node --test` reports `tests 0` and exits 0 for it, and proves this
 * guard's detector reports it. A guard whose failure mode has never been observed is a guard nobody
 * has tested.
 *
 * ## What this still cannot see, stated plainly
 *
 * It is a static reader, not a runner. A test whose body asserts nothing counts as executing, and a
 * skip written as `{ skip: SOME_CONST }` where `SOME_CONST = 'temporarily'` reads as the conditional
 * database waiver. Closing those needs the per-package runners to emit a machine-readable summary
 * (`--test-reporter`) that a root script asserts on — which is a change to every workspace manifest,
 * not to this file. Until then this is the floor, not the ceiling.
 *
 * ## Reachability, concretely
 *
 * A script is reachable when a root script names it — directly (`pnpm --filter @prl/api test`),
 * through a `pnpm -r --filter ...` sweep that selects the package, through `verify`'s literal gate
 * list, or transitively through another reachable root script. The resolver below is deliberately
 * literal about pnpm's filter syntax rather than clever: an unrecognised filter makes this test FAIL
 * rather than assume coverage, because assuming coverage is the bug.
 *
 * ## Would this fail if the behaviour broke?
 *
 * Checked by reverting each fix in turn: with `test:unit` back to `./packages/**` only, `apps/web`
 * is reported unreachable; with `test:scripts` removed from the root manifest,
 * `policy-check.test.mjs` is reported as matched by no runner; with `test:simulation` removed from
 * `test:all` and from `verify`, poker-ai's simulation script is reported unreachable. And the three
 * bypasses above are covered by their own negative controls.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, describe, it } from 'node:test';
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
 * The root scripts a `for <var> in <list>; do ... pnpm run "$<var>" ... done` loop runs.
 *
 * `verify` is written that way on purpose. It used to be a `&&` chain, which meant a failure in one
 * gate skipped every gate after it: `db:verify` sat last, `test` failed, and the gate that the
 * release documents describe as asserting the LIVE schema's security properties had never once
 * executed in the command operators are told to run. A loop runs every gate and reports each result.
 *
 * The gate list is kept as literal words specifically so this resolver can still read it. If it ever
 * becomes dynamic this returns nothing, and the scripts it used to reach are reported unreachable —
 * the checks below fail rather than quietly assuming coverage.
 */
function loopedRootScripts(command: string): string[] {
  const loop = /\bfor\s+([A-Za-z_][\w]*)\s+in\s+([^;]+);\s*do\b([\s\S]*)/.exec(command);
  if (loop === null) return [];
  const variable = loop[1] ?? '';
  const list = loop[2] ?? '';
  const body = loop[3] ?? '';
  // Only a loop that actually runs each word as a root script counts. `for f in *.md; do cat "$f"`
  // reaches no script and must not be read as if it did.
  if (!new RegExp(`pnpm\\s+run\\s+["']?\\$\\{?${variable}\\b`).test(body)) return [];
  return list
    .trim()
    .split(/\s+/)
    .filter((word) => /^[\w:-]+$/.test(word));
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
 * A `node ... --test ... '<glob>'` invocation inside a script command.
 *
 * Written this way rather than as the literal `node --test` because @prl/api's script has
 * `--env-file-if-exists` between the two, and the first draft of this matcher silently registered no
 * glob for it — which would have reported every api test file as unreachable. `[^\n&]` keeps a match
 * inside one `&&` segment, so @prl/web's `tsc ... && node --test '...'` reads correctly.
 */
const RUNNER_INVOCATION = /node\b[^\n&]*?--test\b([^\n&]*)/g;

/**
 * Every quoted glob one `node --test` invocation passes.
 *
 * `node --test` takes *several* positional globs, and the first form of this matcher captured only
 * the first. That is not academic: `test:scripts` runs both `scripts/` and `apps/api/scripts/`, and
 * with only the first glob seen the guard reported a file as never-executed while node was in fact
 * running it — a false positive, which erodes trust in the guard exactly as fast as a false
 * negative hides a defect.
 */
function globsIn(invocationTail: string): string[] {
  return [...invocationTail.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

/** Whether a script command is itself a `node --test` runner (as opposed to, say, `echo && exit 0`). */
function isRunnerScript(command: string): boolean {
  RUNNER_INVOCATION.lastIndex = 0;
  return RUNNER_INVOCATION.test(command);
}

/** Turns one runner glob into a regular expression anchored to the package that runs it. */
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
      for (const match of command.matchAll(RUNNER_INVOCATION)) {
        for (const glob of globsIn(match[1] ?? '')) {
          patterns.push({ dir: manifest.dir, pattern: globToPattern(glob) });
        }
      }
    }
  }
  return patterns;
}

/** The test files one package's own runner globs match, relative to that package. */
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

// ---------------------------------------------------------------------------
// Whether a test file would execute anything
// ---------------------------------------------------------------------------

/**
 * Removes comments, so this file's own prose about the bypasses is not read as a bypass.
 *
 * Taken from `test/server-randomness.test.ts` unchanged, including the `[^:]` guard that stops the
 * line-comment rule eating the rest of a line after `https://`. It is not a parser: a `//` inside a
 * string literal confuses it. That is a known and accepted limitation everywhere it is used here,
 * and it errs towards seeing less, which for the checks below means erring towards reporting a
 * defect rather than hiding one.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * A line that declares a test node's test runner will execute.
 *
 * `describe`/`suite` deliberately do NOT count: a file containing only suites executes no
 * assertions, which is bypass 2. Anchored to the start of a line so a `test(` quoted inside a string
 * — this file quotes several, in its own fixtures — is not read as a declaration.
 */
const EXECUTING_DECLARATION = /^[ \t]*(?:await\s+)?(?:test|it)\s*\(/;

/**
 * `describe.skip(`, `it.todo(` and friends: a declaration that can never run.
 */
const DOTTED_SKIP = /\b(?:describe|suite|test|it)\s*\.\s*(?:skip|todo)\s*\(/;

/**
 * An options object that disables a declaration with a LITERAL reason — `{ skip: 'temporarily' }`,
 * `{ skip: true }`, `{ todo: 'later' }`.
 *
 * A skip whose value is an identifier is deliberately NOT matched. `describe(..., { skip:
 * DB_SKIP_REASON })` is the repository's documented no-database waiver, evaluated per run, and
 * `test/database-availability.test.ts` fails whenever `CI` is set with no database — so that shape
 * cannot hide a suite in CI. A string literal can, forever, and nothing else in the repo would see
 * it: node does not even count these in `skipped`.
 */
const LITERAL_SKIP = /\{[^{}]*\b(?:skip|todo)\s*:\s*(?:'|"|`|true\b)/;

interface FileVerdict {
  readonly declaresTest: boolean;
  /** `line: text` for each permanently disabled declaration. */
  readonly literalSkips: string[];
}

/** Reads one test file's source and reports what it would execute. */
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

// ---------------------------------------------------------------------------
// The checks, as pure functions so the negative controls can feed them fixtures
// ---------------------------------------------------------------------------

/** Workspace `test*` scripts that no root script runs. */
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
 * Workspace `test*` scripts that are not `node --test` runners.
 *
 * This is bypass 1. A `test` script of `echo 'no tests here' && exit 0` satisfies every other check
 * in this file — it is reachable, it declares nothing to glob — and reports a green package. The
 * root manifest is exempt because its `test*` scripts are aggregators (`test:a11y` is an audit
 * script, `test` chains three others), not runners.
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
      // `--test-only` makes node run ONLY declarations marked `.only`, so one stray `.only` silently
      // disables every other test in the package while the run stays green.
      if (/--test-only\b/.test(command)) {
        bad.push(`${manifest.name} (${manifest.dir}) "${script}" passes --test-only`);
      }
    }
  }
  return bad;
}

/** Packages whose `test` script globs match no file at all, so the suite reports `tests 0`. */
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
    // `verify` runs its gates in a loop rather than a `&&` chain. If that list ever stops being
    // literal words this resolver reads nothing from it, every gate-only script becomes unreachable,
    // and the reader deserves to be told which of the two happened.
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

// ---------------------------------------------------------------------------
// Negative controls: build each bypass and prove it now fails
// ---------------------------------------------------------------------------

/**
 * The three bypass shapes, as source text.
 *
 * The `skip` key is assembled rather than written literally because THIS FILE is one of the files
 * `LITERAL_SKIP` scans, and a fixture that is indistinguishable from the defect would fail the guard
 * it exists to prove. The fixture the detector sees is the assembled string, which is byte-identical
 * to what an author would write.
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
 * Runs `node --test` on one file and reports what node itself said about it.
 *
 * `NODE_TEST_CONTEXT` is cleared from the child's environment on purpose: node sets it for every
 * process the test runner spawns, and a runner that sees it refuses to run files at all
 * ("run() is being called recursively within a test file. skipping running files") and prints
 * nothing. Without this the counts below silently read as "no summary" instead of as node's verdict,
 * which is the same shape of invisible non-execution this whole file is about. `undefined` rather
 * than `delete` because `child_process` drops undefined entries when it builds the child's
 * environment — verified — and the repo's lint rules prefer the assignment.
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
    // And the check it used to slip past — the glob check — still cannot see it, which is exactly
    // why the runner check above had to exist.
    assert.deepEqual(packagesWhoseSuiteMatchesNothing([ghost], [], []).length, 1);
  });

  it('bypass 2 — a .test.ts file with no test() calls at all', () => {
    const dir = scratch();
    const file = join(dir, 'ghost.test.ts');
    writeFileSync(file, FIXTURE_NO_TESTS);

    // The hazard, measured from node itself, and it is worse than "tests 0": node counts the FILE
    // as one passing test when the file registers none, so a suite of these reads as green.
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

    // The hazard: node reports `tests 0` AND `skipped 0`. Nothing in a green run mentions it.
    const ran = runNodeTest(file);
    assert.equal(ran.status, 0, 'node exits 0 for a suite skipped by a literal reason');
    assert.equal(ran.counts.get('tests'), 0, 'node reports "tests 0"');
    assert.equal(ran.counts.get('skipped'), 0, 'and "skipped 0" — they are not even counted as skipped');

    const verdict = inspectTestSource(FIXTURE_SKIPPED_SUITE);
    assert.equal(verdict.literalSkips.length, 1, 'the guard must report the literal skip');
    assert.match(verdict.literalSkips[0] ?? '', /critical security invariants/);
  });

  it('does not report the conditional database waiver, which is not a bypass', () => {
    // `{ skip: DB_SKIP_REASON }` is evaluated per run and is false whenever DATABASE_URL is set.
    // `test/database-availability.test.ts` fails whenever CI is set with no database, so this shape
    // cannot hide a suite in CI. If this ever starts being reported, the detector has become a
    // blanket ban on skipping and will be worked around rather than obeyed.
    const waiver = "describe('GET /hands', { skip: DB_SKIP_REASON }, () => {\n  it('a', () => {});\n});\n";
    const verdict = inspectTestSource(waiver);
    assert.deepEqual(verdict.literalSkips, []);
    assert.equal(verdict.declaresTest, true);
  });

  it('would notice a package whose test directory is empty, and an orphan test file', () => {
    // The two positive controls that already worked, kept because they are the other half of the
    // proof: the detectors report a defect for a broken input and nothing for a sound one.
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
