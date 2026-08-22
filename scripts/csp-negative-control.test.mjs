#!/usr/bin/env node
/**
 * The pure half of `scripts/csp-negative-control.mjs`, held to its own standard.
 *
 * The browser half of that script cannot be unit-tested — the whole point of it is that it needs a
 * real rendering engine — so everything that CAN be decided without one is factored out and checked
 * here: the argument parser, the markup builder, the violation matcher and the verdict builder.
 *
 * The centre of this file is the matcher's NEGATIVE CONTROL. `matchesViolation` is the function that
 * turns "the browser said something" into "the browser refused THIS injection FOR THIS reason", and
 * a matcher that has only ever been shown things it should accept is a matcher nobody has tested.
 * So it is shown real reports captured from a real run — the exact objects Chrome 151 produced
 * against this app's production policy — and it is also shown reports from the wrong case and from
 * an unrelated directive entirely, and it must refuse those. A matcher that accepts the wrong
 * evidence is how five injections that were never made get reported as five injections refused.
 *
 * The other assertion worth naming is the one over `CASES`: every case must have an injection in the
 * markup that carries its flag. Without it, a case could be added to the table, never injected, and
 * pass forever on the silence of a thing that was never done.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ageDeclarationCookies,
  attackMarkup,
  buildVerdict,
  CASES,
  EVENT_HANDLER_ELEMENT_ID,
  injectAttackMarkup,
  landedOnAgeGate,
  matchesViolation,
  parseArgs,
  WRONG_NONCE,
} from './csp-negative-control.mjs';

/** A nonce of the shape `src/proxy.ts` mints: 16 random bytes, base64. */
const REAL_NONCE = 'krFOO6/YxWTzC8Ndhu+cig==';
const REMOTE_URL = 'http://127.0.0.1:62081/injected.js';

/**
 * Violation reports captured verbatim from a real run: Chrome 151.0.7922.170, `next start` of this
 * app, the production policy. Kept as data rather than invented, so the matcher is tested against
 * what a browser actually emits and not against what this file imagines it emits.
 */
const REAL_REPORTS = {
  inline: {
    effectiveDirective: 'script-src-elem',
    violatedDirective: 'script-src-elem',
    blockedURI: 'inline',
    lineNumber: 16,
    sample: '',
  },
  eventHandler: {
    effectiveDirective: 'script-src-attr',
    violatedDirective: 'script-src-attr',
    blockedURI: 'inline',
    lineNumber: 1,
    sample: '',
  },
  evaluation: {
    effectiveDirective: 'script-src',
    violatedDirective: 'script-src',
    blockedURI: 'eval',
    lineNumber: 13,
    sample: '',
  },
  remote: {
    effectiveDirective: 'script-src-elem',
    violatedDirective: 'script-src-elem',
    blockedURI: REMOTE_URL,
    lineNumber: 0,
    sample: '',
  },
};

const caseById = (id) => {
  const found = CASES.find((entry) => entry.id === id);
  assert.ok(found !== undefined, `no case with id ${id}`);
  return found;
};

const expectationFor = (id, blockedUri) => {
  const testCase = caseById(id);
  return { directives: testCase.directives, blockedUri: blockedUri ?? testCase.blockedUri };
};

// ---------------------------------------------------------------------------
// matchesViolation — the negative control
// ---------------------------------------------------------------------------

test('matchesViolation fires on the real report for each case', () => {
  assert.equal(matchesViolation(REAL_REPORTS.inline, expectationFor('inline-no-nonce')), true);
  assert.equal(matchesViolation(REAL_REPORTS.inline, expectationFor('inline-wrong-nonce')), true);
  assert.equal(matchesViolation(REAL_REPORTS.eventHandler, expectationFor('event-handler-attribute')), true);
  assert.equal(matchesViolation(REAL_REPORTS.evaluation, expectationFor('eval')), true);
  assert.equal(matchesViolation(REAL_REPORTS.remote, expectationFor('remote-script', REMOTE_URL)), true);
});

test('matchesViolation does NOT fire on an unrelated violation', () => {
  // The one the manual browser check in docs/audit/blocker-remediation.md used: an image from an
  // origin the policy does not allow. A real violation, a real directive, and nothing whatsoever to
  // do with any injection this control makes.
  const unrelated = {
    effectiveDirective: 'img-src',
    violatedDirective: 'img-src',
    blockedURI: 'https://example.com/x.png',
  };
  for (const testCase of CASES) {
    const expectation = { directives: testCase.directives, blockedUri: testCase.blockedUri ?? REMOTE_URL };
    assert.equal(
      matchesViolation(unrelated, expectation),
      false,
      `${testCase.id} accepted an img-src report`,
    );
  }
});

