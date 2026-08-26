#!/usr/bin/env node
/**
 * Proof, against a running production build and in a real browser, that the age gate actually GATES
 * — and that it lets everything else through while it does.
 *
 * This is what `pnpm run test:age-gate` does.
 *
 * ## The gap this closes, and why it was worth a harness of its own
 *
 * `docs/production/legal-review-requirements.md` follow-up 5 named it: "The gate has no
 * browser-level test. The pure decisions are covered by `apps/web/test/age-gate.test.ts`; that a
 * redirect and a `Set-Cookie` actually reach a browser, and that an in-app router navigation is
 * gated as well as a document navigation, needs a running server and is not covered anywhere yet."
 *
 * That is a worse gap than an ordinary coverage hole, for three reasons that compound:
 *
 *   - The gate is a LEGAL control, on a product about to take paying students.
 *   - It is OFF by default (`src/lib/age-gate.ts` argues that at length and the argument stands),
 *     so the shipped configuration exercises none of this. Every other gate in this repository runs
 *     against the shipped configuration; this one cannot.
 *   - A gate that silently fails looks exactly like a gate that is off, which is the shipped state.
 *     There is no error, no log line and no failed request — a reader simply arrives at the tables.
 *     A deployer who switched it on gets no signal at all.
 *
 * ## It found the defect it was written to look for, on its first run — and a second one beside it
 *
 * **One.** The proxy's test for an in-app router navigation was `request.headers.get('rsc') !==
 * null`. That is the header the App Router really sends. It is also one of Next's `FLIGHT_HEADERS`,
 * and Next DELETES all of them from the request before middleware runs —
 * `next/dist/server/web/adapter.js`, commented "Headers should only be stripped for middleware". So
 * the branch was dead: with the gate switched on, a reader who clicked "Play" in the site header
 * from any page walked straight past it, every time, and only a hard document navigation was ever
 * gated. The fix is `isRouterNavigation` in `apps/web/src/lib/guest-bootstrap.ts`.
 *
 * **Two.** The proxy `matcher` excluded two prefetch headers, on the stated reasoning that a
 * prefetch is not a document. That is true of `next-router-prefetch`, which Next answers with 264
 * bytes of routing stub. It is false of `purpose: prefetch`, which changes nothing on the server:
 * the same request carrying it is answered with the complete 38KB page, table and all. So a client
 * that set that one header was served the whole of a gated route — with no gate applied and no
 * Content-Security-Policy on it. Narrowing the exclusion to the header Next honours closes both
 * halves; `isRouterPrefetch` is where the distinction lives.
 *
 * Nothing in the repository could have caught either. The decision functions are correct and their
 * unit tests build headers by hand, so they cannot reproduce a deletion that happens upstream of
 * the function under test, nor a matcher that decides the function is not called at all. This is
 * the shape of defect only a running server shows you, and the first of them is the exact half the
 * follow-up predicted would be wrong.
 *
 * Neither was a way past a control that could not be walked past anyway — the gate is a
 * self-declaration and the button that satisfies it is right there on the page. What was wrong is
 * narrower and still worth the fix: the code claimed there was no path through the proxy that
 * renders a gated page, and there were two.
 *
 * ## What this proves
 *
 * Five properties, each of them a request made and an answer read:
 *
 *   1. A DOCUMENT navigation to a gated route with no declaration is redirected to the interstitial
 *      — real status, real `Location` — and the interstitial really renders.
 *   2. The declaration writes a cookie that WORKS: the same navigation afterwards reaches the page,
 *      over HTTP by replaying the cookie the server set, and in Chrome by pressing the real button
 *      and letting the browser keep the cookie itself.
 *   3. An IN-APP ROUTER navigation is gated too. Measured twice: as the request shape Chrome sends,
 *      and by clicking the real `<Link>` in real Chrome and asserting where the browser ended up.
 *   4. A ROUTER PREFETCH is NOT gated, and prefetching or previously visiting a gated route does
 *      not let a later navigation past the gate. The wider `purpose: prefetch` spelling IS gated,
 *      because Next answers it with the page rather than with a stub — see defect two below.
 *   5. `PRL_AGE_GATE_SCOPE=site` gates the whole site, and still leaves the legal pages open.
 *
 * ## What it deliberately does NOT prove
 *
 *   - Nothing about the shipped configuration, which has no gate. Every server this script starts
 *     has `PRL_AGE_GATE=on` in its environment, because a gate that is off cannot be measured.
 *   - Nothing about whether a threshold is CORRECT, or lawful, or needed. That is the question the
 *     legal register exists to hold open and this file has no opinion on it.
 *   - Nothing about verification. The gate is a self-declaration and says so on its own page; what
 *     is measured here is that the declaration is asked for, recorded and honoured — not that it is
 *     true. A reader who lies passes, by design.
 *   - Nothing about any browser other than the Chrome it found. Safari and Firefox send
 *     `Sec-Fetch-Dest` too and the gate now turns on it, but that is an argument, not a run.
 *   - Nothing about the `__Host-` cookie name. That requires TLS and these servers are plain HTTP,
 *     so what is asserted here is the OTHER half: that over plain HTTP the cookie is NOT `__Host-`
 *     and NOT `Secure`, which is the case that would otherwise be a silent redirect loop.
 *   - Nothing about a deployment behind a proxy. `isSecureRequest` trusts `x-forwarded-proto` and
 *     that path is not exercised.
 *
 * ## What would make this silently pass, and what is done about each
 *
 * This is a negative-control harness — most of its checks assert that something was REFUSED — and
 * the standing failure mode of those is that nothing was refused because nothing happened at all.
 *
 *   - **The server never came up.** Every gated check is paired with an OPEN check: a request that
 *     must succeed, usually the same URL differing by one cookie or one header. `buildVerdict`
 *     refuses to pass a run with no passing check of either kind.
 *   - **The gate was never switched on.** Then the open checks pass and the gated ones fail. The
 *     configuration is also asserted directly: the threshold is set to 21 rather than left at the
 *     default 18, so a server that ignored its environment would accept the wrong declaration value
 *     and fail. A configuration that did not arrive cannot look like a configuration that did.
 *   - **It audited a server somebody else started, in an unknown configuration.** The ports are
 *     probed before anything is started and an answer on one is a failure, not a reuse. There is
 *     deliberately no `--base-url`-only mode for the same reason: this harness must own the
 *     environment of the thing it measures.
 *   - **It audited a stale build.** `next build` is required before this runs — `.next/BUILD_ID` is
 *     checked and its value is printed and recorded, so a report can be tied to a build.
 *   - **The browser click was really a full page load.** A router navigation that fails falls back
 *     to a hard navigation, which is gated by the document path — the gate would hold and property
 *     3 would still be unproven. So the network is watched: the request that carried the click must
 *     have been a `Fetch`, and no `Document` request for the gated route may have been made.
 *   - **The browser was already past the gate.** Each browser phase runs in a fresh profile
 *     directory and clears the cookie jar before the phase that needs it clear, and the jar is read
 *     back and asserted on rather than assumed.
 *
 * ## Usage
 *
 *     node scripts/age-gate-audit.mjs [--port 3458] [--site-port 3459] [--headful] [--out <file>]
 *
 * Requires a production build (`pnpm --filter @prl/web build`). `next dev` is a different runtime
 * with a different proxy compilation path and a pass against it would not be evidence about what
 * ships. The two servers are started by this script, one per scope, and stopped by it.
 *
 * ## Exit codes
 *
 *   0  every check passed, or `--help`
 *   1  any check failed, or any check could not be run
 *
 * There is no warning-with-exit-0 anywhere in this file. A legal control that skips itself when
 * Chrome is missing is worse than no control, because the gate goes green either way. The yellow
 * lines are context about the run and can never change the outcome.
 *
 * The pure parts — the argument parser, the request shapes, the cookie parser, the landing test and
 * the verdict builder — are exported and covered by `scripts/age-gate-audit.test.mjs`, so the run
 * block is guarded by `import.meta.main`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// The gate's own constants rather than copies of them, for the reason `age-gate.ts` states in its
// header and every other harness here repeats: a script that seeds or asserts on a name the proxy
// does not read sails past the whole feature and reports a clean run. That module imports nothing
// precisely so things outside the Next runtime can read it.
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_DECLARE_PARAM,
  AGE_GATE_MAX_AGE_SECONDS,
  AGE_GATE_PATH,
  AGE_GATE_RETURN_PARAM,
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
 * The threshold these servers are configured with, and it is deliberately NOT the default.
 *
 * `AGE_GATE_DEFAULT_MINIMUM` is 18. If this harness used 18 it could not tell "the deployment read
 * my configuration" from "the deployment ignored my configuration and fell back to its default",
 * and every check below would pass either way. 21 is inside the 13–25 band the module clamps to,
 * so it survives the read intact, and it makes the declaration value, the cookie value and the
 * words on the interstitial all three of them things that could only have come from the
 * environment this script set.
 */
