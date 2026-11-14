#!/usr/bin/env node
/**
 * `pnpm run test:age-gate`: proves in a production build and real Chrome that the age gate, switched
 * on, refuses document navigations, router navigations and `purpose: prefetch` requests, honours the
 * declaration cookie, leaves router prefetches and the legal pages open, and gates the whole site
 * under `PRL_AGE_GATE_SCOPE=site`. Every refusal is paired with a request that must succeed.
 * It does not cover the shipped (gate off) configuration, `__Host-` cookies over TLS, other browsers
 * or `x-forwarded-proto`. Next deletes the `rsc` header before middleware runs, which unit tests
 * cannot reproduce; that defect is why this harness exists.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// The gate's own constants, so a renamed cookie or parameter cannot leave this harness passing.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_DECLARE_PARAM,
  AGE_GATE_MAX_AGE_SECONDS,
  AGE_GATE_PATH,
  AGE_GATE_RETURN_PARAM,
} from '../apps/web/src/lib/age-gate.ts';
import { withChrome } from './chrome-devtools.mjs';
import { ManagedServer, refuseOccupiedPort } from './gate-servers.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const paint = (code, s) => (NO_COLOR ? s : `\u001b[${code}m${s}\u001b[0m`);
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const red = (s) => paint('31', s);
const green = (s) => paint('32', s);
const yellow = (s) => paint('33', s);

/**
 * Deliberately not the default 18, so a server that ignored its environment fails. It sits inside the
 * 13 to 25 band the module clamps to.
 */
export const AUDIT_MINIMUM_AGE = 21;

/** A cookie declaring 18 sent to a server asking 21 must not open the tables. */
export const STALE_DECLARATION = 18;

/** Generous, so a slow machine is not reported as a gate defect. A router navigation takes <300ms. */
const NAVIGATION_SETTLE_MS = 2_500;

const PREFETCH_SETTLE_MS = 1_500;

const CHALLENGE_FOR = (path) =>
  `${AGE_GATE_PATH}?${new URLSearchParams({ [AGE_GATE_RETURN_PARAM]: path }).toString()}`;

/**
 * Two servers because the scope is read from the environment. 3000/3001 are the app and API, 3456 is
 * `test:ax`, 3457 is `test:csp`.
 */
const DEFAULTS = {
  port: Number(process.env.PRL_AGE_GATE_AUDIT_PORT ?? 3458),
  sitePort: Number(process.env.PRL_AGE_GATE_AUDIT_SITE_PORT ?? 3459),
  headful: false,
  readyTimeoutSeconds: 120,
  out: null,
};

const HELP = `
${bold('pnpm run test:age-gate')} — the age gate, against a running build and in real Chrome

  ${yellow('Switches the gate ON in two configurations, then makes the requests a reader makes:')}
  ${yellow('a document navigation, an in-app router navigation, a prefetch, and a declaration.')}
  ${yellow('Every refusal is paired with a request that must succeed. Needs a production build.')}

  Server
    --port <n>            port for the play-scope server    (default ${DEFAULTS.port})
    --site-port <n>       port for the site-scope server    (default ${DEFAULTS.sitePort})
    --ready-timeout <s>   how long to wait for a server     (default ${DEFAULTS.readyTimeoutSeconds})

  Reporting
    --headful             run Chrome with a window, to watch it
    --out <file>          also write the findings as JSON
    --json <file>         the same thing, spelt the way test:ax spells it
    -h, --help            this text

  There is no --base-url: this harness starts the servers it measures, because a server somebody
  else started is a server in an unknown configuration, and the configuration is the thing under
  test. Exits 0 only when every request was answered the way the gate says it answers them.
`;

export function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // `pnpm run test:age-gate -- --headful` passes the `--` through.
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
      case '--headful':
        options.headful = true;
        break;
      case '--port':
        options.port = Number(need());
        break;
      case '--site-port':
        options.sitePort = Number(need());
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
  const port = (name, chosen) => {
    if (!Number.isInteger(chosen) || chosen < 1024 || chosen > 65535) {
      throw new Error(`${name} must be a whole number between 1024 and 65535, not ${chosen}`);
    }
  };
  port('--port', options.port);
  port('--site-port', options.sitePort);
  if (options.port === options.sitePort) {
    throw new Error('--port and --site-port must differ; the two scopes are two servers');
  }
  if (!Number.isInteger(options.readyTimeoutSeconds) || options.readyTimeoutSeconds < 1) {
    throw new Error('--ready-timeout must be a positive whole number of seconds');
  }
  return options;
}

export function documentHeaders() {
  return {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  };
}

/**
 * Captured from Chrome 151. Chrome sends `rsc: 1` and Next deletes it before the proxy sees it, so both
 * shapes are checked.
 */
export function routerNavigationHeaders({ from = '/learn', withRsc = true } = {}) {
  const headers = {
    accept: '*/*',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'next-url': from,
  };
  if (withRsc) headers.rsc = '1';
  return headers;
}

/**
 * Must NOT be gated. A redirect would cache the interstitial in the router under the gated route's
 * name. The proxy `matcher` excludes `next-router-prefetch` before the middleware runs.
 */
