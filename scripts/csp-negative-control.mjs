#!/usr/bin/env node
/**
 * Proof, in a real browser, that this app's Content-Security-Policy actually BLOCKS injected script
 * — and that the page still works while it does.
 *
 * This is what `pnpm run test:csp` does.
 *
 * ## The gap this closes, concretely
 *
 * There were two CSP checks in this repository and neither of them was this one:
 *
 *   - `apps/web/test/csp-policy.test.ts` asserts the policy's VALUE. It proves the string is right.
 *     It has never met a browser.
 *   - `scripts/smoke-test.mjs` §10 asserts the header ARRIVED at a browser-shaped client, and that
 *     every rendered `<script>` tag carries the per-response nonce. It proves the header is served
 *     and the nonce plumbing is connected. It has never met a browser either — `fetch` does not
 *     enforce a policy, it just receives one.
 *
 * Nothing proved that a browser ENFORCES it. The only evidence of that was four rows of a table in
 * `docs/audit/blocker-remediation.md` recording a manual check somebody did once, by hand, on one
 * machine. A control whose evidence is a memory is not a control, and this repository says so about
 * every other control it owns. This file replaces that memory with a run.
 *
 * ## What it does NOT prove
 *
 *   - Nothing about any browser other than the Chrome it found. A policy is enforced by the client,
 *     and Firefox and Safari have their own CSP implementations with their own gaps.
 *   - Nothing about routes it did not visit. The proxy puts the same policy on every HTML response
 *     (`apps/web/src/proxy.ts`), so one route is representative of the policy — but "representative"
 *     is an argument about the code, not a measurement.
 *   - Nothing about the API origin. That serves its own headers through `@fastify/helmet` and is
 *     covered by `apps/api/test/security-headers.test.ts`.
 *   - Nothing about whether the app has an XSS. A CSP is what limits the damage of one; this file
 *     measures the limit, not the absence of the hole.
 *   - Nothing about `style-src-attr 'unsafe-inline'`, which is a real and deliberate widening that
 *     `apps/web/src/lib/csp.ts` states and bounds. Only script injection is exercised here.
 *
 * ## How the injections are performed, and why every obvious way is wrong
 *
 * This was determined empirically against this policy, in this browser, and each finding below
 * changed the design. Getting it wrong produces a script that proves nothing while printing PASS.
 *
 *   1. **`Runtime.evaluate` is not subject to the page's CSP.** A DevTools evaluation is allowed to
 *      call `eval` on a page whose policy forbids it, and — measured — the exemption lasts for the
 *      whole synchronous evaluation, so even a `<script>` element that the evaluation creates and
 *      appends runs its `eval` unblocked. So `Runtime.evaluate` is used here to INSTALL and to
 *      INSPECT, and never to perform an injection or to run one.
 *
 *   2. **`document.createElement('script')` + `appendChild` is allowed BY THIS POLICY, on purpose.**
 *      The policy carries `'strict-dynamic'`, whose entire meaning is that a script the policy
 *      already trusts may create further scripts. A non-parser-inserted script element therefore
 *      executes with no nonce at all, and with a deliberately wrong one — measured: both ran, and no
 *      violation was reported. That is correct CSP3 behaviour and not a defect. A negative control
 *      built on it would have reported this policy as broken.
 *
 *   3. **`innerHTML` / `insertAdjacentHTML` proves nothing.** HTML says a `<script>` inserted that
 *      way never executes, whatever the policy. Measured: it did not run AND no violation fired.
 *      That is the exact trap this file exists to avoid — "nothing happened" is also what a working
 *      control looks like, and here it means the control never ran.
 *
 * So the injections arrive the way a real one does: **in the bytes of the document, parsed by the
 * HTML parser.** The Fetch domain pauses the top-level document response, the attack markup is
 * spliced in before `</body>`, and the response is fulfilled with the server's own headers —
 * including the server's own `Content-Security-Policy` and its own per-response nonce, untouched.
 * The browser then parses and enforces exactly what the deployment sent. Parser-inserted scripts are
 * outside `'strict-dynamic'`'s trust propagation, which is what makes them the honest test.
 *
 * The one script in the injection that is NOT an attack is the harness's own probe, stamped with the
 * response's REAL nonce. It installs the violation listener from inside the page (so the listener is
 * in place before the attacks are parsed), and it is where `eval()` is called from — page code, with
 * no DevTools exemption anywhere near it. Its running is itself an assertion: an inline script the
 * policy names by nonce must run, or the negative results below would only mean the injection never
 * arrived.
 *
 * ## Violations are read from the DOM event, not from the console
 *
 * A CSP violation surfaces twice: as a `securitypolicyviolation` DOM event, and as a
 * `Log.entryAdded` console error. The DOM event is what is asserted on, because it is structured —
 * `effectiveDirective`, `violatedDirective`, `blockedURI` — and asserting a directive means reading
 * a field rather than pattern-matching an English sentence that Chrome is free to reword. The log
 * entries are captured anyway and written into the JSON report, because they are what a person
 * reading a browser console would have seen.
 *
 * ## Usage
 *
 *     node scripts/csp-negative-control.mjs [--base-url http://127.0.0.1:3000] [--start] [--with-api]
 *                                           [--route /] [--headful] [--out <file>]
 *
 * Run it against a PRODUCTION build (`next build && next start`). The development policy adds
 * `'unsafe-eval'` and an HMR websocket on purpose, so a pass against `next dev` would be worthless —
 * and case 4 below would legitimately fail.
 *
 * ## Exit codes
 *
 *   0  every check passed, or `--help`
 *   1  any check failed, or any check could not be run
 *
 * There is no warning-with-exit-0 anywhere in this file, and that rule matters here more than
 * anywhere else in the repository: a CSP control that skips itself when Chrome is missing, or when
 * the server is not up, is worse than no control at all, because the gate goes green either way.
 * The yellow lines below are context about the run, never the outcome of a check.
 *
 * The pure parts — argument parsing, the markup builder, the violation matcher and the verdict
 * builder — are exported and covered by `scripts/csp-negative-control.test.mjs`, so the run block is
 * guarded by `import.meta.main`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// The gate's own constants rather than copies of them, for the reason `age-gate.ts` states in its
// own header and `scripts/keyboard-audit.mjs` repeats: a harness that seeds `prl_age_gate` while the
// proxy reads `prl_age_check` sails past the whole feature and reports a clean run against the
// interstitial. That module imports nothing precisely so things outside the Next runtime can read it.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MINIMUM_CEILING,
  AGE_GATE_PATH,
} from '../apps/web/src/lib/age-gate.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

// ===========================================================================
// Constants
// ===========================================================================

/**
 * The nonce put on the "wrong nonce" injection.
 *
 * Deliberately WELL-FORMED — 16 base64 zero bytes, the same shape `src/proxy.ts` mints — so that a
 * block is attributable to the VALUE being wrong rather than to the attribute being malformed. This
 * is the case that catches a policy which has quietly started serving a static nonce: if the
 * deployment's nonce ever equalled this constant the run refuses to continue rather than reporting a
 * block it could not attribute, which is why `attackMarkup` checks for it.
 */
