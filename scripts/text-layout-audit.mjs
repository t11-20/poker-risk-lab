#!/usr/bin/env node
/**
 * `pnpm run test:layout`: measures where text was painted, with `Range.getClientRects()` over each
 * element's own text nodes, on every route in both themes at five widths, then again at 200% text in
 * a smaller large-text pass. Bounding boxes do not overlap when a grid track collapses; the text
 * overflows the box. That is how `grid-template-columns: minmax(0, 1fr) auto` on the Coach rail
 * shipped past every other gate.
 *
 * Findings: `collision` (glyphs of two independent in-flow elements intersect), `escapes` (glyphs
 * leave their own non-scrolling block), `clipped` (cut off by a non-scrolling ancestor without an
 * ellipsis), `squeezed` (a block narrower than its longest word), `broken` (a word torn one or two
 * characters a line, which `squeezed` cannot see because each piece fits), `spills` (glyphs cross
 * the left or right edge of the nearest box that draws one, with nothing clipping them), `page` (the
 * document scrolls sideways), and `unscaled` (the root font size is not the text size the reader
 * set, which `--text-scale` sets in Chrome itself). The page only measures. `findTextDefects()`
 * judges in Node, so tests can feed it the collapsed row's real numbers.
 *
 * Negative controls run on every invocation (`--controls-only` runs only them). Each injects CSS that
 * re-creates one defect shape and must be caught.
 */

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DevtoolsReplies, withChrome } from './chrome-devtools.mjs';
import { ManagedServer, refuseOccupiedPort } from './gate-servers.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

/**
 * `/play` through fixture states, so no socket or database is needed. Bare `/play` covers the live
 * table before "Deal me in", which fetches nothing until pressed.
 */
const ROUTES = [
  '/',
  '/learn',
  '/learn/pot-odds',
  '/learn/counting-outs',
  '/learn/glossary',
  '/play',
  '/play?state=decision',
  '/play?state=complete',
  '/lab',
  '/lab/fl-same-cards-under-the-gun',
  '/lab/spots',
  '/lab/spots/edit?from=fl-same-cards-under-the-gun',
  '/legends',
  '/legends/adaptive-exploiter',
  '/review',
  '/legends/hand-review/demo',
  '/terms',
  '/privacy',
  '/responsible-use',
  '/age-check',
  // The evidence behind the home page's figures, moved off the home page in the 4.0 re-identity.
  '/checks',
];

/**
 * The Coach defect did not reproduce at 360 or 768, where the rail is full width. 360 is the smallest
 * phone, 768 and 1024 straddle the breakpoints, 1440 is the design canvas, 1920 the widest desktop.
 */
const WIDTHS = [360, 768, 1024, 1440, 1920];

/** Tall enough that below-the-fold content lays out. */
const VIEWPORT_HEIGHT = 1200;

const THEMES = ['dark', 'light'];

/**
 * With em breakpoints, 768, 1024 and 1440 at 200% take the 384, 512 and 720px layouts with doubled text,
 * which the 100% sweep never measures. One theme keeps it short.
 */
const LARGE_TEXT = { scale: 2, themes: ['light'], widths: [768, 1024, 1440], phoneWidth: 360 };

/**
 * Injected before the `phoneWidth` cell is measured. CI's Linux Chrome may have no hyphenation dictionary,
 * so a word that fits only hyphenated would pass here and fail there.
 */
const NO_HYPHENATION = '* { hyphens: manual !important; }';

/**
 * The routes clean at `phoneWidth` with hyphenation off, where content wider than a phone scrolls sideways
 * that a 768px window still holds.
 */
const LARGE_TEXT_PHONE_ROUTES = [
  '/',
  '/learn',
  '/learn/pot-odds',
  '/learn/counting-outs',
  '/learn/glossary',
  '/play',
  '/play?state=decision',
  '/play?state=complete',
  '/lab',
  '/lab/fl-same-cards-under-the-gun',
  '/lab/spots',
  '/lab/spots/edit?from=fl-same-cards-under-the-gun',
  '/legends',
  '/legends/adaptive-exploiter',
  '/review',
  '/legends/hand-review/demo',
  '/terms',
  '/privacy',
  '/responsible-use',
  '/age-check',
  '/checks',
];

const LARGE_TEXT_PHONE_WHY =
  'content wider than 360px fits a 768px window, so only a phone at 200% text shows it';

/** An error boundary returns 200 with good markup, so it counts as a failed render. */
const ERROR_BOUNDARY_HEADINGS = [
  'this screen did not load',
  'the application could not be displayed',
  'page not found',
  'this replay needs a session',
];

// Each threshold was raised from a smaller value that produced a false positive on the real app.

/**
 * `letter-spacing` is added after the last glyph too. Measured 0.96px on `.prl-stat__unit` at
 * 12px/0.08em. The collapsed Coach label overshot by 6.6px.
 */
const EDGE_TOLERANCE = 2;

/**
 * The height share matters most. `getClientRects` measures ascent and descent, so tight
 * line-height lines cross by up to 1.4px (measured on `/legends`). A real collision crosses the full
 * height.
 */
const OVERLAP_MIN_AREA = 8;
const OVERLAP_MIN_WIDTH = 2;
const OVERLAP_MIN_HEIGHT_SHARE = 0.4;

/** Chrome's default text size, which `--text-scale` multiplies, and its default monospace size. */
const ROOT_FONT_SIZE = 16;
const FIXED_FONT_SIZE = 13;

/** A word must exceed its own content box by more than this to count as a collapsed column. */
const WORD_TOLERANCE = 2;

/**
 * A word broken into lines of at most this many characters was torn by a column too narrow for it.
 * "Result" on `/review` at 360px with 200% text stood one letter a line.
 */
const MAX_PIECE = 2;

/** The pieces of one broken word the page sends at most, so a longer word's count is a lower bound. */
const PIECES_SENT = 80;

const MIN_TEXT_BOXES_PER_PAGE = 15;

/**
 * Coverage floors per measurement asked for, about a third of the leanest slice measured: 62 routes,
 * light, 360px, 200% text averaged 141 blocks, 12.6 clip tests, 83 frames and 26.6 pairs. Words break
 * least at 100% text and 768px or wider: 1.05 judged a measurement there, against 10.5 in that slice.
 */
const FLOOR_PER_MEASUREMENT = {
  textBoxes: 45,
  ownBox: 45,
  clipTests: 4,
  frameTests: 25,
  pairs: 8,
  breakTests: 0.35,
};

/**
 * The default run's own floors, since the rates above held its 100% pass to 1,680 pairs of 33,528:
 * about a third of each pass on 2026-11-26 (clip tests from `/` and two Legends routes only).
 */
const DEFAULT_RUN_FLOORS = {
  main: { textBoxes: 13150, ownBox: 13150, clipTests: 2000, frameTests: 9600, pairs: 11150, breakTests: 78 },
  'large-text': {
    textBoxes: 5050,
    ownBox: 5050,
    clipTests: 570,
    frameTests: 3650,
    pairs: 2150,
    breakTests: 76,
  },
};

const COVERAGE = [
  ['textBoxes', 'text element(s) measured across the whole sweep'],
  ['ownBox', 'text blocks measured against their own box'],
  ['clipTests', 'text blocks measured against a clipping ancestor'],
  ['frameTests', 'text blocks measured against the frame drawn around them'],
  ['pairs', 'pairs of text blocks compared for a collision'],
  ['breakTests', 'words on two lines or more judged for a tear letter by letter'],
];

/**
 * @typedef {object} Exemption
 * @property {string} check    which finding this suppresses
 * @property {string} selector CSS selector the element must match
 * @property {string} why      the reason, in a sentence somebody can disagree with
 * @property {string[]} [also] when set, the other element of a collision, or the clipper or frame,
 *   must contain one of these in its description
 * @property {number} [aboveScale] when set, applies only at a text scale above this
 */

/**
 * @type {Exemption[]}
 *
 * A rule that a full sweep at a size it applies to never uses fails the gate, so add one only with
 * the finding it suppresses. Every run prints each rule, its reason and what it suppressed.
 */
const EXEMPTIONS = [];

/** Whether a rule applies at this text size. A measurement that names no size is at 100%. */
const appliesAtScale = (rule, scale) => rule.aboveScale === undefined || (scale ?? 1) > rule.aboveScale;

/**
 * @typedef {object} Control
 * @property {string} id
 * @property {string} route
 * @property {string} expect  the check that must fire
 * @property {string} css     injected into the page after load
 * @property {string} what    what it re-creates, for the log
 * @property {number} [scale] a text size the defect needs; it is then also measured at 100% and
 *   must be silent there, or it would be catching an ordinary defect
 * @property {string} [theme] default dark
 * @property {boolean} [unhyphenated] measured with `NO_HYPHENATION`, as the phone cell is; also measured
 *   without it for the log only, since a Chrome with no dictionary catches it either way
 */

const NARROW_COACH = '.prl-play .prl-play__coach { inline-size: 15rem; }';

