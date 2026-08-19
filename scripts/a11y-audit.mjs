#!/usr/bin/env node
/**
 * A STATIC accessibility audit of the server-rendered HTML of the web app.
 *
 * This is what `pnpm run test:a11y` does. Read the coverage section before you
 * trust it, and read the limitations section before you tell anyone the app is
 * accessible.
 *
 * ## What this is, precisely
 *
 * axe-core 4.13.0 is a devDependency of this repo and it is used here — but NOT by
 * calling `axe.run()`. `axe.run()` requires a live DOM: given plain Node it throws
 *
 *     Required "window" or "document" globals not defined and cannot be deduced
 *     from the context.
 *
 * Supplying a DOM faithful enough for axe to be correct means jsdom or a headless
 * browser, and neither is available — adding one is release-blocking in this repo,
 * and a half-built fake DOM is worse than no DOM at all: axe's checks would run
 * against an environment where `getComputedStyle` lies, silently return "pass" for
 * rules that depend on layout and visibility, and produce a report that reads like
 * a full audit while having tested almost nothing.
 *
 * So this file does two honest things instead:
 *
 *   1. It parses the server-rendered HTML with a small tolerant parser and applies
 *      a fixed set of checks that CAN be decided from markup alone.
 *
 *   2. It gets its facts from axe-core rather than from a hand-written table. The
 *      rule ids, descriptions and help URLs come from `axe.getRules()`, and the
 *      ARIA logic comes from `axe.commons.aria.lookupTable` — the same 120-role,
 *      49-attribute standards tables axe itself uses, including which aria-*
 *      attributes each role allows, which it requires, each attribute's value type
 *      and permitted values, and the implicit-role mapping for HTML elements. Both
 *      are available in plain Node with no DOM. That means when axe-core is
 *      upgraded, the ARIA rules here move with it instead of quietly going stale.
 *
 * Every finding therefore cites a real axe rule id and a real Deque help URL, and
 * every finding is one this script actually decided for itself.
 *
 * ## What IS checked (rule ids are axe-core's)
 *
 *   html-has-lang, html-lang-valid       a lang attribute, and its shape
 *   document-title                       a non-empty <title>
 *   meta-viewport                        zoom not disabled
 *   image-alt, input-image-alt, area-alt alternative text
 *   frame-title                          iframes named
 *   label                                form controls have an accessible name
 *   button-name, link-name, select-name  controls have an accessible name
 *   heading-order, page-has-heading-one, empty-heading
 *   duplicate-id-aria                    ids referenced by ARIA/labels are unique
 *   tabindex                             no positive tabindex
 *   landmark-one-main, landmark-unique   landmark structure
 *   list, definition-list                list markup nesting
 *   aria-roles                           role values exist
 *   aria-valid-attr                      aria-* names exist
 *   aria-allowed-attr                    aria-* allowed for the element's role
 *   aria-valid-attr-value                aria-* values match their declared type
 *   aria-required-attr                   explicit roles carry their required aria-*
 *   aria-hidden-focus                    aria-hidden subtrees contain no tabbables
 *   presentation-role-conflict           role=presentation with conflicting ARIA
 *
 * ## What is NOT checked — a browser-based run is required for all of it
 *
 *   - Colour contrast (`color-contrast`). Needs computed styles. Not attempted.
 *   - Anything decided by CSS: visibility, display:none subtrees, off-screen or
 *     clipped text, reading order, reflow, target size, focus indicators.
 *   - Keyboard operability, focus order and focus management.
 *   - Anything rendered or changed by client-side JavaScript. Routes are audited
 *     exactly as the server delivered them, so a control that only exists after
 *     hydration is invisible to this script.
 *   - Full accessible-name computation. The implementation here handles
 *     aria-labelledby, aria-label, <label>, alt, title and text content. It does
 *     not handle CSS generated content, or the full recursion and traversal rules
 *     of accname 1.2. A name it reports as missing is very likely missing; a name
 *     it accepts is not proof that a screen reader announces something useful.
 *   - ARIA required-owned and required-context relationships (`aria-required-children`,
 *     `aria-required-parent`), nested interactive controls, table header
 *     association, and role/element validity (`aria-allowed-role`).
 *   - Live regions, motion, timing, media captions.
 *   - Elements whose ARIA role cannot be determined from markup alone (`<td>`,
 *     `<th>`, custom elements). These are counted and reported as unchecked rather
 *     than guessed at, because a guessed role produces confident false positives.
 *
 * A passing run here means "no violation of the subset above was found in the
 * delivered HTML". It does not mean the app is accessible.
 *
 * The keyboard half of what this file cannot do is now covered:
 * `scripts/keyboard-audit.mjs` (`pnpm run test:keyboard`) drives real Chrome over the
 * DevTools Protocol and presses real Tab, Enter, Escape and arrow keys — focus order,
 * focus visibility, keyboard traps, the modal sheet, the bet-size slider, and a whole
 * hand folded from the keyboard at a live table. What remains outside both scripts is a
 * screen-reader pass and a browser-based axe run.
 *
 * ## Route discovery
 *
 * Rather than hard-code a route list that silently rots, the audit starts at the
 * seed routes (`--routes`, default `/`) and follows same-origin links found in the
 * delivered HTML, up to `--max-routes`. So the set audited is the set the app
 * actually links to. A route that does not return 2xx fails the run instead of
 * being audited, because auditing an error page produces both false findings and
 * false confidence.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);

// ---------------------------------------------------------------------------
// axe-core: rule metadata and the ARIA standards tables
// ---------------------------------------------------------------------------

/**
 * axe-core loads in plain Node — it guards its own DOM access at import time. Only
 * `axe.run()` needs a document, and this file never calls it.
 */
const axe = require('axe-core');
const ARIA = axe.commons.aria;
const LOOKUP = ARIA.lookupTable;

/** ruleId -> { description, help, helpUrl, tags }. */
const AXE_RULES = new Map(axe.getRules().map((rule) => [rule.ruleId, rule]));

/** Fails loudly if a rule id cited below has been renamed by an axe upgrade. */
function rule(ruleId) {
  const found = AXE_RULES.get(ruleId);
  if (found === undefined) {
    throw new Error(
      `axe-core ${axe.version} has no rule "${ruleId}". A rule was renamed or removed; ` +
        'update the check that cites it rather than inventing a rule id.',
    );
  }
  return found;
}