export const WRONG_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';

/** The id of the injected element carrying the inline event handler, so the run can find and press it. */
export const EVENT_HANDLER_ELEMENT_ID = 'prl-csp-negative-control-onclick';

/**
 * The five injections, and what each one must be refused BY.
 *
 * `directives` is a LIST rather than one string because CSP Level 3 splits `script-src` into
 * `script-src-elem` (a `<script>` element, inline or with a src) and `script-src-attr` (an inline
 * event handler), and reports the split name even when the policy only declares `script-src` —
 * which is what this policy does. A CSP Level 2 client would report `script-src` for all of them.
 * Both are correct answers to "which directive refused this", so both are accepted, and the value
 * the browser actually reported is printed and recorded rather than merely checked off.
 *
 * `blockedUri` is `'inline'` for anything the policy refused to compile, `'eval'` for a string
 * evaluated as code, and the URL itself for a script the policy refused to fetch. Asserting it is
 * what stops one case's violation being accepted as another's.
 */
export const CASES = [
  {
    id: 'inline-no-nonce',
    title: 'an inline <script> with NO nonce does not execute',
    flag: '__prlCspInlineNoNonceRan',
    directives: ['script-src-elem', 'script-src'],
    blockedUri: 'inline',
  },
  {
    id: 'inline-wrong-nonce',
    title: 'an inline <script> with a WRONG nonce does not execute',
    flag: '__prlCspInlineWrongNonceRan',
    directives: ['script-src-elem', 'script-src'],
    blockedUri: 'inline',
  },
  {
    id: 'event-handler-attribute',
    title: 'an inline onclick handler does not execute',
    flag: '__prlCspEventHandlerRan',
    directives: ['script-src-attr', 'script-src'],
    blockedUri: 'inline',
  },
  {
    id: 'eval',
    title: "eval() throws, because 'unsafe-eval' is absent",
    flag: '__prlCspEvalRan',
    directives: ['script-src'],
    blockedUri: 'eval',
  },
  {
    id: 'remote-script',
    title: 'a <script src> on an origin the policy does not allow does not load',
    flag: '__prlCspRemoteScriptRan',
    directives: ['script-src-elem', 'script-src'],
    // Filled in per run: the address the harness's own disallowed origin ended up on.
    blockedUri: null,
  },
];

/** Chrome, wherever this platform keeps it. The same candidate list as the two sibling audits. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path) => typeof path === 'string' && path !== '');

/**
 * How long to wait for the app to hydrate before calling it dead.
 *
 * Generous, because the positive control must never fail for being impatient — a false failure here
 * would send somebody looking for a CSP defect that is really a slow machine. `next start` on this
 * app hydrates in well under a second locally; fifteen is roughly twenty times that.
 */
const HYDRATION_TIMEOUT_MS = 15_000;

/** The settle beat after `load`, so violations raised during parsing have all been dispatched. */
const SETTLE_MS = 500;

// ===========================================================================
// Options
// ===========================================================================

/**
 * Defaults mirror the two sibling browser audits: the web app on 3000, the API on 3001, and
 * `PRL_WEB_ORIGIN` honoured so a developer who set it for one harness does not set a second name.
 *
 * `start` is false by default, like `scripts/ax-tree-audit.mjs`: this runs against a production
 * build, and the common case is pointing it at one that is already up.
 */
const DEFAULTS = {
  baseUrl: process.env.PRL_WEB_ORIGIN ?? 'http://127.0.0.1:3000',
  apiUrl: process.env.PRL_API_ORIGIN ?? 'http://127.0.0.1:3001',
  // `/` renders without the API, carries the whole app shell — the boot overlay and the theme
  // control both positive controls below depend on — and gets the same policy as every other HTML
  // route, because the proxy matcher covers all of them.
  route: '/',
  start: false,
  withApi: false,
  headful: false,
  readyTimeoutSeconds: 120,
  out: null,
};

