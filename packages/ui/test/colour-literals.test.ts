/**
 * Every colour is a token in `tokens.css`, so a theme is one file and the contrast gate sees every
 * value. A literal anywhere else is a colour the gate never measured and a theme switch never moves.
 * Scans every stylesheet in both packages and every `.ts` and `.tsx` source, where a style object,
 * an attribute or a built string could carry one. System colours are allowed, because forced-colors
 * rules and `global-error.tsx` (which loads no stylesheet) need them.
 *
 * Out of scope: the `.svg` files. An SVG loaded as an image cannot read the page's custom
 * properties, so the favicon and the deck in `apps/web/public/cards` must hold literal colours.
 * The deck's are copied from `--prl-deck-*` by `scripts/cards/generate.mjs`, and `cards:check`
 * fails when they drift.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TOKEN_SHEET = 'packages/ui/src/styles/tokens.css';

/** The CSS Color 4 named colours. Keywords and system colours are deliberately absent. */
const NAMED = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown ' +
    'burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ' +
    'ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow ' +
    'lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray ' +
    'lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine ' +
    'mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen ' +
    'mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred ' +
    'papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue ' +
    'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey ' +
    'snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow ' +
    'yellowgreen'
  ).split(' '),
);

const FUNCTION = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/iu;
const HEX = /#[\da-f]{3,8}(?![\w-])/iu;
/** A hex colour inside a longer string. Not after `&` (`&#160;`), `#` or a word character (`/a#b`). */
const HEX_IN_TEXT = /(?<![\w&#])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{3,4})(?![\w-])/iu;
const IDENT = /(?<![\w-])[a-z]+(?![\w-])/giu;

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//gu, ' ');
const stripStrings = (text: string): string => text.replace(/"[^"\n]*"|'[^'\n]*'/gu, '""');

/** What makes `value` a literal colour, or null. `value` is one declaration value or one string. */
function colourLiteralIn(value: string): string | null {
  const hex = HEX.exec(value);
  if (hex !== null) return hex[0];
  const fn = FUNCTION.exec(value);
  if (fn !== null) return fn[0];
  for (const word of value.match(IDENT) ?? []) if (NAMED.has(word.toLowerCase())) return word;
  return null;
}

/** Each `property: value` in a stylesheet, comments and quoted strings (`content`) removed. */
function cssFindings(css: string): string[] {
  const findings: string[] = [];
  const body = stripComments(css);
  for (const match of body.matchAll(/([-\w]+)\s*:\s*([^;{}]+)/gu)) {
    const value = stripStrings(match[2] ?? '');
    const literal = colourLiteralIn(value);
    if (literal !== null) findings.push(`${match[1]}: ${value.trim()}  (${literal})`);
  }
  return findings;
}

/** Style-object keys and SVG paint attributes whose value is a colour. */
const PAINT_KEY =
  /\b(?:color|background(?:Color)?|border(?:Top|Right|Bottom|Left|Block|Inline)?(?:Start|End)?Color|outlineColor|caretColor|textDecorationColor|accentColor|fill|stroke|stopColor|floodColor|lightingColor)\s*[:=]\s*\{?\s*['"]([a-z]+)['"]/giu;

/**
 * The colours in a `.ts` or `.tsx` file: a hex value or a colour function anywhere inside a string,
 * and a colour NAME only where it is painted, as a style-object value or an SVG paint attribute. A
 * name elsewhere is data (`'red'` naming a suit). A hex has to stand alone, so `href="#main"`,
 * `'/learn#odds'` and `'&#160;'` never match.
 */
function sourceFindings(source: string): string[] {
  const findings: string[] = [];
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  for (const match of code.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`/gu)) {
    const text = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (FUNCTION.test(text) || HEX_IN_TEXT.test(text)) findings.push(text);
  }
  for (const match of code.matchAll(PAINT_KEY)) {
    const name = match[1] ?? '';
    if (NAMED.has(name.toLowerCase())) findings.push(name);
  }
  return findings;
}

function walk(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path, keep));
    else if (keep(path)) out.push(path);
  }
  return out;
}

const SOURCE_ROOTS = ['packages/ui/src', 'apps/web/src'].map((root) => join(REPO, root));
const stylesheets = SOURCE_ROOTS.flatMap((root) => walk(root, (file) => file.endsWith('.css')));
const sources = SOURCE_ROOTS.flatMap((root) => walk(root, (file) => /\.tsx?$/u.test(file)));

describe('a colour is declared once, in tokens.css', () => {
  it('reads a non-empty set of stylesheets and components (a sweep of nothing is not a pass)', () => {
    const names = stylesheets.map((file) => relative(REPO, file));
    assert.ok(
      names.includes(TOKEN_SHEET),
      'tokens.css was not found, so the exemption below exempts nothing',
    );
    assert.ok(stylesheets.length >= 10, `only ${stylesheets.length} stylesheets were found`);
    assert.ok(
      sources.filter((file) => file.endsWith('.tsx')).length >= 50,
      'fewer than 50 .tsx files were found',
    );
    assert.ok(
      sources.filter((file) => file.endsWith('.ts')).length >= 50,
      'fewer than 50 .ts files were found',
    );
  });

  it('finds the literals it exists to find (negative controls on the detector itself)', () => {
    assert.equal(cssFindings('.a { color: #fff; }').length, 1);
    assert.equal(cssFindings('.a { background: rgb(0 0 0 / 50%); }').length, 1);
    assert.equal(cssFindings('.a { border-color: hsl(10 20% 30%); }').length, 1);
    assert.equal(cssFindings('.a { color: red; }').length, 1);
    assert.equal(cssFindings('.a { box-shadow: var(--_ring, 0 0 #0000); }').length, 1);
    assert.deepEqual(
      cssFindings(
        '.a { color: currentcolor; background: transparent; border-color: inherit; }' +
          ' .b { color: var(--prl-suit-red); outline-color: Highlight; white-space: nowrap; }' +
          ' .c::after { content: "red"; } /* color: #fff */',
      ),
      [],
    );
    assert.deepEqual(sourceFindings(`const A = { color: '#161b33', b: 'rgb(1 2 3)', fill: "red" };`), [
      '#161b33',
      'rgb(1 2 3)',
      'red',
    ]);
    assert.deepEqual(sourceFindings(`<path fill="black" /><b style={{ backgroundColor: 'white' }} />`), [
      'black',
      'white',
    ]);
    assert.deepEqual(
      sourceFindings(
        `const A = { color: 'CanvasText' }; const SUITS = ['red', 'black']; <a href="#main">Red</a>; // '#fff'`,
      ),
      [],
    );
    assert.deepEqual(
      sourceFindings(
        "const edge = '1px solid #2563eb'; const glow = `0 0 4px ${size} #0000`; el.style.cssText = 'color:#abc';",
      ),
      ['1px solid #2563eb', '0 0 4px ${size} #0000', 'color:#abc'],
    );
    assert.deepEqual(
      sourceFindings(
        "const a = '/learn#pot-odds'; const b = '&#160;'; const c = '#prl-onboarding-step'; const d = '#fade-in';",
      ),
      [],
    );
  });

  it('declares no colour literal in any stylesheet but tokens.css', () => {
    const offenders: string[] = [];
    for (const file of stylesheets) {
      const name = relative(REPO, file);
      if (name === TOKEN_SHEET) continue;
      for (const finding of cssFindings(readFileSync(file, 'utf8'))) offenders.push(`${name}  ${finding}`);
    }
    assert.deepEqual(offenders, [], 'Add a token to tokens.css and read it with var() instead.');
  });

  it('puts no colour literal in a component, a style attribute, a style object or a built string', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const finding of sourceFindings(readFileSync(file, 'utf8'))) {
        offenders.push(`${relative(REPO, file)}  ${finding}`);
      }
    }
    assert.deepEqual(offenders, [], 'Style it with a class that reads a --prl-* token.');
  });
});