/** @type {Control[]} */
const CONTROLS = [
  {
    id: 'coach-track',
    route: '/play?state=decision',
    width: 1440,
    expect: 'squeezed',
    what: 'the shipped Coach defect, put back: a bare `auto` track floored at max-content',
    // Since "Pot and price" shortened to "100 in the pot, 35 to call" it fits a 1440px rail even with
    // the defect, so the rail is narrowed to bring the value wider than its share again.
    css:
      '.prl-play .prl-coach__section .prl-stat__pair { grid-template-columns: minmax(0, 1fr) auto; } ' +
      `${NARROW_COACH}`,
  },
  {
    id: 'coach-track-collision',
    route: '/play?state=decision',
    width: 1440,
    expect: 'collision',
    what: 'the same defect, seen as glyphs painted across a collapsed label',
    // The value is set start-aligned as well, because whether the collapsed label's words land on
    // the sentence's glyphs or in the gap beside them depends on the face. Measured at 1440px after
    // the 4.0 typeface and sentence-case labels: the right-aligned sentence wrapped to leave its
    // first 29px empty, the label's words ("Pot", "and", "price") fell exactly there (x 1034-1063
    // against the value from 1063), and this control stopped being caught. Start-aligned, the
    // sentence covers the label at any face, so the control tests the detector and not the font.
    css:
      '.prl-play .prl-coach__section .prl-stat__pair { grid-template-columns: minmax(0, 1fr) auto; column-gap: 0; } ' +
      '.prl-play .prl-coach__section .prl-stat__value { justify-content: flex-start; text-align: start; } ' +
      `${NARROW_COACH}`,
  },
  {
    id: 'negative-margin',
    route: '/learn',
    width: 1024,
    expect: 'collision',
    what: 'two in-flow blocks pulled over each other by a negative margin',
    css: '.prl-learn-page__lead { margin-block-start: -2.5rem; }',
  },
  {
    id: 'clipped-heading',
    route: '/learn',
    width: 1024,
    expect: 'clipped',
    what: 'a heading cut off by an ancestor that hides overflow and does not scroll',
    css: '.prl-learn-page__head { overflow: hidden; max-width: 90px; }',
  },
  {
    id: 'page-sideways',
    route: '/terms',
    width: 360,
    expect: 'page',
    what: 'a document made wider than the phone it is being read on',
    css: 'main { min-width: 900px; }',
  },
  {
    id: 'page-sideways-2px',
    route: '/terms',
    width: 360,
    expect: 'page',
    what: 'a document 2px wider than the phone, as the scenario link on /learn/counting-outs made it',
    css: 'main { min-width: 362px; }',
  },
  {
    id: 'escaping-nowrap',
    route: '/lab',
    width: 768,
    expect: 'escapes',
    what: 'a sentence held on one line inside a box far too narrow for it',
    css: '.prl-page-head__standfirst { white-space: nowrap; max-width: 120px; }',
  },
  {
    id: 'inside-display-contents',
    route: '/legends',
    width: 1440,
    expect: 'escapes',
    what: 'a Legends card title escaping its box, inside the `display: contents` difficulty scope',
    css: '.prl-legend-scope .prl-legend-identity__archetype { white-space: nowrap; max-width: 60px; }',
  },
  {
    id: 'letter-by-letter',
    route: '/learn',
    width: 1024,
    expect: 'broken',
    what: 'a paragraph in a column two characters wide, its words torn a letter or two a line',
    // Wider than any one letter, so every piece fits its column and `squeezed` stays silent.
    css: '.prl-learn-page__lead { inline-size: 2ch; overflow-wrap: anywhere; }',
  },
  {
    id: 'root-in-px',
    route: '/learn',
    width: 1024,
    expect: 'unscaled',
    what: 'a root font size set in px, which overrides the text size the reader chose',
    css: 'html { font-size: 10px; }',
  },
  {
    id: 'bordered-spill',
    route: '/terms',
    width: 1440,
    expect: 'spills',
    what: 'a paragraph wider than the bordered banner around it, painted across its border',
    // The paragraph keeps its glyphs inside its own box, so only the banner's edge is crossed.
    css: '.prl-legal__banner { max-width: 200px; } .prl-legal__banner p { width: 480px; }',
  },
  {
    id: 'header-px-breakpoint',
    route: '/learn',
    width: 1024,
    scale: 2,
    theme: 'light',
    expect: 'page',
    what: 'the desktop header kept under a px breakpoint, wider than the window at 200% text',
    // The 53.75em and 37.5em header rules put back in px: at 1024px and 32px text they still apply.
    css:
      '@media (min-width: 600px) { .prl-pillbar__brand .prl-shell__brand-name, ' +
      '.prl-pillbar__brand .prl-shell__brand-tail { display: inline; } } ' +
      '@media (min-width: 860px) { .prl-nav { display: block; } .prl-shell__theme { display: flex; } ' +
      '.prl-nav-trigger, .prl-sheet { display: none; } ' +
      '.prl-shell__header-inner { grid-template-columns: auto 1fr auto; } ' +
      '.prl-pillbar__brand .prl-shell__brand-name { display: none; } ' +
      '.prl-pillbar .prl-pillbar__nav { display: flex; align-items: center; justify-content: center; ' +
      'gap: var(--prl-pill-gap); } }',
  },
  {
    id: 'unhyphenated-word',
    route: '/',
    width: 360,
    scale: 2,
    theme: 'light',
    unhyphenated: true,
    expect: 'squeezed',
    what: 'a word that fits its box only hyphenated, measured with hyphenation off as the phone cell is',
    // "foundations" is 88px at 16px and 176px at 32px, where "founda-" and "tions" fit 120px.
    css:
      '.prl-home__way:first-child .prl-home__way-link ' +
      '{ inline-size: 120px; hyphens: auto; overflow-wrap: normal; }',
  },
];

/** The alpha of a computed colour, which Chrome reports as `rgb()`, `rgba()` or with a `/ a` part. */
export function colorAlpha(color) {
  if (color === '' || color === 'transparent') return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/u.exec(color);
  if (slash !== null) return Number(slash[1]) / (slash[2] === '%' ? 100 : 1);
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\s*\)$/u.exec(color);
  return rgba === null ? 1 : Number(rgba[1]);
}

/**
 * Which vertical edges of a box a reader sees: a side with a border, or both sides of a fill that
 * differs from the colour behind it. A translucent fill always does: it composites over that colour.
 * Runs in the page beside `colorAlpha`, so it references nothing else.
 */
export function frameSides(style, backdrop) {
  const border = (side) =>
    Number.parseFloat(style[`border${side}Width`]) > 0 &&
    style[`border${side}Style`] !== 'none' &&
    style[`border${side}Style`] !== 'hidden' &&
    colorAlpha(style[`border${side}Color`]) > 0;
  const alpha = colorAlpha(style.backgroundColor);
  const fill = alpha > 0 && (alpha < 1 || style.backgroundColor !== backdrop);
  return { left: fill || border('Left'), right: fill || border('Right') };
}

/**
 * Folds one word's rectangles into the widest piece, and with `firstTop` known the widest on the first
 * line and on any later one, so each piece meets the room of its own line. Runs in the page.
 */
export function foldWord(widest, text, rects, firstTop) {
  for (const r of rects) {
    const piece = { text, width: Math.round(r.width * 100) / 100 };
    if (widest.word === null || piece.width > widest.word.width) widest.word = piece;
    if (firstTop === null) continue;
    piece.first = r.top < firstTop + r.height / 2;
    const line = piece.first ? 'opening' : 'later';
    if (widest[line] === null || piece.width > widest[line].width) widest[line] = piece;
  }
  return widest;
}

/**
 * A computed text-indent in px, a percentage being of the block's inline size, and whether it names
 * `hanging` or `each-line`, which indent other lines than the first. Runs in the page.
 */
export function parseTextIndent(raw, width) {
  const parts = String(raw ?? '')
    .trim()
    .split(/\s+/u);
  const keywords = parts.some((part) => part === 'hanging' || part === 'each-line');
  const length = parts.filter((part) => part !== 'hanging' && part !== 'each-line').join(' ');
  const n = Number.parseFloat(length);
  if (!Number.isFinite(n)) return { px: 0, keywords };
  return { px: length.endsWith('%') ? (n * width) / 100 : n, keywords };
}

// The walker measures and decides nothing. Comments inside it are part of the page script.

