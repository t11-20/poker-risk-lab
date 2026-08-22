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
 * ## The table's controls are matched by accessible NAME, never by `textContent`
 *
 * An action button in this app is two spans — the word and its cost — so `button.textContent` is
 * the run-together string `Fold0 units`. The first version of `checkPokerActions` filtered
 * `/^(fold|check|call|…)\b/i` over exactly that string, and `\b` does not match between `d` and
 * `0`. It therefore selected only the buttons whose label happens to carry a space (`Raise to 70`)
 * and reported **"no action controls are on screen in this state"** as a WARNING on the routes that
 * render the whole row. A release report recorded those warnings as a benign idle state; they were
 * a detector that could not fire, which is worse than no detector because it reads as a pass.
 *
 * The second half of the same defect was in the follow-up probe: `\b` written inside a template
 * literal is the BACKSPACE escape, not the regex assertion, so the expression injected into the
 * page carried a control character and matched nothing whatsoever.
 *
 * Both halves are fixed by `actionControlName` and `isPokerActionName` below. The name comes from
 * `aria-label` when there is one — what a screen reader announces, and what `scripts/ax-tree-audit.mjs`
 * already matches on after finding this same defect from the other side — and the word boundary is
 * an explicit "not followed by a letter" so that `Fold0 units` matches and `Folding costs nothing`
 * does not. They are real functions injected with `String(fn)` rather than regexes written into a
 * string, because source that is compiled as source cannot be mangled by string escaping.
 *
 * ## A check that finds nothing to check must FAIL where there was something to find
 *
 * Every route handed to `checkPokerActions` declares `actionControls`, and a route that reaches it
 * without one is a failure rather than a lenient default:
 *
 *   - `'required'` — the route renders a decision row. Finding none is a FAILURE, whether the
 *     defect is in the app or in the matcher above. This is the line that stops the silent version
 *     of this check ever coming back.
 *   - `'until-seated'` — the live table before a seat is taken legitimately offers no actions. That
 *     is reported as NOT APPLICABLE, counted separately, and never as a pass: the operable half of
 *     this question belongs to `playOneHandByKeyboard`, which sits down at a real table.
 *
 * ## The age gate
 *
 * `apps/web/src/lib/age-gate.ts` can put an interstitial in front of `/play` (`PRL_AGE_GATE=on`),
 * or in front of everything (`PRL_AGE_GATE_SCOPE=site`). Two things are done about it, and both are
 * needed, because they answer different questions:
 *
 *   1. **A declaration cookie is seeded into the browser profile before the first navigation.** The
 *      value is `AGE_GATE_MINIMUM_CEILING`, the highest threshold the configuration can clamp to,
 *      so one cookie satisfies any gate this app can be configured with. Seeding beats running with
 *      `PRL_AGE_GATE=off` because this harness does not start the server: it is pointed at one that
 *      is already running (staging, a container, another agent's `next start`), whose environment
 *      it cannot change. It audits the deployment as configured, which is the point.
 *   2. **The landing URL is checked on every navigation anyway.** A seeded cookie can be refused —
 *      a raised threshold, a `__Host-` name over plain HTTP — and the failure mode without this
 *      check is a confusing timeout in `goto`, or worse, an audit of the interstitial reported
 *      under the name of the page it replaced. Landing on `/age-check` is now an explicit failure
 *      naming the gate.
 *
 * The cookie is not a bypass of anything: the gate is a self-declaration that any reader can make
 * by pressing its button, and nothing is verified anywhere. What the harness gives up by seeding it
 * is a keyboard audit of the interstitial ITSELF, which is a real page with a real control; run
 * this against a deployment with the gate on and `/age-check` in the route list to cover it.
 *
 * ## Usage
 *
 *     node scripts/keyboard-audit.mjs [--web http://localhost:3000] [--headful] [--json <path>]
 *
 * Exits non-zero on any failure, so it is usable as a release gate. Run it against a PRODUCTION
 * build (`next start`): a development build ships extra dev-only overlays that are not what ships.
 *
 * The checkers that are pure — the two matchers, and the route declarations they are driven by —
 * are exported and covered by `scripts/keyboard-audit.test.mjs`, so the run block below is guarded
 * by `import.meta.main`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// The gate's own constants, imported rather than re-typed. `age-gate.ts` is a leaf module with no
// imports of its own precisely so that things outside the Next runtime can read it, and a second
// copy of a cookie name here is the failure its header describes: a harness that seeds
// `prl_age_gate` while the proxy reads `prl_age_check` would sail past this whole feature and
// report a clean run against the interstitial. `scripts/regenerate-web-fixtures.mjs` sets the
// precedent for a script importing application TypeScript by path.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MINIMUM_CEILING,
  AGE_GATE_PATH,
} from '../apps/web/src/lib/age-gate.ts';

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
/**
 * A check that had nothing to examine BECAUSE THE ROUTE SAYS SO, which is not a pass.
 *
 * Kept out of `passed` on purpose. "69 checks passed" that silently includes a check which
 * examined nothing is the shape of report this file has already produced once, and the whole point
 * of the `actionControls` declaration is that "there was nothing here" has to be a claim somebody
 * wrote down rather than an outcome the run can drift into.
 */
const skip = (label, detail) => {
  notApplicable.push(`${label} — ${detail}`);
  record.push({ level: 'skip', label, detail });
  console.log(`${DIM}  -${RESET} ${label} ${DIM}${detail}${RESET}`);
};
const section = (title) => console.log(`\n${BOLD}${title}${RESET}`);

// ---------------------------------------------------------------------------
// The age gate
// ---------------------------------------------------------------------------

/**
 * True when a navigation ended up on the gate's interstitial instead of where it was sent.
 *
 * Segment matching, never `includes`, for the reason `age-gate.ts` gives: `/age-checkers` is not
 * the gate. The second half — that the REQUEST was not for the gate — is what allows the gate page
 * to be audited as itself when somebody puts it in the route list.
 */
export function landedOnAgeGate(requestedPath, landedPath) {
  const isGate = (path) => path === AGE_GATE_PATH || path.startsWith(`${AGE_GATE_PATH}/`);
  return isGate(landedPath) && !isGate(requestedPath);
}

/**
 * The declaration cookie(s) to seed into the browser profile, as `Network.setCookie` parameters.
 *
 * The value is `AGE_GATE_MINIMUM_CEILING`, which is the highest threshold `readAgeGateConfig` can
 * ever hold — anything larger is clamped down to it — so one value satisfies every configuration
 * without this harness having to know which one is in force. It is not an assertion about anybody's
 * age: the gate is a self-declaration with nothing behind it, and this is the same declaration its
 * own button makes.
 *
 * The `__Host-` name is seeded only over HTTPS, because the prefix means exactly "Secure, and set
 * by this host" and Chrome refuses it otherwise. Over plain HTTP the proxy reads the unprefixed
 * name, which is the whole reason `age-gate.ts` carries two.
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
    const requested = new URL(url).pathname;
    // Poll for the document being interactive AND hydrated. `next start` streams, so `load` alone
    // can fire before the client bundle has attached its handlers — and a control with no handler
    // yet is a control this audit would wrongly call inert.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay(100);
      const state = await this.evaluate(
        `(() => ({ ready: document.readyState, url: location.href, path: location.pathname, hydrated: document.documentElement.dataset.boot !== undefined || document.querySelectorAll('script[src]').length > 0 }))()`,
      ).catch(() => null);
      if (state === null || state.ready !== 'complete') continue;
      // The age gate answers a navigation with a 303 to its own interstitial. Said out loud, here,
      // rather than left to time out below as "did not finish loading" — which is what it did, and
      // which sends the reader of the report looking at the network instead of at the gate.
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
// Finding the table's own controls
// ---------------------------------------------------------------------------

/**
 * What this control is called, as far as a reader is concerned.
 *
 * `aria-label` first, and `textContent` only when there is none. That order is the whole fix: an
 * action button here is a `<span>` for the word and a `<span>` for the cost, so its `textContent`
 * is `Fold0 units`, while its label is the sentence `ActionBar` writes for assistive technology —
 * "fold, costs 0 units, gives up the hand and any claim on the pot". Matching the label is both
 * more likely to be right and closer to the question being asked, which is whether the control a
 * SCREEN READER announces as "fold" can be operated from the keyboard.
 *
 * Written against `getAttribute`/`textContent` alone so that it runs unchanged in the page (see
 * `MATCHER_SOURCE`) and against a plain object in `keyboard-audit.test.mjs`. Nothing here may
 * reference a module-scope binding: in the page there is no module scope.
 */
export function actionControlName(button) {
  const label = button.getAttribute('aria-label');
  const raw = label !== null && label.trim() !== '' ? label : (button.textContent ?? '');
  return raw.replace(/\s+/gu, ' ').trim();
}

/**
 * Whether a control's name is a poker action.
 *
 * The boundary is `(?![\p{L}])` — "not followed by a letter" — rather than `\b`, and that single
 * character class is the difference between this file checking the decision row and skipping it:
 *
 *   `Fold0 units`     `\b` does NOT match between `d` and `0`; the lookahead does.
 *   `Folding costs…`  both correctly refuse it, because `i` is a letter.
 *
 * The cost of the looser boundary, stated honestly: a control named `Fold the summary` would now
 * be taken for a poker action. Nothing in this app has one, the routes this runs on are declared
 * one by one below, and every matched name is printed in the report — so a false positive is
 * visible rather than silent, which is the trade this file cares about after the failure that
 * produced it.
 */
export function isPokerActionName(name) {
  return /^(fold|check|call|bet|raise|all[\s-]?in)(?![\p{L}])/iu.test(name);
}

/**
 * The two matchers as source, for injection into the page.
 *
 * `String(fn)` rather than a copy of the same logic inside a template literal. The copy is what
 * this file had, and one of the two copies contained `\b` — which inside a template literal is
 * U+0008 BACKSPACE and not the regex assertion at all, so the probe it was in could never match
 * anything. One definition, compiled by the same parser in both places, cannot drift and cannot be
 * re-escaped by accident.
 */
const MATCHER_SOURCE = `const prlActionName = ${String(actionControlName)};
const prlIsAction = ${String(isPokerActionName)};`;

/**
 * Every `<button>` on the page, with its name and whether it is usable, plus the SIZE of the set
 * that was examined — and, separately, the decision row as the APP groups it.
 *
 * ## Why two views of the same thing
 *
 * `scanned` is not decoration: "no action controls found" and "no buttons on the page at all" are
 * different defects with the same symptom, and a report that cannot tell them apart sends somebody
 * to look at the app when the fault is in the matcher.
 *
 * `rowUnmatched` is the stronger half, and it exists because of what the broken matcher actually
 * did. It did not find nothing — it found ONE of three controls, because `Raise to 70` happens to
 * carry a space where `Fold0 units` does not, and a check that silently examines a third of its
 * subject reports a pass. So the names are matched the way assistive technology sees them, the row
 * is collected the way the app builds it (`.prl-action-bar__actions`, which is `ActionBar`'s own
 * container), and the two have to agree. A control sitting in the decision row that the matcher
 * does not recognise is a failure of this file, and it now says so.
 *
 * The cost is a class name in an audit: rename `.prl-action-bar__actions` and this reports every
 * route as having no row. That is a loud, immediate failure with the class in the message, which is
 * the trade this file exists to make — the alternative is the silence it had.
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
 * Arms a click probe on the first ENABLED action control, focuses it, and names it.
 *
 * Returns `null` when the row is there but every control in it is disabled, which is a different
 * answer from "there is no row" and is reported differently by the caller.
 */
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
 * The table's own controls: fold, check/call, bet/raise.
 *
 * ## What the outcomes mean, which is the part that was wrong
 *
 * A route declares whether it has a decision row (`actionControls`, see ROUTES), and this refuses
 * to run for a route that declares nothing — a permissive default is how the previous version of
 * this check spent two releases reporting a warning nobody read on the one route that renders the
 * whole row. `'required'` and finding nothing is now a FAILURE. `'until-seated'` and finding
 * nothing is NOT APPLICABLE, counted apart from the passes, because an unseated table has no
 * decision to offer and `playOneHandByKeyboard` is where that question is really answered.
 *
 * ## Why it reloads between the three probes
 *
 * Pressing an action on the fixture route is not free: `TableStage` records the press and disables
 * the whole row to show the state a real table would be in while it waited for a server. So the
 * Space probe and the slider probe would both run against a row this function had just switched
 * off — the Space probe silently did nothing, and the sizer would have been reported as
 * pointer-only when in truth it was disabled. A fresh document before each probe costs about a
 * second and makes each answer independent.
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

  // The agreement check, before anything is decided from the matched set: a matcher that sees part
  // of the row makes every assertion below true of a subset, which is how this check spent two
  // releases reporting a pass over one button out of three.
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

  // Reachable is not the same as operable. Focus the first enabled action and press it, then check
  // the page acknowledged the press — a control that takes focus and ignores Enter is exactly the
  // failure "keyboard-operable" is meant to exclude, and it is invisible to a markup audit.
  const operable = await page.evaluate(ARM_FIRST_ACTION);
  if (operable === null) {
    // Not a warning on a route that promised a decision row: the operable half of this check is the
    // half a static audit cannot do, and a row that is entirely disabled means it did not run.
    const detail = `all ${actions.length} action control(s) are disabled, so neither Enter nor Space was tested`;
    if (expectation === 'required') bad(`${route.title}: poker actions`, detail);
    else skip(`${route.title}: poker actions`, detail);
    return;
  }
  await page.press('Enter');
  const viaEnter = await page.evaluate('window.__prlKeyProbe?.pressed === true');
  if (viaEnter) ok(`${route.title}: "${operable}" activates on Enter`);
  else bad(`${route.title}: poker actions`, `"${operable}" took focus but did not respond to Enter`);

  // And Space, which is the other key a button must answer to. From a fresh document: the Enter
  // above has already been accepted, and on the fixture path that disables the row.
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
 * `/play?state=decision` renders the action row and its controls do respond to Enter and Space —
 * but the press goes nowhere: `TableStage` records it, disables the row, and says in its own copy
 * that no server was asked. So the fixture proves the controls are in the tab order and that they
 * answer the keyboard, and proves nothing about a decision being ACCEPTED. "Poker actions operable"
 * is one of the things the audit specifically asked for, and the second half of it needs a table
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

  // The same two matchers the per-route check uses, for the same reason: a hand-rolled regex in a
  // template literal here is where the `\b`-as-BACKSPACE half of the original defect lived, and a
  // second copy of "what counts as an action" would rot at a different rate from the first.
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
    warn('Private table', 'the hand never reached this seat within 45s');
    return;
  }
  ok('Private table: the hand reached this seat');

  // Every action the engine offered, reachable and enabled.
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
  const accepted = await waitFor(NO_ENABLED_ACTION, 20);
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