export const AUDIT_MINIMUM_AGE = 21;

/**
 * A declaration against a LOWER threshold, used as a negative control on the cookie's value.
 *
 * The cookie records the threshold it was given, not a boolean, so a deployment that raises its
 * threshold re-asks everyone. This is that property at the wiring level: a cookie saying 18, sent
 * to a server asking for 21, must not open the tables. It is the difference between the gate
 * reading the cookie and the gate merely noticing that a cookie exists.
 */
export const STALE_DECLARATION = 18;

/** Chrome, wherever this platform keeps it. The same candidate list as the sibling audits. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter((path) => typeof path === 'string' && path !== '');

/**
 * How long to wait after a navigation or a click before reading where the browser ended up.
 *
 * Generous, because an impatient positive control is a false failure that sends somebody looking
 * for a gate defect that is really a slow machine. A router navigation on this app completes in
 * well under 300ms locally.
 */
const NAVIGATION_SETTLE_MS = 2_500;

/** The beat after a hover, so anything the router wanted to prefetch has had its chance to leave. */
const PREFETCH_SETTLE_MS = 1_500;

/** Where a document navigation is sent when it is refused, as this harness expects to see it. */
const CHALLENGE_FOR = (path) =>
  `${AGE_GATE_PATH}?${new URLSearchParams({ [AGE_GATE_RETURN_PARAM]: path }).toString()}`;

