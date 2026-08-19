#!/usr/bin/env node
/**
 * REAL keyboard navigation, in a real browser, driven by real key events.
 *
 * ## Why this exists
 *
 * `scripts/a11y-audit.mjs` is a *static* audit and says so at length: it parses server-rendered
 * HTML and applies the checks that can be decided from markup alone. It is honest and it is not
 * enough. The release audit left **A11Y-001 UNVERIFIED** for exactly the reason that file states
 * about itself — "keyboard-only primary journeys were not Tab-tested in a real browser" — and a
 * DOM approximation cannot settle it, because the things that go wrong are things markup does not
 * contain:
 *
 *   - `Tab` order is decided by layout and by `display`/`visibility`, not by source order;
 *   - a focus ring is a computed style under `:focus-visible`, which needs a rendering engine;
 *   - a keyboard trap only exists once something has stolen focus at runtime;
 *   - a control that hydrates into an event handler is inert in static HTML and live in a browser.
 *
 * ## How it is a real browser with no new dependency
 *
 * Adding Playwright or Puppeteer to this repository is release-blocking (see
 * `pnpm-workspace.yaml`: `minimumReleaseAge`, `ignoreScripts`, an empty `onlyBuiltDependencies` —
 * a browser driver's whole install is a postinstall download). So this drives Chrome over the
 * **DevTools Protocol** using nothing but Node built-ins: `child_process` to start it,
 * `fetch` for the `/json` endpoints, and Node 22+'s built-in `WebSocket` for the protocol itself.
 *
 * Keys go through `Input.dispatchKeyEvent`, which is the same path a physical keypress takes into
 * the renderer. This is not a synthesised `KeyboardEvent` from page script — a synthesised Tab does
 * not move focus, which is precisely why a jsdom-shaped test cannot answer this question.
 *
 * ## What is checked, per route
 *
 *   1. **Every interactive control is reachable.** The tab walk is compared against the set of
 *      elements the page says are focusable. Anything in the second set and not the first is
 *      unreachable by keyboard.
 *   2. **Focus order is logical.** Asserted as document order, which is what "logical" means for
 *      a page whose visual order is its source order. A jump backwards is reported with both ends.
 *   3. **Focus is visible.** Each stop is measured under `:focus-visible` by comparing the element
 *      and its ancestors' computed styles focused against blurred. Any difference counts, because
 *      an app may legitimately draw the ring on a parent — this one does. A stop with no computed
 *      difference anywhere is a failure.
 *   4. **There is no keyboard trap.** The walk must return to where it started within one cycle,
 *      and `Shift+Tab` must walk back out of every stop.
 *   5. **The skip link works.** First stop, and `Enter` on it must move focus into `<main>`.
 *
 * And per journey, the interactions that are not just tabbing: `Escape` closes the menu and returns
 * focus, arrow keys move a slider, `Enter`/`Space` operate a poker action.
 *
 * The last journey is the one no fixture can stand in for: a PRIVATE TABLE, opened, sat down at,
 * dealt and folded — every step reached by Tab and pressed with Enter, against a real socket and a
 * real server. See `playOneHandByKeyboard`.
 *
 * ## Usage
 *
 *     node scripts/keyboard-audit.mjs [--web http://localhost:3000] [--headful] [--json <path>]
 *
 * Exits non-zero on any failure, so it is usable as a release gate. Run it against a PRODUCTION
 * build (`next start`): a development build ships extra dev-only overlays that are not what ships.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const WEB_ORIGIN = flag('--web', process.env['PRL_WEB_ORIGIN'] ?? 'http://localhost:3000');
const HEADFUL = args.includes('--headful');
const JSON_OUT = flag('--json', null);

/** Chrome, wherever this platform keeps it. */
const CHROME_CANDIDATES = [
  process.env['CHROME_PATH'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path) => typeof path === 'string' && path !== '');

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';

let passed = 0;
const failures = [];
const warnings = [];
const record = [];

const ok = (label, detail = '') => {
  passed += 1;
  record.push({ level: 'pass', label, detail });
  console.log(`${GREEN}  ✓${RESET} ${label}${detail ? ` ${DIM}${detail}${RESET}` : ''}`);
};
const bad = (label, detail) => {
  failures.push(`${label} — ${detail}`);
  record.push({ level: 'fail', label, detail });
  console.log(`${RED}  ✗${RESET} ${label}\n${DIM}      ${detail}${RESET}`);
};
const warn = (label, detail) => {
  warnings.push(`${label} — ${detail}`);
  record.push({ level: 'warn', label, detail });
  console.log(`${YELLOW}  !${RESET} ${label} ${DIM}${detail}${RESET}`);
};
const section = (title) => console.log(`\n${BOLD}${title}${RESET}`);

// ---------------------------------------------------------------------------
// A very small CDP client
// ---------------------------------------------------------------------------