const HELP = `
${bold('pnpm run test:csp')} — CSP negative control, in real Chrome

  ${yellow('Injects script five ways into a real page and asserts the browser REFUSES each one,')}
  ${yellow('by the directive it names — then asserts the page still hydrates and still responds.')}
  ${yellow('Run it against a PRODUCTION build: the development policy allows unsafe-eval.')}

  Server
    --base-url <url>      web app origin                   (default ${DEFAULTS.baseUrl})
    --api-url <url>       API origin                       (default ${DEFAULTS.apiUrl})
    --start               start the web app rather than using one already running
    --with-api            also start the API (only with --start)
    --ready-timeout <s>   how long to wait for a server    (default ${DEFAULTS.readyTimeoutSeconds})

  Scope
    --route <path>        the HTML route to attack         (default ${DEFAULTS.route})

  Reporting
    --headful             run Chrome with a window, to watch it
    --out <file>          also write the findings as JSON
    --json <file>         the same thing, spelt the way test:ax spells it
    -h, --help            this text

  Exits 0 only when every injection was refused AND the page still worked. A check that could
  not be run — no Chrome, no server, no injection point — is a failure, never a skip.
`;

export function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run test:csp -- --headful` passes the `--` through rather than swallowing it, so both
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
      case '--route':
        options.route = need();
        break;
      // One option, two spellings, because `test:a11y` calls it `--out` and `test:ax` calls it
      // `--json` and a reader of either should not have to find out which one this is.
      case '--out':
      case '--json':
        options.out = need();
        break;
      case '--ready-timeout':
        options.readyTimeoutSeconds = Number(need());
        break;
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (!options.route.startsWith('/')) {
    throw new Error(`--route must be a path beginning with "/", not ${options.route}`);
  }
  if (!Number.isInteger(options.readyTimeoutSeconds) || options.readyTimeoutSeconds < 1) {
    throw new Error('--ready-timeout must be a positive whole number of seconds');
  }
  if (options.withApi && !options.start) {
    throw new Error('--with-api only means anything with --start; without it there is no API to start');
  }
  return options;
}

// ===========================================================================
// The age gate
// ===========================================================================

/**
 * True when a navigation ended up on the gate's interstitial instead of where it was sent.
 *
 * Segment matching, never `includes`, for the reason `age-gate.ts` gives at its own `matchesPrefix`:
 * `/age-checkers` is not the gate. The second half — that the REQUEST was not for the gate — is what
 * lets somebody point `--route` at the interstitial and attack it as itself.
 */
export function landedOnAgeGate(requestedPath, landedPath) {
  const isGate = (path) => path === AGE_GATE_PATH || path.startsWith(`${AGE_GATE_PATH}/`);
  return isGate(landedPath) && !isGate(requestedPath);
}

/**
 * The declaration cookie(s) to seed into the browser profile, as `Network.setCookie` parameters.
 *
 * `AGE_GATE_MINIMUM_CEILING` is the highest threshold the gate can hold — anything larger is clamped
 * down to it — so one value satisfies every configuration without this harness knowing which is in
 * force. The `__Host-` name is seeded only over HTTPS, because the prefix means "Secure, and set by
 * this host" and Chrome refuses it otherwise; over plain HTTP the proxy reads the unprefixed name,
 * which is why `age-gate.ts` carries two.
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

// ===========================================================================
// The injection
// ===========================================================================

/**
 * The markup spliced into the document, in the order the parser will meet it.
 *
 * The first element is the harness's own probe and is the only one the policy should admit: it
 * carries the response's real nonce. It has to come FIRST, because a listener registered after an
 * attack has been parsed cannot hear that attack's violation, and it has to be an inline script in
 * the document rather than a `Runtime.evaluate` call for the `eval` case — page code, compiled under
 * the page's policy, with no DevTools exemption anywhere near it.
 *
 * Every attack writes a distinct global by plain assignment. Nothing in an attack may dereference a
 * harness object: if a probe were somehow absent, an attack that threw on `undefined.x` would look
 * exactly like an attack the policy refused.
 *
 * The `<script src>` points at an origin this harness itself is serving on a spare port — a
 * different origin from the app by port alone. That is better than a public URL in two ways: the run
 * needs no internet, and the check is demonstrably able to fire, because if the policy did not block
 * it the script would really be fetched and would really set its flag. The run asserts both that the
 * flag is unset and that that server was never asked for anything.
 */
export function attackMarkup({ nonce, remoteScriptUrl }) {
  if (typeof nonce !== 'string' || nonce.length === 0) {
    throw new Error('the response carried no CSP nonce, so there is nothing to inject a probe with');
  }
  if (nonce === WRONG_NONCE) {
    throw new Error(
      `the deployment's nonce is the harness's own "wrong" nonce (${WRONG_NONCE}), so the ` +
        'wrong-nonce case cannot be told apart from the correct one. That is either an ' +
        'astronomical coincidence or a policy serving a static nonce; either way this run stops.',
    );
  }
  return [
    `<script nonce="${nonce}">`,
    'window.__prlCsp = { violations: [], evalOutcome: null };',
    "document.addEventListener('securitypolicyviolation', function (event) {",
    '  window.__prlCsp.violations.push({',
    '    effectiveDirective: event.effectiveDirective,',
    '    violatedDirective: event.violatedDirective,',
    '    blockedURI: event.blockedURI,',
    '    lineNumber: event.lineNumber,',
    '    sample: String(event.sample || "").slice(0, 60),',
    '  });',
    '});',
    'try {',
    "  eval('window.__prlCspEvalRan = true');",
    "  window.__prlCsp.evalOutcome = 'RAN';",
    '} catch (error) {',
    "  window.__prlCsp.evalOutcome = error.name + ': ' + String(error.message).slice(0, 120);",
    '}',
    '</script>',
    '<script>window.__prlCspInlineNoNonceRan = true;</script>',
    `<script nonce="${WRONG_NONCE}">window.__prlCspInlineWrongNonceRan = true;</script>`,
    `<script src="${remoteScriptUrl}"></script>`,
    `<button id="${EVENT_HANDLER_ELEMENT_ID}" type="button" ` +
      'onclick="window.__prlCspEventHandlerRan = true">CSP negative control</button>',
  ].join('\n');
}

/**
 * Splice the attack markup into a document, immediately before `</body>`.
 *
 * Before `</body>` because it is the one position that is both inside the parsed document and after
 * everything the app rendered — measured, and React hydrates the page around it without removing it.
 * Injecting into `<head>` would race the app's own scripts for no benefit.
 *
 * A document with no `</body>` is a document this cannot attack, and that THROWS rather than
 * returning the input unchanged. A silent no-op here is the precise failure this whole file exists
 * to make impossible: five injections that were never made are five injections that never ran.
 */
export function injectAttackMarkup(html, markup) {
  const at = html.lastIndexOf('</body>');
  if (at === -1) {
    throw new Error(
      'the response has no </body> to inject before, so no injection was made. Nothing below ' +
        'would have been a test of anything.',
    );
  }
  return `${html.slice(0, at)}\n${markup}\n${html.slice(at)}`;
}

/**
 * Whether one reported violation is the one a case is waiting for.
 *
 * Both halves are required. Matching only the directive would let the `eval` case be satisfied by
 * the inline-script violation that arrives a line earlier — both are `script-src` on a Level 3
 * client — and a matcher that can be satisfied by the wrong evidence is a matcher that will one day
 * pass with four of the five injections not made at all.
 *
 * `violatedDirective` is read as a fallback for `effectiveDirective` because the two are aliases in
 * current browsers and only the older name exists in CSP Level 2.
 */
export function matchesViolation(report, expectation) {
  if (report === null || typeof report !== 'object') return false;
  const directive = String(report.effectiveDirective ?? report.violatedDirective ?? '')
    .trim()
    // A `violatedDirective` may historically carry the whole directive with its source list.
    .split(/\s+/)[0];
  if (!expectation.directives.includes(directive)) return false;
  return String(report.blockedURI ?? '') === expectation.blockedUri;
}

/**
 * The verdict, from the recorded checks.
 *
 * Pass requires three things and not two: no failure, at least one negative-control check, and at
 * least one positive-control check. A run that failed before it injected anything has no failures
 * either, and "0 failures" must never be reachable by never having looked.
 */
export function buildVerdict(record) {
  const failures = record.filter((entry) => entry.level === 'fail');
  const passes = record.filter((entry) => entry.level === 'pass');
  const negatives = passes.filter((entry) => entry.kind === 'negative').length;
  const positives = passes.filter((entry) => entry.kind === 'positive').length;
  const reasons = [];
  if (failures.length > 0) reasons.push(`${failures.length} check(s) failed`);
  if (negatives === 0) reasons.push('no injection was ever refused, so nothing was proved about the policy');
  if (positives === 0) reasons.push('the positive control never ran, so a dead page would have passed');
  return {
    passed: reasons.length === 0,
    failed: failures.length,
    passes: passes.length,
    negativeControls: negatives,
    positiveControls: positives,
    reasons,
    exitCode: reasons.length === 0 ? 0 : 1,
  };
}

// ===========================================================================
// A very small CDP client
//
// Lifted from `scripts/keyboard-audit.mjs` and `scripts/ax-tree-audit.mjs` on purpose rather than
// shared through a helper module, for the reason the latter states: these are release gates, and a
// gate that depends on a file another gate can change is a gate that can be broken from a distance.
// The one addition is `on`, because this script has to answer protocol EVENTS — `Fetch.requestPaused`
// is a conversation, not a call.
// ===========================================================================

class Page {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #handlers = new Map();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) {
        for (const handler of this.#handlers.get(message.method) ?? []) handler(message.params);
        return;
      }
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

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, []);
    this.#handlers.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolveSend, reject) => {
      this.#pending.set(id, { resolve: resolveSend, reject });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Evaluates an expression in the page and returns its value.
   *
   * Used only to INSTALL and to INSPECT. Never to inject: a DevTools evaluation is exempt from the
   * page's policy — see the file header, where that exemption is measured rather than assumed.
   */
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
   * all. That distinction is documented at length in `scripts/keyboard-audit.mjs`, where it cost a
   * debugging session.
   */
  async press(key) {
    const KEYS = {
      Enter: { windowsVirtualKeyCode: 13, text: '\r' },
      Space: { windowsVirtualKeyCode: 32, text: ' ', code: 'Space', keyName: ' ' },
    };
    const spec = KEYS[key];
    if (spec === undefined) throw new Error(`no key spec for ${key}`);
    const base = {
      key: spec.keyName ?? key,
      code: spec.code ?? key,
      windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
      nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
      modifiers: 0,
    };
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...base,
      text: spec.text,
      unmodifiedText: spec.text,
    });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await delay(60);
  }

  close() {
    this.#socket.close();
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

async function withChrome(headful, run) {
  const binary = chromePath();
  // Offset by pid so two runs on one machine do not fight over a port, and kept clear of the ranges
  // the keyboard audit (9222+) and the AX audit (9800+) use.
  const port = 9400 + Math.floor(process.pid % 150);
  /**
   * A profile directory per run, removed afterwards.
   *
   * Not a fixed path: this harness seeds an age declaration COOKIE, and a shared profile would carry
   * that declaration into the next run, so a later run against a gated deployment would pass on a
   * cookie it never set. The keyboard audit records the same reasoning.
   */
  const profile = mkdtempSync(join(tmpdir(), 'prl-csp-negative-control-'));
  const child = spawn(
    binary,
    [
      headful ? '--no-first-run' : '--headless=new',
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
    console.log(dim(`  ${version.Browser} — ${headful ? 'headful' : 'headless'}`));

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // The console side of a violation. Not what anything is asserted on — see the file header — but
    // recorded, because it is what a person looking at a browser console would have seen.
    await page.send('Log.enable');
    // Enabled for `Network.setCookie` only: seeding the age declaration before the first navigation
    // is what stops a gated deployment serving the interstitial instead of the page.
    await page.send('Network.enable');
    try {
      return await run(page, version.Browser);
    } finally {
      page.close();
    }
  } finally {
    child.kill('SIGTERM');
    // Chrome writes its profile out as it exits, so removing it races the browser. `maxRetries`
    // gives it its moment, and the catch means the worst case is a few megabytes in the system temp
    // directory rather than a passing run turned into a filesystem error.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.log(
        dim(`  left the browser profile at ${profile} (${error instanceof Error ? error.message : error})`),
      );
    }
  }
}

// ===========================================================================
// The disallowed origin
// ===========================================================================

/**
 * A one-file HTTP server on a spare port, which the policy does not allow and must never be asked.
 *
 * A different port is a different origin, so this is genuinely off-policy without needing a second
 * hostname, a certificate, or the internet. It records every request it receives, and the body it
 * would serve sets a flag — so "the policy failed" is something this run can positively DETECT
 * rather than infer from an absence.
 */
async function startDisallowedOrigin() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end('window.__prlCspRemoteScriptRan = true;\n');
  });
  await new Promise((ready, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ready);
  });
  const { port } = server.address();
  return {
    requests,
    scriptUrl: `http://127.0.0.1:${port}/injected.js`,
    stop: () => new Promise((done) => server.close(done)),
  };
}