// ===========================================================================
// Options
// ===========================================================================

/**
 * Two ports, kept clear of everything else that listens in this repository.
 *
 * 3000/3001 are the app and the API, 3456 is `test:ax`, 3457 is `test:csp`, and the staging and
 * observability stacks hold 8443/9090/9093/9099. Two are needed rather than one because the scope
 * is read from the process environment on every request: proving that `site` gates more than `play`
 * means two differently configured servers, and running them side by side rather than in sequence
 * keeps the browser phase from having to be repeated.
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
    // `pnpm run test:age-gate -- --headful` passes the `--` through rather than swallowing it, so
    // both spellings work instead of one of them dying on "unknown option --".
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

// ===========================================================================
// The request shapes
//
// The whole feature turns on these differing by one header, so they are written out here as data
// rather than assembled at each call site. `apps/web/src/lib/guest-bootstrap.ts` is the other end
// of this conversation and its comments explain what each header means to the proxy.
// ===========================================================================

/**
 * A top-level document navigation: what the browser sends when a URL is opened or a form submits.
 *
 * `sec-fetch-dest: document` is the signal the proxy reads. It is sent explicitly rather than left
 * absent, even though an absent header is also treated as a document, because a harness that
 * exercised only the absent case would prove nothing about what a browser sends.
 */
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
 * An in-app router navigation: what the App Router sends when a reader clicks a `<Link>`.
 *
 * Captured from a real Chrome 151 against this app rather than imagined. `withRsc` exists because
 * of the defect this harness found: Chrome DOES send `rsc: 1`, and Next deletes it before the
 * proxy can see it, so the shape the browser sends and the shape the proxy is handed are two
 * different things and both have to be checked. A gate that only passed with `rsc` present would
 * be a gate that never fires in production.
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
 * A prefetch: the router filling its cache for a page nobody has opened.
 *
 * Identical to a router navigation but for `next-router-prefetch`, which is the point. This one
 * must NOT be gated — a redirect here would put the interstitial into the router's cache under the
 * gated route's name, and the reader would then be shown it (or not) according to a cache rather
 * than according to the gate. The proxy `matcher` excludes it before the middleware even runs.
 *
 * `purpose: prefetch` is the older, wider spelling, sent by some browsers and intermediaries on
 * their own. Both are checked because the matcher lists both.
 */
