/**
 * Configuration tests.
 *
 * These are the tests that decide whether a bad deployment starts. They are written against
 * `loadConfig(env)` rather than `process.env` on purpose — a pure function of an environment
 * record is the only way to assert "production refuses this" without setting NODE_ENV inside
 * a test runner and hoping nothing else notices.
 *
 * Two things every case checks: that a bad value is rejected, and that the *message* names
 * the variable. A boot failure that says "invalid configuration" and nothing else costs the
 * next person an hour.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, type EnvRecord, loadConfig, normaliseOrigin } from '../src/config.ts';

/** A long, high-entropy value that passes the production secret rules. */
const GOOD_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

function baseEnv(overrides: EnvRecord = {}): EnvRecord {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    SESSION_COOKIE_SECRET: GOOD_SECRET,
    ...overrides,
  };
}

function productionEnv(overrides: EnvRecord = {}): EnvRecord {
  return baseEnv({
    NODE_ENV: 'production',
    PUBLIC_WEB_ORIGIN: 'https://app.example.test',
    ...overrides,
  });
}

/** Asserts that loading fails and that at least one problem mentions `needle`. */
function expectProblem(env: EnvRecord, needle: string): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    const matched = error.problems.some((problem) => problem.includes(needle));
    assert.ok(
      matched,
      `no problem mentioned "${needle}". Problems were:\n${error.problems.map((p) => `  - ${p}`).join('\n')}`,
    );
    return error.problems;
  }
  assert.fail(`expected loadConfig to reject, mentioning "${needle}"`);
}

describe('loadConfig — a valid environment', () => {
  it('parses and freezes a minimal valid environment', () => {
    const config = loadConfig(baseEnv());

    assert.equal(config.nodeEnv, 'test');
    assert.equal(config.isTest, true);
    assert.equal(config.isProduction, false);
    // 3001, not 8080. The fallback was changed deliberately: .env.example, docker-compose.yml,
    // the README, the runbook and apps/web/src/lib/api.ts all said 3001, while only this fallback
    // said 8080 — so following the documented dev flow started the API on 8080 while the browser
    // called 3001, and every request from the web app failed with nothing explaining why.
    assert.equal(config.port, 3001);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.logLevel, 'silent');
    assert.deepEqual(config.webOrigins, ['http://localhost:3000']);
    assert.equal(config.oidcEnabled, false);
    assert.equal(config.oidc, null);
    assert.equal(config.cookieSecure, false);
    assert.equal(config.trustProxy, false);
    assert.equal(config.warnings.length, 0);

    assert.ok(Object.isFrozen(config), 'config must be frozen');
    assert.ok(Object.isFrozen(config.rateLimit), 'rateLimit must be frozen');
    assert.ok(Object.isFrozen(config.database), 'database must be frozen');
  });

  it('reads every documented knob', () => {
    const config = loadConfig(
      baseEnv({
        PORT: '9001',
        HOST: '0.0.0.0',
        LOG_LEVEL: 'debug',
        PUBLIC_WEB_ORIGIN: 'http://localhost:3000, https://app.example.test',
        DATABASE_POOL_MAX: '25',
        DATABASE_STATEMENT_TIMEOUT_MS: '2500',
        DATABASE_IDLE_TIMEOUT_SECONDS: '15',
        DATABASE_CONNECT_TIMEOUT_SECONDS: '5',
        MONTE_CARLO_MAX_SAMPLES: '50000',
        MONTE_CARLO_WORKERS: '2',
        COACH_TIMEOUT_MS: '1500',
        RATE_LIMIT_MAX: '120',
        RATE_LIMIT_WINDOW_MS: '30000',
        RATE_LIMIT_EXPENSIVE_MAX: '5',
        RATE_LIMIT_EXPENSIVE_WINDOW_MS: '15000',
        RATE_LIMIT_BAN_AFTER: '0',
        BODY_LIMIT_BYTES: '32768',
        REQUEST_TIMEOUT_MS: '9000',
        SHUTDOWN_GRACE_MS: '2000',
      }),
    );

    assert.equal(config.port, 9001);
    assert.equal(config.host, '0.0.0.0');
    assert.equal(config.logLevel, 'debug');
    assert.deepEqual(config.webOrigins, ['http://localhost:3000', 'https://app.example.test']);
    assert.equal(config.database.poolMax, 25);
    assert.equal(config.database.statementTimeoutMs, 2500);
    assert.equal(config.database.idleTimeoutSeconds, 15);
    assert.equal(config.database.connectTimeoutSeconds, 5);
    assert.equal(config.monteCarloMaxSamples, 50_000);
    assert.equal(config.monteCarloWorkers, 2);
    assert.equal(config.coachTimeoutMs, 1500);
    assert.equal(config.rateLimit.globalMax, 120);
    assert.equal(config.rateLimit.globalWindowMs, 30_000);
    assert.equal(config.rateLimit.expensiveMax, 5);
    assert.equal(config.rateLimit.expensiveWindowMs, 15_000);
    assert.equal(config.rateLimit.banAfter, 0);
    assert.equal(config.bodyLimitBytes, 32_768);
    assert.equal(config.requestTimeoutMs, 9_000);
    assert.equal(config.shutdownGraceMs, 2_000);
  });

  it('deduplicates and lowercases origins, and drops empty entries', () => {
    const config = loadConfig(
      baseEnv({ PUBLIC_WEB_ORIGIN: 'HTTPS://App.Example.Test , https://app.example.test, ,' }),
    );
    assert.deepEqual(config.webOrigins, ['https://app.example.test']);
  });
});