const WALKER = String.raw`(() => {
  const EXEMPT_SELECTORS = EXEMPT_SELECTORS_ARGUMENT;
  const colorAlpha = COLOR_ALPHA_ARGUMENT;
  const frameSides = FRAME_SIDES_ARGUMENT;
  const foldWord = FOLD_WORD_ARGUMENT;
  const PIECES_SENT = PIECES_SENT_ARGUMENT;
  const parseTextIndent = PARSE_TEXT_INDENT_ARGUMENT;

  const skipped = { ariaHidden: 0, visuallyHidden: 0, invisible: 0, offscreen: 0, inert: 0 };

  /** Tags whose text is never painted. */
  const NEVER_PAINTED = new Set(['SCRIPT', 'STYLE', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'HEAD']);

  /** A short, readable path: three levels of tag + id + up to three classes. */
  const describe = (el) => {
    const parts = [];
    let cur = el;
    for (let depth = 0; cur !== null && depth < 3; depth += 1) {
      let s = cur.tagName.toLowerCase();
      if (cur.id !== '') s += '#' + cur.id;
      const classes = (cur.getAttribute('class') || '').trim().split(/\s+/).filter((c) => c !== '');
      if (classes.length > 0) s += '.' + classes.slice(0, 3).join('.');
      parts.unshift(s);
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  /**
   * The visually-hidden idiom, in each of the three spellings this codebase and its reset use.
   *
   * "display: contents" is excluded before the size test, because such an element generates no box
   * and getBoundingClientRect() reports 0x0 for it however much it contains. The Legends difficulty
   * scope (#24) wraps the picker and all twelve cards in one, and every text block on those cards
   * was then counted "visually hidden" and never measured: blocks measured against a clipping
   * ancestor fell from 4,160 to 320 across the sweep, and the coverage floor is what said so. The
   * inside-display-contents control keeps it from going quiet again. (No backticks in this
   * comment: it sits inside the template literal the walker is sent to the page as.)
   */
  const isVisuallyHidden = (style, rect) => {
    if (style.display === 'contents') return false;
    if (style.clipPath === 'inset(50%)') return true;
    if (style.clip === 'rect(0px, 0px, 0px, 0px)') return true;
    if (rect.width <= 1 && rect.height <= 1) return true;
    return false;
  };

  const scrollsHorizontally = (style) =>
    style.overflowX === 'auto' || style.overflowX === 'scroll' ||
    style.overflowX === 'overlay';

  const hidesOverflowX = (style) => style.overflowX === 'hidden' || style.overflowX === 'clip';

  /** Padding box and content box of an element, from its border box and its computed edges. */
  const boxesOf = (el, style) => {
    const r = el.getBoundingClientRect();
    const num = (v) => {
      const n = Number.parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    };
    const bl = num(style.borderLeftWidth);
    const br = num(style.borderRightWidth);
    const bt = num(style.borderTopWidth);
    const bb = num(style.borderBottomWidth);
    const pl = num(style.paddingLeft);
    const pr = num(style.paddingRight);
    const pt = num(style.paddingTop);
    const pb = num(style.paddingBottom);
    const pad = {
      x: r.left + bl,
      y: r.top + bt,
      w: Math.max(0, r.width - bl - br),
      h: Math.max(0, r.height - bt - bb),
    };
    const content = {
      x: pad.x + pl,
      y: pad.y + pt,
      w: Math.max(0, pad.w - pl - pr),
      h: Math.max(0, pad.h - pt - pb),
    };
    return { pad, content };
  };

  const asRect = (r) => ({
    x: Math.round(r.left * 100) / 100,
    y: Math.round(r.top * 100) / 100,
    w: Math.round(r.width * 100) / 100,
    h: Math.round(r.height * 100) / 100,
  });

  const round = (box) => ({
    x: Math.round(box.x * 100) / 100,
    y: Math.round(box.y * 100) / 100,
    w: Math.round(box.w * 100) / 100,
    h: Math.round(box.h * 100) / 100,
  });

  // -- the walk ------------------------------------------------------------

  const all = document.querySelectorAll('*');
  const styles = new Map();
  const styleOf = (el) => {
    let s = styles.get(el);
    if (s === undefined) {
      s = window.getComputedStyle(el);
      styles.set(el, s);
    }
    return s;
  };

  // Preorder index and subtree end, so Node can ask "is a an ancestor of b" with two integers.
  const order = new Map();
  const ends = new Map();
  for (let i = 0; i < all.length; i += 1) {
    order.set(all[i], i);
    ends.set(all[i], i + 1 + all[i].getElementsByTagName('*').length);
  }

  /**
   * The nearest positioned ancestor-or-self, as a preorder index, or -1.
   *
   * Two elements that share this answer are in flow with respect to each other: every step from
   * each of them up to that shared root is static, so their nearest common ancestor is at or below
   * it and neither is out of the other's flow. Two elements that do NOT share it are in different
   * layers, which is the "deliberately stacked" case, and it is excluded structurally rather than
   * by a selector somebody has to maintain.
   */
  const flowRoot = new Map();
  const flowRootOf = (el) => {
    const cached = flowRoot.get(el);
    if (cached !== undefined) return cached;
    const style = styleOf(el);
    let answer;
    if (style.position !== 'static') answer = order.get(el);
    else if (el.parentElement === null) answer = -1;
    else answer = flowRootOf(el.parentElement);
    flowRoot.set(el, answer);
    return answer;
  };

  /** The nearest absolute or fixed ancestor-or-self, or -1. Text in such a layer may overhang on purpose. */
  const layer = new Map();
  const layerOf = (el) => {
    const cached = layer.get(el);
    if (cached !== undefined) return cached;
    const position = styleOf(el).position;
    let answer;
    if (position === 'absolute' || position === 'fixed') answer = order.get(el);
    else if (el.parentElement === null) answer = -1;
    else answer = layerOf(el.parentElement);
    layer.set(el, answer);
    return answer;
  };

  /** The colour painted behind an element: the nearest ancestor's fill. display: contents paints none. */
  const backdrop = new Map();
  const backdropOf = (el) => {
    const parent = el.parentElement;
    if (parent === null) return '';
    const cached = backdrop.get(parent);
    if (cached !== undefined) return cached;
    const own = styleOf(parent).backgroundColor;
    const paints = styleOf(parent).display !== 'contents' && colorAlpha(own) > 0;
    const answer = paints ? own : backdropOf(parent);
    backdrop.set(parent, answer);
    return answer;
  };

  /** The nearest ancestor-or-self that scrolls horizontally, or null. */
  const scrollHostOf = (el) => {
    for (let cur = el; cur !== null; cur = cur.parentElement) {
      if (scrollsHorizontally(styleOf(cur))) return order.get(cur);
    }
    return null;
  };

  /** The block this text is laid into: skip inline boxes, which hug their glyphs. */
  const blockOf = (el) => {
    for (let cur = el; cur !== null; cur = cur.parentElement) {
      const d = styleOf(cur).display;
      if (d !== 'inline' && d !== 'ruby' && d !== 'contents') return cur;
    }
    return el;
  };

  /** Preserved white space hangs past the line box at a wrap, and it paints nothing. */
  const preservesSpaces = (style) => {
    const collapse = style.whiteSpaceCollapse;
    if (typeof collapse === 'string' && collapse !== '') {
      return collapse === 'preserve' || collapse === 'break-spaces' || collapse === 'preserve-spaces';
    }
    const ws = style.whiteSpace;
    return ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces';
  };

  /** The top of a block's first line, which is the only line text-indent moves. */
  const firstLineTop = (block) => {
    const range = document.createRange();
    range.selectNodeContents(block);
    let top = null;
    for (const r of range.getClientRects()) {
      if (r.height > 0.5 && (top === null || r.top < top)) top = r.top;
    }
    return top;
  };

  /** Word rectangles merged along each line, so the hanging space between them is not counted. */
  const addInk = (ink, r) => {
    const prev = ink[ink.length - 1];
    if (prev !== undefined && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.height - r.height) < 0.5) {
      const left = Math.min(prev.left, r.left);
      prev.width = Math.max(prev.left + prev.width, r.right) - left;
      prev.left = left;
      return;
    }
    ink.push({ left: r.left, top: r.top, width: r.width, height: r.height });
  };

  /** How many lines a set of rectangles sits on: a new line starts half a line below the last. */
  const lineCount = (rects) => {
    const tops = rects.map((r) => r.top).sort((a, b) => a - b);
    let lines = 0;
    let at = null;
    for (let k = 0; k < tops.length; k += 1) {
      if (at === null || tops[k] - at > rects[0].height / 2) {
        lines += 1;
        at = tops[k];
      }
    }
    return lines;
  };

  /** A word's characters grouped by the line each was painted on. Only run for a word that broke. */
  const piecesOf = (node, start, word) => {
    const pieces = [];
    let piece = '';
    let at = null;
    let k = start;
    for (const ch of word) {
      const c = document.createRange();
      c.setStart(node, k);
      c.setEnd(node, k + ch.length);
      k += ch.length;
      const r = [...c.getClientRects()].find((x) => x.height > 0.5);
      if (r !== undefined && at !== null && Math.abs(r.top - at) > r.height / 2 && piece !== '') {
        pieces.push(piece);
        piece = '';
      }
      if (r !== undefined) at = r.top;
      piece += ch;
    }
    pieces.push(piece);
    return { text: word.slice(0, 40), pieces: pieces.slice(0, PIECES_SENT) };
  };

  const boxes = [];
  const ariaHidden = [];
  const clippers = [];
  const frames = [];
  const docRoot = document.documentElement;
  let textNodes = 0;
  let words = 0;
  let scanned = 0;

  for (const el of all) {
    if (NEVER_PAINTED.has(el.tagName)) continue;
    scanned += 1;

    const style = styleOf(el);

    if (hidesOverflowX(style) && !scrollsHorizontally(style)) {
      const { pad } = boxesOf(el, style);
      if (pad.w > 0 && pad.h > 0) {
        clippers.push({
          i: order.get(el),
          end: ends.get(el),
          sel: describe(el),
          pad: round(pad),
        });
      }
    }

    // A frame needs a box of its own that lets text overflow. The root's fill paints the canvas.
    const boxed = style.display !== 'none' && style.display !== 'contents' && style.display !== 'inline' &&
      style.display !== 'ruby';
    const shown = style.visibility === 'visible' && style.overflowX === 'visible';
    if (boxed && shown && el !== document.body && el !== docRoot) {
      const sides = frameSides(style, backdropOf(el));
      const r = el.getBoundingClientRect();
      if ((sides.left || sides.right) && r.width > 0 && r.height > 0) {
        frames.push({ i: order.get(el), end: ends.get(el), sel: describe(el), border: asRect(r), ...sides });
      }
    }

    // Own text nodes only. A container's text is its children's business.
    const own = [];
    for (const node of el.childNodes) {
      if (node.nodeType === 3 && /\S/u.test(node.nodeValue)) own.push(node);
    }
    if (own.length === 0) continue;

    if (style.display === 'none' || style.visibility !== 'visible') {
      skipped.invisible += 1;
      continue;
    }
    if (Number.parseFloat(style.opacity) < 0.05) {
      skipped.invisible += 1;
      continue;
    }
    // Hidden from a screen reader, not from the eye: such text is measured, and Node judges it only
    // for a word broken letter by letter, since its overlaps are often decorative by design.
    const silent = el.closest('[aria-hidden="true"]') !== null;
    if (el.closest('[hidden], [inert], details:not([open]) > *:not(summary), dialog:not([open])') !== null) {
      skipped.inert += 1;
      continue;
    }

    const rect = el.getBoundingClientRect();
    let hiddenAncestor = false;
    for (let cur = el; cur !== null; cur = cur.parentElement) {
      if (isVisuallyHidden(styleOf(cur), cur.getBoundingClientRect())) {
        hiddenAncestor = true;
        break;
      }
    }
    if (hiddenAncestor) {
      skipped.visuallyHidden += 1;
      continue;
    }

    const block = blockOf(el);
    const blockStyle = styleOf(block);
    const { pad, content } = boxesOf(block, blockStyle);
    const indent = parseTextIndent(blockStyle.textIndent, content.w);
    // Which lines hanging or each-line indents is not measured, so no piece is placed on a line.
    const firstTop = indent.px === 0 || indent.keywords ? null : firstLineTop(block);
    const preserved = preservesSpaces(style);

    // Glyph rectangles, and the widest word, from the text nodes themselves.
    const rects = [];
    const ink = [];
    const broken = [];
    const widest = { word: null, opening: null, later: null };
    for (const node of own) {
      textNodes += 1;
      const value = node.nodeValue;
      const first = value.search(/\S/u);
      const last = value.length - value.replace(/\s+$/u, '').length;
      const range = document.createRange();
      range.setStart(node, first);
      range.setEnd(node, value.length - last);
      for (const r of range.getClientRects()) {
        if (r.width > 0.5 && r.height > 0.5) rects.push(asRect(r));
      }
      // The longest word, measured rather than estimated: a Range over exactly its characters.
      const pattern = /\S+/gu;
      let match = pattern.exec(value);
      while (match !== null) {
        words += 1;
        const w = document.createRange();
        w.setStart(node, match.index);
        w.setEnd(node, match.index + match[0].length);
        const pieces = [...w.getClientRects()];
        foldWord(widest, match[0].slice(0, 40), pieces, firstTop);
        const shown = pieces.filter((r) => r.width > 0.5 && r.height > 0.5);
        if (preserved) for (const r of shown) addInk(ink, r);
        if (lineCount(shown) > 1) broken.push(piecesOf(node, match.index, match[0]));
        match = pattern.exec(value);
      }
    }
    if (rects.length === 0) {
      skipped.invisible += 1;
      continue;
    }
    if (rects.every((r) => r.x + r.w < 0 || r.y + r.h < -2000)) {
      skipped.offscreen += 1;
      continue;
    }

    const text = own
      .map((n) => n.nodeValue)
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 80);

    const exempt = [];
    for (let i = 0; i < EXEMPT_SELECTORS.length; i += 1) {
      try {
        if (el.matches(EXEMPT_SELECTORS[i])) exempt.push(i);
      } catch (err) {
        return { selectorError: EXEMPT_SELECTORS[i] + ': ' + err.message };
      }
    }

    const measured = {
      i: order.get(el),
      end: ends.get(el),
      sel: describe(el),
      tag: el.tagName.toLowerCase(),
      text,
      rects,
      pad: round(pad),
      content: round(content),
      word: widest.word,
      flow: flowRootOf(el),
      layer: layerOf(el),
      scrollHost: scrollHostOf(el),
      blockScrolls: scrollsHorizontally(blockStyle),
      ellipsis: style.textOverflow === 'ellipsis' || blockStyle.textOverflow === 'ellipsis',
      broken,
      fills: style.wordBreak === 'break-all' || style.lineBreak === 'anywhere' || style.hyphens === 'auto',
      exempt,
    };
    if (preserved && ink.length > 0) measured.ink = ink.map(asRect);
    if (indent.px !== 0) {
      measured.indent = Math.round(indent.px * 100) / 100;
      if (indent.keywords) measured.indentKeyword = true;
      else Object.assign(measured, { opening: widest.opening, later: widest.later });
    }
    if (silent) {
      skipped.ariaHidden += 1;
      ariaHidden.push(measured);
    } else boxes.push(measured);
  }

  const h1 = document.querySelector('h1');
  const docEl = document.documentElement;

  return {
    heading: h1 === null ? '' : (h1.textContent || '').trim().slice(0, 120).toLowerCase(),
    boxes,
    ariaHidden,
    clippers,
    frames,
    page: {
      scrollWidth: docEl.scrollWidth,
      clientWidth: docEl.clientWidth,
      innerWidth: window.innerWidth,
      rootFontSize: Number.parseFloat(window.getComputedStyle(docEl).fontSize),
    },
    counts: {
      scanned,
      textBoxes: boxes.length,
      textNodes,
      words,
      clippers: clippers.length,
      frames: frames.length,
    },
    skipped,
  };
})()`;

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;

