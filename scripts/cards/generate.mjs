#!/usr/bin/env node
/**
 * Writes the deck the web app shows: one SVG per card (`KH.svg`, `TS.svg`) and the backs, into
 * `apps/web/public/cards/`. Ranks and suits are paths authored here, never `<text>`, so a face does not
 * depend on the reader's fonts. The colours come from `--prl-deck-*` in tokens.css, so the contrast gate
 * measures what the files paint.
 *
 *   node scripts/cards/generate.mjs           # rewrite the files
 *   node scripts/cards/generate.mjs --check   # report drift, change nothing
 *
 * Ten is `T` in a file name, as in the engine's notation (`Th`), so every name is two characters.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const TOKENS = join(REPO, 'packages/ui/src/styles/tokens.css');
export const DECK_DIR = join(REPO, 'apps/web/public/cards');

const PALETTE_KEYS = [
  'face',
  'edge',
  'red',
  'black',
  'back-charcoal',
  'back-charcoal-line',
  'back-green',
  'back-green-line',
  'back-wine',
  'back-wine-line',
];

/** The first back is the one `back.svg` copies until the owner picks. */
export const BACKS = ['charcoal', 'green', 'wine'];

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['C', 'D', 'H', 'S'];

/**
 * Refuses a missing, repeated or non-hex token. Declared twice, a token could differ by theme, and a file
 * served as an image cannot follow the theme.
 */