export function prefetchHeaders({ from = '/learn', spelling = 'next-router-prefetch' } = {}) {
  const headers = routerNavigationHeaders({ from });
  if (spelling === 'purpose') headers.purpose = 'prefetch';
  else headers['next-router-prefetch'] = '1';
  return headers;
}

// ===========================================================================
// Reading the answers
// ===========================================================================

/**
 * The declaration cookie out of a response's `Set-Cookie` values, parsed into name and attributes.
 *
 * Returns null when there is no age cookie among them, which is a finding rather than an error:
 * the caller decides whether the absence is a failure. Attribute names are lower-cased and
 * valueless attributes (`HttpOnly`, `Secure`) map to `true`, so a caller asserts on presence the
 * same way it asserts on a value.
 */
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

/**
 * True when a response is the gate's challenge for `path`.
 *
 * The status is asserted as well as the location. 303 is the gate's own choice and the reason is
 * in `src/proxy.ts`: it is "fetch this other URL with GET", it is correct for both a form
 * submission and a plain navigation, and it is not cacheable by default — a cached 302 for `/play`
 * would outlive the declaration that was supposed to end it.
 */
export function isChallenge(status, location, path) {
  if (status !== 303) return false;
  if (location === null) return false;
  return location === CHALLENGE_FOR(path);
}

/**
 * True when a navigation ended up on the interstitial instead of where it was sent.
 *
 * Segment matching, never `includes`, for the reason `age-gate.ts` gives at its own `matchesPrefix`:
 * `/age-checkers` is not the gate. Lifted from `scripts/csp-negative-control.mjs`, which needs the
 * same answer for the opposite reason — it has to know when the gate has swallowed the page it was
 * trying to attack.
 */
export function landedOnAgeGate(requestedPath, landedPath) {
  const isGate = (path) => path === AGE_GATE_PATH || path.startsWith(`${AGE_GATE_PATH}/`);
  return isGate(landedPath) && !isGate(requestedPath);
}

/**
 * The verdict, from the recorded checks.
 *
 * Pass requires four things, not one. No failure; at least one GATED check that passed, so a run
 * that never refused anything cannot report that the gate works; at least one OPEN check that
 * passed, so a run against a server that refuses everything — or against no server at all — cannot
 * either; and at least one check from the BROWSER, because "the gate has no browser-level test" is
 * the sentence this whole file exists to delete, and an HTTP-only run has not deleted it.
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

// ===========================================================================
// Reporting
// ===========================================================================

const record = [];

/**
 * `kind` is `gated` for a request that had to be refused and `open` for one that had to succeed;
 * `layer` is `http` or `browser`. `buildVerdict` requires a passing check of each kind and at
 * least one from the browser, which is what stops a run that fell over early from reporting a
 * clean sheet.
 */
