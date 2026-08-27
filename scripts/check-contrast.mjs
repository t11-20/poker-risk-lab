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
 *   - GLASS: every translucent material tint, composited over BOTH bounding backdrops (black and
 *     white), asserted on the WORSE of the two. See section 3b - this is the part that most
 *     design systems stop measuring the moment they adopt translucency, because a translucent
 *     surface has no contrast ratio until something bounds what can be behind it.
 *   - THE TWO-TONE FOCUS INDICATOR, solved in closed form over every backdrop luminance in
 *     [0, 1] rather than sampled. A single-colour ring on a floating pane is only as visible as
 *     its contrast with a backdrop the design does not own; `accent-300` measures 1.52:1 against
 *     white. The assertion is that the ring's and the halo's failure intervals do not intersect.
 *   - the page wash, as a derived surface: the brightest stop of `--prl-page-wash` composited
 *     over the page ground, then measured like any other content surface.
 *
 * Disabled text is reported but not asserted: WCAG explicitly exempts inactive controls, and
 * asserting it would force a disabled label to be indistinguishable from an enabled one.
 *
 * Usage:  node scripts/check-contrast.mjs        (also `pnpm run design:contrast`)
 * Exit:   0 if every assertion in both passes holds, 1 otherwise.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

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
  // Derived, not declared: the page ground with the brightest stop of `--prl-page-wash`
  // composited onto it. See DERIVED SURFACES below - the wash is a gradient, so the only
  // honest way to assert it is to measure its worst stop as if it covered the whole page.
  '--prl-surface-wash',
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
   3b. GLASS - THE PART THAT CANNOT BE EXPRESSED AS A PAIRING
   ==========================================================================================

   A translucent surface has no contrast ratio. It has a RANGE of them, one per backdrop, and
   the range is unbounded until something bounds it. That is the whole difficulty with glass,
   and the reason most design systems that adopt it quietly stop measuring.

   It is bounded here by construction rather than by convention: no display paints outside
   [#000000, #ffffff], so every glass tint is composited over BOTH extremes and the WORSE of
   the two results is the ratio this system claims. A pairing that holds at both holds over a
   playing-card face, an accent fill, a chart, a photograph, and over whatever is added next
   year - without anyone having to remember a rule about where glass may float.

   The two extremes are read from the stylesheet (`--prl-glass-backdrop-min` / `-max`) rather
   than hard-coded here, so the claim lives with the tokens.

   Which extreme binds FLIPS with the theme, which is the detail that makes this worth
   automating: dark theme paints light text on a dark tint, so its enemy is a bright backdrop
   lifting the composite; light theme paints dark text on a light tint, so its enemy is a dark
   backdrop pulling it down. Measuring one extreme would pass one theme and miss the other.
   ========================================================================================== */

const GLASS_LEVELS = [
  { tint: '--prl-glass-floating', title: 'L3 floating  - pills, toolbars, chips, action bar' },
  { tint: '--prl-glass-floating-hover', title: 'L3 floating, hovered' },
  { tint: '--prl-glass-floating-active', title: 'L3 floating, pressed' },
  { tint: '--prl-glass-overlay', title: 'L4 overlay   - popovers, menus, sheets' },
  { tint: '--prl-glass-overlay-hover', title: 'L4 overlay, hovered' },
];

/**
 * Every text token a component may put on glass - which is the WHOLE content ramp, including
 * `--prl-text-faint`.
 *
 * That was not the plan. `faint` was excluded on the reasoning that it is the dimmest step and
 * has no headroom for a backdrop it does not control, and at the first tint values it did fail:
 * 4.00:1 over the bright extreme. The tints then had to get more opaque for an unrelated reason
 * (`--prl-line-strong` on a hovered pane), and the negative control below reported that the
 * exclusion had stopped being true. It is asserted now instead of documented, which is the
 * stronger of the two: at 4.55:1 worst it has the least room of anything here, so it is the row
 * that will notice first if a tint is ever made more transparent.
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

/** Meaningful borders and the ring, at the 1.4.11 threshold. */
const GLASS_NON_TEXT = ['--prl-line-strong', '--prl-accent-edge', '--prl-focus-color'];

/**
 * Measured, and expected to FAIL. The negative control for everything above.
 *
 * A permitted set nobody has watched exclude anything is a permitted set nobody can justify -
 * and this list has already earned its keep once: it held `--prl-text-faint`, reported that the
 * exclusion had stopped being true after the tints were made more opaque, and that token is now
 * asserted in GLASS_TEXT instead. An exclusion that quietly becomes vacuous is exactly the shape
 * of check that reads green over nothing.
 *
 * What is here now cannot become vacuous by accident, because both tokens are decorative BY
 * DEFINITION (tokens.css rule B): they draw an object's edge and never its meaning. If either
 * ever cleared 3:1 on glass it would still not be allowed to carry meaning - the gate would be
 * reporting that the palette had moved, not that the rule had.
 *
 * If a row here starts clearing its floor the gate says so and does not fail. A tint that got
 * more opaque is a legitimate change; the response is to read the note, not to fight the gate.
 */
const GLASS_EXCLUDED = [
  { tint: '--prl-line', floor: AA_NON_TEXT },
  { tint: '--prl-line-subtle', floor: AA_NON_TEXT },
];

/** The composite of a translucent tint over one bounding backdrop. */
function glassOver(tintToken, backdropToken, map) {
  const backdrop = colorOf(backdropToken, map);
  const tint = colorOf(tintToken, map);
  if (backdrop === null || tint === null) return null;
  return composite(tint, backdrop);
}

/**
 * The two-tone focus ring, proved rather than eyeballed.
 *
 * A single-colour indicator is only as visible as its contrast with the backdrop, and on a
 * floating pane the backdrop is not ours. So the ring is `--prl-focus-color` with a 1px
 * `--prl-focus-halo` of the opposite polarity outside it, and the claim is that NO backdrop
 * defeats both.
 *
 * That claim is checkable in closed form. A foreground of relative luminance `Lf` clears 3:1
 * against a backdrop of luminance `Lb` when `Lb <= (Lf + 0.05) / 3 - 0.05` (backdrop darker)
 * or `Lb >= 3 * (Lf + 0.05) - 0.05` (backdrop lighter) - so each colour covers `[0, lo]` and
 * `[hi, 1]` and fails only strictly inside `(lo, hi)`. The indicator works everywhere exactly
 * when the two open failure intervals do not intersect inside [0, 1].
 */
function ringCoverage(color) {
  const l = relativeLuminance(color);
  return { lo: (l + 0.05) / AA_NON_TEXT - 0.05, hi: AA_NON_TEXT * (l + 0.05) - 0.05 };
}

/* ==========================================================================================
   4. EVALUATION AND OUTPUT
   ========================================================================================== */

const shortName = (token) => token.replace('--prl-', '');

const toHex = ({ r, g, b }) => `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/**
 * DERIVED SURFACES - opaque colours a browser paints that no token declares.
 *
 * `--prl-page-wash` is two radial gradients, and a gradient has no single colour to assert.
 * What CAN be asserted is its worst case: the brightest stop either gradient reaches, treated
 * as if it covered the whole page. `--prl-wash-tint` is that stop, declared as a token for
 * this purpose, and the composite is injected here under a surface name so that every text
 * pairing in every group is measured against the wash as well as against the flat ground.
 *
 * Injected into the resolved theme maps only, never into the two light SCOPES - those are
 * compared against each other for drift, and a derived value in one of them would read as a
 * declaration the other is missing.
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

/**
 * Every glass level, every permitted foreground, both bounding backdrops.
 *
 * Prints `min` (the tint over black), `max` (the tint over white) and `worst`, and asserts on
 * `worst`. Reporting all three rather than only the verdict is what makes the output usable
 * when a level is close: it says which direction the tint has to move.
 */
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
        // The negative control. Expected to fail; reported either way, never asserted.
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

/**
 * The two-tone focus indicator, proved over the whole backdrop range.
 *
 * See `ringCoverage`. Each colour fails only strictly inside its own `(lo, hi)` interval, so
 * the indicator is defeated exactly where the two intervals overlap inside [0, 1]. The
 * assertion is that the overlap is empty - not that it is small.
 */
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

/* ==========================================================================================
   5. PASS 3 - THE PAINTED LAYER: COMPOSITED BACKGROUNDS, MEASURED IN REAL CHROME
   ==========================================================================================

   Passes 1 and 2 read token PAIRS. A pair is a claim about two colours; a reader meets a STACK.

   The defect that produced this section, in full, because it is the whole argument. An agent
   proposed fading folded seats on the poker table with `opacity`, measured the result by hand,
   and declined the change on its own arithmetic rather than on this gate's verdict:

       opacity 1.0    5.95:1     what ships
       opacity 0.9    4.09:1     FAIL
       opacity 0.8    3.10:1     FAIL

   Every ratio in that table was invisible to passes 1 and 2, because `opacity` on a container is
   neither a token nor a pairing: it composites the label AND the plate under it with the felt
   behind them, while the two tokens named in the pairing do not change at all. The change would
   have gone in green. That is a gate manufacturing confidence about the property it does not
   measure - and this app has just been through a redesign that put translucency everywhere, so
   the blind spot was not one seat. It was every glass material, every veil, every tinted surface
   over another tinted surface, and every `opacity` in the tree.

   ## What this pass does instead

   It asks the browser. For every element carrying text, on every route, in both themes:

     1. walk the ancestor chain outward from the text element, collecting every painted layer -
        each element's own `background-color` and `background-image`, and each POSITIONED
        `::before` / `::after` whose box actually covers the text. That last one is not an edge
        case here: the plate under every seat at the table is an `::after`, so a walk that ignored
        pseudo-elements would measure the wrong background on the densest screen in the app;
     2. composite them the way a browser does - source-over in sRGB - as NESTED GROUPS, so an
        `opacity` anywhere in the chain fades everything inside it against everything outside it,
        which is exactly the arithmetic the table above records;
     3. paint the glyph twice: once with the text colour, once without. The first is the pixel a
        reader's eye lands on, the second is the pixel beside it, and the ratio between them is
        the contrast. Computed this way it needs no special case for a translucent text colour,
        for an `opacity`, or for a scrim over both - they all fall out of the same two paints.

   ## Where the walk stops, and what it says when it cannot finish

   A walk outward stops at the first OPAQUE layer: nothing under an opaque fill can be seen, so
   the composite from there inward is exact. Three things stop it earlier, and each gets a verdict
   rather than a silent skip:

     BOUNDED    the stack is still translucent when it crosses an element that FLOATS - absolute,
                fixed or sticky, or carrying a `backdrop-filter`. What is behind a floating pane
                is not its ancestors, it is whatever the page happened to put there, and no walk
                of the DOM can know it. So the construction section 3b uses for glass applies
                here: composite over BOTH bounding backdrops, black and white, and assert the
                worse of the two. That bound also absorbs `backdrop-filter`, because a blur and a
                saturate cannot produce a colour outside the range they are given.
                A gradient is bounded on its own stop path. Compositing a premultiplied gradient
                over a uniform backdrop is the linear interpolation of the composited stops, so
                sampling the stops and the points between them brackets every pixel it can paint.
     UNMEASURED a layer this walk cannot turn into a colour at all: a `url()` image, a
                `background-clip: text` fill, a `mix-blend-mode`, a `filter`. NOT skipped -
                reported by element, counted, and FATAL. An unmeasurable background under real
                text is the exact shape of the blind spot this pass exists to remove, and
                inheriting it quietly would be inheriting it.
     EXEMPT     a disabled control. WCAG 1.4.3 exempts inactive user interface components, so
                these are measured and printed and never asserted - the same posture pass 1 takes
                for `--prl-text-disabled`. Two are real and worth knowing about: the quiz's
                "Previous" and the onboarding's "Back" are `disabled` at step 0, and measure
                2.27:1 dark / 2.27:1 light there.

   Text that is not painted at all is counted and named rather than dropped: `display: none`, a
   zero-area box, and the visually-hidden idiom (a clipped 1px box, or `clip-path: inset(50%)`).
   That last one is not cosmetic bookkeeping - the radar tables on `/legends` put 657 clipped
   cells in the tree, and counting them as measured text would have padded this pass with 657
   rows nobody can see.

   ## The model is checked against the renderer, not trusted

   Compositing arithmetic that agrees with itself is not evidence. So rows are PROBED: a 5x5 patch
   of a real screenshot is captured at a point inside the element that no glyph, no child box and
   no rounded corner covers, and the painted pixel is compared with the prediction. The patch must
   be one colour or the point is discarded and the probe moves - a patch that is not uniform is a
   point that was not clear, and comparing against it would invent a disagreement. The ratio is
   then RE-MEASURED on the painted pixel, which is the reader's real background including
   everything this walk does not model.

   What each probe proves depends on the row it landed on, and the two are not the same claim:

     a row whose composite is a SINGLE colour must match the painted pixel to within one 8-bit
     step. It is a prediction about a renderer and it is either right or the pass is worthless.
     a BOUNDED row has no single predicted colour, so what is asserted is that the painted pixel
     lies inside the envelope the enumeration produced. A bound that does not bound the renderer
     is not a bound, and every worst-case ratio computed the same way is then unproven.

   Probes are ranked by how much compositing the row actually needed, which is a correction the
   first version of this pass needed badly: it probed only the rows it could predict exactly, and
   the result was 44 probes of 44 opaque backgrounds - 44 confirmations that an opaque colour is
   its own colour, and no evidence at all about the arithmetic this pass exists for.

   Measured on the tree this was written against: 145 probes over 38 pages, every one in
   agreement - 99 matching the predicted composite exactly, 46 landing inside a bounded row's
   envelope, and 46 of them over a stack that had to be composited to predict at all.

   Two things had to be true for that. `prefers-reduced-motion: reduce` is emulated, because the
   walk and the screenshot are milliseconds apart and an entrance animation between them moves the
   geometry out from under the probe: with motion on, `/` reported the home guardrail's background
   10/255 too light in both themes, and the pixel it had probed belonged to the page behind a
   panel that had not finished arriving. And a probe point must clear the ROUNDED CORNERS of its
   box and not only its straight edges, because a corner paints nothing outside its arc.

   What this pass does not model is therefore stated where it can be checked rather than assumed:
   `box-shadow`. A drop shadow is painted over the surface BEHIND the element that casts it, so a
   point near an elevated pane is darker than any ancestor declares. Every probe point records
   whether a shadow can reach it, an exact match is DEMANDED where none can, and where one can
   the painted pixel is what gets asserted.

   ## What this pass still does not measure, said plainly so nobody reads it as more

     - hover, focus and active states, and anything behind a pointer. Passes 1 and 2 assert the
       tokens for those (`surface-hover`, `surface-active`, the focus ring over every backdrop
       luminance in [0, 1]); this pass sees the resting page.
     - borders, rings and graphic marks. 1.4.11 is asserted at the token layer, not per element.
     - text over a sibling that overlaps it without being an ancestor. The walk goes up the tree.
       A floating pane over unknown content is BOUNDED, which is the case that matters; two
       in-flow boxes overlapping by accident is a layout defect and a different gate's business.
     - a route this gate could not load. That is a failure here, not something to audit around.
   ========================================================================================== */

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
];

/**
 * The two accessibility preferences that REPLACE the material set, swept on two routes each.
 *
 * `tokens.css` collapses every glass token to an opaque surface under
 * `prefers-reduced-transparency: reduce`, and again under `prefers-contrast: more`, and says of
 * that path: "this is not a degraded fallback, it is the design's own flat mode, and every ratio
 * it produces is already asserted". That sentence was true of the token pairs and unproven of the
 * page, because the collapse changes which token each pane resolves to and nothing had ever
 * rendered it. Two routes under each preference is what turns the claim into a measurement.
 */
const PAINTED_CONDITIONS = [
  // `id` rather than `key`: `scripts/supply-chain/secret-scan.mjs` reads any name ending in `key`
  // that is assigned a quoted literal of twenty characters or more as a credential, and it is
  // right to - `PRL_BACKUP_KEY` is the one secret here that has no prefix of its own to match on.
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
 * A route that rendered one of these did not render.
 *
 * Same refusal as `scripts/ax-tree-audit.mjs`: an error boundary returns HTTP 200 and correct
 * markup, so a contrast sweep over one produces a confident PASS about a page nobody meant to
 * test. The fixture banner on `/play` is NOT one of these - it says "Fixture - no server is
 * connected" in a `.prl-error` box and the page under it is the real component tree.
 */
const ERROR_BOUNDARY_HEADINGS = [
  'this screen did not load',
  'the application could not be displayed',
  'page not found',
  'this replay needs a session',
];

const PAINTED_VIEWPORT = { width: 1440, height: 900 };

/** Below this, a page has not been swept - it has been glanced at. See "a sweep of nothing". */
const MIN_ROWS_PER_PAGE = 20;

/** Probe points offered per page, and how many must come back uniform before the page is done. */
const PROBE_CANDIDATES = 12;
const PROBES_PER_PAGE = 4;

/** Fewer probes than this across the whole pass and the model has not been checked at all. */
const MIN_PROBES = 24;

/** A predicted background must match the painted pixel to within this, per 8-bit channel. */
const PROBE_TOLERANCE = 2;

/**
 * The in-page walk, as source.
 *
 * It runs IN THE PAGE because the page is the only place that knows what the cascade resolved to.
 * `getComputedStyle` has already done every part of this job that is not compositing - the
 * cascade, custom properties, container queries, the theme, `@supports`, the preference media
 * queries - and re-deriving that from the stylesheets would be re-implementing a browser inside a
 * gate whose entire purpose is to stop trusting a model of one.
 *
 * Written without backticks and without a dollar-brace so it can live inside a template literal,
 * which is the idiom this repo already uses to avoid a `biome-ignore`.
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

/* ------------------------------------------------------------------------------------------
   PNG, decoded here rather than depended on.

   `Page.captureScreenshot` answers in PNG and the whole decoder is forty lines of `zlib` plus the
   five filter predictors from the spec, so the argument the header of this file makes about a
   colour library applies unchanged: a gate whose correctness rests on a package nobody here has
   read is a gate nobody here can defend. Only what Chrome emits is handled - 8 bits a channel,
   colour type 2 or 6, not interlaced - and anything else throws rather than guessing.
   ------------------------------------------------------------------------------------------ */

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

/** The colour of a patch, or null if the patch is not one colour - which means the point was not
    clear after all and the probe must move rather than report a disagreement it invented. */
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

/* ------------------------------------------------------------------------------------------
   A very small CDP client.

   Lifted from `scripts/ax-tree-audit.mjs` rather than shared through a helper module, for the
   reason that file gives at its own copy: these are release gates, and a gate that depends on a
   file another gate can change is a gate that can be broken from a distance.
   ------------------------------------------------------------------------------------------ */

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
        // React has to hydrate before the tree is the one a reader meets: the server's markup has
        // no client-rendered panes in it, and half this app's translucency is on those.
        await delay(450);
        return;
      }
    }
    throw new Error(`${url} did not finish loading`);
  }

  /** One 5x5 patch of the real page, at device scale 1 so a CSS pixel is an image pixel. */
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
  // Offset by pid so two runs on one machine do not fight over a port, and kept out of the ranges
  // `keyboard-audit.mjs` and `ax-tree-audit.mjs` use for the same reason.
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
    let version = null;
    for (let attempt = 0; attempt < 60 && version === null; attempt += 1) {
      await delay(150);
      version = await fetch(`http://127.0.0.1:${port}/json/version`)
        .then((r) => r.json())
        .catch(() => null);
    }
    if (version === null) throw new Error(`Chrome did not open a debugging port on ${port}`);
    console.log(dim(`  ${version.Browser} - ${headful ? 'headful' : 'headless'}`));

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // A device-metrics override rather than a window size: the width decides which container
    // queries and which media queries the redesign resolves, and a headless window that was
    // merely asked for a size does not reliably move either. `deviceScaleFactor: 1` is what makes
    // a probe's CSS pixel the same pixel the screenshot returns.
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
 * A child server this gate owns and must clean up.
 *
 * Detached and signalled by process group, for the same reason as `scripts/a11y-audit.mjs`:
 * `pnpm --filter ... start` is a wrapper, so killing the wrapper leaves the real server holding
 * the port, and an orphan makes the next run measure a build nobody meant to test.
 */
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

