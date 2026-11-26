/**
 * At 360px with 200% text the lesson sheet and a glossary entry padded 32-40px a side, which with the
 * boxes inside them left a calculator 148px and a glossary formula 164px. These read the rules below 20em.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const learn = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'learn.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//gu, '');

/** The body of each block opened by `opener`, with where it starts, braces balanced. */
function blocks(opener: string): { at: number; body: string }[] {
  const found: { at: number; body: string }[] = [];
  for (let at = learn.indexOf(`${opener} {`); at >= 0; at = learn.indexOf(`${opener} {`, at + 1)) {
    const open = learn.indexOf('{', at);
    let depth = 0;
    for (let i = open; i < learn.length; i += 1) {
      if (learn[i] === '{') depth += 1;
      else if (learn[i] === '}' && --depth === 0) {
        found.push({ at, body: learn.slice(open + 1, i) });
        break;
      }
    }
  }
  assert.ok(found.length > 0, `no "${opener}" block`);
  return found;
}

/** Where a narrow block declares `property: value` for `selector`, or -1. */
function declaredAt(opener: string, selector: string, property: string, value: string): number {
  for (const { at, body } of blocks(opener)) {
    for (const [, list = '', decls = ''] of body.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      if (!list.split(',').some((one) => one.trim() === selector)) continue;
      if (decls.split(';').some((d) => d.trim() === `${property}: ${value}`)) return at;
    }
  }
  return -1;
}

const NARROW = '@media (width < 20em)';

describe('Learn’s nested padding under 20em', () => {
  it('narrows the lesson sheet to 12px a side', () => {
    assert.ok(declaredAt(NARROW, '.prl-learn-lesson', '--prl-learn-sheet-x', 'var(--prl-space-3)') >= 0);
  });

  // Same specificity, so the 20em value wins only by coming after the phone's 16px one.
  it('declares the sheet’s 12px after the phone’s 16px', () => {
    const phone = declaredAt(
      '@media (width < 37.5em)',
      '.prl-learn-lesson',
      '--prl-learn-sheet-x',
      'var(--prl-space-6)',
    );
    const narrow = declaredAt(NARROW, '.prl-learn-lesson', '--prl-learn-sheet-x', 'var(--prl-space-3)');
    assert.ok(phone >= 0 && narrow >= 0, 'both rules are present');
    assert.ok(phone < narrow, 'the 20em rule comes later');
  });

  for (const selector of ['.prl-learn-glossary__entry', '.prl-learn-glossary__formula']) {
    it(`gives ${selector} 12px of inline padding`, () => {
      assert.ok(declaredAt(NARROW, selector, 'padding-inline', 'var(--prl-space-3)') >= 0, selector);
    });
  }

  it('stacks an assumption’s index above its sentence', () => {
    assert.ok(declaredAt(NARROW, '.prl-assumptions__item', 'grid-template-columns', 'minmax(0, 1fr)') >= 0);
  });
});