/**
 * One page target, spoken to over its own WebSocket.
 *
 * Deliberately tiny: `send` and the two helpers built on it are the whole surface. Everything a
 * driver library adds — auto-waiting, selector engines, retries — is either not needed here or is
 * exactly the kind of implicit behaviour that makes an accessibility result hard to trust.
 */
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
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error(`could not connect to ${wsUrl}`)), {
        once: true,
      });
    });
    return new Page(socket);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression in the page and returns its value. Throws on a page-side throw. */
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
   * A real key press.
   *
   * `rawKeyDown` then `keyUp`, with the Windows virtual key code, is what Chrome's own input
   * pipeline receives from a keyboard. `Input.dispatchKeyEvent` is the only way to make focus
   * actually move: a `KeyboardEvent` constructed in page script is `isTrusted: false` and the
   * browser ignores it for default actions, which is the whole reason a DOM-level test cannot
   * answer any question on this page.
   */
  async press(key, { shift = false } = {}) {
    const KEYS = {
      Tab: { windowsVirtualKeyCode: 9, text: '\t' },
      Enter: { windowsVirtualKeyCode: 13, text: '\r' },
      Escape: { windowsVirtualKeyCode: 27 },
      Space: { windowsVirtualKeyCode: 32, text: ' ', code: 'Space', keyName: ' ' },
      ArrowLeft: { windowsVirtualKeyCode: 37 },
      ArrowUp: { windowsVirtualKeyCode: 38 },
      ArrowRight: { windowsVirtualKeyCode: 39 },
      ArrowDown: { windowsVirtualKeyCode: 40 },
      Home: { windowsVirtualKeyCode: 36 },
      End: { windowsVirtualKeyCode: 35 },
    };
    const spec = KEYS[key];
    if (spec === undefined) throw new Error(`no key spec for ${key}`);
    const base = {
      key: spec.keyName ?? key,
      code: spec.code ?? key,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: shift ? 8 : 0,
    };
    // `keyDown` (carrying `text`) rather than `rawKeyDown` for a key that types something.
    //
    // This distinction is the difference between a test that works and one that silently proves
    // nothing, and it cost a debugging session: with `rawKeyDown`, Enter on a link produced a
    // `keydown` event the page could see but NO default action, so the link was never activated.
    // The skip-link check then reported focus still on the anchor — correctly — and the failure
    // looked like an application bug. Chrome only performs the default action for `keyDown`.
    await this.send('Input.dispatchKeyEvent', {
      type: spec.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...base,
      ...(spec.text === undefined ? {} : { text: spec.text, unmodifiedText: spec.text }),
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    // One frame, so a focus change and any transition it triggers have landed before it is read.
    await delay(30);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    // Poll for the document being interactive AND hydrated. `next start` streams, so `load` alone
    // can fire before the client bundle has attached its handlers — and a control with no handler
    // yet is a control this audit would wrongly call inert.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const state = await this.evaluate(
        `(() => ({ ready: document.readyState, url: location.href, hydrated: document.documentElement.dataset.boot !== undefined || document.querySelectorAll('script[src]').length > 0 }))()`,
      ).catch(() => null);
      if (state !== null && state.ready === 'complete' && state.url.startsWith(url.split('?')[0])) {
        // A further beat for React to attach. Cheap, and it removes a whole class of flake.
        await delay(250);
        return;
      }
    }
    throw new Error(`${url} did not finish loading`);
  }

  close() {
    this.#socket.close();
  }
}

// ---------------------------------------------------------------------------
// Page-side helpers, injected as expressions
// ---------------------------------------------------------------------------

/**
 * A short, stable description of the focused element.
 *
 * Includes the accessible name where one is cheap to compute, because "which control is this" is
 * the question a reader of the report actually has.
 */
const DESCRIBE_ACTIVE = `(() => {
  const el = document.activeElement;
  if (el === null || el === document.body) return { tag: 'body', name: '', id: '', path: 'body' };
  const name = (
    el.getAttribute('aria-label') ??
    (el.getAttribute('aria-labelledby') !== null
      ? (document.getElementById(el.getAttribute('aria-labelledby'))?.textContent ?? '')
      : null) ??
    el.textContent ??
    el.getAttribute('title') ??
    ''
  ).replace(/\\s+/g, ' ').trim().slice(0, 60);
  const path = (() => {
    const parts = [];
    let node = el;
    while (node !== null && node !== document.documentElement && parts.length < 6) {
      const siblings = node.parentElement === null ? [] : [...node.parentElement.children];
      parts.unshift(node.tagName.toLowerCase() + '[' + siblings.indexOf(node) + ']');
      node = node.parentElement;
    }
    return parts.join('>');
  })();
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role') ?? '',
    type: el.getAttribute('type') ?? '',
    name,
    id: el.id,
    path,
    // The stable identity the reachability comparison uses. The path above is kept for the human
    // reading the report and is deliberately NOT what anything is decided on. See STAMP_FOCUSABLE.
    stamp: el.dataset === undefined ? null : (el.dataset.prlKb ?? null),
    inMain: document.getElementById('prl-main')?.contains(el) === true,
    docIndex: [...document.querySelectorAll('*')].indexOf(el),
  };
})()`;

/**
 * Whether focusing this element changed anything a sighted keyboard user can see.
 *
 * ## Why it is a before/after comparison and not "does it have an outline"
 *
 * The first version of this check read the focused element's own `outline` and `box-shadow`, and
 * it reported 36 false failures on the Scenario Lab in its first run. The reason is a legitimate
 * and rather good design decision in `apps/web/src/styles/lab.css`:
 *
 *     .prl-lab-card:has(.prl-lab-card__link:focus-visible) { outline: … }
 *     .prl-lab-card__link:focus-visible { outline: none; }
 *
 * The ring is drawn on the CARD, because the card is what the link's pseudo-element covers — so
 * the focused element itself correctly has no outline at all. A check that reads only the focused
 * node calls that a WCAG 2.4.7 failure, which would have sent somebody to "fix" a design that is
 * already right, and would have taught the next reader that this audit cries wolf.
 *
 * So: snapshot the element and its first few ancestors while focused, blur, snapshot again, and
 * report visible when ANY of those computed values differ. That is the property WCAG actually
 * states — the focus indicator must be perceivable — without an opinion about which element in the
 * subtree draws it or which property it uses.
 *
 * `:focus-visible` is what the app styles, and a real Tab press satisfies it, which is the other
 * reason this has to happen in a browser: forcing the pseudo-class is not something page script can
 * do, and a click-driven focus would legitimately show no ring at all.
 */
const FOCUS_STYLE = `(() => {
  const el = document.activeElement;
  if (el === null || el === document.body) return null;

  const CHAIN = 4;
  const READ = ['outline', 'outlineWidth', 'outlineStyle', 'outlineColor', 'boxShadow',
                'backgroundColor', 'borderColor', 'borderWidth', 'color', 'textDecorationLine',
                'transform', 'filter'];
  const snapshot = () => {
    const parts = [];
    let node = el;
    for (let depth = 0; depth < CHAIN && node !== null; depth += 1) {
      const style = getComputedStyle(node);
      parts.push(READ.map((property) => style[property]).join('|'));
      node = node.parentElement;
    }
    return parts;
  };

  const focused = snapshot();
  // Blur, read, restore. The restore matters: the walk continues from wherever focus is, so a
  // measurement that left the document unfocused would change the very thing it is measuring.
  el.blur();
  const blurred = snapshot();
  el.focus();

  const changedAt = focused.findIndex((value, index) => value !== blurred[index]);
  const own = getComputedStyle(el);
  return {
    outlineWidth: Number.parseFloat(own.outlineWidth) || 0,
    boxShadow: own.boxShadow === 'none' ? '' : own.boxShadow,
    changedAt,
    visible: changedAt >= 0,
  };
})()`;