/** 'wcag' when a rule maps to a WCAG success criterion, else 'best-practice'. */
function severityOf(ruleId) {
  return rule(ruleId).tags.some((tag) => tag.startsWith('wcag2')) ? 'wcag' : 'best-practice';
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:3000',
  apiUrl: 'http://127.0.0.1:3001',
  routes: ['/'],
  maxRoutes: 12,
  crawlDepth: 1,
  start: true,
  withApi: false,
  wcagOnly: false,
  readyTimeoutSeconds: 120,
  requestTimeoutSeconds: 20,
  out: null,
};

const HELP = `
${bold('pnpm run test:a11y')} — static accessibility audit of the delivered HTML

  ${yellow('This is a STATIC audit of server-rendered markup, not a browser run.')}
  ${yellow('It cannot check colour contrast, focus order, or anything CSS or JS decides.')}
  The file header lists exactly which axe rules are and are not covered.

  Server
    --base-url <url>      web app origin                 (default ${DEFAULTS.baseUrl})
    --api-url <url>       API origin                     (default ${DEFAULTS.apiUrl})
    --no-start            audit an already-running server instead of starting one
    --with-api            also start the API (pages that call it render properly)
    --ready-timeout <s>   how long to wait for a server  (default ${DEFAULTS.readyTimeoutSeconds})

  Routes
    --routes <a,b,c>      seed routes                    (default ${DEFAULTS.routes.join(',')})
    --max-routes <n>      cap on routes audited          (default ${DEFAULTS.maxRoutes})
    --crawl-depth <n>     link-following depth, 0 = none (default ${DEFAULTS.crawlDepth})

  Reporting
    --wcag-only           ignore best-practice rules, fail only on WCAG-mapped ones
    --out <file>          also write the report as JSON
    -h, --help            this text

  Exits non-zero on any violation, and on any route that does not return 2xx.
`;

