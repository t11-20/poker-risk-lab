#!/usr/bin/env node
/**
 * Real keyboard navigation in real Chrome over the DevTools Protocol, with Node built-ins only
 * (`pnpm run test:keyboard`). Keys go through `Input.dispatchKeyEvent`, because a synthesised
 * `KeyboardEvent` does not move focus. Per route it checks reachability, document order, a visible
 * focus indicator, no trap and the skip link, then plays a hand at a live table by keyboard.
 *
 * `--start` uses web port 3464. The API must stay on 3001, because `apps/web/next.config.ts` freezes the
 * `/api/*` rewrite destination into `.next/routes-manifest.json` at build time, and a build without
 * `PRL_API_REWRITE_ORIGIN` points at `http://localhost:3001`.
 *
 * An age declaration cookie is seeded before the first navigation, so a gated deployment can be
 * audited as configured. Landing on `/age-check` anyway is a failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// Imported from the gate itself, so a renamed cookie cannot leave this harness seeding the old one.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MINIMUM_CEILING,
  AGE_GATE_PATH,
} from '../apps/web/src/lib/age-gate.ts';
import { waitForDevtools } from './chrome-devtools.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const WEB_ORIGIN = flag('--web', process.env['PRL_WEB_ORIGIN'] ?? 'http://localhost:3000');
const HEADFUL = args.includes('--headful');
const JSON_OUT = flag('--json', null);
const START = args.includes('--start');
const WITH_API = args.includes('--with-api');
const API_ORIGIN = flag('--api', process.env['PRL_API_ORIGIN'] ?? 'http://127.0.0.1:3001');
const READY_TIMEOUT_SECONDS = Number(flag('--ready-timeout', '120'));

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
const notApplicable = [];
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
// A check the route declares has nothing to examine. Kept out of `passed`.
const skip = (label, detail) => {
  notApplicable.push(`${label} — ${detail}`);
  record.push({ level: 'skip', label, detail });
  console.log(`${DIM}  -${RESET} ${label} ${DIM}${detail}${RESET}`);
};
const section = (title) => console.log(`\n${BOLD}${title}${RESET}`);

// Under `--start --with-api` this process owns the API, so a table that never goes live is a failure
// rather than a warning.
const OWNS_API = START && WITH_API;

const unproven = (label, detail) => {
  if (OWNS_API) bad(label, `${detail} (this run started the API itself, so there is nothing else to blame)`);
  else warn(label, detail);
};

// Segment matching, because `/age-checkers` is not the gate. Requesting the gate itself is allowed.
export function landedOnAgeGate(requestedPath, landedPath) {
  const isGate = (path) => path === AGE_GATE_PATH || path.startsWith(`${AGE_GATE_PATH}/`);
  return isGate(landedPath) && !isGate(requestedPath);
}

/**
 * `AGE_GATE_MINIMUM_CEILING` is the highest threshold the config can clamp to, so one value satisfies
 * every configuration. The `__Host-` name is seeded only over HTTPS, because Chrome refuses it
 * otherwise.
 */
