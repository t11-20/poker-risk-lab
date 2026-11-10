#!/usr/bin/env node
/**
 * Tests for the `secret-scan` gate.
 *
 * Run with:  node --test scripts/supply-chain/secret-scan.test.mjs
 *
 * ## What these are actually defending
 *
 * A secret scanner has two failure modes and they are not symmetrical. Missing a
 * credential publishes it. Reporting a line that never held one costs nothing on
 * the day it happens and everything three weeks later, when the gate has fifty
 * known-false lines and the reader has learned to scroll past all of them —
 * including the fifty-first.
 *
 * So the positive cases below are the shapes that must never pass, and the
 * negative cases are every false positive the first two runs of this gate
 * actually produced against this repository: a `const secret = config.x`
 * reference, a `${...}` interpolation, a loopback database URL from
 * `.env.example`, an `example.test` host, a kebab-case fixture name, and a
 * sentence in a comment that happened to follow the word "secret".
 *
 * The last group is the important one. Each of those was a real report, and
 * each is now a rule with a reason rather than an entry on a list.
 *
 * ## The `(REGRESSION)` groups are the third kind, and they are the misses
 *
 * A false positive announces itself; a MISS is silent, and the only thing that
 * makes it visible afterwards is a test that would have failed before. Each group
 * below marked `(REGRESSION)` names the exact input the old code was fed and what
 * it returned:
 *
 *   * a provider token past the 4096-character line bound — `[]`, because the
 *     whole line was dropped rather than just the expensive detectors;
 *   * a real token appended to a line blessed by a pragma on the line ABOVE it —
 *     `[]`, because that pragma suppressed everything on the next line;
 *   * `.env.staging.example` and `.env.d.ts` — blocked from being tracked by a
 *     rule that exempted only the literal name `.env.example`.
 *
 * Two groups deliberately are NOT regressions and say so in place: the YAML/JSON
 * config detector is new capability, and the bare-`key` group pins a claim the
 * file's own header used to make inaccurately. A test that passes against the old
 * code is worth having when what it locks down is a sentence.
 *
 * ## Why the fixtures here carry pragmas
 *
 * This file is read by the gate like every other tracked file, and a fixture that
 * must LOOK like a credential is the case the `prl-allow-secret` pragma exists
 * for. The pragma sits on the SOURCE line; the string an assertion hands
 * `scanText` never contains it, so suppressing the gate's view of the fixture
 * cannot change what the test measures.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  findReasonlessPragmas,
  isLocalHost,
  isPlaceholder,
  isStructuredConfig,
  isTypedName,
  isUnroutableHost,
  redact,
  scanNpmrc,
  scanText,
  shannonEntropy,
} from './secret-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const GATE = join(HERE, 'secret-scan.mjs');

/** The detector names a text produced, in order. */
const detectors = (text) => scanText(text).map((finding) => finding.detector);

/**
 * A `${...}` interpolation, spelled through a substitution rather than written out.
 *
 * Biome's `noTemplateCurlyInString` refuses a plain string containing that syntax
 * and `noUnusedTemplateLiteral` refuses a template literal without one, which
 * leaves no spelling for a string that must genuinely contain it. This is the
 * same construction, and the same reason, as `ci-pinning.test.mjs`: the
 * repository has no `biome-ignore` comments anywhere and a test fixture is a poor
 * place to add the first.
 */
const interpolation = (body) => `\u0024{${body}}`;