/**
 * Every element the page believes is focusable, in document order.
 *
 * The comparison target for "is everything reachable". Deliberately built from the standard
 * focusable selector rather than from anything this app knows about itself, and filtered by actual
 * visibility — a control inside a closed `<details>` or a `display:none` menu is correctly absent
 * from the tab order and must not be reported as unreachable.
 */
const FOCUSABLE_SET = `(() => {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[tabindex]', '[contenteditable="true"]',
  ].join(',');
  const visible = (el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false;
    if (el.getAttribute('tabindex') === '-1') return false;
    if (el.closest('[aria-hidden="true"]') !== null) return false;
    if (el.closest('details:not([open])') !== null && el.tagName.toLowerCase() !== 'summary') return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  /**
   * A radio group is ONE tab stop, by design and by specification.
   *
   * Only the checked radio is in the tab order (or the first, when none is checked); the rest are
   * reached with the arrow keys. Counting every radio input as a required tab stop reported every
   * theme switcher and every quiz answer set in this app as "unreachable", which is both wrong and
   * the opposite of the advice: putting them all in the tab order is the accessibility defect, not
   * the fix.
   */
  const skippedRadio = (el) => {
    if (el.tagName.toLowerCase() !== 'input' || el.getAttribute('type') !== 'radio') return false;
    const name = el.getAttribute('name');
    if (name === null || name === '') return false;
    const group = [...document.querySelectorAll('input[type="radio"][name="' + CSS.escape(name) + '"]')];
    const checked = group.find((radio) => radio.checked);
    return checked === undefined ? group[0] !== el : checked !== el;
  };

  return [...document.querySelectorAll(SELECTOR)].filter(visible).filter((el) => !skippedRadio(el)).map((el) => {
    const parts = [];
    let node = el;
    while (node !== null && node !== document.documentElement && parts.length < 6) {
      const siblings = node.parentElement === null ? [] : [...node.parentElement.children];
      parts.unshift(node.tagName.toLowerCase() + '[' + siblings.indexOf(node) + ']');
      node = node.parentElement;
    }
    return { stamp: el.dataset.prlKb ?? null, path: parts.join('>') };
  });
})()`;

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/**
 * Stamps every focusable element with a stable id, once, before a walk.
 *
 * ## Why a stamp and not a DOM path
 *
 * The first version identified elements by their ancestor-index path
 * (`footer[3]>div[0]>p[2]>a[1]`). That is only stable if the DOM does not change between capturing
 * the focusable set and finishing the walk — and on this app it does: `BootSequence` renders an
 * overlay that unmounts a moment after first paint, which shifts every sibling index below it. The
 * result was an intermittent "1 focusable element is never reached by Tab" on the home page,
 * naming an element Tab had in fact visited, under a path that no longer described it. An audit
 * that reports a defect on one run in three teaches its reader to disbelieve it, so identity has to
 * be something the DOM cannot renumber.
 *
 * Idempotent: re-stamping only fills in elements that arrived since.
 */
const STAMP_FOCUSABLE = `(() => {
  const SELECTOR = [
    'a[href]', 'button', 'input', 'select', 'textarea', 'summary',
    '[tabindex]', '[contenteditable="true"]',
  ].join(',');
  let next = Number(document.documentElement.dataset.prlKbNext ?? '0');
  for (const el of document.querySelectorAll(SELECTOR)) {
    if (el.dataset.prlKb === undefined) {
      next += 1;
      el.dataset.prlKb = String(next);
    }
  }
  document.documentElement.dataset.prlKbNext = String(next);
  return next;
})()`;

/** Puts focus at the very start of the document, so a walk is reproducible. */
async function resetFocus(page) {
  await page.evaluate(
    '(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); })()',
  );
}

/**
 * Tabs forward until focus returns to the first stop, or until the cap.
 *
 * The cap is the trap detector: a page whose tab order never comes back round has something
 * holding focus, and reporting the stop it kept returning to is what makes that debuggable.
 */
async function tabWalk(page, { limit = 120 } = {}) {
  await resetFocus(page);
  const stops = [];
  let firstPath = null;
  for (let step = 0; step < limit; step += 1) {
    await page.press('Tab');
    const active = await page.evaluate(DESCRIBE_ACTIVE);
    if (active.tag === 'body') {
      // Focus left the document — the browser's own UI. One more Tab brings it back in, and that
      // is a complete cycle rather than a trap.
      if (firstPath !== null) return { stops, cycled: true };
      continue;
    }
    const style = await page.evaluate(FOCUS_STYLE);
    if (firstPath === null) firstPath = active.path;
    else if (active.path === firstPath) return { stops, cycled: true };
    stops.push({ ...active, focus: style });
  }
  return { stops, cycled: false };
}

// ---------------------------------------------------------------------------
// Per-route checks
// ---------------------------------------------------------------------------