export function ageDeclarationCookies(origin) {
  const url = new URL(origin);
  const secure = url.protocol === 'https:';
  return AGE_GATE_COOKIE_NAMES.filter((name) => secure || !name.startsWith('__Host-')).map((name) => ({
    url: origin,
    name,
    value: String(AGE_GATE_MINIMUM_CEILING),
    path: '/',
    secure,
  }));
}

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

  // `Input.dispatchKeyEvent` with the Windows virtual key code. A page-script event is untrusted and
  // gets no default action.
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
    // `keyDown` (carrying `text`), not `rawKeyDown`. With `rawKeyDown` Enter on a link fires `keydown`
    // but Chrome performs no default action.
    await this.send('Input.dispatchKeyEvent', {
      type: spec.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...base,
      ...(spec.text === undefined ? {} : { text: spec.text, unmodifiedText: spec.text }),
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(30);
  }

  async goto(url) {
    await this.send('Page.navigate', { url });
    const requested = new URL(url).pathname;
    // `next start` streams, so `load` can fire before the client bundle attaches its handlers.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const state = await this.evaluate(
        `(() => ({ ready: document.readyState, url: location.href, path: location.pathname, hydrated: document.documentElement.dataset.boot !== undefined || document.querySelectorAll('script[src]').length > 0 }))()`,
      ).catch(() => null);
      if (state === null || state.ready !== 'complete') continue;
      // Name the age gate's 303 here rather than timing out below.
      if (landedOnAgeGate(requested, state.path)) {
        throw new Error(
          `the age gate intercepted ${requested} and served ${AGE_GATE_PATH} instead. The audit ` +
            'will not audit the interstitial under this route’s name. The declaration cookie this ' +
            'harness seeds was refused: check PRL_AGE_GATE_MINIMUM_AGE against ' +
            `${String(AGE_GATE_MINIMUM_CEILING)}, and that the origin is not HTTPS while the profile ` +
            'holds only the unprefixed cookie name.',
        );
      }
      if (state.url.startsWith(url.split('?')[0])) {
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
 * Whether focusing this element changed anything visible. It compares the element and its first
 * few ancestors focused against blurred, because `lab.css` draws the ring on the card while the
 * focused link itself has `outline: none`. Reading only the focused node gave 36 false failures.
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

// Built from the standard focusable selector and filtered by visibility.
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

/**
 * `aria-label` first, then `textContent`. An action button's `textContent` is `Fold0 units`.
 * It runs in the page via `MATCHER_SOURCE`, so it may not reference any module-scope binding.
 */
export function actionControlName(button) {
  const label = button.getAttribute('aria-label');
  const raw = label !== null && label.trim() !== '' ? label : (button.textContent ?? '');
  return raw.replace(/\s+/gu, ' ').trim();
}

// `(?![\p{L}])` rather than `\b`, because `\b` does not match between `d` and `0` in `Fold0 units`.
export function isPokerActionName(name) {
  return /^(fold|check|call|bet|raise|all[\s-]?in)(?![\p{L}])/iu.test(name);
}

// `String(fn)`, because `\b` inside a template literal is U+0008 BACKSPACE.
const MATCHER_SOURCE = `const prlActionName = ${String(actionControlName)};
const prlIsAction = ${String(isPokerActionName)};`;

/**
 * Every `<button>` with its name and state, the size of the set examined, and the decision row as
 * `ActionBar` groups it (`.prl-action-bar__actions`). A row control the matcher does not recognise
 * fails, because the old matcher found one of three buttons and reported a pass.
 */
const ACTION_CONTROLS = `(() => {
  ${MATCHER_SOURCE}
  const buttons = [...document.querySelectorAll('button')];
  const named = buttons.map((button) => ({
    name: prlActionName(button),
    disabled: button.disabled,
    tabbable: button.tabIndex >= 0,
  }));
  const row = [...document.querySelectorAll('.prl-action-bar__actions button')];
  return {
    scanned: buttons.length,
    actions: named.filter((entry) => prlIsAction(entry.name)),
    sample: named.slice(0, 6).map((entry) => entry.name.slice(0, 40)),
    rowScanned: row.length,
    rowUnmatched: row
      .map((button) => prlActionName(button))
      .filter((name) => !prlIsAction(name))
      .map((name) => name.slice(0, 40)),
  };
})()`;

// Identity is a stamp, not a DOM path. `BootSequence` unmounts an overlay after first paint and
// shifts sibling indices. Idempotent.
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

async function resetFocus(page) {
  await page.evaluate(
    '(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); })()',
  );
}

// The cap is the trap detector.
async function tabWalk(page, { limit = 120 } = {}) {
  await resetFocus(page);
  const stops = [];
  let firstPath = null;
  for (let step = 0; step < limit; step += 1) {
    await page.press('Tab');
    const active = await page.evaluate(DESCRIBE_ACTIVE);
    if (active.tag === 'body') {
      // Focus left for the browser UI. That completes a cycle.
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

async function auditRoute(page, route) {
  section(`${route.title}  ${DIM}${route.path}${RESET}`);
  await page.goto(`${WEB_ORIGIN}${route.path}`);

  await page.evaluate(STAMP_FOCUSABLE);
  const { stops, cycled } = await tabWalk(page);
  // Re-stamp and read the set after the walk, so it matches the DOM the walk saw.
  await page.evaluate(STAMP_FOCUSABLE);
  const declared = await page.evaluate(FOCUSABLE_SET);

  if (stops.length === 0) {
    bad(`${route.title}: tab order`, 'Tab reached no control at all on this page');
    return;
  }
  ok(`${route.title}: ${stops.length} control(s) reached by Tab`);

  if (cycled) ok(`${route.title}: the tab order cycles — no keyboard trap`);
  else {
    bad(
      `${route.title}: keyboard trap`,
      `Tab did not return to the first control within 120 presses; it was last on ${stops.at(-1)?.path}`,
    );
  }

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

  const first = stops[0];
  if (first !== undefined && /skip to main/i.test(first.name)) {
    ok(`${route.title}: the skip link is the first stop`);
    // A clean load, because the walk may have left `#prl-main` on the URL and a link to the current
    // fragment is a no-op in Chrome.
    await page.goto(`${WEB_ORIGIN}${route.path}`);
    await resetFocus(page);
    await page.press('Tab');
    await page.press('Enter');
    await delay(200);
    const afterSkip = await page.evaluate(
      `(() => { const el = document.activeElement; const main = document.getElementById('prl-main'); return { inMain: main !== null && (main === el || main.contains(el)), hash: location.hash, tag: el === null ? 'null' : el.tagName.toLowerCase() }; })()`,
    );
    // Check focus, not the hash. The hash survives from the previous route.
    if (afterSkip.inMain) {
      ok(`${route.title}: Enter on the skip link moves focus into <main>`);
    } else {
      bad(`${route.title}: skip link`, `Enter left focus on <${afterSkip.tag}> and did not reach <main>`);
    }
  } else {
    bad(`${route.title}: skip link`, `the first stop is "${first?.name ?? '(none)'}", not the skip link`);
  }

  await resetFocus(page);
  for (let step = 0; step < 3; step += 1) await page.press('Tab');
  const forward = await page.evaluate(DESCRIBE_ACTIVE);
  await page.press('Tab', { shift: true });
  const back = await page.evaluate(DESCRIBE_ACTIVE);
  if (back.path !== forward.path) ok(`${route.title}: Shift+Tab moves backwards`);
  else bad(`${route.title}: Shift+Tab`, `focus stayed on ${forward.path}, so it cannot be left backwards`);

  if (route.extra !== undefined) await route.extra(page, route);
}

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

// Returns `null` when the row is present but every control is disabled.
const ARM_FIRST_ACTION = `(() => {
  ${MATCHER_SOURCE}
  const target = [...document.querySelectorAll('button')]
    .filter((button) => prlIsAction(prlActionName(button)))
    .find((button) => !button.disabled);
  if (target === undefined) return null;
  window.__prlKeyProbe = { pressed: false };
  target.addEventListener('click', () => { window.__prlKeyProbe.pressed = true; }, { once: true });
  target.focus();
  return prlActionName(target).slice(0, 40);
})()`;

/**
 * A route must declare `actionControls`. `'required'` with nothing found fails. `'until-seated'`
 * is not applicable. Each probe reloads, because `TableStage` disables the row after a press.
 */
async function checkPokerActions(page, route) {
  const expectation = route.actionControls;
  if (expectation !== 'required' && expectation !== 'until-seated') {
    bad(
      `${route.title}: poker actions`,
      'this route runs the poker-action check without declaring `actionControls`, so there is ' +
        'nothing to compare what was found against. Declare `required` or `until-seated` in ROUTES.',
    );
    return;
  }

  const found = await page.evaluate(ACTION_CONTROLS);
  const actions = found.actions;

  if (found.rowUnmatched.length > 0) {
    bad(
      `${route.title}: poker actions`,
      `the decision row holds ${found.rowUnmatched.length} control(s) this audit does not recognise ` +
        `as a poker action: ${found.rowUnmatched.join(' | ')}. Everything asserted below would be ` +
        'true of a subset of the row, which is not what it says. Fix `isPokerActionName`.',
    );
  }

  if (actions.length === 0) {
    const seen = found.sample.filter((name) => name !== '').join(' | ');
    const detail =
      `${found.scanned} button(s) examined, ${found.rowScanned} of them in a decision row, none ` +
      'named for a poker action' +
      (seen === '' ? '' : `. Names seen: ${seen}`);
    if (expectation === 'required') {
      bad(
        `${route.title}: poker actions`,
        `${detail}. This route renders the decision row, so either the row is gone (rowScanned=0) ` +
          'or the audit can no longer recognise what is in it. Both are failures; neither is an ' +
          'idle table.',
      );
    } else {
      skip(
        `${route.title}: poker actions`,
        `no seat has been taken on this route, so there is no decision to offer (${detail}). ` +
          'A live table with a seat is exercised by the private-table journey below.',
      );
    }
    return;
  }
  ok(
    `${route.title}: ${actions.length} action control(s) found among ${found.scanned} button(s)`,
    actions.map((action) => action.name.slice(0, 28)).join(' | '),
  );

  const untabbable = actions.filter((action) => !action.tabbable);
  if (untabbable.length === 0) {
    ok(
      `${route.title}: every poker action is in the tab order`,
      actions.map((action) => action.name.slice(0, 28)).join(', '),
    );
  } else {
    bad(
      `${route.title}: poker actions`,
      `${untabbable.length} action control(s) are not tabbable: ${untabbable
        .map((action) => action.name.slice(0, 28))
        .join(', ')}`,
    );
  }

  const operable = await page.evaluate(ARM_FIRST_ACTION);
  if (operable === null) {
    const detail = `all ${actions.length} action control(s) are disabled, so neither Enter nor Space was tested`;
    if (expectation === 'required') bad(`${route.title}: poker actions`, detail);
    else skip(`${route.title}: poker actions`, detail);
    return;
  }
  await page.press('Enter');
  const viaEnter = await page.evaluate('window.__prlKeyProbe?.pressed === true');
  if (viaEnter) ok(`${route.title}: "${operable}" activates on Enter`);
  else bad(`${route.title}: poker actions`, `"${operable}" took focus but did not respond to Enter`);

  // From a fresh document, because the Enter above disabled the row.
  await page.goto(`${WEB_ORIGIN}${route.path}`);
  const rearmed = await page.evaluate(ARM_FIRST_ACTION);
  if (rearmed === null) {
    bad(
      `${route.title}: poker actions`,
      'no enabled action control after reloading the route, so Space was never tested',
    );
  } else {
    await page.press('Space');
    const viaSpace = await page.evaluate('window.__prlKeyProbe?.pressed === true');
    if (viaSpace) ok(`${route.title}: "${rearmed}" activates on Space`);
    else bad(`${route.title}: poker actions`, `"${rearmed}" did not respond to Space`);
  }

  await page.goto(`${WEB_ORIGIN}${route.path}`);
  await checkSliders(page, route);
}

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

// Below 860px the destinations move into a `role="dialog"` sheet with a focus trap.
async function auditNarrowViewport(page) {
  section(`Narrow viewport — the menu sheet  ${DIM}390x844${RESET}`);
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

    // The sheet must fill the viewport: a header `backdrop-filter` can make the fixed sheet 76px tall
    // while every keyboard check passes. `elementFromPoint` checks what a tap hits.
    const geometry = await page.evaluate(
      `(() => {
        const dialog = document.querySelector('[role="dialog"]');
        if (dialog === null || dialog.hasAttribute('hidden')) return null;
        const box = dialog.getBoundingClientRect();
        const links = [...dialog.querySelectorAll('a[href]')];
        const unreachable = links.filter((link) => {
          const r = link.getBoundingClientRect();
          const x = r.left + Math.min(8, r.width / 2);
          const y = r.top + Math.min(8, r.height / 2);
          if (y >= window.innerHeight) return false;
          return !link.contains(document.elementFromPoint(x, y));
        });
        return {
          height: Math.round(box.height),
          viewport: window.innerHeight,
          links: links.length,
          firstUnreachable: unreachable[0]?.textContent.replace(/\\s+/g, ' ').trim().slice(0, 30) ?? null,
          unreachable: unreachable.length,
        };
      })()`,
    );
    if (geometry === null) bad('Narrow viewport: menu', 'the sheet was not open to measure');
    else if (geometry.links === 0) bad('Narrow viewport: menu', 'the open sheet holds no links to measure');
    else if (geometry.height < geometry.viewport - 1 || geometry.unreachable > 0)
      bad(
        'Narrow viewport: menu',
        `the open sheet is ${geometry.height}px of a ${geometry.viewport}px viewport and ` +
          `${geometry.unreachable} of ${geometry.links} on-screen links are not under the pointer ` +
          `(first: "${geometry.firstUnreachable}")`,
      );
    else
      ok(
        'Narrow viewport: the open sheet fills the viewport and every on-screen link takes a tap',
        `${geometry.height}px, ${geometry.links} links`,
      );

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

    // The units disclosure must open on screen. At 360 and 411 it began at x=-40.
    const note = await page.evaluate(
      `(() => {
        const toggle = document.querySelector('.prl-shell__header .prl-units__toggle');
        if (toggle === null || toggle.getClientRects().length === 0) return null;
        toggle.focus();
        return true;
      })()`,
    );
    if (note === null) bad('Narrow viewport: units', 'no visible units disclosure in the bar to open');
    else {
      await page.press('Enter');
      await delay(200);
      const placed = await page.evaluate(
        `(() => {
          const panel = document.querySelector('.prl-shell__header .prl-units__note');
          if (panel === null || panel.hidden) return null;
          const r = panel.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right), width: window.innerWidth };
        })()`,
      );
      if (placed === null) bad('Narrow viewport: units', 'Enter on the "i" did not open the explanation');
      else if (placed.left < 0 || placed.right > placed.width)
        bad(
          'Narrow viewport: units',
          `the explanation spans x=${placed.left} to ${placed.right} in a ${placed.width}px viewport`,
        );
      else
        ok(
          'Narrow viewport: the units explanation opens inside the viewport',
          `x=${placed.left} to ${placed.right} of ${placed.width}`,
        );

      // It must close on Escape with focus back on the `i`, measured from the page.
      if (placed !== null) {
        await page.press('Escape');
        await delay(200);
        const dismissed = await page.evaluate(
          `(() => {
            const toggle = document.querySelector('.prl-shell__header .prl-units__toggle');
            const panel = document.querySelector('.prl-shell__header .prl-units__note');
            return {
              shown: panel !== null && !panel.hidden && panel.getClientRects().length > 0,
              expanded: toggle?.getAttribute('aria-expanded') ?? null,
              onToggle: toggle !== null && document.activeElement === toggle,
              activeTag: document.activeElement?.tagName ?? 'null',
            };
          })()`,
        );
        if (dismissed.shown || dismissed.expanded !== 'false')
          bad('Narrow viewport: units', 'Escape did not close the units explanation');
        else if (!dismissed.onToggle)
          bad('Narrow viewport: units', `Escape closed it but left focus on <${dismissed.activeTag}>`);
        else ok('Narrow viewport: the units explanation closes on Escape, focus back on the "i"');
      }
    }
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * A keyboard-focused control must not land under the sticky bar. `scroll-padding-block-start` is
 * derived from `--prl-pillbar-h`, and the bar wrapped to 129px below 382px against a 92px padding.
 * 360x640 is the lowest width of the one-row band. The walk goes backwards from the bottom so every
 * stop scrolls. The skip link is excluded because it paints over the bar.
 */
async function auditStickyBarOcclusion(page) {
  section(`Narrow viewport — nothing focusable lands under the bar  ${DIM}360x640${RESET}`);
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 360,
    height: 640,
    deviceScaleFactor: 2,
    mobile: true,
  });
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  try {
    for (const path of ['/review', '/lab', '/record', '/learn/pot-odds']) {
      await page.goto(`${WEB_ORIGIN}${path}`);

      // Force instant scrolling. `reset.css` sets `scroll-behavior: smooth`, so a rectangle read after a
      // key is mid-flight. The 4px floor skips a 1px visually hidden radio that scrolls the page to y=0.
      const started = await page.evaluate(
        `(() => {
          const root = document.documentElement;
          root.style.scrollBehavior = 'auto';
          if (document.querySelector('.prl-shell__header') === null) {
            return { ok: false, why: 'no sticky bar on this page' };
          }
          window.scrollTo(0, root.scrollHeight);
          const visible = [...document.querySelectorAll(${JSON.stringify(FOCUSABLE)})].filter((element) => {
            const box = element.getBoundingClientRect();
            return box.width >= 4 && box.height >= 4;
          });
          const last = visible.at(-1);
          if (last === undefined) return { ok: false, why: 'no visible focusable control' };
          last.focus();
          window.scrollTo(0, root.scrollHeight);
          return { ok: true, scrollY: Math.round(window.scrollY), viewport: window.innerHeight };
        })()`,
      );
      if (started.ok !== true) {
        bad(`Sticky bar: ${path}`, `${started.why}, so nothing could be walked`);
        continue;
      }
      // A walk that starts at the top never scrolls. Refuse it.
      if (started.scrollY < started.viewport) {
        bad(
          `Sticky bar: ${path}`,
          `the page would not scroll to its end before the walk (scrollY ${started.scrollY}), so a ` +
            'backwards walk from here proves nothing',
        );
        continue;
      }

      const offenders = [];
      let stops = 0;
      let barHeight = 0;
      let padding = '';
      for (let step = 0; step < 45; step += 1) {
        await page.press('Tab', { shift: true });
        const stop = await page.evaluate(
          `(() => {
            const element = document.activeElement;
            const header = document.querySelector('.prl-shell__header');
            if (element === null || header === null || element === document.body) return null;
            if (header.contains(element)) return { skip: true };
            const style = getComputedStyle(element);
            // Painted OVER the bar rather than behind it — the skip link is \`position: fixed\` at
            // z 500 against the bar's 200 — so its geometry says "under" while a reader sees it.
            if (
              style.position === 'fixed' &&
              Number(style.zIndex) > Number(getComputedStyle(header).zIndex || 0)
            ) {
              return { skip: true };
            }
            const box = element.getBoundingClientRect();
            if (box.width < 4 || box.height < 4) return { skip: true };
            const bar = header.getBoundingClientRect();
            return {
              name: (element.textContent ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 44),
              top: Number(box.top.toFixed(1)),
              bottom: Number(box.bottom.toFixed(1)),
              height: Number(box.height.toFixed(1)),
              barBottom: Number(bar.bottom.toFixed(1)),
              barHeight: Number(bar.height.toFixed(1)),
              padding: getComputedStyle(document.documentElement).scrollPaddingBlockStart,
            };
          })()`,
        );
        if (stop === null) break;
        if (stop.skip === true) continue;
        stops += 1;
        barHeight = stop.barHeight;
        padding = stop.padding;
        if (stop.top < stop.barBottom - 1 && stop.bottom > 0) {
          offenders.push(stop);
        }
      }

      if (stops === 0) {
        bad(`Sticky bar: ${path}`, 'Shift+Tab reached no control outside the bar, so nothing was checked');
      } else if (offenders.length === 0) {
        ok(
          `Sticky bar: ${path} — ${stops} stop(s) walked backwards, none behind the bar`,
          `bar ${barHeight}px, scroll-padding ${padding}`,
        );
      } else {
        bad(
          `Sticky bar: ${path}`,
          `${offenders.length} of ${stops} stop(s) were scrolled to underneath the sticky bar. The ` +
            `bar is ${barHeight}px here and the root's \`scroll-padding-block-start\` is ${padding} — ` +
            'see apps/web/src/styles/nav.css. ' +
            offenders
              .slice(0, 3)
              .map(
                (o) =>
                  `"${o.name}" top=${o.top}, bar ends at ${o.barBottom} ` +
                  `(${(o.barBottom - o.top).toFixed(1)}px of a ${o.height}px control behind it)`,
              )
              .join('; '),
        );
      }
    }
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * Sits down at a real table by keyboard with "Deal me in", then acts. The fixture route only proves the
 * controls answer keys, because `TableStage` sends nothing to a server. Without an API this warns.
 */
async function playOneHandByKeyboard(page) {
  section(`Private table, keyboard only  ${DIM}/play?profile=…${RESET}`);
  await page.goto(`${WEB_ORIGIN}/play?profile=adaptive-exploiter&difficulty=realistic`);

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

  const waitFor = async (expression, seconds) => {
    for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
      await delay(250);
      if ((await page.evaluate(expression).catch(() => false)) === true) return true;
    }
    return false;
  };

  const opened = await activateByLabel(/^deal me in$/i);
  if (!opened.activated) {
    unproven('Private table', 'could not reach "Deal me in" by keyboard; is the API running?');
    return;
  }
  ok('Private table: "Deal me in" reached and activated by keyboard');

  const liveSocket = await waitFor(
    '/Take seat|Deal the next hand|Stand up/.test(document.body.innerText)',
    25,
  );
  if (!liveSocket) {
    unproven('Private table', 'the socket did not go live within 25s; the rest of this journey is unproven');
    return;
  }
  ok('Private table: the socket went live');

  // The same matchers as the per-route check, so `\b` cannot creep back in a template literal.
  const ANY_ENABLED_ACTION = `(() => {
    ${MATCHER_SOURCE}
    return [...document.querySelectorAll('button')].some(
      (button) => prlIsAction(prlActionName(button)) && !button.disabled,
    );
  })()`;
  const NO_ENABLED_ACTION = `(() => {
    ${MATCHER_SOURCE}
    return [...document.querySelectorAll('button')].every(
      (button) => !prlIsAction(prlActionName(button)) || button.disabled,
    );
  })()`;

  const myTurn = await waitFor(ANY_ENABLED_ACTION, 45);
  if (!myTurn) {
    unproven('Private table', 'the hand never reached this seat within 45s');
    return;
  }
  ok('Private table: the hand reached this seat');

  const offered = (await page.evaluate(ACTION_CONTROLS)).actions;
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

    await page.press('End');
    const atEnd = await page.evaluate(`document.querySelector('input[type="range"]').value`);
    if (atEnd === sizer.max) ok('Private table: End reaches the maximum size');
    else warn('Private table: slider', `End left the value at ${atEnd}, not ${sizer.max}`);
    await page.press('Home');
  }

  // Fold is legal in every spot and leaves no hand mid-street for the next run.
  const acted = await activateByLabel(/^fold/i);
  if (!acted.activated) {
    bad('Private table: actions', 'could not reach and activate Fold by keyboard');
    return;
  }
  const accepted = await waitFor(NO_ENABLED_ACTION, 20);
  if (accepted) ok('Private table: Fold, pressed with Enter, was accepted by the server');
  else bad('Private table: actions', 'Fold was activated by keyboard and the table did not move on');

  // Wait for the idle bar. A disabled in-flight button is blurred at once, and reading focus then
  // reported a focus loss that the component corrected a frame later.
  await waitFor(`document.querySelector('.prl-action-bar__idle') !== null`, 20);
  await delay(200);
  const survived = await page.evaluate(
    '(() => ({ isBody: document.activeElement === document.body || document.activeElement === null }))()',
  );
  if (!survived.isBody) ok('Private table: focus survived the table update the action caused');
  else warn('Private table', 'acting dropped focus to <body>; a keyboard user restarts from the top');

  await playManualStepsByKeyboard(activateByLabel, waitFor);
}

// Stand up, sit back and deal, proven between hands because "Deal me in" does all three for the
// first hand. Each run opens a fresh Legends match, so the dealt hand is left to the turn timer.
async function playManualStepsByKeyboard(activateByLabel, waitFor) {
  const between = await waitFor(
    `[...document.querySelectorAll('button')].some((b) => /^Deal the next hand$/.test(b.textContent.trim()) && !b.disabled)`,
    90,
  );
  if (!between) {
    unproven(
      'Private table',
      'the folded hand never finished, so the between-hands controls were not reached',
    );
    return;
  }

  const stood = await activateByLabel(/^stand up$/i);
  if (!stood.activated) {
    bad('Private table: manual steps', 'could not reach and activate "Stand up" by keyboard');
    return;
  }
  ok('Private table: "Stand up" reached and activated by keyboard');

  await waitFor('/Take seat \\d+/.test(document.body.innerText)', 20);
  const seated = await activateByLabel(/^take seat \d+$/i);
  if (!seated.activated) {
    bad('Private table: manual steps', 'could not reach and activate "Take seat" by keyboard');
    return;
  }
  ok(`Private table: "${seated.name.trim()}" reached and activated by keyboard`);

  await waitFor('/Deal the next hand/.test(document.body.innerText)', 20);
  const dealt = await activateByLabel(/^deal the next hand$/i);
  if (!dealt.activated) {
    bad('Private table: manual steps', 'could not reach and activate "Deal the next hand" by keyboard');
    return;
  }
  const started = await waitFor('/A hand is in progress/.test(document.body.innerText)', 20);
  if (started) ok('Private table: "Deal the next hand", pressed with Enter, dealt a hand');
  else
    bad('Private table: manual steps', '"Deal the next hand" was activated by keyboard and no hand started');
}

// `keyboard-audit.test.mjs` asserts every route wired to `checkPokerActions` declares `actionControls`.
export const ROUTES = [
  { title: 'Onboarding (home)', path: '/' },
  { title: 'Learn index', path: '/learn', extra: checkDisclosures },
  { title: 'Guided practice (lesson)', path: '/learn/pot-odds', extra: checkFocusSurvivesUpdate },
  { title: 'Scenario Lab', path: '/lab', extra: checkDisclosures },
  { title: 'Scenario Lab (a spot)', path: '/lab/fl-same-cards-under-the-gun', extra: checkSliders },
  { title: 'AI Legends', path: '/legends', extra: checkDisclosures },
  { title: 'AI Legends (a profile)', path: '/legends/adaptive-exploiter' },
  { title: 'Legends hand review', path: '/legends/hand-review' },
  { title: 'Legends hand review (demo)', path: '/legends/hand-review/demo', extra: checkCardText },
  // The fixture of a table waiting on the learner, with every control enabled. A missing decision
  // row here is a defect.
  {
    title: 'Poker table + Coach (decision)',
    path: '/play?state=decision',
    extra: checkPokerActions,
    actionControls: 'required',
  },
  // Before anybody sits there is nothing to decide. `playOneHandByKeyboard` covers the seated case.
  { title: 'Poker table (live)', path: '/play', extra: checkPokerActions, actionControls: 'until-seated' },
  { title: 'Poker table (hand complete)', path: '/play?state=complete', extra: checkCardText },
  { title: 'Hand review', path: '/review', extra: checkDisclosures },
  { title: 'Your record', path: '/record' },
];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** As `refuseOccupiedPort` in `ax-tree-audit.mjs`, which says why it connects rather than binds. */
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
    `${seen} on ${host}:${String(target.port)}. --start drives a server this run started, so it ` +
      'will not score one it did not. Stop it, pass another --web/--api, or leave out --start to ' +
      'drive that server on purpose.',
  );
}

function portFromOrigin(origin) {
  const port = new URL(origin).port;
  return port === '' ? '3000' : port;
}

/**
 * Copied on purpose so release gates fail independently. `pnpm --filter ... start` is a wrapper, so
 * the child is detached and signalled by negative pid to take the real server with it. ESRCH is fine.
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
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
        console.log(`${DIM}  could not stop ${this.label}: ${error.message}${RESET}`);
      }
    }
  }
}

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
  // A profile per run, because a shared one would carry the seeded age cookie into the next run.
  const profile = mkdtempSync(join(tmpdir(), 'prl-keyboard-audit-'));
  const child = spawn(
    binary,
    [
      HEADFUL ? '--no-first-run' : '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
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
    console.log(`${DIM}  ${version.Browser} — ${HEADFUL ? 'headful' : 'headless'}${RESET}`);

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('DOM.enable');
    // Enabled for `Network.setCookie`.
    await page.send('Network.enable');
    for (const cookie of ageDeclarationCookies(WEB_ORIGIN)) await page.send('Network.setCookie', cookie);
    try {
      await run(page);
    } finally {
      page.close();
    }
  } finally {
    child.kill('SIGTERM');
    // Chrome writes its profile as it exits, so removal retries and never fails the run.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.log(
        `${DIM}  left the browser profile at ${profile} (${error instanceof Error ? error.message : String(error)})${RESET}`,
      );
    }
  }
}

// `/play` is gated under both scopes, so one manual-redirect request answers for either.
async function probeAgeGate() {
  const response = await fetch(`${WEB_ORIGIN}/play`, {
    headers: { accept: 'text/html' },
    redirect: 'manual',
  }).catch(() => null);
  if (response === null) return false;
  if (response.status < 300 || response.status >= 400) return false;
  const location = response.headers.get('location') ?? '';
  return landedOnAgeGate('/play', new URL(location, WEB_ORIGIN).pathname);
}

async function main() {
  console.log(`\n${BOLD}Keyboard-only journey audit${RESET}  ${DIM}${WEB_ORIGIN}${RESET}`);
  console.log(
    `${DIM}  Real Chrome, real Input.dispatchKeyEvent. This is the check scripts/a11y-audit.mjs says it cannot do.${RESET}`,
  );

  // `--with-api` without `--start` would do nothing, so refuse it.
  if (WITH_API && !START) {
    console.error(
      `\n${RED}--with-api only means anything with --start; without it there is no API to start.${RESET}\n`,
    );
    process.exit(1);
  }
  if (!Number.isFinite(READY_TIMEOUT_SECONDS) || READY_TIMEOUT_SECONDS <= 0) {
    console.error(`\n${RED}--ready-timeout must be a positive number of seconds.${RESET}\n`);
    process.exit(1);
  }

  const servers = [];
  let exitCode = 0;

  try {
    if (START) {
      for (const url of WITH_API ? [WEB_ORIGIN, API_ORIGIN] : [WEB_ORIGIN]) await refuseOccupiedPort(url);
      if (WITH_API) {
        // Inherit DATABASE_URL and do not force NODE_ENV=production, which refuses `.env`'s dev secrets.
        // PUBLIC_WEB_ORIGIN must be this audit's origin, or CORS and the WebSocket Origin check answer
        // `forbidden`.
        const api = new ManagedServer(
          'api',
          ['--filter', '@prl/api', 'start'],
          new URL('/api/v1/health', API_ORIGIN).toString(),
          {
            PORT: portFromOrigin(API_ORIGIN),
            HOST: '127.0.0.1',
            PUBLIC_WEB_ORIGIN: new URL(WEB_ORIGIN).origin,
          },
        );
        servers.push(api);
        console.log(`${DIM}  starting the API on ${API_ORIGIN}...${RESET}`);
        api.start();
        await api.waitUntilReady(READY_TIMEOUT_SECONDS);
      }
      const web = new ManagedServer('web', ['--filter', '@prl/web', 'start'], WEB_ORIGIN, {
        NODE_ENV: 'production',
        PRL_API_ORIGIN: API_ORIGIN,
        PORT: portFromOrigin(WEB_ORIGIN),
      });
      servers.push(web);
      console.log(`${DIM}  starting the web app on ${WEB_ORIGIN}...${RESET}`);
      web.start();
      await web.waitUntilReady(READY_TIMEOUT_SECONDS);
    }

    const probe = await fetch(WEB_ORIGIN, { headers: { accept: 'text/html' } }).catch(() => null);
    if (probe === null || !probe.ok) {
      console.error(`\n${RED}${WEB_ORIGIN} is not serving. Start it first, or pass --start:${RESET}`);
      console.error(`${DIM}  pnpm --filter @prl/web build && pnpm --filter @prl/web start${RESET}\n`);
      throw new Error(`${WEB_ORIGIN} is not serving`);
    }

    // Is this our app? The marker is the shell class the root layout always emits. Against an unrelated
    // app on :3000 a review got thirty failures that were true of somebody else's page.
    const landing = await probe.text();
    if (!landing.includes('prl-app') && !landing.includes('prl-shell')) {
      console.error(`\n${RED}${WEB_ORIGIN} is serving, but it is not Poker Risk Lab.${RESET}`);
      console.error(
        `${DIM}  No 'prl-app' or 'prl-shell' in the landing HTML (${landing.length} bytes). ` +
          `Something else is on that port.${RESET}`,
      );
      console.error(`${DIM}  Pass --web <origin>, or set PRL_WEB_ORIGIN.${RESET}\n`);
      throw new Error(`${WEB_ORIGIN} is serving something that is not Poker Risk Lab`);
    }

    if (await probeAgeGate()) {
      console.log(
        `${YELLOW}  The age gate is ON at this origin: ${AGE_GATE_PATH} stands in front of /play.${RESET}`,
      );
      console.log(
        `${YELLOW}  A declaration cookie (${AGE_GATE_COOKIE_NAMES.join(' / ')} = ${String(
          AGE_GATE_MINIMUM_CEILING,
        )}) is being seeded, so the routes below are the pages themselves.${RESET}`,
      );
      console.log(
        `${YELLOW}  The interstitial itself is NOT audited by this run; give it its own route list.${RESET}`,
      );
    }

    // A sweep of nothing is not a pass.
    if (ROUTES.length === 0) {
      throw new Error('the route list is empty, so this run would audit no page at all');
    }

    let journeys = 0;
    await withChrome(async (page) => {
      for (const route of ROUTES) {
        journeys += 1;
        try {
          await auditRoute(page, route);
        } catch (error) {
          bad(`${route.title}: audit`, error instanceof Error ? error.message : String(error));
        }
      }
      journeys += 3;
      try {
        await auditNarrowViewport(page);
      } catch (error) {
        bad('Narrow viewport: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await auditStickyBarOcclusion(page);
      } catch (error) {
        bad('Sticky bar: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await playOneHandByKeyboard(page);
      } catch (error) {
        bad('Private table: audit', error instanceof Error ? error.message : String(error));
      }
    });
    if (journeys === 0) bad('scope', 'no journey ran, so nothing was audited');
  } catch (error) {
    console.error(`\n${RED}${error instanceof Error ? error.message : String(error)}${RESET}\n`);
    exitCode = 1;
  } finally {
    // Before any `process.exit`, which skips `finally`.
    for (const server of servers) server.stop();
  }

  if (exitCode !== 0) process.exit(exitCode);

  if (JSON_OUT !== null) {
    await writeFile(JSON_OUT, `${JSON.stringify({ origin: WEB_ORIGIN, record }, null, 2)}\n`);
    console.log(`\n${DIM}  wrote ${JSON_OUT}${RESET}`);
  }

  console.log(`\n${BOLD}Summary${RESET}`);
  console.log(`  ${GREEN}${passed} check(s) passed${RESET}`);
  console.log(`  ${DIM}${notApplicable.length} check(s) not applicable on the route they ran on${RESET}`);
  for (const entry of notApplicable) console.log(`${DIM}    - ${entry}${RESET}`);
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
  // Zero failures over zero checks is not a clean run.
  if (passed === 0) {
    console.log(`\n${RED}${BOLD}FAIL — no check ran at all, so nothing was proven.${RESET}\n`);
    process.exit(1);
  }
  console.log(`${GREEN}${BOLD}\nKeyboard audit passed.${RESET}\n`);
}

if (import.meta.main) await main();
