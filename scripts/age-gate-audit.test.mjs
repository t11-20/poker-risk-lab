#!/usr/bin/env node
/**
 * The pure half of `scripts/age-gate-audit.mjs`: argument parser, request shapes, cookie parser,
 * challenge and landing tests, and the verdict builder, which must refuse runs that proved nothing.
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

test('parseArgs defaults to two ports that nothing else in this repository listens on', () => {
  const options = parseArgs([]);
  // A port collision would silently audit somebody else's server, so the run refuses it.
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
  assert.equal(parseArgs(['--json', 'y.json']).out, 'y.json');
});

test('parseArgs refuses the two scopes sharing one port', () => {
  // The scope is read from the environment, so one port cannot hold both configurations.
  assert.throws(() => parseArgs(['--port', '4100', '--site-port', '4100']), /must differ/u);
});

test('parseArgs refuses a port that is not a port, and an unknown option', () => {
  assert.throws(() => parseArgs(['--port', 'eighty']), /whole number/u);
  assert.throws(() => parseArgs(['--port', '80']), /between 1024 and 65535/u);
  assert.throws(() => parseArgs(['--ready-timeout', '0']), /positive whole number/u);
  assert.throws(() => parseArgs(['--base-url', 'http://x']), /unknown option/u);
  assert.throws(() => parseArgs(['--port']), /needs a value/u);
});

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

  // Next deletes `rsc` before middleware runs, so a real in-app click reaches the proxy like this.
  const asTheProxySeesIt = routerNavigationHeaders({ withRsc: false });
  assert.equal(asTheProxySeesIt.rsc, undefined);
  assert.equal(asTheProxySeesIt['sec-fetch-dest'], 'empty');
});

test('a prefetch differs from a router navigation by exactly one header, under either spelling', () => {
  const navigation = routerNavigationHeaders();
  for (const spelling of ['next-router-prefetch', 'purpose']) {
    const prefetch = prefetchHeaders({ spelling });
    const added = Object.keys(prefetch).filter((key) => !(key in navigation));
    assert.deepEqual(added, [spelling === 'purpose' ? 'purpose' : 'next-router-prefetch']);
    for (const key of Object.keys(navigation)) assert.equal(prefetch[key], navigation[key]);
  }
});

test('the threshold this harness configures is not the one the code would default to', () => {
  assert.equal(AUDIT_MINIMUM_AGE, 21);
  assert.notEqual(AUDIT_MINIMUM_AGE, 18);
  assert.ok(STALE_DECLARATION < AUDIT_MINIMUM_AGE);
});

test('parseDeclarationCookie finds the gate cookie and splits its attributes', () => {
  // Captured from a real run with the gate on, threshold 21, plain HTTP.
  const real = `${AGE_GATE_COOKIE_NAMES[1]}=21; Path=/; Max-Age=${AGE_GATE_MAX_AGE_SECONDS}; SameSite=Lax; HttpOnly`;
  const parsed = parseDeclarationCookie(['prl_session=abc; Path=/; HttpOnly', real]);
  assert.equal(parsed.name, AGE_GATE_COOKIE_NAMES[1]);
  assert.equal(parsed.value, '21');
  assert.equal(parsed.attributes.path, '/');
  assert.equal(parsed.attributes.samesite, 'Lax');
  assert.equal(parsed.attributes.httponly, true);
  assert.equal(parsed.attributes.secure, undefined);
  assert.equal(parsed.attributes['max-age'], String(AGE_GATE_MAX_AGE_SECONDS));
});

test('parseDeclarationCookie reports absence rather than inventing a cookie', () => {
  assert.equal(parseDeclarationCookie([]), null);
  assert.equal(parseDeclarationCookie(['prl_session=abc; Path=/']), null);
  assert.equal(parseDeclarationCookie(['=nameless; Path=/']), null);
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
  // 303 is not cacheable by default. A cached redirect would outlive the declaration.
  assert.equal(isChallenge(302, location, '/play'), false);
  assert.equal(isChallenge(307, location, '/play'), false);
  assert.equal(isChallenge(200, null, '/play'), false);
  assert.equal(isChallenge(303, null, '/play'), false);
  assert.equal(isChallenge(303, '/', '/play'), false);
  assert.equal(isChallenge(303, `${AGE_GATE_PATH}?next=%2Flearn`, '/play'), false);
});

test('landedOnAgeGate is a segment test, not a substring one', () => {
  assert.equal(landedOnAgeGate('/play', AGE_GATE_PATH), true);
  assert.equal(landedOnAgeGate('/play', `${AGE_GATE_PATH}/anything`), true);
  assert.equal(landedOnAgeGate('/play', '/play'), false);
  assert.equal(landedOnAgeGate('/play', '/age-checkers'), false);
  assert.equal(landedOnAgeGate(AGE_GATE_PATH, AGE_GATE_PATH), false);
});

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
  // A gate switched off: everything answers 200 and nothing fails.
  const verdict = buildVerdict([pass('open', 'http'), pass('open', 'browser')]);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.reasons.join(' '), /nothing was ever refused/u);
});

test('buildVerdict refuses a run that never allowed anything', () => {
  // A server that is not there, or one refusing everything.
  const verdict = buildVerdict([pass('gated', 'http'), pass('gated', 'browser')]);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reasons.join(' '), /a dead server would have passed/u);
});

test('buildVerdict refuses a run that never opened a browser', () => {
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
  const record = [
    pass('gated', 'http'),
    pass('open', 'http'),
    pass('gated', 'browser'),
    { level: 'note', kind: 'context', layer: 'context', label: 'build', detail: 'abc' },
  ];
  assert.equal(buildVerdict(record).passed, true);
  assert.equal(buildVerdict(record).passes, 3);
});
