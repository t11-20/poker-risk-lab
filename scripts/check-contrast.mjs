#!/usr/bin/env node
/**
 * `pnpm run design:contrast`: recomputes every contrast ratio the design system claims, in both
 * themes, with no dependencies. The WCAG 2.x formulas reproduce every ratio in the design doc
 * (14.00, 9.94, 7.07, ...).
 *
 * Pass 1 reads tokens.css alone (what the doc claims). Pass 2 adds base.css's derived pairings and
 * light-theme repairs (what a browser paints). Pass 3 composites every text element's real
 * background in Chrome. Glass tints are composited over black and white and asserted on the worse.
 * The two-tone focus ring is solved in closed form over every backdrop luminance. Disabled text is
 * reported but not asserted (WCAG exempts inactive controls). Exits 1 if any pass fails.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { waitForDevtools } from './chrome-devtools.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(REPO_ROOT, 'packages/ui/src/styles/tokens.css');
const BASE = join(REPO_ROOT, 'packages/ui/src/styles/base.css');

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);

/**
 * The 0.04045 threshold matches sRGB. WCAG 2.0's 0.03928 agrees to eleven decimal places either side
 * of the boundary, so it cannot change a ratio.
 */
function toLinear(channel8Bit) {
  const c = channel8Bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance({ r, g, b }) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Source-over in gamma-encoded sRGB, because that is what a browser does. */
function composite(source, backdrop) {
  if (source.a >= 1) return source;
  const mix = (s, b) => Math.round(s * source.a + b * (1 - source.a));
  return { r: mix(source.r, backdrop.r), g: mix(source.g, backdrop.g), b: mix(source.b, backdrop.b), a: 1 };
}

const HEX_SHORT = /^#([\da-f])([\da-f])([\da-f])([\da-f])?$/i;
const HEX_LONG = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i;
const RGB_FN = /^rgba?\(([^)]+)\)$/i;

/** Returns null for anything that is not a colour, so callers can skip it. */
function parseColor(value) {
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };

  const short = HEX_SHORT.exec(text);
  if (short) {
    const [, r, g, b, a] = short;
    return {
      r: Number.parseInt(`${r}${r}`, 16),
      g: Number.parseInt(`${g}${g}`, 16),
      b: Number.parseInt(`${b}${b}`, 16),
      a: a === undefined ? 1 : Number.parseInt(`${a}${a}`, 16) / 255,
    };
  }

  const long = HEX_LONG.exec(text);
  if (long) {
    const [, r, g, b, a] = long;
    return {
      r: Number.parseInt(r, 16),
      g: Number.parseInt(g, 16),
      b: Number.parseInt(b, 16),
      a: a === undefined ? 1 : Number.parseInt(a, 16) / 255,
    };
  }

  const fn = RGB_FN.exec(text);
  if (fn) {
    const [channels, alpha] = fn[1].split('/');
    const parts = channels
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const chan = (raw) => {
      const n = Number.parseFloat(raw);
      if (Number.isNaN(n)) return null;
      return raw.includes('%') ? Math.round((n / 100) * 255) : Math.round(n);
    };
    const r = chan(parts[0]);
    const g = chan(parts[1]);
    const b = chan(parts[2]);
    if (r === null || g === null || b === null) return null;
    const rawAlpha = alpha ?? parts[3];
    let a = 1;
    if (rawAlpha !== undefined) {
      const n = Number.parseFloat(rawAlpha);
      if (!Number.isNaN(n)) a = rawAlpha.includes('%') ? n / 100 : n;
    }
    return { r, g, b, a };
  }

  return null;
}

/* A brace-depth scanner, not a CSS parser. It records the selector scope of each `--prl-*`
   declaration. Values here never contain `{`, `}` or `;`. Comments are stripped first so a
   commented-out token is not read. */

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function scanDeclarations(css) {
  const out = [];
  const stack = [];
  let buffer = '';

  for (const char of stripComments(css)) {
    if (char === '{') {
      stack.push(buffer.trim());
      buffer = '';
    } else if (char === '}') {
      stack.pop();
      buffer = '';
    } else if (char === ';') {
      const colon = buffer.indexOf(':');
      if (colon > 0) {
        const prop = buffer.slice(0, colon).trim();
        if (prop.startsWith('--prl-')) {
          out.push({ scope: [...stack], prop, value: buffer.slice(colon + 1).trim() });
        }
      }
      buffer = '';
    } else {
      buffer += char;
    }
  }

  return out;
}

/**
 * `dark` is the bare `:root`. The two light scopes are kept apart so drift between the media query
 * and `[data-theme="light"]` is caught.
 */
function classifyScope(scope) {
  const inner = scope.at(-1) ?? '';
  const outer = scope.length > 1 ? scope[0] : '';
  if (outer.includes('forced-colors') || outer.includes('prefers-reduced-motion')) return null;
  if (inner === ':root' && scope.length === 1) return 'dark';
  if (outer.includes('prefers-color-scheme: light') && inner.startsWith(':root')) return 'light-media';
  if (inner === ':root[data-theme="light"]') return 'light-explicit';
  return null;
}

/** Later files override earlier ones, as the cascade does. Also returns the two light scopes. */
function buildThemes(files) {
  const dark = new Map();
  const lightMedia = new Map();
  const lightExplicit = new Map();

  for (const file of files) {
    for (const decl of scanDeclarations(readFileSync(file, 'utf8'))) {
      const theme = classifyScope(decl.scope);
      if (theme === 'dark') dark.set(decl.prop, decl.value);
      if (theme === 'light-media') lightMedia.set(decl.prop, decl.value);
      if (theme === 'light-explicit') lightExplicit.set(decl.prop, decl.value);
    }
  }

  return { dark, light: new Map([...dark, ...lightExplicit]), lightMedia, lightExplicit };
}

const VAR_REF = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/;

function resolveToken(name, map, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const raw = map.get(name);
  if (raw === undefined) return null;
  const ref = VAR_REF.exec(raw.trim());
  if (!ref) return raw.trim();
  const referenced = resolveToken(ref[1], map, seen);
  if (referenced !== null) return referenced;
  return ref[2] === undefined ? null : ref[2].trim();
}

/* `hover` and `active` only sit behind a control's own label, so they are asserted against control
   tokens. Every other text token is asserted against the content surfaces. */

const CONTENT_SURFACES = [
  '--prl-surface-page',
  '--prl-surface-raised',
  '--prl-surface-panel',
  '--prl-surface-inset',
  '--prl-surface-table',
  // The brightest page-wash stop over the ground. See `deriveSurfaces`.
  '--prl-surface-wash',
];

const INTERACTION_SURFACES = ['--prl-surface-hover', '--prl-surface-active'];
const ALL_SURFACES = [...CONTENT_SURFACES, ...INTERACTION_SURFACES];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** 200 to 500 carry text. 600 and below never do, so they are printed but not asserted. */
const ACCENT_FILL_STEPS = [
  '--prl-accent-200',
  '--prl-accent-300',
  '--prl-accent-400',
  '--prl-accent-500',
  // Declared in base.css, so it prints as `-` in pass 1.
  '--prl-accent-fill',
];

const ACCENT_RAMP = [
  '--prl-accent-200',
  '--prl-accent-300',
  '--prl-accent-400',
  '--prl-accent-500',
  '--prl-accent-600',
  '--prl-accent-700',
  '--prl-accent-800',
  '--prl-accent-900',
];

const GROUPS = [
  {
    id: 'body-text',
    title: 'Body text on every surface',
    rule: 'WCAG 1.4.3 Contrast (Minimum), AA body text',
    min: AA_TEXT,
    foregrounds: ['--prl-text', '--prl-text-secondary', '--prl-text-muted', '--prl-text-faint'],
    backgrounds: ALL_SURFACES,
  },
  {
    id: 'semantic-text',
    title: 'Semantic and accent colours used as text',
    rule: 'WCAG 1.4.3. These carry a sign, glyph or word as well as the colour',
    min: AA_TEXT,
    foregrounds: ['--prl-favourable', '--prl-adverse', '--prl-caution', '--prl-info', '--prl-accent-text'],
    backgrounds: CONTENT_SURFACES,
  },
  {
    id: 'meaningful-borders',
    title: 'Meaningful borders and the focus ring',
    rule: 'WCAG 1.4.11 Non-text Contrast. Decorative hairlines are exempt and excluded',
    min: AA_NON_TEXT,
    foregrounds: ['--prl-line-strong', '--prl-line-accent', '--prl-accent-edge', '--prl-focus-color'],
    backgrounds: ALL_SURFACES,
  },
  {
    id: 'series',
    title: 'Chart series on every surface',
    rule: 'WCAG 1.4.11. Each series also carries a distinct fill pattern',
    min: AA_NON_TEXT,
    foregrounds: [
      '--prl-series-a',
      '--prl-series-b',
      '--prl-series-c',
      '--prl-series-d',
      '--prl-series-e',
      '--prl-series-f',
    ],
    backgrounds: ALL_SURFACES,
  },
  {
    id: 'suits',
    title: 'Suits on both card faces',
    rule: 'WCAG 1.4.3. Card faces stay light in both themes',
    min: AA_TEXT,
    foregrounds: ['--prl-suit-spade', '--prl-suit-heart', '--prl-suit-diamond', '--prl-suit-club'],
    backgrounds: ['--prl-card-face', '--prl-card-face-dim'],
  },
  {
    id: 'text-on-accent',
    title: 'Text on an accent fill',
    rule: 'WCAG 1.4.3. The ink INVERTS with the theme; see the ink-on-accent control below',
    min: AA_TEXT,
    foregrounds: ['--prl-text-on-accent'],
    backgrounds: ACCENT_FILL_STEPS,
  },
];