export function prefetchHeaders({ from = '/learn', spelling = 'next-router-prefetch' } = {}) {
  const headers = routerNavigationHeaders({ from });
  if (spelling === 'purpose') headers.purpose = 'prefetch';
  else headers['next-router-prefetch'] = '1';
  return headers;
}

/** Null when there is no age cookie. Valueless attributes map to `true`. */
export function parseDeclarationCookie(setCookieValues) {
  for (const raw of setCookieValues) {
    const [pair, ...rest] = raw.split(';');
    const separator = (pair ?? '').indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!AGE_GATE_COOKIE_NAMES.includes(name)) continue;
    const attributes = {};
    for (const part of rest) {
      const at = part.indexOf('=');
      if (at < 0) attributes[part.trim().toLowerCase()] = true;
      else attributes[part.slice(0, at).trim().toLowerCase()] = part.slice(at + 1).trim();
    }
    return { name, value: pair.slice(separator + 1).trim(), attributes, raw };
  }
  return null;
}

/** 303, because a cached 302 for `/play` would outlive the declaration (see `src/proxy.ts`). */
export function isChallenge(status, location, path) {
  if (status !== 303) return false;
  if (location === null) return false;
  return location === CHALLENGE_FOR(path);
}

/** Segment matching, never `includes`, because `/age-checkers` is not the gate. */
export function landedOnAgeGate(requestedPath, landedPath) {
  const isGate = (path) => path === AGE_GATE_PATH || path.startsWith(`${AGE_GATE_PATH}/`);
  return isGate(landedPath) && !isGate(requestedPath);
}

/**
 * Pass needs no failure, at least one gated pass, one open pass and one browser pass, so a run that
 * refused nothing, allowed nothing or never opened a browser cannot pass.
 */
export function buildVerdict(record) {
  const failures = record.filter((entry) => entry.level === 'fail');
  const passes = record.filter((entry) => entry.level === 'pass');
  const gated = passes.filter((entry) => entry.kind === 'gated').length;
  const open = passes.filter((entry) => entry.kind === 'open').length;
  const browser = passes.filter((entry) => entry.layer === 'browser').length;
  const reasons = [];
  if (failures.length > 0) reasons.push(`${failures.length} check(s) failed`);
  if (gated === 0) reasons.push('nothing was ever refused, so nothing was proved about the gate');
  if (open === 0) reasons.push('nothing was ever allowed, so a dead server would have passed');
  if (browser === 0) reasons.push('no check ran in a browser, which is the gap this harness exists to close');
  return {
    passed: reasons.length === 0,
    failed: failures.length,
    passes: passes.length,
    gatedChecks: gated,
    openChecks: open,
    browserChecks: browser,
    reasons,
    exitCode: reasons.length === 0 ? 0 : 1,
  };
}

const record = [];

const ok = (kind, layer, label, detail = '') => {
  record.push({ level: 'pass', kind, layer, label, detail });
  console.log(`  ${green('✓')} ${label}${detail === '' ? '' : ` ${dim(detail)}`}`);
};
const bad = (kind, layer, label, detail) => {
  record.push({ level: 'fail', kind, layer, label, detail });
  console.log(`  ${red('✗')} ${label}\n${dim(`      ${detail}`)}`);
};
/** Context about the run. Never changes the exit code. */
const note = (label, detail) => {
  record.push({ level: 'note', kind: 'context', layer: 'context', label, detail });
  console.log(`  ${yellow('!')} ${label} ${dim(detail)}`);
};
const section = (title) => console.log(`\n${bold(title)}`);

const judge = (held, kind, layer, label, passDetail, failDetail) => {
  if (held) ok(kind, layer, label, passDetail);
  else bad(kind, layer, label, failDetail);
  return held;
};

