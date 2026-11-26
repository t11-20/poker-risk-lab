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

/** The shortest distance from point `p` to the segment `a`-`b`. */
function toSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

interface Point {
  readonly x: number;
  readonly y: number;
}

describe('an opponent’s second card back beside the disc', () => {
  const LAST_BACK = '.prl-seat:not(.prl-seat--self) .prl-card-row__cards .prl-card--face-down:last-child';
  const width = px(value('.prl-seat .prl-card--face-down', '--prl-card-w'));
  const [w = 0, h = 0] = value('.prl-card', 'aspect-ratio').split('/').map(Number);
  const height = (width * h) / w;
  const turn = (Number.parseFloat(value(LAST_BACK, 'rotate')) * Math.PI) / 180;
  const gap = px(value('.prl-seat__cluster', 'gap'));

  // Origin at the back's bottom centre; the cluster aligns the back's and the disc's bottom edges.
  const corners: Point[] = [
    [-width / 2, -height],
    [width / 2, -height],
    [width / 2, 0],
    [-width / 2, 0],
  ].map(([x = 0, y = 0]) => ({
    x: x * Math.cos(turn) - y * Math.sin(turn),
    y: x * Math.sin(turn) + y * Math.cos(turn),
  }));
  const centre: Point = { x: width / 2 + gap + disc / 2, y: -disc / 2 };
  const nearest = Math.min(...corners.map((a, i) => toSegment(centre, a, corners[(i + 1) % 4] as Point)));

  it('reads a back that leans toward the disc, about its bottom centre', () => {
    assert.ok(turn > 0, `the last back turns ${turn}rad`);
    assert.equal(
      value('.prl-seat:not(.prl-seat--self) .prl-card--face-down', 'transform-origin'),
      '50% 100%',
    );
    assert.equal(value('.prl-seat__cluster', 'align-items'), 'flex-end');
  });

  it('stays at least 4px clear of the turn ring, so it never crosses the disc', () => {
    const clear = nearest - ring / 2;
    assert.ok(
      clear >= 4,
      `${gap}px gap: the back is ${nearest.toFixed(2)}px from the disc's centre, ${clear.toFixed(2)}px`,
    );
  });
});
