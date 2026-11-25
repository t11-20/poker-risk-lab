/**
 * A callout's padding is its edge on all four sides. `base.css` gives every `<p>` a bottom margin, so a
 * callout whose body ended in a paragraph measured 33px below the text against 16px above it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');

const components = read('../src/styles/components.css');
const base = read('../src/styles/base.css');
const callout = read('../src/components/Callout.tsx');

describe('callout edges', () => {
  it('takes the paragraph margin off the last child of `.prl-callout__body`', () => {
    assert.match(callout, /<div className="prl-callout__body">\{children\}<\/div>/u);
    assert.match(base, /(?:^|\n)p \{[^}]*margin-block-end: var\(--prl-space-6\);/u);
    assert.match(components, /(?:^|\n)\.prl-callout__body > :last-child \{\s*margin-block-end: 0;\s*\}/u);
  });
});