// ===========================================================================
// Servers
// ===========================================================================

/**
 * A child server this script owns and must clean up.
 *
 * The same class, for the same reason, as `scripts/a11y-audit.mjs` and `scripts/ax-tree-audit.mjs`:
 * `pnpm --filter ... start` is a wrapper, so killing the wrapper leaves the real server holding the
 * port, and an orphan makes the next run test a build nobody meant to test. Detached, signalled by
 * process group, ESRCH tolerated.
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
// Reporting
// ===========================================================================

const record = [];

/**
 * `kind` is `negative` for an injection that had to be refused and `positive` for the page still
 * working. `buildVerdict` requires at least one passing check of each, which is what stops a run
 * that fell over early from reporting a clean sheet.
 */
const ok = (kind, label, detail = '') => {
  record.push({ level: 'pass', kind, label, detail });
  console.log(`  ${green('✓')} ${label}${detail === '' ? '' : ` ${dim(detail)}`}`);
};
const bad = (kind, label, detail) => {
  record.push({ level: 'fail', kind, label, detail });
  console.log(`  ${red('✗')} ${label}\n${dim(`      ${detail}`)}`);
};
/** Context about the run, never the outcome of a check. Nothing here can change the exit code. */
const note = (label, detail) => {
  record.push({ level: 'note', kind: 'context', label, detail });
  console.log(`  ${yellow('!')} ${label} ${dim(detail)}`);
};
const section = (title) => console.log(`\n${bold(title)}`);