/** Reported, never asserted. Disabled text and decorative hairlines are exempt. */
const INFORMATIONAL = [
  {
    id: 'exempt',
    title: 'Exempt by definition - measured for the record, not asserted',
    rule: 'disabled text: WCAG 1.4.3 exempts inactive controls. Hairlines: decorative only',
    foregrounds: ['--prl-text-disabled', '--prl-line-subtle', '--prl-line'],
    backgrounds: CONTENT_SURFACES,
  },
];

/* Glass has no single ratio. Every tint is composited over the bounding backdrops
   (`--prl-glass-backdrop-min`/`-max`, black and white) and the worse result is asserted. Which
   extreme binds flips with the theme. */

const GLASS_LEVELS = [
  { tint: '--prl-glass-floating', title: 'L3 floating  - pills, toolbars, chips, action bar' },
  { tint: '--prl-glass-floating-hover', title: 'L3 floating, hovered' },
  { tint: '--prl-glass-floating-active', title: 'L3 floating, pressed' },
  { tint: '--prl-glass-overlay', title: 'L4 overlay   - popovers, menus, sheets' },
  { tint: '--prl-glass-overlay-hover', title: 'L4 overlay, hovered' },
];

/**
 * The whole content ramp, `--prl-text-faint` included. At 4.55:1 worst it has the least headroom, so
 * it is the row that notices first if a tint gets more transparent.
 */
const GLASS_TEXT = [
  '--prl-text',
  '--prl-text-secondary',
  '--prl-text-muted',
  '--prl-text-faint',
  '--prl-accent-text',
  '--prl-favourable',
  '--prl-adverse',
  '--prl-caution',
  '--prl-info',
];

const GLASS_NON_TEXT = ['--prl-line-strong', '--prl-accent-edge', '--prl-focus-color'];

/**
 * Expected to FAIL: the negative control for the glass rows. Both tokens are decorative by definition
 * (tokens.css rule B). A row that starts clearing its floor is reported, not failed.
 */
const GLASS_EXCLUDED = [
  { tint: '--prl-line', floor: AA_NON_TEXT },
  { tint: '--prl-line-subtle', floor: AA_NON_TEXT },
];

function glassOver(tintToken, backdropToken, map) {
  const backdrop = colorOf(backdropToken, map);
  const tint = colorOf(tintToken, map);
  if (backdrop === null || tint === null) return null;
  return composite(tint, backdrop);
}

/**
 * Each colour clears 3:1 for `Lb <= (Lf + 0.05) / 3 - 0.05` or `Lb >= 3 * (Lf + 0.05) - 0.05`, so it
 * fails only inside `(lo, hi)`. The ring and halo work everywhere when their failure intervals do not
 * intersect in [0, 1].
 */
function ringCoverage(color) {
  const l = relativeLuminance(color);
  return { lo: (l + 0.05) / AA_NON_TEXT - 0.05, hi: AA_NON_TEXT * (l + 0.05) - 0.05 };
}

const shortName = (token) => token.replace('--prl-', '');

const toHex = ({ r, g, b }) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/**
 * `--prl-page-wash` is a gradient, so its brightest stop (`--prl-wash-tint`) is composited over the
 * ground and treated as covering the page. Injected into the theme maps only, never the light scopes
 * compared for drift.
 */
function deriveSurfaces(map) {
  const page = colorOf('--prl-surface-page', map);
  const tint = colorOf('--prl-wash-tint', map);
  if (page !== null && tint !== null) map.set('--prl-surface-wash', toHex(composite(tint, page)));
}

function colorOf(token, map, backdrop) {
  const resolved = resolveToken(token, map);
  if (resolved === null) return null;
  const parsed = parseColor(resolved);
  if (parsed === null) return null;
  return backdrop === undefined ? parsed : composite(parsed, backdrop);
}

function evaluateGroup(group, map) {
  const rows = [];
  const failures = [];

  for (const fg of group.foregrounds) {
    const cells = [];
    for (const bg of group.backgrounds) {
      const bgColor = colorOf(bg, map);
      if (bgColor === null) {
        cells.push({ bg, ratio: null });
        continue;
      }
      const fgColor = colorOf(fg, map, bgColor);
      if (fgColor === null) {
        cells.push({ bg, ratio: null });
        continue;
      }
      const ratio = contrastRatio(fgColor, bgColor);
      const failed = group.min !== undefined && ratio < group.min;
      cells.push({ bg, ratio, failed });
      if (failed) failures.push({ group: group.id, fg, bg, ratio, min: group.min });
    }
    rows.push({ fg, cells });
  }

  return { rows, failures };
}

const COL = 9;
const LABEL = 22;

function printMatrix(group, result) {
  const header = group.backgrounds.map((bg) => shortName(bg).replace('surface-', '').padStart(COL));
  console.log(`  ${''.padEnd(LABEL)}${dim(header.join(''))}`);

  for (const row of result.rows) {
    const cells = row.cells.map((cell) => {
      if (cell.ratio === null) return dim('-'.padStart(COL));
      const text = `${cell.ratio.toFixed(2)}${cell.failed ? '!' : ' '}`.padStart(COL);
      if (cell.failed) return red(text);
      return group.min === undefined ? dim(text) : text;
    });
    console.log(`  ${shortName(row.fg).padEnd(LABEL)}${cells.join('')}`);
  }
}

/** Prints the tint over black, over white, and the worse of the two, and asserts on the worse. */
function evaluateGlass(map, themeName) {
  const failures = [];
  const min = '--prl-glass-backdrop-min';
  const max = '--prl-glass-backdrop-max';
  if (colorOf(min, map) === null || colorOf(max, map) === null) return failures;

  console.log('');
  console.log(`  Glass: every tint over BOTH bounding backdrops  ${dim('worst of the two is asserted')}`);
  console.log(
    dim(`  backdrop range ${resolveToken(min, map)} .. ${resolveToken(max, map)} - nothing a display`),
  );
  console.log(dim('  can paint is outside it, so a ratio that holds at both holds over any content'));

  const rows = [
    ...GLASS_TEXT.map((fg) => ({ fg, floor: AA_TEXT, asserted: true })),
    ...GLASS_NON_TEXT.map((fg) => ({ fg, floor: AA_NON_TEXT, asserted: true })),
    ...GLASS_EXCLUDED.map((row) => ({ fg: row.tint, floor: row.floor, asserted: false })),
  ];

  for (const level of GLASS_LEVELS) {
    const dark = glassOver(level.tint, min, map);
    const light = glassOver(level.tint, max, map);
    if (dark === null || light === null) continue;

    console.log('');
    console.log(`  ${shortName(level.tint).padEnd(LABEL)}${dim(level.title)}`);
    console.log(
      `  ${''.padEnd(LABEL)}${dim(['over min', 'over max', 'worst'].map((h) => h.padStart(COL)).join(''))}`,
    );

    for (const row of rows) {
      const overDark = colorOf(row.fg, map, dark);
      const overLight = colorOf(row.fg, map, light);
      if (overDark === null || overLight === null) continue;
      const a = contrastRatio(overDark, dark);
      const b = contrastRatio(overLight, light);
      const worst = Math.min(a, b);
      const bad = worst < row.floor;
      const cells = [a, b, worst].map((n) => n.toFixed(2).padStart(COL));
      const line = `  ${shortName(row.fg).padEnd(LABEL)}${cells.join('')}`;

      if (!row.asserted) {
        // The negative control. Reported either way, never asserted.
        const note = bad
          ? dim(`  decorative only, as expected (a meaningful border needs ${row.floor.toFixed(1)}:1)`)
          : yellow(`  now clears ${row.floor.toFixed(1)}:1 - re-read the exclusion, it may be stale`);
        console.log(dim(line) + note);
        continue;
      }

      console.log(bad ? red(`${line}!`) : line);
      if (bad) {
        failures.push({
          group: 'glass',
          fg: row.fg,
          bg: level.tint,
          ratio: worst,
          min: row.floor,
          theme: themeName,
        });
      }
    }
  }

  return failures;
}

