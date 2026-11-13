#!/usr/bin/env node
/**
 * `pnpm run test:a11y`: a STATIC accessibility audit of server-rendered HTML. It parses the markup
 * itself and takes rule ids, help URLs and the ARIA tables from axe-core, because `axe.run()` needs a
 * live DOM.
 *
 * Checked (axe rule ids): html-has-lang, html-lang-valid, document-title, meta-viewport, image-alt,
 * input-image-alt, area-alt, frame-title, label, button-name, link-name, select-name, heading-order,
 * page-has-heading-one, empty-heading, duplicate-id-aria, tabindex, landmark-one-main,
 * landmark-unique, list, definition-list, aria-roles, aria-valid-attr, aria-allowed-attr,
 * aria-valid-attr-value, aria-required-attr, aria-hidden-focus, presentation-role-conflict.
 *
 * NOT checked: colour contrast, focus order, keyboard operability, anything decided by CSS
 * (visibility, reading order, reflow, target size, focus indicators), hydrated-only controls, full
 * accname 1.2, required owned/context roles, live regions and media. Elements whose role markup
 * cannot decide are counted as unchecked. A pass does not mean the app is accessible.
 *
 * Routes are crawled from `--routes` through same-origin links. A declaration cookie at the gate's
 * ceiling is sent so an age-gated deployment serves its pages, and a response that landed on
 * `/age-check` is recorded as unauditable. Audit the interstitial with `--routes /age-check`.
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The gate's own constants, so the cookie this seeds is the one the proxy reads.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MINIMUM_CEILING,
  AGE_GATE_PATH,
} from '../apps/web/src/lib/age-gate.ts';

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

/** axe-core loads in plain Node. Only `axe.run()` needs a document, and this file never calls it. */
const axe = require('axe-core');
const ARIA = axe.commons.aria;
const LOOKUP = ARIA.lookupTable;

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

function severityOf(ruleId) {
  return rule(ruleId).tags.some((tag) => tag.startsWith('wcag2')) ? 'wcag' : 'best-practice';
}

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
    // `pnpm run test:a11y -- --with-api` passes the `--` through.
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

// A tolerant HTML parser. It implements only the tree-construction rules that change answers here
// (void elements, raw-text elements, implied end tags) and keeps elements where the author wrote them.

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

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

/** Implied end tags. Without them `<ul><li>a<li>b</ul>` nests an li in an li and `list` misfires. */
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
  // Only the entities that change whether text is empty or what an id looks like.
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

    if (html.startsWith('</', lt)) {
      let cursor = lt + 2;
      let name = '';
      while (cursor < html.length && NAME_CHAR.test(html[cursor])) name += html[cursor++];
      const end = html.indexOf('>', cursor);
      i = end === -1 ? html.length : end + 1;
      if (name.length > 0) closeTag(name.toLowerCase());
      continue;
    }

    if (!NAME_START.test(html[lt + 1] ?? '')) {
      addText('<', lt);
      i = lt + 1;
      continue;
    }

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
      // First occurrence wins, as in browsers.
      const lower = attrName.toLowerCase();
      if (!attrs.has(lower)) attrs.set(lower, decodeEntities(attrValue));
    }
    const tagEnd = html.indexOf('>', cursor);
    i = tagEnd === -1 ? html.length : tagEnd + 1;

    const closes = CLOSES_ON_START.get(name);
    if (closes?.has(top().name)) closeTag(top().name);
    if (CLOSES_PARAGRAPH.has(name) && top().name === 'p') closeTag('p');

    const element = { type: 'element', name, attrs, children: [], parent: top(), start: lt };
    top().children.push(element);

    if (VOID_ELEMENTS.has(name) || selfClosing) continue;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      // A `<` inside a script is not markup.
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

function inAriaHidden(element) {
  if (attr(element, 'aria-hidden') === 'true') return true;
  return ancestors(element).some((a) => attr(a, 'aria-hidden') === 'true');
}

/** Skips script, style and aria-hidden subtrees, and includes descendant image alt text. */
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