// ===========================================================================
// The run
// ===========================================================================

/**
 * Navigate, intercepting the document response so the attack markup is in the bytes the parser sees.
 *
 * The server's own headers are put back untouched apart from the three that describe the body's
 * encoding and length, which no longer describe it. The `Content-Security-Policy` in particular is
 * the deployment's, nonce and all — the whole point is to make the browser enforce what the app
 * really served, against markup the app really did not.
 */
async function navigateWithInjection(page, pageUrl, remoteScriptUrl) {
  const outcome = { injected: false, nonce: null, policy: null, status: null, error: null, serverHtml: '' };

  page.on('Fetch.requestPaused', async (params) => {
    try {
      const headers = params.responseHeaders ?? [];
      const status = params.responseStatusCode ?? 0;
      // A redirect has no body to attack. Let it through; where it landed is checked afterwards,
      // because an interstitial served under the route's name is the failure `a11y-audit.mjs`
      // describes at length.
      if (status < 200 || status >= 300) {
        await page.send('Fetch.continueRequest', { requestId: params.requestId });
        return;
      }
      outcome.status = status;
      const policy = headers.find((h) => h.name.toLowerCase() === 'content-security-policy')?.value ?? null;
      outcome.policy = policy;
      outcome.nonce = policy === null ? null : (/'nonce-([^']+)'/.exec(policy)?.[1] ?? null);

      const body = await page.send('Fetch.getResponseBody', { requestId: params.requestId });
      const html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
      outcome.serverHtml = html;
      const injected = injectAttackMarkup(html, attackMarkup({ nonce: outcome.nonce, remoteScriptUrl }));
      // `content-length` and `content-encoding` described the server's body and no longer describe
      // this one; leaving either in place makes Chrome truncate the page or try to gunzip plain
      // text. Everything else — the policy above all — is handed back exactly as it arrived.
      const keep = headers.filter(
        (header) =>
          !['content-encoding', 'content-length', 'transfer-encoding'].includes(header.name.toLowerCase()),
      );
      await page.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: status,
        responseHeaders: keep,
        body: Buffer.from(injected, 'utf8').toString('base64'),
      });
      outcome.injected = true;
    } catch (error) {
      // Recorded and then let through, rather than left paused: a hung navigation reports itself as
      // a timeout somewhere else, and the reader has to be told the injection is what failed.
      outcome.error = error instanceof Error ? error.message : String(error);
      await page.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {
        // The request may already be gone; `outcome.error` above is the failure that gets reported,
        // and a second error raised while trying to recover would replace it with a worse message.
      });
    }
  });

  // Only the top-level document is paused. Every subresource — including the disallowed script, if
  // the policy ever let it through — travels its normal path, so what is measured is the browser's
  // behaviour and not the harness's.
  await page.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }],
  });
  await page.send('Page.navigate', { url: pageUrl });

  const requested = new URL(pageUrl).pathname;
  let landed = null;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await delay(100);
    const state = await page
      .evaluate('(() => ({ ready: document.readyState, path: location.pathname }))()')
      .catch(() => null);
    if (state === null) continue;
    landed = state.path;
    if (state.ready === 'complete') break;
  }
  await page.send('Fetch.disable');
  await delay(SETTLE_MS);

  if (landed !== null && landedOnAgeGate(requested, landed)) {
    throw new Error(
      `the age gate intercepted ${requested} and served ${AGE_GATE_PATH} instead. The declaration ` +
        'cookie this harness seeds was refused: check PRL_AGE_GATE_MINIMUM_AGE against ' +
        `${String(AGE_GATE_MINIMUM_CEILING)}, and that the origin is not HTTPS while the profile ` +
        'holds only the unprefixed cookie name.',
    );
  }
  if (outcome.error !== null) throw new Error(`the injection failed: ${outcome.error}`);
  if (!outcome.injected) {
    throw new Error(
      `nothing was injected into ${pageUrl}. Either the document response was never paused or it ` +
        'was not a 2xx HTML body, and either way nothing below would be evidence of anything.',
    );
  }
  return outcome;
}