/** The assertion is that the ring's and halo's failure intervals do not overlap at all. */
function evaluateFocusIndicator(map, themeName) {
  const ringColor = colorOf('--prl-focus-color', map);
  const haloColor = colorOf('--prl-focus-halo', map);
  if (ringColor === null || haloColor === null) return [];

  const ring = ringCoverage(ringColor);
  const halo = ringCoverage(haloColor);
  const gapLow = Math.max(Math.min(ring.lo, ring.hi), Math.min(halo.lo, halo.hi), 0);
  const gapHigh = Math.min(Math.max(ring.lo, ring.hi), Math.max(halo.lo, halo.hi), 1);
  const defeated = gapLow < gapHigh;

  const span = ({ lo, hi }) => `fails only for backdrop L in (${lo.toFixed(3)}, ${hi.toFixed(3)})`;
  console.log('');
  console.log('  Focus indicator on glass: no backdrop may defeat BOTH tones');
  console.log(dim('  WCAG 1.4.11 at 3:1, solved over every backdrop luminance in [0, 1]'));
  console.log(`  ${'focus-color'.padEnd(LABEL)}${dim(span(ring))}`);
  console.log(`  ${'focus-halo'.padEnd(LABEL)}${dim(span(halo))}`);
  console.log(
    `  ${'overlap'.padEnd(LABEL)}${
      defeated
        ? red(`(${gapLow.toFixed(3)}, ${gapHigh.toFixed(3)}) - both tones invisible there`)
        : green('empty - the ring is visible over every possible backdrop')
    }`,
  );

  if (!defeated) return [];
  return [
    {
      group: 'focus-indicator',
      fg: '--prl-focus-color',
      bg: '--prl-focus-halo',
      ratio: contrastRatio(ringColor, haloColor),
      min: AA_NON_TEXT,
      theme: themeName,
    },
  ];
}

function runPass(label, files, note) {
  const themes = buildThemes(files);
  console.log('');
  console.log(bold(`${label}`));
  console.log(dim(`  ${note}`));
  console.log(dim(`  ${files.map((f) => relative(REPO_ROOT, f)).join(' + ')}`));

  const failures = [];

  for (const themeName of ['dark', 'light']) {
    const map = themes[themeName];
    deriveSurfaces(map);
    console.log('');
    console.log(`  ${bold(themeName.toUpperCase())}`);

    for (const group of GROUPS) {
      console.log('');
      console.log(`  ${group.title}  ${dim(`>= ${group.min.toFixed(1)}:1`)}`);
      console.log(dim(`  ${group.rule}`));
      const result = evaluateGroup(group, map);
      printMatrix(group, result);
      for (const failure of result.failures) failures.push({ ...failure, theme: themeName });
    }

    for (const group of INFORMATIONAL) {
      console.log('');
      console.log(`  ${group.title}`);
      console.log(dim(`  ${group.rule}`));
      printMatrix(group, evaluateGroup(group, map));
    }

    // The accent ramp, printed as a lookup table for picking an accent fill. Not an assertion.
    console.log('');
    console.log('  Accent ramp: is this step safe to put --prl-text-on-accent on?');
    const onAccent = colorOf('--prl-text-on-accent', map);
    for (const step of ACCENT_RAMP) {
      const fill = colorOf(step, map);
      if (fill === null || onAccent === null) continue;
      const ratio = contrastRatio(onAccent, fill);
      const eligible = ratio >= AA_TEXT;
      const verdict = eligible ? green('fill-eligible') : dim('ink only, never a text fill');
      console.log(`  ${shortName(step).padEnd(LABEL)}${ratio.toFixed(2).padStart(COL)}  ${verdict}`);
    }

    /**
     * `--prl-text-on-accent` must be the better of near-black and white on the current fill. The light
     * theme inverts the fill, so it must invert the ink (dark: ink-900 9.39:1, white 2.07:1).
     */
    const fill = colorOf('--prl-accent-fill', map) ?? colorOf('--prl-accent-500', map);
    const ink = colorOf('--prl-text-on-accent', map);
    if (fill !== null && ink !== null) {
      const white = { r: 255, g: 255, b: 255, a: 1 };
      const nearBlack = colorOf('--prl-ink-900', map) ?? { r: 0, g: 0, b: 0, a: 1 };
      const chosen = contrastRatio(ink, fill);
      const whiteRatio = contrastRatio(white, fill);
      const blackRatio = contrastRatio(nearBlack, fill);
      const best = Math.max(whiteRatio, blackRatio);
      const isBest = chosen >= best - 0.01;

      console.log('');
      console.log('  Ink on the accent fill: the token must be the BETTER of the two candidates');
      console.log(`  ${'white'.padEnd(LABEL)}${whiteRatio.toFixed(2).padStart(COL)}`);
      console.log(`  ${'ink-900'.padEnd(LABEL)}${blackRatio.toFixed(2).padStart(COL)}`);
      const verdict = isBest ? green('picked the better ink') : red('picked the WORSE ink');
      console.log(`  ${'text-on-accent'.padEnd(LABEL)}${chosen.toFixed(2).padStart(COL)}  ${verdict}`);
      if (!isBest) {
        failures.push({
          group: 'ink-on-accent',
          fg: '--prl-text-on-accent',
          bg: '--prl-accent-fill',
          ratio: chosen,
          min: Number(best.toFixed(2)),
          theme: themeName,
        });
      }
    }

    for (const failure of evaluateGlass(map, themeName)) failures.push(failure);
    for (const failure of evaluateFocusIndicator(map, themeName)) failures.push(failure);
  }

  // The two light scopes must agree, or the theme a reader gets depends on how they chose it.
  const drift = [];
  for (const [prop, value] of themes.lightExplicit) {
    if (themes.lightMedia.get(prop) !== value) drift.push(prop);
  }
  for (const [prop] of themes.lightMedia) {
    if (!themes.lightExplicit.has(prop)) drift.push(prop);
  }

  console.log('');
  console.log('  Light theme declared twice - the media query and [data-theme="light"] must agree');
  if (drift.length === 0) {
    console.log(`  ${green('in sync')} ${dim(`(${themes.lightExplicit.size} declarations)`)}`);
  } else {
    console.log(`  ${red(`${drift.length} declaration(s) differ:`)} ${[...new Set(drift)].join(', ')}`);
    for (const prop of new Set(drift)) {
      failures.push({ group: 'theme-drift', fg: prop, bg: 'light-media vs light-explicit' });
    }
  }

  return failures;
}

/* Pass 3: the painted layer, in real Chrome. Token pairs cannot see `opacity` on a container (folded
   seats at 0.9 opacity measured 4.09:1 while the token pair was unchanged). For each text element the
   walk collects ancestor backgrounds and covering positioned pseudo-elements, composites them as
   nested opacity groups, and paints the glyph with and without the text colour.

   The walk stops at the first opaque layer. BOUNDED: a still-translucent stack crossing a floating
   element is composited over black and white, and gradients are bounded on their stop path.
   UNMEASURED: `url()` images, `background-clip: text`, blend modes and filters are fatal. EXEMPT:
   disabled controls are printed, not asserted. Unpainted and visually-hidden text is counted.

   The model is checked against 5x5 screenshot patches. A single-colour composite must match within
   one 8-bit step, a bounded row must contain the painted pixel, and the ratio is re-measured on the
   pixel. `box-shadow` is not modelled, so shadowed points assert the painted pixel only. Motion is
   off so animations cannot move geometry between walk and screenshot. Not covered: hover, focus and
   active states, per-element borders, overlapping siblings. */

/**
 * The routes this pass sweeps.
 *
 * Every screen of the redesign rather than a sample, because the defect being closed is a class
 * that lives in whichever component happened to stack two translucent things - and a route list
 * covering "the important pages" covers the pages somebody already thought about.
 *
 * `/play` is entered through its fixture states rather than a live table, for the reason
 * `scripts/ax-tree-audit.mjs` gives at its own journey list: the fixture renders the same
 * component tree with no database behind it, so this gate fails on a contrast defect and never
 * on Postgres being down.
 */
const PAINTED_ROUTES = [
  '/',
  '/learn',
  '/learn/pot-odds',
  '/play?state=decision',
  '/play?state=complete',
  '/lab',
  '/lab/fl-same-cards-under-the-gun',
  '/legends',
  '/legends/adaptive-exploiter',
  '/review',
  '/legends/hand-review/demo',
  // `/learn/glossary`, not `/glossary`. The first full run of this pass listed the second one and
  // the error-boundary refusal above caught it: 68 text elements had been measured, all of them
  // belonging to `not-found.tsx`, which is correct markup for a page nobody meant to sweep.
  '/learn/glossary',
  '/terms',
  '/privacy',
  '/responsible-use',
  // The evidence behind the home page's figures, moved off the home page in the 4.0 re-identity.
  '/checks',
];

/**
 * tokens.css collapses glass to opaque surfaces under these preferences, which changes which token
 * each pane resolves to. Two routes each.
 */
const PAINTED_CONDITIONS = [
  // `id`, not `key`: secret-scan.mjs reads a `key` name with a 20+ character literal as a credential.
  { id: 'default', media: [], routes: PAINTED_ROUTES },
  {
    id: 'reduced-transparency',
    media: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
    routes: ['/play?state=decision', '/learn'],
  },
  {
    id: 'contrast-more',
    media: [{ name: 'prefers-contrast', value: 'more' }],
    routes: ['/play?state=decision', '/learn'],
  },
];

/**
 * An error boundary returns 200 and correct markup. The `/play` fixture banner is not one of these.
 */
const ERROR_BOUNDARY_HEADINGS = [
  'this screen did not load',
  'the application could not be displayed',
  'page not found',
  'this replay needs a session',
];

const PAINTED_VIEWPORT = { width: 1440, height: 900 };

const MIN_ROWS_PER_PAGE = 20;

