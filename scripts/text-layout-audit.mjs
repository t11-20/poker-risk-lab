#!/usr/bin/env node
/**
 * `pnpm run test:layout`: measures where text was painted, with `Range.getClientRects()` over each
 * element's own text nodes, on every route in both themes at five widths. Bounding boxes do not
 * overlap when a grid track collapses; the text overflows the box. That is how
 * `grid-template-columns: minmax(0, 1fr) auto` on the Coach rail shipped past every other gate.
 *
 * Findings: `collision` (glyphs of two independent in-flow elements intersect), `escapes` (glyphs
 * leave their own non-scrolling block), `clipped` (cut off by a non-scrolling ancestor without an
 * ellipsis), `squeezed` (a block narrower than its longest word), and `page` (the document scrolls
 * sideways). The page only measures. `findTextDefects()` judges in Node, so tests can feed it the
 * collapsed row's real numbers.
 *
 * Negative controls run on every invocation (`--controls-only` runs only them). Each injects CSS that
 * re-creates one defect shape and must be caught. With the real defect rebuilt into play.css the
 * sweep reported 52 findings, and the collision showed only at 1024, 1440 and 1920.
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { waitForDevtools } from './chrome-devtools.mjs';

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
  '/learn/glossary',
  '/play',
  '/play?state=decision',
  '/play?state=complete',
  '/lab',
  '/lab/fl-same-cards-under-the-gun',
  '/legends',
  '/legends/adaptive-exploiter',
  '/review',
  '/legends/hand-review/demo',
  '/terms',
  '/privacy',
  '/responsible-use',
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

/** A word must exceed its own content box by more than this to count as a collapsed column. */
const WORD_TOLERANCE = 2;

/**
 * Coverage floors, so a sweep or detector that examined nothing fails. Each is about a third of what
 * a full sweep measures today.
 */
const MIN_TEXT_BOXES_PER_PAGE = 15;
const MIN_MEASUREMENTS = 100;
const MIN_TEXT_BOXES_TOTAL = 5000;
const MIN_OWN_BOX_CHECKS = 8000;
const MIN_CLIP_TESTS = 2000;
const MIN_PAIRS_COMPARED = 8000;

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

