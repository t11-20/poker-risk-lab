#!/usr/bin/env node
/**
 * Tests for the `secret-scan` gate. Run with `node --test scripts/supply-chain/secret-scan.test.mjs`.
 *
 * Positive cases are shapes that must never pass. Negative cases are false positives earlier runs
 * produced against this repo. `(REGRESSION)` groups name an input the old code missed.
 *
 * Fixtures carry `prl-allow-secret` pragmas because the gate reads this file too. The pragma is on
 * the source line, never in the string handed to `scanText`.
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

const detectors = (text) => scanText(text).map((finding) => finding.detector);

/**
 * Biome refuses `${` in a plain string and a template literal without a substitution, so the
 * interpolation is built through one. Same construction as `ci-pinning.test.mjs`.
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
    // All of these are in the repo on purpose.
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
    // The separator used to be mandatory, so `API_KEY` matched and `apiKey` did not.
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
    assert.deepEqual(detectors('parsed.password = encodeURIComponent(password);'), []);
    assert.deepEqual(detectors("  const cursor = { startedAtKey: '2026-08-17T14:26:23.974456Z' };"), []);
  });

  it('does not report a reference to a credential held elsewhere', () => {
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
    // The API test suite's shared session secret, recorded by hash.
    assert.deepEqual(detectors("SESSION_COOKIE_SECRET: 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA'"), []);
  });
});

describe('.npmrc auth', () => {
  it('says nothing about an interpolated token, which is the correct way to write one', () => {
    // This detector used to ignore `isPlaceholder` and the pragma, so the standard CI npmrc failed.
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
    // The old `if (line.length > 4096) continue;` returned [] here.
    const token = `ghp_${'a'.repeat(36)}`;
    const long = `${'x'.repeat(4100)} ${token}`;
    assert.deepEqual(detectors(long), ['github-token'], 'a long line must not swallow a prefixed token');
    assert.deepEqual(detectors(`x ${token}`), ['github-token'], 'and the short-line control still works');
  });

  it('says that the column on such a line is not somewhere you can go', () => {
    const [finding] = scanText(`${'x'.repeat(4100)} ghp_${'a'.repeat(36)}`);
    assert.ok(finding !== undefined);
    assert.match(finding.note ?? '', /4141-character line/);
    assert.match(finding.note ?? '', /generic name-and-value detectors did NOT run/);
    const [ordinary] = scanText(`const t = 'ghp_${'a'.repeat(36)}';`);
    assert.equal(ordinary?.note, undefined);
  });

  it('leaves the generic detectors bounded, because their cost is quadratic', () => {
    // The deliberate remaining gap: generic detectors do not run past the bound.
    // prl-allow-secret: a fixture that must LOOK like a credential to test the detector
    const buried = `${'x'.repeat(5000)} SESSION_SECRET: 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'`;
    assert.deepEqual(detectors(buried), [], 'documented gap: generic detectors are length-bounded');
    assert.deepEqual(detectors("SESSION_SECRET: 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'"), ['secret-literal']); // prl-allow-secret: the same fixture, inline
  });
});

describe('a preceding-line pragma is spent on one finding (REGRESSION)', () => {
  const fixture = `ghp_${'0'.repeat(36)}`;
  const real = 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'; // prl-allow-secret: the "real" token of the pragma fixture; it is not one

  it('no longer blesses a second value appended to the blessed line', () => {
    // The old code returned [] here, suppressing both tokens.
    const text = `// prl-allow-secret: the fixture below is fake\nconst FIXTURE='${fixture}'; const REAL='${real}';`;
    const found = scanText(text);
    assert.deepEqual(
      found.map((f) => f.detector),
      ['github-token'],
      'the appended token must be reported',
    );
    assert.equal(found[0]?.line, 2);
    // The pragma is spent on the leftmost finding.
    assert.ok((found[0]?.column ?? 0) > `const FIXTURE='`.length);
    assert.match(found[0]?.note ?? '', /already spent/);
  });

  it('keeps the oversized-line note as well, when a line has both', () => {
    // The note is appended, so the oversized-line note survives.
    const text = `// prl-allow-secret: the first one is a fixture\nconst L='${fixture}'; ${'x'.repeat(4100)} ${real}`;
    const found = scanText(text);
    assert.equal(found.length, 1);
    assert.match(found[0]?.note ?? '', /character line/);
    assert.match(found[0]?.note ?? '', /already spent/);
  });

  it('still suppresses the ordinary one-value case, which is what the pragma is for', () => {
    assert.deepEqual(detectors(`// prl-allow-secret: fixture\nSECRET: 'Kd93Lp2Qv8Zx4Rt7Bn1Ym6Hs0Gc5Jw'`), []);
    assert.deepEqual(detectors(`# prl-allow-secret: docs example\nconst t = '${fixture}';`), []);
  });

  it('a pragma ON the line still covers the whole line, and says why it may', () => {
    // Same-line placement covers the whole line, because the claim is visible on it.
    const line = `const A='${fixture}'; const B='${real}'; // prl-allow-secret: both are fixtures`;
    assert.deepEqual(detectors(line), []);
  });
});

describe('NEVER_TRACKED exempts templates, not environments (REGRESSION)', () => {
  // The old rule `/(^|\/)\.env\.(?!example$)[^/]+$/` exempted only `.env.example`, and returned true
  // for the first five paths below. Asserted against the pattern as the gate spells it.
  const ENV_RULE = /(^|\/)\.env\.(?!(?:[^/]*\.)?example$)(?!d\.ts$)[^/]+$/;

  it('lets a *.example template and a .d.ts declaration be tracked', () => {
    for (const path of ['.env.example', '.env.staging.example', '.env.local.example', '.env.d.ts']) {
      assert.equal(ENV_RULE.test(path), false, `${path} must not be blocked`);
    }
  });

  it('still blocks every file that actually holds environment values', () => {
    // These hold real values on somebody's disk, whatever the suffix suggests.
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
    // `SECRET_LITERAL` needs quotes and `SECRET_ENV_ASSIGNMENT` needs `=`, so this used to return [].
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
    // `authorization` is not credential-shaped. The scheme word is stripped before the value tests.
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
    // Repo-wide, this detector gave 62 false positives; on YAML and JSON only it gave 0.
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
    // Pins a doc claim, so it passes against the old code. All four clear every value test and
    // need a pragma. Dropping bare `key` would hide PRL_BACKUP_KEY.
    const firing = [
      "const CACHE_KEY = 'v3:profile:f4a9c1e8b27d3a6f9012cd45ef6789ab';", // prl-allow-secret: a hashed cache key fixture
      "const IDEMPOTENCY_KEY = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';", // prl-allow-secret: a hex idempotency fixture
      "const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';", // prl-allow-secret: a git SHA fixture
      "vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'", // prl-allow-secret: a PUBLIC VAPID key fixture
    ];
    for (const line of firing) {
      assert.deepEqual(detectors(line), ['secret-literal'], `the header claims this fires: ${line}`);
    }
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
    // `deploy/backup/backup.env` was matched by no ignore rule. Asks git, not .gitignore.
    const ignored = (path) => {
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
