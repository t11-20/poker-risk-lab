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

import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
// Imported from the gate itself, so a renamed cookie cannot leave this harness seeding the old one.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MINIMUM_CEILING,
  AGE_GATE_PATH,
} from '../apps/web/src/lib/age-gate.ts';
import { DevtoolsReplies, withChrome } from './chrome-devtools.mjs';
import { ManagedServer, refuseOccupiedPort } from './gate-servers.mjs';

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

const RED = '\u001b[31m';
const GREEN = '\u001b[32m';
const YELLOW = '\u001b[33m';
const DIM = '\u001b[2m';
const BOLD = '\u001b[1m';
const RESET = '\u001b[0m';
const dim = (s) => `${DIM}${s}${RESET}`;

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
  #replies = new DevtoolsReplies();
  #handlers = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.method !== undefined) {
        for (const handler of this.#handlers.get(message.method) ?? []) handler(message.params);
      }
      this.#replies.settle(message);
    });
    socket.addEventListener('close', () => this.#replies.fail(new Error('the DevTools socket closed')));
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

  /** Returns the unsubscribe. */
  on(method, handler) {
    this.#handlers.set(method, [...(this.#handlers.get(method) ?? []), handler]);
    return () => {
      this.#handlers.set(
        method,
        (this.#handlers.get(method) ?? []).filter((h) => h !== handler),
      );
    };
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

/**
 * `hidden` for anything a reader never meets, so the decorative `<img alt="">` inside a named card is not
 * held to a name of its own. A strip of named cards carries their names. Runs stringified in the page.
 */
export function cardElementVerdict(el) {
  for (let node = el; node !== null; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return 'hidden';
  }
  if ((el.getAttribute('aria-label') ?? '').trim() !== '') return 'named';
  if ((el.textContent ?? '').trim() !== '') return 'named';
  const pending = [...el.children];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.getAttribute('aria-hidden') === 'true') continue;
    if (/visually-hidden|prl-sr-only/u.test(node.getAttribute('class') ?? '')) return 'named';
    const label = (node.getAttribute('aria-label') ?? '').trim();
    if (node.getAttribute('role') === 'img' && label !== '') return 'named';
    pending.push(...node.children);
  }
  return 'unnamed';
}

