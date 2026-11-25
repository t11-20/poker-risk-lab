/**
 * Before hydration the saved-spot list cannot be read. Its placeholder is the empty-state box, sized by
 * the empty-state sentence laid hidden under the visible one, so an empty list lands without moving the
 * form below it and the two heights cannot drift apart.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const list = readFileSync(join(SRC, 'components', 'SpotList.tsx'), 'utf8');
const css = readFileSync(join(SRC, 'styles', 'spot-editor.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

function branch(start: string, end: string): string {
  const from = list.indexOf(start);
  assert.ok(from >= 0, `no "${start}" in SpotList.tsx`);
  const to = list.indexOf(end, from);
  assert.ok(to > from, `no "${end}" after "${start}"`);
  return list.slice(from, to);
}

describe('the saved-spot list before it is read', () => {
  it('is the empty-state box, holding the empty-state sentence hidden beneath the visible one', () => {
    const pending = branch('if (!library.ready)', '\n  }\n');
    assert.match(pending, /<div className="prl-empty prl-spot-list__pending">/u);
    assert.match(pending, /<p className="prl-note">Reading the spots saved in this browser\.<\/p>/u);
    assert.match(pending, /<p aria-hidden="true">\{NONE_SAVED\}<\/p>/u);
  });

  it('is replaced, when nothing is saved, by a box with that same sentence', () => {
    const empty = branch('library.spots.length === 0 ?', ') : (');
    assert.match(empty, /<div className="prl-empty">\s*<p>\{NONE_SAVED\}<\/p>\s*<\/div>/u);
    assert.match(list, /const NONE_SAVED =\s*'No spots saved in this browser yet\./u);
  });

  it('stacks the two sentences in one cell and paints only the visible one', () => {
    assert.match(css, /\.prl-spot-list__pending > \* \{\s*grid-area: 1 \/ 1;\s*\}/u);
    assert.match(css, /\.prl-spot-list__pending > \[aria-hidden="true"\] \{\s*visibility: hidden;\s*\}/u);
  });
});