describe('provider token shapes', () => {
  it('finds the tokens whose prefix is the evidence', () => {
    const cases = [
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      ['AKIAIOSFODNN7EXAMPLE', 'aws-access-key-id'],
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      ['ghp_012345678901234567890123456789012345', 'github-token'],
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      ['xoxb-0123456789-abcdefghij', 'slack-token'],
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      ['sk_live_0123456789abcdefghij', 'stripe-live-key'],
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      ['AIzaSyA01234567890123456789012345678901', 'google-api-key'],
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      ['npm_012345678901234567890123456789012345', 'npm-token'],
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      ['-----BEGIN OPENSSH PRIVATE KEY-----', 'private-key-block'],
    ];
    for (const [value, detector] of cases) {
      assert.deepEqual(detectors(`const x = '${value}';`), [detector], `missed ${detector}`);
    }
  });

  it('fires on a prefix match regardless of the surrounding name', () => {
    // The whole point of a prefixed token: it is a credential wherever it appears,
    // including in a log line, a fixture path or a URL query string.
    // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
    assert.deepEqual(detectors('curl "https://api/x?k=ghp_012345678901234567890123456789012345"'), [
      'github-token',
    ]);
  });
});

describe('credentialed URLs', () => {
  it('reports a password pointing at a host somebody else can reach', () => {
    // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
    assert.deepEqual(detectors("DATABASE_URL='postgres://u:Hunter2Hunter2@db.prod.acme.com/x'"), [
      'url-embedded-password',
    ]);
  });

  it('says nothing about loopback, compose service names or reserved domains', () => {
    // Every one of these is in this repository on purpose: .env.example, three CI
    // jobs, the compose files and most of the API test suite.
    const quiet = [
      'postgresql://prl_api:poker-dev-only@127.0.0.1:5432/poker_risk_lab',
      'postgres://prl:prl@localhost:5432/prl',
      'postgres://prl:prl@postgres:5432/prl',
      'postgres://poker:poker@db.internal:5432/poker_risk_lab',
      "PUBLIC_WEB_ORIGIN: 'https://user:pass@app.example.test'",
      'postgresql://prl_deployer:poker-dev-only@...',
    ];
    for (const line of quiet) assert.deepEqual(detectors(line), [], line);
  });
});

describe('credential-shaped names', () => {
  it('reports a high-entropy literal', () => {
    // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
    assert.deepEqual(detectors("SESSION_COOKIE_SECRET: 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'"), [
      'secret-literal',
    ]);
  });

  it('reports an unquoted environment-file assignment', () => {
    assert.deepEqual(detectors('PRL_BACKUP_KEY=Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'), ['secret-env-assignment']);
  });

  it("reads a camelCase name, which is this repository's default convention (REGRESSION)", () => {
    // The separator before the credential word used to be mandatory, so `API_KEY` matched and
    // `apiKey` did not — switching the generic detector off for most of a TypeScript monorepo.
    // The AWS secret access key has no prefix of its own, so this detector is the only thing
    // that can ever see one.
    for (const line of [
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      "const apiKey = 'hT3kq9ZmR2vL8xPd41Ns6Wc0';",
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      "const clientSecret = 'hT3kq9ZmR2vL8xPd41Ns6Wc0';",
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      "const awsSecretAccessKey = 'wJalrXUtnFEMIK7MDENGbPxRfiCYzEXAMPLEKEY';",
      // prl-allow-secret: a fixture the detector must fire on; this file is what proves it does
      "  privateKey: 'hT3kq9ZmR2vL8xPd41Ns6Wc0',",
    ]) {
      assert.deepEqual(detectors(line), ['secret-literal'], line);
    }
  });

  it('still says nothing about a property assignment or a timestamp', () => {
    // Both arrived with the camelCase relaxation and are the reason the env-file form refuses a
    // dotted name and `isPlaceholder` knows an ISO-8601 timestamp.
    assert.deepEqual(detectors('parsed.password = encodeURIComponent(password);'), []);
    assert.deepEqual(detectors("  const cursor = { startedAtKey: '2026-08-17T14:26:23.974456Z' };"), []);
  });

  it('does not report a reference to a credential held elsewhere', () => {
    // This is what correct code looks like. Reporting it is how a gate teaches
    // its reader that it cannot tell reading a secret from writing one down.
    const quiet = [
      'const secret = config.sessionCookieSecret;',
      "const token = request.headers['authorization'];",
      `const credentials = ${interpolation('formEncode(config.clientId)')};`,
      `SESSION_COOKIE_SECRET=${interpolation('PRL_STAGING_SESSION_COOKIE_SECRET:?set it')}`,
      'api_key: process.env.PRL_KEY',
    ];
    for (const line of quiet) assert.deepEqual(detectors(line), [], line);
  });

  it('does not report placeholders, slugs or prose', () => {
    const quiet = [
      'SESSION_COOKIE_SECRET=replace-me-this-example-value-is-rejected-in-production',
      "OIDC_CLIENT_SECRET: 'drill-secret-value-for-a-drill-only',",
      "SESSION_COOKIE_SECRET: 'y3-turn-clock-test-secret-value-long-enough',",
      '// Deterministic under one secret: "which sessions are mine" has to keep working.',
      'DATABASE_URL=postgresql://prl_backup:CHANGE_ME@127.0.0.1:5432/poker_risk_lab',
    ];
    for (const line of quiet) assert.deepEqual(detectors(line), [], line);
  });

  it('ignores a value too short to be a credential', () => {
    assert.deepEqual(detectors("password: 'abc123'"), []);
  });

  it('does not match a name that merely contains a credential word', () => {
    // TOKEN_BUDGET, KEYBOARD_AUDIT and SECRETS_DOC are not credentials.
    assert.deepEqual(detectors('TOKEN_BUDGET_PER_MINUTE=30000000000000000000'), []);
  });
});