const ok = (kind, layer, label, detail = '') => {
  record.push({ level: 'pass', kind, layer, label, detail });
  console.log(`  ${green('✓')} ${label}${detail === '' ? '' : ` ${dim(detail)}`}`);
};
const bad = (kind, layer, label, detail) => {
  record.push({ level: 'fail', kind, layer, label, detail });
  console.log(`  ${red('✗')} ${label}\n${dim(`      ${detail}`)}`);
};
/** Context about the run, never the outcome of a check. Nothing here can change the exit code. */
const note = (label, detail) => {
  record.push({ level: 'note', kind: 'context', layer: 'context', label, detail });
  console.log(`  ${yellow('!')} ${label} ${dim(detail)}`);
};
const section = (title) => console.log(`\n${bold(title)}`);

/** `ok` or `bad` from a boolean, so a check reads as one statement rather than as an if. */
const judge = (held, kind, layer, label, passDetail, failDetail) => {
  if (held) ok(kind, layer, label, passDetail);
  else bad(kind, layer, label, failDetail);
  return held;
};

// ===========================================================================
// HTTP
// ===========================================================================

/**
 * One request, with redirects NOT followed, returned as plain data.
 *
 * `redirect: 'manual'` is the whole point: this harness asserts on the status and the `Location` a
 * gated request is answered with, and a client that quietly followed the redirect would report the
 * interstitial's 200 and prove nothing about how it got there.
 */
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
 * A request and every redirect it is answered with, as a chain.
 *
 * Needed because Next answers an RSC request whose `_rsc` cache-busting parameter it does not like
 * with its OWN 307 before the proxy has said anything, so "was this gated" cannot be read from the
 * first response alone. The chain is returned whole and the caller asserts on what is in it —
 * which also makes "the gate appeared somewhere in here" a thing that can be asserted NEGATIVELY,
 * for the prefetch, where the interesting claim is that the gate never appeared at all.
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

/** True when any hop in a chain was a redirect to the gate's interstitial. */
function chainHitTheGate(chain) {
  return chain.some((hop) => {
    if (hop.location === null) return false;
    const target = new URL(hop.location, hop.url).pathname;
    return landedOnAgeGate(new URL(hop.url).pathname, target);
  });
}

const describeChain = (chain) =>
  chain.map((hop) => `${hop.status}${hop.location === null ? '' : ` -> ${hop.location}`}`).join(' ');

// ===========================================================================
// A very small CDP client
//
// Lifted from `scripts/csp-negative-control.mjs`, which lifted it from `scripts/ax-tree-audit.mjs`,
// on purpose rather than shared through a helper module — for the reason those files state: these
// are release gates, and a gate that depends on a file another gate can change is a gate that can
// be broken from a distance. The additions here are `on`, because this script has to answer
// protocol EVENTS to watch the network, and `click`, because the property that matters most is
// what happens when a reader presses a link.
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

  /**
   * A real mouse press at a point, through Chrome's own input pipeline.
   *
   * Not `element.click()`: that is a synthetic event dispatched from a DevTools evaluation, and
   * while React would honour it, it would leave the harness proving that React's onClick works
   * rather than that a reader pressing a link is gated. The difference has mattered before —
   * `scripts/keyboard-audit.mjs` records the same distinction for keys.
   */
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
  // the keyboard audit (9222+), the AX audit (9800+) and the CSP control (9400+) use.
  const port = 9600 + Math.floor(process.pid % 150);
  /**
   * A profile directory per run, removed afterwards.
   *
   * Not a fixed path, and here the reason is the feature itself: this harness's whole subject is a
   * cookie that lets a reader past a gate. A profile shared with a previous run would carry that
   * cookie in, and the run would report a gate holding for a reader it had already let through.
   */
  const profile = mkdtempSync(join(tmpdir(), 'prl-age-gate-audit-'));
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
    // Enabled to WATCH, not to seed: the cookie this harness cares about is one the browser is
    // supposed to store for itself, and a seeded one would prove nothing about the `Set-Cookie`.
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
// Servers
// ===========================================================================