/**
 * Exported so `keyboard-audit.test.mjs` can hold the list to its own rule: any route wired to
 * `checkPokerActions` declares what it expects to find. That test is the reason a future route
 * cannot quietly re-introduce the permissive default this check used to have.
 */
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
  // `?state=decision` renders the fixture of a table waiting on the learner: the action controls,
  // the bet-size slider and the Coach panel, all present, hydrated and ENABLED. That is the only
  // way to Tab to a fold/call/raise control without sitting down at a socket-backed table — which
  // needs an opponent and belongs to `scripts/smoke-test.mjs`. It is the same component tree the
  // live route renders, so what is asserted here about the keyboard is true of the live table too,
  // and it is the one route in this list where a missing decision row is a defect rather than a
  // state. Hence `required`.
  {
    title: 'Poker table + Coach (decision)',
    path: '/play?state=decision',
    extra: checkPokerActions,
    actionControls: 'required',
  },
  // The live table before anybody sits down: "Open the table", and nothing to decide. Declared
  // `until-seated` so that finding no actions is recorded as not-applicable instead of passing
  // quietly — and so that it can never stand in for the seated case, which `playOneHandByKeyboard`
  // is the only thing here that reaches.
  { title: 'Poker table (live)', path: '/play', extra: checkPokerActions, actionControls: 'until-seated' },
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
  /**
   * A profile directory per run, removed afterwards.
   *
   * It used to be the fixed path `/tmp/prl-keyboard-audit-profile`, and a fixed profile is state
   * that outlives the run. Two runs at once fight over the lock; and now that this harness seeds an
   * age declaration COOKIE, a shared profile would carry that declaration into the next run — so a
   * later run against a gated deployment would pass on a cookie it never set and nobody could tell
   * the seeding from the leftovers. A temporary directory costs a few megabytes for the length of
   * one audit.
   */
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
    // `Network` is enabled for one reason: `Network.setCookie`. Seeding the age declaration before
    // the first navigation is what stops a gated deployment serving the interstitial to every
    // route in the list below. `goto` still checks where it landed — see `landedOnAgeGate` — because
    // a cookie the deployment refuses must be a loud failure and not a silent audit of the wrong
    // page.
    await page.send('Network.enable');
    for (const cookie of ageDeclarationCookies(WEB_ORIGIN)) await page.send('Network.setCookie', cookie);
    try {
      await run(page);
    } finally {
      page.close();
    }
  } finally {
    child.kill('SIGTERM');
    // Chrome writes its profile out as it exits, so removing it races the browser: the first
    // version of this threw ENOTEMPTY out of a `finally` and turned a PASSING audit into a
    // non-zero exit with a filesystem error where the summary should have been. `maxRetries` gives
    // Chrome its moment, and the catch means the worst case is a few megabytes left in the system
    // temp directory rather than a false failure.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.log(
        `${DIM}  left the browser profile at ${profile} (${error instanceof Error ? error.message : String(error)})${RESET}`,
      );
    }
  }
}

