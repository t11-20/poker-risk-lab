/**
 * At 360px with 200% text a lesson calculator's panel, formula, callout and assumption list each padded
 * 32-40px a side inside a 296px column. These read the rule that lets that padding give way below 20em.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const css = readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const NARROW = '@media (width < 20em) {';
const INSETS = ['.prl-panel', '.prl-callout', '.prl-formula', '.prl-assumptions'];

/** Each narrow block's body and where it starts, braces matched. */
function narrowBlocks(): { at: number; body: string }[] {
  const found: { at: number; body: string }[] = [];
  for (let at = css.indexOf(NARROW); at >= 0; at = css.indexOf(NARROW, at + 1)) {
    let depth = 1;
    let end = at + NARROW.length;
    for (; end < css.length && depth > 0; end += 1) {
      if (css[end] === '{') depth += 1;
      if (css[end] === '}') depth -= 1;
    }
    found.push({ at, body: css.slice(at + NARROW.length, end - 1) });
  }
  assert.ok(found.length > 0, `no ${NARROW} block`);
  return found;
}

/** The narrow block whose rule names `selector` and sets `padding-inline`. */
function narrowPadding(selector: string): { at: number; value: string } | null {
  for (const { at, body } of narrowBlocks()) {
    for (const [, list = '', decls = ''] of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!list.split(',').some((part) => part.trim() === selector)) continue;
      const value = /padding-inline:\s*([^;]+);/.exec(decls)?.[1];
      if (value !== undefined) return { at, value: value.trim() };
    }
  }
  return null;
}

describe('a calculator’s nested boxes under 20em', () => {
  for (const selector of INSETS) {
    it(`gives ${selector} 12px of inline padding`, () => {
      assert.equal(narrowPadding(selector)?.value, 'var(--prl-space-3)', selector);
    });

    // Same specificity, so the narrow padding wins only by coming after the box's own.
    it(`declares ${selector}'s narrow padding after its own`, () => {
      const own = css.search(new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')} \\{[^}]*padding:`));
      const narrow = narrowPadding(selector);
      assert.ok(own >= 0 && narrow !== null, 'both rules are present');
      assert.ok(own < narrow.at, `${selector}'s narrow padding comes first, so its own wins`);
    });
  }
});