const PROBE_CANDIDATES = 12;
const PROBES_PER_PAGE = 4;

const MIN_PROBES = 24;

/** A predicted background must match the painted pixel to within this, per 8-bit channel. */
const PROBE_TOLERANCE = 2;

/**
 * Runs in the page because only `getComputedStyle` knows what the cascade resolved. Written without
 * backticks or a dollar-brace so it can live in a template literal without a `biome-ignore`.
 */
const PAINT_WALKER = String.raw`
(() => {
  const state = (window.__prlContrast = window.__prlContrast || { seen: new WeakSet() });
  const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };
  const BLACK = { r: 0, g: 0, b: 0, a: 1 };
  const WHITE = { r: 255, g: 255, b: 255, a: 1 };
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE']);
  const MEASURE_ALL = MEASURE_ALL_ARGUMENT;
  const PROBE_BUDGET = PROBE_BUDGET_ARGUMENT;

  const parse = (value) => {
    if (typeof value !== 'string') return null;
    const match = /^rgba?\(([^)]+)\)$/i.exec(value.trim());
    if (match === null) return null;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const over = (src, dst) => {
    const a = src.a + dst.a * (1 - src.a);
    if (a === 0) return TRANSPARENT;
    const ch = (s, d) => (s * src.a + d * dst.a * (1 - src.a)) / a;
    return { r: ch(src.r, dst.r), g: ch(src.g, dst.g), b: ch(src.b, dst.b), a: a };
  };
  const fade = (c, o) => ({ r: c.r, g: c.g, b: c.b, a: c.a * o });
  const lin = (v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const contrast = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  const GRADIENT = /(linear|radial|conic)-gradient\(/i;
  const stopsOf = (image) => {
    if (!GRADIENT.test(image)) return null;
    const found = [];
    const matches = image.match(/rgba?\([^)]*\)/gi) || [];
    for (const raw of matches) {
      const colour = parse(raw);
      if (colour !== null) found.push(colour);
    }
    if (found.length === 0) return null;
    const out = found.slice();
    for (let i = 0; i + 1 < found.length; i += 1) {
      const one = found[i];
      const two = found[i + 1];
      for (const t of [0.25, 0.5, 0.75]) {
        const a = (1 - t) * one.a + t * two.a;
        if (a === 0) continue;
        const ch = (p, q) => ((1 - t) * one.a * p + t * two.a * q) / a;
        out.push({ r: ch(one.r, two.r), g: ch(one.g, two.g), b: ch(one.b, two.b), a: a });
      }
    }
    return out;
  };

  const reduceCandidates = (candidates) => {
    if (candidates.length <= 4) return candidates;
    const keep = [];
    for (const base of [BLACK, WHITE]) {
      let low = candidates[0];
      let high = candidates[0];
      for (const c of candidates) {
        if (lum(over(c, base)) < lum(over(low, base))) low = c;
        if (lum(over(c, base)) > lum(over(high, base))) high = c;
      }
      keep.push(low, high);
    }
    return keep.filter((c, i) => keep.indexOf(c) === i);
  };

  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const contains = (outer, inner) =>
    outer.left <= inner.left + 0.5 &&
    outer.top <= inner.top + 0.5 &&
    outer.right >= inner.right - 0.5 &&
    outer.bottom >= inner.bottom - 0.5;

  const pseudoBox = (host, style) => {
    if (style.position !== 'absolute' && style.position !== 'fixed') return null;
    const box = host.getBoundingClientRect();
    const num = (v) => (v === 'auto' ? null : Number.parseFloat(v));
    const w = Number.parseFloat(style.width);
    const h = Number.parseFloat(style.height);
    if (style.position === 'fixed') {
      const top = num(style.top) === null ? 0 : num(style.top);
      const left = num(style.left) === null ? 0 : num(style.left);
      return {
        top: top,
        left: left,
        right: left + (Number.isNaN(w) ? window.innerWidth : w),
        bottom: top + (Number.isNaN(h) ? window.innerHeight : h),
        fixed: true,
      };
    }
    const t = num(style.top);
    const l = num(style.left);
    const b = num(style.bottom);
    const r = num(style.right);
    const top = t !== null ? box.top + t : b !== null && !Number.isNaN(h) ? box.bottom - b - h : box.top;
    const left = l !== null ? box.left + l : r !== null && !Number.isNaN(w) ? box.right - r - w : box.left;
    return {
      top: top,
      left: left,
      right: left + (Number.isNaN(w) ? box.width : w),
      bottom: top + (Number.isNaN(h) ? box.height : h),
      fixed: false,
    };
  };

  const viewportBox = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

  const layersOf = (node, textRect) => {
    const style = getComputedStyle(node);
    const below = [];
    const above = [];
    const unmeasurable = [];
    const add = (list, colour, image, label, partial) => {
      const solid = parse(colour);
      if (image !== 'none' && image !== '') {
        const stops = stopsOf(image);
        if (stops === null) {
          unmeasurable.push(label + ': background-image ' + image.slice(0, 48));
          return;
        }
        if (solid !== null && solid.a > 0) list.push({ candidates: [solid], label: label });
        const candidates = reduceCandidates(stops);
        list.push({
          candidates: partial ? candidates.concat([null]) : candidates,
          label: label + ' gradient',
        });
        return;
      }
      if (solid === null || solid.a === 0) return;
      list.push({ candidates: partial ? [solid, null] : [solid], label: label });
    };
    add(below, style.backgroundColor, style.backgroundImage, 'background', false);
    for (const pseudo of ['::before', '::after']) {
      const ps = getComputedStyle(node, pseudo);
      if (ps.content === 'none') continue;
      const noPaint =
        ps.backgroundColor === 'rgba(0, 0, 0, 0)' && (ps.backgroundImage === 'none' || ps.backgroundImage === '');
      if (noPaint) continue;
      const box = pseudoBox(node, ps);
      if (box === null) continue;
      const covers = box.fixed && contains(box, viewportBox) ? true : contains(box, textRect);
      if (!covers && !intersects(box, textRect)) continue;
      const zIndex = Number.parseInt(ps.zIndex, 10);
      const target = Number.isFinite(zIndex) && zIndex < 0 ? below : above;
      add(target, ps.backgroundColor, ps.backgroundImage, pseudo + (covers ? '' : ' partial'), !covers);
    }
    const floats =
      style.position === 'absolute' ||
      style.position === 'fixed' ||
      style.position === 'sticky' ||
      (style.backdropFilter !== 'none' && style.backdropFilter !== '');
    if (style.mixBlendMode !== 'normal') unmeasurable.push('mix-blend-mode: ' + style.mixBlendMode);
    if (style.filter !== 'none' && style.filter !== '') unmeasurable.push('filter: ' + style.filter);
    return {
      below: below,
      above: above,
      unmeasurable: unmeasurable,
      opacity: Number(style.opacity),
      floats: floats,
      why:
        style.backdropFilter !== 'none' && style.backdropFilter !== ''
          ? 'backdrop-filter'
          : 'position: ' + style.position,
      style: style,
    };
  };

  const describe = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node !== null && node !== document.documentElement; i += 1) {
      const classes = [];
      for (let c = 0; c < node.classList.length && c < 3; c += 1) classes.push(node.classList[c]);
      parts.unshift(node.tagName.toLowerCase() + (classes.length > 0 ? '.' + classes.join('.') : ''));
      node = node.parentElement;
    }
    return parts.join('>');
  };

  const isDisabled = (el) => {
    let node = el;
    while (node !== null) {
      if (node.matches !== undefined && node.matches(':disabled')) return true;
      if (node.getAttribute !== undefined && node.getAttribute('aria-disabled') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  };

  const CLIPPED_AWAY = /^inset\(\s*(\d+(\.\d+)?)%/;
  const isVisuallyHidden = (el) => {
    let node = el;
    while (node !== null && node !== document.body) {
      const style = getComputedStyle(node);
      const clip = CLIPPED_AWAY.exec(style.clipPath);
      if (clip !== null && Number(clip[1]) >= 50) return true;
      if (style.clip === 'rect(0px, 0px, 0px, 0px)') return true;
      const box = node.getBoundingClientRect();
      if (box.width <= 2 && box.height <= 2 && style.overflow === 'hidden') return true;
      node = node.parentElement;
    }
    return false;
  };

  /* Every box that casts a shadow, with the box that shadow can reach. A drop shadow is painted
     over the surface BEHIND the element that casts it, so a point near an elevated pane is not the
     colour its own ancestors declare - and this walk does not composite shadows. Knowing where one
     can land is what lets the probe below demand exact agreement everywhere else. */
  const shadowReach = [];
  {
    const all = document.body.querySelectorAll('*');
    for (let i = 0; i < all.length; i += 1) {
      const style = getComputedStyle(all[i]);
      if (style.boxShadow === 'none' || style.boxShadow === '') continue;
      const lengths = style.boxShadow.match(/-?\d+(\.\d+)?px/g) || [];
      let reach = 0;
      for (const value of lengths) reach = Math.max(reach, Math.abs(Number.parseFloat(value)));
      const box = all[i].getBoundingClientRect();
      const pad = reach * 2 + 4;
      shadowReach.push({
        left: box.left - pad,
        top: box.top - pad,
        right: box.right + pad,
        bottom: box.bottom + pad,
      });
    }
  }
  const nearShadow = (x, y) => {
    for (const r of shadowReach) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
    return false;
  };

  const counts = {
    candidates: 0,
    measured: 0,
    exact: 0,
    bounded: 0,
    unmeasured: 0,
    exempt: 0,
    notPainted: 0,
    hidden: 0,
    offscreen: 0,
    srOnly: 0,
  };
  const rows = [];
  const probes = [];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let textNode = walker.nextNode(); textNode !== null; textNode = walker.nextNode()) {
    if (textNode.textContent.trim() === '') continue;
    const el = textNode.parentElement;
    if (el === null || SKIP_TAGS.has(el.tagName)) continue;
    if (state.seen.has(el)) continue;

    const range = document.createRange();
    range.selectNodeContents(el);
    const glyphRects = [];
    const list = range.getClientRects();
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].width > 0 && list[i].height > 0) glyphRects.push(list[i]);
    }
    if (glyphRects.length === 0) {
      state.seen.add(el);
      counts.candidates += 1;
      counts.notPainted += 1;
      continue;
    }
    const textRect = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const r of glyphRects) {
      textRect.left = Math.min(textRect.left, r.left);
      textRect.top = Math.min(textRect.top, r.top);
      textRect.right = Math.max(textRect.right, r.right);
      textRect.bottom = Math.max(textRect.bottom, r.bottom);
    }
    const inView = intersects(textRect, viewportBox);
    if (!inView && !MEASURE_ALL) continue;
    state.seen.add(el);
    counts.candidates += 1;
    if (!inView) counts.offscreen += 1;

    if (isVisuallyHidden(el)) {
      counts.srOnly += 1;
      continue;
    }

    const chain = [];
    let node = el;
    let hidden = false;
    let opacityClean = true;
    let cutAt = -1;
    let floatAt = -1;
    const unmeasurable = [];
    while (node !== null) {
      const info = layersOf(node, textRect);
      const index = chain.length;
      chain.push(info);
      if (info.style.display === 'none' || info.style.visibility === 'hidden' || info.opacity === 0) {
        hidden = true;
        break;
      }
      for (const reason of info.unmeasurable) unmeasurable.push(describe(node) + ' ' + reason);
      if (info.opacity < 1) opacityClean = false;
      if (opacityClean) {
        for (let i = info.below.length - 1; i >= 0; i -= 1) {
          if (info.below[i].candidates.every((c) => c !== null && c.a === 1)) {
            info.opaqueFrom = i;
            cutAt = index;
            break;
          }
        }
      }
      if (cutAt >= 0) break;
      if (info.floats && floatAt < 0) floatAt = index;
      node = node.parentElement;
    }
    if (hidden) {
      counts.hidden += 1;
      continue;
    }

    const style = getComputedStyle(el);
    if (style.webkitBackgroundClip === 'text' || style.backgroundClip === 'text') {
      unmeasurable.push(describe(el) + ' background-clip: text');
    }
    const ink = parse(style.webkitTextFillColor) || parse(style.color);
    if (ink === null) unmeasurable.push(describe(el) + ' text colour ' + style.color);

    const base = {
      sel: describe(el),
      text: textNode.textContent.trim().slice(0, 44),
      px: Number.parseFloat(style.fontSize),
      weight: Number.parseInt(style.fontWeight, 10) || 400,
      offscreen: !inView,
      disabled: isDisabled(el),
    };
    if (unmeasurable.length > 0) {
      counts.measured += 1;
      counts.unmeasured += 1;
      rows.push(Object.assign(base, { status: 'unmeasured', why: unmeasurable.slice(0, 3) }));
      continue;
    }

    /* One evaluation of a chain slice over a set of possible grounds. The top is inclusive. */
    const evaluate = (top, grounds, opaqueFrom) => {
      const varying = [];
      for (let i = 0; i <= top; i += 1) {
        for (const side of ['below', 'above']) {
          const layers = chain[i][side];
          for (let j = 0; j < layers.length; j += 1) {
            if (i === top && side === 'below' && opaqueFrom !== undefined && j < opaqueFrom) continue;
            if (layers[j].candidates.length > 1) varying.push(i + ':' + side + ':' + j);
          }
        }
      }
      const radix = varying.map((key) => {
        const bits = key.split(':');
        return chain[Number(bits[0])][bits[1]][Number(bits[2])].candidates.length;
      });
      let total = 1;
      for (const n of radix) total *= n;
      const capped = Math.min(total, 96);
      let worst = null;
      /* The envelope of every background this row could paint. A bounded row cannot be compared
         with a probe colour for colour, but the painted pixel MUST fall inside the envelope - a
         bound that does not bound the renderer is not a bound. */
      const low = { r: 255, g: 255, b: 255 };
      const high = { r: 0, g: 0, b: 0 };
      for (let combo = 0; combo < capped; combo += 1) {
        const chosen = {};
        let rest = combo;
        for (let i = 0; i < varying.length; i += 1) {
          chosen[varying[i]] = rest % radix[i];
          rest = Math.floor(rest / radix[i]);
        }
        const pick = (key, layer) => {
          if (layer.candidates.length === 1) return layer.candidates[0];
          return layer.candidates[chosen[key] === undefined ? 0 : chosen[key]];
        };
        const group = (i, withText) => {
          let buffer = TRANSPARENT;
          const start = i === top && opaqueFrom !== undefined ? opaqueFrom : 0;
          for (let j = start; j < chain[i].below.length; j += 1) {
            const colour = pick(i + ':below:' + j, chain[i].below[j]);
            if (colour !== null) buffer = over(colour, buffer);
          }
          if (i === 0) {
            if (withText) buffer = over(ink, buffer);
          } else {
            buffer = over(fade(group(i - 1, withText), chain[i - 1].opacity), buffer);
          }
          for (let j = 0; j < chain[i].above.length; j += 1) {
            const colour = pick(i + ':above:' + j, chain[i].above[j]);
            if (colour !== null) buffer = over(colour, buffer);
          }
          return buffer;
        };
        for (const ground of grounds) {
          const background = over(fade(group(top, false), chain[top].opacity), ground);
          const foreground = over(fade(group(top, true), chain[top].opacity), ground);
          const value = contrast(foreground, background);
          if (worst === null || value < worst.value) worst = { value: value, fg: foreground, bg: background };
          for (const channel of ['r', 'g', 'b']) {
            low[channel] = Math.min(low[channel], background[channel]);
            high[channel] = Math.max(high[channel], background[channel]);
          }
        }
      }
      return { worst: worst, low: low, high: high, varying: varying.length, truncated: total > capped };
    };

    /* The nominal stack: outward to the first opaque fill, or to the page ground. */
    let grounds = [WHITE];
    let groundWhy = null;
    const top = chain.length - 1;
    if (cutAt < 0) {
      const root = parse(getComputedStyle(document.documentElement).backgroundColor);
      const body = parse(getComputedStyle(document.body).backgroundColor);
      const canvas = root !== null && root.a === 1 ? root : body !== null && body.a === 1 ? body : null;
      if (canvas === null) {
        grounds = [BLACK, WHITE];
        groundWhy = 'no opaque page ground - bounded over both extremes';
      } else {
        grounds = [canvas];
      }
    } else {
      grounds = [WHITE];
    }
    const nominal = evaluate(top, grounds, cutAt >= 0 ? chain[cutAt].opaqueFrom : undefined);

    /* The bound: the same stack cut at the first element that floats, over both extremes. */
    let bound = null;
    if (floatAt >= 0 && (cutAt < 0 || floatAt < cutAt)) {
      bound = evaluate(floatAt, [BLACK, WHITE], undefined);
    }

    const round = (c) => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) });
    const why = [];
    if (groundWhy !== null) why.push(groundWhy);
    if (nominal.varying > 0) why.push(nominal.varying + ' gradient/partial layer(s), worst taken');
    if (bound !== null) why.push('crosses ' + chain[floatAt].why + ' while translucent');
    const bounded = grounds.length > 1 || nominal.varying > 0 || bound !== null;
    const status = base.disabled ? 'exempt' : bounded ? 'bounded' : 'exact';
    counts.measured += 1;
    if (status === 'exact') counts.exact += 1;
    if (status === 'bounded') counts.bounded += 1;
    if (status === 'exempt') counts.exempt += 1;

    /* How much compositing this row actually needed: layers that are translucent, plus every
       group opacity below 1. A probe of a row with none of them proves only that an opaque
       background is its own colour, so this is what the probe list is ranked by. */
    let blend = 0;
    for (let i = 0; i <= top; i += 1) {
      if (chain[i].opacity < 1) blend += 1;
      for (const side of ['below', 'above']) {
        for (const layer of chain[i][side]) {
          if (layer.candidates.some((c) => c !== null && c.a < 1)) blend += 1;
        }
      }
    }

    const row = Object.assign(base, {
      status: status,
      ratio: Math.round(nominal.worst.value * 100) / 100,
      bound: bound === null ? null : Math.round(bound.worst.value * 100) / 100,
      fg: round(nominal.worst.fg),
      bg: round(nominal.worst.bg),
      why: why.slice(0, 3),
      depth: chain.length,
      ink: { r: Math.round(ink.r), g: Math.round(ink.g), b: Math.round(ink.b), a: ink.a },
      solidInk: chain.every((c) => c.opacity === 1) && ink.a === 1,
      blend: blend,
      low: { r: Math.floor(nominal.low.r), g: Math.floor(nominal.low.g), b: Math.floor(nominal.low.b) },
      high: { r: Math.ceil(nominal.high.r), g: Math.ceil(nominal.high.g), b: Math.ceil(nominal.high.b) },
      single: nominal.varying === 0 && grounds.length === 1,
    });
    rows.push(row);

    /* Probe any row whose nominal composite is a SINGLE colour - not only the ones with no
       floating ancestor. A glass pane over a known ancestor has exactly one predicted background
       and the probe is what decides whether that ancestor really was behind it; excluding those
       was how the first version of this pass ended up probing 44 opaque stacks and verifying
       nothing about compositing at all. */
    if (inView && el.children.length < 40) {
      const box = el.getBoundingClientRect();
      const style2 = getComputedStyle(el);
      const inset = {
        left: box.left + Number.parseFloat(style2.borderLeftWidth),
        right: box.right - Number.parseFloat(style2.borderRightWidth),
        top: box.top + Number.parseFloat(style2.borderTopWidth),
        bottom: box.bottom - Number.parseFloat(style2.borderBottomWidth),
      };
      if (inset.right - inset.left >= 16 && inset.bottom - inset.top >= 12) {
        const blocked = [];
        const all = document.createRange();
        all.selectNodeContents(el);
        const glyphs = all.getClientRects();
        for (let i = 0; i < glyphs.length; i += 1) blocked.push(glyphs[i]);
        const kids = el.querySelectorAll('*');
        for (let i = 0; i < kids.length && i < 60; i += 1) blocked.push(kids[i].getBoundingClientRect());
        const radius = (value) => Number.parseFloat(value) || 0;
        const corners = [
          { r: radius(style2.borderTopLeftRadius), cx: inset.left, cy: inset.top, left: true, top: true },
          { r: radius(style2.borderTopRightRadius), cx: inset.right, cy: inset.top, left: false, top: true },
          { r: radius(style2.borderBottomLeftRadius), cx: inset.left, cy: inset.bottom, left: true, top: false },
          { r: radius(style2.borderBottomRightRadius), cx: inset.right, cy: inset.bottom, left: false, top: false },
        ]
          .filter((c) => c.r > 0)
          .map((c) => ({
            r: c.r,
            cx: c.left ? c.cx + c.r : c.cx - c.r,
            cy: c.top ? c.cy + c.r : c.cy - c.r,
            left: c.left,
            top: c.top,
          }));
        let best = null;
        const found = [];
        const steps = 7;
        for (let yi = 0; yi <= steps; yi += 1) {
          for (let xi = 0; xi <= steps; xi += 1) {
            const x = inset.left + ((inset.right - inset.left) * xi) / steps;
            const y = inset.top + ((inset.bottom - inset.top) * yi) / steps;
            if (x < 4 || y < 4 || x > window.innerWidth - 5 || y > window.innerHeight - 5) continue;
            let clearance = Math.min(x - inset.left, inset.right - x, y - inset.top, inset.bottom - y);
            /* A rounded corner paints nothing outside its arc, so a point that clears the straight
               edges by 6px can still land on whatever is behind the box. Measured on the home
               guardrail: 8px from two edges, 10/255 away from the predicted colour, because the
               corner radius had cut the fill away underneath it. */
            for (const corner of corners) {
              if ((x < corner.cx) === corner.left && (y < corner.cy) === corner.top) {
                const dx = x - corner.cx;
                const dy = y - corner.cy;
                clearance = Math.min(clearance, corner.r - Math.sqrt(dx * dx + dy * dy));
              }
            }
            for (const r of blocked) {
              const dx = Math.max(r.left - x, x - r.right);
              const dy = Math.max(r.top - y, y - r.bottom);
              const away = dx > 0 || dy > 0 ? Math.max(dx, dy) : -1;
              if (away < clearance) clearance = away;
            }
            if (clearance >= 5) found.push({ x: Math.round(x), y: Math.round(y), clearance: clearance });
            if (best === null || clearance > best.clearance) {
              best = { x: Math.round(x), y: Math.round(y), clearance: clearance };
            }
          }
        }
        if (best !== null && best.clearance >= 5) {
          probes.push({
            sel: row.sel,
            x: best.x,
            y: best.y,
            clearance: Math.round(best.clearance),
            layers: row.depth,
            blend: row.blend,
            floated: bound !== null,
            single: row.single,
            low: row.low,
            high: row.high,
            expected: row.bg,
            alternates: found
              .filter((p) => Math.abs(p.x - best.x) > 6 || Math.abs(p.y - best.y) > 6)
              .sort((a, b) => b.clearance - a.clearance)
              .slice(0, 3)
              .map((p) => ({ x: p.x, y: p.y })),
            ink: row.ink,
            solidInk: row.solidInk,
            shadow: nearShadow(best.x, best.y),
            text: row.text,
          });
        }
      }
    }
  }

  /* Rows that needed real compositing first: a probe is only evidence about the arithmetic if
     the arithmetic did something. */
  probes.sort((a, b) => {
    if (b.blend !== a.blend) return b.blend - a.blend;
    if (b.layers !== a.layers) return b.layers - a.layers;
    return b.clearance - a.clearance;
  });
  probes.splice(PROBE_BUDGET, probes.length);
  rows.sort((a, b) => (a.ratio === undefined ? -1 : b.ratio === undefined ? 1 : a.ratio - b.ratio));
  return {
    counts: counts,
    rows: rows,
    probes: probes,
    heading: (document.querySelector('h1') || { textContent: '' }).textContent.trim().toLowerCase().slice(0, 80),
    ground: getComputedStyle(document.documentElement).getPropertyValue('--prl-surface-page').trim(),
    scroll: Math.round(window.scrollY),
    docHeight: Math.round(document.documentElement.scrollHeight),
  };
})()
`;