test('matchesViolation does not let one case be satisfied by another case evidence', () => {
  // Both are `script-src` on a Level 3 client, and only `blockedURI` tells them apart. This is the
  // assertion that stops the eval case passing on the inline case's violation.
  assert.equal(matchesViolation(REAL_REPORTS.evaluation, expectationFor('inline-no-nonce')), false);
  assert.equal(matchesViolation(REAL_REPORTS.inline, expectationFor('eval')), false);
  // The event handler and an inline element both block "inline"; only the directive separates them.
  assert.equal(matchesViolation(REAL_REPORTS.eventHandler, expectationFor('inline-no-nonce')), false);
  assert.equal(matchesViolation(REAL_REPORTS.inline, expectationFor('event-handler-attribute')), false);
  // The right directive for the remote case, but some other URL.
  assert.equal(
    matchesViolation(
      { effectiveDirective: 'script-src-elem', blockedURI: 'http://127.0.0.1:1/other.js' },
      expectationFor('remote-script', REMOTE_URL),
    ),
    false,
  );
});

test('matchesViolation accepts the CSP Level 2 report shape', () => {
  // An older client has no `effectiveDirective`, and its `violatedDirective` may carry the whole
  // directive including its source list. Only the directive name is compared.
  assert.equal(
    matchesViolation(
      { violatedDirective: "script-src 'self' 'nonce-abc'", blockedURI: 'inline' },
      expectationFor('inline-no-nonce'),
    ),
    true,
  );
});

test('matchesViolation refuses anything that is not a report', () => {
  for (const value of [null, undefined, 'script-src', 42, []]) {
    assert.equal(matchesViolation(value, expectationFor('eval')), false);
  }
  // A report with neither field is not evidence of anything.
  assert.equal(matchesViolation({ blockedURI: 'eval' }, expectationFor('eval')), false);
});

// ---------------------------------------------------------------------------
// The case table
// ---------------------------------------------------------------------------

test('every case is distinct, named, and attributable', () => {
  assert.equal(new Set(CASES.map((entry) => entry.id)).size, CASES.length);
  assert.equal(new Set(CASES.map((entry) => entry.flag)).size, CASES.length);
  for (const testCase of CASES) {
    assert.ok(testCase.directives.length > 0, `${testCase.id} names no directive`);
    assert.ok(testCase.title.length > 0, `${testCase.id} has no title`);
  }
  // Exactly one case is filled in per run, and it is the one whose blocked URI is an address this
  // harness only learns when it opens a socket.
  assert.deepEqual(
    CASES.filter((entry) => entry.blockedUri === null).map((entry) => entry.id),
    ['remote-script'],
  );
});

test('every case that the markup is responsible for actually appears in the markup', () => {
  const markup = attackMarkup({ nonce: REAL_NONCE, remoteScriptUrl: REMOTE_URL });
  // The remote case's flag is set by the body the disallowed origin serves, not by the markup, so it
  // is the one exception — and it is named rather than skipped silently.
  for (const testCase of CASES) {
    if (testCase.id === 'remote-script') {
      assert.ok(markup.includes(REMOTE_URL), 'the remote case has no <script src> in the markup');
      continue;
    }
    assert.ok(markup.includes(testCase.flag), `${testCase.id} declares ${testCase.flag} and nothing sets it`);
  }
});

// ---------------------------------------------------------------------------
// attackMarkup
// ---------------------------------------------------------------------------

test('attackMarkup stamps the real nonce on the probe and nothing else', () => {
  const markup = attackMarkup({ nonce: REAL_NONCE, remoteScriptUrl: REMOTE_URL });
  assert.equal(markup.split(REAL_NONCE).length - 1, 1, 'the real nonce appears more than once');
  assert.ok(markup.includes(`<script nonce="${REAL_NONCE}">`));
  assert.ok(markup.includes(`<script nonce="${WRONG_NONCE}">`));
  // The un-nonced injection must carry no nonce attribute at all.
  assert.ok(markup.includes('<script>window.__prlCspInlineNoNonceRan = true;</script>'));
  assert.ok(markup.includes(`id="${EVENT_HANDLER_ELEMENT_ID}"`));
  assert.ok(markup.includes('onclick="window.__prlCspEventHandlerRan = true"'));
});

