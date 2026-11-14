#!/usr/bin/env node
/**
 * The computed accessibility tree of this app, walked in real Chrome per journey (`pnpm run test:ax`).
 *
 * It asserts on what a screen reader consumes, but it is NOT a screen-reader test. Whether VoiceOver,
 * NVDA or JAWS speaks it is `docs/production/accessibility-certification.md`. It does not check
 * contrast (`design:contrast`) or the keyboard (`test:keyboard`). A face-down card whose rank or suit
 * reaches the tree is a hidden-information leak, and it is checked here. A skipped journey fails.
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ANNOUNCER_PROBE, ASSERTION_ROUTES, CARD_VALUE_WORDS, SPEECH_PROBE } from './ax-assertions.mjs';
import { waitForDevtools } from './chrome-devtools.mjs';
import { startReviewProxy } from './review-proxy.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);

/**
 * The six journeys, each as one or more routes. Fixture states of `/play` render the same tree as the
 * live route without a database. `cards` and `interact` are per route, because `/review` is a hand
 * list with no cards on it.
 */
const JOURNEYS = [
  { key: 'learn', title: 'Learn', routes: [{ path: '/learn' }] },
  { key: 'practice', title: 'Guided practice', routes: [{ path: '/learn/pot-odds' }] },
  {
    key: 'table',
    title: 'Poker table and Coach',
    routes: [
      { path: '/play?state=decision', cards: true, interact: true },
      { path: '/play?state=complete', cards: true },
    ],
  },
  {
    key: 'lab',
    title: 'Scenario Lab',
    routes: [{ path: '/lab' }, { path: '/lab/fl-same-cards-under-the-gun' }],
  },
  {
    key: 'legends',
    title: 'AI Legends',
    routes: [{ path: '/legends' }, { path: '/legends/adaptive-exploiter' }],
  },
  {
    key: 'review',
    title: 'Hand review',
    routes: [{ path: '/review' }, { path: '/legends/hand-review/demo', cards: true }],
  },
];

/**
 * The h1 of this app's error boundaries. They return HTTP 200, so a route that rendered one is
 * refused rather than audited. A stale server once produced a confident pass over the error page.
 */
const ERROR_BOUNDARY_HEADINGS = [
  /^this screen did not load$/iu,
  /^the application could not be displayed$/iu,
  /^page not found$/iu,
  /could not be loaded$/iu,
  /^this replay needs a session$/iu,
];

const JOURNEY_KEYS_FOR_HELP = JOURNEYS.map((journey) => journey.key).join(', ');

const EXPECTED_LIVE_REGIONS = [{ politeness: 'polite', atLeast: 1 }];

/**
 * A second web app whose `PRL_API_ORIGIN` points at nothing, for 8.2 (the web server's own fetch
 * fails). Port 1 needs root to bind, so nothing can be listening there.
 */
const OFFLINE_WEB_ORIGIN = process.env.PRL_WEB_OFFLINE_ORIGIN ?? 'http://127.0.0.1:3459';
const DEAD_API_ORIGIN = 'http://127.0.0.1:1';

/**
 * A third web app behind `scripts/review-proxy.mjs`, which flips one hex digit of one salt in the
 * real review response. It is 6.7's fixture. Other ports in use are 3000/3001 app and API, 3456 this
 * gate, 3457 test:csp, 3458/3459 age gate and 8.2, 3462 design:contrast, 3463 test:layout, 3464
 * test:keyboard.
 */
const PROXIED_WEB_ORIGIN = process.env.PRL_WEB_PROXIED_ORIGIN ?? 'http://127.0.0.1:3465';
const REVIEW_PROXY_ORIGIN = process.env.PRL_REVIEW_PROXY_ORIGIN ?? 'http://127.0.0.1:3467';

const DEFAULTS = {
  baseUrl: process.env.PRL_WEB_ORIGIN ?? 'http://127.0.0.1:3000',
  apiUrl: process.env.PRL_API_ORIGIN ?? 'http://127.0.0.1:3001',
  offlineUrl: OFFLINE_WEB_ORIGIN,
  proxiedUrl: PROXIED_WEB_ORIGIN,
  proxyUrl: REVIEW_PROXY_ORIGIN,
  start: false,
  withApi: false,
  headful: false,
  readyTimeoutSeconds: 120,
  journeys: [],
  assertions: [],
  skipJourneys: false,
  skipAssertions: false,
  json: null,
};

const ASSERTION_KEYS_FOR_HELP = ASSERTION_ROUTES.map((route) => route.key).join(', ');

const HELP = `
${bold('pnpm run test:ax')} — accessibility-TREE audit, in real Chrome

  ${yellow('This walks the COMPUTED ACCESSIBILITY TREE — the data a screen reader consumes.')}
  ${yellow('It is NOT a screen-reader test and does not substitute for one. The manual')}
  ${yellow('procedure is docs/production/accessibility-certification.md.')}

  Server
    --base-url <url>      web app origin                   (default ${DEFAULTS.baseUrl})
    --api-url <url>       API origin                       (default ${DEFAULTS.apiUrl})
    --offline-url <url>   where the second web app, the one with no API behind it, is put
                          for assertion 8.2                (default ${DEFAULTS.offlineUrl})
    --proxied-url <url>   where the third web app, the one behind the corrupting proxy, is put
                          for assertion 6.7                (default ${DEFAULTS.proxiedUrl})
    --proxy-url <url>     where that proxy listens          (default ${DEFAULTS.proxyUrl})
    --start               start the web app rather than using one already running
    --with-api            also start the API (only with --start)
    --ready-timeout <s>   how long to wait for a server    (default ${DEFAULTS.readyTimeoutSeconds})

  Scope
    --journeys <a,b,c>    audit only these journey keys    (default: all)
                          ${JOURNEY_KEYS_FOR_HELP}
    --assertions <a,b,c>  run only these certification pages (default: all)
                          ${ASSERTION_KEYS_FOR_HELP}
    --no-journeys         skip the per-journey tree audit
    --no-assertions       skip the certification assertions

  Reporting
    --headful             run Chrome with a window, to watch it
    --json <file>         also write the findings as JSON
    -h, --help            this text

  Exits 0 when every check passed, 1 on any failure or unreachable route.
`;