/**
 * Whether this origin is serving the age gate, asked before Chrome is even started.
 *
 * `redirect: 'manual'` so the 303 itself is visible rather than followed. `/play` is the probe
 * because it is gated under BOTH scopes — `play` and `site` — so one request answers the question
 * for either configuration.
 */
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

  try {
    const probe = await fetch(WEB_ORIGIN, { headers: { accept: 'text/html' } }).catch(() => null);
    if (probe === null || !probe.ok) {
      console.error(`\n${RED}${WEB_ORIGIN} is not serving. Start it first:${RESET}`);
      console.error(`${DIM}  pnpm --filter @prl/web build && pnpm --filter @prl/web start${RESET}\n`);
      process.exit(1);
    }

    // Said before anything else, and said in colour: a run whose routes were all reached past a
    // gate is a different run, and the reader of the output has to be told which one they are
    // holding. Silence here is what would let a gated deployment be audited as if it were open.
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
  // Printed even when it is zero, because "how much did this run decline to check" is the number
  // the previous version of this file hid inside its warning list.
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
  console.log(`${GREEN}${BOLD}\nKeyboard audit passed.${RESET}\n`);
}

// Guarded so that `keyboard-audit.test.mjs` can import the matchers without starting Chrome.
if (import.meta.main) await main();
