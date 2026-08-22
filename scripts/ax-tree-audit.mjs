#!/usr/bin/env node
/**
 * The COMPUTED ACCESSIBILITY TREE of this app, walked in real Chrome, per journey.
 *
 * This is what `pnpm run test:ax` does.
 *
 * ## What this is, said plainly
 *
 * The accessibility tree is the data structure a screen reader actually consumes: role, computed
 * name, computed description, state, and the live-region properties, after ARIA, after CSS, after
 * hydration, after `aria-labelledby` has been resolved across the document. This script asks Chrome
 * for it (`Accessibility.getFullAXTree`) and asserts things about it.
 *
 * **It is NOT a screen-reader test and it does not substitute for one.** Nothing here proves that
 * VoiceOver, NVDA, JAWS, Orca or TalkBack *speaks* any of it, in what order, at what verbosity, or
 * whether the result is comprehensible to a person. A correct accessibility tree is a necessary
 * condition for a usable screen-reader experience and nowhere near a sufficient one. The manual
 * procedure that settles the sufficient half is `docs/production/accessibility-certification.md`,
 * and on the machine this was written on that procedure is recorded as BLOCKED and UNVERIFIED, with
 * the specific reasons.
 *
 * ## The defect this exists for
 *
 * `scripts/a11y-audit.mjs` parses server-rendered HTML and says so at length; `scripts/keyboard-audit.mjs`
 * drives real keys. Between them they cover markup and the keyboard, and both are blind to the one
 * thing a screen reader reads. Concretely, every one of these is invisible to both and is checked
 * here:
 *
 *   - a control whose name comes from CSS-hidden text, or from an `aria-labelledby` pointing at a
 *     node that only exists after hydration, or from nothing at all once the browser has computed it;
 *   - a live region whose politeness is not what the markup implies, or that a wrapper has made
 *     `aria-hidden`, or that lives inside a shadow root where a light-DOM scan cannot see it;
 *   - a heading outline that is only correct in the source order the server sent;
 *   - **a hidden card whose rank or suit reaches the accessibility tree.** That is a
 *     hidden-information failure before it is an accessibility one: a face-down card is face-down
 *     because the server refused to send its value, and a client that puts "queen of hearts" into a
 *     computed accessible name has leaked it to anybody running a screen reader, while looking
 *     perfectly correct on screen.
 *
 * ## What is checked, per journey
 *
 *   1. every interactive node in the computed tree has a non-empty computed accessible name;
 *   2. exactly one `heading` at level 1, and no level skipped in document order;
 *   3. the required landmarks are present, and two landmarks of one role never share a name;
 *   4. the expected live regions exist, with the expected politeness and computed role, including
 *      the app's route announcer;
 *   5. every face-down card is named as hidden and names no rank and no suit — asserted against the
 *      computed name AND against the element's own markup;
 *   6. after a REAL interaction driven through Chrome's input pipeline, the announcement region's
 *      content actually changed and the focused node still has a computed accessible name.
 *
 * ## What it does NOT prove
 *
 *   - That any screen reader announces any of it. See above; this is the whole reason the manual
 *     certification document exists.
 *   - Colour contrast, focus visibility, focus order or keyboard operability. Contrast is
 *     `pnpm run design:contrast`; the keyboard is `pnpm run test:keyboard`.
 *   - Anything about a route it could not load. A route that does not render is a failure here, not
 *     something to audit around, for the same reason `a11y-audit.mjs` refuses to audit an error page.
 *   - That the wording is good. "Button" is a name; it is not a useful one.
 *
 * ## Usage
 *
 *     node scripts/ax-tree-audit.mjs [--base-url http://127.0.0.1:3000] [--no-start] [--with-api]
 *                                    [--journeys learn,table] [--headful] [--json <file>]
 *
 * ## Exit codes
 *
 *   0  every check passed, or `--help`
 *   1  any check failed, any route failed to load, or Chrome could not be driven
 *
 * A skipped journey is a failure, not a warning: an audit that quietly covers four of six journeys
 * and exits 0 is how a gate stops meaning anything.
 */

import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);
const cyan = (s) => paint('36', s);

// ===========================================================================
// The journeys
//
// Declared before the options block because `--help` interpolates their keys and
// `parseArgs` validates against them, and a `const` cannot be read before its own
// declaration.
// ===========================================================================

