/**
 * A `.prl-grid` cell is often an `<li>`, and base.css gives every `<li>` but the last a bottom margin.
 * In a grid that left the last row's cells 4px apart in height, so the cells carry no margin.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name: string): string =>
  readFileSync(new URL(`../src/styles/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

test('a grid cell has no margin, so a list item cell matches its row', () => {
  const base = read('base.css');
  assert.match(base, /(?:^|\})\s*li\s*\{[^}]*margin-block-end:/u, 'base.css no longer spaces list items');
  const cell = /\.prl-grid > \*\s*\{([^}]*)\}/u.exec(read('components.css'));
  assert.ok(cell !== null, 'components.css has no rule for a grid cell');
  assert.match(cell[1] ?? '', /(?:^|;)\s*margin:\s*0\s*;/u);
});