/**
 * A child server this script owns and must clean up.
 *
 * The same class, for the same reason, as `scripts/a11y-audit.mjs` and its siblings: `pnpm --filter
 * ... start` is a wrapper, so killing the wrapper leaves the real server holding the port, and an
 * orphan makes the next run measure a build nobody meant to measure. Detached, signalled by process
 * group, ESRCH tolerated.
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

/**
 * The environment one of these servers runs with, spelled out in full every time.
 *
 * Every gate variable is set, including the ones being left at their default, because this process
 * inherits the developer's environment and a stray `PRL_AGE_GATE_MINIMUM_AGE` in somebody's `.env`
 * would otherwise silently change what this harness is measuring. An empty string for the
 * jurisdiction is not the same as leaving it unset in `readAgeGateConfig`'s eyes — it cleans to
 * nothing and is ignored — and that is what is wanted: a label from the ambient environment must
 * not leak onto the interstitial this run reads.
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

/**
 * Refuses to continue if anything is already listening on a port this run wants.
 *
 * A harness that quietly reused whatever was on its port would be auditing a server in an unknown
 * configuration and reporting the result under this script's name. That is the failure the a11y
 * audit's `landedOnAgeGate` exists for, one level up: not "the wrong page under the right name" but
 * "the wrong server under the right port".
 */
async function refuseOccupiedPort(port) {
  const free = await new Promise((done) => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });
  if (!free) {
    throw new Error(
      `something is already listening on 127.0.0.1:${port}. This harness starts the servers it ` +
        'measures, so it will not reuse one it did not configure. Stop it, or pass --port/--site-port.',
    );
  }
}

/** The build this run will measure, or a refusal. `next dev` is a different runtime and is not it. */
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

// ===========================================================================
// The checks — over HTTP
// ===========================================================================

/**
 * Properties 1, 2, 3 and 4, against the play-scope server, as bare HTTP.
 *
 * Every gated check here has an open one beside it that differs by exactly one thing — one cookie,
 * or one header — so a failure says which of the two mattered. A run where the server is simply
 * absent fails both halves of every pair, and `buildVerdict` refuses it for having allowed nothing.
 */
