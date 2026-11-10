import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Same comment stripping as `scripts/supply-chain/repo-hygiene.mjs`, limits included. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const BANNED = ['createDeterministicRandomForTests', 'createSamplingRandom', 'Math.random'];

test('no source file can deal from a seeded or test-only stream', () => {
  // The engine already refuses a sampling source for dealing, and the test-only generator in
  // production. This keeps the bot from reaching for either in the first place: the only seam
  // through which a test deals a scripted hand is `Deps.dealRandom`.
  assert.ok(
    code('createDeterministicRandomForTests(1)').includes(BANNED[0] as string),
    'the scan fires on code',
  );
  assert.ok(!code('// createDeterministicRandomForTests').includes(BANNED[0] as string), 'and not on prose');
  const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
  assert.ok(files.length >= 8, `scanned ${files.length} files: a scan of nothing proves nothing`);
  for (const name of files) {
    const body = code(readFileSync(join(SRC, name), 'utf8'));
    for (const banned of BANNED) assert.ok(!body.includes(banned), `${name} uses ${banned}`);
  }
  assert.match(readFileSync(join(SRC, 'deps.ts'), 'utf8'), /dealRandom: \(\) => createSecureRandom\(\)/);
});
