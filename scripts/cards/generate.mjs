#!/usr/bin/env node
/**
 * Writes the deck the web app shows: one SVG per card (`KH.svg`, `TS.svg`) and the backs, into
 * `apps/web/public/cards/`. Ranks and suits are paths authored here, never `<text>`, so a face does not
 * depend on the reader's fonts. Each file's `<title>` names the card in words: metadata, never drawn.
 * The colours come from `--prl-deck-*` in tokens.css, so the contrast gate measures what the files paint.
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

const PALETTE_KEYS = ['face', 'edge', 'red', 'black', 'back-charcoal', 'back-charcoal-line'];

/** Charcoal, because a green back sinks into the felt and a wine back sits close to the red suit ink. */
export const BACK = 'charcoal';

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['C', 'D', 'H', 'S'];
const RANK_WORDS = {
  2: 'Two',
  3: 'Three',
  4: 'Four',
  5: 'Five',
  6: 'Six',
  7: 'Seven',
  8: 'Eight',
  9: 'Nine',
  T: 'Ten',
  J: 'Jack',
  Q: 'Queen',
  K: 'King',
  A: 'Ace',
};
const SUIT_WORDS = { C: 'clubs', D: 'diamonds', H: 'hearts', S: 'spades' };
export const BACK_TITLE = 'Card back';

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
const CX = W / 2;
const CY = H / 2;

/**
 * Filled rank indexes, each in a box `w` by `h`. Court letters carry a serif cap and serif feet.
 * `evenodd` punches the counter. Paths only: a face must not ask the reader for a font.
 */