/**
 * The six journeys the product is reviewed as, each as one or more routes.
 *
 * The fixture states of `/play` are used rather than a live socket wherever a check does not need
 * one. That is not a shortcut: `/play?state=decision` renders the same component tree the live route
 * does, with the action controls hydrated, and it renders it without a database — so this gate fails
 * on an accessibility defect and never on Postgres being down. What a live table could additionally
 * prove is covered by `scripts/keyboard-audit.mjs`, which does sit down at one.
 *
 * `cards` and `interact` are per ROUTE and not per journey, which is a correction rather than a
 * detail: they were per journey in the first version, so the hand-review journey demanded cards on
 * `/review` — the hand LIST, which has no table on it and never had — and reported a failure against
 * a page that is behaving correctly. A check that fires on a page it does not apply to teaches its
 * reader to skim past it.
 */
const JOURNEYS = [
  { key: 'learn', title: 'Learn', routes: [{ path: '/learn' }] },
  { key: 'practice', title: 'Guided practice', routes: [{ path: '/learn/pot-odds' }] },
  {
    key: 'table',
    title: 'Poker table and Coach',
    routes: [
      // The interaction check belongs to this route: acting is the app's most consequential dynamic
      // update, and it is the one the brief names. `?state=decision` is the fixture that renders a
      // table waiting on the reader, with every control hydrated and no server required.
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
    // `/review` is the hand list. The replay — and therefore the only cards in this journey — is at
    // the demo route, which renders a whole finished hand without needing one to have been played.
    routes: [{ path: '/review' }, { path: '/legends/hand-review/demo', cards: true }],
  },
];

/**
 * The level-1 headings this app's error boundaries own.
 *
 * A route that rendered one of these did not render. Auditing it produces a confident PASS over the
 * error page's own markup — which is correct markup, for a page nobody meant to test — and that is
 * strictly worse than a failure, because it reads as evidence. `scripts/a11y-audit.mjs` refuses to
 * audit a non-2xx response for the same reason; this is the client-rendered version of the same
 * refusal, and it is needed because these boundaries return HTTP 200.
 *
 * Observed for real: with six of this app's routes failing to render against a stale server, the
 * first version of this audit reported "23 interactive, 2 headings, 6 landmarks — ok" for `/review`.
 * Every one of those nodes belonged to the error boundary.
 */
const ERROR_BOUNDARY_HEADINGS = [
  /^this screen did not load$/iu,
  /^the application could not be displayed$/iu,
  /^page not found$/iu,
  /could not be loaded$/iu,
  /^this replay needs a session$/iu,
];

const JOURNEY_KEYS_FOR_HELP = JOURNEYS.map((journey) => journey.key).join(', ');

/** Live regions every route in this app is expected to expose once hydrated. */
const EXPECTED_LIVE_REGIONS = [{ politeness: 'polite', atLeast: 1 }];

// ===========================================================================
// Options
// ===========================================================================

/**
 * Defaults mirror `.env.example` and the two existing audits: the web app on 3000, the API on 3001.
 * `PRL_WEB_ORIGIN` is the variable `scripts/keyboard-audit.mjs` already honours, so a developer who
 * has set it for one audit does not have to set a second name for this one.
 */
const DEFAULTS = {
  baseUrl: process.env.PRL_WEB_ORIGIN ?? 'http://127.0.0.1:3000',
  apiUrl: process.env.PRL_API_ORIGIN ?? 'http://127.0.0.1:3001',
  start: false,
  withApi: false,
  headful: false,
  readyTimeoutSeconds: 120,
  journeys: [],
  json: null,
};

const HELP = `
${bold('pnpm run test:ax')} — accessibility-TREE audit, in real Chrome

  ${yellow('This walks the COMPUTED ACCESSIBILITY TREE — the data a screen reader consumes.')}
  ${yellow('It is NOT a screen-reader test and does not substitute for one. The manual')}
  ${yellow('procedure is docs/production/accessibility-certification.md.')}

  Server
    --base-url <url>      web app origin                   (default ${DEFAULTS.baseUrl})
    --api-url <url>       API origin                       (default ${DEFAULTS.apiUrl})
    --start               start the web app rather than using one already running
    --with-api            also start the API (only with --start)
    --ready-timeout <s>   how long to wait for a server    (default ${DEFAULTS.readyTimeoutSeconds})

  Scope
    --journeys <a,b,c>    audit only these journey keys    (default: all)
                          ${JOURNEY_KEYS_FOR_HELP}

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
    // `pnpm run test:ax -- --headful` passes the `--` through rather than swallowing it, so both
    // spellings work instead of one of them dying on "unknown option --".
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
  return options;
}

// ===========================================================================
// The checkers
//
// Pure functions over an array of CDP AXNode objects. They are exported and take
// plain data precisely so `ax-tree-audit.test.mjs` can hand them a tree with a
// nameless button and a leaked card in it and assert that they fire — a detector
// that has never been shown a violation is a detector nobody has tested.
// ===========================================================================

/**
 * Roles whose nodes must carry a computed accessible name.
 *
 * Every one of these is something a reader is asked to operate. A control with no name is announced
 * as its role alone — "button", "link", "slider" — which is the single most common way an app
 * becomes unusable non-visually while looking finished.
 *
 * `image` is deliberately absent: an image with no name may legitimately be decorative, and Chrome
 * reports a decorative one as `ignored` rather than as a nameless image. The card check below is
 * what covers the images that DO carry information here.
 *
 * `option` is absent too: it takes its name from its own contents, and an empty one is a
 * content bug rather than a naming bug, reported honestly as a different thing.
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

/** Landmark roles this app must expose, with how many of each are expected. */
export const REQUIRED_LANDMARKS = [
  { role: 'banner', min: 1, max: 1 },
  { role: 'navigation', min: 1, max: 4 },
  { role: 'main', min: 1, max: 1 },
  { role: 'contentinfo', min: 1, max: 1 },
];

/**
 * Words that must never appear in the accessible name of a card the server chose to hide.
 *
 * Ranks and suits, as `packages/ui/src/cards.ts` spells them. Matched on word boundaries so
 * "face-down card" does not trip on anything, and so a name like "Ada hole cards" is not read as a
 * leak — "cards" is not a rank.
 */
export const CARD_VALUE_WORDS =
  /\b(ace|king|queen|jack|ten|nine|eight|seven|six|five|four|three|two|deuce|hearts?|diamonds?|clubs?|spades?)\b/iu;

const roleOf = (node) => (node.role?.value ?? '').toString().toLowerCase();
const nameOf = (node) => (node.name?.value ?? '').toString().trim();

/** One AX property by name, or `undefined`. Properties are a list of `{name, value:{value}}`. */
export function axProperty(node, name) {
  const found = (node.properties ?? []).find((property) => property.name === name);
  return found === undefined ? undefined : found.value?.value;
}

/**
 * Index a flat AX node list into something walkable.
 *
 * `getFullAXTree` returns a flat array with `childIds`, so document order has to be recovered by
 * walking from the root rather than trusting array order. Heading-level checking depends on that
 * order being right, and array order is not documented to be it.
 */
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
  // A node the walk never reached (a detached fragment Chrome still reported) is still audited:
  // silently dropping nodes is how a checker reports a clean tree it never looked at.
  for (const node of nodes) visit(node);
  return { byId, roots, order };
}

/** True when this node, or an ancestor in the reported tree, is hidden from assistive technology. */
function isHidden(node) {
  return axProperty(node, 'hidden') === true || axProperty(node, 'hiddenRoot') === true;
}

/**
 * Everything wrong with one computed tree.
 *
 * Returns findings plus the counts each check actually looked at, so a caller can tell "nothing was
 * wrong" apart from "nothing was examined" — the failure mode every scan in this repo is required to
 * rule out.
 */
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

  // --- 1. names on interactive nodes ---------------------------------------
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

  // --- 2. headings ---------------------------------------------------------
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

  // --- 3. landmarks --------------------------------------------------------
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
    // Two landmarks of one role must be told apart by NAME. This is the check that a source-level
    // scan cannot make, because the name may be computed from anything.
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
 * The hidden-card check, over `{ name, html }` pairs read from the face-down cards on a page.
 *
 * Split out from `auditAxTree` because it needs the element's markup as well as its computed name:
 * a leak can arrive either way, and the markup half catches a `data-suit` or a text node that the
 * name computation happens not to include today but a future ARIA change might.
 *
 * `expectHidden` is what makes this an accessibility check as well as a security one. A card that
 * names nothing at all is not a leak and is still a defect: a reader hears an unnamed image, or
 * nothing, where a sighted reader sees a card that is deliberately face-down.
 */
export function checkHiddenCards(cards) {
  const findings = [];
  for (const card of cards) {
    const name = (card.name ?? '').trim();
    // A card Chrome reports as `notRendered` is in a `display:none` subtree — a collapsed panel, a
    // container query that does not apply at this width. It has no computed name BECAUSE it has no
    // box, which is not a naming defect. The two leak checks below still run on it, because markup
    // that is not rendered today is markup that is one CSS change away from being read out.
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

/**
 * The live-region check, over the regions found in a computed tree.
 *
 * `expected` is a list of `{ politeness, atLeast }`. It is deliberately a floor rather than an exact
 * set: this app mounts its polite regions empty from the first render (an empty region is still a
 * region in the tree), and a page may legitimately gain one. What it may not do is lose them, or
 * make one assertive that should not interrupt.
 */
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

// ===========================================================================
// A very small CDP client
//
// Lifted from `scripts/keyboard-audit.mjs` on purpose rather than shared through a
// helper module: these two scripts are release gates, and a gate that depends on a
// file another gate can change is a gate that can be broken from a distance. The
// duplication is about forty lines and it is the cheaper half of that trade.
// ===========================================================================

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
   * A real key press, through Chrome's own input pipeline.
   *
   * `keyDown` rather than `rawKeyDown` for a key that types something: with `rawKeyDown` the page
   * sees the event and the browser performs no default action, so Enter on a button does nothing at
   * all. That distinction is documented at length in `scripts/keyboard-audit.mjs` and cost a
   * debugging session there; it is repeated here so it cannot be lost by editing one file.
   */
  async press(key) {
    const KEYS = {
      Tab: { windowsVirtualKeyCode: 9, text: '\t' },
      Enter: { windowsVirtualKeyCode: 13, text: '\r' },
      Escape: { windowsVirtualKeyCode: 27 },
      ArrowRight: { windowsVirtualKeyCode: 39 },
    };
    const spec = KEYS[key];
    if (spec === undefined) throw new Error(`no key spec for ${key}`);
    const base = {
      key,
      code: key,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: 0,
    };
    await this.send('Input.dispatchKeyEvent', {
      type: spec.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...base,
      ...(spec.text === undefined ? {} : { text: spec.text, unmodifiedText: spec.text }),
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(50);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const state = await this.evaluate(
        '(() => ({ ready: document.readyState, url: location.href }))()',
      ).catch(() => null);
      if (state !== null && state.ready === 'complete' && state.url.startsWith(url.split('?')[0])) {
        // A further beat for React to hydrate. The accessibility tree of a page that has not
        // hydrated is the server's markup, which is what `a11y-audit.mjs` already covers.
        await delay(400);
        return;
      }
    }
    throw new Error(`${url} did not finish loading`);
  }

  /** The whole computed accessibility tree, shadow DOM included. */
  async axTree() {
    const result = await this.send('Accessibility.getFullAXTree');
    return result.nodes ?? [];
  }

  /** The computed AX node for one element, addressed by CSS selector. Empty when nothing matches. */
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

  close() {
    this.#socket.close();
  }
}

/** Chrome, wherever this platform keeps it. Same candidate list as the keyboard audit. */
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
  // Offset by pid so two audits on one machine do not fight over a port. Kept out of the keyboard
  // audit's range for the same reason.
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
    let version = null;
    for (let attempt = 0; attempt < 60 && version === null; attempt += 1) {
      await delay(150);
      version = await fetch(`http://127.0.0.1:${port}/json/version`)
        .then((r) => r.json())
        .catch(() => null);
    }
    if (version === null) throw new Error(`Chrome did not open a debugging port on ${port}`);
    console.log(dim(`  ${version.Browser} — ${headful ? 'headful' : 'headless'}`));

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('DOM.enable');
    // The whole point of this script. Without it `getFullAXTree` answers with an empty tree.
    await page.send('Accessibility.enable');
    try {
      await run(page);
    } finally {
      page.close();
    }
  } finally {
    child.kill('SIGTERM');
  }
}