/* PNG decoder, about forty lines of `zlib`, so the gate has no dependency. Only what Chrome emits is
   handled (8-bit, colour type 2 or 6, not interlaced). Anything else throws. */

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let colourType = 0;
  const chunks = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colourType = data[9];
      if (data[8] !== 8) throw new Error(`PNG bit depth ${data[8]} is not 8`);
      if (colourType !== 2 && colourType !== 6) throw new Error(`PNG colour type ${colourType}`);
      if (data[12] !== 0) throw new Error('interlaced PNG');
    } else if (type === 'IDAT') chunks.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const bpp = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * bpp;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? pixels[y * stride + x - bpp] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? pixels[(y - 1) * stride + x - bpp] : 0;
      let value = line[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const dLeft = Math.abs(p - left);
        const dUp = Math.abs(p - up);
        const dUpLeft = Math.abs(p - upLeft);
        value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, bpp, pixels };
}

/** Null when the patch is not one colour, so the probe moves instead of inventing a disagreement. */
function uniformColour(image) {
  const at = (x, y) => {
    const i = y * image.width * image.bpp + x * image.bpp;
    return { r: image.pixels[i], g: image.pixels[i + 1], b: image.pixels[i + 2], a: 1 };
  };
  const first = at(0, 0);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const pixel = at(x, y);
      if (pixel.r !== first.r || pixel.g !== first.g || pixel.b !== first.b) return null;
    }
  }
  return first;
}