describe('loadConfig — invalid values are named', () => {
  it('rejects an unknown NODE_ENV', () => {
    expectProblem(baseEnv({ NODE_ENV: 'staging' }), 'NODE_ENV');
  });

  it('rejects a non-integer PORT rather than parsing a prefix of it', () => {
    // parseInt('8080abc') would be 8080. Number() is NaN, which is the point.
    const problems = expectProblem(baseEnv({ PORT: '8080abc' }), 'PORT');
    assert.ok(
      problems.some((p) => p.includes('8080abc')),
      'the message should quote the bad value',
    );
  });

  it('rejects an out-of-range PORT', () => {
    expectProblem(baseEnv({ PORT: '70000' }), 'PORT');
  });

  it('rejects a non-boolean TRUST_PROXY', () => {
    expectProblem(baseEnv({ TRUST_PROXY: 'maybe' }), 'TRUST_PROXY');
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expectProblem(baseEnv({ LOG_LEVEL: 'chatty' }), 'LOG_LEVEL');
  });

  it('requires DATABASE_URL', () => {
    const env = baseEnv();
    const withoutUrl: EnvRecord = { ...env, DATABASE_URL: undefined };
    expectProblem(withoutUrl, 'DATABASE_URL');
  });

  it('rejects a DATABASE_URL that is not a postgres URL', () => {
    expectProblem(baseEnv({ DATABASE_URL: 'mysql://localhost/db' }), 'DATABASE_URL');
  });

  it('rejects an origin with a path, and says which path to drop', () => {
    const problems = expectProblem(
      baseEnv({ PUBLIC_WEB_ORIGIN: 'https://app.example.test/api' }),
      'PUBLIC_WEB_ORIGIN',
    );
    assert.ok(
      problems.some((p) => p.includes('/api')),
      'the message should name the offending path',
    );
  });

  it('rejects an origin with credentials, a query or a non-http scheme', () => {
    expectProblem(baseEnv({ PUBLIC_WEB_ORIGIN: 'https://user:pass@app.example.test' }), 'credentials');
    expectProblem(baseEnv({ PUBLIC_WEB_ORIGIN: 'https://app.example.test?x=1' }), 'query string');
    expectProblem(baseEnv({ PUBLIC_WEB_ORIGIN: 'ftp://app.example.test' }), 'http or https');
    expectProblem(baseEnv({ PUBLIC_WEB_ORIGIN: 'not-a-url' }), 'not a URL');
  });

  it('reports every problem at once rather than the first', () => {
    const problems = expectProblem(
      baseEnv({ NODE_ENV: 'staging', PORT: 'nope', LOG_LEVEL: 'chatty', DATABASE_URL: 'mysql://x/y' }),
      'NODE_ENV',
    );
    assert.ok(problems.length >= 4, `expected at least 4 problems, got ${problems.length}`);
    assert.equal(problems.filter((p) => p.includes('PORT')).length, 1);
    assert.equal(problems.filter((p) => p.includes('LOG_LEVEL')).length, 1);
    assert.equal(problems.filter((p) => p.includes('DATABASE_URL')).length, 1);
  });

  it("puts every problem in the error's message, so a boot log is self-explanatory", () => {
    try {
      loadConfig(baseEnv({ PORT: 'nope', LOG_LEVEL: 'chatty' }));
      assert.fail('expected a ConfigError');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /PORT/);
      assert.match(error.message, /LOG_LEVEL/);
      assert.match(error.message, /2 configuration problems/);
    }
  });
});