function snippet(element) {
  const parts = [element.name];
  for (const [name, value] of element.attrs) {
    parts.push(value === '' ? name : `${name}="${value.length > 40 ? `${value.slice(0, 40)}...` : value}"`);
  }
  const text = `<${parts.join(' ')}>`;
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

/**
 * Implicit roles that need element-specific logic, from HTML-AAM. Context-dependent cases return
 * `undetermined` so role-dependent checks skip the element.
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
  // Types with no ARIA role mapping are `undetermined`.
]);

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

const SECTIONING = new Set(['article', 'aside', 'main', 'nav', 'section']);

/**
 * ARIA 1.2 roles missing from axe 4.13's `lookupTable.role` that allow only globals. axe rejects
 * `generic`, and it is the resolved role of div, span and p, so without it `aria-allowed-attr` would
 * never fire on the commonest elements.
 */
const GLOBALS_ONLY_ROLES = new Set(['generic']);

function roleOf(element) {
  const explicit = attr(element, 'role');
  if (explicit !== null) {
    // The first valid token of the fallback list wins.
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
    const named = attr(element, 'aria-label') !== null || attr(element, 'aria-labelledby') !== null;
    return { role: named ? 'region' : 'generic', explicit: false };
  }
  if (name === 'div' || name === 'span' || name === 'p') return { role: 'generic', explicit: false };
  if (name === 'td' || name === 'th' || name === 'caption') {
    return { role: 'undetermined', explicit: false };
  }

  const implicit = LOOKUP.implicitHtmlRole[name];
  if (typeof implicit === 'string') return { role: implicit, explicit: false };
  return { role: 'undetermined', explicit: false };
}

/** The subset of accname this can do. See the limitations in the file header. */
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
      return type === 'submit' ? 'Submit' : 'Reset';
    }
    if (type === 'button') {
      const value = attr(element, 'value');
      if (value !== null && value.trim().length > 0) return value.trim();
    }
  }

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

/** Markup-only. CSS can change focusability, so aria-hidden-focus is an approximation. */
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

// Each check returns { ruleId, message, snippet, line }. A check that cannot decide reports nothing.

const FORM_CONTROL_TYPES_WITHOUT_LABELS = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