export function intersection(a, b) {
  const dx = Math.min(right(a), right(b)) - Math.max(a.x, b.x);
  const dy = Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y);
  if (dx <= 0 || dy <= 0) return { dx: 0, dy: 0, area: 0 };
  return { dx, dy, area: dx * dy };
}

export function isRealOverlap(hit, a, b) {
  if (hit.area < OVERLAP_MIN_AREA) return false;
  if (hit.dx < OVERLAP_MIN_WIDTH) return false;
  const share = hit.dy / Math.max(1e-6, Math.min(a.h, b.h));
  return share >= OVERLAP_MIN_HEIGHT_SHARE;
}

const isAncestor = (a, b) => a.i < b.i && b.end <= a.end;

/** Zero when `rects` stay inside `box`. */
export function escapeAmount(rects, box) {
  let worst = 0;
  let side = '';
  for (const r of rects) {
    const over = right(r) - right(box);
    const under = box.x - r.x;
    if (over > worst) {
      worst = over;
      side = 'right';
    }
    if (under > worst) {
      worst = under;
      side = 'left';
    }
  }
  return { amount: Math.round(worst * 100) / 100, side };
}

/** The innermost frame containing `box`, the box's own element included, or null. */
export function nearestFrame(box, frames) {
  let nearest = null;
  for (const frame of frames) {
    if (frame.i > box.i || box.i >= frame.end) continue;
    if (nearest === null || frame.i > nearest.i) nearest = frame;
  }
  return nearest;
}

/** The frame's border box, opened out on a side it does not draw, so only a drawn edge can be crossed. */
export function drawnEdges(frame) {
  const far = 1e6;
  const left = frame.left ? frame.border.x : -far;
  const rightEdge = frame.right ? right(frame.border) : far;
  return { x: left, y: frame.border.y, w: rightEdge - left, h: frame.border.h };
}

/** What of `rects` each clipper lets through horizontally. A clipper wider than the frame hides nothing. */
export function clippedRects(rects, clips) {
  let shown = rects;
  for (const clip of clips) {
    shown = shown.flatMap((r) => {
      const x = Math.max(r.x, clip.pad.x);
      const w = Math.min(right(r), right(clip.pad)) - x;
      return w > 0 ? [{ ...r, x, w }] : [];
    });
  }
  return shown;
}

/** Glyphs without the preserved white space that hangs past a wrapped line and paints nothing. */
const glyphsOf = (box) => box.ink ?? box.rects;

/** A break after one of these is the text's own break opportunity, not a word torn apart. */
const BREAK_AFTER = /[-\u00AD\u2010\u2013\u2014/]$/u;

/**
 * Two short pieces, or most of three or more, so one longer piece cannot clear "Br|illi|an|t" while
 * "reachin|g" stays an emergency break. Where the browser fills lines (`break-all`, `hyphens: auto`)
 * every middle piece is a whole line and the ends are leftovers, so one short middle piece is torn.
 */
function isTorn(run, fills) {
  const short = (p) => [...p].length <= MAX_PIECE;
  if (fills) return run.slice(1, -1).some(short);
  if (run.length === 2) return run.every(short);
  return run.length > 2 && run.filter(short).length * 2 > run.length;
}