/* ------------------------------------------------------------------------------------------
   THE PASS ITSELF
   ------------------------------------------------------------------------------------------ */

const walkerSource = (measureAll, probeBudget) =>
  PAINT_WALKER.replace('MEASURE_ALL_ARGUMENT', String(measureAll)).replace(
    'PROBE_BUDGET_ARGUMENT',
    String(probeBudget),
  );

/** One page: navigate, theme it, walk it, probe it. Returns failures, never throws for content. */
async function measurePage(page, url, label, theme, failures, tally) {
  await page.goto(url);
  // The theme is set on the root element, which is where `tokens.css` keys both of its light
  // scopes. Setting it AFTER load rather than emulating `prefers-color-scheme` is deliberate: it
  // exercises the explicit `[data-theme]` scope, which is the one a reader who used the toggle
  // gets, and the media-query scope is asserted against it for drift in passes 1 and 2.
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await delay(250);

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

  // The probes. A point whose patch is not one colour was not clear, so it moves rather than
  // reporting a disagreement it invented; a point that never comes back clear is not a failure,
  // it is one fewer probe, and the pass asserts on how many came back overall.
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
    // A bound wide enough to hold anything holds nothing. Only a narrow envelope counts as a
    // check, and the wide ones are the rows the both-extremes assertion already covers.
    const tight =
      probe.high.r - probe.low.r < 48 && probe.high.g - probe.low.g < 48 && probe.high.b - probe.low.b < 48;

    if (!probe.single && !probe.shadow && tight && !inEnvelope) {
      // The row was BOUNDED, and the pixel Chrome painted is outside the bound. That is not a
      // near miss, it is the bound failing to bound - every worst-case ratio computed the same
      // way is then unproven.
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
      // A bounded row has no single predicted colour to match, so the exact-match arithmetic below
      // does not apply to it. What is asserted for it is the envelope above and, always, the
      // ratio measured on the painted pixel itself.
    } else if (delta <= PROBE_TOLERANCE) {
      matched += 1;
      tally.matched += 1;
    } else if (probe.shadow) {
      // A drop shadow from a neighbouring pane can land here, and this pass does not composite
      // shadows. Reported, and the painted pixel below is what gets asserted.
      tally.shadowed += 1;
    } else if (probe.floated) {
      // The stack was still translucent when it crossed a floating element, so the ancestor
      // background this walk used was a guess about what is behind the pane. The probe says it
      // guessed wrong - which is a fact about the page, not an error in the arithmetic, and the
      // reason the ASSERTION for these rows is the both-extremes bound and the painted pixel.
      tally.floated += 1;
    } else {
      // Nothing floats, nothing can cast a shadow here, and the composite was a single colour:
      // the two are measuring the same thing and the model is wrong. Every ratio in this pass is
      // worth nothing while that is true.
      fail(
        `MODEL DISAGREES WITH THE RENDERER at ${probe.x},${probe.y}: predicted ${toHex(probe.expected)}, ` +
          `Chrome painted ${toHex(painted)} (${delta}/255)  ${probe.sel}`,
      );
    }
    // The painted pixel is the reader's background whatever the model thinks, so it is asserted
    // in its own right - this is the one measurement in the pass that models nothing at all.
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
        // Motion is disabled for every condition, not only the default one: the walk and the
        // screenshot that checks it are milliseconds apart, and an entrance animation between
        // them moves the geometry out from under the probe. Measured: without this, `/` reported
        // the home guardrail 10/255 light in both themes because the panel had not landed yet.
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
    // Chrome missing, the server refusing to start, a route that never loaded: all of these are
    // failures of this gate. A contrast gate that cannot reach the app reports that it could not,
    // and exits non-zero, because the alternative is a green tick over nothing.
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

  // Every one of these is the same rule as the token passes': a check that read nothing is not a
  // check. The pass can fail because the app is wrong; it must also fail because it never looked.
  if (tally.rows === 0) {
    failures.push({ group: 'painted', line: 'no text was composited at all - the sweep found nothing' });
  }
  // Two per page or MIN_PROBES, whichever is smaller, so that `--routes` narrows the sweep
  // without turning the check off: a one-route run still has to prove the model on that route.
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

/** `--base-url`, `--no-start`, `--routes a,b`, `--headful`. Everything else is the default sweep. */
function parsePaintedOptions(argv) {
  const options = {
    // 3462, because the rest of the map is taken: 3000/3001 are the app and the API, 3456 is
    // `test:ax`, 3457 is `test:csp`, 3458/3459 are the age-gate audit, 3463 is `test:layout`,
    // 3464 is `test:keyboard` and 3465/3467 are `test:ax`'s third web app and the corrupting proxy
    // behind it. Two gates on one port is one gate measuring the other's server.
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
    // `--routes ''` is a sweep of nothing, and a sweep of nothing is not a pass.
    throw new Error('--routes was given no routes');
  }
  return options;
}

/* ==========================================================================================
   6. MAIN
   ========================================================================================== */

// Arguments first: a bad flag or a `--help` should not have to sit through two passes of matrices.
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

/**
 * PASS 3 runs last, and runs even when the token passes have already failed.
 *
 * Same reason `pnpm run verify` runs every gate after the first failure: a reader who has just
 * been handed four bad token pairings still needs to know whether the page they are about to ship
 * is legible, and those are different questions with different repairs.
 */
const paintedFailures = await runPaintedPass(paintedOptions);

console.log('');
console.log(bold('SUMMARY'));

const describe = (f) => {
  // A painted-layer finding is about one element on one route, not a pairing of two tokens, so it
  // arrives with its own line already written.
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
