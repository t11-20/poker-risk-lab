/**
 * Makes true the comment on `PolicyInput.random` in `src/policy.ts`, which says `Math.random` is
 * banned in this package and asserted absent. Every profile decision comes from an injected
 * `RandomSource`, so one stray call would silently break seeded reproducibility. The repository-wide
 * ban is `scripts/supply-chain/repo-hygiene.mjs`. The scan asserts it found files, and a companion
 * test proves the detector tells a use from a prose mention.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = join(PACKAGE_DIR, 'src');

/** Recursive, so a future `src/<subdir>/` is not skipped. */
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
 * Not a parser, so a `//` or `/*` inside a string literal confuses it. The `[^:]` stops a line
 * comment match from eating the rest of a line after `https://`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('@prl/poker-ai source obeys the randomness rules', () => {
  const files = sourceFiles();

  it('scans a non-empty tree, so a passing result means something', () => {
    assert.ok(files.length > 5, `expected the package source under src/, found ${files.length} files`);
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
    // Time comes in through the engine's state and identity through the seat.
    const offences: string[] = [];
    for (const file of files) {
      const name = relative(PACKAGE_DIR, file);
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const banned of ['randomUUID', 'randomBytes']) {
        if (code.includes(banned)) offences.push(`${name}: ${banned}`);
      }
      // The clock is allowed only for the elapsed-time field. Scoped per line, so a new clock read in
      // `simulate.ts` that feeds a decision is still caught.
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
    // If the two permitted reads disappear the rule is vacuous. A third is caught by the rule above.
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
    assert.ok(stripComments('const u = "https://x.test"; const y = Math.random();').includes('Math.random'));
  });

  it('walks into a subdirectory', () => {
    // `src/` is flat today, so the walker is pointed at the package root to prove it recurses.
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