function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run test:a11y -- --with-api` passes the `--` through to the script
    // rather than swallowing it, so the conventional invocation would otherwise
    // die on "unknown option --". Absorbing it here means both
    // `pnpm run test:a11y --with-api` and the `--` form work.
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
      case '--no-start':
        options.start = false;
        break;
      case '--with-api':
        options.withApi = true;
        break;
      case '--wcag-only':
        options.wcagOnly = true;
        break;
      case '--base-url':
        options.baseUrl = need();
        break;
      case '--api-url':
        options.apiUrl = need();
        break;
      case '--out':
        options.out = need();
        break;
      case '--routes':
        options.routes = need()
          .split(',')
          .map((route) => route.trim())
          .filter((route) => route.length > 0);
        break;
      case '--max-routes':
        options.maxRoutes = Number(need());
        break;
      case '--crawl-depth':
        options.crawlDepth = Number(need());
        break;
      case '--ready-timeout':
        options.readyTimeoutSeconds = Number(need());
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (options.routes.length === 0) throw new Error('--routes needs at least one route');
  if (!Number.isInteger(options.maxRoutes) || options.maxRoutes < 1) {
    throw new Error('--max-routes must be a positive integer');
  }
  if (!Number.isInteger(options.crawlDepth) || options.crawlDepth < 0) {
    throw new Error('--crawl-depth must be 0 or more');
  }
  return options;
}

// ===========================================================================
// HTML parser
//
// Tolerant on purpose: it must produce a usable tree from whatever the server
// sent, including markup this audit is about to complain about. It implements the
// parts of the HTML tree-construction algorithm that change the ANSWERS here —
// void elements, raw-text elements, and the implied end tags that decide whether
// an <li> is a child of its <ul> — and nothing else. It is not a conforming HTML
// parser and does not try to be; where it differs from a browser, it differs by
// keeping elements where the author wrote them.
// ===========================================================================

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** Content is text, not markup, until the matching end tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/**
 * Implied end tags: which open element a start tag closes.
 *
 * Without these, `<ul><li>a<li>b</ul>` parses as an li nested inside an li, and
 * the `list` check reports a violation that a browser would never see. This is the
 * single place where being sloppy about parsing would produce wrong findings, so it
 * is the one place the real algorithm is followed.
 */
const CLOSES_ON_START = new Map([
  ['li', new Set(['li'])],
  ['dt', new Set(['dt', 'dd'])],
  ['dd', new Set(['dt', 'dd'])],
  ['option', new Set(['option'])],
  ['optgroup', new Set(['optgroup', 'option'])],
  ['tr', new Set(['tr', 'td', 'th'])],
  ['td', new Set(['td', 'th'])],
  ['th', new Set(['td', 'th'])],
  ['thead', new Set(['tbody', 'tfoot', 'tr', 'td', 'th'])],
  ['tbody', new Set(['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])],
  ['tfoot', new Set(['thead', 'tbody', 'tr', 'td', 'th'])],
]);

/** A start tag in this set closes an open <p>. */
const CLOSES_PARAGRAPH = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'details',
  'div',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'main',
  'menu',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

const NAME_START = /[a-zA-Z]/;
const NAME_CHAR = /[^\s/>]/;

function decodeEntities(text) {
  // Only the handful that change whether text is empty or what an id looks like.
  // A full entity table is not needed to decide any check here, and pretending to
  // have one would be a lie in the other direction.
  if (!text.includes('&')) return text;
  return text
    .replace(/&(#x[0-9a-fA-F]+|#\d+);/g, (whole, code) => {
      const value =
        code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : whole;
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (whole, name) => {
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
      return map[name] ?? whole;
    });
}

function parseHtml(html) {
  const root = { type: 'root', name: '#root', attrs: new Map(), children: [], parent: null, start: 0 };
  const stack = [root];
  const top = () => stack[stack.length - 1];

  const addText = (value, start) => {
    if (value.length === 0) return;
    top().children.push({ type: 'text', value: decodeEntities(value), parent: top(), start });
  };

  /** Pops until `name` is closed. A stray end tag with no open element is dropped. */
  const closeTag = (name) => {
    for (let depth = stack.length - 1; depth > 0; depth--) {
      if (stack[depth].name === name) {
        stack.length = depth;
        return;
      }
    }
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      addText(html.slice(i), i);
      break;
    }
    if (lt > i) addText(html.slice(i, lt), i);

    // --- comment / doctype / processing instruction ---
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt + 2);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    // --- end tag ---
    if (html.startsWith('</', lt)) {
      let cursor = lt + 2;
      let name = '';
      while (cursor < html.length && NAME_CHAR.test(html[cursor])) name += html[cursor++];
      const end = html.indexOf('>', cursor);
      i = end === -1 ? html.length : end + 1;
      if (name.length > 0) closeTag(name.toLowerCase());
      continue;
    }

    // Not a tag at all — a bare "<" in text.
    if (!NAME_START.test(html[lt + 1] ?? '')) {
      addText('<', lt);
      i = lt + 1;
      continue;
    }

    // --- start tag ---
    let cursor = lt + 1;
    let name = '';
    while (cursor < html.length && NAME_CHAR.test(html[cursor])) name += html[cursor++];
    name = name.toLowerCase();

    const attrs = new Map();
    let selfClosing = false;
    while (cursor < html.length) {
      while (cursor < html.length && /\s/.test(html[cursor])) cursor++;
      if (html[cursor] === '/') {
        selfClosing = true;
        cursor++;
        continue;
      }
      if (html[cursor] === '>' || cursor >= html.length) break;
      let attrName = '';
      while (cursor < html.length && !/[\s=/>]/.test(html[cursor])) attrName += html[cursor++];
      if (attrName.length === 0) {
        cursor++;
        continue;
      }
      while (cursor < html.length && /\s/.test(html[cursor])) cursor++;
      let attrValue = '';
      if (html[cursor] === '=') {
        cursor++;
        while (cursor < html.length && /\s/.test(html[cursor])) cursor++;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          cursor++;
          const close = html.indexOf(quote, cursor);
          attrValue = close === -1 ? html.slice(cursor) : html.slice(cursor, close);
          cursor = close === -1 ? html.length : close + 1;
        } else {
          while (cursor < html.length && !/[\s>]/.test(html[cursor])) attrValue += html[cursor++];
        }
      }
      // First occurrence wins, which is what browsers do with a duplicated attribute.
      const lower = attrName.toLowerCase();
      if (!attrs.has(lower)) attrs.set(lower, decodeEntities(attrValue));
    }
    const tagEnd = html.indexOf('>', cursor);
    i = tagEnd === -1 ? html.length : tagEnd + 1;

    // Implied end tags before the element is inserted.
    const closes = CLOSES_ON_START.get(name);
    if (closes?.has(top().name)) closeTag(top().name);
    if (CLOSES_PARAGRAPH.has(name) && top().name === 'p') closeTag('p');

    const element = { type: 'element', name, attrs, children: [], parent: top(), start: lt };
    top().children.push(element);

    if (VOID_ELEMENTS.has(name) || selfClosing) continue;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      // Find the matching end tag without interpreting anything in between: a "<"
      // inside a script is not markup, and treating it as markup is how naive
      // parsers produce a tree with half the page inside a <script>.
      const pattern = new RegExp(`</${name}\\s*>`, 'i');
      const rest = html.slice(i);
      const match = pattern.exec(rest);
      const text = match === null ? rest : rest.slice(0, match.index);
      if (text.length > 0) {
        element.children.push({ type: 'text', value: decodeEntities(text), parent: element, start: i });
      }
      i = match === null ? html.length : i + match.index + match[0].length;
      continue;
    }

    stack.push(element);
  }

  return root;
}

/** Byte offset -> 1-based line number, so findings point at a place in the file. */
function lineIndex(html) {
  const offsets = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === '\n') offsets.push(i + 1);
  return (offset) => {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (offsets[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

// ===========================================================================
// Tree helpers
// ===========================================================================

function* walk(node) {
  for (const child of node.children ?? []) {
    if (child.type === 'element') {
      yield child;
      yield* walk(child);
    }
  }
}

const elementsOf = (root) => [...walk(root)];

const attr = (element, name) => element.attrs.get(name) ?? null;
const hasAttr = (element, name) => element.attrs.has(name);

function ancestors(element) {
  const chain = [];
  let current = element.parent;
  while (current !== null && current.type === 'element') {
    chain.push(current);
    current = current.parent;
  }
  return chain;
}

/** True when this element or an ancestor is aria-hidden="true". */
function inAriaHidden(element) {
  if (attr(element, 'aria-hidden') === 'true') return true;
  return ancestors(element).some((a) => attr(a, 'aria-hidden') === 'true');
}

/**
 * Text content for name-from-contents.
 *
 * Skips script/style and aria-hidden subtrees, and folds in the alt text of
 * descendant images — an anchor whose only content is `<img alt="Home">` is named
 * "Home", and a check that ignored that would report a violation on correct markup.
 */
function textContent(element) {
  let out = '';
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (child.type === 'text') {
        out += child.value;
        continue;
      }
      if (child.type !== 'element') continue;
      if (child.name === 'script' || child.name === 'style') continue;
      if (attr(child, 'aria-hidden') === 'true') continue;
      if (child.name === 'img' || child.name === 'area') {
        out += ` ${attr(child, 'alt') ?? ''} `;
        continue;
      }
      if (child.name === 'input' && (attr(child, 'type') ?? '').toLowerCase() === 'image') {
        out += ` ${attr(child, 'alt') ?? ''} `;
        continue;
      }
      visit(child);
    }
  };
  visit(element);
  return out.replace(/\s+/g, ' ').trim();
}

/** The single short snippet shown with a finding. Long tags are truncated. */
function snippet(element) {
  const parts = [element.name];
  for (const [name, value] of element.attrs) {
    parts.push(value === '' ? name : `${name}="${value.length > 40 ? `${value.slice(0, 40)}...` : value}"`);
  }
  const text = `<${parts.join(' ')}>`;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

// ===========================================================================
// Roles
// ===========================================================================

/**
 * Implicit roles that axe resolves with element-specific logic rather than from its
 * flat `implicitHtmlRole` table (which covers only unconditional mappings).
 *
 * Everything here is straight from HTML-AAM. Anything genuinely
 * context-dependent is resolved from the tree below, or returned as `undetermined`
 * so that role-dependent checks skip the element instead of guessing.
 */
const INPUT_TYPE_ROLES = new Map([
  ['button', 'button'],
  ['checkbox', 'checkbox'],
  ['email', 'textbox'],
  ['image', 'button'],
  ['number', 'spinbutton'],
  ['radio', 'radio'],
  ['range', 'slider'],
  ['reset', 'button'],
  ['search', 'searchbox'],
  ['submit', 'button'],
  ['tel', 'textbox'],
  ['text', 'textbox'],
  ['url', 'textbox'],
  // color, date, datetime-local, file, month, password, time, week and hidden have
  // no ARIA role mapping. They are `undetermined` rather than guessed.
]);

/** Landmark roles, for the landmark checks. */
const LANDMARK_ROLES = new Set([
  'banner',
  'complementary',
  'contentinfo',
  'form',
  'main',
  'navigation',
  'region',
  'search',
]);

/** Elements that scope <header>/<footer> out of banner/contentinfo. */
const SECTIONING = new Set(['article', 'aside', 'main', 'nav', 'section']);

/**
 * The element's role, or `undetermined` when markup alone cannot decide it.
 *
 * `undetermined` is load-bearing: `aria-allowed-attr` compares against the role's
 * allowed list, so an unknown role would mean "globals only" and would flag
 * perfectly valid ARIA on any element this script does not model. Returning
 * `undetermined` makes those elements visibly unchecked instead.
 */
/**
 * Roles that are real in ARIA 1.2 but absent from axe 4.13's `lookupTable.role`,
 * and which support only the global ARIA attributes.
 *
 * `generic` is the one that matters: `axe.commons.aria.isValidRole('generic')`
 * returns false, so without this an author who correctly writes `role="generic"`
 * would be told it is not a role. It is also the resolved role for div, span and p
 * below, and treating an unlisted role as "no information" would mean
 * `aria-allowed-attr` never fired on the most common elements on the page — a
 * silent hole in the check that looks exactly like a pass.
 */
const GLOBALS_ONLY_ROLES = new Set(['generic']);

function roleOf(element) {
  const explicit = attr(element, 'role');
  if (explicit !== null) {
    // A role attribute is a space-separated fallback list; the first valid token wins.
    for (const token of explicit.trim().split(/\s+/)) {
      const lower = token.toLowerCase();
      if (ARIA.isValidRole(lower) || GLOBALS_ONLY_ROLES.has(lower)) {
        return { role: lower, explicit: true };
      }
    }
    return { role: null, explicit: true, invalid: explicit };
  }

  const name = element.name;
  if (name === 'a' || name === 'area') {
    return { role: hasAttr(element, 'href') ? 'link' : 'generic', explicit: false };
  }
  if (name === 'img') {
    const alt = attr(element, 'alt');
    if (alt === '') return { role: 'presentation', explicit: false };
    return { role: 'img', explicit: false };
  }
  if (name === 'input') {
    const type = (attr(element, 'type') ?? 'text').toLowerCase();
    if (type === 'hidden') return { role: 'none', explicit: false };
    const mapped = INPUT_TYPE_ROLES.get(type);
    return mapped === undefined
      ? { role: 'undetermined', explicit: false }
      : { role: mapped, explicit: false };
  }
  if (name === 'select') {
    // combobox unless it is a multi-select or shows more than one row.
    const size = Number(attr(element, 'size') ?? '0');
    const multiple = hasAttr(element, 'multiple');
    return { role: multiple || size > 1 ? 'listbox' : 'combobox', explicit: false };
  }
  if (name === 'form') return { role: 'form', explicit: false };
  if (name === 'aside') return { role: 'complementary', explicit: false };
  if (name === 'header' || name === 'footer') {
    const scoped = ancestors(element).some((a) => SECTIONING.has(a.name));
    if (scoped) return { role: 'generic', explicit: false };
    return { role: name === 'header' ? 'banner' : 'contentinfo', explicit: false };
  }
  if (name === 'section') {
    // A <section> is a region only when it has an accessible name.
    const named = attr(element, 'aria-label') !== null || attr(element, 'aria-labelledby') !== null;
    return { role: named ? 'region' : 'generic', explicit: false };
  }
  if (name === 'div' || name === 'span' || name === 'p') return { role: 'generic', explicit: false };
  if (name === 'td' || name === 'th' || name === 'caption') {
    // Depends on the containing table's role. Not modelled.
    return { role: 'undetermined', explicit: false };
  }

  const implicit = LOOKUP.implicitHtmlRole[name];
  if (typeof implicit === 'string') return { role: implicit, explicit: false };
  return { role: 'undetermined', explicit: false };
}

/**
 * Accessible name, in precedence order, for the subset of accname this can do.
 *
 * Deliberately NOT the full algorithm — see the limitations in the file header.
 */
function accessibleName(element, byId) {
  const labelledby = attr(element, 'aria-labelledby');
  if (labelledby !== null) {
    const names = labelledby
      .trim()
      .split(/\s+/)
      .map((id) => {
        const target = byId.get(id);
        return target === undefined ? '' : textContent(target) || attr(target, 'value') || '';
      })
      .filter((text) => text.length > 0);
    if (names.length > 0) return names.join(' ');
  }

  const label = attr(element, 'aria-label');
  if (label !== null && label.trim().length > 0) return label.trim();

  if (element.name === 'img' || element.name === 'area') {
    const alt = attr(element, 'alt');
    if (alt !== null && alt.trim().length > 0) return alt.trim();
  }
  if (element.name === 'input') {
    const type = (attr(element, 'type') ?? 'text').toLowerCase();
    if (type === 'image') {
      const alt = attr(element, 'alt');
      if (alt !== null && alt.trim().length > 0) return alt.trim();
    }
    if (type === 'submit' || type === 'reset') {
      const value = attr(element, 'value');
      if (value !== null && value.trim().length > 0) return value.trim();
      // The browser supplies "Submit"/"Reset" when there is no value.
      return type === 'submit' ? 'Submit' : 'Reset';
    }
    if (type === 'button') {
      const value = attr(element, 'value');
      if (value !== null && value.trim().length > 0) return value.trim();
    }
  }

  // A <label for> pointing here, or a <label> wrapping this control.
  const id = attr(element, 'id');
  if (id !== null) {
    const forLabel = byId.labelsFor?.get(id);
    if (forLabel !== undefined) {
      const text = textContent(forLabel);
      if (text.length > 0) return text;
    }
  }
  const wrapping = ancestors(element).find((a) => a.name === 'label');
  if (wrapping !== undefined) {
    const text = textContent(wrapping);
    if (text.length > 0) return text;
  }

  const title = attr(element, 'title');
  if (title !== null && title.trim().length > 0) return title.trim();

  // Name from contents, for the roles that allow it.
  const { role } = roleOf(element);
  const spec = role === null || role === 'undetermined' ? null : LOOKUP.role[role];
  if (
    spec !== null &&
    spec !== undefined &&
    Array.isArray(spec.nameFrom) &&
    spec.nameFrom.includes('contents')
  ) {
    const text = textContent(element);
    if (text.length > 0) return text;
  }
  return null;
}

/**
 * Focusable-by-keyboard, as far as markup can tell.
 *
 * `disabled` and a negative tabindex remove an element from the tab order.
 * Anything CSS does about it is invisible here, which is why aria-hidden-focus is
 * a static approximation.
 */
function isTabbable(element) {
  const tabindex = attr(element, 'tabindex');
  if (tabindex !== null) {
    const value = Number(tabindex);
    if (Number.isFinite(value)) return value >= 0;
  }
  if (hasAttr(element, 'disabled')) return false;
  if (element.name === 'a' || element.name === 'area') return hasAttr(element, 'href');
  if (['button', 'select', 'textarea', 'summary'].includes(element.name)) return true;
  if (element.name === 'input') return (attr(element, 'type') ?? 'text').toLowerCase() !== 'hidden';
  if (element.name === 'iframe') return true;
  return false;
}

// ===========================================================================
// The checks
//
// Each returns an array of { ruleId, message, snippet, line }. A check that cannot
// decide something must not report anything: silence here is correct, and a guess
// is not.
// ===========================================================================

const FORM_CONTROL_TYPES_WITHOUT_LABELS = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

function buildIndex(root) {
  /** id -> element, first occurrence. Also records every duplicate. */
  const byId = new Map();
  const duplicates = new Map();
  const labelsFor = new Map();
  for (const element of walk(root)) {
    const id = attr(element, 'id');
    if (id !== null && id.length > 0) {
      if (byId.has(id)) duplicates.set(id, (duplicates.get(id) ?? 1) + 1);
      else byId.set(id, element);
    }
    if (element.name === 'label') {
      const target = attr(element, 'for');
      if (target !== null && target.length > 0 && !labelsFor.has(target)) labelsFor.set(target, element);
    }
  }
  byId.labelsFor = labelsFor;
  return { byId, duplicates, labelsFor };
}

function runChecks(html, root) {
  const lineOf = lineIndex(html);
  const { byId, duplicates } = buildIndex(root);
  const all = elementsOf(root);
  const findings = [];
  /**
   * Checks that were skipped, not elements that were skipped.
   *
   * An earlier version counted every element whose role could not be resolved,
   * which meant `<head>`, `<meta>` and `<script>` inflated the figure into
   * something alarming and meaningless. What a reader needs to know is how many
   * ARIA attributes went unjudged, because that is the size of the hole.
   */
  const unchecked = { ariaAttributesSkipped: 0 };

  const report = (ruleId, element, message) => {
    findings.push({
      ruleId,
      message,
      snippet: element === null ? null : snippet(element),
      line: element === null ? null : lineOf(element.start),
    });
  };

  // --- document level ------------------------------------------------------

  const htmlElement = all.find((element) => element.name === 'html') ?? null;
  const lang = htmlElement === null ? null : attr(htmlElement, 'lang');
  if (htmlElement === null) {
    report('html-has-lang', null, 'the response has no <html> element');
  } else if (lang === null || lang.trim().length === 0) {
    report('html-has-lang', htmlElement, '<html> has no lang attribute');
  } else if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(lang.trim())) {
    // A shape check, not a registry lookup: this catches "english" and "en_GB",
    // not an unregistered-but-well-formed subtag.
    report('html-lang-valid', htmlElement, `lang="${lang}" is not a well-formed BCP 47 tag`);
  }

  const title = all.find((element) => element.name === 'title') ?? null;
  if (title === null || textContent(title).length === 0) {
    report('document-title', title, 'the document has no non-empty <title>');
  }

  for (const meta of all.filter((element) => element.name === 'meta')) {
    if ((attr(meta, 'name') ?? '').toLowerCase() !== 'viewport') continue;
    const content = (attr(meta, 'content') ?? '').toLowerCase();
    if (/user-scalable\s*=\s*(no|0)/.test(content)) {
      report('meta-viewport', meta, 'the viewport disables zooming (user-scalable=no)');
    }
    const maxScale = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
    if (maxScale !== null && Number(maxScale[1]) < 2) {
      report('meta-viewport', meta, `maximum-scale=${maxScale[1]} prevents zooming to 200%`);
    }
  }

  // --- duplicate ids -------------------------------------------------------

  for (const [id, count] of duplicates) {
    report('duplicate-id-aria', byId.get(id) ?? null, `id="${id}" appears ${count} times`);
  }

  // --- per element ---------------------------------------------------------

  const headings = [];
  const landmarks = [];

  for (const element of all) {
    const hidden = inAriaHidden(element);
    const resolved = roleOf(element);

    // --- tabindex ---
    const tabindex = attr(element, 'tabindex');
    if (tabindex !== null && Number(tabindex) > 0) {
      report('tabindex', element, `tabindex="${tabindex}" forces this element ahead of the document order`);
    }

    // --- invalid role ---
    if (resolved.explicit && resolved.role === null) {
      report('aria-roles', element, `role="${resolved.invalid}" is not a valid ARIA role`);
    }

    // --- aria-* names, values, and whether the role allows them ---
    //
    // `allowed === null` means "the role could not be determined, so do not judge
    // which attributes it permits". Every attribute skipped that way is counted, so
    // the report says how much was not checked instead of implying it passed.
    const allowed = allowedAriaFor(resolved);

    for (const [name, value] of element.attrs) {
      if (!name.startsWith('aria-')) continue;

      if (!ARIA.validateAttr(name)) {
        report('aria-valid-attr', element, `${name} is not a defined ARIA attribute`);
        continue;
      }
      const spec = LOOKUP.attributes[name];

      // Value type, from axe's own table.
      if (spec !== undefined && spec.type !== undefined) {
        const problem = checkAttrValue(name, value, spec, byId);
        if (problem !== null) report('aria-valid-attr-value', element, problem);
      }

      if (allowed === null) {
        unchecked.ariaAttributesSkipped += 1;
        continue;
      }
      if (!allowed.has(name)) {
        report(
          'aria-allowed-attr',
          element,
          `${name} is not allowed on role "${resolved.role}" (implicit roles included)`,
        );
      }
    }

    // --- required aria-* for an EXPLICIT role only ---
    // An implicit role gets its required values from the host language: <h2> does
    // not need aria-level, but role="heading" does. Checking implicit roles here
    // would flag every heading on every page.
    if (resolved.explicit && resolved.role !== null) {
      for (const required of ARIA.requiredAttr(resolved.role) ?? []) {
        if (!element.attrs.has(required)) {
          report('aria-required-attr', element, `role="${resolved.role}" requires ${required}`);
        }
      }
    }

    // --- role=presentation with conflicting ARIA ---
    if (resolved.explicit && (resolved.role === 'presentation' || resolved.role === 'none')) {
      const conflicting = [...element.attrs.keys()].filter(
        (name) => name.startsWith('aria-') && name !== 'aria-hidden',
      );
      const focusable = isTabbable(element);
      if (conflicting.length > 0 || focusable) {
        report(
          'presentation-role-conflict',
          element,
          `role="${resolved.role}" is ignored because the element is ${
            focusable ? 'focusable' : `also carrying ${conflicting.join(', ')}`
          }`,
        );
      }
    }

    // --- aria-hidden must not contain anything tabbable ---
    if (attr(element, 'aria-hidden') === 'true') {
      const tabbable = [element, ...walk(element)].filter(isTabbable);
      if (tabbable.length > 0) {
        report(
          'aria-hidden-focus',
          element,
          `aria-hidden="true" but this subtree contains ${tabbable.length} keyboard-focusable ` +
            'element(s), which are reachable by tab but hidden from assistive technology',
        );
      }
    }

    if (hidden) continue; // Nothing below matters for a subtree hidden from AT.

    // --- alternative text ---
    if (element.name === 'img') {
      const hasName =
        hasAttr(element, 'alt') ||
        attr(element, 'aria-label') !== null ||
        attr(element, 'aria-labelledby') !== null ||
        resolved.role === 'presentation' ||
        resolved.role === 'none';
      if (!hasName) report('image-alt', element, '<img> has no alt attribute and no ARIA name');
    }
    if (element.name === 'input' && (attr(element, 'type') ?? '').toLowerCase() === 'image') {
      if (accessibleName(element, byId) === null) {
        report('input-image-alt', element, '<input type="image"> has no alt text');
      }
    }
    if (element.name === 'area' && hasAttr(element, 'href')) {
      if (accessibleName(element, byId) === null) {
        report('area-alt', element, 'an active <area> has no alternative text');
      }
    }
    if (element.name === 'iframe' || element.name === 'frame') {
      const named =
        (attr(element, 'title') ?? '').trim().length > 0 ||
        attr(element, 'aria-label') !== null ||
        attr(element, 'aria-labelledby') !== null;
      if (!named) report('frame-title', element, `<${element.name}> has no title`);
    }

    // --- names for controls ---
    if (element.name === 'button' || (resolved.explicit && resolved.role === 'button')) {
      if (accessibleName(element, byId) === null) {
        report('button-name', element, 'this button has no accessible name');
      }
    }
    if (element.name === 'a' && hasAttr(element, 'href')) {
      if (accessibleName(element, byId) === null) {
        report('link-name', element, 'this link has no accessible name');
      }
    }
    if (element.name === 'select') {
      if (accessibleName(element, byId) === null) {
        report('select-name', element, '<select> has no accessible name');
      }
    }
    if (element.name === 'textarea' || (element.name === 'input' && !isUnlabellable(element))) {
      if (accessibleName(element, byId) === null) {
        report('label', element, `<${element.name}> has no label, aria-label, aria-labelledby or title`);
      }
    }

    // --- headings ---
    if (/^h[1-6]$/.test(element.name) || resolved.role === 'heading') {
      const level = /^h([1-6])$/.exec(element.name)?.[1];
      const ariaLevel = attr(element, 'aria-level');
      const resolvedLevel = level !== undefined ? Number(level) : Number(ariaLevel ?? '0');
      headings.push({ element, level: resolvedLevel });
      if (textContent(element).length === 0 && accessibleName(element, byId) === null) {
        report('empty-heading', element, `<${element.name}> has no text`);
      }
    }

    // --- landmarks ---
    if (resolved.role !== null && resolved.role !== 'undetermined' && LANDMARK_ROLES.has(resolved.role)) {
      landmarks.push({ element, role: resolved.role, name: accessibleName(element, byId) });
    }

    // --- list structure ---
    if (element.name === 'ul' || element.name === 'ol' || element.name === 'menu') {
      for (const child of element.children) {
        if (child.type === 'text') {
          if (child.value.trim().length > 0) {
            report(
              'list',
              element,
              `<${element.name}> contains text directly; only <li> (and script/template) are allowed`,
            );
            break;
          }
          continue;
        }
        if (child.type !== 'element') continue;
        if (['li', 'script', 'template'].includes(child.name)) continue;
        if (attr(child, 'role') === 'listitem') continue;
        report('list', element, `<${element.name}> contains a direct <${child.name}> child`);
        break;
      }
    }
    if (element.name === 'dl') {
      for (const child of element.children) {
        if (child.type !== 'element') continue;
        if (['dt', 'dd', 'div', 'script', 'template'].includes(child.name)) continue;
        report('definition-list', element, `<dl> contains a direct <${child.name}> child`);
        break;
      }
    }
  }

  // --- heading order -------------------------------------------------------

  if (headings.length > 0 && !headings.some((heading) => heading.level === 1)) {
    report('page-has-heading-one', null, 'the page has headings but no level-1 heading');
  }
  let previous = null;
  for (const heading of headings) {
    if (heading.level < 1 || heading.level > 6) continue;
    if (previous !== null && heading.level > previous + 1) {
      report('heading-order', heading.element, `heading level jumps from h${previous} to h${heading.level}`);
    }
    previous = heading.level;
  }

  // --- landmarks -----------------------------------------------------------

  const mains = landmarks.filter((landmark) => landmark.role === 'main');
  if (mains.length === 0) {
    report('landmark-one-main', null, 'the page has no <main> or role="main" landmark');
  } else if (mains.length > 1) {
    report('landmark-one-main', mains[1].element, `the page has ${mains.length} main landmarks`);
  }
  const seenLandmarks = new Map();
  for (const landmark of landmarks) {
    const key = `${landmark.role}\u0000${landmark.name ?? ''}`;
    if (seenLandmarks.has(key)) {
      report(
        'landmark-unique',
        landmark.element,
        `a second "${landmark.role}" landmark with the same name ("${landmark.name ?? 'no name'}") — ` +
          'give each one a distinguishing aria-label',
      );
    }
    seenLandmarks.set(key, landmark.element);
  }

  return { findings, unchecked, elementCount: all.length };
}

/**
 * The set of aria-* attributes a role permits: the globals plus the role's own.
 * `null` when the role could not be determined, which means "do not judge".
 */
function allowedAriaFor(resolved) {
  if (resolved.role === null || resolved.role === 'undetermined') return null;
  if (GLOBALS_ONLY_ROLES.has(resolved.role)) return new Set(LOOKUP.globalAttributes);
  const spec = LOOKUP.role[resolved.role];
  if (spec === undefined) return null;
  return new Set([...LOOKUP.globalAttributes, ...(spec.attributes?.allowed ?? [])]);
}

/** input types that legitimately have no separate label. */
function isUnlabellable(element) {
  const type = (attr(element, 'type') ?? 'text').toLowerCase();
  return FORM_CONTROL_TYPES_WITHOUT_LABELS.has(type);
}

/** Value validation driven by axe's own attribute table. */
function checkAttrValue(name, value, spec, byId) {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return spec.allowEmpty === true ? null : `${name} is empty`;
  }
  switch (spec.type) {
    case 'boolean':
      return trimmed === 'true' || trimmed === 'false' ? null : `${name}="${value}" must be true or false`;
    case 'nmtoken':
      return Array.isArray(spec.values) && !spec.values.includes(trimmed.toLowerCase())
        ? `${name}="${value}" must be one of: ${spec.values.join(', ')}`
        : null;
    case 'nmtokens': {
      if (!Array.isArray(spec.values)) return null;
      const bad = trimmed.split(/\s+/).filter((token) => !spec.values.includes(token.toLowerCase()));
      return bad.length > 0
        ? `${name}="${value}" contains ${bad.join(', ')}; allowed: ${spec.values.join(', ')}`
        : null;
    }
    case 'int': {
      return /^-?\d+$/.test(trimmed) ? null : `${name}="${value}" must be an integer`;
    }
    case 'decimal':
      return /^-?(\d+(\.\d*)?|\.\d+)$/.test(trimmed) ? null : `${name}="${value}" must be a number`;
    case 'idref':
      return byId.has(trimmed) ? null : `${name}="${value}" points at an id that is not in this document`;
    case 'idrefs': {
      const missing = trimmed.split(/\s+/).filter((id) => !byId.has(id));
      return missing.length > 0
        ? `${name}="${value}" points at ${missing.length} id(s) not in this document: ${missing.join(', ')}`
        : null;
    }
    default:
      // 'string' and anything unstandardised: nothing decidable here.
      return null;
  }
}

// ===========================================================================
// Servers
// ===========================================================================

/**
 * A child server this script owns and must clean up.
 *
 * Detached, and signalled by process group, for the same reason as
 * scripts/dev.mjs: `pnpm --filter ... start` is a wrapper, and killing the wrapper
 * leaves the real server holding the port. An orphaned Next server after a failed
 * audit makes the next audit pass against stale markup.
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
      // Kept, not printed: a healthy Next boot is twenty lines of noise. It is
      // printed only if the server fails to become ready, which is exactly when
      // somebody needs it.
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
        // Any HTTP answer means the server is listening. A 404 on the ready URL is
        // still a live server, and treating it as "not ready" would spin forever.
        if (response.status > 0) return;
      } catch {
        // Not up yet.
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `${this.label} was not ready at ${this.readyUrl} within ${timeoutSeconds}s:\n${this.output.join('')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 300));
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

