/**
 * At 360px with 200% text one display word was wider than the 296px column, and Chrome never hyphenates
 * a capitalised word. The ramp steps down below 20em; these pin the step and the arithmetic behind it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

const PHONE_AT_200 = '@media (width < 20em)';
const DISPLAY = ['--prl-type-display-1', '--prl-type-display-2', '--prl-type-display-3'] as const;

/** The body of the first block opened by `opener`, braces balanced. */
function block(css: string, opener: string): string {
  const at = css.indexOf(`${opener} {`);
  assert.ok(at >= 0, `tokens.css has no "${opener}" block`);
  const open = css.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  assert.fail(`"${opener}" is never closed`);
}

function value(body: string, token: string): string {
  const found = new RegExp(`${token}: ([^;]+);`, 'u').exec(body)?.[1];
  assert.ok(found !== undefined, `${token} is not declared here`);
  return found.trim();
}

/** A plain rem length, or the floor of a `clamp()` whose floor is one. */
function floorRem(length: string): number {
  const rem = /^(?:clamp\()?([\d.]+)rem\b/u.exec(length)?.[1];
  assert.ok(rem !== undefined, `not a rem length or a clamp with a rem floor: ${length}`);
  return Number(rem);
}

const root = block(tokens, ':root');
const phone = block(block(tokens, PHONE_AT_200), ':root');

describe('the display ramp on a phone at 200% text', () => {
  it('is a range a 360px phone reaches only with large text', () => {
    const em = Number(/\(width < ([\d.]+)em\)/u.exec(PHONE_AT_200)?.[1]);
    assert.ok(360 / 16 >= em, 'a 360px phone at the default size would take the smaller titles');
    assert.ok(360 / 32 < em, 'a 360px phone at 200% text would keep the larger titles');
  });

  it('steps every display size below its own floor, in plain rem, so it follows the reader', () => {
    for (const token of DISPLAY) {
      const narrow = value(phone, token);
      assert.match(narrow, /^[\d.]+rem$/u, `${token} is ${narrow}: no px, no clamp() cap`);
      assert.ok(floorRem(narrow) < floorRem(value(root, token)), `${token} does not step down`);
    }
  });

  it('keeps the ladder in order: heading, then display-3, display-2 and display-1', () => {
    const sizes = [value(root, '--prl-type-heading'), ...[...DISPLAY].reverse().map((t) => value(phone, t))];
    const rems = sizes.map(floorRem);
    for (const [i, rem] of rems.entries())
      assert.ok(i === 0 || (rems[i - 1] ?? rem) < rem, sizes.join(' < '));
  });

  // Measured at 72px, condensed: "Fundamentalist" 408px, "Tournaments:" 362.5px. Width scales with size.
  it('fits the widest measured title word in the 296px column at 32px text', () => {
    const px = floorRem(value(phone, '--prl-type-display-2')) * 32;
    for (const [word, at72] of [
      ['Fundamentalist', 408],
      ['Tournaments:', 362.5],
    ] as const) {
      assert.ok((at72 / 72) * px <= 296, `"${word}" is ${((at72 / 72) * px).toFixed(1)}px at ${px}px`);
    }
  });
});