// CDP client copied, not shared, from ax-tree-audit.mjs so one gate cannot break another.

class Page {
  #socket;
  #nextId = 1;
  #pending = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.#pending.get(message.id);
      if (waiter === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  static async open(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolveOpen, reject) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new Page(socket);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolveSend, reject) => {
      this.#pending.set(id, { resolve: resolveSend, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? 'unknown'}`);
    }
    return result.result.value;
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    const path = url.split('?')[0];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const state = await this.evaluate(
        '(() => ({ ready: document.readyState, url: location.href }))()',
      ).catch(() => null);
      if (state !== null && state.ready === 'complete' && state.url.startsWith(path)) {
        // Half the translucency is on client-rendered panes, so wait for hydration.
        await delay(450);
        return;
      }
    }
    throw new Error(`${url} did not finish loading`);
  }

  /** Device scale 1, so a CSS pixel is an image pixel. */
  async patch(x, y) {
    const shot = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: x - 2, y: y - 2, width: 5, height: 5, scale: 1 },
    });
    return uniformColour(decodePng(Buffer.from(shot.data, 'base64')));
  }

  close() {
    this.#socket.close();
  }
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path) => typeof path === 'string' && path !== '');

function chromePath() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error(
      `no Chrome found. Set CHROME_PATH, or install one of:\n${CHROME_CANDIDATES.map((p) => `  ${p}`).join('\n')}`,
    );
  }
  return found;
}

