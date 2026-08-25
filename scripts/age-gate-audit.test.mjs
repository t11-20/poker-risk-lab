#!/usr/bin/env node
/**
 * The pure half of `scripts/age-gate-audit.mjs`, held to its own standard.
 *
 * The interesting half of that script cannot be unit-tested — its entire premise is that the gate's
 * pure decisions are already covered and what was missing was a running server and a browser — so
 * what is checked here is the machinery that turns a real answer into a verdict: the argument
 * parser, the request shapes, the `Set-Cookie` parser, the challenge test, the landing test and the
 * verdict builder.
 *
 * Two of these are worth naming, because they are where a harness lies to itself.
 *
 * **The request shapes.** The whole feature turns on three requests that differ by one header, and
 * a harness whose "router navigation" was accidentally identical to its "prefetch" would report
 * that the gate handles both correctly while having made one request twice. So the shapes are
 * asserted to DIFFER, in the specific ways the proxy reads, rather than merely to exist. The case
 * that matters most is `withRsc: false` — the shape the proxy is actually handed, once Next has
 * stripped its own headers, and the shape under which this gate was broken.
 *
 * **The verdict builder.** It is the thing that decides whether a run counts, and its whole job is
 * refusing runs that proved nothing. It is shown a record with no refusals, a record with no
 * allowances, and a record with no browser evidence, and it must refuse all three — a verdict
 * builder that only passes clean records is a verdict builder nobody has tested.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGE_GATE_COOKIE_NAMES,
  AGE_GATE_MAX_AGE_SECONDS,
  AGE_GATE_PATH,
} from '../apps/web/src/lib/age-gate.ts';
import {
  AUDIT_MINIMUM_AGE,
  buildVerdict,
  documentHeaders,
  isChallenge,
  landedOnAgeGate,
  parseArgs,
  parseDeclarationCookie,
  prefetchHeaders,
  routerNavigationHeaders,
  STALE_DECLARATION,
} from './age-gate-audit.mjs';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

test('parseArgs defaults to two ports that nothing else in this repository listens on', () => {
  const options = parseArgs([]);
  // 3000/3001 the app and API, 3456 test:ax, 3457 test:csp, 8443/9090/9093/9099 the staging and
  // observability stacks. A collision here does not fail — it silently audits somebody else's
  // server — which is why the run refuses an occupied port outright.
  assert.equal(options.port, 3458);
  assert.equal(options.sitePort, 3459);
  assert.notEqual(options.port, options.sitePort);
  assert.equal(options.headful, false);
  assert.equal(options.out, null);
});

test('parseArgs accepts the flags the pnpm script and a developer use', () => {
  const options = parseArgs(['--', '--port', '4100', '--site-port', '4101', '--headful', '--out', 'x.json']);
  assert.equal(options.port, 4100);
  assert.equal(options.sitePort, 4101);
  assert.equal(options.headful, true);
  assert.equal(options.out, 'x.json');
  // `--json` is the same option, because test:ax spells it that way and a reader of either should
  // not have to find out which one this is.
  assert.equal(parseArgs(['--json', 'y.json']).out, 'y.json');
});

test('parseArgs refuses the two scopes sharing one port', () => {
  // They are two servers because the scope is read from the process environment per request, so
  // one port cannot hold both configurations. Left unchecked, the second `next start` would fail
  // to bind and the run would report a server that "was not ready" rather than a bad option.
  assert.throws(() => parseArgs(['--port', '4100', '--site-port', '4100']), /must differ/u);
});

test('parseArgs refuses a port that is not a port, and an unknown option', () => {
  assert.throws(() => parseArgs(['--port', 'eighty']), /whole number/u);
  assert.throws(() => parseArgs(['--port', '80']), /between 1024 and 65535/u);
  assert.throws(() => parseArgs(['--ready-timeout', '0']), /positive whole number/u);
  assert.throws(() => parseArgs(['--base-url', 'http://x']), /unknown option/u);
  assert.throws(() => parseArgs(['--port']), /needs a value/u);
});

// ---------------------------------------------------------------------------
// The request shapes — the centre of this file
// ---------------------------------------------------------------------------

test('a document navigation says it is a document', () => {
  const headers = documentHeaders();
  assert.equal(headers['sec-fetch-dest'], 'document');
  assert.equal(headers['sec-fetch-mode'], 'navigate');
  assert.ok(headers.accept.startsWith('text/html'));
  assert.equal(headers.rsc, undefined);
  assert.equal(headers['next-router-prefetch'], undefined);
});

test('a router navigation is a fetch, and is checked both with and without the header Next strips', () => {
  const asChromeSendsIt = routerNavigationHeaders();
  assert.equal(asChromeSendsIt['sec-fetch-dest'], 'empty');
  assert.equal(asChromeSendsIt.rsc, '1');
  assert.equal(asChromeSendsIt['next-router-prefetch'], undefined);

  // The shape the proxy is actually handed. Next deletes `rsc` — one of its `FLIGHT_HEADERS` —
  // before middleware runs, and the gate's original test looked for exactly that header, so it
  // never fired on a real in-app click. This is the case that must gate.
  const asTheProxySeesIt = routerNavigationHeaders({ withRsc: false });
  assert.equal(asTheProxySeesIt.rsc, undefined);
  assert.equal(asTheProxySeesIt['sec-fetch-dest'], 'empty');
});

test('a prefetch differs from a router navigation by exactly one header, under either spelling', () => {
  const navigation = routerNavigationHeaders();
  for (const spelling of ['next-router-prefetch', 'purpose']) {
    const prefetch = prefetchHeaders({ spelling });
    const added = Object.keys(prefetch).filter((key) => !(key in navigation));
    // If these two ever became the same request, the harness would report that the gate handles a
    // navigation and a prefetch correctly while having made one of them twice.
    assert.deepEqual(added, [spelling === 'purpose' ? 'purpose' : 'next-router-prefetch']);
    for (const key of Object.keys(navigation)) assert.equal(prefetch[key], navigation[key]);
  }
});

test('the threshold this harness configures is not the one the code would default to', () => {
  // If it were, a server that ignored its environment entirely would pass every check in the run.
  assert.equal(AUDIT_MINIMUM_AGE, 21);
  assert.notEqual(AUDIT_MINIMUM_AGE, 18);
  // And the stale-declaration control has to be genuinely below it, or it proves nothing about the
  // gate reading the cookie's value rather than noticing the cookie exists.
  assert.ok(STALE_DECLARATION < AUDIT_MINIMUM_AGE);
});

// ---------------------------------------------------------------------------
// Reading the answers
// ---------------------------------------------------------------------------

test('parseDeclarationCookie finds the gate cookie and splits its attributes', () => {
  // Captured verbatim from a real run: `next start` of this app, gate on, threshold 21, plain HTTP.
  const real = `${AGE_GATE_COOKIE_NAMES[1]}=21; Path=/; Max-Age=${AGE_GATE_MAX_AGE_SECONDS}; SameSite=Lax; HttpOnly`;
  const parsed = parseDeclarationCookie(['prl_session=abc; Path=/; HttpOnly', real]);
  assert.equal(parsed.name, AGE_GATE_COOKIE_NAMES[1]);
  assert.equal(parsed.value, '21');
  assert.equal(parsed.attributes.path, '/');
  assert.equal(parsed.attributes.samesite, 'Lax');
  // A valueless attribute maps to `true`, so presence is asserted the same way a value is.
  assert.equal(parsed.attributes.httponly, true);
  assert.equal(parsed.attributes.secure, undefined);
  assert.equal(parsed.attributes['max-age'], String(AGE_GATE_MAX_AGE_SECONDS));
});

test('parseDeclarationCookie reports absence rather than inventing a cookie', () => {
  // The failure this prevents: a run where the declaration set no cookie at all, reported as a
  // cookie with the wrong shape rather than as no cookie.
  assert.equal(parseDeclarationCookie([]), null);
  assert.equal(parseDeclarationCookie(['prl_session=abc; Path=/']), null);
  assert.equal(parseDeclarationCookie(['=nameless; Path=/']), null);
  // A near-miss name. The gate reads two names and neither of them is this one.
  assert.equal(parseDeclarationCookie(['prl_age_checked=21; Path=/']), null);
});

test('parseDeclarationCookie accepts the prefixed name a TLS deployment would send', () => {
  const parsed = parseDeclarationCookie([`${AGE_GATE_COOKIE_NAMES[0]}=21; Path=/; Secure; HttpOnly`]);
  assert.equal(parsed.name, AGE_GATE_COOKIE_NAMES[0]);
  assert.equal(parsed.attributes.secure, true);
});

test('isChallenge asserts the status as well as the destination', () => {
  const location = `${AGE_GATE_PATH}?next=%2Fplay`;
  assert.equal(isChallenge(303, location, '/play'), true);
  // 302 is not the same answer. The gate chooses 303 because it is "fetch this with GET" and is not
  // cacheable by default — a cached redirect for /play would outlive the declaration ending it.
  assert.equal(isChallenge(302, location, '/play'), false);
  assert.equal(isChallenge(307, location, '/play'), false);
  assert.equal(isChallenge(200, null, '/play'), false);
  assert.equal(isChallenge(303, null, '/play'), false);
  // The right status to the wrong place, and the right place for the wrong route. Both are a gate
  // that would strand the reader somewhere they did not ask to be.
  assert.equal(isChallenge(303, '/', '/play'), false);
  assert.equal(isChallenge(303, `${AGE_GATE_PATH}?next=%2Flearn`, '/play'), false);
});

test('landedOnAgeGate is a segment test, not a substring one', () => {
  assert.equal(landedOnAgeGate('/play', AGE_GATE_PATH), true);
  assert.equal(landedOnAgeGate('/play', `${AGE_GATE_PATH}/anything`), true);
  assert.equal(landedOnAgeGate('/play', '/play'), false);
  // `/age-checkers` is not the gate, and a substring test here would report a page the gate never
  // served as proof that it did.
  assert.equal(landedOnAgeGate('/play', '/age-checkers'), false);
  // Asking for the interstitial and getting it is not a gating event.
  assert.equal(landedOnAgeGate(AGE_GATE_PATH, AGE_GATE_PATH), false);
});

// ---------------------------------------------------------------------------
// The verdict — the negative control on the harness itself
// ---------------------------------------------------------------------------

const pass = (kind, layer) => ({ level: 'pass', kind, layer, label: `${kind}/${layer}`, detail: '' });

test('buildVerdict passes a run that refused something, allowed something, and used a browser', () => {
  const verdict = buildVerdict([pass('gated', 'http'), pass('open', 'http'), pass('gated', 'browser')]);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.gatedChecks, 2);
  assert.equal(verdict.openChecks, 1);
  assert.equal(verdict.browserChecks, 1);
});

test('buildVerdict refuses a run that never refused anything', () => {
  // The shape of a gate that is switched off: everything answers 200 and nothing fails.
  const verdict = buildVerdict([pass('open', 'http'), pass('open', 'browser')]);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.reasons.join(' '), /nothing was ever refused/u);
});

test('buildVerdict refuses a run that never allowed anything', () => {
  // The shape of a server that is not there, or one refusing every request for an unrelated reason.
  // "0 failures" must never be reachable by never having looked.
  const verdict = buildVerdict([pass('gated', 'http'), pass('gated', 'browser')]);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reasons.join(' '), /a dead server would have passed/u);
});

test('buildVerdict refuses a run that never opened a browser', () => {
  // "The gate has no browser-level test" is the sentence this harness exists to delete. An
  // HTTP-only run has not deleted it, however many checks it passed.
  const verdict = buildVerdict([pass('gated', 'http'), pass('open', 'http')]);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reasons.join(' '), /no check ran in a browser/u);
});

test('buildVerdict fails on any failure, however much else passed', () => {
  const verdict = buildVerdict([
    pass('gated', 'http'),
    pass('open', 'http'),
    pass('gated', 'browser'),
    { level: 'fail', kind: 'gated', layer: 'browser', label: 'the click was gated', detail: 'it was not' },
  ]);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.failed, 1);
  assert.equal(verdict.exitCode, 1);
});

test('a note can never change the outcome', () => {
  // Notes are context about the run — the build id, what the browser prefetched. If one could carry
  // a verdict, the run would have a way of passing without a check.
  const record = [
    pass('gated', 'http'),
    pass('open', 'http'),
    pass('gated', 'browser'),
    { level: 'note', kind: 'context', layer: 'context', label: 'build', detail: 'abc' },
  ];
  assert.equal(buildVerdict(record).passed, true);
  assert.equal(buildVerdict(record).passes, 3);
});
