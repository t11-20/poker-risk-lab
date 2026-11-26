/**
 * At 360px with 200% text the bet sizer was 367px and every bundled /lab scenario 450-507px wide.
 * These read the rules that let each of its blocks shrink below 20em, and nowhere else.
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

/** Where the block's own rule starts, outside any at-rule block. */
function own(selector: string): number {
  return css.search(new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')} \\{`));
}

const RULES: readonly [selector: string, property: string, value: string, why: string][] = [
  ['.prl-sizer', 'min-inline-size', '0', 'a fieldset defaults to min-content, which pinned it at 367px'],
  ['.prl-sizer', 'padding-inline', 'var(--prl-space-3)', 'its 24px a side left the controls 98px'],
  ['.prl-action-bar', 'min-width', '0', 'a grid item, floored at the number field and its paddings'],
  ['.prl-action-bar', 'padding-inline', 'var(--prl-space-3)', 'its 32px a side left the sizer 148px'],
  ['.prl-sizer__controls', 'min-width', '0', 'a flex item, floored at the field'],
  ['.prl-sizer__field', 'min-width', '0', 'a flex item, floored at the number field'],
  ['.prl-sizer__field', 'flex-wrap', 'wrap', 'the label beside the field made the row 318px'],
  ['.prl-sizer__slider', 'min-width', '0', 'an 8rem floor is 256px at 200%'],
  ['.prl-sizer__number', 'max-width', '100%', 'its 6.5rem is 208px at 200%'],
];

describe('the bet sizer under 20em', () => {
  for (const [selector, property, value, why] of RULES) {
    it(`sets ${selector} ${property}: ${value}, after its own rule (${why})`, () => {
      const rule = narrow(selector, property);
      assert.equal(rule?.value, value, `${selector} ${property}`);
      const at = own(selector);
      assert.ok(at >= 0 && at < (rule?.at ?? -1), `${selector}'s own rule would win`);
    });
  }
});