async function withChrome(headful, run) {
  const binary = chromePath();
  // Clear of the keyboard-audit and ax-tree-audit port ranges.
  const port = 9650 + Math.floor(process.pid % 140);
  const child = spawn(
    binary,
    [
      headful ? '--no-first-run' : '--headless=new',
      `--remote-debugging-port=${port}`,
      '--user-data-dir=/tmp/prl-contrast-paint-profile',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      `--window-size=${PAINTED_VIEWPORT.width},${PAINTED_VIEWPORT.height}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const version = await waitForDevtools(child, port);
    console.log(dim(`  ${version.Browser} - ${headful ? 'headful' : 'headless'}`));

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // A device-metrics override, because a resized headless window does not reliably move media or
    // container queries. `deviceScaleFactor: 1` makes a CSS pixel a screenshot pixel.
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: PAINTED_VIEWPORT.width,
      height: PAINTED_VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    try {
      await run(page);
    } finally {
      page.close();
    }
  } finally {
    child.kill('SIGTERM');
  }
}

/**
 * `waitUntilReady` cannot tell its own child's answer from a stranger's, so an occupied port is
 * refused (a hand-started `next start` on :3521 was measured passing this gate). It connects rather
 * than binds, because on macOS a bind to 127.0.0.1 succeeds beside a wildcard listener (Node 24.18,
 * 2026-11-10). Only ECONNREFUSED counts as free.
 */
async function refuseOccupiedPort(url) {
  const { hostname, port, protocol } = new URL(url);
  const host = hostname.replace(/^\[(.*)\]$/, '$1');
  const target = { host, port: Number(port || (protocol === 'https:' ? 443 : 80)) };
  const outcome = await new Promise((done) => {
    const socket = connect(target);
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      done('accepted');
    });
    socket.once('timeout', () => {
      socket.destroy();
      done('was neither accepted nor refused within 2s');
    });
    socket.once('error', (error) =>
      done(error.code === 'ECONNREFUSED' ? 'refused' : `failed (${error.code})`),
    );
  });
  if (outcome === 'refused') return;
  const seen = outcome === 'accepted' ? 'something is already listening' : `a probe connection ${outcome}`;
  throw new Error(
    `${seen} on ${host}:${String(target.port)}. This gate starts the web app it measures, so it ` +
      'will not score one it did not. Stop it, pass another --base-url, or pass --no-start to ' +
      'measure that server on purpose.',
  );
}

/** `pnpm --filter ... start` is a wrapper, so the server is detached and signalled by process group. */
class ManagedServer {
  constructor(label, args, readyUrl, env) {
    this.label = label;
    this.args = args;
    this.readyUrl = readyUrl;
    this.env = env;
    this.child = null;
    this.output = [];
    this.exited = null;
  }

  start() {
    this.child = spawn('pnpm', this.args, {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env, ...this.env },
    });
    const keep = (chunk) => {
      this.output.push(chunk.toString());
      if (this.output.length > 200) this.output.shift();
    };
    this.child.stdout.on('data', keep);
    this.child.stderr.on('data', keep);
    this.child.on('exit', (code, signal) => {
      this.exited = signal ?? code;
    });
  }

  async waitUntilReady(timeoutSeconds) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      if (this.exited !== null) {
        throw new Error(
          `${this.label} exited (${this.exited}) before it was ready:\n${this.output.join('')}`,
        );
      }
      const answered = await fetch(this.readyUrl, { signal: AbortSignal.timeout(2000) })
        .then((response) => response.status > 0)
        .catch(() => false);
      if (answered) return;
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.label} was not ready at ${this.readyUrl} within ${timeoutSeconds}s:\n${this.output.join('')}`,
        );
      }
      await delay(300);
    }
  }

  stop() {
    if (this.child === null || this.child.pid === undefined) return;
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'ESRCH')) {
        console.log(dim(`  could not stop ${this.label}: ${err.message}`));
      }
    }
  }
}

const walkerSource = (measureAll, probeBudget) =>
  PAINT_WALKER.replace('MEASURE_ALL_ARGUMENT', String(measureAll)).replace(
    'PROBE_BUDGET_ARGUMENT',
    String(probeBudget),
  );

/** Returns failures. Never throws for content. */
async function measurePage(page, url, label, theme, failures, tally) {
  await page.goto(url);
  // Set on the root after load, which exercises the explicit `[data-theme]` scope the toggle uses.
  // The media-query scope is checked against it for drift in passes 1 and 2.
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await delay(250);
  // Two rendered frames. Under reduced motion base.css makes theme colours 1ms transitions, which
  // report the old value until a frame starts them. Without this, CI's `/legends` dark sweep walked
  // light-theme text (340 findings, 0/4 probes agreed).
  await page.evaluate(
    'new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))',
  );

  const result = await page.evaluate(walkerSource(true, PROBE_CANDIDATES));
  const fail = (line) => failures.push({ group: 'painted', line: `${label}  ${line}` });

  if (ERROR_BOUNDARY_HEADINGS.some((heading) => result.heading.startsWith(heading))) {
    fail(`rendered an error boundary ("${result.heading}") - nothing here was measured`);
    return;
  }
  if (result.counts.measured < MIN_ROWS_PER_PAGE) {
    fail(`only ${result.counts.measured} text element(s) measured - a sweep of nothing is not a pass`);
  }
  tally.rows += result.counts.measured;
  tally.exact += result.counts.exact;
  tally.bounded += result.counts.bounded;
  tally.exempt += result.counts.exempt;
  tally.srOnly += result.counts.srOnly;
  tally.grounds.set(`${label}`, result.ground);

  const asserted = result.rows.filter((row) => row.status !== 'exempt');
  const worstOf = (row) =>
    row.bound === null || row.bound === undefined ? row.ratio : Math.min(row.ratio, row.bound);
  let worst = null;
  for (const row of asserted) {
    if (row.status === 'unmeasured') {
      tally.unmeasured += 1;
      fail(`UNMEASURED  ${row.sel}  "${row.text}"  ${row.why.join('; ')}`);
      continue;
    }
    const value = worstOf(row);
    if (worst === null || value < worst) worst = value;
    if (value < AA_TEXT) {
      const bound = row.bound === null || row.bound === undefined ? '' : `  (bound ${row.bound.toFixed(2)})`;
      fail(
        `${value.toFixed(2)}:1 needs ${AA_TEXT}:1  ${row.sel}  "${row.text}"  ` +
          `${row.px}px/${row.weight}  ${toHex(row.fg)} on ${toHex(row.bg)}${bound}` +
          (row.why.length > 0 ? `  [${row.why.join('; ')}]` : ''),
      );
    }
  }

  // A point whose patch is not one colour moves. One that never comes clear is one fewer probe.
  let taken = 0;
  let discarded = 0;
  let matched = 0;
  let bracketed = 0;
  for (const probe of result.probes) {
    if (taken >= PROBES_PER_PAGE) break;
    let painted = null;
    for (const point of [{ x: probe.x, y: probe.y }, ...probe.alternates]) {
      painted = await page.patch(point.x, point.y);
      if (painted !== null) break;
      discarded += 1;
    }
    if (painted === null) continue;
    taken += 1;
    tally.probes += 1;
    const delta = Math.max(
      Math.abs(painted.r - probe.expected.r),
      Math.abs(painted.g - probe.expected.g),
      Math.abs(painted.b - probe.expected.b),
    );
    if (probe.blend > 0) tally.blended += 1;
    const inEnvelope =
      painted.r >= probe.low.r - PROBE_TOLERANCE &&
      painted.r <= probe.high.r + PROBE_TOLERANCE &&
      painted.g >= probe.low.g - PROBE_TOLERANCE &&
      painted.g <= probe.high.g + PROBE_TOLERANCE &&
      painted.b >= probe.low.b - PROBE_TOLERANCE &&
      painted.b <= probe.high.b + PROBE_TOLERANCE;
    // Only a narrow envelope counts as a check. Wide ones are covered by the both-extremes bound.
    const tight =
      probe.high.r - probe.low.r < 48 && probe.high.g - probe.low.g < 48 && probe.high.b - probe.low.b < 48;

    if (!probe.single && !probe.shadow && tight && !inEnvelope) {
      // The painted pixel is outside the bound, so every bounded ratio is unproven.
      fail(
        `THE BOUND DOES NOT BOUND THE RENDERER at ${probe.x},${probe.y}: predicted ` +
          `${toHex(probe.low)}..${toHex(probe.high)}, Chrome painted ${toHex(painted)}  ${probe.sel}`,
      );
    }
    if (!probe.single) {
      if (tight) {
        tally.bracketed += 1;
        bracketed += 1;
      }
    } else if (delta <= PROBE_TOLERANCE) {
      matched += 1;
      tally.matched += 1;
    } else if (probe.shadow) {
      // A neighbouring pane's shadow can land here. The painted pixel is asserted below.
      tally.shadowed += 1;
    } else if (probe.floated) {
      // A guess about what is behind a floating pane was wrong. The bound and the pixel are asserted.
      tally.floated += 1;
    } else {
      // Nothing floats or casts a shadow, and the composite was one colour, so the model is wrong.
      fail(
        `MODEL DISAGREES WITH THE RENDERER at ${probe.x},${probe.y}: predicted ${toHex(probe.expected)}, ` +
          `Chrome painted ${toHex(painted)} (${delta}/255)  ${probe.sel}`,
      );
    }
    // The painted pixel is the reader's real background, so it is asserted in its own right.
    if (probe.solidInk) {
      const ratio = contrastRatio(composite(probe.ink, painted), painted);
      if (ratio < AA_TEXT) {
        fail(
          `${ratio.toFixed(2)}:1 needs ${AA_TEXT}:1 ON REAL PIXELS  ${probe.sel}  "${probe.text}"  ` +
            `${toHex(probe.ink)} on painted ${toHex(painted)}`,
        );
      }
    }
  }

  const counts = result.counts;
  console.log(
    `  ${label.padEnd(46)}${String(counts.measured).padStart(5)} text  ` +
      `${String(counts.exact).padStart(4)} exact ${String(counts.bounded).padStart(4)} bounded ` +
      `${String(counts.exempt).padStart(2)} exempt ${String(counts.srOnly).padStart(4)} unpainted  ` +
      `worst ${worst === null ? '-' : worst.toFixed(2)}  ${matched + bracketed}/${taken} probes agreed` +
      (discarded > 0 ? dim(` (${discarded} point(s) moved)`) : ''),
  );
}