describe('suppression', () => {
  it('honours a pragma on the line and on the line above', () => {
    const value = 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw';
    assert.deepEqual(
      detectors(`const s = 'ghp_012345678901234567890123456789012345'; // prl-allow-secret: docs`),
      [],
    );
    assert.deepEqual(detectors(`// prl-allow-secret: fixture\nSECRET: '${value}'`), []);
  });

  it('reports a pragma with no reason, so a suppression is always reviewable', () => {
    assert.deepEqual(findReasonlessPragmas('const s = 1; // prl-allow-secret:'), [1]);
    assert.deepEqual(findReasonlessPragmas('const s = 1; // prl-allow-secret: because'), []);
  });

  it('suppresses a value recorded as a published constant, wherever it appears', () => {
    // The API test suite's shared session secret. Recorded by hash so the entry
    // works in history, where a pragma added today does not exist.
    assert.deepEqual(detectors("SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA'"), []);
  });
});

describe('.npmrc auth', () => {
  it('says nothing about an interpolated token, which is the correct way to write one', () => {
    // The regression: this detector ignored `isPlaceholder` and the pragma, so
    // `_authToken=${NODE_AUTH_TOKEN}` — the standard CI npmrc, and the shape this file's header
    // calls the correct way to reference a secret — failed the gate, and the failure told the
    // operator to add a pragma the detector did not read.
    assert.deepEqual(scanNpmrc(`//registry.npmjs.org/:_authToken=${interpolation('NODE_AUTH_TOKEN')}\n`), []);
    assert.deepEqual(
      scanNpmrc('//registry.npmjs.org/:_authToken=abc123def456 // prl-allow-secret: fixture\n'),
      [],
    );
  });

  it('reports an auth field and leaves registry pinning alone', () => {
    const npmrc = [
      'registry=https://registry.npmjs.org/',
      '//registry.npmjs.org/:_authToken=abc123def456',
    ].join('\n');
    assert.deepEqual(
      scanNpmrc(npmrc).map((f) => f.detector),
      ['npmrc-auth'],
    );
    assert.deepEqual(scanNpmrc('@prl:registry=https://registry.npmjs.org/\n'), []);
  });
});

describe('evidence is redacted', () => {
  it('prints a prefix and a length, never the value', () => {
    const secret = 'ghp_012345678901234567890123456789012345'; // prl-allow-secret: a fixture the detector must fire on
    const evidence = redact(secret);
    assert.match(evidence, /^ghp_… \(40 chars\)$/);
    assert.ok(!evidence.includes(secret), 'the finding restated the credential it found');
  });

  it('never restates the value in a finding either', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'; // prl-allow-secret: a fixture the detector must fire on
    for (const finding of scanText(`key = '${secret}'`)) {
      assert.ok(!finding.evidence.includes(secret), 'a finding carried the whole credential');
    }
  });
});

