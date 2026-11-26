/**
 * A seat's disc, its turn ring and its cards, computed from the stylesheet's own values at 16px text.
 * The ring touched a to-act plate's outline, and an opponent's second card back crossed its disc by 1.7px.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(new URL('../src/styles/components.css', import.meta.url), 'utf8'));
const tokens = strip(readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'));

const ROOT_PX = 16;

/** The first value a custom property is given in tokens.css. */
function token(name: string): string {
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1];
  assert.ok(value !== undefined, `tokens.css does not define ${name}`);
  return value.trim();
}

/** A length in px: `0`, `Npx`, `Nrem`, `var(--x)` or `calc(a + b)` of those. */
function px(value: string): number {
  const v = value.trim();
  const sum = /^calc\((.+) \+ (.+)\)$/.exec(v);
  if (sum) return px(sum[1] ?? '') + px(sum[2] ?? '');
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref) return px(token(ref[1] ?? ''));
  if (v === '0') return 0;
  const unit = /^(-?[\d.]+)(px|rem)$/.exec(v);
  assert.ok(unit, `cannot read "${v}" as a length`);
  return Number(unit[1]) * (unit[2] === 'rem' ? ROOT_PX : 1);
}

/** `sheet` with every at-rule block removed, so only rules that apply at every size remain. */
function everySize(sheet: string): string {
  let out = sheet;
  for (let head = out.indexOf('@'); head >= 0; head = out.indexOf('@')) {
    let depth = 0;
    let end = out.indexOf('{', head);
    do {
      if (out[end] === '{') depth += 1;
      if (out[end] === '}') depth -= 1;
      end += 1;
    } while (depth > 0 && end < out.length);
    out = out.slice(0, head) + out.slice(end);
  }
  return out;
}

const always = everySize(css);

/** What the rules outside any at-rule set `property` to for `selector`, the last one winning. */
function value(selector: string, property: string): string {
  let found: string | undefined;
  for (const [, list = '', body = ''] of always.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!list.split(',').some((part) => part.trim() === selector)) continue;
    const hit = new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body)?.[1];
    if (hit !== undefined) found = hit.trim();
  }
  assert.ok(found !== undefined, `no rule sets ${selector} ${property}`);
  return found;
}

const disc = px(value('.prl-seat__disc', 'inline-size'));
const ring = px(value('.prl-seat__disc .prl-turn-timer', '--prl-turn-size'));

/** How far an outline is drawn past the plate's border edge. */
function outlineReach(selector: string): number {
  const width = /^(\S+) solid /.exec(value(selector, 'outline'))?.[1] ?? '';
  return px(width) + px(value(selector, 'outline-offset'));
}

const PLATES = [
  '.prl-seat--to-act .prl-seat__plate',
  '.prl-seat--marked .prl-seat__plate',
  '.prl-seat--self.prl-seat--to-act .prl-seat__plate',
  '.prl-seat--self.prl-seat--marked .prl-seat__plate',
];

describe('the disc over its plate', () => {
  const gaps: [string, number][] = [
    ['an opponent', px(value('.prl-seat', 'gap'))],
    ['the viewer', px(value('.prl-seat--self', 'gap').split(' ')[0] ?? '')],
  ];

  it('reads a ring wider than the disc, and outlines drawn past the plate', () => {
    assert.ok(ring > disc, `ring ${ring}px, disc ${disc}px`);
    for (const plate of PLATES) assert.ok(outlineReach(plate) > 0, plate);
  });

  for (const [who, gap] of gaps) {
    it(`leaves ${who}'s ring at least 4px clear of the widest plate outline`, () => {
      const reach = Math.max(...PLATES.map(outlineReach));
      const clear = gap - (ring - disc) / 2 - reach;
      assert.ok(
        clear >= 4,
        `${gap}px gap, ring ${(ring - disc) / 2}px past the disc, outline ${reach}px: ${clear}px`,
      );
    });
  }
});
