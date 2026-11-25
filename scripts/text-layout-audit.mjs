#!/usr/bin/env node
/**
 * `pnpm run test:layout`: measures where text was painted, with `Range.getClientRects()` over each
 * element's own text nodes, on every route in both themes at five widths. Bounding boxes do not
 * overlap when a grid track collapses; the text overflows the box. That is how
 * `grid-template-columns: minmax(0, 1fr) auto` on the Coach rail shipped past every other gate.
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

const MIN_TEXT_BOXES_PER_PAGE = 15;

/**
 * Coverage floors per measurement asked for, so a narrow run is held to its own size. Each is about a
 * third of the leanest slice measured: 62 routes, light, 360px, 200% text averaged 141 text blocks,
 * 12.6 clip tests, 83 frame tests, 26.6 pairs and 165 break tests a page. A floor is never below one.
 */
const FLOOR_PER_MEASUREMENT = {
  textBoxes: 45,
  ownBox: 45,
  clipTests: 4,
  frameTests: 25,
  pairs: 8,
  breakTests: 50,
};

/**
 * @typedef {object} Exemption
 * @property {string} check    which finding this suppresses
 * @property {string} selector CSS selector the element must match
 * @property {string} why      the reason, in a sentence somebody can disagree with
 * @property {string[]} [also] when set, the OTHER element of a collision must match one of these
 */

/**
 * @type {Exemption[]}
 *
 * Empty because a full sweep (34,000 text elements, 150 measurements) reports nothing. Pseudo-element
 * glyphs, separate positioned layers, hidden subtrees and letter-spacing are excluded by the
 * measurement. A rule that matches nothing fails the gate, so add one only with the finding it
 * suppresses.
 */
const EXEMPTIONS = [];