// ===========================================================================
// Servers
// ===========================================================================

/**
 * A child server this script owns and must clean up.
 *
 * The same class, for the same reason, as `scripts/a11y-audit.mjs`: `pnpm --filter ... start` is a
 * wrapper, so killing the wrapper leaves the real server holding the port, and an orphan makes the
 * next run audit a build nobody meant to test. Detached, signalled by process group, ESRCH tolerated.
 */
/** The port `next start` should bind, taken from the origin this audit will probe. */
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
      // Kept, not printed: a healthy Next boot is twenty lines of noise, and it is only wanted when
      // the server fails to come up.
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
        // Any HTTP answer means it is listening; a 404 on the ready URL is still a live server.
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

// ===========================================================================
// Run
// ===========================================================================

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
 * The route announcer, checked as a computed node rather than as markup.
 *
 * Two halves, and the second is the one a source scan cannot make: Next 16 ships its own route
 * announcer inside a shadow root on `<next-route-announcer>`, assertive, and this app stands it down
 * in favour of a polite one in the light DOM (see `apps/web/src/components/RouteAnnouncer.tsx`). If
 * the stand-down ever stops working, the page has two regions announcing the same title and one of
 * them interrupts. That is invisible to every static check and obvious here.
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

/**
 * Every card on the page, as a computed name plus its own markup.
 *
 * `rendered` is `ignored !== true`. Chrome reports a node inside a `display:none` subtree as
 * `ignored` with reason `notRendered`, and this app has several: the Coach panel's outs strip is
 * behind a container query, so at 1440x900 fifteen perfectly well-labelled cards are in the DOM with
 * no box and therefore no computed name. Treating those as unnamed controls was the first thing this
 * check got wrong, and it would have sent somebody to "fix" markup that is already right.
 */
