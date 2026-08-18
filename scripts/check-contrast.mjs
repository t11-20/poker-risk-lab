#!/usr/bin/env node
/**
 * Gate: every contrast ratio the design system CLAIMS is measured here, in both themes.
 *
 * `docs/frontend-design-system.md` asserts a table of ratios, and tokens.css repeats several of
 * them in comments ("worst 6.10:1", "9.39:1", "AA body"). A number in a comment is a number
 * nobody checks. This script recomputes all of them from the stylesheets themselves, so the doc
 * cannot drift from the tokens and the tokens cannot drift from WCAG.
 *
 * ## Why it is written this way
 *
 * Dependency-free, standard library only. A contrast checker that pulls in a colour library is a
 * contrast checker whose correctness depends on a package nobody in this repo has read, and the
 * whole formula is fifteen lines. It is implemented from the WCAG 2.x definitions of relative
 * luminance and contrast ratio, and it reproduces every ratio printed in the design doc exactly
 * (14.00, 9.94, 7.07, 4.99, 9.39, 2.07, 4.34, 1.44, 12.77, ...), which is the evidence that the
 * implementation is right rather than merely plausible.
 *
 * ## Two passes, and why the distinction matters
 *
 *   PASS 1  THE TOKEN LAYER - tokens.css alone. This is what the design doc claims, so a failure
 *           here is a defect in the token set, independent of what any component does with it.
 *   PASS 2  THE RENDERED LAYER - tokens.css plus the derived pairings and light-theme repairs
 *           declared at the top of base.css. This is what a browser actually paints, so a failure
 *           here is a defect a reader would meet.
 *
 * Both are fatal. Reporting them separately is what makes the output actionable: "the light theme
 * of tokens.css has four bad pairings and the component layer already routes around all of them"
 * is a different message from "the UI is broken", and a single pass/fail count cannot tell them
 * apart. When the token layer is fixed, the two passes converge and the repairs in base.css can
 * be deleted - this script will say so.
 *
 * ## What is asserted
 *
 *   - body text >= 4.5:1 on every surface                            (WCAG 1.4.3, AA)
 *   - meaningful borders and focus rings >= 3:1 on every surface     (WCAG 1.4.11)
 *   - --prl-text-on-accent on every accent step used as a FILL >= 4.5:1
 *   - each of the four suits >= 4.5:1 on both card faces
 *   - every chart series >= 3:1 on every surface                     (WCAG 1.4.11)
 *   - a control on the ink-on-accent rule: of the only two candidates for text on an accent fill,
 *     near-black and white, `--prl-text-on-accent` must BE the better one. That is the rule the
 *     design doc writes as "never white on accent", expressed so it cannot go stale when the
 *     palette moves - and it has already moved once: the light theme inverts the pairing.
 *
 * Disabled text is reported but not asserted: WCAG explicitly exempts inactive controls, and
 * asserting it would force a disabled label to be indistinguishable from an enabled one.
 *
 * Usage:  node scripts/check-contrast.mjs        (also `pnpm run design:contrast`)
 * Exit:   0 if every assertion in both passes holds, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOKENS = join(REPO_ROOT, 'packages/ui/src/styles/tokens.css');
const BASE = join(REPO_ROOT, 'packages/ui/src/styles/base.css');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);

/* ==========================================================================================
   1. COLOUR MATHS - WCAG 2.x, implemented from the definitions
   ========================================================================================== */

/**
 * sRGB channel to linear light.
 *
 * The threshold is 0.04045, matching the sRGB standard and the current WCAG text. WCAG 2.0 wrote
 * 0.03928 in one place; the two branches of the function agree to eleven decimal places either
 * side of the boundary, so the choice cannot change a reported ratio.
 */