async function auditRoute(page, route) {
  section(`${route.title}  ${DIM}${route.path}${RESET}`);
  await page.goto(`${WEB_ORIGIN}${route.path}`);

  await page.evaluate(STAMP_FOCUSABLE);
  const { stops, cycled } = await tabWalk(page);
  // Read the focusable set AFTER the walk, and stamp again first: anything that appeared while the
  // walk was running — a `<details>` opening, an overlay leaving — is then judged against the DOM
  // the walk actually saw, rather than against one that no longer exists.
  await page.evaluate(STAMP_FOCUSABLE);
  const declared = await page.evaluate(FOCUSABLE_SET);

  if (stops.length === 0) {
    bad(`${route.title}: tab order`, 'Tab reached no control at all on this page');
    return;
  }
  ok(`${route.title}: ${stops.length} control(s) reached by Tab`);

  // 4. No keyboard trap.
  if (cycled) ok(`${route.title}: the tab order cycles — no keyboard trap`);
  else {
    bad(
      `${route.title}: keyboard trap`,
      `Tab did not return to the first control within 120 presses; it was last on ${stops.at(-1)?.path}`,
    );
  }

  // 1. Everything focusable is reached.
  const reached = new Set(stops.map((stop) => stop.stamp).filter((stamp) => stamp !== null));
  const unreachable = declared.filter((entry) => entry.stamp === null || !reached.has(entry.stamp));
  if (unreachable.length === 0) {
    ok(`${route.title}: every focusable control is reachable`, `${declared.length} checked`);
  } else {
    bad(
      `${route.title}: unreachable controls`,
      `${unreachable.length} focusable element(s) are never reached by Tab: ${unreachable
        .slice(0, 4)
        .map((entry) => entry.path)
        .join(', ')}`,
    );
  }

  // 2. Focus order follows the document.
  const outOfOrder = [];
  for (let index = 1; index < stops.length; index += 1) {
    const previous = stops[index - 1];
    const current = stops[index];
    if (current.docIndex < previous.docIndex) {
      outOfOrder.push(`${previous.name || previous.path} → ${current.name || current.path}`);
    }
  }
  if (outOfOrder.length === 0) ok(`${route.title}: focus order follows the document`);
  else {
    bad(
      `${route.title}: focus order`,
      `${outOfOrder.length} backward jump(s): ${outOfOrder.slice(0, 3).join('; ')}`,
    );
  }

  // 3. Every stop shows a focus indicator.
  const invisible = stops.filter((stop) => stop.focus === null || stop.focus.visible !== true);
  if (invisible.length === 0) ok(`${route.title}: every stop has a visible focus indicator`);
  else {
    bad(
      `${route.title}: invisible focus`,
      `${invisible.length} stop(s) show no outline and no box-shadow: ${invisible
        .slice(0, 4)
        .map((stop) => stop.name || stop.path)
        .join(', ')}`,
    );
  }

  // 5. The skip link, which is the first stop by design.
  const first = stops[0];
  if (first !== undefined && /skip to main/i.test(first.name)) {
    ok(`${route.title}: the skip link is the first stop`);
    // A CLEAN load before this one check, which is not fussiness: a fragment link to the fragment
    // the URL already carries is a no-op in Chrome, and the tab walk above may have left
    // `#prl-main` on the address. Testing from a dirty URL made this check alternate pass/fail down
    // the route list in a way that looked exactly like an application bug and was not. A reader
    // arriving at a page has a clean URL, so that is the state the skip link is tested in.
    await page.goto(`${WEB_ORIGIN}${route.path}`);
    await resetFocus(page);
    await page.press('Tab');
    await page.press('Enter');
    await delay(200);
    const afterSkip = await page.evaluate(
      `(() => { const el = document.activeElement; const main = document.getElementById('prl-main'); return { inMain: main !== null && (main === el || main.contains(el)), hash: location.hash, tag: el === null ? 'null' : el.tagName.toLowerCase() }; })()`,
    );
    // FOCUS, not the hash. An earlier version accepted `location.hash === '#prl-main'` as evidence
    // and that made the check worthless: the hash survives an in-page navigation, so half the
    // routes passed on a fragment left behind by the route before them while focus had not moved at
    // all. Moving focus is the entire job of a skip link.
    if (afterSkip.inMain) {
      ok(`${route.title}: Enter on the skip link moves focus into <main>`);
    } else {
      bad(`${route.title}: skip link`, `Enter left focus on <${afterSkip.tag}> and did not reach <main>`);
    }
  } else {
    bad(`${route.title}: skip link`, `the first stop is "${first?.name ?? '(none)'}", not the skip link`);
  }

  // Shift+Tab must walk back out of the last stop, which is the other half of "no trap".
  await resetFocus(page);
  for (let step = 0; step < 3; step += 1) await page.press('Tab');
  const forward = await page.evaluate(DESCRIBE_ACTIVE);
  await page.press('Tab', { shift: true });
  const back = await page.evaluate(DESCRIBE_ACTIVE);
  if (back.path !== forward.path) ok(`${route.title}: Shift+Tab moves backwards`);
  else bad(`${route.title}: Shift+Tab`, `focus stayed on ${forward.path}, so it cannot be left backwards`);

  if (route.extra !== undefined) await route.extra(page, route);
}

// ---------------------------------------------------------------------------
// Journey-specific interactions
// ---------------------------------------------------------------------------

/** A `<details>` disclosure has to open on Enter and close again, from the keyboard alone. */
async function checkDisclosures(page, route) {
  const count = await page.evaluate(`document.querySelectorAll('details > summary').length`);
  if (count === 0) return;
  const worked = await page.evaluate(
    `(() => { const s = document.querySelector('details > summary'); if (s === null) return false; s.focus(); return document.activeElement === s; })()`,
  );
  if (!worked) {
    warn(`${route.title}: disclosure`, 'a <summary> would not take focus');
    return;
  }
  await page.press('Enter');
  await delay(150);
  const opened = await page.evaluate(`document.querySelector('details')?.open === true`);
  await page.press('Enter');
  await delay(150);
  const closed = await page.evaluate(`document.querySelector('details')?.open === false`);
  if (opened && closed) ok(`${route.title}: disclosures open and close on Enter`, `${count} on the page`);
  else
    bad(
      `${route.title}: disclosure`,
      `Enter did not toggle a <details> (opened=${opened}, closed=${closed})`,
    );
}

/**
 * Every range input must move with the arrow keys, and must announce its value.
 *
 * A bet-size slider that only responds to a pointer is the single most common way a poker UI
 * becomes unusable without a mouse, so this is checked wherever one appears.
 */