async function runPaintedPass(options) {
  console.log('');
  console.log(bold('PASS 3 - THE PAINTED LAYER'));
  console.log(dim('  What a reader actually sees: every ancestor composited, in real Chrome, per route.'));
  console.log(dim('  A failure here is a defect no token pair can express - see section 5.'));

  const failures = [];
  const tally = {
    pages: 0,
    rows: 0,
    exact: 0,
    bounded: 0,
    exempt: 0,
    srOnly: 0,
    unmeasured: 0,
    probes: 0,
    matched: 0,
    blended: 0,
    bracketed: 0,
    shadowed: 0,
    floated: 0,
    grounds: new Map(),
  };
  const servers = [];

  try {
    if (options.start) {
      await refuseOccupiedPort(options.baseUrl);
      const web = new ManagedServer('web', ['--filter', '@prl/web', 'start'], options.baseUrl, {
        NODE_ENV: 'production',
        PORT: new URL(options.baseUrl).port,
      });
      servers.push(web);
      console.log(dim(`  starting the built web app on ${options.baseUrl} ...`));
      web.start();
      await web.waitUntilReady(options.readyTimeoutSeconds);
    } else {
      console.log(dim(`  measuring the server already running at ${options.baseUrl}`));
    }

    await withChrome(options.headful, async (page) => {
      for (const condition of PAINTED_CONDITIONS) {
        // Motion off for every condition. With it on, `/` reported the home guardrail 10/255 light
        // because the panel had not landed.
        await page.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, ...condition.media],
        });
        const routes = options.routes === null ? condition.routes : options.routes;
        for (const theme of ['dark', 'light']) {
          for (const route of routes) {
            const label = `${condition.id}/${theme}  ${route}`;
            tally.pages += 1;
            await measurePage(page, `${options.baseUrl}${route}`, label, theme, failures, tally);
          }
        }
      }
    });
  } catch (err) {
    // A gate that cannot reach the app fails.
    failures.push({ group: 'painted', line: `the painted layer could not be measured: ${err.message}` });
  } finally {
    for (const server of servers) server.stop();
  }

  console.log('');
  console.log(
    `  ${tally.pages} page(s), ${tally.rows} text element(s) composited, ` +
      `${tally.exact} exact, ${tally.bounded} bounded, ${tally.exempt} exempt (disabled), ` +
      `${tally.srOnly} not painted`,
  );
  console.log(
    `  ${tally.probes} probe(s) against real screenshot pixels: ${tally.matched} matched the composite exactly, ` +
      `${tally.bracketed} landed inside a bounded row's envelope, ` +
      `${tally.blended} of them over a stack this pass had to composite` +
      (tally.shadowed > 0 ? `, ${tally.shadowed} differed where a box-shadow can reach` : '') +
      (tally.floated > 0
        ? `, ${tally.floated} differed under a floating pane (the painted pixel was asserted)`
        : ''),
  );

  // A check that read nothing fails.
  if (tally.rows === 0) {
    failures.push({ group: 'painted', line: 'no text was composited at all - the sweep found nothing' });
  }
  // Capped by page count, so a one-route `--routes` run still has to prove the model.
  const probesNeeded = Math.min(MIN_PROBES, 2 * tally.pages);
  if (tally.probes < probesNeeded) {
    failures.push({
      group: 'painted',
      line: `only ${tally.probes} probe(s) of the model against real pixels (need ${probesNeeded}) - the arithmetic in this pass is unverified against the renderer`,
    });
  }
  const grounds = new Set(
    [...tally.grounds.entries()].filter(([label]) => label.startsWith('default/')).map(([, value]) => value),
  );
  if (tally.pages > 1 && grounds.size < 2) {
    failures.push({
      group: 'painted',
      line: `every page resolved --prl-surface-page to the same value (${[...grounds].join(', ')}) - the theme never changed, so one of the two themes was measured twice`,
    });
  }

  if (failures.length === 0) {
    console.log(`  ${green('every composited background clears the floor, in both themes')}`);
  }
  return failures;
}

const PAINTED_USAGE = `Usage: node scripts/check-contrast.mjs [options]

  --base-url <url>   measure this origin           (default http://127.0.0.1:3462)
  --no-start         do not start the web app; something is already serving --base-url
  --routes a,b       sweep these routes instead of the whole app. A narrowed sweep still has
                     to prove the model against real pixels, it just needs fewer probes
  --headful          watch it happen

Passes 1 and 2 read the stylesheets and need nothing. PASS 3 needs the web app BUILT
(\`pnpm run build\`) and a Chrome (\`CHROME_PATH\`); without either it fails rather than skipping.`;

function parsePaintedOptions(argv) {
  const options = {
    // 3462 is free. 3000/3001 app and API, 3456/3465/3467 test:ax, 3457 test:csp, 3458/3459 age gate,
    // 3463 test:layout, 3464 test:keyboard.
    baseUrl: process.env.PRL_CONTRAST_ORIGIN ?? 'http://127.0.0.1:3462',
    start: true,
    headful: false,
    routes: null,
    readyTimeoutSeconds: 120,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-start') options.start = false;
    else if (arg === '--headful') options.headful = true;
    else if (arg === '--base-url') options.baseUrl = argv[++i];
    else if (arg === '--routes') options.routes = argv[++i].split(',').filter(Boolean);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  if (options.routes !== null && options.routes.length === 0) {
    throw new Error('--routes was given no routes');
  }
  return options;
}

let paintedOptions;
try {
  paintedOptions = parsePaintedOptions(process.argv.slice(2));
} catch (err) {
  console.error(red(`check-contrast - ${err.message}`));
  console.error(PAINTED_USAGE);
  process.exit(1);
}
if (paintedOptions.help === true) {
  console.log(PAINTED_USAGE);
  process.exit(0);
}

console.log(bold('Poker Risk Lab - contrast gate'));
console.log(dim('WCAG 2.x relative luminance, computed from the stylesheets. No dependencies.'));

const tokenFailures = runPass(
  'PASS 1 - THE TOKEN LAYER',
  [TOKENS],
  'What the design system claims. A failure here is a defect in the token set.',
);

const renderedFailures = runPass(
  'PASS 2 - THE RENDERED LAYER',
  [TOKENS, BASE],
  'What a browser paints, including the derived pairings and repairs in base.css.',
);

/** Pass 3 runs even when the token passes failed. The two have different repairs. */
const paintedFailures = await runPaintedPass(paintedOptions);

console.log('');
console.log(bold('SUMMARY'));

const describe = (f) => {
  if (f.line !== undefined) return f.line;
  if (f.group === 'theme-drift') return `${f.theme ?? 'light'}  ${f.fg}  ${f.bg}`;
  const ratio = f.ratio.toFixed(2);
  return `${f.theme}  ${shortName(f.fg)} on ${shortName(f.bg)}  ${ratio}:1  (needs ${f.min}:1)`;
};

const report = (label, failures) => {
  if (failures.length === 0) {
    console.log(`  ${green('PASS')}  ${label}`);
    return;
  }
  console.log(`  ${red('FAIL')}  ${label}  ${failures.length} finding(s)`);
  for (const failure of failures) console.log(`          ${describe(failure)}`);
};

report('token layer  (tokens.css)', tokenFailures);
report('rendered layer  (tokens.css + base.css)', renderedFailures);
report('painted layer  (real Chrome, every ancestor composited)', paintedFailures);

if (tokenFailures.length > 0 && renderedFailures.length === 0) {
  console.log('');
  console.log(yellow('  The rendered UI is AA in both themes; the failures above are in the token'));
  console.log(yellow('  layer alone, and base.css section 0 repairs each one. Fold those repairs'));
  console.log(yellow('  into the light theme of tokens.css and both passes go green together.'));
}

const total = tokenFailures.length + renderedFailures.length + paintedFailures.length;
if (total > 0) {
  console.log('');
  console.log(red(`  ${total} failing finding(s). Contrast is a functional requirement, not a preference.`));
  process.exit(1);
}

console.log('');
console.log(green('  Every claimed ratio holds, in both themes, in all three passes - and the third one'));
console.log(green('  measured the composited background of every piece of text the app paints.'));
process.exit(0);