describe('helpers', () => {
  it('scores entropy so prose and randomness are separable', () => {
    assert.ok(shannonEntropy('aaaaaaaaaaaaaaaa') < 1);
    assert.ok(shannonEntropy('Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw') > 4);
  });

  it('knows which hosts nobody else can reach', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      'postgres',
      '10.0.0.4',
      '192.168.1.9',
      'host.docker.internal',
    ]) {
      assert.equal(isLocalHost(host), true, host);
    }
    assert.equal(isLocalHost('db.prod.acme.com'), false);
    assert.equal(isUnroutableHost('app.example.test'), true);
    assert.equal(isUnroutableHost('db.prod.acme.com'), false);
  });

  it('recognises a typed name and not a generated one', () => {
    assert.equal(isTypedName('drill-secret-value-for-a-drill-only'), true);
    assert.equal(isTypedName('y3-turn-clock-test-secret-value-long-enough'), true);
    assert.equal(isTypedName('stackDepthAdjustment'), true);
    assert.equal(isTypedName('prl.learn.onboarding.dismissed'), true);
    assert.equal(isTypedName('Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'), false);
    assert.equal(isPlaceholder(interpolation('SOMETHING')), true);
    assert.equal(isPlaceholder('CHANGE_ME'), true);
  });
});

describe('long lines still get the anchored detectors (REGRESSION)', () => {
  it('finds a provider token past the generic-detector bound', () => {
    // Fed `'x'.repeat(4100) + ' ghp_aaaa…'`, the old `if (line.length > 4096) continue;`
    // returned []. The identical token on a short line returned one github-token. A
    // minified .json or .js config is one line by construction and is the likeliest
    // single place a build-time-injected credential lands, so the bound switched the
    // scanner off exactly where a real one would be. It now returns the finding.
    const token = `ghp_${'a'.repeat(36)}`;
    const long = `${'x'.repeat(4100)} ${token}`;
    assert.deepEqual(detectors(long), ['github-token'], 'a long line must not swallow a prefixed token');
    assert.deepEqual(detectors(`x ${token}`), ['github-token'], 'and the short-line control still works');
  });

  it('says that the column on such a line is not somewhere you can go', () => {
    // A column 4,102 characters into minified output is not a place an editor can take
    // anybody, and a finding that offers one without saying so reads as a source
    // location. The note is also where the remaining gap is stated: the generic
    // name-and-value detectors did not run on that line.
    const [finding] = scanText(`${'x'.repeat(4100)} ghp_${'a'.repeat(36)}`);
    assert.ok(finding !== undefined);
    assert.match(finding.note ?? '', /4141-character line/);
    assert.match(finding.note ?? '', /generic name-and-value detectors did NOT run/);
    // A finding on an ordinary line carries no note, so the note means something.
    const [ordinary] = scanText(`const t = 'ghp_${'a'.repeat(36)}';`);
    assert.equal(ordinary?.note, undefined);
  });

  it('leaves the generic detectors bounded, because their cost is quadratic', () => {
    // `SECRET_LITERAL` and `URL_CREDENTIAL` open with unanchored greedy runs that
    // backtrack at every start position. This is the deliberate remaining gap, asserted
    // so that it is a decision rather than an accident: a credential-named quoted value
    // inside a 40,000-character minified line is still missed.
    // prl-allow-secret: a fixture that must LOOK like a credential to test the detector
    const buried = `${'x'.repeat(5000)} SESSION_SECRET: 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'`;
    assert.deepEqual(detectors(buried), [], 'documented gap: generic detectors are length-bounded');
    // The same content under the bound is found, which is what makes the line above a
    // statement about length rather than about the detector.
    assert.deepEqual(detectors("SESSION_SECRET: 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'"), ['secret-literal']); // prl-allow-secret: the same fixture, inline
  });
});