// ===========================================================================
// Route discovery
// ===========================================================================

/** Same-origin links in this HTML, normalised to path-only routes. */
function linksIn(html, baseUrl, pageUrl) {
  const found = new Set();
  const base = new URL(baseUrl);
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/gi)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    if (raw.length === 0 || raw.startsWith('#')) continue;
    let url;
    try {
      url = new URL(decodeEntities(raw), pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== base.origin) continue;
    // Query strings and fragments do not change server-rendered markup enough to
    // be worth auditing as separate routes, and including them makes the route
    // list unbounded.
    found.add(url.pathname);
  }
  return found;
}

// ===========================================================================
// Run
// ===========================================================================

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (err) {
  console.error(red(`a11y-audit — ${err.message}`));
  process.exit(1);
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

console.log(
  bold('\nPoker Risk Lab accessibility audit') + dim(`  (axe-core ${axe.version} rules and ARIA tables)`),
);
console.log(yellow('  STATIC audit of server-rendered HTML. No browser, so no colour contrast,'));
console.log(yellow('  no focus order, and nothing that CSS or client-side JavaScript decides.'));
console.log(dim('  The file header lists every rule this does and does not cover.\n'));

const servers = [];
let exitCode = 0;

try {
  if (options.start) {
    if (options.withApi) {
      const api = new ManagedServer(
        'api',
        ['--filter', '@prl/api', 'start'],
        new URL('/api/v1/health', options.apiUrl).toString(),
        { NODE_ENV: 'production' },
      );
      servers.push(api);
      console.log(dim('  starting the API...'));
      api.start();
      await api.waitUntilReady(options.readyTimeoutSeconds);
    }
    const web = new ManagedServer('web', ['--filter', '@prl/web', 'start'], options.baseUrl, {
      NODE_ENV: 'production',
      PRL_API_ORIGIN: options.apiUrl,
    });
    servers.push(web);
    console.log(dim('  starting the web app...'));
    web.start();
    await web.waitUntilReady(options.readyTimeoutSeconds);
    console.log(dim(`  ready at ${options.baseUrl}\n`));
  } else {
    console.log(dim(`  auditing the server already running at ${options.baseUrl}\n`));
  }

  // --- fetch and audit, discovering routes as we go ---
  const queue = options.routes.map((route) => ({ route, depth: 0 }));
  const seen = new Set(options.routes);
  const results = [];
  const fetchFailures = [];

  while (queue.length > 0 && results.length < options.maxRoutes) {
    const { route, depth } = queue.shift();
    const pageUrl = new URL(route, options.baseUrl).toString();
    let response;
    let html;
    try {
      response = await fetch(pageUrl, {
        headers: { accept: 'text/html' },
        signal: AbortSignal.timeout(options.requestTimeoutSeconds * 1000),
      });
      html = await response.text();
    } catch (err) {
      fetchFailures.push({ route, reason: err.message });
      continue;
    }
    if (!response.ok) {
      // Not audited on purpose: an error page is not the markup this app ships,
      // and findings from it would be noise attributed to a real route.
      fetchFailures.push({ route, reason: `HTTP ${response.status}` });
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) {
      fetchFailures.push({ route, reason: `content-type ${contentType || 'missing'} is not HTML` });
      continue;
    }

    const root = parseHtml(html);
    const audit = runChecks(html, root);
    results.push({ route, bytes: html.length, ...audit });

    if (depth < options.crawlDepth) {
      for (const link of linksIn(html, options.baseUrl, pageUrl)) {
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push({ route: link, depth: depth + 1 });
      }
    }
  }

  // --- report ---
  const byRule = new Map();
  let totalFindings = 0;
  let suppressed = 0;

  for (const result of results) {
    const shown = result.findings.filter((finding) => {
      if (!options.wcagOnly) return true;
      const keep = severityOf(finding.ruleId) === 'wcag';
      if (!keep) suppressed += 1;
      return keep;
    });
    result.shown = shown;
    totalFindings += shown.length;
    for (const finding of shown) {
      byRule.set(finding.ruleId, (byRule.get(finding.ruleId) ?? 0) + 1);
    }
  }

  console.log(bold(`Routes audited (${results.length})`));
  for (const result of results) {
    const count = result.shown.length;
    const head = count === 0 ? green('ok') : red(`${count} violation(s)`);
    console.log(
      `\n  ${cyan(result.route)}  ${head} ${dim(`${result.bytes} bytes, ${result.elementCount} elements`)}`,
    );
    if (result.unchecked.ariaAttributesSkipped > 0) {
      console.log(
        dim(
          `    ${result.unchecked.ariaAttributesSkipped} aria-* attribute(s) sat on an element ` +
            'whose role this audit cannot determine from markup; aria-allowed-attr was not ' +
            'judged for them',
        ),
      );
    }
    // Grouped by rule, so a systemic problem reads as one entry with a count
    // rather than forty identical lines.
    const grouped = new Map();
    for (const finding of result.shown) {
      if (!grouped.has(finding.ruleId)) grouped.set(finding.ruleId, []);
      grouped.get(finding.ruleId).push(finding);
    }
    for (const [ruleId, findings] of grouped) {
      const meta = rule(ruleId);
      const tag = severityOf(ruleId) === 'wcag' ? red('WCAG') : yellow('best-practice');
      console.log(`    ${bold(ruleId)} ${dim(`(${tag})`)} — ${meta.help}`);
      console.log(dim(`      ${meta.helpUrl}`));
      for (const finding of findings.slice(0, 10)) {
        console.log(`      ${red('x')} line ${finding.line ?? '?'}: ${finding.message}`);
        if (finding.snippet !== null) console.log(dim(`        ${finding.snippet}`));
      }
      if (findings.length > 10) console.log(dim(`      ... and ${findings.length - 10} more`));
    }
  }

  if (fetchFailures.length > 0) {
    console.log(red(bold('\nRoutes that could not be audited')));
    for (const failure of fetchFailures) {
      console.log(red(`  x ${failure.route} — ${failure.reason}`));
    }
    console.log(dim('  A route in the seed list that does not return HTML is a broken route or a stale'));
    console.log(dim('  route list. Either way it is a failure, not something to audit around.'));
  }

  console.log(bold('\nSummary'));
  console.log(`  routes audited      ${results.length}`);
  console.log(`  violations          ${totalFindings}`);
  if (suppressed > 0) console.log(dim(`  suppressed          ${suppressed} best-practice (--wcag-only)`));
  if (byRule.size > 0) {
    console.log(bold('\n  by rule'));
    for (const [ruleId, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${count.toString().padStart(4)}  ${ruleId}  ${dim(severityOf(ruleId))}`);
    }
  }

  const report = {
    tool: `a11y-audit.mjs (static) using axe-core ${axe.version} rule metadata and ARIA tables`,
    kind: 'static-html',
    coverageWarning:
      'Static audit of server-rendered HTML. Does NOT cover colour contrast, CSS-dependent ' +
      'visibility, or anything rendered by client-side JavaScript. Focus order, focus ' +
      'visibility and keyboard operability are covered separately by scripts/keyboard-audit.mjs ' +
      '(pnpm run test:keyboard), which drives a real browser. A screen-reader pass is still ' +
      'required and is not automated anywhere.',
    baseUrl: options.baseUrl,
    wcagOnly: options.wcagOnly,
    generatedAt: new Date().toISOString(),
    routes: results.map((result) => ({
      route: result.route,
      bytes: result.bytes,
      elements: result.elementCount,
      ariaAttributesNotJudged: result.unchecked.ariaAttributesSkipped,
      violations: result.shown,
    })),
    unauditableRoutes: fetchFailures,
    violationsByRule: Object.fromEntries(byRule),
    totalViolations: totalFindings,
    passed: totalFindings === 0 && fetchFailures.length === 0 && results.length > 0,
  };

  if (options.out !== null) {
    const outPath = resolve(REPO_ROOT, options.out);
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(dim(`\n  report written to ${outPath}`));
  }

  if (results.length === 0) {
    console.log(red(bold('\nFAIL — no route was audited at all.')));
    exitCode = 1;
  } else if (report.passed) {
    console.log(green(bold('\nPASS — no violation of the checked rules.')));
    console.log(dim('  Checked rules only. This is not a statement that the app is accessible;'));
    console.log(dim('  colour contrast still needs a browser run, and so does a screen reader.'));
    console.log(dim('  Focus order and keyboard use: `pnpm run test:keyboard` (real Chrome).\n'));
  } else {
    console.log(red(bold('\nFAIL')));
    exitCode = 1;
  }
} catch (err) {
  console.error(red(`\na11y-audit failed: ${err.message}`));
  exitCode = 1;
} finally {
  for (const server of servers) server.stop();
}

process.exit(exitCode);