/** @type {Control[]} */
const CONTROLS = [
  {
    id: 'coach-track',
    route: '/play?state=decision',
    width: 1440,
    expect: 'squeezed',
    what: 'the shipped Coach defect, put back: a bare `auto` track floored at max-content',
    css: '.prl-play .prl-coach__section .prl-stat__pair { grid-template-columns: minmax(0, 1fr) auto; }',
  },
  {
    id: 'coach-track-collision',
    route: '/play?state=decision',
    width: 1440,
    expect: 'collision',
    what: 'the same defect, seen as glyphs painted across a collapsed label',
    css: '.prl-play .prl-coach__section .prl-stat__pair { grid-template-columns: minmax(0, 1fr) auto; column-gap: 0; }',
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
];

// The walker measures and decides nothing. Comments inside it are part of the page script.

const WALKER = String.raw`(() => {
  const EXEMPT_SELECTORS = EXEMPT_SELECTORS_ARGUMENT;

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

  const boxes = [];
  const clippers = [];
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
    if (el.closest('[aria-hidden="true"]') !== null) {
      skipped.ariaHidden += 1;
      continue;
    }
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

    // Glyph rectangles, and the widest word, from the text nodes themselves.
    const rects = [];
    let widest = null;
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
        let wide = 0;
        for (const r of w.getClientRects()) wide = Math.max(wide, r.width);
        if (widest === null || wide > widest.width) {
          widest = { text: match[0].slice(0, 40), width: Math.round(wide * 100) / 100 };
        }
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

    const block = blockOf(el);
    const blockStyle = styleOf(block);
    const { pad, content } = boxesOf(block, blockStyle);

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

    boxes.push({
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
      scrollHost: scrollHostOf(el),
      blockScrolls: scrollsHorizontally(blockStyle),
      ellipsis: style.textOverflow === 'ellipsis' || blockStyle.textOverflow === 'ellipsis',
      exempt,
    });
  }

  const h1 = document.querySelector('h1');
  const docEl = document.documentElement;

  return {
    heading: h1 === null ? '' : (h1.textContent || '').trim().slice(0, 120).toLowerCase(),
    boxes,
    clippers,
    page: {
      scrollWidth: docEl.scrollWidth,
      clientWidth: docEl.clientWidth,
      innerWidth: window.innerWidth,
    },
    counts: { scanned, textBoxes: boxes.length, textNodes, words, clippers: clippers.length },
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

/** `measurement` is what `WALKER` returns. `context` names route, theme and width. */
export function findTextDefects(measurement, context = {}, exemptions = EXEMPTIONS) {
  const findings = [];
  const usedExemptions = new Set();
  const { boxes, clippers } = measurement;
  // What each detector looked at, floored in `coverageFailures`.
  const counts = { ownBox: 0, scrollExcused: 0, ellipsisExcused: 0, clipTests: 0, pairs: 0 };

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

  for (const box of boxes) {
    // Only the block's own overflow excuses this. The Coach rail sits inside a horizontal scroller,
    // and skipping scrolling ancestors made this blind to the 0px column.
    if (box.blockScrolls) {
      counts.scrollExcused += 1;
      continue;
    }
    counts.ownBox += 1;

    if (box.word !== null && box.word.width > box.content.w + WORD_TOLERANCE) {
      if (exemptFor(box, 'squeezed') === null) {
        add('squeezed', {
          sel: box.sel,
          text: box.text,
          word: box.word.text,
          needs: box.word.width,
          has: box.content.w,
          short: Math.round((box.word.width - box.content.w) * 100) / 100,
        });
      }
    }

    if (box.ellipsis) counts.ellipsisExcused += 1;
    else {
      const escaped = escapeAmount(box.rects, box.pad);
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
      const escaped = escapeAmount(box.rects, clipper.pad);
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

  // Sorted by top edge so the scan can exit early. The key must be the TOPMOST rect, not `rects[0]`,
  // or the early exit skips pairs and reports no collision.
  const topOf = (box) => Math.min(...box.rects.map((r) => r.y));
  const sorted = [...boxes].sort((a, b) => topOf(a) - topOf(b));
  const lowestOf = sorted.map((box) => Math.max(...box.rects.map(bottom)));
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
      for (const one of first.rects) {
        for (const two of second.rects) {
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

  const { page } = measurement;
  if (page.scrollWidth > page.clientWidth + EDGE_TOLERANCE) {
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
  const where = `${finding.route}  ${finding.theme}  ${String(finding.width)}px`;
  const quote = finding.text === '' ? '' : `  "${finding.text}"`;
  switch (finding.check) {
    case 'squeezed':
      return (
        `${where}\n      SQUEEZED   ${finding.sel}${quote}\n` +
        `      the column is ${String(finding.has)}px and the word "${finding.word}" needs ` +
        `${String(finding.needs)}px — short by ${String(finding.short)}px`
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
    --no-self-test        skip the injected negative controls (they are the gate's own proof)
    --controls-only       run ONLY the negative controls and stop

  Reporting
    --headful             run Chrome with a window, to watch it
    --out <file>          also write the findings as JSON
    -h, --help            this text

  Exits 0 when nothing collided, nothing escaped, nothing was clipped, nothing was
  squeezed, every negative control was caught and every exemption was used.
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
  if (options.themes?.some((t) => !THEMES.includes(t)) === true) {
    throw new Error(`--themes takes ${THEMES.join(' and ')}`);
  }
  if (options.controlsOnly && !options.selfTest) {
    throw new Error('--controls-only and --no-self-test together leave nothing to run');
  }
  return options;
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

/** Every condition that makes a green result meaningless, as failure lines. */
export function coverageFailures(tally, exemptions = EXEMPTIONS) {
  const problems = [];
  if (tally.measurements < MIN_MEASUREMENTS) {
    problems.push(
      `only ${String(tally.measurements)} page measurement(s) were taken; a sweep of nothing is not a pass`,
    );
  }
  if (tally.textBoxes < MIN_TEXT_BOXES_TOTAL) {
    problems.push(
      `only ${String(tally.textBoxes)} text element(s) were measured across the whole sweep; ` +
        'a sweep of nothing is not a pass',
    );
  }
  for (const [what, seen, floor] of [
    ['text blocks measured against their own box', tally.detector.ownBox, MIN_OWN_BOX_CHECKS],
    ['text blocks measured against a clipping ancestor', tally.detector.clipTests, MIN_CLIP_TESTS],
    ['pairs of text blocks compared for a collision', tally.detector.pairs, MIN_PAIRS_COMPARED],
  ]) {
    if (seen < floor) {
      problems.push(
        `only ${String(seen)} ${what} (floor ${String(floor)}) — a detector that examined nothing ` +
          'reports what a detector that found nothing reports',
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
  // Clear of ax-tree-audit's debugging-port range.
  const port = 9650 + Math.floor(process.pid % 140);
  const child = spawn(
    binary,
    [
      headful ? '--no-first-run' : '--headless=new',
      `--remote-debugging-port=${port}`,
      '--user-data-dir=/tmp/prl-text-layout-audit-profile',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${String(WIDTHS[WIDTHS.length - 1])},${String(VIEWPORT_HEIGHT)}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    const version = await waitForDevtools(child, port);
    console.log(dim(`  ${version.Browser} — ${headful ? 'headful' : 'headless'}`));

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // Motion off, so an entrance animation cannot move geometry between walk and layout. It also
    // removes the boot overlay.
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
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
 * refused (a hand-started `next start` on :3521 was measured passing this run). It connects rather
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
    `${seen} on ${host}:${String(target.port)}. --start measures a web app this run started, so it ` +
      'will not score one it did not. Stop it, pass another --base-url, or leave out --start to ' +
      'measure that server on purpose.',
  );
}

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
      try {
        const response = await fetch(this.readyUrl, { signal: AbortSignal.timeout(2000) });
        if (response.status > 0) return;
      } catch {
        // Not up yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.label} was not ready at ${this.readyUrl} within ${String(timeoutSeconds)}s:\n` +
            this.output.join(''),
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

const walkerSource = () =>
  WALKER.replace('EXEMPT_SELECTORS_ARGUMENT', JSON.stringify(EXEMPTIONS.map((rule) => rule.selector)));

let dumpCount = 0;

async function measure(page, route, theme, width) {
  await page.setWidth(width);
  // On the root element, where `tokens.css` keys its light scope.
  await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
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
  return { measurement, context: { route, theme, width } };
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
    detector: { ownBox: 0, scrollExcused: 0, ellipsisExcused: 0, clipTests: 0, pairs: 0 },
    routesLoaded: 0,
    routesWanted: 0,
  };
  const servers = [];
  let exitCode = 0;

  try {
    if (options.start) {
      await refuseOccupiedPort(options.baseUrl);
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

    await withChrome(options.headful, async (page) => {
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
  console.log(`  measurements        ${String(tally.measurements)}`);
  console.log(`  text elements       ${String(tally.textBoxes)}`);
  console.log(`  text nodes / words  ${String(tally.textNodes)} / ${String(tally.words)}`);
  console.log(`  clipping ancestors  ${String(tally.clippers)}`);
  console.log(
    `  detectors examined  ${String(tally.detector.ownBox)} block(s) against their own box, ` +
      `${String(tally.detector.clipTests)} against a clipping ancestor, ` +
      `${String(tally.detector.pairs)} pair(s) for a collision`,
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
        `${String(tally.skipped.ariaHidden)} aria-hidden, ${String(tally.skipped.invisible)} invisible, ` +
        `${String(tally.skipped.inert)} inert, ${String(tally.skipped.offscreen)} off-screen`,
    ),
  );
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
            'measurements, nothing collided, escaped, was clipped or was squeezed,\n' +
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
