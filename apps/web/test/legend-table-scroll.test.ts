/**
 * A legend table scrolls sideways at 360px (444px of table in a 277px wrapper, measured in Chrome on
 * /legends/hand-review/demo), so its wrapper must be a tab stop while it scrolls, or the derivation
 * column cannot be reached from a keyboard. Asserted over source, because `apps/web` tests run with no DOM.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') ? [path] : [];
  });
}

const uses = sources(SRC).flatMap((path) => {
  const text = readFileSync(path, 'utf8');
  return [...text.matchAll(/<(\w+)\s+className="prl-legend-table-wrap"([^>]*)>/gu)].map((match) => ({
    path,
    tag: match[1],
    rest: match[2] ?? '',
  }));
});

describe('legend tables scroll inside a measured region', () => {
  it('found the wrappers, so a clean result means something', () => {
    assert.equal(uses.length, 2, JSON.stringify(uses));
  });

  it('wraps every legend table in ScrollRegion, not a bare div (REGRESSION)', () => {
    for (const use of uses) assert.equal(use.tag, 'ScrollRegion', use.path);
  });

  it('names each region apart, because one hand review shows a table per decision', () => {
    const comparison = uses.find((use) => use.path.endsWith('PostHandComparison.tsx'));
    assert.match(comparison?.rest ?? '', /\$\{sequence\}/u);
  });
});