async function checkPlayScopeOverHttp(origin) {
  section('The server is up, and the gate is not simply refusing everything');

  // The positive control that everything below leans on. `/terms` is on the gate's always-open
  // list — a reader must be able to read what a deployment claims about them BEFORE being asked to
  // declare anything — so this is both "the server answers" and property 5's first half.
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

  // The query string has to survive, or a reader sent to `/play?state=decision` comes back to a
  // different page than the one they asked for.
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
    // Over plain HTTP the cookie must NOT be `__Host-` and must NOT be `Secure`, and this is not a
    // tidiness point: a browser silently discards a `Secure` cookie delivered over http, so the
    // declaration would never stick and the gate would ask again on every request for ever. It is
    // the one failure mode `age-gate.ts` calls "a redirect loop and not a subtlety".
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
      // Replayed exactly as the server set it, name and all, rather than assembled from constants:
      // the thing under test is that what the server sends back is what opens the door.
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

  // Both shapes, and the difference between them is the defect this harness found. Chrome sends
  // `rsc: 1`; Next strips it before the proxy is handed the request. So the first of these is what
  // the browser sends and the second is what the proxy actually sees, and a gate that only holds
  // for the first is a gate that never fires in production.
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

  // The `_rsc` cache-busting parameter Next appends must not survive into the return path, or the
  // reader is sent back to a URL whose response is an RSC payload rather than a page — a blank
  // screen at the end of an otherwise working gate.
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

  // The router's own prefetch. This one must be left alone: Next answers it with a routing stub and
  // no page content, and a redirect here would put the interstitial into the router's cache under
  // the gated route's name — a reader would then be shown it, or not, according to a cache rather
  // than according to the gate.
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
   * `purpose: prefetch` is the OTHER spelling, and it is not the same thing at all — which is the
   * second defect this harness found.
   *
   * That header changes nothing on the server. Next answers a request carrying it with the whole
   * page: 38KB of document with the table in it, or a full RSC payload, against 264 bytes of stub
   * for the header above. The proxy `matcher` used to exclude both spellings on the stated
   * reasoning that "prefetches are not a document" — so any client that set this one header was
   * served the complete gated page, with no gate applied to it and no Content-Security-Policy on
   * it. Both halves are now closed by narrowing that exclusion to the header Next honours.
   *
   * A self-declaration gate is not a security boundary and nobody needed a header to get past this
   * one — the button is right there. What was wrong is narrower and still worth fixing: the code
   * claimed there was no path through the proxy that renders a gated page, and there was one.
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

  // The always-open list, and it is the half of scope=site that matters most. A reader has to be
  // able to read what a deployment claims about their data BEFORE being asked to declare anything.
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

// ===========================================================================
// The checks — in a browser
// ===========================================================================

/** Where a link is on the page, so it can be pressed rather than followed by script. */
/**
 * The centre of an element, in viewport coordinates, ready for a real mouse press.
 *
 * ## Why the scroll is `instant`
 *
 * `packages/ui/src/styles/reset.css` sets `scroll-behavior: smooth` globally, and
 * `scrollIntoView`'s default `behavior: 'auto'` honours it. So the rect below was being read WHILE
 * the page was still scrolling, and the press landed wherever the control had been mid-flight.
 *
 * That is exactly how this harness came to report a declaration that set no cookie: the button was
 * found, the click was dispatched, and it hit nothing. Every HTTP-level check passed — the
 * `Set-Cookie` was the right shape — because the failure was in the press, not the server.
 *
 * It was latent for as long as the control happened to be in view already, which made
 * `scrollIntoView` a no-op and left no race to lose. A layout change that pushed it below the fold
 * is what surfaced it — which is the worst way for a gate to go wrong: silently, on an edit that
 * had nothing to do with it.
 */
const LINK_BOX = (selector) => `(() => {
  const link = document.querySelector(${JSON.stringify(selector)});
  if (link === null) return null;
  link.scrollIntoView({ block: 'center', behavior: 'instant' });
  const box = link.getBoundingClientRect();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, href: link.getAttribute('href') };
})()`;

/**
 * The in-app link to the gated route: the header's call-to-action, which is on every page.
 *
 * A `next/link`, so pressing it is a router navigation and not a document request — which is the
 * whole point. It is found by class rather than by href so that the check fails loudly if the
 * header stops carrying it, instead of quietly matching some other link to the same place.
 */
const PLAY_CTA = 'a.prl-pillbar__cta';

/** The interstitial's own submit control, so the declaration is made the way a reader makes it. */
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

  // First the positive control, while the declaration still stands: the same click, from the same
  // page, must WORK. Without it, a gate that had broken every in-app link would look identical to
  // a gate that was doing its job.
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

  // Now the same click with no declaration. The jar is cleared and read back rather than assumed:
  // a browser still holding the cookie would sail through and the run would report a pass.
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
  // Hover first, and wait. Anything the router intends to prefetch for this link leaves now, so
  // the click that follows is a click on a link the router has had every chance to warm.
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

  // Everything from here to the moment the browser reaches the interstitial is what carried the
  // click. Traffic AFTER that — the interstitial's own header carries the same link, and the router
  // may go looking at it — is not evidence about how the click travelled, and counting it would
  // fail this check for a reason that has nothing to do with the gate.
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

  // The reader visited /play with a declaration earlier in this very session, so the browser's HTTP
  // cache and the router's client-side cache have both seen that route's payload. The repository's
  // own analysis says the default `staleTimes` means a dynamic payload is never reused; this is the
  // measurement that turns that argument into a fact. The check above already navigated from a
  // page loaded after the cookie was cleared, so this asserts the other half: nothing served here
  // was a cached rendering of the page.
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

// ===========================================================================
// The run
// ===========================================================================

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
    await refuseOccupiedPort(options.port);
    await refuseOccupiedPort(options.sitePort);

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

    await withChrome(options.headful, async (page, browserVersion) => {
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