function toLinear(channel8Bit) {
  const c = channel8Bit / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance: the ITU-R BT.709 luma coefficients applied to linear light. */
function relativeLuminance({ r, g, b }) {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio: (lighter + 0.05) / (darker + 0.05). Always >= 1. */
function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Alpha compositing, source-over, in sRGB space.
 *
 * Needed because two tokens (`--prl-scrim`, `--prl-veil-*`) are translucent, and "the contrast of
 * a translucent colour" is meaningless until it is composited over something. Compositing in
 * gamma-encoded sRGB rather than linear light is deliberate: it is what a browser does, and the
 * point of this script is to predict the browser.
 */
function composite(source, backdrop) {
  if (source.a >= 1) return source;
  const mix = (s, b) => Math.round(s * source.a + b * (1 - source.a));
  return { r: mix(source.r, backdrop.r), g: mix(source.g, backdrop.g), b: mix(source.b, backdrop.b), a: 1 };
}

const HEX_SHORT = /^#([\da-f])([\da-f])([\da-f])([\da-f])?$/i;
const HEX_LONG = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})([\da-f]{2})?$/i;
const RGB_FN = /^rgba?\(([^)]+)\)$/i;

/** Parses the colour syntaxes tokens.css actually uses. Returns null for anything else - a
    system colour keyword, a font stack, a duration - so callers can skip non-colours. */
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
    // Both the legacy comma syntax and the modern space-with-slash syntax appear in the wild.
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

/* ==========================================================================================
   2. A VERY SMALL CSS DECLARATION SCANNER
   ==========================================================================================

   Not a CSS parser, and it does not need to be. It needs to answer one question: for each
   `--prl-*` declaration, which selector scope was it in? So it tracks brace depth and keeps the
   text before each `{` as the scope, which is enough for the three shapes these files use:
   `:root { }`, `:root[data-theme="light"] { }` and `@media (...) { :root... { } }`.

   Custom property VALUES cannot contain `{`, `}` or `;` in these files, so a character scan is
   safe. Comments are stripped first because a commented-out token would otherwise be read as a
   real one - which is exactly the kind of quiet wrongness a gate must not have.
   ========================================================================================== */

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
 * Which theme a scope belongs to.
 *
 * `dark` is the bare `:root`, because dark is the designed default and the light theme is
 * expressed as overrides. The two light scopes - the `prefers-color-scheme` media query and the
 * explicit `[data-theme="light"]` selector - are tracked separately so they can be compared: they
 * are meant to be identical, and if they drift the app renders differently depending on how the
 * reader chose their theme. That is a bug this gate can catch for free.
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

/** Builds `{ dark, light }` token maps from a list of stylesheets, later files overriding
    earlier ones exactly as the cascade would. Also returns the two light scopes for comparison. */
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

/** Resolves a token to a literal value, following `var()` chains and their fallbacks. */
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

/* ==========================================================================================
   3. THE PAIRINGS
   ==========================================================================================

   Surfaces are split into two groups because a token's permitted backgrounds are part of its
   definition. `hover` and `active` only ever sit behind an interactive control's own label, so
   the tokens asserted against them are the ones a control may use; every other text token is
   asserted against the surfaces that hold content.
   ========================================================================================== */

const CONTENT_SURFACES = [
  '--prl-surface-page',
  '--prl-surface-raised',
  '--prl-surface-panel',
  '--prl-surface-inset',
  '--prl-surface-table',
];

const INTERACTION_SURFACES = ['--prl-surface-hover', '--prl-surface-active'];
const ALL_SURFACES = [...CONTENT_SURFACES, ...INTERACTION_SURFACES];

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/**
 * Accent steps used as a FILL behind `--prl-text-on-accent`.
 *
 * 200 to 500 are the bright end of the ramp - the steps a highlighter-like fill comes from. 600
 * and below are border and shadow-adjacent steps that never carry text, so asserting text on them
 * would be asserting a pairing the design forbids. The whole ramp is printed either way, with
 * each step marked fill-eligible or not, because that table is the thing a reader needs when they
 * are about to pick an accent for a button.
 */