/** The part of a broken word torn one or two characters a line, or null, whatever allowed the breaks. */
export function letterByLetter(pieces, fills = false) {
  let run = [];
  const runs = [];
  for (const piece of pieces) {
    run.push(piece);
    if (BREAK_AFTER.test(piece)) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs.find((r) => isTorn(r, fills)) ?? null;
}

/** The widest piece on the first line or a later one, whichever is shortest of its own line's room. */
function squeezeOf(box) {
  const indent = box.indent ?? 0;
  let worst = null;
  for (const word of [box.word, box.opening, box.later]) {
    if (word === null || word === undefined) continue;
    // A negative text-indent starts the first line that far before the content box. Under hanging or
    // each-line the lines it moves are unknown, so no line gains room and every line may lose it.
    const room =
      box.indentKeyword === true
        ? box.content.w - Math.max(0, indent)
        : box.content.w - (word.first === true ? indent : 0);
    const short = word.width - room;
    if (worst === null || short > worst.short) worst = { word, room, short };
  }
  return worst;
}

/** `measurement` is what `WALKER` returns. `context` names route, theme and width. */
export function findTextDefects(measurement, context = {}, exemptions = EXEMPTIONS) {
  const findings = [];
  const suppressed = {};
  const { boxes, clippers } = measurement;
  const frames = measurement.frames ?? [];
  const ariaHidden = measurement.ariaHidden ?? [];
  // What each detector looked at, floored in `coverageFailures`.
  const counts = {
    ownBox: 0,
    scrollExcused: 0,
    ellipsisExcused: 0,
    clipTests: 0,
    frameTests: 0,
    pairs: 0,
    breakTests: 0,
  };

  const exemptFor = (box, check, otherSel) => {
    for (const index of box.exempt) {
      const rule = exemptions[index];
      if (rule === undefined || rule.check !== check) continue;
      if (!appliesAtScale(rule, context.scale)) continue;
      if (rule.also !== undefined && otherSel !== undefined) {
        if (!rule.also.some((needle) => otherSel.includes(needle))) continue;
      }
      suppressed[index] = (suppressed[index] ?? 0) + 1;
      return rule;
    }
    return null;
  };

  const add = (check, detail) => {
    findings.push({ check, ...context, ...detail });
  };

  // A scroller does not mend a stacked word, and aria-hidden text is still painted. Only a word on
  // two lines or more is counted as judged, so a dead line count or piece split examines nothing.
  for (const box of [...boxes, ...ariaHidden]) {
    let reported = false;
    for (const word of box.broken ?? []) {
      if (!Array.isArray(word.pieces) || word.pieces.length < 2) continue;
      counts.breakTests += 1;
      if (reported || letterByLetter(word.pieces, box.fills === true) === null) continue;
      reported = true;
      if (exemptFor(box, 'broken') !== null) continue;
      add('broken', {
        sel: box.sel,
        text: box.text,
        word: word.text,
        pieces: word.pieces,
        ariaHidden: ariaHidden.includes(box),
      });
    }
  }

  for (const box of boxes) {
    // Only the block's own overflow excuses this. The Coach rail sits inside a horizontal scroller,
    // and skipping scrolling ancestors made this blind to the 0px column.
    if (box.blockScrolls) {
      counts.scrollExcused += 1;
      continue;
    }
    counts.ownBox += 1;

    const squeeze = squeezeOf(box);
    if (squeeze !== null && squeeze.short > WORD_TOLERANCE) {
      if (exemptFor(box, 'squeezed') === null) {
        add('squeezed', {
          sel: box.sel,
          text: box.text,
          word: squeeze.word.text,
          needs: squeeze.word.width,
          has: Math.round(squeeze.room * 100) / 100,
          short: Math.round(squeeze.short * 100) / 100,
        });
      }
    }

    if (box.ellipsis) counts.ellipsisExcused += 1;
    else {
      const escaped = escapeAmount(glyphsOf(box), box.pad);
      if (escaped.amount > EDGE_TOLERANCE && exemptFor(box, 'escapes') === null) {
        add('escapes', {
          sel: box.sel,
          text: box.text,
          side: escaped.side,
          past: escaped.amount,
          box: box.pad,
        });
      }
    }
  }

  for (const clipper of clippers) {
    for (const box of boxes) {
      if (box.i <= clipper.i || box.i >= clipper.end) continue;
      if (box.ellipsis) continue;
      if (box.scrollHost !== null && box.scrollHost > clipper.i) continue;
      counts.clipTests += 1;
      const escaped = escapeAmount(glyphsOf(box), clipper.pad);
      if (escaped.amount <= EDGE_TOLERANCE) continue;
      if (exemptFor(box, 'clipped', clipper.sel) !== null) continue;
      add('clipped', {
        sel: box.sel,
        text: box.text,
        clipper: clipper.sel,
        side: escaped.side,
        past: escaped.amount,
      });
    }
  }

  for (const box of boxes) {
    if (box.ellipsis) continue;
    const frame = nearestFrame(box, frames);
    if (frame === null) continue;
    // Out of flow or scrolled inside the frame, the glyphs are not crossing its edge.
    if (box.layer > frame.i) continue;
    if (box.scrollHost !== null && box.scrollHost >= frame.i) continue;
    counts.frameTests += 1;
    const clips = clippers.filter((c) => c.i >= frame.i && c.i <= box.i && box.i < c.end);
    const spilled = escapeAmount(clippedRects(glyphsOf(box), clips), drawnEdges(frame));
    if (spilled.amount <= EDGE_TOLERANCE) continue;
    if (exemptFor(box, 'spills', frame.sel) !== null) continue;
    add('spills', {
      sel: box.sel,
      text: box.text,
      frame: frame.sel,
      side: spilled.side,
      past: spilled.amount,
      box: frame.border,
    });
  }

  // Sorted by top edge so the scan can exit early. The key must be the TOPMOST rect, not `rects[0]`,
  // or the early exit skips pairs and reports no collision.
  const topOf = (box) => Math.min(...glyphsOf(box).map((r) => r.y));
  const sorted = [...boxes].sort((a, b) => topOf(a) - topOf(b));
  const lowestOf = sorted.map((box) => Math.max(...glyphsOf(box).map(bottom)));
  for (let a = 0; a < sorted.length; a += 1) {
    const first = sorted[a];
    for (let b = a + 1; b < sorted.length; b += 1) {
      const second = sorted[b];
      if (topOf(second) > lowestOf[a]) break;
      if (first.flow !== second.flow) continue;
      if (isAncestor(first, second) || isAncestor(second, first)) continue;
      counts.pairs += 1;
      let worst = null;
      let pair = null;
      for (const one of glyphsOf(first)) {
        for (const two of glyphsOf(second)) {
          const hit = intersection(one, two);
          if (!isRealOverlap(hit, one, two)) continue;
          if (worst === null || hit.area > worst.area) {
            worst = hit;
            pair = [one, two];
          }
        }
      }
      if (worst === null) continue;
      if (exemptFor(first, 'collision', second.sel) !== null) continue;
      if (exemptFor(second, 'collision', first.sel) !== null) continue;
      add('collision', {
        sel: first.sel,
        text: first.text,
        other: second.sel,
        otherText: second.text,
        area: Math.round(worst.area * 100) / 100,
        dx: Math.round(worst.dx * 100) / 100,
        dy: Math.round(worst.dy * 100) / 100,
        rects: pair,
      });
    }
  }

  // No tolerance: `scrollWidth` counts whole pixels of layout, and 2px of sideways scroll still scrolls.
  const { page } = measurement;

  // Without this a page that pins its root in px passes a 200% sweep while measuring 100% text. A root
  // that could not be read is judged the same way, so a missing measurement cannot pass.
  const expected = ROOT_FONT_SIZE * (context.scale ?? 1);
  if (!(Math.abs(page.rootFontSize - expected) < 0.5)) {
    add('unscaled', {
      sel: 'html',
      text: '',
      rootFontSize: page.rootFontSize ?? null,
      expected,
    });
  }

  if (page.scrollWidth > page.clientWidth) {
    add('page', {
      sel: 'html',
      text: '',
      scrollWidth: page.scrollWidth,
      clientWidth: page.clientWidth,
      past: page.scrollWidth - page.clientWidth,
    });
  }

  const usedExemptions = Object.keys(suppressed).map(Number);
  return { findings, usedExemptions, suppressed, counts };
}

export function formatFinding(finding) {
  const scale =
    finding.scale === undefined || finding.scale === 1 ? '' : `  ${String(finding.scale * 100)}% text`;
  const where = `${finding.route}  ${finding.theme}  ${String(finding.width)}px${scale}`;
  const quote = finding.text === '' ? '' : `  "${finding.text}"`;
  switch (finding.check) {
    case 'squeezed':
      return (
        `${where}\n      SQUEEZED   ${finding.sel}${quote}\n` +
        `      the column is ${String(finding.has)}px and the word "${finding.word}" needs ` +
        `${String(finding.needs)}px — short by ${String(finding.short)}px`
      );
    case 'broken': {
      const count = String(finding.pieces.length);
      const lines = finding.pieces.length >= PIECES_SENT ? `at least ${count}` : count;
      return (
        `${where}\n      BROKEN     ${finding.sel}${quote}${finding.ariaHidden ? ' (aria-hidden)' : ''}\n` +
        `      the word "${finding.word}" is torn over ${lines} lines: ` +
        `${finding.pieces.slice(0, 12).join(' | ')}`
      );
    }
    case 'escapes':
      return (
        `${where}\n      ESCAPES    ${finding.sel}${quote}\n` +
        `      glyphs reach ${String(finding.past)}px past the ${finding.side} edge of their own box`
      );
    case 'clipped':
      return (
        `${where}\n      CLIPPED    ${finding.sel}${quote}\n` +
        `      cut off ${String(finding.past)}px past the ${finding.side} edge of ${finding.clipper}`
      );
    case 'spills':
      return (
        `${where}\n      SPILLS     ${finding.sel}${quote}\n` +
        `      glyphs reach ${String(finding.past)}px past the ${finding.side} edge drawn by ${finding.frame}`
      );
    case 'collision':
      return (
        `${where}\n      COLLISION  ${finding.sel}${quote}\n` +
        `                 ${finding.other}  "${finding.otherText}"\n` +
        `      glyphs overlap by ${String(finding.area)} px² (${String(finding.dx)} x ${String(finding.dy)})`
      );
    case 'page':
      return (
        `${where}\n      PAGE       the document scrolls sideways: ${String(finding.scrollWidth)}px ` +
        `of content in a ${String(finding.clientWidth)}px viewport`
      );
    case 'unscaled':
      return (
        `${where}\n      UNSCALED   the root font size is ${String(finding.rootFontSize)}px ` +
        `where the reader set ${String(finding.expected)}px: the page ignored their text size`
      );
    default:
      return `${where}  ${finding.check}  ${finding.sel}`;
  }
}

const DEFAULTS = {
  // 3463 is free. 3000/3001 app and API, 3456/3465/3467 test:ax, 3457 test:csp, 3458/3459 age gate,
  // 3462 contrast, 3464 test:keyboard.
  baseUrl: process.env.PRL_LAYOUT_ORIGIN ?? 'http://127.0.0.1:3463',
  start: false,
  headful: false,
  readyTimeoutSeconds: 120,
  routes: null,
  widths: null,
  themes: null,
  selfTest: true,
  controlsOnly: false,
  textScale: 1,
  textScaleGiven: false,
  out: null,
};

const LARGE_TEXT_CELLS = [
  `${String(LARGE_TEXT.scale * 100)}%`,
  LARGE_TEXT.themes.join(','),
  `${LARGE_TEXT.widths.join(',')}px`,
].join(', ');
const LARGE_TEXT_LAYOUTS = LARGE_TEXT.widths.map((w) => `${String(w / LARGE_TEXT.scale)}px`).join(', ');
const LARGE_TEXT_PHONE_CELLS =
  `${String(LARGE_TEXT_PHONE_ROUTES.length)} route(s) at ` + `${String(LARGE_TEXT.phoneWidth)}px`;

const HELP = `
${bold('pnpm run test:layout')} — the PAINTED TEXT of this app, in real Chrome

  ${yellow('Measures Range.getClientRects() over the text nodes themselves — where the')}
  ${yellow('GLYPHS landed — not the bounding boxes of the elements that hold them. A')}
  ${yellow('collapsed grid track does not overlap anything; its text does.')}

  Server
    --base-url <url>      web app origin                   (default ${DEFAULTS.baseUrl})
    --start               start the built web app rather than using one already running
    --ready-timeout <s>   how long to wait for it          (default ${DEFAULTS.readyTimeoutSeconds})

  Scope
    --routes <a,b>        sweep only these routes, in both passes (default: all ${String(ROUTES.length)})
    --widths <n,n>        sweep only these widths          (default ${WIDTHS.join(',')})
    --themes <a,b>        sweep only these themes          (default ${THEMES.join(',')})
    --text-scale <n>      the reader's text size, as Chrome's own setting: 2 is 32px text
                          (1 to 3 in sixteenths, so the sizes Chrome takes stay whole; default 1)
    --no-self-test        skip the injected negative controls (they are the gate's own proof)
    --controls-only       run ONLY the negative controls and stop

  Passes
    Unless --widths, --themes or --text-scale is given, the matrix above runs at 100%
    text and then a large-text pass runs at ${LARGE_TEXT_CELLS}. Em breakpoints give
    those widths the ${LARGE_TEXT_LAYOUTS} layouts with doubled text. It also measures
    ${LARGE_TEXT_PHONE_CELLS} with hyphenation off, the ones clean there today. Any of the three
    flags replaces both passes with exactly the matrix it names, at one text size.

  Reporting
    --headful             run Chrome with a window, to watch it
    --out <file>          also write the findings as JSON
    -h, --help            this text

  Exits 0 when nothing collided, escaped, was clipped, spilled past a drawn frame,
  was squeezed or was broken letter by letter, every negative control was caught and
  every exemption a full pass could reach was used. Each exemption is printed with
  its reason on every run.
`;

export function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--start':
        options.start = true;
        break;
      case '--headful':
        options.headful = true;
        break;
      case '--no-self-test':
        options.selfTest = false;
        break;
      case '--controls-only':
        options.controlsOnly = true;
        break;
      case '--base-url':
        options.baseUrl = need();
        break;
      case '--out':
        options.out = need();
        break;
      case '--ready-timeout':
        options.readyTimeoutSeconds = Number(need());
        break;
      case '--text-scale':
        options.textScale = Number(need());
        options.textScaleGiven = true;
        break;
      case '--routes':
        options.routes = need()
          .split(',')
          .map((r) => r.trim())
          .filter((r) => r !== '');
        break;
      case '--themes':
        options.themes = need()
          .split(',')
          .map((r) => r.trim())
          .filter((r) => r !== '');
        break;
      case '--widths':
        options.widths = need()
          .split(',')
          .map((w) => Number.parseInt(w.trim(), 10));
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!Number.isInteger(options.readyTimeoutSeconds) || options.readyTimeoutSeconds < 1) {
    throw new Error('--ready-timeout must be a positive whole number of seconds');
  }
  if (options.widths?.some((w) => !Number.isInteger(w) || w < 200) === true) {
    throw new Error('--widths takes whole numbers of at least 200');
  }
  // `Page.setFontSizes` takes whole pixels, so 1.3 (20.8px) would be measured as something else.
  const scale = options.textScale;
  if (!Number.isFinite(scale) || scale < 1 || scale > 3 || !Number.isInteger(scale * ROOT_FONT_SIZE)) {
    throw new Error('--text-scale takes a number from 1 to 3 in sixteenths, such as 1.25, 1.5 or 2');
  }
  for (const [flag, list] of [
    ['--routes', options.routes],
    ['--widths', options.widths],
    ['--themes', options.themes],
  ]) {
    if (list !== null && list.length === 0) throw new Error(`${flag} was given an empty list`);
  }
  if (options.themes?.some((t) => !THEMES.includes(t)) === true) {
    throw new Error(`--themes takes ${THEMES.join(' and ')}`);
  }
  if (options.controlsOnly && !options.selfTest) {
    throw new Error('--controls-only and --no-self-test together leave nothing to run');
  }
  return options;
}

