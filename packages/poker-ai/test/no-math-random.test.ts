/**
 * The assertion `src/policy.ts` already claimed to have.
 *
 * `policy.ts:254` documents the `random` field as:
 *
 * ```ts
 *   /** Injected. `Math.random` is banned in this package and asserted absent. *\/
 * ```
 *
 * It was not asserted absent. There was no scan anywhere in `packages/poker-ai/test/`, and the ban
 * was enforced over two of the repository's seven source trees — `apps/api/src` and
 * `packages/poker-engine/src` — neither of which is this one. A comment that describes a test that
 * does not exist is worse than no comment: it is the reason nobody wrote the test.
 *
 * ## Why it matters here specifically
 *
 * Every opponent profile's decisions come from an injected `RandomSource`, and that is what makes a
 * seeded run byte-identical — which `test/simulation/profile-differentiation.test.ts` depends on for
 * its reproduction claim, and which the load harness and the bots' teaching value depend on too. One
 * `Math.random()` reached for in a hurry inside a weighting helper would break reproducibility
 * silently: every run would still work, and no assertion anywhere would notice.
 *
 * The repository-wide version of this ban, over all seven `src/` trees including `apps/web/src`,
 * lives in `scripts/supply-chain/repo-hygiene.mjs` and runs as `pnpm run security:hygiene`. This
 * file is the package-local one, so `pnpm --filter @prl/poker-ai test` proves the claim its own
 * source makes.
 *
 * ## Every detector is proved to fail
 *
 * Same convention as `packages/poker-engine/test/rng.test.ts` and
 * `apps/api/test/server-randomness.test.ts`: the scan asserts it found files to scan, and a
 * companion test feeds the detector a violation and a prose mention and asserts it distinguishes
 * them. A guard that cannot fail is decoration.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(PACKAGE_DIR, 'src');

/**
 * Every `.ts` file under `src/`, RECURSIVELY.
 *
 * The engine's equivalent walker reads one level only, so a future `src/<subdir>/` would be skipped
 * in silence. This one recurses, and `packages/poker-engine/test/rng.test.ts` has been made to
 * recurse as well.
 */
function sourceFiles(dir: string = SRC_DIR): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) found.push(path);
  }
  return found;
}

/**
 * Removes block and line comments, so a prose mention of a banned API is not read as a use of it.
 *
 * Taken from `packages/poker-engine/test/rng.test.ts` unchanged, limitation included: it is not a
 * parser, so a `//` or `/*` inside a string literal would confuse it. The `[^:]` before the
 * line-comment match is what stops it eating the rest of a line after `https://`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('@prl/poker-ai source obeys the randomness rules', () => {
  const files = sourceFiles();

  it('scans a non-empty tree, so a passing result means something', () => {
    assert.ok(files.length > 5, `expected the package source under src/, found ${files.length} files`);
    // And it reaches the file whose comment makes the claim, which is the specific thing that was
    // never checked.
    assert.ok(
      files.some((file) => file.endsWith('policy.ts')),
      'the scan must cover policy.ts, whose comment asserts this ban',
    );
  });

  it('never uses Math.random', () => {
    const offences: string[] = [];
    for (const file of files) {
      if (stripComments(readFileSync(file, 'utf8')).includes('Math.random')) {
        offences.push(relative(PACKAGE_DIR, file));
      }
    }
    assert.deepEqual(
      offences,
      [],
      'every decision in this package comes from an injected RandomSource, which is what makes a ' +
        `seeded run reproducible:\n${offences.join('\n')}`,
    );
  });

  it('never uses the other non-deterministic sources either', () => {
    // `randomUUID`/`randomBytes` and the two clocks are the other ways a decision stream stops being
    // reproducible. None belongs in a policy: time comes in through the engine's state and identity
    // through the seat.
    const offences: string[] = [];
    for (const file of files) {
      const name = relative(PACKAGE_DIR, file);
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const banned of ['randomUUID', 'randomBytes']) {
        if (code.includes(banned)) offences.push(`${name}: ${banned}`);
      }
      // The clock is allowed in exactly one place, and only for the one field the simulation
      // documents as varying between runs. Scoped per LINE rather than per file, so `simulate.ts`
      // gaining a clock read that feeds a decision is still caught — which is the property being
      // asserted, rather than "this file is trusted".
      for (const line of code.split('\n')) {
        if (!line.includes('Date.now(') && !line.includes('performance.now(')) continue;
        const isElapsedMeasurement = name === 'src/simulate.ts' && /\b(?:startedAt|elapsedMs)\b/.test(line);
        if (!isElapsedMeasurement) offences.push(`${name}: ${line.trim()}`);
      }
    }
    assert.deepEqual(
      offences,
      [],
      `a profile's decisions must depend only on its seed and the state it is shown:\n${offences.join('\n')}`,
    );
  });

  it('reads the clock exactly twice, both times to measure elapsed wall time', () => {
    // The companion to the exception above: if the two permitted reads ever disappear the rule
    // becomes vacuous, and if a third appears the rule above catches it. `simulate.ts` states the
    // contract itself — "fully deterministic for a given config; the only field that varies between
    // runs is elapsedMs" — and this is what holds it to that.
    const simulate = files.find((file) => file.endsWith('src/simulate.ts'));
    assert.ok(simulate !== undefined, 'src/simulate.ts must exist for this exception to mean anything');
    const reads = stripComments(readFileSync(simulate, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('Date.now(') || line.includes('performance.now('));
    assert.equal(reads.length, 2, `expected exactly two clock reads, found ${reads.length}`);
    assert.ok(reads.some((line) => line.includes('startedAt')));
    assert.ok(reads.some((line) => line.includes('elapsedMs')));
  });
});

describe('the detector can actually fail', () => {
  it('sees Math.random in code and not in prose', () => {
    assert.ok(stripComments('const x = Math.random();').includes('Math.random'));
    assert.ok(!stripComments('// mentions Math.random in prose').includes('Math.random'));
    assert.ok(!stripComments('/* mentions Math.random in a block */').includes('Math.random'));
    // The guard that stops the line-comment rule eating a URL, and with it the rest of the line.
    assert.ok(stripComments('const u = "https://x.test"; const y = Math.random();').includes('Math.random'));
  });

  it('walks into a subdirectory', () => {
    // The engine's one-level walker would return the same list whether or not `src/` had
    // subdirectories, so this asserts the recursion itself rather than trusting it. `src/` is flat
    // today; the walker is pointed at the package root, which is not.
    const nested = sourceFiles(PACKAGE_DIR).map((file) => relative(PACKAGE_DIR, file));
    assert.ok(
      nested.some((file) => file.includes('/')),
      'the walker did not descend into any subdirectory, so a nested source file would be skipped',
    );
    assert.ok(
      nested.some((file) => file.startsWith('test/simulation/')),
      'the walker must reach test/simulation, the deepest tree in this package',
    );
  });
});