describe('loadConfig — the session cookie secret', () => {
  it('allows a short secret outside production, with a warning', () => {
    const config = loadConfig(baseEnv({ SESSION_COOKIE_SECRET: 'short' }));
    assert.equal(config.sessionCookieSecret, 'short');
    assert.ok(
      config.warnings.some((warning) => warning.includes('SESSION_COOKIE_SECRET')),
      'a short secret outside production should warn',
    );
  });

  it('rejects a short secret in production', () => {
    expectProblem(productionEnv({ SESSION_COOKIE_SECRET: 'short' }), 'SESSION_COOKIE_SECRET');
  });

  it('rejects a long but low-entropy secret in production', () => {
    const problems = expectProblem(
      productionEnv({ SESSION_COOKIE_SECRET: 'ab'.repeat(32) }),
      'distinct characters',
    );
    assert.ok(problems.length >= 1);
  });

  it('rejects a placeholder secret in production even when it is long enough', () => {
    expectProblem(
      productionEnv({ SESSION_COOKIE_SECRET: 'replace-me-this-example-value-is-rejected' }),
      'placeholder',
    );
  });

  it('rejects the value shipped in .env.example', () => {
    // If this ever stops failing, the example file has become a working production secret.
    expectProblem(
      productionEnv({ SESSION_COOKIE_SECRET: 'replace-me-this-example-value-is-rejected-in-production' }),
      'SESSION_COOKIE_SECRET',
    );
  });

  it('requires the secret in production', () => {
    const env: EnvRecord = { ...productionEnv(), SESSION_COOKIE_SECRET: undefined };
    const problems = expectProblem(env, 'SESSION_COOKIE_SECRET');
    assert.ok(
      problems.some((problem) => problem.includes('randomBytes')),
      'the message should show how to generate one',
    );
  });

  it('invents a random per-process secret outside production, and says so', () => {
    const env: EnvRecord = { ...baseEnv(), SESSION_COOKIE_SECRET: undefined };
    const first = loadConfig(env);
    const second = loadConfig(env);
    assert.ok(first.sessionCookieSecret.length >= 32);
    assert.notEqual(first.sessionCookieSecret, second.sessionCookieSecret);
    assert.ok(first.warnings.some((warning) => warning.includes('random per-process secret')));
  });

  it('accepts a good secret in production', () => {
    const config = loadConfig(productionEnv());
    assert.equal(config.sessionCookieSecret, GOOD_SECRET);
    assert.equal(config.isProduction, true);
    assert.equal(config.cookieSecure, true);
  });
});