/** What `Page.setFontSizes` is sent. Its fields are integers, and the fixed size has no exact 13·n. */
export function fontSizesFor(scale) {
  return { standard: ROOT_FONT_SIZE * scale, fixed: Math.round(FIXED_FONT_SIZE * scale) };
}

/**
 * The passes a run measures. `narrowed` marks a pass that left out part of its own matrix, which
 * cannot prove an exemption stale.
 */
export function sweepPasses(options) {
  const routes = options.routes ?? ROUTES;
  const asked = options.widths !== null || options.themes !== null || options.textScaleGiven === true;
  // Only the run with none of the four scope flags is held to DEFAULT_RUN_FLOORS.
  const whole = !asked && options.routes === null;
  const main = {
    id: 'main',
    scale: options.textScale,
    routes,
    themes: options.themes ?? THEMES,
    widths: options.widths ?? WIDTHS,
    also: [],
    narrowed: options.routes !== null || options.widths !== null || options.themes !== null,
    floors: whole ? DEFAULT_RUN_FLOORS.main : null,
  };
  if (asked) return [main];
  const phoneRoutes = LARGE_TEXT_PHONE_ROUTES.filter((route) => routes.includes(route));
  const phone = {
    routes: phoneRoutes,
    themes: LARGE_TEXT.themes,
    widths: [LARGE_TEXT.phoneWidth],
    unhyphenated: true,
  };
  const large = {
    id: 'large-text',
    scale: LARGE_TEXT.scale,
    routes,
    themes: LARGE_TEXT.themes,
    widths: LARGE_TEXT.widths,
    also: phoneRoutes.length === 0 ? [] : [{ ...phone, why: LARGE_TEXT_PHONE_WHY }],
    narrowed: options.routes !== null,
    floors: whole ? DEFAULT_RUN_FLOORS['large-text'] : null,
  };
  return [main, large];
}

/** A pass's own matrix, then each further block of cells it measures at the same text size. */
export function passBlocks(pass) {
  return [{ routes: pass.routes, themes: pass.themes, widths: pass.widths }, ...(pass.also ?? [])];
}

const blockCells = (block) => block.routes.length * block.themes.length * block.widths.length;

export function sweepMatrix(options) {
  const out = [];
  for (const pass of sweepPasses(options)) {
    for (const block of passBlocks(pass)) {
      for (const route of block.routes) {
        for (const theme of block.themes) {
          for (const width of block.widths) out.push({ route, theme, width, scale: pass.scale });
        }
      }
    }
  }
  return out;
}

/** The floor for `key` in a run that asked for `wanted` measurements: never below one. */
export function coverageFloor(key, wanted) {
  return Math.max(1, Math.floor(FLOOR_PER_MEASUREMENT[key] * wanted));
}

/** What each detector examined against its floor: the rate for the run's size, or `floors` if higher. */
export function coverageChecks(tally, floors = null) {
  const wanted = tally.measurementsWanted ?? 0;
  return COVERAGE.map(([key, what]) => ({
    key,
    what,
    seen: (key === 'textBoxes' ? tally.textBoxes : tally.detector[key]) ?? 0,
    floor: Math.max(coverageFloor(key, wanted), floors?.[key] ?? 0),
  }));
}

/** Every condition that makes a green result meaningless, as failure lines. */
export function coverageFailures(tally, floors = null) {
  const problems = [];
  // The matrix asked for, not what was measured, so a run that measured less cannot lower its floor.
  const wanted = tally.measurementsWanted ?? 0;
  if (!(wanted >= 1)) {
    problems.push('the sweep asked for no measurement at all; a sweep of nothing is not a pass');
  }
  if (tally.measurements < Math.max(1, wanted)) {
    problems.push(
      `only ${String(tally.measurements)} of ${String(wanted)} page measurement(s) were taken; ` +
        'a sweep of nothing is not a pass',
    );
  }
  const per = `for ${String(wanted)} measurement(s)`;
  for (const { key, what, seen, floor } of coverageChecks(tally, floors)) {
    if (seen >= floor) continue;
    const why =
      key === 'textBoxes'
        ? 'a sweep of nothing is not a pass'
        : 'a detector that examined nothing reports what a detector that found nothing reports';
    problems.push(`only ${String(seen)} ${what} (floor ${String(floor)} ${per}) — ${why}`);
  }
  if (tally.routesLoaded < (tally.routesWanted ?? 0)) {
    problems.push(
      `${String((tally.routesWanted ?? 0) - tally.routesLoaded)} route(s) never loaded, so nothing was measured on them`,
    );
  }
  return problems;
}

/** Each pass held to its own floors, so a small pass cannot borrow coverage from the large one. */
export function passCoverageFailures(passes, tallies) {
  const failures = [];
  for (const [k, tally] of tallies.entries()) {
    const prefix = passes.length > 1 ? `${textSizeLabel(passes[k].scale)} pass: ` : '';
    for (const problem of coverageFailures(tally, passes[k].floors)) failures.push(`${prefix}${problem}`);
  }
  return failures;
}

/**
 * Each rule's standing after a run, from the findings it suppressed across every pass. A rule no pass
 * could reach is `unreached`, said aloud; one a full pass reached and never used is `stale`.
 */
export function exemptionReport(passes, suppressed, exemptions = EXEMPTIONS) {
  return exemptions.map((rule, index) => {
    const count = suppressed[index] ?? 0;
    const reached = passes.some((pass) => pass.narrowed !== true && appliesAtScale(rule, pass.scale));
    const status = count > 0 ? 'used' : reached ? 'stale' : 'unreached';
    return { index, rule, count, status };
  });
}

export function exemptionFailures(report) {
  return report
    .filter((entry) => entry.status === 'stale')
    .map(
      ({ index, rule }) =>
        `exemption ${String(index)} (${rule.check} ${rule.selector}) matched nothing in a full pass it ` +
        'applies to — a stale exemption is a hole that looks like a decision',
    );
}

export function formatExemption({ rule, count, status }) {
  const size = rule.aboveScale === undefined ? '' : ` above ${String(rule.aboveScale * 100)}% text`;
  const said = {
    used: `${String(count)} finding(s) suppressed`,
    stale: 'matched nothing',
    unreached: 'not reached: no full pass in this run measured at a size it applies to',
  }[status];
  return `${rule.check} ${rule.selector}${size}: ${said}\n      why: ${rule.why}`;
}

export class Page {
  textScale = 1;
  textSizeMethod = "Chrome's default, nothing sent";
  #socket;
  #nextId = 1;
  #replies = new DevtoolsReplies();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      this.#replies.settle(message);
    });
    socket.addEventListener('close', () => this.#replies.fail(new Error('the DevTools socket closed')));
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
    const reply = this.#replies.expect(id, method);
    try {
      this.#socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.#replies.fail(error);
    }
    return reply;
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

  /**
   * A device-metrics override, not a window resize. A resized headless window does not reliably move
   * media and container queries.
   */
  async setWidth(width) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /**
   * Chrome's own text-size setting, which moves em media queries; an inline root size would not, so a
   * refusal throws. Chrome starts at 16/13 and a reused profile keeps no size set this way (measured).
   */
  async setTextScale(scale) {
    if (scale === this.textScale) return;
    try {
      await this.send('Page.setFontSizes', { fontSizes: fontSizesFor(scale) });
    } catch (error) {
      throw new Error(
        `Chrome refused Page.setFontSizes for ${textSizeLabel(scale)} ` +
          `(${error instanceof Error ? error.message : String(error)}), ` +
          'so no layout at that size can be measured',
      );
    }
    this.textScale = scale;
    this.textSizeMethod = 'Page.setFontSizes';
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const state = await this.evaluate(
        '(() => ({ ready: document.readyState, url: location.href }))()',
      ).catch(() => null);
      if (state !== null && state.ready === 'complete' && state.url.startsWith(url.split('?')[0])) {
        await delay(400);
        return;
      }
    }
    throw new Error(`${url} did not finish loading`);
  }

  close() {
    this.#socket.close();
  }
}

/**
 * Port 0 and a fresh profile unless overridden, so Chrome picks the port and no other gate's Chrome can
 * answer on it. An empty profile would be Chrome's own.
 */
export function chromeTarget(env) {
  const port = env.PRL_LAYOUT_CDP_PORT ?? '0';
  const valid = /^\d+$/u.test(port) && Number(port) >= 1 && Number(port) <= 65535;
  if (env.PRL_LAYOUT_CDP_PORT !== undefined && !valid) {
    throw new Error(`PRL_LAYOUT_CDP_PORT takes a port from 1 to 65535, not "${port}"`);
  }
  const profile = env.PRL_LAYOUT_PROFILE;
  if (profile === undefined) return { port: Number(port), freshProfile: 'prl-text-layout-audit-' };
  if (profile.trim() === '') {
    throw new Error('PRL_LAYOUT_PROFILE is set but empty: name a folder or unset it');
  }
  return { port: Number(port), profile };
}