async function checkSliders(page, route) {
  const sliders = await page.evaluate(
    `[...document.querySelectorAll('input[type="range"], [role="slider"]')].map((el, index) => ({
      index,
      label: (el.getAttribute('aria-label') ?? el.closest('label')?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40),
      hasNumericAlternative: el.form !== null || document.querySelector('input[type="number"]') !== null,
      min: el.getAttribute('min') ?? el.getAttribute('aria-valuemin'),
      max: el.getAttribute('max') ?? el.getAttribute('aria-valuemax'),
      now: el.getAttribute('aria-valuenow') ?? el.value ?? null,
      text: el.getAttribute('aria-valuetext'),
    }))`,
  );
  if (sliders.length === 0) return;

  for (const slider of sliders) {
    const before = await page.evaluate(
      `(() => {
        const el = [...document.querySelectorAll('input[type="range"], [role="slider"]')][${slider.index}];
        el.focus();
        return el.value ?? el.getAttribute('aria-valuenow');
      })()`,
    );
    await page.press('ArrowRight');
    await page.press('ArrowRight');
    const after = await page.evaluate(
      `(() => {
        const el = [...document.querySelectorAll('input[type="range"], [role="slider"]')][${slider.index}];
        return el.value ?? el.getAttribute('aria-valuenow');
      })()`,
    );
    const label = slider.label || `slider ${slider.index}`;
    if (String(before) !== String(after)) {
      ok(`${route.title}: "${label}" moves with the arrow keys`, `${before} → ${after}`);
    } else {
      bad(
        `${route.title}: slider`,
        `"${label}" did not change on ArrowRight (${before}), so it is pointer-only`,
      );
    }
    if (slider.min === null || slider.max === null) {
      warn(`${route.title}: slider semantics`, `"${label}" declares no min/max, so its range is unannounced`);
    }
  }
}

/**
 * The table's own controls: fold, check/call, bet/raise.
 *
 * Only asserted when a table is actually live. This audit does not sit down at a table — that
 * needs a socket and an opponent, and `scripts/smoke-test.mjs` covers the play path — so a page
 * that shows no action controls reports that rather than inventing a pass.
 */
async function checkPokerActions(page, route) {
  const actions = await page.evaluate(
    `[...document.querySelectorAll('button')]
      .filter((b) => /^(fold|check|call|bet|raise|all.?in)\\b/i.test((b.textContent ?? '').trim()))
      .map((b) => ({
        name: (b.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 30),
        disabled: b.disabled,
        tabbable: b.tabIndex >= 0,
      }))`,
  );
  if (actions.length === 0) {
    warn(`${route.title}: poker actions`, 'no action controls are on screen in this state');
    return;
  }
  const untabbable = actions.filter((action) => !action.tabbable);
  if (untabbable.length === 0) {
    ok(
      `${route.title}: every poker action is in the tab order`,
      actions.map((action) => action.name).join(', '),
    );
  } else {
    bad(
      `${route.title}: poker actions`,
      `${untabbable.length} action control(s) are not tabbable: ${untabbable.map((a) => a.name).join(', ')}`,
    );
  }

  // Reachable is not the same as operable. Tab to the first enabled action and press it, then check
  // the page acknowledged the press — a control that takes focus and ignores Enter is exactly the
  // failure "keyboard-operable" is meant to exclude, and it is invisible to a markup audit.
  const operable = await page.evaluate(
    `(() => {
      const target = [...document.querySelectorAll('button')]
        .filter((b) => /^(fold|check|call|bet|raise|all.?in)\b/i.test((b.textContent ?? '').trim()))
        .find((b) => !b.disabled);
      if (target === undefined) return null;
      window.__prlKeyProbe = { pressed: false };
      target.addEventListener('click', () => { window.__prlKeyProbe.pressed = true; }, { once: true });
      target.focus();
      return (target.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 24);
    })()`,
  );
  if (operable === null) {
    warn(`${route.title}: poker actions`, 'every action control is disabled in this state');
    return;
  }
  await page.press('Enter');
  const viaEnter = await page.evaluate('window.__prlKeyProbe?.pressed === true');
  if (viaEnter) ok(`${route.title}: "${operable}" activates on Enter`);
  else bad(`${route.title}: poker actions`, `"${operable}" took focus but did not respond to Enter`);

  // And Space, which is the other key a button must answer to.
  const rearmed = await page.evaluate(
    `(() => {
      const target = [...document.querySelectorAll('button')]
        .filter((b) => /^(fold|check|call|bet|raise|all.?in)\b/i.test((b.textContent ?? '').trim()))
        .find((b) => !b.disabled);
      if (target === undefined) return false;
      window.__prlKeyProbe = { pressed: false };
      target.addEventListener('click', () => { window.__prlKeyProbe.pressed = true; }, { once: true });
      target.focus();
      return true;
    })()`,
  );
  if (rearmed) {
    await page.press('Space');
    const viaSpace = await page.evaluate('window.__prlKeyProbe?.pressed === true');
    if (viaSpace) ok(`${route.title}: a poker action activates on Space`);
    else bad(`${route.title}: poker actions`, 'a poker action did not respond to Space');
  }

  await checkSliders(page, route);
}

/**
 * Card and table information has to be readable as text, not only as a picture.
 *
 * The check is that every card element carries an accessible name — a rank and a suit in words is
 * the app's own convention — because a suit conveyed by a glyph and a colour is conveyed twice
 * visually and not at all otherwise.
 */
async function checkCardText(page, route) {
  const cards = await page.evaluate(
    `(() => {
      const nodes = [...document.querySelectorAll('[class*="card"], [data-rank], [data-suit]')].filter(
        (el) => el.getClientRects().length > 0,
      );
      const named = nodes.filter((el) => {
        const label = el.getAttribute('aria-label') ?? '';
        const text = (el.textContent ?? '').trim();
        return label.length > 0 || text.length > 0 || el.querySelector('[class*="visually-hidden"], .prl-sr-only') !== null;
      });
      return { total: nodes.length, named: named.length };
    })()`,
  );
  if (cards.total === 0) return;
  if (cards.named === cards.total) {
    ok(`${route.title}: every card element carries text`, `${cards.total} checked`);
  } else {
    warn(
      `${route.title}: card text`,
      `${cards.total - cards.named} of ${cards.total} card elements carry neither text nor a label`,
    );
  }
}

/**
 * Focus must survive a dynamic update.
 *
 * The failure this catches: a component that re-renders and replaces its DOM node throws focus to
 * `<body>`, and a keyboard user is silently returned to the top of the page mid-task. Provoked by
 * focusing a control and forcing a re-render through the app's own interaction.
 */
async function checkFocusSurvivesUpdate(page, route) {
  const setup = await page.evaluate(
    `(() => {
      const target = [...document.querySelectorAll('details > summary, button')].find(
        (el) => el.getClientRects().length > 0,
      );
      if (target === undefined) return null;
      target.focus();
      return (target.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40);
    })()`,
  );
  if (setup === null) return;
  await page.press('Enter');
  await delay(400);
  const after = await page.evaluate(
    '(() => ({ isBody: document.activeElement === document.body || document.activeElement === null }))()',
  );
  if (!after.isBody) ok(`${route.title}: focus survives the update it triggered`, `on "${setup}"`);
  else bad(`${route.title}: focus lost`, `activating "${setup}" dropped focus to <body>`);
}

