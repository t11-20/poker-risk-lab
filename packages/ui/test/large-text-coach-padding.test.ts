/**
 * At 360px with 200% text the Coach and the boxes inside it padded 32-40px a side, which floored it at
 * 315px in a 296px column. These read the rule that lets that padding give way below 20em.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const NARROW = '@media (width < 20em) {';

/** Where a narrow block sets `property` for `selector`, and to what, braces matched. */
function narrow(selector: string, property: string): { at: number; value: string } | null {
  for (let at = css.indexOf(NARROW); at >= 0; at = css.indexOf(NARROW, at + 1)) {
    let depth = 1;
    let end = at + NARROW.length;
    for (; end < css.length && depth > 0; end += 1) {
      if (css[end] === '{') depth += 1;
      if (css[end] === '}') depth -= 1;
    }
    for (const [, list = '', decls = ''] of css.slice(at, end).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!list.split(',').some((part) => part.trim() === selector)) continue;
      const value = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(decls)?.[1];
      if (value !== undefined) return { at, value: value.trim() };
    }
  }
  return null;
}

/** Where the box's own rule sets `property`, outside any at-rule block. */
function own(selector: string, property: string): number {
  return css.search(new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')} \\{[^}]*${property}:`));
}

const BOXES = ['.prl-coach', '.prl-coach__section', '.prl-suggestion', '.prl-uncertainty', '.prl-stat'];
const LISTS = ['.prl-coach__list', '.prl-suggestion__changes', '.prl-uncertainty__limitations'];

describe('the Coach’s nested boxes under 20em', () => {
  for (const selector of BOXES) {
    it(`gives ${selector} 12px of inline padding, after its own padding`, () => {
      const rule = narrow(selector, 'padding-inline');
      assert.equal(rule?.value, 'var(--prl-space-3)', selector);
      const at = own(selector, 'padding');
      assert.ok(at >= 0 && at < (rule?.at ?? -1), `${selector}'s own padding would win`);
    });
  }

  for (const selector of LISTS) {
    it(`indents ${selector} 24px, after its own indent`, () => {
      const rule = narrow(selector, 'padding-inline-start');
      assert.equal(rule?.value, 'var(--prl-space-5)', selector);
      const at = own(selector, 'padding-inline-start');
      assert.ok(at >= 0 && at < (rule?.at ?? -1), `${selector}'s own indent would win`);
    });
  }
});