async function auditCards(page, label) {
  const faceDown = await page.axFor('.prl-card--face-down');
  const faceUp = await page.axFor('.prl-card:not(.prl-card--face-down)');
  if (faceDown.length === 0 && faceUp.length === 0) {
    bad(`${label}: cards`, 'no card elements on a route that is supposed to show a table');
    return;
  }
  if (faceDown.length === 0) {
    // Not a pass and not a failure of the app: a hand where nothing is hidden proves nothing about
    // hiding. Saying so is the honest report; claiming a pass here is how a check rots.
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

  // A face-up card must be named too, or the board is a row of unlabelled images.
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

/**
 * Act at the table, for real, and check what the accessibility tree says afterwards.
 *
 * Driven with a genuine `Input.dispatchKeyEvent` rather than `element.click()`: a synthesised click
 * does not satisfy `:focus-visible`, does not exercise the keyboard path, and — for the focus half
 * of this check — does not put the caret anywhere. The two assertions are the ones the brief asks
 * for and they are exactly the two that a static pass cannot make.
 */
async function actAtTheTable(page, label) {
  const before = await page.evaluate(
    `[...document.querySelectorAll('[role="status"], [aria-live]')].map((el) => (el.textContent ?? '').trim()).join(' | ')`,
  );
  /*
    Matched on the ACCESSIBLE NAME, not on `textContent`, and that is the difference between this
    check running and silently doing nothing. An action button is two spans — the word and its cost —
    so its `textContent` is the run-together string "Fold0 units", and `/^fold\b/` does not match it
    because there is no word boundary between "d" and "0". The `aria-label` is the sentence
    `ActionBar` writes for exactly this purpose: "fold, costs 0 units, gives up the hand ...".
  */
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

  // The focused node, read from the computed tree rather than from the DOM: "what has focus" and
  // "what a screen reader will say about the thing that has focus" are different questions, and this
  // is the second one.
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
  /*
    `RootWebArea` is the document itself, and it is NOT a pass however well named it is.

    This check accepted it in its first version and reported "the focused node still has a computed
    name — RootWebArea: Play — Poker Risk Lab", which is the page title: precisely the state that
    means the caret was dropped to the top of the document. Chrome names the root after the title, so
    a name test alone can never fail here. That false pass is the reason this branch exists, and it
    is the exact defect the check was written to catch — a control that disables itself on activation
    takes the caret with it.
  */
  if (/^(rootwebarea|webarea|document)$/iu.test(focusedRole)) {
    /*
      Chrome 151's full AX tree keeps `focused` on RootWebArea after a `tabindex="-1"` landing
      place is focused. Measured: document.activeElement was the named acknowledgement
      (`role="status" aria-label="Your decision is with the server"`) while getFullAXTree still
      named RootWebArea as focused. `Accessibility.getPartialAXTree` on the active element
      reports the real computed name. A RootWebArea failure is reserved for when the DOM caret
      is ALSO on the document.
    */
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

  // Did this route actually render itself, or an error boundary standing in for it? Asked before
  // anything else, because every check below would otherwise pass against the error page's markup.
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
  // The "did this actually look at anything" guard. A tree with three nodes in it is a route that
  // failed to render, and reporting "no violations" for it is the worst outcome available.
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

    const wanted =
      options.journeys.length === 0
        ? JOURNEYS
        : JOURNEYS.filter((journey) => options.journeys.includes(journey.key));

    await withChrome(options.headful, async (page) => {
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
    });

    // A journey that was asked for and produced no result at all is a failure, never a warning.
    if (wanted.length === 0) {
      bad('scope', 'no journey matched, so nothing was audited');
    }
  } catch (error) {
    bad('audit', error instanceof Error ? error.message : String(error));
  } finally {
    for (const server of servers) server.stop();
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
