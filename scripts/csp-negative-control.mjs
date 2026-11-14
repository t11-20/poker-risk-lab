#!/usr/bin/env node
/**
 * `pnpm run test:csp`: proves in real Chrome that the production Content-Security-Policy blocks five
 * script injections and that the page still hydrates and responds. csp-policy.test.ts checks the
 * policy string and smoke-test.mjs §10 checks it arrives; neither runs a browser.
 *
 * Injections arrive in the document bytes. The Fetch domain pauses the document response, splices
 * markup before `</body>` and fulfils it with the server's own headers and nonce. The obvious routes
 * prove nothing (all measured): `Runtime.evaluate` is exempt from the page's CSP, `'strict-dynamic'`
 * lets `createElement('script')` run with any nonce, and `innerHTML` scripts never execute.
 * Violations are read from the `securitypolicyviolation` event, not console text.
 *
 * Run against a production build. The dev policy adds `'unsafe-eval'`. Only Chrome, one route, and
 * script injection are covered.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// The gate's own constants, so the seeded cookie name is the one the proxy reads.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MINIMUM_CEILING,
  AGE_GATE_PATH,
} from '../apps/web/src/lib/age-gate.ts';
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
 * Well-formed (16 base64 zero bytes, the shape `src/proxy.ts` mints) so a block is attributable to the
 * value. `attackMarkup` refuses a deployment whose nonce equals it.
 */
export const WRONG_NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';

export const EVENT_HANDLER_ELEMENT_ID = 'prl-csp-negative-control-onclick';

/**
 * `directives` is a list because CSP3 reports `script-src-elem`/`script-src-attr` while CSP2 reports
 * `script-src`. `blockedUri` stops one case's violation satisfying another's.
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
    // Filled in per run with the disallowed origin's address.
    blockedUri: null,
  },
];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path) => typeof path === 'string' && path !== '');

/** About twenty times local hydration, so a slow machine is not reported as a CSP defect. */
const HYDRATION_TIMEOUT_MS = 15_000;

/** After `load`, so violations raised during parsing have been dispatched. */
const SETTLE_MS = 500;

const DEFAULTS = {
  baseUrl: process.env.PRL_WEB_ORIGIN ?? 'http://127.0.0.1:3000',
  apiUrl: process.env.PRL_API_ORIGIN ?? 'http://127.0.0.1:3001',
  // `/` renders without the API and carries the boot overlay and theme control the positive controls use.
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
    // `pnpm run test:csp -- --headful` passes the `--` through.
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

/**
 * Segment matching, never `includes`, because `/age-checkers` is not the gate. A request FOR the gate
 * does not count, so `--route` can target the interstitial.
 */
export function landedOnAgeGate(requestedPath, landedPath) {
  const isGate = (path) => path === AGE_GATE_PATH || path.startsWith(`${AGE_GATE_PATH}/`);
  return isGate(landedPath) && !isGate(requestedPath);
}

/**
 * `AGE_GATE_MINIMUM_CEILING` satisfies any configured threshold. The `__Host-` name is seeded only over
 * HTTPS, because Chrome refuses it otherwise.
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

/**
 * The probe comes first with the real nonce, so its violation listener hears every attack, and it
 * calls `eval` as page code. Attacks only assign globals and never dereference a harness object, so a
 * missing probe cannot look like a block. The `<script src>` points at a local off-policy port, so the
 * check needs no internet and a policy failure is positively detected.
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
 * Before `</body>`, measured as a position React hydrates around without removing. A document with
 * no `</body>` throws, because a silent no-op would mean no injection ran.
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
 * Directive and blocked URI must both match, or the inline-script violation could satisfy the eval
 * case. `violatedDirective` is the CSP2 name for `effectiveDirective`.
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

/** Pass needs no failure, one negative-control pass and one positive-control pass. */
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

// CDP client copied, not shared, from keyboard-audit.mjs so one gate cannot break another.

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

  /** Install and inspect only. A DevTools evaluation is exempt from the page's policy. */
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

  /** `keyDown`, not `rawKeyDown`, which suppresses the default action so Enter on a button does nothing. */
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
  // Clear of keyboard-audit (9222+) and ax-tree-audit (9800+).
  const port = 9400 + Math.floor(process.pid % 150);
  // A fresh profile per run, so a seeded age cookie cannot carry into a later run.
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
    const version = await waitForDevtools(child, port);
    console.log(dim(`  ${version.Browser} — ${headful ? 'headful' : 'headless'}`));

    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    );
    const page = await Page.open(target.webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // Console violations are recorded for the report but never asserted on.
    await page.send('Log.enable');
    // For `Network.setCookie`, so a gated deployment serves the page.
    await page.send('Network.enable');
    try {
      return await run(page, version.Browser);
    } finally {
      page.close();
    }
  } finally {
    child.kill('SIGTERM');
    // Chrome writes its profile as it exits, so removal retries and tolerates failure.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      console.log(
        dim(`  left the browser profile at ${profile} (${error instanceof Error ? error.message : error})`),
      );
    }
  }
}