/** Redirects are not followed, so the status and `Location` of a refusal can be asserted. */
async function request(url, { headers = {}, cookie = null, method = 'GET' } = {}) {
  const sent = { ...headers };
  if (cookie !== null) sent.cookie = cookie;
  const response = await fetch(url, {
    method,
    headers: sent,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text().catch(() => '');
  return {
    status: response.status,
    location: response.headers.get('location'),
    contentType: response.headers.get('content-type'),
    setCookie: response.headers.getSetCookie(),
    hasCsp: response.headers.get('content-security-policy') !== null,
    body,
  };
}

/**
 * Next can answer an RSC request with its own 307 before the proxy runs, so the whole redirect chain is
 * returned and asserted on.
 */
async function requestChain(url, options = {}, limit = 5) {
  const chain = [];
  let current = url;
  for (let hop = 0; hop < limit; hop += 1) {
    const response = await request(current, options);
    chain.push({ url: current, ...response });
    if (response.status < 300 || response.status >= 400 || response.location === null) break;
    current = new URL(response.location, current).toString();
  }
  return chain;
}

function chainHitTheGate(chain) {
  return chain.some((hop) => {
    if (hop.location === null) return false;
    const target = new URL(hop.location, hop.url).pathname;
    return landedOnAgeGate(new URL(hop.url).pathname, target);
  });
}

const describeChain = (chain) =>
  chain.map((hop) => `${hop.status}${hop.location === null ? '' : ` -> ${hop.location}`}`).join(' ');

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
    await new Promise((ready, fail) => {
      socket.addEventListener('open', ready, { once: true });
      socket.addEventListener('error', () => fail(new Error(`could not connect to ${wsUrl}`)), {
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

  /** A real press through `Input.dispatchMouseEvent`, not a synthetic `element.click()`. */
  async click(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async hover(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
  }

  close() {
    this.#socket.close();
  }
}

function withPage(headful, run) {
  const chrome = {
    headful,
    // Clear of keyboard-audit (9222+), ax-tree-audit (9800+) and csp-negative-control (9400+).
    port: 9600 + Math.floor(process.pid % 150),
    // A fresh profile per run, so no declaration cookie survives from a previous run.
    freshProfile: 'prl-age-gate-audit-',
    flags: ['--window-size=1440,900'],
    dim,
  };
  return withChrome(chrome, async ({ version, openTab }) => {
    console.log(dim(`  ${version.Browser} — ${headful ? 'headful' : 'headless'}`));
    const page = await Page.open(await openTab());
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    // Watched, never seeded. The cookie under test must come from the server's `Set-Cookie`.
    await page.send('Network.enable');
    try {
      return await run(page, version.Browser);
    } finally {
      page.close();
    }
  });
}

const OCCUPIED_PORT_ADVICE =
  'This harness starts the servers it measures, so it will not reuse one it did not configure. Stop ' +
  'it, or pass --port/--site-port.';

/**
 * Every gate variable is set, so a stray value in the developer's environment cannot change what is
 * measured. An empty jurisdiction is ignored by `readAgeGateConfig`.
 */
function serverEnv(port, scope) {
  return {
    NODE_ENV: 'production',
    PORT: String(port),
    PRL_AGE_GATE: 'on',
    PRL_AGE_GATE_MINIMUM_AGE: String(AUDIT_MINIMUM_AGE),
    PRL_AGE_GATE_SCOPE: scope,
    PRL_AGE_GATE_JURISDICTION: '',
  };
}

function buildId() {
  const path = join(REPO_ROOT, 'apps', 'web', '.next', 'BUILD_ID');
  if (!existsSync(path)) {
    throw new Error(
      'apps/web/.next/BUILD_ID is missing, so there is no production build to measure. Run ' +
        '`pnpm --filter @prl/web build` first — a pass against `next dev` would not be evidence ' +
        'about what ships.',
    );
  }
  return readFileSync(path, 'utf8').trim();
}

/** Properties 1 to 4 over HTTP. Each gated check has an open check that differs by one cookie or header. */
async function checkPlayScopeOverHttp(origin) {
  section('The server is up, and the gate is not simply refusing everything');

  // `/terms` is always open, so this is both the server-is-up control and half of property 5.
  const terms = await request(new URL('/terms', origin), { headers: documentHeaders() });
  judge(
    terms.status === 200 && terms.body.includes('<html'),
    'open',
    'http',
    'GET /terms is served, gate or no gate',
    `200, ${terms.body.length} bytes of HTML`,
    `expected 200 and HTML, got ${terms.status} (${terms.location ?? 'no Location'}). Nothing below ` +
      'this line means anything if the server is not answering.',
  );

  const learn = await request(new URL('/learn', origin), { headers: documentHeaders() });
  judge(
    learn.status === 200,
    'open',
    'http',
    'GET /learn is open under the play scope',
    'the written material is not behind an age question',
    `expected 200, got ${learn.status} -> ${learn.location ?? '(no Location)'}. Under scope=play only ` +
      'the tables are gated; gating a lesson on probability is not proportionate to anything.',
  );

  const interstitial = await request(new URL(AGE_GATE_PATH, origin), { headers: documentHeaders() });
  const asksForTheConfiguredAge = interstitial.body.includes(`are you ${AUDIT_MINIMUM_AGE} or older`);
  judge(
    interstitial.status === 200 && asksForTheConfiguredAge,
    'open',
    'http',
    `GET ${AGE_GATE_PATH} renders and asks for ${AUDIT_MINIMUM_AGE}`,
    'the threshold on the page is the one this run configured, not the built-in default',
    `expected 200 with the question at ${AUDIT_MINIMUM_AGE}, got ${interstitial.status} and ` +
      `${asksForTheConfiguredAge ? 'the right question' : 'a page that does not ask for that threshold'}. ` +
      'A server showing the default 18 here is a server that ignored its environment, and every ' +
      'other check in this run would then be measuring a configuration nobody chose.',
  );

  section('1. A document navigation to a gated route is redirected to the interstitial');

  const gatedDocument = await request(new URL('/play', origin), { headers: documentHeaders() });
  judge(
    isChallenge(gatedDocument.status, gatedDocument.location, '/play'),
    'gated',
    'http',
    'GET /play with no declaration is answered 303 to the interstitial',
    `303 -> ${gatedDocument.location}`,
    `expected 303 -> ${CHALLENGE_FOR('/play')}, got ${gatedDocument.status} -> ` +
      `${gatedDocument.location ?? '(no Location)'}`,
  );
  judge(
    gatedDocument.hasCsp,
    'gated',
    'http',
    'the redirect carries the security headers too',
    'a policy applied only to responses carrying HTML is a policy with a hole in it',
    'the 303 had no Content-Security-Policy. src/proxy.ts sets the full header set on the redirect ' +
      'precisely because a redirect is a response the browser handles.',
  );

  const withQuery = await request(new URL('/play?state=decision', origin), { headers: documentHeaders() });
  judge(
    withQuery.status === 303 && withQuery.location === CHALLENGE_FOR('/play?state=decision'),
    'gated',
    'http',
    'the route the reader asked for is carried through the redirect, query and all',
    withQuery.location ?? '',
    `expected 303 -> ${CHALLENGE_FOR('/play?state=decision')}, got ${withQuery.status} -> ` +
      `${withQuery.location ?? '(no Location)'}`,
  );

  section('2. The declaration sets a cookie that actually works');

  const declareUrl = new URL(AGE_GATE_PATH, origin);
  declareUrl.searchParams.set(AGE_GATE_RETURN_PARAM, '/play');
  declareUrl.searchParams.set(AGE_GATE_DECLARE_PARAM, String(AUDIT_MINIMUM_AGE));
  const declared = await request(declareUrl, { headers: documentHeaders() });
  const cookie = parseDeclarationCookie(declared.setCookie);
  judge(
    declared.status === 303 && declared.location === '/play' && cookie !== null,
    'open',
    'http',
    'declaring is answered 303 back to the route, with a Set-Cookie',
    `303 -> ${declared.location}, ${cookie === null ? 'no cookie' : cookie.raw}`,
    `expected 303 -> /play with a declaration cookie, got ${declared.status} -> ` +
      `${declared.location ?? '(no Location)'} and ${declared.setCookie.length} Set-Cookie header(s)`,
  );

  if (cookie !== null) {
    // Over plain HTTP the cookie must not be `__Host-` or `Secure`. Browsers discard a `Secure` cookie
    // sent over http, so the gate would ask for ever.
    const attributes = cookie.attributes;
    const shaped =
      cookie.name === AGE_GATE_COOKIE_NAMES[1] &&
      attributes.secure === undefined &&
      attributes.httponly === true &&
      attributes.path === '/' &&
      attributes.samesite === 'Lax' &&
      attributes['max-age'] === String(AGE_GATE_MAX_AGE_SECONDS);
    judge(
      shaped,
      'open',
      'http',
      'the cookie is the shape a browser over plain HTTP will actually keep',
      `${cookie.name}, HttpOnly, Path=/, SameSite=Lax, Max-Age=${AGE_GATE_MAX_AGE_SECONDS}, not Secure`,
      `got ${cookie.raw}. Over http the name must be the unprefixed one and Secure must be absent: ` +
        'a browser discards a Secure cookie sent over http, and a declaration that never sticks is ' +
        'a gate that asks again for ever.',
    );
    judge(
      cookie.value === String(AUDIT_MINIMUM_AGE),
      'open',
      'http',
      'the cookie records the THRESHOLD it was declared against, not a flag',
      `${cookie.name}=${cookie.value}`,
      `expected the value ${AUDIT_MINIMUM_AGE}, got "${cookie.value}". A boolean cookie would carry ` +
        'every existing reader silently past a raised threshold.',
    );

    const admitted = await request(new URL('/play', origin), {
      headers: documentHeaders(),
      // Replayed exactly as the server set it.
      cookie: `${cookie.name}=${cookie.value}`,
    });
    judge(
      admitted.status === 200,
      'open',
      'http',
      'the same navigation, carrying that cookie, reaches the page',
      '200 from /play',
      `expected 200, got ${admitted.status} -> ${admitted.location ?? '(no Location)'}. The gate set a ` +
        'cookie it then did not honour, which is a reader stuck in a loop.',
    );
  }

  const stale = await request(new URL('/play', origin), {
    headers: documentHeaders(),
    cookie: `${AGE_GATE_COOKIE_NAMES[1]}=${STALE_DECLARATION}`,
  });
  judge(
    isChallenge(stale.status, stale.location, '/play'),
    'gated',
    'http',
    `a declaration against ${STALE_DECLARATION} does not open a ${AUDIT_MINIMUM_AGE} gate`,
    'the deployment changed the question, so the old answer is not an answer',
    `expected 303 to the interstitial, got ${stale.status}. The gate is noticing that a cookie exists ` +
      'rather than reading what it says.',
  );

  section('3. An in-app router navigation is gated as well as a document navigation');

  // Chrome sends `rsc: 1` and Next strips it before the proxy, so both shapes are checked.
  for (const [label, headers] of [
    ['as Chrome sends it (rsc: 1 present)', routerNavigationHeaders({ withRsc: true })],
    ['as the proxy is handed it (rsc stripped by Next)', routerNavigationHeaders({ withRsc: false })],
  ]) {
    const chain = await requestChain(new URL('/play', origin), { headers });
    judge(
      chainHitTheGate(chain),
      'gated',
      'http',
      `a router navigation to /play is gated — ${label}`,
      describeChain(chain),
      `the chain never reached the interstitial: ${describeChain(chain)}. A gate a single in-app ` +
        'click walks around is not a gate.',
    );
  }

  const routerAdmitted = await requestChain(new URL('/play', origin), {
    headers: routerNavigationHeaders(),
    cookie: `${AGE_GATE_COOKIE_NAMES[1]}=${AUDIT_MINIMUM_AGE}`,
  });
  const last = routerAdmitted.at(-1);
  judge(
    !chainHitTheGate(routerAdmitted) &&
      last.status === 200 &&
      (last.contentType ?? '').includes('x-component'),
    'open',
    'http',
    'a router navigation carrying the declaration reaches the page',
    `${describeChain(routerAdmitted)}, ${last.contentType}`,
    `expected an RSC payload, got ${describeChain(routerAdmitted)} (${last.contentType}). The gate is ` +
      'refusing a declared reader, which breaks every in-app link to the tables.',
  );

  // A surviving `_rsc` parameter would return the reader to an RSC payload, a blank screen.
  const withRscParam = await request(new URL('/play?_rsc=abc123', origin), { headers: documentHeaders() });
  judge(
    withRscParam.status === 303 && withRscParam.location === CHALLENGE_FOR('/play'),
    'gated',
    'http',
    'the _rsc parameter is dropped from the route the reader is sent back to',
    withRscParam.location ?? '',
    `expected 303 -> ${CHALLENGE_FOR('/play')}, got ${withRscParam.status} -> ` +
      `${withRscParam.location ?? '(no Location)'}. A return path carrying _rsc sends the reader to a ` +
      'payload rather than to a page.',
  );

  section('4. A router prefetch is NOT gated — and the other spelling is not a prefetch at all');

  const routerPrefetch = await requestChain(new URL('/play', origin), { headers: prefetchHeaders() });
  const stub = routerPrefetch.at(-1);
  judge(
    !chainHitTheGate(routerPrefetch) && stub.status === 200,
    'open',
    'http',
    'a router prefetch of /play is answered normally',
    describeChain(routerPrefetch),
    `expected the prefetch to be left alone, got ${describeChain(routerPrefetch)}. Redirecting one ` +
      "puts the interstitial into the router's cache under the gated route's name.",
  );
  judge(
    !stub.body.includes(AGE_GATE_PATH) && !stub.body.includes('Six-handed table'),
    'gated',
    'http',
    'and the prefetched payload carries neither the interstitial nor the table',
    `${stub.body.length} bytes, a routing stub`,
    `the prefetch payload is ${stub.body.length} bytes and contains page content. Next answers a ` +
      'router prefetch for a dynamic route with a segment tree and nothing else; a payload with the ' +
      'table in it would be a page delivered past the gate, and one with the interstitial in it ' +
      'would be a poisoned router cache.',
  );

  /*
   * `purpose: prefetch` changes nothing on the server. Next answers it with the whole page (38KB against
   * a 264-byte stub), so the matcher no longer excludes it and it is gated.
   */
  for (const [label, headers] of [
    ['as a document', { ...documentHeaders(), purpose: 'prefetch' }],
    ['as a fetch', prefetchHeaders({ spelling: 'purpose' })],
  ]) {
    const chain = await requestChain(new URL('/play', origin), { headers });
    judge(
      chainHitTheGate(chain),
      'gated',
      'http',
      `a request carrying purpose: prefetch is gated, because Next answers it with the page — ${label}`,
      describeChain(chain),
      `the chain never reached the interstitial: ${describeChain(chain)}. Next renders the whole page ` +
        'for this header, so stepping aside for it is stepping aside for a delivery of exactly the ' +
        'thing the gate exists to hold back.',
    );
  }

  const purposeDeclared = await requestChain(new URL('/play', origin), {
    headers: { ...documentHeaders(), purpose: 'prefetch' },
    cookie: `${AGE_GATE_COOKIE_NAMES[1]}=${AUDIT_MINIMUM_AGE}`,
  });
  const purposeTerminal = purposeDeclared.at(-1);
  judge(
    purposeTerminal.status === 200 && purposeTerminal.hasCsp,
    'open',
    'http',
    'and a declared reader still gets that page, now with a policy on it',
    '200, Content-Security-Policy present',
    `expected 200 with a CSP, got ${purposeTerminal.status} and ` +
      `${purposeTerminal.hasCsp ? 'a policy' : 'NO policy'}. Narrowing the matcher was supposed to ` +
      'bring this response inside the proxy, not to break it.',
  );
}

/** Property 5: the same server, one scope wider. */
async function checkSiteScopeOverHttp(origin) {
  section('5. PRL_AGE_GATE_SCOPE=site gates the whole site, not just /play');

  for (const path of ['/', '/learn', '/lab']) {
    const response = await request(new URL(path, origin), { headers: documentHeaders() });
    judge(
      isChallenge(response.status, response.location, path),
      'gated',
      'http',
      `GET ${path} is gated under scope=site`,
      `303 -> ${response.location}`,
      `expected 303 -> ${CHALLENGE_FOR(path)}, got ${response.status} -> ` +
        `${response.location ?? '(no Location)'}. Under the wider scope this is behind the question, ` +
        'and the same path answered 200 on the play-scope server above — so the scope is what changed.',
    );
  }

  // A reader must be able to read the privacy terms before declaring anything.
  for (const path of [AGE_GATE_PATH, '/terms', '/privacy', '/responsible-use']) {
    const response = await request(new URL(path, origin), { headers: documentHeaders() });
    judge(
      response.status === 200,
      'open',
      'http',
      `GET ${path} stays open even under scope=site`,
      '200',
      `expected 200, got ${response.status} -> ${response.location ?? '(no Location)'}. A privacy ` +
        'policy that can only be read by people who have already answered a question about ' +
        'themselves is not a privacy policy — and gating the gate is an infinite redirect.',
    );
  }

  const declared = await request(new URL('/learn', origin), {
    headers: documentHeaders(),
    cookie: `${AGE_GATE_COOKIE_NAMES[1]}=${AUDIT_MINIMUM_AGE}`,
  });
  judge(
    declared.status === 200,
    'open',
    'http',
    'a declared reader reaches /learn under scope=site',
    '200',
    `expected 200, got ${declared.status}. The wider scope must still be a gate rather than a wall.`,
  );
}

/**
 * The scroll is `instant` because reset.css sets `scroll-behavior: smooth`, and a rect read mid-scroll
 * made the press miss the declaration button.
 */
const LINK_BOX = (selector) => `(() => {
  const link = document.querySelector(${JSON.stringify(selector)});
  if (link === null) return null;
  link.scrollIntoView({ block: 'center', behavior: 'instant' });
  const box = link.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, href: link.getAttribute('href') };
})()`;

/** Found by class so the check fails loudly if the header stops carrying the link. */
const PLAY_CTA = 'a.prl-pillbar__cta';

const DECLARE_BUTTON = 'form.prl-gate__form button[type=submit]';

async function checkInBrowser(page, origin) {
  const requests = [];
  page.on('Network.requestWillBeSent', (params) => {
    requests.push({
      url: params.request.url,
      type: params.type,
      headers: params.request.headers,
      redirect: params.redirectResponse === undefined ? null : params.redirectResponse.status,
    });
  });

  const here = () => page.evaluate('location.href');
  const path = async () => {
    const url = new URL(await here());
    return url.pathname + url.search;
  };
  const pathname = async () => new URL(await here()).pathname;
  const goto = async (url) => {
    await page.send('Page.navigate', { url: new URL(url, origin).toString() });
    await delay(NAVIGATION_SETTLE_MS);
  };
  const cookies = async () => (await page.send('Network.getCookies', { urls: [origin] })).cookies;

  section('1 (browser). A real navigation to /play, with an empty cookie jar');

  await page.send('Network.clearBrowserCookies');
  await goto('/play');
  const landedPath = await path();
  const sawTheForm = await page.evaluate(
    `document.querySelector(${JSON.stringify(DECLARE_BUTTON)}) !== null`,
  );
  judge(
    landedOnAgeGate('/play', await pathname()) && sawTheForm,
    'gated',
    'browser',
    'Chrome asked for /play and was shown the interstitial',
    landedPath,
    `the browser ended up at ${landedPath}${sawTheForm ? '' : ' with no declaration form on it'}. A ` +
      'redirect the browser did not follow, or an interstitial that did not render, is a gate a ' +
      'reader never sees.',
  );

  section('2 (browser). Pressing the real control, and the cookie the browser keeps');

  const button = await page.evaluate(LINK_BOX(DECLARE_BUTTON));
  if (button === null) {
    bad(
      'open',
      'browser',
      'the declaration can be made by pressing the control',
      'the submit control is not in the document, so the declaration was never made and this case ' +
        'was not tested. A case that could not run is a failure.',
    );
    return;
  }
  await page.click(button.x, button.y);
  await delay(NAVIGATION_SETTLE_MS);

  const afterDeclaring = await path();
  const heading = await page.evaluate('document.querySelector("h1")?.textContent ?? ""');
  judge(
    afterDeclaring === '/play' && heading.length > 0,
    'open',
    'browser',
    'declaring put the reader on the route they asked for',
    `${afterDeclaring} — h1 "${heading}"`,
    `expected /play, got ${afterDeclaring}. The declaration was made and the reader was not let ` +
      'through, which is the loop the cookie shape checks above exist to prevent.',
  );

  const jar = await cookies();
  const kept = jar.find((entry) => AGE_GATE_COOKIE_NAMES.includes(entry.name));
  judge(
    kept !== undefined && kept.value === String(AUDIT_MINIMUM_AGE) && kept.httpOnly === true,
    'open',
    'browser',
    'the browser accepted and stored the declaration cookie',
    kept === undefined ? '' : `${kept.name}=${kept.value}, HttpOnly=${kept.httpOnly}`,
    `the jar holds ${JSON.stringify(jar.map((c) => c.name))}. This is the check the follow-up asked ` +
      'for by name: a Set-Cookie that a real browser refuses to keep is a gate that never ends.',
  );

  section('3 (browser). An in-app click, which makes no document request at all');

  // Positive control first. The same click must work while the declaration stands.
  await goto('/learn');
  const cta = await page.evaluate(LINK_BOX(PLAY_CTA));
  if (cta === null) {
    bad(
      'gated',
      'browser',
      'the site header carries an in-app link to /play',
      `no ${PLAY_CTA} on /learn, so there was no in-app navigation to gate and the case was not ` +
        'tested. A case that could not run is a failure.',
    );
    return;
  }
  requests.length = 0;
  await page.click(cta.x, cta.y);
  await delay(NAVIGATION_SETTLE_MS);
  const declaredClickLanded = await path();
  const declaredClickWasSoft = requests.some((r) => r.url.includes('/play') && r.type === 'Fetch');
  judge(
    declaredClickLanded === '/play' && declaredClickWasSoft,
    'open',
    'browser',
    'a declared reader clicking Play in the header reaches the tables',
    `${declaredClickLanded}, by ${declaredClickWasSoft ? 'a router fetch' : 'a document load'}`,
    `landed on ${declaredClickLanded} by ${declaredClickWasSoft ? 'a router fetch' : 'a document load'}. ` +
      'If a declared reader cannot click through, the gate is refusing people it has already ' +
      'admitted — and the refusal below would prove nothing.',
  );

  // The jar is read back, not assumed empty.
  await page.send('Network.clearBrowserCookies');
  const emptied = await cookies();
  judge(
    emptied.length === 0,
    'open',
    'browser',
    'the cookie jar really is empty before the gated click',
    'no cookies for this origin',
    `the jar still holds ${JSON.stringify(emptied.map((c) => c.name))}. A reader who is still declared ` +
      'is a reader the gate is right to let through, and the check below would be vacuous.',
  );

  await goto('/learn');
  const gatedCta = await page.evaluate(LINK_BOX(PLAY_CTA));
  requests.length = 0;
  // Hover first, so the router has every chance to prefetch before the click.
  await page.hover(gatedCta.x, gatedCta.y);
  await delay(PREFETCH_SETTLE_MS);
  const prefetches = requests.filter(
    (r) =>
      r.url.includes('/play') && (r.headers['Next-Router-Prefetch'] ?? r.headers['next-router-prefetch']),
  );
  note(
    'prefetches observed for /play while the link was hovered',
    prefetches.length === 0
      ? 'none — the root layout awaits headers(), so every route is dynamic and Next prefetches no ' +
          'payload for one without a loading boundary. Recorded rather than asserted: this is a ' +
          'fact about Next, and the property that matters is the click below.'
      : `${prefetches.length}, none of which may be a redirect`,
  );
  for (const prefetch of prefetches) {
    judge(
      prefetch.redirect === null,
      'open',
      'browser',
      'the prefetch was not answered with a redirect',
      '',
      `a prefetch for ${prefetch.url} was answered ${prefetch.redirect}. That redirect is now in the ` +
        "router's cache for a page the reader never asked for.",
    );
  }

  // Only traffic before the browser reaches the interstitial carried the click. The interstitial's
  // own header links to /play too.
  const beforeClick = requests.length;
  await page.click(gatedCta.x, gatedCta.y);
  await delay(NAVIGATION_SETTLE_MS);

  const gatedClickLanded = await path();
  const sinceClick = requests.slice(beforeClick);
  const arrival = sinceClick.findIndex((r) => new URL(r.url).pathname.startsWith(AGE_GATE_PATH));
  const carriedTheClick = arrival < 0 ? sinceClick : sinceClick.slice(0, arrival + 1);
  const playRequests = carriedTheClick.filter((r) => new URL(r.url).pathname === '/play');
  const wasSoftNavigation = playRequests[0]?.type === 'Fetch';
  const wasHardNavigation = playRequests.some((r) => r.type === 'Document');
  const showsTheForm = await page.evaluate(
    `document.querySelector(${JSON.stringify(DECLARE_BUTTON)}) !== null`,
  );

  judge(
    landedOnAgeGate('/play', await pathname()) && showsTheForm,
    'gated',
    'browser',
    'an undeclared reader clicking Play in the header is shown the interstitial',
    gatedClickLanded,
    `the browser ended up at ${gatedClickLanded}${showsTheForm ? '' : ' with no declaration form'}. ` +
      'This is the exact case the legal register predicted would be wrong, and it was: the gate ' +
      'read the `rsc` header, which Next deletes before middleware sees it.',
  );
  judge(
    wasSoftNavigation && !wasHardNavigation,
    'gated',
    'browser',
    'and it was a router navigation, not a page load falling back to one',
    `${playRequests.length} request(s) for /play before the interstitial arrived, the first a Fetch`,
    `the requests that carried the click were ${JSON.stringify(
      carriedTheClick.map((r) => `${r.type} ${new URL(r.url).pathname}`),
    )}. A router navigation that fails falls back to a hard navigation, which the document path ` +
      'gates — the gate would hold and this property would still be unproven. The claim is about ' +
      'the in-app path specifically.',
  );

  section('4 (browser). Having been to /play before does not carry a reader past the gate');

  // The session already loaded /play declared. Nothing on the refused page may come from that cache.
  const servedFromCache = await page.evaluate(
    'document.body.textContent.includes("Six-handed table") || document.querySelector("[data-prl-table]") !== null',
  );
  judge(
    !servedFromCache,
    'gated',
    'browser',
    'no part of the table was rendered from a cache the earlier visit left behind',
    'the page shows the interstitial and nothing of /play',
    'the table appeared on a page the gate had refused. A prefetched or cached dynamic payload is ' +
      'being reused across the declaration, which would let any reader who had once declared — or ' +
      'once been prefetched — past the gate for as long as the cache lived.',
  );
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`age-gate-audit — ${err.message}`));
    process.exit(1);
  }

  if (options.help) {
    console.log(HELP);
    process.exit(0);
  }

  const playOrigin = `http://127.0.0.1:${options.port}`;
  const siteOrigin = `http://127.0.0.1:${options.sitePort}`;

  console.log(bold('\nPoker Risk Lab age gate audit'));
  console.log(yellow('  The gate is switched ON in two configurations and then asked the questions a'));
  console.log(yellow('  reader asks: a page, a link, a prefetch, a declaration. Every refusal has a'));
  console.log(yellow('  request beside it that must succeed, so a dead server cannot report a pass.'));

  const servers = [];
  let browser = null;
  let build = null;

  try {
    build = buildId();
    note('build under test', `apps/web/.next/BUILD_ID ${build}`);
    await refuseOccupiedPort(`http://127.0.0.1:${options.port}`, OCCUPIED_PORT_ADVICE);
    await refuseOccupiedPort(`http://127.0.0.1:${options.sitePort}`, OCCUPIED_PORT_ADVICE);

    for (const [label, port, scope, origin] of [
      ['web (scope=play)', options.port, 'play', playOrigin],
      ['web (scope=site)', options.sitePort, 'site', siteOrigin],
    ]) {
      const server = new ManagedServer(
        label,
        ['--filter', '@prl/web', 'start'],
        origin,
        serverEnv(port, scope),
      );
      servers.push(server);
      console.log(dim(`  starting ${label} on ${port}...`));
      server.start();
      await server.waitUntilReady(options.readyTimeoutSeconds);
    }

    await checkPlayScopeOverHttp(playOrigin);
    await checkSiteScopeOverHttp(siteOrigin);

    await withPage(options.headful, async (page, browserVersion) => {
      browser = browserVersion;
      await checkInBrowser(page, playOrigin);
    });
  } catch (error) {
    bad('run', 'run', 'the audit ran to completion', error instanceof Error ? error.message : String(error));
  } finally {
    for (const server of servers) server.stop();
  }

  const verdict = buildVerdict(record);

  if (options.out !== null) {
    const outPath = resolve(REPO_ROOT, options.out);
    writeFileSync(
      outPath,
      `${JSON.stringify(
        {
          tool: 'age-gate-audit.mjs — the age gate against a running production build, and in real Chrome',
          kind: 'age-gate-enforcement',
          coverageWarning:
            'Proves that a gate SWITCHED ON refuses and admits the requests below, in this browser, ' +
            'on this build. It says nothing about the shipped configuration (which has no gate), ' +
            'nothing about whether any threshold is lawful or needed, and nothing about ' +
            'verification — the gate is a self-declaration and says so on its own page.',
          browser,
          buildId: build,
          minimumAge: AUDIT_MINIMUM_AGE,
          origins: { play: playOrigin, site: siteOrigin },
          generatedAt: new Date().toISOString(),
          record,
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
  console.log(dim(`  refusals proved      ${verdict.gatedChecks}`));
  console.log(dim(`  open routes proved   ${verdict.openChecks}`));
  console.log(dim(`  checks in a browser  ${verdict.browserChecks}`));
  if (verdict.failed > 0) {
    console.log(bold('\n  failures'));
    for (const entry of record.filter((item) => item.level === 'fail')) {
      console.log(red(`    - ${entry.label} — ${entry.detail}`));
    }
  }

  if (verdict.passed) {
    console.log(
      green(bold('\nPASS — the gate refused every ungated navigation, and admitted every other one.')),
    );
  } else {
    console.log(red(bold('\nFAIL')));
    for (const reason of verdict.reasons) console.log(red(`  ${reason}`));
  }

  console.log(
    dim(
      '\n  Caveat: this is one browser, one build, one pair of configurations, over plain HTTP. It\n' +
        '  proves that a gate somebody switched ON does what the code says it does — including on\n' +
        '  an in-app click, which is where it was broken. It proves nothing about the shipped\n' +
        '  configuration, which has no gate and is a decision for a lawyer rather than for this\n' +
        '  repository; nothing about whether a threshold is correct; and nothing about the reader,\n' +
        '  because a self-declaration is a statement and this measures only that it is asked for,\n' +
        '  recorded and honoured.\n',
    ),
  );

  process.exit(verdict.exitCode);
}

if (import.meta.main) await main();
