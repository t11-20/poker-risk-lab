/**
 * icon.svg is served under the nonce CSP, so its colours are literals the contrast gate never
 * measures. A channel with blue strictly the largest is a cool grey the palette forbids.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const icon = readFileSync(new URL('../src/app/icon.svg', import.meta.url), 'utf8');

interface Rgb {
  readonly hex: string;
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Every hex colour in `svg`, including an 8-digit form whose last pair is alpha. */
function hexColours(svg: string): readonly Rgb[] {
  return [...svg.matchAll(/#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/gu)].map(
    (match) => {
      const raw = match[1] ?? '';
      const expanded = raw.length <= 4 ? [...raw].map((character) => character + character).join('') : raw;
      const hex = expanded.slice(0, 6).toLowerCase();
      return {
        hex: `#${hex}`,
        r: Number.parseInt(hex.slice(0, 2), 16),
        g: Number.parseInt(hex.slice(2, 4), 16),
        b: Number.parseInt(hex.slice(4, 6), 16),
      };
    },
  );
}

test('the favicon carries no colour whose blue channel is strictly the largest', () => {
  const colours = hexColours(icon);
  assert.ok(
    colours.length >= 3,
    `read ${colours.length} hex colours from icon.svg; a sweep of nothing is not a pass`,
  );
  const cool = colours.filter((colour) => colour.b > colour.r && colour.b > colour.g);
  assert.deepEqual(
    cool.map((colour) => colour.hex),
    [],
    'blue is the largest channel, which is a cool colour the palette forbids',
  );
});