export function readPalette(css) {
  const body = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const palette = {};
  for (const match of body.matchAll(/--prl-deck-([\w-]+)\s*:\s*([^;]+);/gu)) {
    const [, key, raw] = match;
    const value = raw.trim().toLowerCase();
    if (key in palette) throw new Error(`--prl-deck-${key} is declared more than once`);
    if (!/^#[\da-f]{6}$/u.test(value))
      throw new Error(`--prl-deck-${key} is "${value}", not a #rrggbb colour`);
    palette[key] = value;
  }
  const missing = PALETTE_KEYS.filter((key) => !(key in palette));
  if (missing.length > 0)
    throw new Error(`tokens.css has no ${missing.map((k) => `--prl-deck-${k}`).join(', ')}`);
  return palette;
}

const W = 250;
const H = 350;
const RADIUS = 18;
const INK_WIDTH = 9;
const INDEX_SCALE = 1.25;

/**
 * Rank glyphs, stroked, in a box `w` wide and 60 tall. Monoline so they stay legible at 32px, where a
 * filled serif face closes up.
 */
const RANK_GLYPHS = {
  2: { w: 34, d: 'M2 14C2 5 9 0 17 0C26 0 33 6 33 15C33 24 27 31 2 60H35' },
  3: {
    w: 34,
    d: 'M3 8C7 2 11 0 17 0C26 0 32 6 32 15C32 23 26 28 16 28C27 28 34 34 34 44C34 54 27 60 17 60C9 60 4 57 1 51',
  },
  4: { w: 36, d: 'M26 60V0L0 42H36' },
  5: { w: 34, d: 'M32 0H6L3 27C7 24 12 23 17 23C28 23 34 30 34 41C34 53 26 60 16 60C9 60 4 57 1 52' },
  6: {
    w: 34,
    d: 'M30 4C26 1 22 0 18 0C7 0 1 12 1 32C1 50 7 60 18 60C28 60 34 53 34 42C34 31 27 24 18 24C9 24 2 30 1 38',
  },
  7: { w: 34, d: 'M0 0H34L12 60' },
  8: {
    w: 34,
    d:
      'M17 28C8 28 3 23 3 14C3 5 9 0 17 0C25 0 31 5 31 14C31 23 26 28 17 28C27 28 34 35 34 44' +
      'C34 54 27 60 17 60C7 60 0 54 0 44C0 35 7 28 17 28Z',
  },
  9: {
    w: 34,
    d: 'M4 56C8 59 12 60 16 60C27 60 33 48 33 28C33 10 27 0 16 0C6 0 0 7 0 18C0 29 7 36 16 36C25 36 32 30 33 22',
  },
  T: { w: 42, d: 'M0 9L7 2V60M31 0C38 0 42 12 42 30C42 48 38 60 31 60C24 60 20 48 20 30C20 12 24 0 31 0Z' },
  J: { w: 28, d: 'M27 0V44C27 55 21 60 13 60C5 60 0 55 0 47' },
  Q: {
    w: 38,
    d: 'M19 0C31 0 37 12 37 30C37 48 31 60 19 60C7 60 1 48 1 30C1 12 7 0 19 0ZM23 44L38 62',
  },
  K: { w: 32, d: 'M2 0V60M32 0L2 38M12 27L32 60' },
  A: { w: 38, d: 'M0 60L19 0L38 60M6 41H32' },
};

/**
 * Suit symbols, filled, in a 100 x 100 box. Several paths rather than one, so overlapping parts never
 * cancel under the nonzero rule.
 */
const SUIT_SHAPES = {
  C: [
    'M29 26A21 21 0 1 0 71 26A21 21 0 1 0 29 26Z',
    'M6 58A21 21 0 1 0 48 58A21 21 0 1 0 6 58Z',
    'M52 58A21 21 0 1 0 94 58A21 21 0 1 0 52 58Z',
    'M50 36L34 62H66Z',
    'M46 60C46 80 42 91 33 98H67C58 91 54 80 54 60Z',
  ],
  D: ['M50 0Q68 28 88 50Q68 72 50 100Q32 72 12 50Q32 28 50 0Z'],
  H: [
    'M50 96C30 78 4 58 4 32C4 15 16 4 30 4C40 4 47 10 50 18C53 10 60 4 70 4C84 4 96 15 96 32C96 58 70 78 50 96Z',
  ],
  S: [
    'M50 2C30 22 4 42 4 64C4 79 15 88 28 88C37 88 44 84 47 77C46 86 42 93 34 98H66C58 93 54 86 53 77' +
      'C56 84 63 88 72 88C85 88 96 79 96 64C96 42 70 22 50 2Z',
  ],
};

const RED_SUITS = new Set(['D', 'H']);
const COURTS = new Set(['J', 'Q', 'K']);
/** Inside a court card's frame the symbol is smaller, and an ace's is the largest on the deck. */
const CENTRE_SIZE = { J: 72, Q: 72, K: 72, A: 120 };

const round = (n) => Number(n.toFixed(3)).toString();

function suitAt(suit, cx, cy, size, ink) {
  const scale = size / 100;
  const at = `translate(${round(cx - size / 2)} ${round(cy - size / 2)}) scale(${round(scale)})`;
  return `<g transform="${at}" fill="${ink}">${SUIT_SHAPES[suit].map((d) => `<path d="${d}"/>`).join('')}</g>`;
}

/**
 * Rank over suit, centred on x = 40. The bottom-right copy is the same group turned half a circle. The
 * rank is drawn at 1.25, because at 32px wide a 60-unit rank was under 8px tall.
 */
function cornerIndex(rank, suit, ink) {
  const glyph = RANK_GLYPHS[rank];
  const rankAt = `translate(${round(40 - (glyph.w * INDEX_SCALE) / 2)} 20) scale(${INDEX_SCALE})`;
  const stroke = `stroke="${ink}" stroke-width="${INK_WIDTH}" stroke-linecap="round" stroke-linejoin="round"`;
  return `<path transform="${rankAt}" d="${glyph.d}" fill="none" ${stroke}/>${suitAt(suit, 40, 126, 38, ink)}`;
}

function frame(palette, fill) {
  const edge = `stroke="${palette.edge}" stroke-width="1" vector-effect="non-scaling-stroke"`;
  return `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${RADIUS}" fill="${fill}" ${edge}/>`;
}

function svg(body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${body}</svg>\n`;
}

function face(rank, suit, palette) {
  const ink = RED_SUITS.has(suit) ? palette.red : palette.black;
  const parts = [frame(palette, palette.face), cornerIndex(rank, suit, ink)];
  parts.push(`<g transform="rotate(180 ${W / 2} ${H / 2})">${cornerIndex(rank, suit, ink)}</g>`);
  // A court card is told from a pip card by a frame round its symbol, as on a printed deck.
  if (COURTS.has(rank)) {
    parts.push(
      `<rect x="80" y="44" width="90" height="262" rx="6" fill="none" stroke="${ink}" stroke-width="4"/>`,
    );
  }
  parts.push(suitAt(suit, W / 2, H / 2, CENTRE_SIZE[rank] ?? 96, ink));
  return svg(parts.join(''));
}

/** A white margin round a lattice panel. The margin is what separates a dark back from a dark felt. */
function back(name, palette) {
  const fill = palette[`back-${name}`];
  const line = palette[`back-${name}-line`];
  const lattice =
    `<pattern id="lattice" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<path d="M0 0H28M0 0V28" stroke="${line}" stroke-width="3"/></pattern>`;
  return svg(
    `<defs>${lattice}</defs>${frame(palette, palette.face)}` +
      `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="10" fill="${fill}"/>` +
      `<rect x="16" y="16" width="${W - 32}" height="${H - 32}" rx="10" fill="url(#lattice)"/>` +
      `<rect x="30" y="30" width="${W - 60}" height="${H - 60}" rx="6" fill="none" stroke="${line}" stroke-width="4"/>`,
  );
}

/** Every file the deck consists of, by name. */
export function renderDeck(palette) {
  const files = new Map();
  for (const rank of RANKS)
    for (const suit of SUITS) files.set(`${rank}${suit}.svg`, face(rank, suit, palette));
  for (const name of BACKS) files.set(`back-${name}.svg`, back(name, palette));
  files.set('back.svg', back(BACKS[0], palette));
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const files = renderDeck(readPalette(readFileSync(TOKENS, 'utf8')));
  mkdirSync(DECK_DIR, { recursive: true });
  const onDisk = new Set(readdirSync(DECK_DIR));
  const drift = [];
  for (const [name, content] of files) {
    const current = onDisk.has(name) ? readFileSync(join(DECK_DIR, name), 'utf8') : null;
    if (current === content) continue;
    drift.push(name);
    if (!check) writeFileSync(join(DECK_DIR, name), content);
  }
  const strays = [...onDisk].filter((name) => !files.has(name));
  if (check) {
    if (drift.length > 0 || strays.length > 0) {
      console.error(
        `Deck out of date: ${[...drift, ...strays].join(', ')}. Run: node scripts/cards/generate.mjs`,
      );
      process.exit(1);
    }
    console.log(`${files.size} card files match tokens.css.`);
    return;
  }
  if (strays.length > 0) console.error(`Not generated, remove by hand: ${strays.join(', ')}`);
  console.log(`${files.size} card files, ${drift.length} rewritten.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