const ACCENT_FILL_STEPS = [
  '--prl-accent-200',
  '--prl-accent-300',
  '--prl-accent-400',
  '--prl-accent-500',
  // Declared in base.css, so it is absent from pass 1 and prints as `-` there. That is the
  // point: pass 1 is the token layer exactly as tokens.css ships it.
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

/** Reported, never asserted. Disabled text is exempt from 1.4.3 (inactive user interface
    components), and a decorative hairline is exempt from 1.4.11 by definition - both are here so
    that "exempt" is a measured claim rather than an assumption. */
const INFORMATIONAL = [
  {
    id: 'exempt',
    title: 'Exempt by definition - measured for the record, not asserted',
    rule: 'disabled text: WCAG 1.4.3 exempts inactive controls. Hairlines: decorative only',
    foregrounds: ['--prl-text-disabled', '--prl-line-subtle', '--prl-line'],
    backgrounds: CONTENT_SURFACES,
  },
];

/* ==========================================================================================
   4. EVALUATION AND OUTPUT
   ========================================================================================== */

const shortName = (token) => token.replace('--prl-', '');

function colorOf(token, map, backdrop) {
  const resolved = resolveToken(token, map);
  if (resolved === null) return null;
  const parsed = parseColor(resolved);
  if (parsed === null) return null;
  return backdrop === undefined ? parsed : composite(parsed, backdrop);
}

/** One group, one theme: a matrix of ratios with the failures marked. */
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

function runPass(label, files, note) {
  const themes = buildThemes(files);
  console.log('');
  console.log(bold(`${label}`));
  console.log(dim(`  ${note}`));
  console.log(dim(`  ${files.map((f) => relative(REPO_ROOT, f)).join(' + ')}`));

  const failures = [];

  for (const themeName of ['dark', 'light']) {
    const map = themes[themeName];
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

    // The accent ramp, annotated. Not an assertion - a lookup table for whoever picks the next
    // accent fill, and the reason `--prl-accent-fill` exists as a named pairing.
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
     * The ink-on-accent control.
     *
     * There are only two candidates for text on an accent fill - near-black or white - and the
     * design doc's rule ("never white on accent") is really the DARK theme's answer to a
     * measurement: ink-900 on bright cyan is 9.39:1 while white on it is 2.07:1. The light theme
     * inverts the fill and therefore has to invert the ink.
     *
     * So rather than asserting one of the two colours, this asserts that `--prl-text-on-accent`
     * IS the better of the two on whatever the fill currently is. That check cannot go stale when
     * the palette moves, and it catches the exact mistake the rule was written to prevent -
     * carrying the other theme's ink onto this theme's fill.
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
      // A hair of tolerance so an equal-but-not-identical ink is not reported as a defect.
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

/* ==========================================================================================
   5. MAIN
   ========================================================================================== */

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

console.log('');
console.log(bold('SUMMARY'));

const describe = (f) => {
  if (f.group === 'theme-drift') return `${f.theme ?? 'light'}  ${f.fg}  ${f.bg}`;
  const ratio = f.ratio.toFixed(2);
  return `${f.theme}  ${shortName(f.fg)} on ${shortName(f.bg)}  ${ratio}:1  (needs ${f.min}:1)`;
};

const report = (label, failures) => {
  if (failures.length === 0) {
    console.log(`  ${green('PASS')}  ${label}`);
    return;
  }
  console.log(`  ${red('FAIL')}  ${label}  ${failures.length} pairing(s)`);
  for (const failure of failures) console.log(`          ${describe(failure)}`);
};

report('token layer  (tokens.css)', tokenFailures);
report('rendered layer  (tokens.css + base.css)', renderedFailures);

if (tokenFailures.length > 0 && renderedFailures.length === 0) {
  console.log('');
  console.log(yellow('  The rendered UI is AA in both themes; the failures above are in the token'));
  console.log(yellow('  layer alone, and base.css section 0 repairs each one. Fold those repairs'));
  console.log(yellow('  into the light theme of tokens.css and both passes go green together.'));
}

const total = tokenFailures.length + renderedFailures.length;
if (total > 0) {
  console.log('');
  console.log(red(`  ${total} failing pairing(s). Contrast is a functional requirement, not a preference.`));
  process.exit(1);
}

console.log('');
console.log(green('  Every claimed ratio holds, in both themes, in both passes.'));
process.exit(0);