function buildIndex(root) {
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
  /** Counts ARIA attributes that went unjudged, which is the size of the hole. */
  const unchecked = { ariaAttributesSkipped: 0 };

  const report = (ruleId, element, message) => {
    findings.push({
      ruleId,
      message,
      snippet: element === null ? null : snippet(element),
      line: element === null ? null : lineOf(element.start),
    });
  };

  const htmlElement = all.find((element) => element.name === 'html') ?? null;
  const lang = htmlElement === null ? null : attr(htmlElement, 'lang');
  if (htmlElement === null) {
    report('html-has-lang', null, 'the response has no <html> element');
  } else if (lang === null || lang.trim().length === 0) {
    report('html-has-lang', htmlElement, '<html> has no lang attribute');
  } else if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(lang.trim())) {
    // A shape check, not a registry lookup.
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

  for (const [id, count] of duplicates) {
    report('duplicate-id-aria', byId.get(id) ?? null, `id="${id}" appears ${count} times`);
  }

  const headings = [];
  const landmarks = [];

  for (const element of all) {
    const hidden = inAriaHidden(element);
    const resolved = roleOf(element);

    const tabindex = attr(element, 'tabindex');
    if (tabindex !== null && Number(tabindex) > 0) {
      report('tabindex', element, `tabindex="${tabindex}" forces this element ahead of the document order`);
    }

    if (resolved.explicit && resolved.role === null) {
      report('aria-roles', element, `role="${resolved.invalid}" is not a valid ARIA role`);
    }

    // `allowed === null` means the role is undetermined. Each skipped attribute is counted.
    const allowed = allowedAriaFor(resolved);

    for (const [name, value] of element.attrs) {
      if (!name.startsWith('aria-')) continue;

      if (!ARIA.validateAttr(name)) {
        report('aria-valid-attr', element, `${name} is not a defined ARIA attribute`);
        continue;
      }
      const spec = LOOKUP.attributes[name];

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

    // Required aria-* for EXPLICIT roles only. <h2> needs no aria-level, role="heading" does.
    if (resolved.explicit && resolved.role !== null) {
      for (const required of ARIA.requiredAttr(resolved.role) ?? []) {
        if (!element.attrs.has(required)) {
          report('aria-required-attr', element, `role="${resolved.role}" requires ${required}`);
        }
      }
    }

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

    if (/^h[1-6]$/.test(element.name) || resolved.role === 'heading') {
      const level = /^h([1-6])$/.exec(element.name)?.[1];
      const ariaLevel = attr(element, 'aria-level');
      const resolvedLevel = level !== undefined ? Number(level) : Number(ariaLevel ?? '0');
      headings.push({ element, level: resolvedLevel });
      if (textContent(element).length === 0 && accessibleName(element, byId) === null) {
        report('empty-heading', element, `<${element.name}> has no text`);
      }
    }

    if (resolved.role !== null && resolved.role !== 'undetermined' && LANDMARK_ROLES.has(resolved.role)) {
      landmarks.push({ element, role: resolved.role, name: accessibleName(element, byId) });
    }

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

/** `null` when the role is undetermined, which means do not judge. */
function allowedAriaFor(resolved) {
  if (resolved.role === null || resolved.role === 'undetermined') return null;
  if (GLOBALS_ONLY_ROLES.has(resolved.role)) return new Set(LOOKUP.globalAttributes);
  const spec = LOOKUP.role[resolved.role];
  if (spec === undefined) return null;
  return new Set([...LOOKUP.globalAttributes, ...(spec.attributes?.allowed ?? [])]);
}

function isUnlabellable(element) {
  const type = (attr(element, 'type') ?? 'text').toLowerCase();
  return FORM_CONTROL_TYPES_WITHOUT_LABELS.has(type);
}

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
      return null;
  }
}

/** Servers get an explicit `PORT` so they listen where the audit looks. */
function portFromOrigin(origin, fallback) {
  const port = new URL(origin).port;
  return port === '' ? fallback : port;
}

/**
 * `waitUntilReady` cannot tell its own child's answer from a stranger's, so an occupied port is
 * refused (a stranger on :3472 was audited and passed). It connects rather than binds, because on
 * macOS a bind to 127.0.0.1 succeeds beside a wildcard listener such as `next start` (measured
 * 2026-11-10). Only ECONNREFUSED counts as free.
 */
async function refuseOccupiedPort(port) {
  const outcome = await new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port: Number(port) });
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
  if (outcome !== 'refused') {
    const seen = outcome === 'accepted' ? 'something is already listening' : `a probe connection ${outcome}`;
    throw new Error(
      `${seen} on 127.0.0.1:${port}. --start audits a server this run ` +
        'started, so it will not score one it did not. Stop it, pass another --base-url/--api-url, ' +
        'or pass --no-start to audit that server on purpose.',
    );
  }
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
      // Printed only if the server fails to become ready.
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
        // Any HTTP answer means the server is listening.
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

/**
 * Both cookie names. The proxy takes the lower value when both are present, and `__Host-` rules
 * constrain `Set-Cookie`, not a request header.
 */
const AGE_DECLARATION_COOKIE = AGE_GATE_COOKIE_NAMES.map(
  (name) => `${name}=${String(AGE_GATE_MINIMUM_CEILING)}`,
).join('; ');

/**
 * Segment matching, never `includes`, because `/age-checkers` is not the gate. A request FOR the gate
 * does not count, so `--routes /age-check` audits the interstitial.
 */