function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run test:ax -- --headful` passes the `--` through.
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
      case '--with-api':
        options.withApi = true;
        break;
      case '--headful':
        options.headful = true;
        break;
      case '--base-url':
        options.baseUrl = need();
        break;
      case '--api-url':
        options.apiUrl = need();
        break;
      case '--offline-url':
        options.offlineUrl = need();
        break;
      case '--proxied-url':
        options.proxiedUrl = need();
        break;
      case '--proxy-url':
        options.proxyUrl = need();
        break;
      case '--json':
        options.json = need();
        break;
      case '--ready-timeout':
        options.readyTimeoutSeconds = Number(need());
        break;
      case '--journeys':
        options.journeys = need()
          .split(',')
          .map((key) => key.trim())
          .filter((key) => key.length > 0);
        break;
      case '--assertions':
        options.assertions = need()
          .split(',')
          .map((key) => key.trim())
          .filter((key) => key.length > 0);
        break;
      case '--no-journeys':
        options.skipJourneys = true;
        break;
      case '--no-assertions':
        options.skipAssertions = true;
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!Number.isInteger(options.readyTimeoutSeconds) || options.readyTimeoutSeconds < 1) {
    throw new Error('--ready-timeout must be a positive whole number of seconds');
  }
  if (options.withApi && !options.start) {
    throw new Error('--with-api only means anything with --start; without it there is no API to start');
  }
  const known = new Set(JOURNEYS.map((journey) => journey.key));
  for (const key of options.journeys) {
    if (!known.has(key)) {
      throw new Error(`no journey named "${key}" (known: ${[...known].join(', ')})`);
    }
  }
  const knownAssertions = new Set(ASSERTION_ROUTES.map((route) => route.key));
  for (const key of options.assertions) {
    if (!knownAssertions.has(key)) {
      throw new Error(`no assertion page named "${key}" (known: ${[...knownAssertions].join(', ')})`);
    }
  }
  if (options.skipJourneys && options.skipAssertions) {
    throw new Error('--no-journeys and --no-assertions together leave nothing to audit');
  }
  return options;
}

/**
 * Roles that must carry a computed name. `image` is absent because a decorative image is reported as
 * ignored. `option` is absent because it takes its name from its own contents.
 */
export const NAMED_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'radio',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
]);

export const REQUIRED_LANDMARKS = [
  { role: 'banner', min: 1, max: 1 },
  // `/review` adds two uniquely named navs. Uniqueness is checked below.
  { role: 'navigation', min: 1, max: 5 },
  { role: 'main', min: 1, max: 1 },
  { role: 'contentinfo', min: 1, max: 1 },
];

// Shared with assertion 3.8 so the two leak checks use one word list.
export { CARD_VALUE_WORDS };

const roleOf = (node) => (node.role?.value ?? '').toString().toLowerCase();
const nameOf = (node) => (node.name?.value ?? '').toString().trim();

export function axProperty(node, name) {
  const found = (node.properties ?? []).find((property) => property.name === name);
  return found === undefined ? undefined : found.value?.value;
}

// Document order comes from walking `childIds` from the root, not from array order.
export function indexAxTree(nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const childOf = new Set();
  for (const node of nodes) for (const id of node.childIds ?? []) childOf.add(id);
  const roots = nodes.filter((node) => !childOf.has(node.nodeId));
  const order = [];
  const seen = new Set();
  const visit = (node) => {
    if (node === undefined || seen.has(node.nodeId)) return;
    seen.add(node.nodeId);
    order.push(node);
    for (const id of node.childIds ?? []) visit(byId.get(id));
  };
  for (const root of roots) visit(root);
  // Audit nodes the walk never reached too, so a detached fragment is not silently dropped.
  for (const node of nodes) visit(node);
  return { byId, roots, order };
}

function isHidden(node) {
  return axProperty(node, 'hidden') === true || axProperty(node, 'hiddenRoot') === true;
}

// Returns counts as well as findings, so "nothing wrong" differs from "nothing examined".
export function auditAxTree(nodes) {
  const { order } = indexAxTree(nodes);
  const findings = [];
  const counts = { nodes: nodes.length, interactive: 0, headings: 0, landmarks: 0, liveRegions: 0 };
  const report = (check, detail, node) => {
    findings.push({
      check,
      detail,
      role: node === undefined ? null : roleOf(node),
      name: node === undefined ? null : nameOf(node),
    });
  };

  const live = order.filter(
    (node) => !node.ignored && ['polite', 'assertive'].includes(String(axProperty(node, 'live') ?? '')),
  );
  counts.liveRegions = live.length;

  for (const node of order) {
    if (node.ignored || isHidden(node)) continue;
    const role = roleOf(node);
    if (!NAMED_ROLES.has(role)) continue;
    counts.interactive += 1;
    if (nameOf(node).length === 0) {
      report(
        'accessible-name',
        `a ${role} has no computed accessible name, so it is announced as "${role}" and nothing else`,
        node,
      );
    }
  }

  const headings = order
    .filter((node) => !node.ignored && !isHidden(node) && roleOf(node) === 'heading')
    .map((node) => ({ node, level: Number(axProperty(node, 'level') ?? 0) }));
  counts.headings = headings.length;

  const levelOnes = headings.filter((heading) => heading.level === 1);
  if (levelOnes.length !== 1) {
    report(
      'one-h1',
      `the page has ${levelOnes.length} level-1 heading(s); a route owns exactly one, and the ` +
        'shell owns none',
    );
  }
  let previous = null;
  for (const heading of headings) {
    if (heading.level < 1 || heading.level > 6) {
      report('heading-level', `a heading reports level ${heading.level}`, heading.node);
      continue;
    }
    if (previous !== null && heading.level > previous + 1) {
      report(
        'heading-order',
        `heading level jumps from ${previous} to ${heading.level}, so a reader navigating by ` +
          'heading is told a section is nested under one that does not exist',
        heading.node,
      );
    }
    previous = heading.level;
  }

  const landmarks = order.filter(
    (node) =>
      !node.ignored &&
      !isHidden(node) &&
      REQUIRED_LANDMARKS.some((required) => required.role === roleOf(node)),
  );
  counts.landmarks = landmarks.length;
  for (const required of REQUIRED_LANDMARKS) {
    const found = landmarks.filter((node) => roleOf(node) === required.role);
    if (found.length < required.min) {
      report('landmark-missing', `no ${required.role} landmark in the computed tree`);
    } else if (found.length > required.max) {
      report(
        'landmark-count',
        `${found.length} ${required.role} landmarks; at most ${required.max} is expected, and two ` +
          'of the same kind leave a reader guessing which one the rotor means',
      );
    }
    const names = found.map((node) => nameOf(node).toLowerCase());
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    for (const duplicate of new Set(duplicates)) {
      report(
        'landmark-unique',
        `two ${required.role} landmarks share the computed name "${duplicate || '(no name)'}"`,
      );
    }
  }

  return { findings, counts };
}

/**
 * The hidden-card check over `{ name, html }` pairs. The markup is checked as well as the computed
 * name, because a `data-suit` attribute can leak too. A hidden card that names nothing is a defect.
 */
export function checkHiddenCards(cards) {
  const findings = [];
  for (const card of cards) {
    const name = (card.name ?? '').trim();
    // A `notRendered` card has no box and so no name, which is not a defect. Its markup is still checked.
    const rendered = card.rendered !== false;
    if (rendered && name.length === 0) {
      findings.push({
        check: 'hidden-card-unnamed',
        detail: 'a face-down card has no computed accessible name, so its state is a visual cue only',
        role: null,
        name: null,
      });
    } else if (rendered && !/face[- ]?down|hidden|not shown/iu.test(name)) {
      findings.push({
        check: 'hidden-card-unnamed',
        detail: `a face-down card is named "${name}", which does not say that it is hidden`,
        role: null,
        name,
      });
    }
    const leak = CARD_VALUE_WORDS.exec(name);
    if (leak !== null) {
      findings.push({
        check: 'hidden-card-leak',
        detail:
          `a face-down card's accessible name contains "${leak[0]}". The server withheld this ` +
          'card; naming it in the accessibility tree discloses it to every screen-reader user',
        role: null,
        name,
      });
    }
    const inMarkup = CARD_VALUE_WORDS.exec(card.html ?? '');
    if (inMarkup !== null) {
      findings.push({
        check: 'hidden-card-leak',
        detail:
          `a face-down card's own markup contains "${inMarkup[0]}". Whether or not it is announced ` +
          'today, the value is in the page and is one ARIA change away from being read out',
        role: null,
        name,
      });
    }
  }
  return findings;
}