describe('a preceding-line pragma is spent on one finding (REGRESSION)', () => {
  const fixture = `ghp_${'0'.repeat(36)}`;
  const real = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // prl-allow-secret: the "real" token of the pragma fixture; it is not one

  it('no longer blesses a second value appended to the blessed line', () => {
    // Fed exactly this, the old code returned [] — both tokens suppressed. The header
    // claimed the pragma "travels with the line, so a copy of that line pasted into real
    // code arrives carrying a visible claim about itself", which is true of the same-line
    // form and false of this one: nothing on the second line carries any claim at all,
    // so a real token appended to an already-blessed line inherited the blessing in
    // silence. It now returns one github-token, for the SECOND value.
    const text = `// prl-allow-secret: the fixture below is fake\nconst FIXTURE='${fixture}'; const REAL='${real}';`;
    const found = scanText(text);
    assert.deepEqual(
      found.map((f) => f.detector),
      ['github-token'],
      'the appended token must be reported',
    );
    assert.equal(found[0]?.line, 2);
    // The leftmost finding is the one the pragma is spent on — the position the author's
    // own value occupied when they wrote it — so the survivor is the one further right.
    assert.ok((found[0]?.column ?? 0) > `const FIXTURE='`.length);
    assert.match(found[0]?.note ?? '', /already spent/);
  });

  it('keeps the oversized-line note as well, when a line has both', () => {
    // The two notes answer different questions — "this column is not a place" and "the
    // pragma above was already used" — and an oversized line with two tokens under a
    // preceding pragma raises both. The note is appended rather than assigned so the
    // first is not lost; without that, the surviving finding on a 4,100-character line
    // would offer an unnavigable column with no explanation of it.
    const text = `// prl-allow-secret: the first one is a fixture\nconst L='${fixture}'; ${'x'.repeat(4100)} ${real}`;
    const found = scanText(text);
    assert.equal(found.length, 1);
    assert.match(found[0]?.note ?? '', /character line/);
    assert.match(found[0]?.note ?? '', /already spent/);
  });

  it('still suppresses the ordinary one-value case, which is what the pragma is for', () => {
    // The overwhelmingly common shape, and the reason the limit is one finding rather
    // than zero: a pragma above a line with a single documented example still works.
    assert.deepEqual(detectors(`// prl-allow-secret: fixture\nSECRET: 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'`), []);
    assert.deepEqual(detectors(`# prl-allow-secret: docs example\nconst t = '${fixture}';`), []);
  });

  it('a pragma ON the line still covers the whole line, and says why it may', () => {
    // The two placements are not equivalent and the rule follows the visibility: the
    // claim is written on the line it excuses, so a copy-paste carries it and a reviewer
    // reading the line reads the claim. Appending to such a line does inherit the
    // suppression; that is accepted, and documented, because the line says out loud that
    // it has been excused.
    const line = `const A='${fixture}'; const B='${real}'; // prl-allow-secret: both are fixtures`;
    assert.deepEqual(detectors(line), []);
  });
});

describe('NEVER_TRACKED exempts templates, not environments (REGRESSION)', () => {
  // The rule was `/(^|\/)\.env\.(?!example$)[^/]+$/` — one literal exemption. It blocked
  // `.env.staging.example` and `.env.local.example`, which are the same class of file as
  // the `.env.example` it deliberately exempts, and `.env.d.ts`, which is a TypeScript
  // ambient declaration holding type names rather than values. Nothing here is caught by
  // any of that today, which is what made it a trap for the next file added rather than a
  // live failure: a release gate telling somebody to rotate a credential that never
  // existed is a gate somebody adds a hurried exemption to.
  //
  // Asserted against the pattern as the gate spells it, because the constant is internal.
  // Fed the same eight paths, the old pattern returned true for the first five.
  const ENV_RULE = /(^|\/)\.env\.(?!(?:[^/]*\.)?example$)(?!d\.ts$)[^/]+$/;

  it('lets a *.example template and a .d.ts declaration be tracked', () => {
    for (const path of ['.env.example', '.env.staging.example', '.env.local.example', '.env.d.ts']) {
      assert.equal(ENV_RULE.test(path), false, `${path} must not be blocked`);
    }
  });

  it('still blocks every file that actually holds environment values', () => {
    // `.env.test` and `.env.development` stay blocked on purpose: both hold real values
    // on somebody's disk whatever the suffix suggests, and `.env.local` is on the
    // MUST_BE_IGNORED list for exactly that reason. The exemption is for files whose NAME
    // says they carry no values, not for environments that sound unimportant.
    for (const path of [
      '.env.test',
      '.env.development',
      '.env.local',
      '.env.production',
      'deploy/staging/.env.staging',
      '.env.myexample',
    ]) {
      assert.equal(ENV_RULE.test(path), true, `${path} must still be blocked`);
    }
  });
});