async function withPage(headful, target, textScale, run) {
  const chrome = {
    headful,
    ...target,
    flags: [
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${String(WIDTHS[WIDTHS.length - 1])},${String(VIEWPORT_HEIGHT)}`,
    ],
    dim,
  };
  await withChrome(chrome, async ({ version, openTab }) => {
    console.log(dim(`  ${version.Browser} — ${headful ? 'headful' : 'headless'}`));
    const page = await Page.open(await openTab());
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // Motion off, so an entrance animation cannot move geometry between walk and layout. It also
    // removes the boot overlay.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await page.setTextScale(textScale);
    try {
      await run(page);
    } finally {
      page.close();
    }
  });
}

const walkerSource = () =>
  WALKER.replace('EXEMPT_SELECTORS_ARGUMENT', JSON.stringify(EXEMPTIONS.map((rule) => rule.selector)))
    .replace('COLOR_ALPHA_ARGUMENT', () => String(colorAlpha))
    .replace('FRAME_SIDES_ARGUMENT', () => String(frameSides))
    .replace('FOLD_WORD_ARGUMENT', () => String(foldWord))
    .replace('PIECES_SENT_ARGUMENT', String(PIECES_SENT))
    .replace('PARSE_TEXT_INDENT_ARGUMENT', () => String(parseTextIndent));

let dumpCount = 0;

async function measure(page, route, theme, width, unhyphenated = false) {
  await page.setWidth(width);
  // On the root element, where `tokens.css` keys its light scope.
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  await delay(180);
  if (unhyphenated) await refuseHyphenation(page, route);
  const measurement = await page.evaluate(walkerSource());
  // `PRL_LAYOUT_DUMP=<dir>` writes every rectangle, for tuning thresholds.
  if (process.env.PRL_LAYOUT_DUMP !== undefined) {
    dumpCount += 1;
    writeFileSync(
      `${process.env.PRL_LAYOUT_DUMP}/dump-${String(dumpCount)}.json`,
      JSON.stringify(measurement, null, 1),
    );
  }
  if (measurement.selectorError !== undefined) {
    throw new Error(`an EXEMPTIONS selector is not valid CSS — ${measurement.selectorError}`);
  }
  return { measurement, context: { route, theme, width, scale: page.textScale } };
}

/**
 * A constructed stylesheet, because the CSP has no `'unsafe-inline'` for `style-src` and an injected
 * `<style>` never applies.
 */
async function injectSheet(page, css) {
  const applied = await page.evaluate(
    `(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(${JSON.stringify(css)});
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return sheet.cssRules.length;
    })()`,
  );
  if (applied === 0) throw new Error(`an injected stylesheet parsed to no rules: ${css}`);
  await delay(250);
}

/** The sweep and its control both open a page here, so the control proves the sweep's own injection. */
async function openPage(page, url, unhyphenated) {
  await page.goto(url);
  if (unhyphenated) await injectSheet(page, NO_HYPHENATION);
}

/** Read back from the page rather than trusted, since a Chrome with no dictionary looks the same. */
async function refuseHyphenation(page, route) {
  const left = await page.evaluate(
    "[...document.querySelectorAll('*')].filter((el) => getComputedStyle(el).hyphens === 'auto').length",
  );
  if (left !== 0) {
    throw new Error(`${route}: ${String(left)} element(s) still hyphenate with ${NO_HYPHENATION} injected`);
  }
}

async function controlFindings(page, baseUrl, control, scale, unhyphenated = control.unhyphenated === true) {
  await page.setTextScale(scale);
  await openPage(page, `${baseUrl}${control.route}`, unhyphenated);
  await injectSheet(page, control.css);
  const theme = control.theme ?? 'dark';
  const { measurement, context } = await measure(page, control.route, theme, control.width, unhyphenated);
  const { findings } = findTextDefects(measurement, context);
  return { findings: findings.filter((f) => f.check === control.expect), measurement };
}

/**
 * A control is caught when its check fired. One with its own text size must also be silent at 100%,
 * or it is catching an ordinary defect and no longer proves the larger text was measured.
 */
export function judgeControl(control, atScale, atDefaultSize) {
  if (atScale.length === 0) return { caught: false, why: 'missed' };
  if (control.scale !== undefined && !(atDefaultSize?.length === 0)) {
    return { caught: false, why: 'fires at 100% text' };
  }
  return { caught: true, why: '' };
}

/** Each control returns whether it was caught and the measurement, so a pass prints its evidence. */
async function runControls(page, baseUrl, runScale) {
  const results = [];
  for (const control of CONTROLS) {
    const scale = control.scale ?? runScale;
    const { findings, measurement } = await controlFindings(page, baseUrl, control, scale);
    const result = {
      id: control.id,
      what: control.what,
      expect: control.expect,
      route: control.route,
      width: control.width,
      scale,
      evidence: findings.slice(0, 2),
      textBoxes: measurement.counts.textBoxes,
    };
    let atOne;
    if (control.scale !== undefined) {
      atOne = (await controlFindings(page, baseUrl, control, 1)).findings;
      result.atDefaultSize = atOne.length;
    }
    if (control.unhyphenated === true) {
      result.hyphenated = (await controlFindings(page, baseUrl, control, scale, false)).findings.length;
    }
    Object.assign(result, judgeControl(control, findings, atOne));
    results.push(result);
  }
  await page.setTextScale(runScale);
  return results;
}

const textSizeLabel = (scale) => `${String(scale * 100)}% text`;

function newTally(pass) {
  return {
    scale: pass.scale,
    narrowed: pass.narrowed,
    measurements: 0,
    textBoxes: 0,
    textNodes: 0,
    words: 0,
    clippers: 0,
    skipped: { ariaHidden: 0, visuallyHidden: 0, invisible: 0, offscreen: 0, inert: 0 },
    detector: {
      ownBox: 0,
      scrollExcused: 0,
      ellipsisExcused: 0,
      clipTests: 0,
      frameTests: 0,
      pairs: 0,
      breakTests: 0,
    },
    measurementsWanted: passBlocks(pass).reduce((sum, block) => sum + blockCells(block), 0),
    routesLoaded: 0,
    routesWanted: passBlocks(pass).reduce((sum, block) => sum + block.routes.length * block.themes.length, 0),
    textSize: { scale: pass.scale, method: 'not applied' },
  };
}

async function sweepPass(page, baseUrl, pass, tally, findings, failures, suppressed) {
  const label = textSizeLabel(pass.scale);
  await page.setTextScale(pass.scale);
  tally.textSize.method = page.textSizeMethod;
  const size = (block) =>
    [
      `${String(block.routes.length)} route(s)`,
      `${String(block.themes.length)} theme(s)`,
      `${String(block.widths.length)} width(s)`,
    ].join(' x ');
  const sizes = passBlocks(pass).map(size).join(' + ');
  console.log(bold(`\nSweep at ${label} — ${sizes} = ${String(tally.measurementsWanted)} measurements`));
  for (const block of passBlocks(pass)) {
    if (block.why !== undefined) {
      const widths = block.widths.map((w) => `${String(w)}px`).join(', ');
      const hyphens = block.unhyphenated === true ? ', hyphenation off' : '';
      console.log(`  then at ${widths}, ${block.themes.join(', ')}${hyphens}`);
      console.log(dim(`  on ${block.routes.join(', ')}`));
      console.log(dim(`  because ${block.why}`));
    }
    await sweepBlock(page, baseUrl, label, block, tally, findings, failures, suppressed);
  }
}

async function sweepBlock(page, baseUrl, label, block, tally, findings, failures, suppressed) {
  for (const route of block.routes) {
    const perRoute = [];
    for (const theme of block.themes) {
      try {
        await openPage(page, `${baseUrl}${route}`, block.unhyphenated === true);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        failures.push(`${route} (${theme}, ${label}) did not load: ${why}`);
        continue;
      }
      let loaded = true;
      for (const width of block.widths) {
        const { measurement, context } = await measure(page, route, theme, width, block.unhyphenated);
        const where = `${route} (${theme}, ${String(width)}px, ${label})`;
        const heading = measurement.heading;
        if (ERROR_BOUNDARY_HEADINGS.some((boundary) => heading.startsWith(boundary))) {
          failures.push(`${where} rendered an error boundary ("${heading}") — nothing on it was measured`);
          loaded = false;
          break;
        }
        if (measurement.counts.textBoxes < MIN_TEXT_BOXES_PER_PAGE) {
          failures.push(
            `${where} produced only ${String(measurement.counts.textBoxes)} text element(s) — ` +
              'that is not a page',
          );
          loaded = false;
          break;
        }
        tally.measurements += 1;
        tally.textBoxes += measurement.counts.textBoxes;
        tally.textNodes += measurement.counts.textNodes;
        tally.words += measurement.counts.words;
        tally.clippers += measurement.counts.clippers;
        for (const key of Object.keys(tally.skipped)) {
          tally.skipped[key] += measurement.skipped[key] ?? 0;
        }
        const result = findTextDefects(measurement, context);
        for (const key of Object.keys(tally.detector)) tally.detector[key] += result.counts[key];
        for (const [index, count] of Object.entries(result.suppressed)) {
          suppressed[index] = (suppressed[index] ?? 0) + count;
        }
        for (const finding of result.findings) findings.push(finding);
        perRoute.push({ theme, width, findings: result.findings.length });
      }
      if (loaded) tally.routesLoaded += 1;
    }
    const hits = perRoute.reduce((sum, entry) => sum + entry.findings, 0);
    const mark = hits === 0 ? green('ok  ') : red('FAIL');
    console.log(
      `  ${mark} ${route.padEnd(36)} ${dim(`${String(perRoute.length)} measurement(s), ${String(hits)} finding(s)`)}`,
    );
  }
}

function printControl(result, failures) {
  const size = result.scale === 1 ? '' : `, ${textSizeLabel(result.scale)}`;
  const head = `  ${result.caught ? green('CAUGHT ') : red('MISSED ')} ${result.expect.padEnd(9)} ${result.id}`;
  console.log(`${head}  ${dim(result.what)}`);
  console.log(
    dim(
      `      ${result.route} at ${String(result.width)}px${size}, ${String(result.textBoxes)} text elements`,
    ),
  );
  if (result.atDefaultSize !== undefined) {
    console.log(dim(`      at 100% text: ${String(result.atDefaultSize)} ${result.expect} finding(s)`));
  }
  if (result.hyphenated !== undefined) {
    const why =
      result.hyphenated === 0
        ? 'this Chrome hyphenated the word, so only the injected sheet caught it'
        : 'this Chrome did not hyphenate it (no dictionary?), so this run shows only that the sheet applied';
    console.log(yellow(`      hyphenation allowed: ${String(result.hyphenated)} finding(s) — ${why}`));
  }
  if (result.caught) {
    for (const line of result.evidence.slice(0, 1)) {
      console.log(dim(`      ${formatFinding(line).split('\n').slice(1).join('\n      ').trim()}`));
    }
    return;
  }
  const where = `${result.route} at ${String(result.width)}px${size}`;
  if (result.why === 'missed') {
    failures.push(
      `negative control "${result.id}" was NOT caught: ${result.what} produced no ` +
        `${result.expect} finding on ${where}`,
    );
  } else {
    failures.push(
      `negative control "${result.id}" fires at 100% text too, so it no longer proves the larger ` +
        `text is measured: ${String(result.atDefaultSize)} ${result.expect} finding(s) on ` +
        `${result.route} at ${String(result.width)}px`,
    );
  }
}

async function main() {
  let options;
  let target;
  try {
    options = parseArgs(process.argv.slice(2));
    target = chromeTarget(process.env);
  } catch (err) {
    console.error(red(`text-layout-audit — ${err.message}`));
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log(bold('\nPoker Risk Lab painted-text audit'));
  console.log(yellow('  Where the GLYPHS landed, from Range.getClientRects() — not where the'));
  console.log(yellow('  boxes are. A collapsed grid track does not overlap anything; its text does.'));
  console.log(dim(`  ${options.baseUrl}\n`));

  const passes = sweepPasses(options);
  const tallies = passes.map(newTally);
  const failures = [];
  const findings = [];
  const controlResults = [];
  const suppressed = {};
  const servers = [];
  let exitCode = 0;

  try {
    if (options.start) {
      await refuseOccupiedPort(
        options.baseUrl,
        '--start measures a web app this run started, so it will not score one it did not. Stop it, ' +
          'pass another --base-url, or leave out --start to measure that server on purpose.',
      );
      const web = new ManagedServer('web', ['--filter', '@prl/web', 'start'], options.baseUrl, {
        NODE_ENV: 'production',
        PORT: new URL(options.baseUrl).port === '' ? '3000' : new URL(options.baseUrl).port,
      });
      servers.push(web);
      console.log(dim(`  starting the built web app on ${options.baseUrl} ...`));
      web.start();
      await web.waitUntilReady(options.readyTimeoutSeconds);
    } else {
      const probe = await fetch(options.baseUrl, { headers: { accept: 'text/html' } }).catch(() => null);
      if (probe === null || !probe.ok) {
        console.error(red(`\n${options.baseUrl} is not serving. Start it, or pass --start.`));
        console.error(dim('  pnpm --filter @prl/web build && pnpm --filter @prl/web start\n'));
        process.exit(1);
      }
    }

    await withPage(options.headful, target, passes[0].scale, async (page) => {
      if (options.selfTest) {
        console.log(bold('\nNegative controls — a defect of each shape, put back into a real page'));
        for (const result of await runControls(page, options.baseUrl, passes[0].scale)) {
          controlResults.push(result);
          printControl(result, failures);
        }
      }

      if (options.controlsOnly) return;

      for (const [k, pass] of passes.entries()) {
        await sweepPass(page, options.baseUrl, pass, tallies[k], findings, failures, suppressed);
      }
    });
  } catch (error) {
    failures.push(
      `the painted text could not be measured: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    for (const server of servers) server.stop();
  }

  const exemptions = exemptionReport(options.controlsOnly ? [] : passes, suppressed);
  if (!options.controlsOnly) {
    for (const problem of passCoverageFailures(passes, tallies)) failures.push(problem);
    for (const problem of exemptionFailures(exemptions)) failures.push(problem);
  }

  const byCheck = new Map();
  for (const finding of findings) {
    byCheck.set(finding.check, (byCheck.get(finding.check) ?? 0) + 1);
  }

  console.log(bold('\nSummary'));
  for (const [k, tally] of options.controlsOnly ? [] : tallies.entries()) {
    console.log(
      `  text size           ${textSizeLabel(tally.textSize.scale)} ` +
        `(${String(fontSizesFor(tally.textSize.scale).standard)}px), ` +
        `via ${tally.textSize.method}`,
    );
    console.log(`  measurements        ${String(tally.measurements)}`);
    console.log(`  text elements       ${String(tally.textBoxes)}`);
    console.log(`  text nodes / words  ${String(tally.textNodes)} / ${String(tally.words)}`);
    console.log(`  clipping ancestors  ${String(tally.clippers)}`);
    console.log(
      `  detectors examined  ${String(tally.detector.ownBox)} block(s) against their own box, ` +
        `${String(tally.detector.clipTests)} against a clipping ancestor, ` +
        `${String(tally.detector.frameTests)} against a drawn frame, ` +
        `${String(tally.detector.pairs)} pair(s) for a collision, ` +
        `${String(tally.detector.breakTests)} word(s) on two lines or more for a tear`,
    );
    console.log(
      dim(
        `  excused by construction: ${String(tally.detector.scrollExcused)} inside a block that ` +
          `scrolls horizontally, ${String(tally.detector.ellipsisExcused)} truncated with an ellipsis`,
      ),
    );
    console.log(
      dim(
        `  not painted, so not measured: ${String(tally.skipped.visuallyHidden)} visually hidden, ` +
          `${String(tally.skipped.invisible)} invisible, ` +
          `${String(tally.skipped.inert)} inert, ${String(tally.skipped.offscreen)} off-screen`,
      ),
    );
    console.log(dim(`  aria-hidden, judged only for a broken word: ${String(tally.skipped.ariaHidden)}`));
    const whose = passes[k].floors === null ? 'scaled to the measurements asked for' : "the default run's";
    const floors = coverageChecks(tally, passes[k].floors).map(
      ({ key, seen, floor }) => `${key} ${String(seen)} ${seen >= floor ? '>=' : '<'} ${String(floor)}`,
    );
    console.log(`  coverage floors     ${whose}: ${floors.join(', ')}`);
  }
  console.log(
    `  negative controls   ${String(controlResults.filter((r) => r.caught).length)}/${String(controlResults.length)} caught`,
  );
  console.log(`  exemptions          ${String(exemptions.length)}`);
  for (const entry of exemptions) {
    const line = `    - ${formatExemption(entry)}`;
    console.log(entry.status === 'used' ? yellow(line) : entry.status === 'stale' ? red(line) : dim(line));
  }
  console.log(`  findings            ${String(findings.length)}`);
  for (const [check, count] of [...byCheck].sort()) {
    console.log(`    ${check.padEnd(18)}${String(count)}`);
  }

  if (findings.length > 0) {
    console.log(bold('\n  Findings'));
    // Deduplicated by element and check. One collapsed column at five widths is one defect.
    const seen = new Map();
    for (const finding of findings) {
      const key = `${finding.check}|${finding.sel}|${finding.other ?? ''}`;
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(finding);
    }
    for (const [, group] of seen) {
      console.log(red(`    - ${formatFinding(group[0])}`));
      if (group.length > 1) {
        const where = group
          .slice(1)
          .map((f) => `${f.route} ${f.theme} ${String(f.width)}px ${textSizeLabel(f.scale ?? 1)}`)
          .slice(0, 6);
        console.log(dim(`      and ${String(group.length - 1)} more: ${where.join('; ')}`));
      }
    }
  }

  if (failures.length > 0) {
    console.log(bold('\n  Gate failures'));
    for (const failure of failures) console.log(red(`    - ${failure}`));
  }

  if (options.out !== null) {
    const outPath = resolve(REPO_ROOT, options.out);
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          tool: 'text-layout-audit.mjs — painted text, real Chrome',
          kind: 'layout',
          measures:
            'Range.getClientRects() over each element own text nodes: where the glyphs landed, ' +
            'not where the boxes are.',
          baseUrl: options.baseUrl,
          generatedAt: new Date().toISOString(),
          // The first pass, in the shape a single-size run has always written.
          matrix: {
            routes: passes[0].routes,
            themes: passes[0].themes,
            widths: passes[0].widths,
            textScale: passes[0].scale,
          },
          tally: tallies[0],
          passes: passes.map((pass, k) => ({ ...pass, tally: tallies[k] })),
          exemptions: exemptions.map(({ rule, count, status }) => ({ ...rule, suppressed: count, status })),
          controls: controlResults,
          findings,
          failures,
          passed: findings.length === 0 && failures.length === 0,
        },
        null,
        2,
      )}\n`,
    );
    console.log(dim(`\n  findings written to ${outPath}`));
  }

  if (findings.length > 0 || failures.length > 0) exitCode = 1;

  const measured = tallies.reduce((sum, t) => sum + t.measurements, 0);
  const elements = tallies.reduce((sum, t) => sum + t.textBoxes, 0);
  const sizes = passes.map((pass) => textSizeLabel(pass.scale)).join(' and ');
  if (exitCode === 0) {
    console.log(
      green(
        bold(
          `\nPASS — ${String(elements)} painted text elements over ${String(measured)} measurements at ` +
            `${sizes}, nothing collided, escaped, was clipped, spilled, was squeezed or broken,\n` +
            `and all ${String(controlResults.length)} negative controls were caught.`,
        ),
      ),
    );
  } else {
    console.log(red(bold('\nFAIL')));
  }
  console.log(
    dim(
      '\n  Caveat: this measures the RESTING page at the widths, themes and text sizes above. It has\n' +
        '  no opinion about whether the layout is good, and it sees no hover, focus or open state,\n' +
        '  and no animation mid-flight.\n',
    ),
  );

  process.exit(exitCode);
}

export { CONTROLS, EXEMPTIONS, LARGE_TEXT, LARGE_TEXT_PHONE_ROUTES, NO_HYPHENATION, ROUTES, THEMES, WIDTHS };

if (import.meta.main) await main();
