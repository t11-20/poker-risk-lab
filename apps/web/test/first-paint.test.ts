/**
 * The server-rendered page is the first thing a reader sees. A first-visit overlay covered it until
 * about 1.2s after first paint while LCP had already happened underneath, and it kept a session key
 * `/privacy` had to name. Nothing in the app may bring either back.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (/\.(tsx?|css)$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('nothing covers the first paint', () => {
  it('has no boot overlay, its stamp or its session key anywhere in src', () => {
    const files = walk(SRC);
    assert.ok(files.length > 100, `read only ${String(files.length)} files under ${SRC}`);
    const offenders = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return ['BootSequence', 'prl-boot', 'data-boot', 'prl-booted']
        .filter((word) => text.includes(word))
        .map((word) => `${relative(SRC, file)}: ${word}`);
    });
    assert.deepEqual(offenders, []);
  });
});