const RANK_GLYPHS = {
  2: {
    w: 40,
    h: 56,
    d:
      'M8 16C8 6 15 0 23 0C33 0 40 7 40 17C40 28 32 34 16 46L8 52H40V56H2V46L22 32' +
      'C30 26 32 22 32 16C32 10 28 6 23 6C16 6 13 10 13 15H8Z',
  },
  3: {
    w: 40,
    h: 56,
    d:
      'M6 10C10 2 16 0 22 0C32 0 40 6 40 15C40 22 35 27 28 29C36 31 42 37 42 46' +
      'C42 54 33 56 23 56C12 56 3 52 2 44H11C12 48 17 50 23 50C31 50 33 46 33 42' +
      'C33 36 27 32 18 32H12V26H20C30 26 32 21 32 16C32 10 27 6 22 6C15 6 11 10 10 14H6Z',
  },
  4: {
    w: 36,
    h: 56,
    rule: 'evenodd',
    d: 'M22 0H32V56H22V36H0V26L22 0ZM24 12L12 28H24Z',
  },
  5: {
    w: 40,
    h: 56,
    d:
      'M4 0H36V8H14L12 20H22C34 20 42 28 42 40C42 52 32 56 22 56C10 56 2 50 2 40H12' +
      'C12 46 16 48 22 48C30 48 32 44 32 40C32 34 26 30 18 30H6L10 0H4Z',
  },
  6: {
    w: 40,
    h: 56,
    d:
      'M22 26C32 26 38 34 38 44C38 52 32 56 22 56C12 56 4 52 4 44C4 34 12 26 22 26Z' +
      'M22 34C16 34 12 38 12 44C12 48 16 50 22 50C28 50 30 48 30 44C30 38 28 34 22 34Z' +
      'M30 6C20 0 8 4 4 16C2 26 6 34 8 38L16 36C14 28 12 20 18 12C22 8 28 8 32 14L30 6Z',
  },
  7: { w: 40, h: 56, d: 'M0 0H40L18 56H8L28 10H0Z' },
  8: {
    w: 40,
    h: 56,
    d:
      'M20 0C30 0 36 6 36 14C36 22 30 26 20 26C10 26 4 22 4 14C4 6 10 0 20 0Z' +
      'M20 6C15 6 12 9 12 14C12 18 15 20 20 20C25 20 28 18 28 14C28 9 25 6 20 6Z' +
      'M20 24C32 24 38 32 38 42C38 52 32 56 20 56C8 56 2 52 2 42C2 32 8 24 20 24Z' +
      'M20 32C14 32 10 36 10 42C10 48 14 50 20 50C26 50 30 48 30 42C30 36 26 32 20 32Z',
  },
  9: {
    w: 40,
    h: 56,
    d:
      'M20 0C32 0 38 8 38 18C38 28 30 34 20 34C10 34 4 28 4 18C4 8 10 0 20 0Z' +
      'M20 8C14 8 10 12 10 18C10 24 14 26 20 26C26 26 30 24 30 18C30 12 26 8 20 8Z' +
      'M28 22L38 26C40 38 38 48 32 54L22 56C28 46 26 36 20 30Z',
  },
  T: {
    w: 58,
    h: 56,
    rule: 'evenodd',
    d:
      'M0 0H10V56H0ZM34 0C22 0 16 12 16 28C16 44 22 56 34 56C46 56 52 44 52 28C52 12 46 0 34 0Z' +
      'M34 10C40 10 42 16 42 28C42 40 40 46 34 46C28 46 26 40 26 28C26 16 28 10 34 10Z',
  },
  J: {
    w: 36,
    h: 56,
    d: 'M0 0H36V8H26V34C26 46 18 54 8 54C2 54 0 50 0 44H10C10 46 12 46 14 46' + 'C18 46 18 40 18 34V8H0Z',
  },
  Q: {
    w: 46,
    h: 62,
    rule: 'evenodd',
    d:
      'M23 0C36 0 46 12 46 28C46 44 36 56 23 56C10 56 0 44 0 28C0 12 10 0 23 0Z' +
      'M23 10C16 10 10 17 10 28C10 39 16 46 23 46C30 46 36 39 36 28C36 17 30 10 23 10Z',
    extra: 'M34 38L54 56H42L28 44Z',
  },
  K: {
    w: 44,
    h: 56,
    d: 'M0 0H16V5H11V51H16V56H0V51H5V5H0ZM12 22L34 0H44L20 28L44 56H34L12 34Z',
  },
  A: {
    w: 44,
    h: 56,
    rule: 'evenodd',
    d: 'M12 0H32L36 8L44 56H33L30 44H14L11 56H0L8 8ZM22 16L16 36H28Z',
  },
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

const round = (n) => Number(n.toFixed(3)).toString();

function suitAt(suit, cx, cy, size, ink) {
  const scale = size / 100;
  const at = `translate(${round(cx - size / 2)} ${round(cy - size / 2)}) scale(${round(scale)})`;
  return `<g transform="${at}" fill="${ink}">${SUIT_SHAPES[suit].map((d) => `<path d="${d}"/>`).join('')}</g>`;
}

/** Rank over a small suit, in the top-left. The bottom-right copy is this group turned half a circle. */
function cornerIndex(rank, suit, ink) {
  const glyph = RANK_GLYPHS[rank];
  const scale = Math.min(0.62, 46 / glyph.w);
  const x = 14 + (46 - glyph.w * scale) / 2;
  const y = 12;
  const rule = glyph.rule === undefined ? '' : ` fill-rule="${glyph.rule}"`;
  const rankAt = `translate(${round(x)} ${round(y)}) scale(${round(scale)})`;
  const rankMark = `<path transform="${rankAt}" d="${glyph.d}" fill="${ink}"${rule}/>`;
  const extra =
    glyph.extra === undefined ? '' : `<path transform="${rankAt}" d="${glyph.extra}" fill="${ink}"/>`;
  const suitY = y + glyph.h * scale + 16;
  return `${rankMark}${extra}${suitAt(suit, 14 + 23, suitY, 24, ink)}`;
}

function spot(x, y, s, rot = false) {
  return { x, y, s, rot };
}

/** One row of a pip card: two columns, the lower half turned over as on a printed deck. */
function pairRow(y, s, rot, inset) {
  return [spot(CX - inset, y, s, rot), spot(CX + inset, y, s, rot)];
}

/**
 * Classic pip places. The ace is one large symbol. Ten keeps two centre pips between four rows.
 * Coordinates are the card's 250 by 350 box, clear of the corner indexes.
 */
function pipsFor(rank) {
  const inset = 40;
  switch (rank) {
    case 'A':
      return [spot(CX, CY + 4, 122)];
    case '2':
      return [spot(CX, 120, 52), spot(CX, 236, 52, true)];
    case '3':
      return [spot(CX, 108, 46), spot(CX, CY, 46), spot(CX, 246, 46, true)];
    case '4':
      return [...pairRow(112, 46, false, inset), ...pairRow(244, 46, true, inset)];
    case '5':
      return [...pairRow(110, 42, false, inset), spot(CX, CY, 42), ...pairRow(246, 42, true, inset)];
    case '6':
      return [
        ...pairRow(102, 40, false, inset),
        ...pairRow(CY, 40, false, inset),
        ...pairRow(252, 40, true, inset),
      ];
    case '7':
      return [
        ...pairRow(98, 36, false, inset),
        spot(CX, 140, 34),
        ...pairRow(CY + 4, 36, false, inset),
        ...pairRow(256, 36, true, inset),
      ];
    case '8':
      return [
        ...pairRow(94, 34, false, 42),
        spot(CX, 136, 32),
        ...pairRow(CY + 2, 34, false, 42),
        spot(CX, 216, 32, true),
        ...pairRow(260, 34, true, 42),
      ];
    case '9':
      return [
        ...pairRow(80, 32, false, 40),
        ...pairRow(120, 32, false, 40),
        spot(CX, CY, 32),
        ...pairRow(230, 32, true, 40),
        ...pairRow(270, 32, true, 40),
      ];
    case 'T':
      return [
        ...pairRow(74, 28, false, 40),
        ...pairRow(110, 28, false, 40),
        spot(CX, 150, 26),
        spot(CX, 198, 26, true),
        ...pairRow(240, 28, true, 40),
        ...pairRow(276, 28, true, 40),
      ];
    default:
      return [];
  }
}

function pip(suit, place, ink) {
  const mark = suitAt(suit, place.x, place.y, place.s, ink);
  if (!place.rot) return mark;
  return `<g transform="rotate(180 ${place.x} ${place.y})">${mark}</g>`;
}

/** A court card: a frame, a small suit in each corner of it, and one suit in the middle. */
function courtFace(suit, ink) {
  const frame = `<rect x="70" y="108" width="110" height="134" rx="8" fill="none" stroke="${ink}" stroke-width="3.5"/>`;
  const corners = [
    spot(92, 128, 18, false),
    spot(158, 128, 18, false),
    spot(92, 222, 18, true),
    spot(158, 222, 18, true),
  ];
  return `${frame}${corners.map((place) => pip(suit, place, ink)).join('')}${suitAt(suit, CX, CY, 58, ink)}`;
}

function frame(palette, fill) {
  const edge = `stroke="${palette.edge}" stroke-width="1" vector-effect="non-scaling-stroke"`;
  return `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="${RADIUS}" fill="${fill}" ${edge}/>`;
}

function svg(title, body) {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  return `${open}<title>${title}</title>${body}</svg>\n`;
}

export const faceTitle = (rank, suit) => `${RANK_WORDS[rank]} of ${SUIT_WORDS[suit]}`;

function face(rank, suit, palette) {
  const ink = RED_SUITS.has(suit) ? palette.red : palette.black;
  const index = cornerIndex(rank, suit, ink);
  const parts = [frame(palette, palette.face), index];
  parts.push(`<g transform="rotate(180 ${CX} ${CY})">${index}</g>`);
  if (COURTS.has(rank)) parts.push(courtFace(suit, ink));
  else for (const place of pipsFor(rank)) parts.push(pip(suit, place, ink));
  return svg(faceTitle(rank, suit), parts.join(''));
}

/** A white margin round a lattice panel. The margin is what separates a dark back from a dark felt. */
function back(name, palette) {
  const fill = palette[`back-${name}`];
  const line = palette[`back-${name}-line`];
  const lattice =
    `<pattern id="lattice" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
    `<path d="M0 0H28M0 0V28" stroke="${line}" stroke-width="3"/></pattern>`;
  return svg(
    BACK_TITLE,
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
  files.set(`back-${BACK}.svg`, back(BACK, palette));
  files.set('back.svg', back(BACK, palette));
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