describe('loadConfig — production-only refusals', () => {
  it('refuses to start when cookies cannot be Secure', () => {
    expectProblem(productionEnv({ COOKIE_SECURE: 'false' }), 'COOKIE_SECURE');
  });

  it('refuses a plaintext http origin in production', () => {
    const problems = expectProblem(
      productionEnv({ PUBLIC_WEB_ORIGIN: 'http://app.example.test' }),
      'plaintext http',
    );
    assert.ok(problems.some((p) => p.includes('Secure session cookie')));
  });

  it('requires PUBLIC_WEB_ORIGIN in production', () => {
    const env: EnvRecord = { ...productionEnv(), PUBLIC_WEB_ORIGIN: undefined };
    expectProblem(env, 'PUBLIC_WEB_ORIGIN');
  });

  it('falls back to localhost outside production, with a warning', () => {
    const env: EnvRecord = { ...baseEnv(), PUBLIC_WEB_ORIGIN: undefined };
    const config = loadConfig(env);
    assert.deepEqual(config.webOrigins, ['http://localhost:3000']);
    assert.ok(config.warnings.some((warning) => warning.includes('PUBLIC_WEB_ORIGIN')));
  });
});

describe('loadConfig — OIDC is all or nothing', () => {
  it('is disabled when no OIDC variable is set', () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.oidcEnabled, false);
    assert.equal(config.oidc, null);
  });

  it('is enabled, with every field, when all four are set', () => {
    const config = loadConfig(
      baseEnv({
        OIDC_ISSUER: 'https://accounts.example.test',
        OIDC_CLIENT_ID: 'poker-risk-lab',
        OIDC_CLIENT_SECRET: 'not-a-real-secret',
        OIDC_REDIRECT_URI: 'http://localhost:8080/api/v1/auth/oidc/callback',
      }),
    );
    assert.equal(config.oidcEnabled, true);
    assert.deepEqual(config.oidc, {
      issuer: 'https://accounts.example.test',
      clientId: 'poker-risk-lab',
      clientSecret: 'not-a-real-secret',
      redirectUri: 'http://localhost:8080/api/v1/auth/oidc/callback',
    });
  });

  it('rejects a partial OIDC configuration and names what is missing', () => {
    const problems = expectProblem(
      baseEnv({ OIDC_ISSUER: 'https://accounts.example.test', OIDC_CLIENT_ID: 'poker-risk-lab' }),
      'OIDC is partially configured',
    );
    const joined = problems.join(' ');
    assert.match(joined, /OIDC_CLIENT_SECRET/);
    assert.match(joined, /OIDC_REDIRECT_URI/);
  });

  it('rejects a single OIDC variable on its own', () => {
    expectProblem(baseEnv({ OIDC_CLIENT_SECRET: 'lonely' }), 'OIDC is partially configured');
  });

  it('requires https for the issuer and the redirect, localhost excepted', () => {
    expectProblem(
      baseEnv({
        OIDC_ISSUER: 'http://accounts.example.test',
        OIDC_CLIENT_ID: 'id',
        OIDC_CLIENT_SECRET: 'sh',
        OIDC_REDIRECT_URI: 'https://app.example.test/cb',
      }),
      'OIDC_ISSUER must use https',
    );
  });
});

describe('loadConfig — TRUST_PROXY warns about what it does', () => {
  it('warns when enabled, because it makes the client address forgeable', () => {
    const config = loadConfig(baseEnv({ TRUST_PROXY: 'true' }));
    assert.equal(config.trustProxy, true);
    assert.ok(config.warnings.some((warning) => warning.includes('X-Forwarded-For')));
  });
});

describe('normaliseOrigin', () => {
  it('keeps the port and drops a trailing slash', () => {
    assert.deepEqual(normaliseOrigin('http://localhost:3000/'), { origin: 'http://localhost:3000' });
    assert.deepEqual(normaliseOrigin('https://app.example.test'), { origin: 'https://app.example.test' });
  });

  it('lowercases the host', () => {
    assert.deepEqual(normaliseOrigin('HTTPS://App.Example.Test'), { origin: 'https://app.example.test' });
  });

  it('reports a problem instead of throwing', () => {
    const result = normaliseOrigin('::::');
    assert.ok('problem' in result);
  });
});
