/**
 * The poker table at 360px with 200% text: side pots whose names had a 0px track, and seat names torn
 * mid-word in two 111-127px columns. These read the rules that fix both below 20em, and only there.
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
  // Two seats a row left a name 111-127px, and a Legends seat's "Fundamentalist" is 200px.
  holds([
    ['.prl-table__field', 'grid-template-columns', 'minmax(0, 1fr)', 'one seat a row'],
    ['.prl-table__field', '--prl-seat-w', '100%', 'a seat is the whole row'],
    ['.prl-table__field', '--prl-table-pad', 'var(--prl-space-1)', 'its 16px a side came off the seat'],
    ['.prl-seat__plate', 'padding-inline', 'var(--prl-space-2)', 'its 16px a side came off the name'],
  ]);

  const SLOTS = ['top', 'left-high', 'right-high', 'left-low', 'right-low', 'hero'];

  it('gives every seat and the board a row of their own, in the order of the two-column layout', () => {
    const rules = SLOTS.map((slot) => `.prl-table__field [data-slot="${slot}"]`);
    rules.splice(3, 0, '.prl-table__centre');
    for (const selector of rules) {
      const at = css.indexOf(`\n${selector} {`);
      assert.ok(
        at >= 0 && at < (narrow(selector, 'grid-area')?.at ?? -1),
        `${selector}'s own rule would win`,
      );
    }
    const rows = rules.map((selector) => narrow(selector, 'grid-area')?.value);
    assert.deepEqual(rows, ['1 / 1', '2 / 1', '3 / 1', '4 / 1', '5 / 1', '6 / 1', '7 / 1']);
    assert.equal(narrow('.prl-table__field', 'grid-template-rows')?.value, 'repeat(7, auto)');
  });

  // In a whole-row seat the cards beside the disc set it 52px (backs) and 62px (face up) off its plate.
  it('puts an opponent’s cards above the disc, so the disc stays over its plate', () => {
    assert.equal(narrow('.prl-seat__cluster', 'flex-direction')?.value, 'column');
    assert.equal(narrow('.prl-seat__cluster', 'align-items')?.value, 'center');
    assert.equal(
      ownValue('.prl-seat__cluster', 'align-items'),
      'flex-end',
      'beside the disc at every other size',
    );
  });

  it('keeps two seats a row and the seat padding at every other size', () => {
    assert.equal(ownValue('.prl-table__field', 'grid-template-columns'), 'repeat(2, minmax(0, 1fr))');
    assert.equal(ownValue('.prl-seat__plate', 'padding'), 'var(--prl-space-2) var(--prl-space-4)');
    assert.equal(ownValue('.prl-table__field', '--prl-table-pad'), 'var(--prl-space-4)');
  });
});