/** The five injections, judged against what the page reported. */
function judgeNegativeControls(state, executed, disallowedRequests, cases) {
  for (const testCase of cases) {
    const expectation = { directives: testCase.directives, blockedUri: testCase.blockedUri };
    const violation = state.violations.find((report) => matchesViolation(report, expectation));
    const ran = executed[testCase.flag] === true;

    if (ran) {
      bad(
        'negative',
        testCase.title,
        `IT EXECUTED. \`window.${testCase.flag}\` is true, so the policy did not stop this ` +
          'injection. Every other result in this run is beside the point until that is fixed.',
      );
      continue;
    }
    if (violation === undefined) {
      const seen =
        state.violations.length === 0
          ? 'no violation of any kind was reported'
          : `the ${state.violations.length} violation(s) reported were: ${state.violations
              .map((report) => `${report.effectiveDirective} / ${report.blockedURI}`)
              .join(', ')}`;
      bad(
        'negative',
        testCase.title,
        'it did not execute, and the browser reported no matching violation — expected one of ' +
          `${testCase.directives.join(' or ')} blocking "${testCase.blockedUri}", and ${seen}. ` +
          'Silence is not a refusal: an injection that never arrived looks exactly like this.',
      );
      continue;
    }
    ok(
      'negative',
      testCase.title,
      `refused by ${violation.effectiveDirective}, blocked "${violation.blockedURI}"`,
    );
  }

  // The remote case has a second, independent witness that no assertion about the DOM can give: the
  // origin the policy forbids was never asked for anything.
  if (disallowedRequests.length === 0) {
    ok('negative', 'the disallowed origin was never contacted', 'no request reached it at all');
  } else {
    bad(
      'negative',
      'the disallowed origin was never contacted',
      `it received ${disallowedRequests.length} request(s): ${disallowedRequests.join(', ')}. The ` +
        'policy did not stop the fetch, so a real injection would have run attacker code.',
    );
  }
}

/**
 * The page still works.
 *
 * ## The hydration signal, and why it is trustworthy
 *
 * `.prl-boot` is the `BootSequence` overlay. It is rendered BY THE SERVER — deliberately, so it is
 * in the first paint rather than fading in over a shell the reader can already read — and it is
 * removed from the DOM by client-side React, which returns `null` once the boot state reaches
 * `gone`. So the element's ABSENCE is a fact only the client bundle can produce.
 *
 * That makes it a better signal than any generic one:
 *
 *   - It is checked against the bytes this very run received, not against an assumption: the server
 *     HTML captured at interception must CONTAIN it, or the signal is reported as unavailable and
 *     the run fails rather than reading a missing element as success.
 *   - It cannot be satisfied by CSS. Elements are counted in the DOM, so `display: none` — which is
 *     what `globals.css` does under reduced motion — does not fake it.
 *   - It cannot be satisfied by a page that failed to load, which is the trap this control exists
 *     for: a blank page, an error boundary or a document whose every script was blocked all keep the
 *     server's overlay exactly where the server put it.
 *   - And it is this app's own code rather than a framework internal, so it cannot be quietly
 *     invalidated by a React or Next upgrade.
 *
 * Under `'strict-dynamic'` the `'self'` in `script-src` is IGNORED for the parser-inserted tags the
 * document carries, so every one of this app's own `<script src>` bundles is admitted by its nonce
 * and by nothing else. Hydration having happened at all is therefore also proof that the nonce
 * mechanism worked end to end — the same nonce, in the same response, that the wrong-nonce injection
 * above was refused for not having.
 */