test('attackMarkup produces balanced script elements', () => {
  const markup = attackMarkup({ nonce: REAL_NONCE, remoteScriptUrl: REMOTE_URL });
  // A `</script>` inside an inline script body would end the element early and turn the rest of the
  // probe into text, which is a whole run silently proving nothing.
  assert.equal((markup.match(/<script\b/g) ?? []).length, (markup.match(/<\/script>/g) ?? []).length);
  assert.equal((markup.match(/<script\b/g) ?? []).length, 4);
});

test('attackMarkup refuses to run without a real nonce', () => {
  assert.throws(() => attackMarkup({ nonce: '', remoteScriptUrl: REMOTE_URL }), /carried no CSP nonce/);
  assert.throws(() => attackMarkup({ nonce: null, remoteScriptUrl: REMOTE_URL }), /carried no CSP nonce/);
});

test('attackMarkup refuses when the deployment nonce IS the wrong nonce', () => {
  // The wrong-nonce case would be indistinguishable from the correct one, so the run stops rather
  // than reporting a refusal it cannot attribute.
  assert.throws(() => attackMarkup({ nonce: WRONG_NONCE, remoteScriptUrl: REMOTE_URL }), /static nonce/);
});

test('the wrong nonce is well-formed and is not the real one', () => {
  assert.notEqual(WRONG_NONCE, REAL_NONCE);
  assert.match(WRONG_NONCE, /^[A-Za-z0-9+/]+={0,2}$/);
});

// ---------------------------------------------------------------------------
// injectAttackMarkup
// ---------------------------------------------------------------------------

test('injectAttackMarkup splices before the last </body> and changes nothing else', () => {
  const html = '<!doctype html><html><body><p>hello</p></body></html>';
  const out = injectAttackMarkup(html, '<b>X</b>');
  assert.ok(out.includes('<p>hello</p>'));
  assert.ok(out.indexOf('<b>X</b>') < out.indexOf('</body>'));
  assert.ok(out.indexOf('<b>X</b>') > out.indexOf('<p>hello</p>'));
  assert.ok(out.endsWith('</body></html>'));
});

test('injectAttackMarkup uses the LAST </body>, not the first', () => {
  // A page whose own content mentions the string must still be attacked at its real end.
  const html = '<body><code>&lt;/body&gt;</code>x</body>y</body></html>';
  const out = injectAttackMarkup(html, 'MARK');
  assert.equal(out.lastIndexOf('MARK') < out.lastIndexOf('</body>'), true);
  assert.equal(out.split('MARK').length - 1, 1);
  assert.ok(/MARK\n<\/body><\/html>$/.test(out));
});

test('injectAttackMarkup THROWS rather than returning the document unchanged', () => {
  assert.throws(() => injectAttackMarkup('<p>no body element here</p>', 'MARK'), /no <\/body>/);
});

// ---------------------------------------------------------------------------
// buildVerdict
// ---------------------------------------------------------------------------

const passEntry = (kind) => ({ level: 'pass', kind, label: 'x', detail: '' });
const failEntry = (kind) => ({ level: 'fail', kind, label: 'x', detail: 'y' });

test('buildVerdict passes only with a negative control AND a positive control AND no failure', () => {
  const verdict = buildVerdict([passEntry('negative'), passEntry('positive')]);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.negativeControls, 1);
  assert.equal(verdict.positiveControls, 1);
  assert.deepEqual(verdict.reasons, []);
});

test('buildVerdict fails on any failure', () => {
  const verdict = buildVerdict([passEntry('negative'), passEntry('positive'), failEntry('negative')]);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.failed, 1);
  assert.match(verdict.reasons.join(' '), /1 check\(s\) failed/);
});

test('buildVerdict fails when nothing was injected, even with zero failures', () => {
  // The run that fell over before it attacked anything. Zero failures, and it must not be a pass.
  const verdict = buildVerdict([passEntry('positive')]);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.exitCode, 1);
  assert.match(verdict.reasons.join(' '), /no injection was ever refused/);
});

test('buildVerdict fails when the positive control never ran', () => {
  const verdict = buildVerdict([passEntry('negative')]);
  assert.equal(verdict.passed, false);
  assert.match(verdict.reasons.join(' '), /a dead page would have passed/);
});