async function checkCardText(page, route) {
  const cards = await page.evaluate(
    `(() => {
      const verdict = ${String(cardElementVerdict)};
      const nodes = [...document.querySelectorAll('[class*="card"], [data-rank], [data-suit]')].filter(
        (el) => el.getClientRects().length > 0,
      );
      const judged = nodes.map((el) => ({ el, verdict: verdict(el) }));
      const unnamed = judged
        .filter((entry) => entry.verdict === 'unnamed')
        .map((entry) => [entry.el.tagName.toLowerCase(), ...entry.el.classList].join('.'));
      const hidden = judged.filter((entry) => entry.verdict === 'hidden').length;
      return { total: nodes.length - hidden, hidden, unnamed };
    })()`,
  );
  // A route that runs this check shows cards, so finding none means the selector stopped matching.
  if (cards.total === 0) {
    bad(`${route.title}: card text`, 'found no visible card element a reader meets');
    return;
  }
  if (cards.unnamed.length === 0) {
    ok(
      `${route.title}: every card element carries text`,
      `${cards.total} checked, ${cards.hidden} hidden from readers skipped`,
    );
  } else {
    warn(
      `${route.title}: card text`,
      `${cards.unnamed.length} of ${cards.total} card elements carry neither text nor a label: ` +
        [...new Set(cards.unnamed)].join(', '),
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
 * From 860px the root's scroll padding assumes a one-row bar (`--prl-pillbar-h` in nav.css), so a
 * second row would hide 52px of every control scrolled to. The balance is written as 999,999, because
 * a six-figure balance is the widest the bar is sized for, and the default 1,000 hid a wrap at 860.
 */
async function auditBarHoldsOneRow(page) {
  section(`Wide viewport — the bar holds one row  ${DIM}860 to 1440, balance 999,999${RESET}`);
  const widths = [860, 900, 960, 1024, 1280, 1440];
  const wrapped = [];
  try {
    for (const width of widths) {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.goto(`${WEB_ORIGIN}/lab`);
      const bar = await page.evaluate(
        `(async () => {
          const header = document.querySelector('.prl-shell__header');
          // The balance is read from storage after hydration, so the figure can arrive after load.
          for (let i = 0; i < 30 && !header?.querySelector('.prl-units__figure'); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const figure = header?.querySelector('.prl-units__figure');
          const tour = header?.querySelector('.prl-shell__header-tools > .prl-tour-button');
          if (!header || !figure || !tour) return null;
          figure.textContent = '999,999';
          const padding = parseFloat(getComputedStyle(document.documentElement).scrollPaddingBlockStart);
          return {
            height: Math.round(header.getBoundingClientRect().height),
            padding: Math.round(padding),
            tour: tour.getBoundingClientRect().width,
          };
        })()`,
      );
      if (bar === null) {
        bad(`Bar row: ${width}px`, 'no header, units figure or "How to use" button to measure');
        return;
      }
      if (bar.tour < 44) wrapped.push(`${width}px: "How to use" is ${bar.tour}px wide, not shown`);
      // The padding is the bar, its 1px edge aside, plus a 16px step; a second row adds 52px.
      if (bar.height > bar.padding - 15)
        wrapped.push(`${width}px: bar ${bar.height}px, padding ${bar.padding}px`);
    }
    if (wrapped.length === 0) ok(`The bar holds one row at ${widths.join(', ')}px with a six-figure balance`);
    else bad('Bar row', `the bar is taller than the scroll padding assumes: ${wrapped.join('; ')}`);
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * Descendants of a closed `<details>` cannot take focus, but Chrome still reports a box for them
 * under `content-visibility: hidden`, so a centre-point tap would call them covered. The summary
 * can take focus, so it stays in the set.
 */
export function insideClosedDetails(element) {
  return element.closest('details:not([open]) > :not(summary)') !== null;
}

/**
 * Below 600px the Coach's closed sheet is a fixed 4rem strip. At 360x780 "Deal me in" rested at y 705
 * to 749 under a strip starting at 716, so a tap on it opened the Coach. Scroll padding cannot help a
 * control that is already in the first viewport. `elementFromPoint` checks what a tap hits, at both
 * ends of the page, and the decision fixture proves the strip is still there when it has a table.
 */
async function auditCoachPeekOcclusion(page) {
  const VIEWPORTS = [
    [360, 780],
    [390, 844],
  ];
  const PAGES = [
    { path: '/play', state: 'idle', needs: 'Deal me in' },
    { path: '/play?state=error', state: 'error', needs: null },
    { path: '/play?state=decision', state: 'ready', needs: null },
  ];
  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  try {
    for (const [width, height] of VIEWPORTS) {
      section(
        `Narrow viewport — nothing on /play rests under the Coach peek  ${DIM}${width}x${height}${RESET}`,
      );
      await page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: true,
      });
      for (const { path, state, needs } of PAGES) {
        const label = `Coach peek: ${path} at ${width}x${height}`;
        await page.goto(`${WEB_ORIGIN}${path}`);
        const probe = (end) =>
          page.evaluate(
            `(() => {
              const insideClosedDetails = ${String(insideClosedDetails)};
              const root = document.documentElement;
              root.style.scrollBehavior = 'auto';
              window.scrollTo(0, ${end ? 'root.scrollHeight' : '0'});
              const handle = document.querySelector('.prl-play__handle');
              const hb = handle?.getBoundingClientRect();
              const handleHit =
                hb !== undefined && hb.height > 0 &&
                handle.contains(document.elementFromPoint(hb.left + hb.width / 2, hb.top + hb.height / 2));
              const controls = [...document.querySelectorAll('main :is(${FOCUSABLE})')]
                .filter(
                  (element) =>
                    element.closest('.prl-play__coach') === null && !insideClosedDetails(element),
                )
                .map((element) => ({ element, box: element.getBoundingClientRect() }))
                // A centre past the viewport's edge is not on screen to tap.
                .filter(({ box }) => {
                  const y = box.top + box.height / 2;
                  return box.width >= 4 && box.height >= 4 && y > 0 && y < innerHeight;
                });
              const covered = controls
                .map(({ element, box }) => ({
                  name: (element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 44),
                  top: Math.round(box.top),
                  bottom: Math.round(box.bottom),
                  hit: document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
                  element,
                }))
                .filter((c) => !c.element.contains(c.hit))
                .map(({ name, top, bottom, hit }) => ({ name, top, bottom, hit: hit?.getAttribute('class') || hit?.tagName }));
              const note = document.querySelector('.prl-play__coach[data-open="false"] .prl-play__handle-note');
              const nb = note?.getBoundingClientRect();
              const noteCut =
                nb !== undefined && getComputedStyle(note).visibility !== 'hidden' &&
                nb.top < innerHeight && nb.bottom > innerHeight;
              return {
                state: document.querySelector('.prl-play__stage')?.dataset.state ?? null,
                names: controls.map(({ element }) => (element.textContent ?? '').trim()),
                handleHit,
                noteCut,
                covered,
              };
            })()`,
          );
        const top = await probe(false);
        const end = await probe(true);
        if (top.state !== state) {
          bad(label, `expected the stage in state "${state}", found "${top.state}", so this checked nothing`);
          continue;
        }
        if (top.names.length === 0 || (needs !== null && !top.names.includes(needs))) {
          bad(
            label,
            `no ${needs === null ? 'control' : `"${needs}"`} was on screen to tap, so nothing was checked`,
          );
          continue;
        }
        if (state === 'ready' && !top.handleHit) {
          bad(label, 'the Coach peek is missing or covered while the table has a decision to price');
          continue;
        }
        if (top.noteCut) {
          bad(label, 'the closed sheet shows a cut-off sliver of its caveat line at the viewport edge');
          continue;
        }
        const covered = [...top.covered, ...end.covered];
        if (covered.length === 0) {
          ok(`${label} — ${top.names.length} control(s) on screen, each takes a tap at its centre`);
        } else {
          bad(
            label,
            covered
              .slice(0, 3)
              .map((c) => `"${c.name}" at y ${c.top}-${c.bottom}: a tap at its centre lands on ${c.hit}`)
              .join('; '),
          );
        }
      }
    }
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * Below 600px the open Coach sheet covered y 64 to 844, the clock, cards, price and action row with it,
 * and its reading started 1,205px down (390x844). Opened from the two places a decision leaves the price:
 * held at the top, and at a first call, where it was measured at 537 (390x844) and 472 (360x780).
 */
async function auditCoachSheetOpen(page) {
  const VIEWPORTS = [
    [360, 780],
    [390, 844],
  ];
  try {
    for (const [width, height] of VIEWPORTS) {
      section(
        `Narrow viewport — the open Coach leaves the decision in view  ${DIM}${width}x${height}${RESET}`,
      );
      await page.send('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: true,
      });
      for (const [where, priceAt] of [
        ['held', null],
        ['first call', height - 307],
      ]) {
        const label = `Coach sheet: ${where} at ${width}x${height}`;
        await page.goto(`${WEB_ORIGIN}/play?state=decision`);
        // The first-visit overlay covers the page, and every tap would land on it.
        for (
          let wait = 0;
          wait < 30 && (await page.evaluate(`document.querySelector('.prl-boot') !== null`));
          wait += 1
        ) {
          await delay(100);
        }
        await page.evaluate(
          `(() => {
            document.documentElement.style.scrollBehavior = 'auto';
            // Headless Chrome stopped producing frames after a reload, and the slide stayed at its start.
            document.querySelector('.prl-play__coach').style.transition = 'none';
            const price = document.querySelector('.prl-action-bar__price');
            const top = ${priceAt ?? 'parseFloat(getComputedStyle(document.documentElement).scrollPaddingBlockStart)'};
            window.scrollBy(0, price.getBoundingClientRect().top - top);
            document.querySelector('.prl-play__handle').focus();
          })()`,
        );
        await page.press('Enter');
        await delay(600);
        const open = await page.evaluate(
          `(() => {
            const sheet = document.querySelector('.prl-play__coach');
            const head = sheet.querySelector('.prl-suggestion__head');
            const hit = (element) => {
              const box = element.getBoundingClientRect();
              const y = box.top + box.height / 2;
              return y > 0 && y < innerHeight && element.contains(document.elementFromPoint(box.left + box.width / 2, y));
            };
            const needed = [
              ...[...document.querySelectorAll('.prl-action-bar__actions button:not([disabled])')].map((b) => [b.textContent.trim().slice(0, 20), b]),
              ['the price', document.querySelector('.prl-action-bar__price')],
              ['the clock', document.querySelector('.prl-hand-glance .prl-turn-timer')],
              ...[...document.querySelectorAll('.prl-hand-glance .prl-card')].map((c, i) => ['card ' + (i + 1), c]),
            ].filter(([, element]) => element !== null);
            return {
              open: sheet.dataset.open === 'true',
              headBottom: head === null ? null : Math.round(head.getBoundingClientRect().bottom - sheet.getBoundingClientRect().top),
              sheetHeight: sheet.clientHeight,
              needed: needed.length,
              hidden: needed.filter(([, element]) => !hit(element)).map(([name]) => name),
            };
          })()`,
        );
        if (!open.open || open.headBottom === null || open.needed < 6) {
          bad(
            label,
            `the sheet did not open over a priced decision (${JSON.stringify(open)}), so nothing was checked`,
          );
          continue;
        }
        if (open.headBottom <= open.sheetHeight) {
          ok(`${label}: the reading ends ${open.headBottom}px into a ${open.sheetHeight}px sheet`);
        } else {
          bad(
            label,
            `the reading ends ${open.headBottom}px into a ${open.sheetHeight}px sheet, below its first screen`,
          );
        }
        if (open.hidden.length === 0) ok(`${label}: ${open.needed} controls and figures still take a tap`);
        else bad(label, `under the open sheet: ${open.hidden.join(', ')}`);

        // From the last disclosure, scrolled to the bottom: the handle scrolls with the sheet's content.
        await page.evaluate(
          `(() => {
            const sheet = document.querySelector('.prl-play__coach');
            [...sheet.querySelectorAll('summary')].at(-1).focus({ preventScroll: true });
            sheet.scrollTop = sheet.scrollHeight;
          })()`,
        );
        await page.press('Escape');
        await delay(400);
        const closed = await page.evaluate(
          `(() => {
            const handle = document.querySelector('.prl-play__handle');
            const box = handle.getBoundingClientRect();
            const y = box.top + box.height / 2;
            return {
              open: document.querySelector('.prl-play__coach').dataset.open,
              onHandle: document.activeElement === handle,
              shown: y > 0 && y < innerHeight && handle.contains(document.elementFromPoint(box.left + box.width / 2, y)),
            };
          })()`,
        );
        if (closed.open === 'false' && closed.onHandle && closed.shown)
          ok(`${label}: Escape closes it, focus back on the handle, and the handle is what the peek shows`);
        else
          bad(
            label,
            `after Escape the sheet is open=${closed.open}, focus on the handle ${closed.onHandle}, ` +
              `handle on screen ${closed.shown}`,
          );
      }
    }
    // A phone held sideways is under 600px wide too, and a sheet sized for a tall screen came out negative.
    section(`Narrow viewport — the open Coach in landscape  ${DIM}568x320${RESET}`);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 568,
      height: 320,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await page.goto(`${WEB_ORIGIN}/play?state=decision`);
    for (
      let wait = 0;
      wait < 30 && (await page.evaluate(`document.querySelector('.prl-boot') !== null`));
      wait += 1
    ) {
      await delay(100);
    }
    await page.evaluate(
      `(() => {
        document.querySelector('.prl-play__coach').style.transition = 'none';
        document.querySelector('.prl-play__handle').focus();
      })()`,
    );
    await page.press('Enter');
    await delay(600);
    const sideways = await page.evaluate(
      `(() => {
        const sheet = document.querySelector('.prl-play__coach');
        return { open: sheet.dataset.open === 'true', height: sheet.clientHeight };
      })()`,
    );
    if (!sideways.open) bad('Coach sheet: 568x320', 'the sheet did not open, so nothing was checked');
    else if (sideways.height >= 320 * 0.4)
      ok(`Coach sheet: 568x320: the open sheet is ${sideways.height}px of a 320px screen`);
    else
      bad(
        'Coach sheet: 568x320',
        `the open sheet is ${sideways.height}px of a 320px screen, too small to read`,
      );
  } finally {
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
}

/**
 * After the table, the session can delete its account. Each step unmounts the control that was pressed,
 * so focus must be placed. The journey opens the warning and backs out; it never types the phrase.
 */
async function auditAccountDeletionFocus(page) {
  section(`Account deletion keeps focus  ${DIM}/record${RESET}`);
  await page.goto(`${WEB_ORIGIN}/record`);
  await resetFocus(page);
  let reached = false;
  for (let step = 0; step < 80 && !reached; step += 1) {
    await page.press('Tab');
    reached = (await page.evaluate(DESCRIBE_ACTIVE)).name === 'Delete my account';
  }
  if (!reached) {
    unproven(
      'Account deletion',
      'no "Delete my account" control to reach; the session from the table is missing',
    );
    return;
  }
  await page.press('Enter');
  await delay(250);
  const field = await page.evaluate(
    `document.activeElement?.labels?.[0]?.textContent ?? document.activeElement?.tagName ?? 'body'`,
  );
  if (/^To confirm, type /u.test(field))
    ok('Account deletion: opening the warning focuses the confirm field');
  else bad('Account deletion', `opening the warning left focus on ${field}, so the warning is not announced`);

  let back = false;
  for (let step = 0; step < 6 && !back; step += 1) {
    await page.press('Tab');
    back = (await page.evaluate(DESCRIBE_ACTIVE)).name === 'Keep my account';
  }
  if (!back) {
    bad('Account deletion', 'could not reach "Keep my account" by keyboard from the confirm field');
    return;
  }
  await page.press('Enter');
  await delay(250);
  const opener = (await page.evaluate(DESCRIBE_ACTIVE)).name;
  if (opener === 'Delete my account') ok('Account deletion: keeping the account returns focus to the opener');
  else bad('Account deletion', `keeping the account left focus on "${opener || 'body'}"`);
}

/**
 * The quiz keeps its place in `?question=N`, and Back to an entry a fragment link added must show that
 * entry's place. Focus on a control of the question that leaves goes to the new heading; elsewhere it stays.
 */
async function auditQuizBackPlace(page) {
  const path = '/learn/hand-flow';
  section(`Quiz place follows Back  ${DIM}${path}${RESET}`);
  const readQuiz = () =>
    page.evaluate(
      `(() => { const a = document.activeElement; return { place: document.querySelector('.prl-learn-quiz__position')?.textContent.trim() ?? '', query: location.search, heading: a?.classList.contains('prl-learn-quiz__heading') ?? false, inQuiz: a?.closest('.prl-learn-quiz') !== null && a !== null, tag: a === null || a === document.body ? 'body' : a.tagName }; })()`,
    );
  for (const focusInside of [true, false]) {
    const label = focusInside ? 'focus on an answer' : 'focus outside the quiz';
    await page.goto(`${WEB_ORIGIN}${path}`);
    await page.evaluate(`location.hash = 'main'`);
    for (let press = 0; press < 2; press += 1) {
      const focused = await page.evaluate(
        `(() => { const b = [...document.querySelectorAll('.prl-learn-quiz__nav button')].find((x) => /^Next question$/.test(x.textContent.trim())); if (b === undefined) return false; b.focus(); return true; })()`,
      );
      if (!focused) {
        bad('Quiz Back', `no "Next question" button on ${path}`);
        return;
      }
      await page.press('Enter');
      await delay(200);
    }
    const before = await readQuiz();
    if (!before.place.includes('03') || !before.query.includes('question=3')) {
      bad('Quiz Back', `two Next presses showed "${before.place}" at "${before.query}", not question 3`);
      return;
    }
    const placed = await page.evaluate(
      focusInside
        ? `(() => { const c = document.querySelector('.prl-learn-quiz__options input'); c?.focus(); return c !== null && document.activeElement === c; })()`
        : `(() => { const c = document.querySelector('header a'); c?.focus(); return c !== null && document.activeElement === c; })()`,
    );
    if (!placed) {
      bad('Quiz Back', `${label}: could not place focus before pressing Back`);
      return;
    }
    await page.evaluate('history.back()');
    await delay(500);
    const after = await readQuiz();
    if (!after.place.includes('01') || after.query.includes('question=')) {
      bad('Quiz Back', `${label}: Back showed "${after.place}" at "${after.query}", not question 1`);
    } else if (focusInside && !after.heading) {
      bad('Quiz Back', `${label}: Back left focus on ${after.tag}, not the new question's heading`);
    } else if (!focusInside && after.inQuiz) {
      bad('Quiz Back', `${label}: Back pulled focus into the quiz`);
    } else {
      ok(
        `Quiz Back (${label}): shows question 1, ${focusInside ? 'focus on its heading' : 'focus left alone'}`,
      );
    }
  }
}

/** Turbopack's worker entry, which every worker loads first; blocking it is a worker that cannot start. */
export const WORKER_ENTRY_PATTERN = '*turbopack-worker-*';

/** What is wrong with where the page's deferred figures were computed, or `null`. */
export function computedOnVerdict({ marks, pending }, expected) {
  if (pending > 0) return `${String(pending)} deferred figure(s) never arrived`;
  if (marks.length === 0) return 'no deferred figure carries data-computed, so nothing was checked';
  const off = marks.filter((mark) => mark !== expected);
  if (off.length > 0) {
    return `${String(off.length)} of ${String(marks.length)} deferred figure(s) computed on "${off.join('", "')}", not "${expected}"`;
  }
  return null;
}

/**
 * The main-thread fallback would hide a worker that never runs, so the figure must say it came from the
 * worker. The control blocks the worker's entry and must then see the fallback, or the check proves nothing.
 */
async function auditDeferredOnWorker(page) {
  const path = '/learn/hand-flow';
  section(`Deferred figure on the worker  ${DIM}${path}${RESET}`);
  const READ = `(() => ({ marks: [...document.querySelectorAll('[data-computed]')].map((e) => e.dataset.computed), pending: document.querySelectorAll('.prl-learn-calc__skeleton').length }))()`;
  const settle = async () => {
    // A preflop equity takes ~260 ms; 30 s leaves room for a loaded machine without timing anything.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const state = await page.evaluate(READ).catch(() => null);
      if (state !== null && state.pending === 0 && state.marks.length > 0) return state;
      await delay(250);
    }
    return (await page.evaluate(READ).catch(() => null)) ?? { marks: [], pending: 0 };
  };

  await page.goto(`${WEB_ORIGIN}${path}`);
  const live = await settle();
  const problem = computedOnVerdict(live, 'worker');
  if (problem === null) ok(`Deferred figure: ${String(live.marks.length)} computed on the worker`);
  else bad('Deferred figure', problem);

  // `Fetch`, because `Network.setBlockedURLs` on the page does not reach a worker's script (Chrome 158).
  let refused = 0;
  const off = page.on('Fetch.requestPaused', ({ requestId }) => {
    refused += 1;
    page
      .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      .catch((error) => bad('Deferred figure control', `could not refuse the worker: ${String(error)}`));
  });
  try {
    await page.send('Fetch.enable', { patterns: [{ urlPattern: WORKER_ENTRY_PATTERN }] });
    await page.goto(`${WEB_ORIGIN}${path}`);
    const dead = await settle();
    // The check above must fail on this page, and the page must still show the fallback's figure.
    const missed = computedOnVerdict(dead, 'worker');
    const fallback = computedOnVerdict(dead, 'here');
    if (refused === 0) bad('Deferred figure control', `no request matched ${WORKER_ENTRY_PATTERN}`);
    else if (missed === null)
      bad('Deferred figure control', 'the worker check passed with the worker refused');
    else if (fallback !== null) bad('Deferred figure control', `with the worker refused, ${fallback}`);
    else ok(`Deferred figure control: with the worker refused, the check fails (${missed})`);
  } finally {
    off();
    await page.send('Fetch.disable');
  }
}

/** "Show the reasoning" unmounts itself when pressed, so it must hand focus to the reasoning it revealed. */
async function auditQuizRevealFocus(page) {
  const path = '/learn/counting-outs';
  section(`Quiz reveal keeps focus  ${DIM}${path}${RESET}`);
  await page.goto(`${WEB_ORIGIN}${path}`);
  const focusButton = (pattern) =>
    page.evaluate(
      `(() => { const b = [...document.querySelectorAll('.prl-learn-quiz button')].find((x) => ${pattern}.test(x.textContent.trim())); if (b === undefined) return false; b.focus(); return document.activeElement === b; })()`,
    );
  let found = false;
  for (let step = 0; step < 12 && !found; step += 1) {
    found = await focusButton('/^Show the reasoning$/');
    if (found) break;
    if (!(await focusButton('/^Next question$/'))) break;
    await page.press('Enter');
    await delay(200);
  }
  if (!found) {
    bad('Quiz reveal', `no decision question with "Show the reasoning" in the quiz on ${path}`);
    return;
  }
  await page.press('Enter');
  await delay(300);
  const landed = await page.evaluate(
    `(() => { const a = document.activeElement; return { why: a?.classList.contains('prl-learn-quiz__explanation') ?? false, visible: a?.matches(':focus-visible') ?? false, tag: a === null || a === document.body ? 'body' : a.tagName }; })()`,
  );
  if (landed.why && landed.visible)
    ok('Quiz reveal: "Show the reasoning" moves visible focus to the reasoning');
  else if (landed.why)
    bad('Quiz reveal', 'focus reached the reasoning, but it does not match :focus-visible');
  else bad('Quiz reveal', `pressing "Show the reasoning" left focus on ${landed.tag}`);
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
  { title: 'Your spots', path: '/lab/spots' },
  { title: 'Spot editor', path: '/lab/spots/edit?from=fl-same-cards-under-the-gun' },
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

function portFromOrigin(origin) {
  const port = new URL(origin).port;
  return port === '' ? '3000' : port;
}

async function withPage(run) {
  const chrome = {
    headful: HEADFUL,
    port: 9222 + Math.floor(process.pid % 500),
    // A profile per run, because a shared one would carry the seeded age cookie into the next run.
    freshProfile: 'prl-keyboard-audit-',
    flags: ['--window-size=1440,900'],
    dim,
  };
  await withChrome(chrome, async ({ version, openTab }) => {
    console.log(`${DIM}  ${version.Browser} — ${HEADFUL ? 'headful' : 'headless'}${RESET}`);
    const page = await Page.open(await openTab());
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
  });
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
      for (const url of WITH_API ? [WEB_ORIGIN, API_ORIGIN] : [WEB_ORIGIN]) {
        await refuseOccupiedPort(
          url,
          '--start drives a server this run started, so it will not score one it did not. Stop it, pass ' +
            'another --web/--api, or leave out --start to drive that server on purpose.',
        );
      }
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
          { dim },
        );
        servers.push(api);
        console.log(`${DIM}  starting the API on ${API_ORIGIN}...${RESET}`);
        api.start();
        await api.waitUntilReady(READY_TIMEOUT_SECONDS);
      }
      const web = new ManagedServer(
        'web',
        ['--filter', '@prl/web', 'start'],
        WEB_ORIGIN,
        {
          NODE_ENV: 'production',
          PRL_API_ORIGIN: API_ORIGIN,
          PORT: portFromOrigin(WEB_ORIGIN),
        },
        { dim },
      );
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
    await withPage(async (page) => {
      for (const route of ROUTES) {
        journeys += 1;
        try {
          await auditRoute(page, route);
        } catch (error) {
          bad(`${route.title}: audit`, error instanceof Error ? error.message : String(error));
        }
      }
      journeys += 8;
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
        await auditBarHoldsOneRow(page);
      } catch (error) {
        bad('Bar row: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await auditCoachPeekOcclusion(page);
      } catch (error) {
        bad('Coach peek: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await auditCoachSheetOpen(page);
      } catch (error) {
        bad('Coach sheet: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await playOneHandByKeyboard(page);
      } catch (error) {
        bad('Private table: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await auditAccountDeletionFocus(page);
      } catch (error) {
        bad('Account deletion: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await auditQuizRevealFocus(page);
      } catch (error) {
        bad('Quiz reveal: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await auditQuizBackPlace(page);
      } catch (error) {
        bad('Quiz Back: audit', error instanceof Error ? error.message : String(error));
      }
      try {
        await auditDeferredOnWorker(page);
      } catch (error) {
        bad('Deferred figure: audit', error instanceof Error ? error.message : String(error));
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