async function checkPositiveControls(page, serverHtml) {
  const serverRenderedOverlay = serverHtml.includes('prl-boot');
  if (!serverRenderedOverlay) {
    bad(
      'positive',
      'React hydrated the page',
      'the server HTML contains no "prl-boot" overlay, so its absence from the live DOM proves ' +
        'nothing. The hydration signal this check depends on is gone — find a new one rather than ' +
        'reading this as a pass.',
    );
  }

  const deadline = Date.now() + HYDRATION_TIMEOUT_MS;
  let live = null;
  for (;;) {
    live = await page.evaluate(
      `(() => ({
         overlays: document.querySelectorAll('.prl-boot').length,
         main: document.getElementById('prl-main') !== null,
         probeRan: typeof window.__prlCsp === 'object' && window.__prlCsp !== null,
         themeControls: document.querySelectorAll('.prl-theme__input').length,
       }))()`,
    );
    if (live.overlays === 0 || Date.now() >= deadline) break;
    await delay(200);
  }

  if (!live.main) {
    bad(
      'positive',
      'the route rendered the app',
      'there is no #prl-main in the document, so this is not the app shell. Nothing above is ' +
        'evidence about the page this run was meant to attack.',
    );
  } else {
    ok('positive', 'the route rendered the app', '#prl-main is present');
  }

  if (live.probeRan) {
    ok(
      'positive',
      "the harness's own correctly-nonce'd inline script DID run",
      'so inline script is admitted by the response nonce, and the two refusals above are about ' +
        'the nonce and not about inline script arriving',
    );
  } else {
    bad(
      'positive',
      "the harness's own correctly-nonce'd inline script DID run",
      "window.__prlCsp is absent. The probe was injected with the response's real nonce and did " +
        'not run, so either the nonce is not honoured or the injection never reached the parser — ' +
        'and every negative result above is unattributable.',
    );
  }

  if (serverRenderedOverlay && live.overlays === 0) {
    ok(
      'positive',
      'React hydrated the page',
      'the server-rendered .prl-boot overlay was removed from the DOM by client code, which only ' +
        "the app's own nonce-admitted bundles can do",
    );
  } else if (serverRenderedOverlay) {
    bad(
      'positive',
      'React hydrated the page',
      `the server-rendered .prl-boot overlay is still in the DOM after ${HYDRATION_TIMEOUT_MS}ms, ` +
        'so the client bundle never took over. The page is server markup and nothing more — which ' +
        'is also a page on which no injection could have run, so the refusals above prove nothing.',
    );
  }
}

/**
 * The page is interactive: something that needs JavaScript actually responds.
 *
 * The theme control, driven by a REAL key press through Chrome's input pipeline. It is the right
 * control for this because its whole effect is JavaScript: `ThemeToggle`'s `onChange` calls
 * `applyTheme`, which writes `data-theme` on `<html>`. There is no form post and no CSS that can
 * produce that attribute, so a changed value is proof that a React event handler ran.
 *
 * A visible, not-currently-checked option is chosen on purpose. Two instances of the control are
 * rendered — the header and the mobile sheet — and the sheet's copy has no layout boxes at this
 * viewport; pressing Space on an already-checked radio fires no `change` at all, so a check that
 * picked either would report a dead page on a live one.
 */