function landedOnAgeGate(requestedPath, landedPath) {
  const isGate = (path) => path === AGE_GATE_PATH || path.startsWith(`${AGE_GATE_PATH}/`);
  return isGate(landedPath) && !isGate(requestedPath);
}

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
    // Query strings and fragments are dropped, or the route list is unbounded.
    found.add(url.pathname);
  }
  return found;
}

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
        // No NODE_ENV=production on the API. `loadConfig` then requires SESSION_COOKIE_SECRET and
        // PUBLIC_WEB_ORIGIN, which the ci.yml `a11y` job does not supply, and the API exits 78.
        // PUBLIC_WEB_ORIGIN is set to this audit's web origin for CORS and the WebSocket Origin check.
        {
          PORT: portFromOrigin(options.apiUrl, '3001'),
          HOST: '127.0.0.1',
          PUBLIC_WEB_ORIGIN: new URL(options.baseUrl).origin,
        },
      );
      servers.push(api);
      await refuseOccupiedPort(portFromOrigin(options.apiUrl, '3001'));
      console.log(dim('  starting the API...'));
      api.start();
      await api.waitUntilReady(options.readyTimeoutSeconds);
    }
    // The web server keeps NODE_ENV=production. Its production markup is what this scores.
    const web = new ManagedServer('web', ['--filter', '@prl/web', 'start'], options.baseUrl, {
      NODE_ENV: 'production',
      PRL_API_ORIGIN: options.apiUrl,
      PORT: portFromOrigin(options.baseUrl, '3000'),
    });
    servers.push(web);
    await refuseOccupiedPort(portFromOrigin(options.baseUrl, '3000'));
    console.log(dim('  starting the web app...'));
    web.start();
    await web.waitUntilReady(options.readyTimeoutSeconds);
    console.log(dim(`  ready at ${options.baseUrl}\n`));
  } else {
    console.log(dim(`  auditing the server already running at ${options.baseUrl}\n`));
  }

  // Probe /play once without following redirects or declaring, to record whether a gate is in front.
  // /play is gated under both scopes.
  const gateProbe = await fetch(new URL('/play', options.baseUrl), {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  }).catch(() => null);
  const ageGateOn =
    gateProbe !== null &&
    gateProbe.status >= 300 &&
    gateProbe.status < 400 &&
    landedOnAgeGate('/play', new URL(gateProbe.headers.get('location') ?? '/', options.baseUrl).pathname);
  if (ageGateOn) {
    console.log(yellow(`  The age gate is ON at this origin: ${AGE_GATE_PATH} stands in front of /play.`));
    console.log(
      yellow(`  Every request below carries a declaration (${AGE_DECLARATION_COOKIE}), so the routes`),
    );
    console.log(yellow('  audited are the pages themselves and not the interstitial.'));
    console.log(dim(`  The interstitial is a page too: audit it with --routes ${AGE_GATE_PATH}.\n`));
  }

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
        headers: { accept: 'text/html', cookie: AGE_DECLARATION_COOKIE },
        signal: AbortSignal.timeout(options.requestTimeoutSeconds * 1000),
      });
      html = await response.text();
    } catch (err) {
      fetchFailures.push({ route, reason: err.message });
      continue;
    }
    if (!response.ok) {
      // An error page is not the markup this app ships.
      fetchFailures.push({ route, reason: `HTTP ${response.status}` });
      continue;
    }
    // `fetch` follows the gate's 303 silently, so only the landing URL shows whether this is the
    // route that was asked for.
    const landedPath = new URL(response.url === '' ? pageUrl : response.url).pathname;
    if (landedOnAgeGate(new URL(pageUrl).pathname, landedPath)) {
      fetchFailures.push({
        route,
        reason:
          `the age gate answered with ${landedPath}. This route was NOT audited: the interstitial ` +
          'is not the page. The declaration cookie this audit sends was refused — check ' +
          `PRL_AGE_GATE_MINIMUM_AGE against ${String(AGE_GATE_MINIMUM_CEILING)}. To audit the gate ` +
          `itself, run with --routes ${AGE_GATE_PATH}.`,
      });
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
    // Recorded so a run past an age gate can be told apart from one against an ungated deployment.
    ageGate: { detected: ageGateOn, declarationSent: AGE_DECLARATION_COOKIE },
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