test('buildVerdict fails on an empty record with both reasons', () => {
  const verdict = buildVerdict([]);
  assert.equal(verdict.passed, false);
  assert.equal(verdict.exitCode, 1);
  assert.equal(verdict.reasons.length, 2);
});

test('buildVerdict ignores context notes', () => {
  const verdict = buildVerdict([
    { level: 'note', kind: 'context', label: 'policy', detail: '' },
    passEntry('negative'),
    passEntry('positive'),
  ]);
  assert.equal(verdict.passes, 2);
  assert.equal(verdict.passed, true);
});

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults', () => {
  const options = parseArgs([]);
  assert.equal(options.route, '/');
  assert.equal(options.start, false);
  assert.equal(options.withApi, false);
  assert.equal(options.headful, false);
  assert.equal(options.out, null);
  assert.equal(options.help, false);
  assert.equal(options.readyTimeoutSeconds, 120);
});

test('parseArgs reads GNU long options with space-separated values', () => {
  const options = parseArgs([
    '--base-url',
    'http://example.test:4000',
    '--api-url',
    'http://example.test:4001',
    '--route',
    '/learn',
    '--ready-timeout',
    '30',
    '--out',
    'report.json',
  ]);
  assert.equal(options.baseUrl, 'http://example.test:4000');
  assert.equal(options.apiUrl, 'http://example.test:4001');
  assert.equal(options.route, '/learn');
  assert.equal(options.readyTimeoutSeconds, 30);
  assert.equal(options.out, 'report.json');
});

test('parseArgs boolean flags take no value', () => {
  const options = parseArgs(['--start', '--with-api', '--headful']);
  assert.equal(options.start, true);
  assert.equal(options.withApi, true);
  assert.equal(options.headful, true);
});

test('parseArgs treats --json and --out as one option', () => {
  assert.equal(parseArgs(['--json', 'a.json']).out, 'a.json');
  assert.equal(parseArgs(['--out', 'b.json']).out, 'b.json');
});

test('parseArgs absorbs the -- that pnpm passes through', () => {
  const options = parseArgs(['--', '--headful']);
  assert.equal(options.headful, true);
});

test('parseArgs accepts both spellings of help', () => {
  assert.equal(parseArgs(['-h']).help, true);
  assert.equal(parseArgs(['--help']).help, true);
});

test('parseArgs throws the REASON, not "invalid"', () => {
  assert.throws(() => parseArgs(['--nope']), /^Error: unknown option --nope \(try --help\)$/);
  assert.throws(() => parseArgs(['--base-url']), /--base-url needs a value/);
  assert.throws(() => parseArgs(['--route', 'learn']), /must be a path beginning with "\/", not learn/);
  assert.throws(() => parseArgs(['--ready-timeout', '0']), /positive whole number of seconds/);
  assert.throws(() => parseArgs(['--ready-timeout', 'soon']), /positive whole number of seconds/);
  assert.throws(() => parseArgs(['--with-api']), /only means anything with --start/);
});

// ---------------------------------------------------------------------------
// The age gate
// ---------------------------------------------------------------------------

test('landedOnAgeGate matches by segment, never by substring', () => {
  assert.equal(landedOnAgeGate('/', '/age-check'), true);
  assert.equal(landedOnAgeGate('/', '/age-check/next'), true);
  // The failure the segment rule exists to prevent.
  assert.equal(landedOnAgeGate('/', '/age-checkers'), false);
  assert.equal(landedOnAgeGate('/', '/learn'), false);
  // Asking for the gate and getting the gate is not an interception.
  assert.equal(landedOnAgeGate('/age-check', '/age-check'), false);
});

test('ageDeclarationCookies omits the __Host- name over plain HTTP', () => {
  const http = ageDeclarationCookies('http://127.0.0.1:3000');
  assert.ok(http.length > 0);
  assert.equal(
    http.some((cookie) => cookie.name.startsWith('__Host-')),
    false,
  );
  for (const cookie of http) {
    assert.equal(cookie.secure, false);
    assert.equal(cookie.path, '/');
  }
});

test('ageDeclarationCookies seeds every name over HTTPS, marked secure', () => {
  const https = ageDeclarationCookies('https://poker.example');
  assert.ok(https.some((cookie) => cookie.name.startsWith('__Host-')));
  for (const cookie of https) assert.equal(cookie.secure, true);
  // One value satisfies any threshold the gate can be configured with, so every cookie carries it.
  assert.equal(new Set(https.map((cookie) => cookie.value)).size, 1);
});
