import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DECK_SIZE, orderedDeck } from '../src/cards.ts';
import {
  createDeterministicRandomForTests,
  createSecureRandom,
  shuffledDeck,
  shuffleInPlace,
  unbiasedInt,
} from '../src/rng.ts';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * Removes block and line comments so that a prose mention of a banned API is not
 * mistaken for a use of it. Not a full parser — a `//` or `/*` inside a string
 * literal would confuse it — but the engine source contains no such string, and
 * the alternative (matching the raw text) produces a false positive on the very
 * comment that documents the rule.
 */
/**
 * Every `.ts` file under `src/`, RECURSIVELY.
 *
 * This used to read one level with `readdirSync(SRC_DIR)`, so a future `packages/poker-engine/src/
 * <subdir>/` would have been skipped in silence — the scan would still have passed, over fewer
 * files than it claimed to cover. `src/` is flat today; the point is that it may not stay so.
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

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('src/ never uses Math.random in code', () => {
  // The guardrail is that cards come only from a CSPRNG. A source scan is a blunt
  // check, but it is the one that catches the mistake being introduced later, when
  // someone reaches for the convenient thing in a hurry.
  const offenders: string[] = [];
  const files = sourceFiles();
  // A walker that silently matched nothing would pass for ever, which is the most likely way this
  // quietly stops working.
  assert.ok(files.length > 5, `expected the engine source under src/, found ${files.length} files`);
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    if (code.includes('Math.random')) offenders.push(relative(SRC_DIR, file));
  }
  assert.deepEqual(offenders, [], `Math.random must never appear in engine code: ${offenders.join(', ')}`);
});

test('the Math.random scan would actually catch a violation', () => {
  // A guard test is worthless if it cannot fail. Prove the detector fires.
  assert.ok(stripComments('const x = Math.random();').includes('Math.random'));
  assert.ok(!stripComments('// mentions Math.random in prose').includes('Math.random'));
  assert.ok(!stripComments('/* mentions Math.random in a block */').includes('Math.random'));
});

test('unbiasedInt rejects invalid bounds and handles bound 1', () => {
  const constant = (): number => 0;
  assert.equal(unbiasedInt(constant, 1), 0);
  assert.throws(() => unbiasedInt(constant, 0), /positive integer/);
  assert.throws(() => unbiasedInt(constant, -3), /positive integer/);
  assert.throws(() => unbiasedInt(constant, 2.5), /positive integer/);
});

test('unbiasedInt discards draws in the wrap region rather than folding them', () => {
  // With bound 3, limit = floor(2^32 / 3) * 3 = 4294967295. The single value
  // 4294967295 must be rejected, not mapped to 0.
  const draws = [4_294_967_295, 7];
  let index = 0;
  const source = (): number => {
    const value = draws[index] ?? 0;
    index += 1;
    return value;
  };
  assert.equal(unbiasedInt(source, 3), 1, '7 % 3 === 1, after rejecting the wrap value');
  assert.equal(index, 2, 'the wrap value was consumed and discarded');
});

test('unbiasedInt fails loudly if the source never leaves the rejection region', () => {
  const stuck = (): number => 4_294_967_295;
  assert.throws(() => unbiasedInt(stuck, 3), /not uniform/);
});

test('unbiasedInt is close to uniform over a large sample', () => {
  const random = createSecureRandom();
  const bound = 52;
  const samples = 520_000;
  const counts = new Float64Array(bound);
  for (let i = 0; i < samples; i++) {
    const value = random.nextInt(bound);
    assert.ok(value >= 0 && value < bound, `value ${value} out of range`);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  const expected = samples / bound;
  // Chi-squared goodness of fit. With 51 degrees of freedom the 99.9th percentile
  // is about 99.6; a correct generator sits far below that. This is a smoke test
  // for gross bias (e.g. modulo folding), not a certification of the CSPRNG.
  let chiSquared = 0;
  for (let value = 0; value < bound; value++) {
    const observed = counts[value] ?? 0;
    chiSquared += (observed - expected) ** 2 / expected;
  }
  assert.ok(chiSquared < 99.6, `chi-squared ${chiSquared.toFixed(1)} suggests a biased generator`);
});

test('shuffleInPlace produces a permutation and touches every position', () => {
  const random = createSecureRandom();
  for (let iteration = 0; iteration < 200; iteration++) {
    const deck = orderedDeck();
    shuffleInPlace(deck, random);
    assert.equal(deck.length, DECK_SIZE);
    assert.equal(new Set(deck).size, DECK_SIZE, 'shuffle must be a permutation');
    for (const card of deck) assert.ok(card >= 0 && card < DECK_SIZE);
  }
});

test('shuffleInPlace reaches every permutation of three items roughly equally', () => {
  // Fisher–Yates picking from [0, i] gives each of the 3! = 6 orderings equal
  // probability. The classic bug — picking from [0, n) — does not, and shows up
  // here as a lopsided distribution.
  const random = createSecureRandom();
  const seen = new Map<string, number>();
  const trials = 120_000;
  for (let i = 0; i < trials; i++) {
    const items = [0, 1, 2];
    shuffleInPlace(items, random);
    const key = items.join('');
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  assert.equal(seen.size, 6, 'all six orderings must occur');
  const expected = trials / 6;
  for (const [key, count] of seen) {
    const deviation = Math.abs(count - expected) / expected;
    assert.ok(deviation < 0.05, `ordering ${key} appeared ${count} times, expected ~${expected}`);
  }
});

test('the deterministic test generator is reproducible and labelled', () => {
  const a = createDeterministicRandomForTests(42);
  const b = createDeterministicRandomForTests(42);
  assert.equal(a.kind, 'deterministic-test-only');
  const deckA = shuffledDeck(a);
  const deckB = shuffledDeck(b);
  assert.deepEqual(deckA, deckB, 'the same seed produces the same deck');

  const c = createDeterministicRandomForTests(43);
  assert.notDeepEqual(shuffledDeck(c), deckA, 'a different seed produces a different deck');
  assert.equal(createSecureRandom().kind, 'csprng');
});

test('the deterministic test generator refuses to run in production', () => {
  const previous = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';
  try {
    assert.throws(() => createDeterministicRandomForTests(1), /never be used in production/);
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
});