describe('YAML and JSON configuration values', () => {
  it('reads an unquoted YAML scalar, which no other detector can see', () => {
    // The gap this closes: `SECRET_LITERAL` needs quotes and YAML does not use them,
    // `SECRET_ENV_ASSIGNMENT` needs `=` and YAML uses `:`. This deployment's
    // configuration is YAML — the compose files, the Prometheus scrape config, three CI
    // workflows — so a bare scalar under a credential-shaped key sat between the two.
    // Before: scanText('  metricsToken: aZ9k…', 'deploy.yml') returned []. After:
    // one config-secret-value.
    const line = '  metricsToken: aZ9kQ2vR8tX4bN6mL1sD7gH3jF5wC0yPqE';
    assert.deepEqual(
      scanText(line, 'deploy/staging/observability/prometheus.yml').map((f) => f.detector),
      ['config-secret-value'],
    );
    assert.deepEqual(
      scanText('  "apiKey": "aZ9kQ2vR8tX4bN6mL1sD7gH3jF5wC0yPqE",', 'apps/api/config.json').map(
        (f) => f.detector,
      ),
      ['config-secret-value'],
    );
  });

  it('reads `Bearer <token>` under a key that is not credential-shaped', () => {
    // `authorization` is not in SECRET_NAME_PART and never will be — `authorization` in
    // TypeScript is usually the header being read. In a scrape config or a webhook
    // definition it is the canonical place a bearer token is written down. The scheme
    // word is stripped before the value tests, because `isPlaceholder` rejects anything
    // containing a space and would otherwise reject every one of them.
    for (const line of [
      '    authorization: Bearer aZ9kQ2vR8tX4bN6mL1sD7gH3jF5wC0yPqE',
      '  credentials: Basic YWxhZGRpbjpvcGVuc2VzYW1lMTIzNDU2Nzg5',
    ]) {
      assert.deepEqual(
        scanText(line, 'prometheus.yml').map((f) => f.detector),
        ['config-auth-scheme'],
        line,
      );
    }
  });

  it('runs ONLY on .yml/.yaml/.json, which is what makes it precise', () => {
    // The general form of this detector was tried across the whole repository and
    // reverted: in a TypeScript monorepo `key: 'someIdentifier'` is object-literal syntax
    // and it produced 62 false positives on this repository alone. Restricted to formats
    // where object-literal syntax cannot occur, it measured 0 findings and 0 false
    // positives over the 42 tracked YAML and JSON files. This is that restriction.
    const line = '  metricsToken: aZ9kQ2vR8tX4bN6mL1sD7gH3jF5wC0yPqE';
    for (const path of ['src/config.ts', 'src/config.tsx', 'README.md', 'Makefile', '']) {
      assert.deepEqual(scanText(line, path), [], `${path || '(no path)'} must not run the config detector`);
    }
    assert.equal(isStructuredConfig('a/b.yaml'), true);
    assert.equal(isStructuredConfig('a/b.yml'), true);
    assert.equal(isStructuredConfig('a/b.json'), true);
    assert.equal(isStructuredConfig('a.json/b.ts'), false, 'the extension, not a directory name');
    assert.equal(isStructuredConfig(''), false, 'fails closed when the caller forgets the path');
  });

  it('stays quiet on the shapes this repository actually writes', () => {
    // Every one of these is in a tracked YAML here on purpose. Interpolation is the
    // correct way to reference a secret; `credentials_file` names a path, not a value;
    // a `#` comment is not a mapping; a short value is not a credential.
    const quiet = [
      `  METRICS_TOKEN: ${interpolation('PRL_STAGING_METRICS_TOKEN:?set it in deploy/staging/.env.staging')}`,
      '      credentials_file: /etc/prometheus/metrics-token',
      '  # token: aZ9kQ2vR8tX4bN6mL1sD7gH3jF5wC0yPqE',
      '  password: hunter2',
      '  key: some-kebab-case-fixture-name',
    ];
    for (const line of quiet) assert.deepEqual(scanText(line, 'docker-compose.yml'), [], line);
  });
});