async function checkInteractivity(page) {
  const before = await page.evaluate("document.documentElement.getAttribute('data-theme')");
  const target = await page.evaluate(
    `(() => {
       const inputs = [...document.querySelectorAll('.prl-theme__input')];
       const candidate = inputs
         .filter((input) => !input.checked)
         .find((input) => input.getClientRects().length > 0 && getComputedStyle(input).display !== 'none');
       if (candidate === undefined) return null;
       candidate.focus();
       return { value: candidate.value, focused: document.activeElement === candidate, count: inputs.length };
     })()`,
  );
  if (target === null || !target.focused) {
    bad(
      'positive',
      'the page is interactive',
      'no visible, unchecked theme option could be focused, so the interactivity check had ' +
        'nothing to press. That is a failure and not a skip: this is the check that tells a live ' +
        'page apart from a dead one.',
    );
    return;
  }
  await page.press('Space');
  await delay(300);
  const after = await page.evaluate(
    `(() => ({
       theme: document.documentElement.getAttribute('data-theme'),
       checked: document.querySelector('.prl-theme__input[value="' + ${JSON.stringify(target.value)} + '"]').checked,
     }))()`,
  );
  if (after.theme === before) {
    bad(
      'positive',
      'the page is interactive',
      `a real Space press on the "${target.value}" theme option left data-theme at ` +
        `"${before ?? '(absent)'}". The React handler did not run, so this page is inert — and an ` +
        'inert page refuses every injection for the wrong reason.',
    );
    return;
  }
  ok(
    'positive',
    'the page is interactive',
    `a real Space press on the "${target.value}" theme option moved data-theme ` +
      `${before === null ? '(absent)' : `"${before}"`} -> "${after.theme}"`,
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`csp-negative-control — ${err.message}`));
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  const pageUrl = new URL(options.route, options.baseUrl).toString();
  console.log(bold('\nPoker Risk Lab CSP negative control'));
  console.log(yellow('  Five script injections into a real page, in real Chrome, and the browser'));
  console.log(yellow('  must refuse every one of them BY NAME — while the page still works.'));
  console.log(dim(`  ${pageUrl}\n`));

  const servers = [];
  const disallowed = await startDisallowedOrigin();
  const logEntries = [];
  let policy = null;
  let browser = null;

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
    } else {
      const probe = await fetch(pageUrl, { headers: { accept: 'text/html' } }).catch(() => null);
      if (probe === null || !probe.ok) {
        // Not a warning. A CSP control that cannot reach the deployment has proved nothing, and
        // exiting 0 here would put a green tick on a gate that never ran.
        console.error(red(`\n${pageUrl} is not serving. Start it, or pass --start.`));
        console.error(dim('  pnpm --filter @prl/web build && pnpm --filter @prl/web start\n'));
        process.exit(1);
      }
    }

    await withChrome(options.headful, async (page, browserVersion) => {
      browser = browserVersion;
      page.on('Log.entryAdded', (params) => logEntries.push(params.entry));
      for (const cookie of ageDeclarationCookies(options.baseUrl)) {
        await page.send('Network.setCookie', cookie);
      }

      const cases = CASES.map((testCase) =>
        testCase.id === 'remote-script' ? { ...testCase, blockedUri: disallowed.scriptUrl } : testCase,
      );

      const injection = await navigateWithInjection(page, pageUrl, disallowed.scriptUrl);
      policy = injection.policy;
      if (policy === null) {
        bad(
          'negative',
          'the response carried a Content-Security-Policy',
          `${pageUrl} returned HTML with no policy header at all. There is nothing to enforce.`,
        );
        return;
      }
      note('policy under test', `${policy.length} chars, nonce ${injection.nonce}`);

      // The event-handler case needs the handler to be REACHED, which needs an activation. Enter on
      // a focused button is a real one and, unlike a click at coordinates, does not depend on where
      // the injected element ended up on the page.
      const focused = await page.evaluate(
        `(() => {
           const button = document.getElementById(${JSON.stringify(EVENT_HANDLER_ELEMENT_ID)});
           if (button === null) return false;
           button.scrollIntoView();
           button.focus();
           return document.activeElement === button;
         })()`,
      );
      if (!focused) {
        bad(
          'negative',
          'an inline onclick handler does not execute',
          'the injected button is not in the document, so the handler was never reached and this ' +
            'case was not tested. A case that could not run is a failure.',
        );
      } else {
        await page.press('Enter');
        await delay(SETTLE_MS);
      }

      const state = await page.evaluate('window.__prlCsp ?? { violations: [], evalOutcome: null }');
      const executed = await page.evaluate(
        `(() => ({
           __prlCspInlineNoNonceRan: window.__prlCspInlineNoNonceRan === true,
           __prlCspInlineWrongNonceRan: window.__prlCspInlineWrongNonceRan === true,
           __prlCspEventHandlerRan: window.__prlCspEventHandlerRan === true,
           __prlCspEvalRan: window.__prlCspEvalRan === true,
           __prlCspRemoteScriptRan: window.__prlCspRemoteScriptRan === true,
         }))()`,
      );

      section('Negative control — every injection is refused');
      // When the button could not be focused the event-handler case has already been failed above
      // with the reason. Judging it again here would print a second, less accurate failure for the
      // same one case and would double-count it in the summary.
      judgeNegativeControls(
        state,
        executed,
        disallowed.requests,
        focused ? cases : cases.filter((testCase) => testCase.id !== 'event-handler-attribute'),
      );
      // The eval case has a second witness the DOM event cannot give: what the page's own `try`
      // block caught. A violation with no throw would mean the evaluation happened anyway.
      if (/^EvalError/.test(String(state.evalOutcome ?? ''))) {
        ok('negative', 'eval() threw in page code', String(state.evalOutcome).slice(0, 90));
      } else {
        bad(
          'negative',
          'eval() threw in page code',
          `the page-side try/catch reported "${state.evalOutcome}", not an EvalError. A policy ` +
            'that reports a violation and evaluates the string anyway blocks nothing.',
        );
      }

      section('Positive control — the page still works');
      await checkPositiveControls(page, injection.serverHtml);
      await checkInteractivity(page);
    });
  } catch (error) {
    bad('run', 'the control ran to completion', error instanceof Error ? error.message : String(error));
  } finally {
    for (const server of servers) server.stop();
    await disallowed.stop();
  }

  const verdict = buildVerdict(record);

  if (options.out !== null) {
    const outPath = resolve(REPO_ROOT, options.out);
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          tool: 'csp-negative-control.mjs — script injection into a real page, in real Chrome',
          kind: 'csp-enforcement',
          coverageWarning:
            'Proves that THIS browser enforces the policy on THIS route. It says nothing about ' +
            'other browsers, other routes, the API origin, or whether the app has an XSS at all.',
          browser,
          baseUrl: options.baseUrl,
          route: options.route,
          policy,
          generatedAt: new Date().toISOString(),
          record,
          // What a person watching the browser console would have seen, kept because it is the
          // other half of the evidence even though nothing is asserted on it.
          consoleSecurityLog: logEntries
            .filter((entry) => /content security policy/i.test(entry.text ?? ''))
            .map((entry) => ({ level: entry.level, text: entry.text })),
          verdict,
        },
        null,
        2,
      )}\n`,
    );
    console.log(dim(`\n  findings written to ${outPath}`));
  }

  console.log(bold('\nSummary'));
  console.log(`  checks passed        ${verdict.passes}`);
  console.log(`  checks failed        ${verdict.failed}`);
  console.log(dim(`  injections refused   ${verdict.negativeControls}`));
  console.log(dim(`  positive controls    ${verdict.positiveControls}`));
  if (verdict.failed > 0) {
    console.log(bold('\n  failures'));
    for (const entry of record.filter((item) => item.level === 'fail')) {
      console.log(red(`    - ${entry.label} — ${entry.detail}`));
    }
  }

  if (verdict.passed) {
    console.log(green(bold('\nPASS — the browser refused every injection, and the page still worked.')));
  } else {
    console.log(red(bold('\nFAIL')));
    for (const reason of verdict.reasons) console.log(red(`  ${reason}`));
  }

  console.log(
    dim(
      '\n  Caveat: this is one browser, one route, one build. It proves that the policy this\n' +
        '  deployment served was ENFORCED by the Chrome that ran here — the thing no unit test\n' +
        '  and no `fetch` can prove — and it proves the page survived the enforcement. It does\n' +
        '  not prove Firefox or Safari agree, it does not cover the API origin, and it is not a\n' +
        '  statement that the app has no XSS: a CSP bounds the damage of one, and what is\n' +
        '  measured here is the bound.\n',
    ),
  );

  process.exit(verdict.exitCode);
}

if (import.meta.main) await main();