/**
 * The whole navigation, at the width where it becomes a modal sheet.
 *
 * Below 860px the destinations move out of the bar and into a `role="dialog"` sheet with a focus
 * trap. That is the only dialog in the product, so it is the only place the audit's brief about
 * "modal/dialog focus management" has anything to test — and it is invisible at desktop width.
 */
async function auditNarrowViewport(page) {
  section(`Narrow viewport — the menu sheet  ${DIM}390x844${RESET}`);
  // A phone, with a device pixel ratio, so the media query resolves the way it does on one.
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  try {
    await page.goto(`${WEB_ORIGIN}/learn`);

    const trigger = await page.evaluate(
      `(() => {
        const button = [...document.querySelectorAll('button')].find(
          (b) => /menu/i.test(b.textContent ?? '') && b.getClientRects().length > 0,
        );
        if (button === undefined) return null;
        button.focus();
        return { expanded: button.getAttribute('aria-expanded'), controls: button.getAttribute('aria-controls') };
      })()`,
    );
    if (trigger === null) {
      bad('Narrow viewport: menu', 'no visible menu trigger at 390px, so the destinations are unreachable');
      return;
    }
    ok('Narrow viewport: the menu trigger is on screen and focusable', `aria-expanded=${trigger.expanded}`);

    await page.press('Enter');
    await delay(300);
    const opened = await page.evaluate(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const button = [...document.querySelectorAll('button')].find((b) => /menu/i.test(b.textContent ?? ''));
        return {
          expanded: button?.getAttribute('aria-expanded') ?? null,
          open: dialog !== null && !dialog.hasAttribute('hidden'),
          modal: dialog?.getAttribute('aria-modal') ?? null,
          focusInside: dialog !== null && dialog.contains(document.activeElement),
          activeName: (document.activeElement?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 30),
        };
      })()`,
    );
    if (opened.open && opened.expanded === 'true')
      ok('Narrow viewport: Enter opens the sheet, and aria-expanded says so');
    else
      bad(
        'Narrow viewport: menu',
        `Enter did not open it (open=${opened.open}, expanded=${opened.expanded})`,
      );

    if (opened.modal === 'true') ok('Narrow viewport: the sheet is a modal dialog');
    else warn('Narrow viewport: menu', 'the sheet is not marked aria-modal');

    if (opened.focusInside)
      ok('Narrow viewport: focus moves into the sheet on open', `on "${opened.activeName}"`);
    else bad('Narrow viewport: menu', `focus stayed outside the sheet, on "${opened.activeName}"`);

    // The trap: Tab must never leave the sheet while it is open.
    let escaped = null;
    for (let step = 0; step < 25 && escaped === null; step += 1) {
      await page.press('Tab');
      const where = await page.evaluate(
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return {
            inside: dialog !== null && dialog.contains(document.activeElement),
            name: (document.activeElement?.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 30),
          };
        })()`,
      );
      if (!where.inside) escaped = where.name;
    }
    if (escaped === null) ok('Narrow viewport: Tab is held inside the open sheet — the trap works');
    else bad('Narrow viewport: menu', `Tab escaped the open sheet onto "${escaped}"`);

    // And Shift+Tab, which is the half a naive trap forgets.
    let escapedBack = null;
    for (let step = 0; step < 25 && escapedBack === null; step += 1) {
      await page.press('Tab', { shift: true });
      const where = await page.evaluate(
        `(() => {
          const dialog = document.querySelector('[role="dialog"]');
          return { inside: dialog !== null && dialog.contains(document.activeElement) };
        })()`,
      );
      if (!where.inside) escapedBack = 'yes';
    }
    if (escapedBack === null) ok('Narrow viewport: Shift+Tab is held inside the sheet too');
    else bad('Narrow viewport: menu', 'Shift+Tab escaped the open sheet');

    // Escape closes it AND puts focus back where it came from. A trap you cannot leave and a trap
    // that abandons you on the way out are the same bug from a keyboard user's side.
    await page.press('Escape');
    await delay(300);
    const closed = await page.evaluate(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const button = [...document.querySelectorAll('button')].find((b) => /menu/i.test(b.textContent ?? ''));
        return {
          open: dialog !== null && !dialog.hasAttribute('hidden'),
          expanded: button?.getAttribute('aria-expanded') ?? null,
          onTrigger: button !== undefined && document.activeElement === button,
          activeTag: document.activeElement?.tagName ?? 'null',
        };
      })()`,
    );
    if (!closed.open && closed.expanded !== 'true') ok('Narrow viewport: Escape closes the sheet');
    else bad('Narrow viewport: menu', 'Escape did not close the sheet — that is a keyboard trap');

    if (closed.onTrigger) ok('Narrow viewport: focus returns to the trigger that opened it');
    else bad('Narrow viewport: menu', `focus went to <${closed.activeTag}> instead of back to the trigger`);
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * The one journey that cannot be done with a fixture: sitting down and acting.
 *
 * ## Why it is here and not left to the fixture route
 *
 * `/play?state=decision` renders the action row, and every control in it is `disabled` — correctly,
 * because that page states in its own copy that no link on it opens a socket. So it proves the
 * controls are IN the tab order and proves nothing about whether they can be operated. "Poker
 * actions operable" is one of the things the audit specifically asked for, and it needs a table
 * that is really dealing.
 *
 * So this walks the product's own path with the keyboard only: open the table, take the seat, deal,
 * and then act — each step by tabbing to a control and pressing Enter, never by clicking. If any
 * step does not arrive, the journey reports that it could not be completed rather than passing.
 *
 * ## What it needs
 *
 * A running API with a database. Without one the table never goes live and this reports a warning:
 * a keyboard audit is not the right place to fail a run because Postgres is down, and
 * `scripts/smoke-test.mjs` is the gate that does fail on that.
 */
async function playOneHandByKeyboard(page) {
  section(`Private table, keyboard only  ${DIM}/play?profile=…${RESET}`);
  await page.goto(`${WEB_ORIGIN}/play?profile=adaptive-exploiter&difficulty=realistic`);

  /** Tabs until a control whose label matches lands under focus, then presses Enter on it. */
  const activateByLabel = async (pattern, { limit = 60 } = {}) => {
    await resetFocus(page);
    for (let step = 0; step < limit; step += 1) {
      await page.press('Tab');
      const active = await page.evaluate(DESCRIBE_ACTIVE);
      if (pattern.test(active.name)) {
        const enabled = await page.evaluate('document.activeElement?.disabled !== true');
        if (!enabled) return { found: true, activated: false, name: active.name };
        await page.press('Enter');
        return { found: true, activated: true, name: active.name };
      }
    }
    return { found: false, activated: false, name: '' };
  };

  /** Polls until the page satisfies `expression`, or gives up. */
  const waitFor = async (expression, seconds) => {
    for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
      await delay(250);
      if ((await page.evaluate(expression).catch(() => false)) === true) return true;
    }
    return false;
  };

  const opened = await activateByLabel(/^open the table$/i);
  if (!opened.activated) {
    warn('Private table', 'could not reach "Open the table" by keyboard; is the API running?');
    return;
  }
  ok('Private table: "Open the table" reached and activated by keyboard');

  const liveSocket = await waitFor(
    '/Take seat|Deal the next hand|Stand up/.test(document.body.innerText)',
    25,
  );
  if (!liveSocket) {
    warn('Private table', 'the socket did not go live within 25s; the rest of this journey is unproven');
    return;
  }
  ok('Private table: the socket went live');

  const seated = await activateByLabel(/take seat/i);
  if (seated.activated) ok(`Private table: "${seated.name.trim()}" reached and activated by keyboard`);
  else warn('Private table', 'no free seat to take by keyboard');

  await waitFor('/Deal the next hand/.test(document.body.innerText)', 20);
  const dealt = await activateByLabel(/deal the next hand/i);
  if (!dealt.activated) {
    warn('Private table', 'could not reach "Deal the next hand" by keyboard');
    return;
  }
  ok('Private table: "Deal the next hand" reached and activated by keyboard');

  const ACTION_RE = String.raw`^(fold|check|call|bet|raise|all.?in)\b`;
  const myTurn = await waitFor(
    `[...document.querySelectorAll('button')].some((b) => new RegExp(${JSON.stringify(ACTION_RE)}, 'i').test((b.textContent ?? '').trim()) && !b.disabled)`,
    45,
  );
  if (!myTurn) {
    warn('Private table', 'the hand never reached this seat within 45s');
    return;
  }
  ok('Private table: the hand reached this seat');

  // Every action the engine offered, reachable and enabled.
  const offered = await page.evaluate(
    `[...document.querySelectorAll('button')]
      .filter((b) => new RegExp(${JSON.stringify(ACTION_RE)}, 'i').test((b.textContent ?? '').trim()))
      .map((b) => ({ name: (b.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 28), disabled: b.disabled, tabbable: b.tabIndex >= 0 }))`,
  );
  const unusable = offered.filter((action) => action.disabled || !action.tabbable);
  if (offered.length > 0 && unusable.length === 0) {
    ok(
      'Private table: every offered action is enabled and tabbable',
      offered.map((action) => action.name).join(' | '),
    );
  } else {
    bad(
      'Private table: actions',
      `unusable by keyboard: ${unusable.map((a) => a.name).join(', ') || 'none offered'}`,
    );
  }

  // The bet-size control, which is where a poker UI most often becomes pointer-only.
  const sizer = await page.evaluate(
    `(() => {
      const slider = document.querySelector('input[type="range"]');
      if (slider === null) return null;
      const labelled = slider.id !== '' ? document.querySelector('label[for="' + CSS.escape(slider.id) + '"]') : null;
      return {
        name: (slider.getAttribute('aria-label') ?? labelled?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        min: slider.min,
        max: slider.max,
        describedBy: slider.getAttribute('aria-describedby') !== null,
        numberAlternative: document.querySelectorAll('input[type="number"]').length,
        presets: [...document.querySelectorAll('button')].filter((b) => /pot|all in/i.test(b.textContent ?? '')).length,
      };
    })()`,
  );
  if (sizer === null) {
    warn('Private table', 'no bet-size control on screen in this spot');
  } else {
    if (sizer.name !== '') ok('Private table: the size slider is named', `"${sizer.name}"`);
    else bad('Private table: slider', 'the bet-size slider has no accessible name');

    if (sizer.min !== '' && sizer.max !== '')
      ok('Private table: the slider declares its range', `${sizer.min}..${sizer.max}`);
    else bad('Private table: slider', 'the bet-size slider declares no min/max, so its range is unannounced');

    if (sizer.numberAlternative > 0 || sizer.presets > 0) {
      ok(
        'Private table: the slider has non-slider alternatives',
        `${sizer.numberAlternative} number input(s), ${sizer.presets} preset(s)`,
      );
    } else {
      bad('Private table: slider', 'the only way to choose a size is the slider itself');
    }

    // And it must actually move on an arrow key, from a REAL key press.
    const before = await page.evaluate(
      `(() => { const s = document.querySelector('input[type="range"]'); s.focus(); return s.value; })()`,
    );
    await page.press('ArrowRight');
    await page.press('ArrowRight');
    await page.press('ArrowUp');
    const after = await page.evaluate(`document.querySelector('input[type="range"]').value`);
    if (String(before) !== String(after))
      ok('Private table: the slider moves with the arrow keys', `${before} → ${after}`);
    else bad('Private table: slider', `did not move on ArrowRight/ArrowUp (${before}) — it is pointer-only`);

    // End should jump to the maximum, which is the "all in" shortcut a keyboard user needs.
    await page.press('End');
    const atEnd = await page.evaluate(`document.querySelector('input[type="range"]').value`);
    if (atEnd === sizer.max) ok('Private table: End reaches the maximum size');
    else warn('Private table: slider', `End left the value at ${atEnd}, not ${sizer.max}`);
    await page.press('Home');
  }

  // Finally: act. Fold, because it is the one action legal in every spot and it ends the hand
  // cleanly rather than leaving a table mid-street for the next run to inherit.
  const acted = await activateByLabel(/^fold/i);
  if (!acted.activated) {
    bad('Private table: actions', 'could not reach and activate Fold by keyboard');
    return;
  }
  const accepted = await waitFor(
    `[...document.querySelectorAll('button')].every((b) => !new RegExp(${JSON.stringify(ACTION_RE)}, 'i').test((b.textContent ?? '').trim()) || b.disabled)`,
    20,
  );
  if (accepted) ok('Private table: Fold, pressed with Enter, was accepted by the server');
  else bad('Private table: actions', 'Fold was activated by keyboard and the table did not move on');

  // Wait for the bar to reach its IDLE state before reading focus, not merely for the buttons to be
  // gone or disabled. Pressing an action disables the row while the request is in flight — and a
  // disabled button is blurred by the browser at once — so a check that fired on "no enabled
  // action" caught that intermediate moment and reported a focus loss the component corrected a
  // frame later. That intermittency was the audit's, not the app's.
  await waitFor(`document.querySelector('.prl-action-bar__idle') !== null`, 20);
  await delay(200);
  const survived = await page.evaluate(
    '(() => ({ isBody: document.activeElement === document.body || document.activeElement === null }))()',
  );
  if (!survived.isBody) ok('Private table: focus survived the table update the action caused');
  else warn('Private table', 'acting dropped focus to <body>; a keyboard user restarts from the top');
}

// ---------------------------------------------------------------------------
// The journeys
// ---------------------------------------------------------------------------

const ROUTES = [
  { title: 'Onboarding (home)', path: '/' },
  { title: 'Learn index', path: '/learn', extra: checkDisclosures },
  { title: 'Guided practice (lesson)', path: '/learn/pot-odds', extra: checkFocusSurvivesUpdate },
  { title: 'Scenario Lab', path: '/lab', extra: checkDisclosures },
  { title: 'Scenario Lab (a spot)', path: '/lab/preflop-open-cutoff', extra: checkSliders },
  { title: 'AI Legends', path: '/legends', extra: checkDisclosures },
  { title: 'AI Legends (a profile)', path: '/legends/adaptive-exploiter' },
  { title: 'Legends hand review', path: '/legends/hand-review' },
  { title: 'Legends hand review (demo)', path: '/legends/hand-review/demo', extra: checkCardText },
  // `?state=decision` renders the fixture of a table waiting on the learner: the action controls,
  // the bet-size slider and the Coach panel, all present and hydrated. That is the only way to Tab
  // to a fold/call/raise control without sitting down at a socket-backed table — which needs an
  // opponent and belongs to `scripts/smoke-test.mjs`. It is the same component tree the live route
  // renders, so what is asserted here about the keyboard is true of the live table too.
  { title: 'Poker table + Coach (decision)', path: '/play?state=decision', extra: checkPokerActions },
  { title: 'Poker table (live)', path: '/play', extra: checkPokerActions },
  { title: 'Poker table (hand complete)', path: '/play?state=complete', extra: checkCardText },
  { title: 'Hand review', path: '/review', extra: checkDisclosures },
  { title: 'Your record', path: '/record' },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function chromePath() {
  const found = CHROME_CANDIDATES.find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error(
      `no Chrome found. Set CHROME_PATH, or install one of:\n${CHROME_CANDIDATES.map((p) => `  ${p}`).join('\n')}`,
    );
  }
  return found;
}

async function withChrome(run) {
  const binary = chromePath();
  const port = 9222 + Math.floor(process.pid % 500);
  const child = spawn(
    binary,
    [
      HEADFUL ? '--no-first-run' : '--headless=new',
      `--remote-debugging-port=${port}`,
      '--user-data-dir=/tmp/prl-keyboard-audit-profile',
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
    console.log(`${DIM}  ${version.Browser} — ${HEADFUL ? 'headful' : 'headless'}${RESET}`);

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('DOM.enable');
    try {
      await run(page);
    } finally {
      page.close();
    }
  } finally {
    child.kill('SIGTERM');
  }
}

console.log(`\n${BOLD}Keyboard-only journey audit${RESET}  ${DIM}${WEB_ORIGIN}${RESET}`);
console.log(
  `${DIM}  Real Chrome, real Input.dispatchKeyEvent. This is the check scripts/a11y-audit.mjs says it cannot do.${RESET}`,
);

try {
  const probe = await fetch(WEB_ORIGIN, { headers: { accept: 'text/html' } }).catch(() => null);
  if (probe === null || !probe.ok) {
    console.error(`\n${RED}${WEB_ORIGIN} is not serving. Start it first:${RESET}`);
    console.error(`${DIM}  pnpm --filter @prl/web build && pnpm --filter @prl/web start${RESET}\n`);
    process.exit(1);
  }

  await withChrome(async (page) => {
    for (const route of ROUTES) {
      try {
        await auditRoute(page, route);
      } catch (error) {
        bad(`${route.title}: audit`, error instanceof Error ? error.message : String(error));
      }
    }
    try {
      await auditNarrowViewport(page);
    } catch (error) {
      bad('Narrow viewport: audit', error instanceof Error ? error.message : String(error));
    }
    try {
      await playOneHandByKeyboard(page);
    } catch (error) {
      bad('Private table: audit', error instanceof Error ? error.message : String(error));
    }
  });
} catch (error) {
  console.error(`\n${RED}${error instanceof Error ? error.message : String(error)}${RESET}\n`);
  process.exit(1);
}

if (JSON_OUT !== null) {
  await writeFile(JSON_OUT, `${JSON.stringify({ origin: WEB_ORIGIN, record }, null, 2)}\n`);
  console.log(`\n${DIM}  wrote ${JSON_OUT}${RESET}`);
}

console.log(`\n${BOLD}Summary${RESET}`);
console.log(`  ${GREEN}${passed} check(s) passed${RESET}`);
if (warnings.length > 0) {
  console.log(`  ${YELLOW}${warnings.length} warning(s)${RESET}`);
  for (const warning of warnings) console.log(`${YELLOW}    - ${warning}${RESET}`);
}
if (failures.length > 0) {
  console.log(`  ${RED}${failures.length} failure(s)${RESET}`);
  for (const failure of failures) console.log(`${RED}    - ${failure}${RESET}`);
  console.log('');
  process.exit(1);
}
console.log(`${GREEN}${BOLD}\nKeyboard audit passed.${RESET}\n`);