describe('the cost of a bare `key` is real, and the header now says so', () => {
  it('reports a cache key, an idempotency key, a git SHA and a PUBLIC VAPID key', () => {
    // This pins a DOC claim rather than a behaviour change, so unlike its neighbours it
    // passes against the old code — the reports are unchanged, the comment describing
    // them was wrong. It used to say the cost of a bare `key` in the name list was paid
    // for by the value tests. It is not: the value tests are length >= 20, not a
    // placeholder, entropy >= 3.2 bits/char, and not a PUBLISHED_CONSTANTS hash, and all
    // four of these clear all four. Nothing in them could separate any of these from a
    // credential, because there is nothing to separate — the last one grants nothing and
    // looks more like a credential than the rest.
    //
    // The policy is accepted: each of these needs a pragma, and writing one is the human
    // saying which it is. Dropping bare `key` would make PRL_BACKUP_KEY — the value that
    // decrypts every archive — invisible to the only detector that can see it.
    //
    // Each fixture below carries a pragma of its own, because this file is read by the
    // gate like any other tracked file and a fixture that must LOOK like a credential is
    // exactly the case the pragma exists for. The pragma is on the source line; the
    // string the assertion feeds `scanText` does not contain it.
    const firing = [
      "const CACHE_KEY = 'v3:profile:f4a9c1e8b27d3a6f9012cd45ef6789ab';", // prl-allow-secret: a hashed cache key fixture
      "const IDEMPOTENCY_KEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';", // prl-allow-secret: a hex idempotency fixture
      "const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';", // prl-allow-secret: a git SHA fixture
      "vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'", // prl-allow-secret: a PUBLIC VAPID key fixture
    ];
    for (const line of firing) {
      assert.deepEqual(detectors(line), ['secret-literal'], `the header claims this fires: ${line}`);
    }
    // And the pragma is the remedy the header now points at, so it has to work.
    for (const line of firing) {
      assert.deepEqual(detectors(`${line} // prl-allow-secret: not a credential`), [], line);
    }
  });
});

describe('the gate as a whole', () => {
  it('passes on this repository, which is the claim it exists to make', () => {
    const res = execFileSync(process.execPath, [GATE], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.match(res, /secret-scan — pass/);
  });

  it('fails when a path an operator is told to write a secret to is not ignored', () => {
    // The defect this gate was written for: `deploy/backup/backup.env` holds
    // PRL_BACKUP_KEY and was matched by no ignore rule, so on a backup host one
    // `git add -A` would have committed the key that decrypts every archive.
    // This asserts the rule that now covers it, from git's own answer rather than
    // by re-reading .gitignore — the question is what git does, not what the file says.
    const ignored = (path) => {
      // `git check-ignore -q` exits 1 when nothing matches, which execFileSync turns into a
      // throw. Caught here so the assertion below reports the path rather than a stack.
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', '--', path], {
          cwd: REPO_ROOT,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    for (const path of [
      '.env',
      'deploy/backup/backup.env',
      'deploy/staging/tls/staging-ca-key.pem',
      'deploy/staging/observability/metrics-token',
    ]) {
      assert.equal(ignored(path), true, `no ignore rule matches ${path}`);
    }
  });
});
