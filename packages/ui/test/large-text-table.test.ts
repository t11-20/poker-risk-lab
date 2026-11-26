/**
 * The poker table at 360px with 200% text: side pots whose names had a 0px track, and seat names torn
 * mid-word in two 111-124px columns. These read the rules that fix both below 20em, and only there.
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

/** What the block's own rule sets `property` to. */
function ownValue(selector: string, property: string): string | undefined {
  const at = own(selector);
  assert.ok(at >= 0, `no rule of its own for ${selector}`);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', css.indexOf('{', at)));
  return new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim();
}

function holds(rules: readonly (readonly [string, string, string, string])[]): void {
  for (const [selector, property, value, why] of rules) {
    it(`sets ${selector} ${property}: ${value}, after its own rule (${why})`, () => {
      const rule = narrow(selector, property);
      assert.equal(rule?.value, value, `${selector} ${property}`);
      const at = own(selector);
      assert.ok(at >= 0 && at < (rule?.at ?? -1), `${selector}'s own rule would win`);
    });
  }
}

describe('side pots under 20em', () => {
  holds([
    ['.prl-pot__side', 'grid-template-columns', 'auto auto', 'two auto figures left the names 0px'],
    ['.prl-pot__side-seats', 'grid-column', '2', 'the names go under the amount'],
  ]);

  it('keeps three tracks at every other size', () => {
    assert.equal(ownValue('.prl-pot__side', 'grid-template-columns'), 'auto auto minmax(0, 1fr)');
  });
});

describe('seat names under 20em', () => {
  holds([
    ['.prl-table__field', '--prl-table-pad', 'var(--prl-space-1)', 'its 16px a side came off both seats'],
    [
      '.prl-table__field',
      '--prl-seat-w',
      'calc((100cqi - var(--prl-table-pad) * 2 - var(--prl-space-1)) / 2)',
      'half the field, less the narrower pads and gap',
    ],
    ['.prl-table__field', 'column-gap', 'var(--prl-space-1)', 'the gap the seat width subtracts'],
    ['.prl-seat__plate', 'padding-inline', 'var(--prl-space-2)', 'its 16px a side left "Quartile" 77px'],
  ]);

  it('keeps the seat padding at every other size', () => {
    assert.equal(ownValue('.prl-seat__plate', 'padding'), 'var(--prl-space-2) var(--prl-space-4)');
    assert.equal(ownValue('.prl-table__field', '--prl-table-pad'), 'var(--prl-space-4)');
  });
});