// `expected` is a floor, not an exact set. A page may gain a region but not lose one.
export function checkLiveRegions(nodes, expected) {
  const { order } = indexAxTree(nodes);
  const regions = order
    .filter((node) => !node.ignored)
    .map((node) => ({
      role: roleOf(node),
      name: nameOf(node),
      live: String(axProperty(node, 'live') ?? ''),
      atomic: axProperty(node, 'atomic') === true,
      hidden: isHidden(node),
    }))
    .filter((region) => region.live === 'polite' || region.live === 'assertive');

  const findings = [];
  for (const region of regions) {
    if (region.hidden) {
      findings.push({
        check: 'live-region-hidden',
        detail:
          `an ${region.live} live region is inside an aria-hidden subtree, so it is in the DOM and ` +
          'announced by nothing',
        role: region.role,
        name: region.name,
      });
    }
  }
  for (const want of expected) {
    const found = regions.filter((region) => region.live === want.politeness && !region.hidden);
    if (found.length < want.atLeast) {
      findings.push({
        check: 'live-region-missing',
        detail:
          `${found.length} ${want.politeness} live region(s) in the computed tree, expected at ` +
          `least ${want.atLeast}`,
        role: null,
        name: null,
      });
    }
  }
  return { findings, regions };
}

// Copied from `scripts/keyboard-audit.mjs` on purpose, so one gate cannot be broken by editing another.

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

  // `keyDown`, because with `rawKeyDown` Enter on a button performs no default action.
  async press(key, options = {}) {
    const KEYS = {
      Tab: { windowsVirtualKeyCode: 9, text: '\t' },
      Enter: { windowsVirtualKeyCode: 13, text: '\r' },
      Escape: { windowsVirtualKeyCode: 27 },
      ArrowRight: { windowsVirtualKeyCode: 39 },
      Home: { windowsVirtualKeyCode: 36 },
      End: { windowsVirtualKeyCode: 35 },
    };
    const spec = KEYS[key];
    if (spec === undefined) throw new Error(`no key spec for ${key}`);
    // Shift is bit 8 in CDP's modifier mask.
    const modifiers = options.shift === true ? 8 : 0;
    const base = {
      key,
      code: key,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', {
      type: spec.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...base,
      ...(spec.text === undefined ? {} : { text: spec.text, unmodifiedText: spec.text }),
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(50);
  }

  /**
   * Per-character key events. `<input type="number">` drops a non-numeric value set by `.value` or
   * `Input.insertText`, so `badInput` never becomes true. Assertion 2.6 needs the refused value.
   */
  async insertText(text) {
    for (const character of text) {
      const code = character.toUpperCase().charCodeAt(0);
      const base = {
        key: character,
        text: character,
        unmodifiedText: character,
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        modifiers: 0,
      };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await delay(30);
    }
    await delay(120);
  }

  async selectAllAndType(selector, text) {
    await this.evaluate(
      `(() => {
        const field = document.querySelector(${JSON.stringify(selector)});
        if (field === null) return;
        field.focus();
        field.select();
      })()`,
    );
    await this.insertText(text);
  }

  // A device-metrics override, because a smaller headless window does not reliably move the
  // `min-width: 860px` media query or the container query.
  async setViewport(viewport) {
    if (viewport === null || viewport === undefined) {
      await this.send('Emulation.clearDeviceMetricsOverride');
      return;
    }
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async onNewDocument(source) {
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  /**
   * Block requests matching `patterns` for this page only. This is how 3.20 sees the API down without
   * stopping the API the other assertions share. Pass `[]` to clear, and callers clear in a `finally`.
   */
  async blockUrls(patterns) {
    await this.send('Network.setBlockedURLs', { urls: patterns });
  }

  // The Chrome profile persists across runs, and a reused guest session is already seated (3.2).
  async clearCookies() {
    await this.send('Network.clearBrowserCookies');
  }

  async settle(ms) {
    await delay(ms);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const state = await this.evaluate(
        '(() => ({ ready: document.readyState, url: location.href }))()',
      ).catch(() => null);
      if (state !== null && state.ready === 'complete' && state.url.startsWith(url.split('?')[0])) {
        // Let React hydrate. Unhydrated markup is `a11y-audit.mjs`'s job.
        await delay(400);
        return;
      }
    }
    throw new Error(`${url} did not finish loading`);
  }

  async axTree() {
    const result = await this.send('Accessibility.getFullAXTree');
    return result.nodes ?? [];
  }

  async axFor(selector) {
    const doc = await this.send('DOM.getDocument', { depth: 1 });
    const found = await this.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector });
    const out = [];
    for (const nodeId of found.nodeIds ?? []) {
      const partial = await this.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const node = (partial.nodes ?? [])[0];
      const html = await this.send('DOM.getOuterHTML', { nodeId }).catch(() => ({ outerHTML: '' }));
      out.push({ node: node ?? null, html: html.outerHTML ?? '' });
    }
    return out;
  }

  // `axFor` without the outer HTML. Assertion 7.4 sweeps every ancestor of `<main>` and the footer.
  async axFlagsFor(selector) {
    const doc = await this.send('DOM.getDocument', { depth: 1 });
    const found = await this.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector });
    const out = [];
    for (const nodeId of found.nodeIds ?? []) {
      const partial = await this.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const node = (partial.nodes ?? [])[0];
      out.push({
        ignored: node === undefined || node.ignored === true,
        role: String(node?.role?.value ?? ''),
        name: String(node?.name?.value ?? '')
          .replace(/\s+/gu, ' ')
          .trim(),
      });
    }
    return out;
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
  // Offset by pid so two audits on one machine do not share a port.
  const port = 9800 + Math.floor(process.pid % 150);
  const child = spawn(
    binary,
    [
      headful ? '--no-first-run' : '--headless=new',
      `--remote-debugging-port=${port}`,
      '--user-data-dir=/tmp/prl-ax-tree-audit-profile',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--window-size=1440,900',
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
    await page.send('DOM.enable');
    // Needed for `Network.setBlockedURLs` and `Network.clearBrowserCookies`.
    await page.send('Network.enable');
    // Without it `getFullAXTree` returns an empty tree.
    await page.send('Accessibility.enable');
    // Installed before any document loads, because G9 asserts nothing is announced on a full load.
    await page.onNewDocument(ANNOUNCER_PROBE);
    // The live table replaces most of what it says a second later, so the observer must start first.
    await page.onNewDocument(SPEECH_PROBE);
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
 * Refuse to start when something already answers on a port this run will poll, because
 * `waitUntilReady` accepts any 200 and cannot tell its own child's answer from a stranger's.
 * It connects rather than binds, because on macOS a bind of 127.0.0.1 succeeds beside a wildcard
 * listener such as `next start` (Node 24.18). Only ECONNREFUSED counts as free.
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
    `${seen} on ${host}:${String(target.port)}. This run starts the server it audits there, so it ` +
      'will not score one it did not. Stop it, or pass another --base-url, --api-url, ' +
      '--offline-url, --proxied-url or --proxy-url.',
  );
}