/**
 * @typedef {object} Control
 * @property {string} id
 * @property {string} route
 * @property {string} expect  the check that must fire
 * @property {string} css     injected into the page after load
 * @property {string} what    what it re-creates, for the log
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

// The walker measures and decides nothing. Comments inside it are part of the page script.

const WALKER = String.raw`(() => {
  const EXEMPT_SELECTORS = EXEMPT_SELECTORS_ARGUMENT;
  const colorAlpha = COLOR_ALPHA_ARGUMENT;
  const frameSides = FRAME_SIDES_ARGUMENT;

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

  /** text-indent in px; a percentage is of the block's own inline size. */
  const indentOf = (style, width) => {
    const raw = style.textIndent;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return 0;
    return raw.trim().endsWith('%') ? (n * width) / 100 : n;
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
    return { text: word.slice(0, 40), pieces: pieces.slice(0, 80) };
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
    const indent = indentOf(blockStyle, content.w);
    const firstTop = indent === 0 ? null : firstLineTop(block);
    const preserved = preservesSpaces(style);

    // Glyph rectangles, and the widest word, from the text nodes themselves.
    const rects = [];
    const ink = [];
    const broken = [];
    let widest = null;
    let later = null;
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
        let wide = 0;
        for (const r of pieces) wide = Math.max(wide, r.width);
        const word = { text: match[0].slice(0, 40), width: Math.round(wide * 100) / 100 };
        if (firstTop !== null && pieces.length > 0) {
          word.first = pieces[0].top < firstTop + pieces[0].height / 2;
          if (!word.first && (later === null || word.width > later.width)) later = word;
        }
        if (widest === null || word.width > widest.width) widest = word;
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
      word: widest,
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
    if (indent !== 0) {
      measured.indent = Math.round(indent * 100) / 100;
      measured.later = later;
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
 * The part of a broken word that was torn one or two characters a line, or null. A token wrapped
 * across full lines is left alone however its breaks were allowed; letters stacked never are.
 * Where the browser itself splits words to fill a line (`break-all`, `hyphens: auto`), a short word
 * split at a line end is two short pieces, so there it takes three.
 */
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
  const least = fills ? 3 : 2;
  return runs.find((r) => r.length >= least && r.every((p) => [...p].length <= MAX_PIECE)) ?? null;
}

/** The widest word, or the widest beyond the first line, short of the room its own line has. */
function squeezeOf(box) {
  let worst = null;
  for (const word of [box.word, box.later]) {
    if (word === null || word === undefined) continue;
    // A negative text-indent starts the first line that far before the content box.
    const room = box.content.w - (word.first === true ? (box.indent ?? 0) : 0);
    const short = word.width - room;
    if (worst === null || short > worst.short) worst = { word, room, short };
  }
  return worst;
}

/** `measurement` is what `WALKER` returns. `context` names route, theme and width. */
export function findTextDefects(measurement, context = {}, exemptions = EXEMPTIONS) {
  const findings = [];
  const usedExemptions = new Set();
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
      if (rule.also !== undefined && otherSel !== undefined) {
        if (!rule.also.some((needle) => otherSel.includes(needle))) continue;
      }
      usedExemptions.add(index);
      return rule;
    }
    return null;
  };

  const add = (check, detail) => {
    findings.push({ check, ...context, ...detail });
  };

  // A scroller does not mend a stacked word, and aria-hidden text is still painted.
  for (const box of [...boxes, ...ariaHidden]) {
    if (!Array.isArray(box.broken)) continue;
    counts.breakTests += 1;
    for (const word of box.broken) {
      const torn = letterByLetter(word.pieces, box.fills === true);
      if (torn === null) continue;
      if (exemptFor(box, 'broken') !== null) break;
      add('broken', {
        sel: box.sel,
        text: box.text,
        word: word.text,
        pieces: word.pieces,
        ariaHidden: ariaHidden.includes(box),
      });
      break;
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

  return { findings, usedExemptions: [...usedExemptions], counts };
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
    case 'broken':
      return (
        `${where}\n      BROKEN     ${finding.sel}${quote}${finding.ariaHidden ? ' (aria-hidden)' : ''}\n` +
        `      the word "${finding.word}" is torn over ${String(finding.pieces.length)} lines: ` +
        `${finding.pieces.slice(0, 12).join(' | ')}`
      );
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
  out: null,
};

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
    --routes <a,b>        sweep only these routes          (default: all ${String(ROUTES.length)})
    --widths <n,n>        sweep only these widths          (default ${WIDTHS.join(',')})
    --themes <a,b>        sweep only these themes          (default ${THEMES.join(',')})
    --text-scale <n>      the reader's text size, as Chrome's own setting: 2 is 32px text
                          (1 to 3 in sixteenths, so the sizes Chrome takes stay whole; default 1)
    --no-self-test        skip the injected negative controls (they are the gate's own proof)
    --controls-only       run ONLY the negative controls and stop

  Reporting
    --headful             run Chrome with a window, to watch it
    --out <file>          also write the findings as JSON
    -h, --help            this text

  Exits 0 when nothing collided, escaped, was clipped, spilled past a drawn frame,
  was squeezed or was broken letter by letter, every negative control was caught and
  every exemption was used.
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

export function sweepMatrix(options) {
  const routes = options.routes ?? ROUTES;
  const themes = options.themes ?? THEMES;
  const widths = options.widths ?? WIDTHS;
  const out = [];
  for (const route of routes) {
    for (const theme of themes) {
      for (const width of widths) out.push({ route, theme, width });
    }
  }
  return out;
}

/** The floor for `key` in a run that asked for `wanted` measurements: never below one. */
export function coverageFloor(key, wanted) {
  return Math.max(1, Math.floor(FLOOR_PER_MEASUREMENT[key] * wanted));
}

/** Every condition that makes a green result meaningless, as failure lines. */
export function coverageFailures(tally, exemptions = EXEMPTIONS) {
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
  const textFloor = coverageFloor('textBoxes', wanted);
  if (tally.textBoxes < textFloor) {
    problems.push(
      `only ${String(tally.textBoxes)} text element(s) were measured across the whole sweep ` +
        `(floor ${String(textFloor)} ${per}); a sweep of nothing is not a pass`,
    );
  }
  for (const [what, key] of [
    ['text blocks measured against their own box', 'ownBox'],
    ['text blocks measured against a clipping ancestor', 'clipTests'],
    ['text blocks measured against the frame drawn around them', 'frameTests'],
    ['pairs of text blocks compared for a collision', 'pairs'],
    ['text blocks whose words were checked for a break letter by letter', 'breakTests'],
  ]) {
    const seen = tally.detector[key] ?? 0;
    const floor = coverageFloor(key, wanted);
    if (seen < floor) {
      problems.push(
        `only ${String(seen)} ${what} (floor ${String(floor)} ${per}) — a detector that examined ` +
          'nothing reports what a detector that found nothing reports',
      );
    }
  }
  if (tally.routesLoaded < (tally.routesWanted ?? 0)) {
    problems.push(
      `${String((tally.routesWanted ?? 0) - tally.routesLoaded)} route(s) never loaded, so nothing was measured on them`,
    );
  }
  for (let i = 0; i < exemptions.length; i += 1) {
    if (!tally.usedExemptions.has(i)) {
      problems.push(
        `exemption ${String(i)} (${exemptions[i].check} ${exemptions[i].selector}) matched nothing ` +
          'in the whole sweep — a stale exemption is a hole that looks like a decision',
      );
    }
  }
  return problems;
}

class Page {
  textScale = 1;
  /** How the text size was applied: Chrome's setting, or an inline root size when Chrome refused it. */
  textSizeMethod = 'Page.setFontSizes';
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

async function withPage(headful, textScale, run) {
  const chrome = {
    headful,
    // Clear of ax-tree-audit's debugging-port range. The overrides let a second run beside the gate keep
    // off its port and its profile, which one Chrome locks.
    port: Number(process.env.PRL_LAYOUT_CDP_PORT ?? 9650 + Math.floor(process.pid % 140)),
    profile: process.env.PRL_LAYOUT_PROFILE ?? '/tmp/prl-text-layout-audit-profile',
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
    // Sent at 1 too, so a size left over in a reused profile is reset rather than measured.
    page.textScale = textScale;
    await page.send('Page.setFontSizes', { fontSizes: fontSizesFor(textScale) }).catch((error) => {
      page.textSizeMethod = 'inline root font-size';
      console.log(
        red(`  Chrome refused Page.setFontSizes (${error.message}); falling back to an inline root`),
      );
      console.log(red('  font-size, which moves no em media query and so is not the reader setting.'));
    });
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
    .replace('FRAME_SIDES_ARGUMENT', () => String(frameSides));

let dumpCount = 0;

async function measure(page, route, theme, width) {
  await page.setWidth(width);
  // On the root element, where `tokens.css` keys its light scope.
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
  if (page.textSizeMethod !== 'Page.setFontSizes') {
    await page.evaluate(`document.documentElement.style.fontSize = '${String(page.textScale * 100)}%'`);
  }
  await delay(180);
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
async function injectControl(page, css) {
  const applied = await page.evaluate(
    `(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(${JSON.stringify(css)});
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      return sheet.cssRules.length;
    })()`,
  );
  if (applied === 0) throw new Error(`a negative control's stylesheet parsed to no rules: ${css}`);
  await delay(250);
}

/** Each control returns whether it was caught and the measurement, so a pass prints its evidence. */
async function runControls(page, baseUrl) {
  const results = [];
  for (const control of CONTROLS) {
    await page.goto(`${baseUrl}${control.route}`);
    await injectControl(page, control.css);
    const { measurement, context } = await measure(page, control.route, 'dark', control.width);
    const { findings } = findTextDefects(measurement, context);
    const caught = findings.filter((finding) => finding.check === control.expect);
    results.push({
      id: control.id,
      what: control.what,
      expect: control.expect,
      route: control.route,
      width: control.width,
      caught: caught.length > 0,
      evidence: caught.slice(0, 2),
      textBoxes: measurement.counts.textBoxes,
    });
  }
  return results;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
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

  const matrix = sweepMatrix(options);
  const failures = [];
  const findings = [];
  const controlResults = [];
  const tally = {
    measurements: 0,
    textBoxes: 0,
    textNodes: 0,
    words: 0,
    clippers: 0,
    skipped: { ariaHidden: 0, visuallyHidden: 0, invisible: 0, offscreen: 0, inert: 0 },
    usedExemptions: new Set(),
    detector: {
      ownBox: 0,
      scrollExcused: 0,
      ellipsisExcused: 0,
      clipTests: 0,
      frameTests: 0,
      pairs: 0,
      breakTests: 0,
    },
    measurementsWanted: matrix.length,
    routesLoaded: 0,
    routesWanted: 0,
    textSize: { scale: options.textScale, method: 'not applied' },
  };
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

    await withPage(options.headful, options.textScale, async (page) => {
      tally.textSize.method = page.textSizeMethod;
      if (options.selfTest) {
        console.log(bold('\nNegative controls — a defect of each shape, put back into a real page'));
        for (const result of await runControls(page, options.baseUrl)) {
          controlResults.push(result);
          const head = `  ${result.caught ? green('CAUGHT ') : red('MISSED ')} ${result.expect.padEnd(9)} ${result.id}`;
          console.log(`${head}  ${dim(result.what)}`);
          console.log(
            dim(
              `      ${result.route} at ${String(result.width)}px, ${String(result.textBoxes)} text elements`,
            ),
          );
          if (result.caught) {
            for (const line of result.evidence.slice(0, 1)) {
              console.log(dim(`      ${formatFinding(line).split('\n').slice(1).join('\n      ').trim()}`));
            }
          } else {
            failures.push(
              `negative control "${result.id}" was NOT caught: ${result.what} produced no ` +
                `${result.expect} finding on ${result.route} at ${String(result.width)}px`,
            );
          }
        }
      }

      if (options.controlsOnly) return;

      console.log(
        bold(
          `\nSweep — ${String((options.routes ?? ROUTES).length)} route(s) x ` +
            `${String((options.themes ?? THEMES).length)} theme(s) x ` +
            `${String((options.widths ?? WIDTHS).length)} width(s) = ${String(matrix.length)} measurements`,
        ),
      );

      const routes = options.routes ?? ROUTES;
      const themes = options.themes ?? THEMES;
      const widths = options.widths ?? WIDTHS;
      tally.routesWanted = routes.length * themes.length;

      for (const route of routes) {
        const perRoute = [];
        for (const theme of themes) {
          try {
            await page.goto(`${options.baseUrl}${route}`);
          } catch (error) {
            failures.push(
              `${route} (${theme}) did not load: ${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          let loaded = true;
          for (const width of widths) {
            const { measurement, context } = await measure(page, route, theme, width);
            const heading = measurement.heading;
            if (ERROR_BOUNDARY_HEADINGS.some((boundary) => heading.startsWith(boundary))) {
              failures.push(
                `${route} (${theme}, ${String(width)}px) rendered an error boundary ("${heading}") — ` +
                  'nothing on it was measured',
              );
              loaded = false;
              break;
            }
            if (measurement.counts.textBoxes < MIN_TEXT_BOXES_PER_PAGE) {
              failures.push(
                `${route} (${theme}, ${String(width)}px) produced only ` +
                  `${String(measurement.counts.textBoxes)} text element(s) — that is not a page`,
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
            for (const index of result.usedExemptions) tally.usedExemptions.add(index);
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
    });
  } catch (error) {
    failures.push(
      `the painted text could not be measured: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    for (const server of servers) server.stop();
  }

  if (!options.controlsOnly) {
    for (const problem of coverageFailures(tally)) failures.push(problem);
  }

  const byCheck = new Map();
  for (const finding of findings) {
    byCheck.set(finding.check, (byCheck.get(finding.check) ?? 0) + 1);
  }

  console.log(bold('\nSummary'));
  console.log(
    `  text size           ${String(tally.textSize.scale * 100)}% ` +
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
      `${String(tally.detector.breakTests)} for a word broken letter by letter`,
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
  console.log(
    `  negative controls   ${String(controlResults.filter((r) => r.caught).length)}/${String(controlResults.length)} caught`,
  );
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
          .map((f) => `${f.route} ${f.theme} ${String(f.width)}px`)
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
          matrix: {
            routes: options.routes ?? ROUTES,
            themes: options.themes ?? THEMES,
            widths: options.widths ?? WIDTHS,
            textScale: options.textScale,
          },
          tally: { ...tally, usedExemptions: [...tally.usedExemptions] },
          exemptions: EXEMPTIONS,
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

  if (exitCode === 0) {
    console.log(
      green(
        bold(
          `\nPASS — ${String(tally.textBoxes)} painted text elements over ${String(tally.measurements)} ` +
            'measurements, nothing collided, escaped, was clipped, spilled, was squeezed or broken,\n' +
            `and all ${String(controlResults.length)} negative controls were caught.`,
        ),
      ),
    );
  } else {
    console.log(red(bold('\nFAIL')));
  }
  console.log(
    dim(
      '\n  Caveat: this measures the RESTING page at five widths in two themes. It has no opinion\n' +
        '  about whether the layout is good, and it sees no hover, focus or open state, and no\n' +
        '  animation mid-flight.\n',
    ),
  );

  process.exit(exitCode);
}

export { CONTROLS, EXEMPTIONS, ROUTES, THEMES, WIDTHS };

if (import.meta.main) await main();