/** A different port is a different origin. It records every request, so a policy failure is detected. */
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
    `${seen} on ${host}:${String(target.port)}. --start tests a server this run started, so it ` +
      'will not score one it did not. Stop it, pass another --base-url/--api-url, or leave out ' +
      '--start to test that server on purpose.',
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

const record = [];

const ok = (kind, label, detail = '') => {
  record.push({ level: 'pass', kind, label, detail });
  console.log(`  ${green('✓')} ${label}${detail === '' ? '' : ` ${dim(detail)}`}`);
};
const bad = (kind, label, detail) => {
  record.push({ level: 'fail', kind, label, detail });
  console.log(`  ${red('✗')} ${label}\n${dim(`      ${detail}`)}`);
};
/** Context about the run. Never changes the exit code. */
const note = (label, detail) => {
  record.push({ level: 'note', kind: 'context', label, detail });
  console.log(`  ${yellow('!')} ${label} ${dim(detail)}`);
};
const section = (title) => console.log(`\n${bold(title)}`);

/**
 * The server's headers are returned untouched, CSP and nonce included, apart from those describing the
 * body's encoding and length.
 */
async function navigateWithInjection(page, pageUrl, remoteScriptUrl) {
  const outcome = { injected: false, nonce: null, policy: null, status: null, error: null, serverHtml: '' };

  page.on('Fetch.requestPaused', async (params) => {
    try {
      const headers = params.responseHeaders ?? [];
      const status = params.responseStatusCode ?? 0;
      // A redirect has no body to attack. Where it landed is checked afterwards.
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
      // The old length and encoding would make Chrome truncate the page or gunzip plain text.
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
      // Let through, not left paused, so the injection failure is what gets reported.
      outcome.error = error instanceof Error ? error.message : String(error);
      await page.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {
        // The request may already be gone. Keep the first error.
      });
    }
  });

  // Only the top-level document is paused. Subresources travel their normal path.
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

  // A second witness: the forbidden origin was never asked for anything.
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
 * Hydration signal: `.prl-boot` is server-rendered and removed by client React, so its absence is
 * something only the client bundle can produce. It is counted in the DOM, so `display: none` cannot
 * fake it, and the captured server HTML must contain it. Under `'strict-dynamic'` the app's own
 * bundles load only by nonce, so hydration also proves the nonce worked.
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
 * The theme control, by a real key press. `data-theme` can only change if a React handler ran. A
 * visible unchecked option is chosen, because Space on a checked radio fires no `change`.
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
      for (const url of options.withApi ? [options.baseUrl, options.apiUrl] : [options.baseUrl]) {
        await refuseOccupiedPort(url);
      }
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
      const probe = await fetch(pageUrl, { headers: { accept: 'text/html' } }).catch(() => null);
      if (probe === null || !probe.ok) {
        // Not a warning. A control that cannot reach the deployment has proved nothing.
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

      // Enter on a focused button activates the handler wherever the element landed.
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
      // When focus failed, the case already failed above. Judging it again would double-count it.
      judgeNegativeControls(
        state,
        executed,
        disallowed.requests,
        focused ? cases : cases.filter((testCase) => testCase.id !== 'event-handler-attribute'),
      );
      // A violation with no EvalError would mean the evaluation happened anyway.
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