function portFromOrigin(origin) {
  const port = new URL(origin).port;
  return port === '' ? '3000' : port;
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
      // Kept for the failure message only.
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

let passed = 0;
const failures = [];
const record = [];

const ok = (label, detail = '') => {
  passed += 1;
  record.push({ level: 'pass', label, detail });
  console.log(`  ${green('✓')} ${label}${detail === '' ? '' : ` ${dim(detail)}`}`);
};
const bad = (label, detail) => {
  failures.push(`${label} — ${detail}`);
  record.push({ level: 'fail', label, detail });
  console.log(`  ${red('✗')} ${label}\n${dim(`      ${detail}`)}`);
};
const note = (label, detail) => {
  record.push({ level: 'note', label, detail });
  console.log(`  ${yellow('!')} ${label} ${dim(detail)}`);
};
const section = (title) => console.log(`\n${bold(title)}`);

/**
 * Next 16 ships an assertive route announcer in a shadow root, and this app stands it down for a
 * polite one (`apps/web/src/components/RouteAnnouncer.tsx`). If the stand-down fails, two regions
 * announce the title and one interrupts.
 */
async function checkRouteAnnouncer(page, label) {
  const found = await page.axFor('[data-prl-route-announcer]');
  if (found.length !== 1) {
    bad(`${label}: route announcer`, `${found.length} light-DOM route announcer(s) on the page, expected 1`);
    return;
  }
  const node = found[0].node;
  if (node === null) {
    bad(`${label}: route announcer`, 'the route announcer is not in the computed accessibility tree');
    return;
  }
  const live = String(axProperty(node, 'live') ?? '');
  const role = (node.role?.value ?? '').toLowerCase();
  if (live !== 'polite') {
    bad(`${label}: route announcer`, `its computed live politeness is "${live || 'none'}", expected polite`);
  } else if (role !== 'status') {
    bad(`${label}: route announcer`, `its computed role is "${role || 'none'}", expected status`);
  } else {
    ok(`${label}: the route announcer is one polite status region in the light DOM`);
  }

  const frameworkAnnouncers = await page.evaluate(
    "document.getElementsByTagName('next-route-announcer').length",
  );
  if (frameworkAnnouncers === 0) {
    ok(`${label}: the framework's shadow-DOM announcer is stood down`, 'no duplicate announcement');
  } else {
    bad(
      `${label}: route announcer`,
      `${frameworkAnnouncers} <next-route-announcer> element(s) remain, so the page title is ` +
        'announced twice — once assertively from inside a shadow root',
    );
  }
}

// `rendered` is `ignored !== true`. The Coach outs strip is `display:none` at 1440x900, so its
// cards have no computed name and are not defects.
async function auditCards(page, label) {
  const faceDown = await page.axFor('.prl-card--face-down');
  const faceUp = await page.axFor('.prl-card:not(.prl-card--face-down)');
  if (faceDown.length === 0 && faceUp.length === 0) {
    bad(`${label}: cards`, 'no card elements on a route that is supposed to show a table');
    return;
  }
  if (faceDown.length === 0) {
    // A hand with nothing hidden proves nothing about hiding, so it is a note, not a pass.
    note(`${label}: cards`, `${faceUp.length} card(s) on screen and none face-down; nothing to prove here`);
  } else {
    const findings = checkHiddenCards(
      faceDown.map((entry) => ({
        name: (entry.node?.name?.value ?? '').toString(),
        html: entry.html,
        rendered: entry.node?.ignored !== true,
      })),
    );
    if (findings.length === 0) {
      ok(
        `${label}: every face-down card is named as hidden and names no rank or suit`,
        `${faceDown.length} checked`,
      );
    } else {
      for (const finding of findings) bad(`${label}: ${finding.check}`, finding.detail);
    }
  }

  const renderedFaceUp = faceUp.filter((entry) => entry.node?.ignored !== true);
  const unnamed = renderedFaceUp.filter((entry) => (entry.node?.name?.value ?? '').toString().trim() === '');
  if (renderedFaceUp.length > 0 && unnamed.length === 0) {
    ok(
      `${label}: every rendered face-up card has a computed name`,
      `${renderedFaceUp.length} of ${faceUp.length} in the DOM are rendered`,
    );
  } else if (unnamed.length > 0) {
    bad(`${label}: cards`, `${unnamed.length} rendered face-up card(s) have no computed accessible name`);
  }
}

// Real key events, because a synthesised click does not move focus or satisfy `:focus-visible`.
async function actAtTheTable(page, label) {
  const before = await page.evaluate(
    `[...document.querySelectorAll('[role="status"], [aria-live]')].map((el) => (el.textContent ?? '').trim()).join(' | ')`,
  );
  // Match the accessible name. `textContent` of an action button runs together as "Fold0 units".
  const target = await page.evaluate(
    `(() => {
      const named = (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').replace(/\\s+/gu, ' ').trim();
      const button = [...document.querySelectorAll('button')]
        .filter((b) => /^fold\\b/i.test(named(b)))
        .find((b) => !b.disabled);
      if (button === undefined) return null;
      button.focus();
      return named(button);
    })()`,
  );
  if (target === null) {
    bad(`${label}: interaction`, 'no enabled Fold control on a route that renders a decision');
    return;
  }
  await page.press('Enter');
  await delay(500);

  const after = await page.evaluate(
    `[...document.querySelectorAll('[role="status"], [aria-live]')].map((el) => (el.textContent ?? '').trim()).join(' | ')`,
  );
  if (after !== before) {
    ok(`${label}: acting changed what the live regions say`, `on "${target}"`);
  } else {
    bad(
      `${label}: interaction`,
      'the announcement regions are byte-identical after a decision was submitted, so a reader ' +
        'who cannot see the screen was told nothing about their own action',
    );
  }

  const nodes = await page.axTree();
  const focused = nodes.find((node) => axProperty(node, 'focused') === true && !node.ignored);
  if (focused === undefined) {
    bad(
      `${label}: interaction`,
      'nothing in the computed tree has focus after acting — the browser dropped the caret to the ' +
        'document, so a keyboard reader restarts from the top of the page',
    );
    return;
  }
  const focusedName = (focused.name?.value ?? '').toString().trim();
  const focusedRole = (focused.role?.value ?? '').toString();
  // RootWebArea is named after the page title, so a focused document always has a name. It is the
  // state where the caret was dropped, and it fails.
  if (/^(rootwebarea|webarea|document)$/iu.test(focusedRole)) {
    // Chrome 151's full tree keeps `focused` on RootWebArea after a `tabindex="-1"` landing is focused.
    // So fail only when `document.activeElement` is also the document.
    const abandoned = await page.evaluate(
      `(() => {
        const el = document.activeElement;
        return el === null || el === document.body || el === document.documentElement;
      })()`,
    );
    if (abandoned) {
      bad(
        `${label}: interaction`,
        'after acting, focus is on the document itself. The control the reader pressed disabled ' +
          'itself and the browser blurred it, so a keyboard reader is returned to the top of the ' +
          'page and a screen-reader user is told nothing about what their decision did',
      );
      return;
    }
    await page.evaluate(
      `document.activeElement && document.activeElement.setAttribute('data-prl-ax-focus', '1')`,
    );
    const partial = await page.axFor('[data-prl-ax-focus="1"]');
    const landed = partial[0]?.node ?? null;
    const landedName = (landed?.name?.value ?? '').toString().trim();
    const landedRole = (landed?.role?.value ?? '').toString();
    if (landed !== null && landedName.length > 0) {
      ok(
        `${label}: the focused node still has a computed name`,
        `${landedRole}: "${landedName}" (caret on a tabindex=-1 landing; full tree kept RootWebArea focused)`,
      );
      return;
    }
    bad(
      `${label}: interaction`,
      'document.activeElement is not the document, but it has no computed accessible name, so a ' +
        'reader whose caret was moved there would be told nothing about where they now are',
    );
    return;
  }
  if (focusedName.length > 0) {
    ok(`${label}: the focused node still has a computed name`, `${focusedRole}: "${focusedName}"`);
  } else {
    bad(
      `${label}: interaction`,
      `focus landed on a ${focusedRole} with no computed accessible name, which is announced as a ` +
        'bare role and tells the reader nothing about where they now are',
    );
  }
}

async function auditRoute(page, journey, route, baseUrl) {
  const label = `${journey.title} ${route.path}`;
  console.log(`\n  ${cyan(route.path)}`);
  await page.goto(`${baseUrl}${route.path}`);

  const nodes = await page.axTree();
  if (nodes.length === 0) {
    bad(`${label}: tree`, 'Chrome returned an empty accessibility tree for this route');
    return;
  }

  // Refuse an error boundary before any check passes against its markup.
  const heading = nodes.find(
    (node) =>
      !node.ignored && (node.role?.value ?? '') === 'heading' && Number(axProperty(node, 'level') ?? 0) === 1,
  );
  const headingName = (heading?.name?.value ?? '').toString().trim();
  if (ERROR_BOUNDARY_HEADINGS.some((pattern) => pattern.test(headingName))) {
    bad(
      `${label}: did not render`,
      `this route rendered an error boundary — its level-1 heading is "${headingName}". Nothing ` +
        'below was audited: a clean report over an error page is evidence about the error page',
    );
    return;
  }

  const { findings, counts } = auditAxTree(nodes);
  // A tree this small is a route that failed to render.
  if (counts.interactive < 3) {
    bad(
      `${label}: coverage`,
      `only ${counts.interactive} interactive node(s) in the computed tree of ${counts.nodes} nodes; ` +
        'this route did not render, so nothing below it was really checked',
    );
    return;
  }

  const byCheck = new Map();
  for (const finding of findings) {
    if (!byCheck.has(finding.check)) byCheck.set(finding.check, []);
    byCheck.get(finding.check).push(finding);
  }
  if (findings.length === 0) {
    ok(
      `${label}: names, headings and landmarks`,
      `${counts.interactive} interactive, ${counts.headings} heading(s), ${counts.landmarks} landmark(s)`,
    );
  } else {
    for (const [check, group] of byCheck) {
      for (const finding of group.slice(0, 6)) {
        const where =
          finding.role === null ? '' : ` [${finding.role}${finding.name === '' ? '' : ` "${finding.name}"`}]`;
        bad(`${label}: ${check}`, `${finding.detail}${where}`);
      }
      if (group.length > 6) {
        bad(`${label}: ${check}`, `... and ${group.length - 6} more of the same`);
      }
    }
  }

  const regions = checkLiveRegions(nodes, EXPECTED_LIVE_REGIONS);
  if (regions.findings.length === 0) {
    ok(
      `${label}: live regions`,
      regions.regions.map((region) => `${region.live}/${region.role || 'generic'}`).join(', '),
    );
  } else {
    for (const finding of regions.findings) bad(`${label}: ${finding.check}`, finding.detail);
  }

  await checkRouteAnnouncer(page, label);
  if (route.cards === true) await auditCards(page, label);
  if (route.interact === true) await actAtTheTable(page, label);
}

/**
 * The certification assertions a machine can decide. Each finding carries its ID from
 * `docs/production/accessibility-certification.md`. A page whose `gather` throws fails every
 * assertion on it, because these rows are no longer in the human session.
 */
async function runAssertions(page, context, wanted) {
  const origins = context.origins;
  for (const route of wanted) {
    section(`${route.title}  ${dim(`${route.path}${route.viewport === undefined ? '' : ' · narrow'}`)}`);
    // `null` means that server did not come up, and every check on the route fails rather than skips.
    const baseUrl = origins[route.origin ?? 'default'] ?? null;
    if (baseUrl === null) {
      for (const check of route.checks) {
        bad(
          `${check.id} — ${check.what}`,
          `this assertion runs against the "${route.origin}" server, which did not start. Nothing ` +
            'was checked; see the startup failure above',
        );
      }
      continue;
    }
    let evidence = null;
    let gatherError = null;
    try {
      await page.setViewport(route.viewport ?? null);
      await page.goto(`${baseUrl}${route.path}`);
      evidence = await route.gather(page, baseUrl, context);
    } catch (error) {
      gatherError = error instanceof Error ? error.message : String(error);
    } finally {
      // Reset the viewport even on failure, or later routes are audited at 390px.
      await page.setViewport(null).catch((error) => {
        console.log(dim(`  could not clear the viewport override: ${error.message}`));
      });
    }
    for (const check of route.checks) {
      if (gatherError !== null) {
        bad(`${check.id} — ${check.what}`, `the page could not be driven: ${gatherError}`);
        continue;
      }
      let verdict;
      try {
        verdict = check.decide(evidence);
      } catch (error) {
        verdict = { ok: false, detail: `the check threw: ${error instanceof Error ? error.message : error}` };
      }
      if (verdict.ok) ok(`${check.id} — ${check.what}`, verdict.detail);
      else bad(`${check.id} — ${check.what}`, verdict.detail);
    }
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`ax-tree-audit — ${err.message}`));
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  console.log(bold('\nPoker Risk Lab accessibility-TREE audit'));
  console.log(yellow('  The COMPUTED tree, in real Chrome — the data a screen reader consumes.'));
  console.log(yellow('  This is NOT a screen-reader test and does not substitute for one.'));
  console.log(dim(`  ${options.baseUrl}\n`));

  const servers = [];
  // Only the `finally` below closes it.
  let reviewProxy = null;
  let exitCode = 0;

  const wanted =
    options.journeys.length === 0
      ? JOURNEYS
      : JOURNEYS.filter((journey) => options.journeys.includes(journey.key));

  const wantedAssertions =
    options.assertions.length === 0
      ? ASSERTION_ROUTES
      : ASSERTION_ROUTES.filter((route) => options.assertions.includes(route.key));

  const needsOffline =
    !options.skipAssertions && wantedAssertions.some((route) => route.origin === 'offline');
  const needsProxied =
    !options.skipAssertions && wantedAssertions.some((route) => route.origin === 'proxied');

  try {
    const ours = [
      ...(options.start ? [options.baseUrl] : []),
      ...(options.start && options.withApi ? [options.apiUrl] : []),
      ...(needsOffline ? [options.offlineUrl] : []),
      ...(needsProxied ? [options.proxyUrl, options.proxiedUrl] : []),
    ];
    for (const url of ours) await refuseOccupiedPort(url);
    if (options.start) {
      if (options.withApi) {
        const api = new ManagedServer(
          'api',
          ['--filter', '@prl/api', 'start'],
          new URL('/api/v1/health', options.apiUrl).toString(),
          // Inherit DATABASE_URL from the parent. NODE_ENV=production would refuse `.env`'s development
          // secrets and the audit would score the lab error page.
          //
          // PUBLIC_WEB_ORIGIN must list this gate's origin or CORS and the WebSocket Origin check answer
          // `forbidden`. Order matters, because `config.webOrigins[0]` is the OIDC redirect target.
          // The second origin is 6.7's third web app.
          {
            PORT: portFromOrigin(options.apiUrl),
            HOST: '127.0.0.1',
            PUBLIC_WEB_ORIGIN: [new URL(options.baseUrl).origin, new URL(options.proxiedUrl).origin].join(
              ',',
            ),
          },
        );
        servers.push(api);
        console.log(dim('  starting the API...'));
        api.start();
        await api.waitUntilReady(options.readyTimeoutSeconds);
      }
      const web = new ManagedServer('web', ['--filter', '@prl/web', 'start'], options.baseUrl, {
        NODE_ENV: 'production',
        PRL_API_ORIGIN: options.apiUrl,
        PORT: portFromOrigin(options.baseUrl),
      });
      servers.push(web);
      console.log(dim('  starting the web app...'));
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

    // Started only when a route needs it. See `OFFLINE_WEB_ORIGIN`.
    const origins = { default: options.baseUrl, offline: null, proxied: null };
    if (needsOffline) {
      const offline = new ManagedServer(
        'web with no API behind it',
        ['--filter', '@prl/web', 'start'],
        options.offlineUrl,
        {
          NODE_ENV: 'production',
          PRL_API_ORIGIN: DEAD_API_ORIGIN,
          PORT: portFromOrigin(options.offlineUrl),
        },
      );
      servers.push(offline);
      console.log(dim('  starting a second web app with no API behind it, for 8.2...'));
      offline.start();
      try {
        await offline.waitUntilReady(options.readyTimeoutSeconds);
        origins.offline = options.offlineUrl;
      } catch (error) {
        // Recorded, not fatal. This server is a fixture for one assertion.
        bad(
          'offline web app',
          `${error instanceof Error ? error.message : String(error)}. 8.2 cannot be checked without it`,
        );
      }
    }

    // Same terms as the second web app. See `PROXIED_WEB_ORIGIN`.
    if (needsProxied) {
      try {
        reviewProxy = await startReviewProxy({
          upstream: options.apiUrl,
          host: new URL(options.proxyUrl).hostname,
          port: Number(new URL(options.proxyUrl).port),
        });
        console.log(dim(`  starting a corrupting pass-through proxy at ${reviewProxy.origin}, for 6.7...`));
      } catch (error) {
        bad(
          'review proxy',
          `${error instanceof Error ? error.message : String(error)}. 6.7 cannot be checked without it`,
        );
      }
      if (reviewProxy !== null) {
        const proxied = new ManagedServer(
          'web behind the corrupting proxy',
          ['--filter', '@prl/web', 'start'],
          options.proxiedUrl,
          {
            NODE_ENV: 'production',
            PRL_API_ORIGIN: reviewProxy.origin,
            PORT: portFromOrigin(options.proxiedUrl),
          },
        );
        servers.push(proxied);
        console.log(dim('  starting a third web app behind that proxy, for 6.7...'));
        proxied.start();
        try {
          await proxied.waitUntilReady(options.readyTimeoutSeconds);
          origins.proxied = options.proxiedUrl;
        } catch (error) {
          bad(
            'proxied web app',
            `${error instanceof Error ? error.message : String(error)}. 6.7 cannot be checked without it`,
          );
        }
      }
    }

    await withChrome(options.headful, async (page) => {
      if (!options.skipJourneys) {
        for (const journey of wanted) {
          section(`${journey.title}  ${dim(journey.key)}`);
          for (const route of journey.routes) {
            try {
              await auditRoute(page, journey, route, options.baseUrl);
            } catch (error) {
              bad(
                `${journey.title} ${route.path}: audit`,
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }
      }
      if (!options.skipAssertions) {
        console.log(
          bold(`\n${'═'.repeat(70)}\nCertification assertions — the machine-checkable half of the 72`),
        );
        console.log(
          dim(
            '  docs/production/accessibility-certification.md marks each of these `auto`. A failure\n' +
              '  here is a regression in a fact one of its manual assertions rests on.',
          ),
        );
        await runAssertions(page, { origins, proxy: reviewProxy }, wantedAssertions);
      }
    });

    if (!options.skipJourneys && wanted.length === 0) {
      bad('scope', 'no journey matched, so nothing was audited');
    }
    if (!options.skipAssertions && wantedAssertions.length === 0) {
      bad('scope', 'no assertion page matched, so no certification assertion was checked');
    }
  } catch (error) {
    bad('audit', error instanceof Error ? error.message : String(error));
  } finally {
    for (const server of servers) server.stop();
    if (reviewProxy !== null) reviewProxy.close();
  }

  if (options.json !== null) {
    const outPath = resolve(REPO_ROOT, options.json);
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          tool: 'ax-tree-audit.mjs — computed accessibility tree, real Chrome',
          kind: 'accessibility-tree',
          coverageWarning:
            'This walks the computed accessibility tree. It is NOT a screen-reader test: nothing ' +
            'here proves any assistive technology speaks any of it, in what order, or ' +
            'comprehensibly. See docs/production/accessibility-certification.md.',
          baseUrl: options.baseUrl,
          generatedAt: new Date().toISOString(),
          record,
          passed: failures.length === 0,
        },
        null,
        2,
      )}\n`,
    );
    console.log(dim(`\n  findings written to ${outPath}`));
  }

  console.log(bold('\nSummary'));
  console.log(`  checks passed       ${passed}`);
  console.log(`  checks failed       ${failures.length}`);
  if (failures.length > 0) {
    console.log(bold('\n  failures'));
    for (const failure of failures) console.log(red(`    - ${failure}`));
    exitCode = 1;
  }
  if (passed === 0) {
    console.log(red(bold('\nFAIL — no check ran at all.')));
    exitCode = 1;
  } else if (exitCode === 0) {
    console.log(green(bold('\nPASS — the computed accessibility tree satisfied every check above.')));
  } else {
    console.log(red(bold('\nFAIL')));
  }
  console.log(
    dim(
      '\n  Caveat, and it is the whole point of this footer: a correct accessibility tree is a\n' +
        '  NECESSARY condition for a usable screen-reader experience and not a sufficient one.\n' +
        '  This script has not heard anything. The manual certification that does is\n' +
        '  docs/production/accessibility-certification.md, and it is recorded there as UNVERIFIED\n' +
        '  on the machine this was written on.\n',
    ),
  );

  process.exit(exitCode);
}

if (import.meta.main) await main();
