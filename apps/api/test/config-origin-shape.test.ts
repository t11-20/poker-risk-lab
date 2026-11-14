/**
 * Host-shape validation for `PUBLIC_WEB_ORIGIN`. `isAllowedOrigin` matches exactly, so an accepted
 * wildcard matches nothing and every CORS request and socket is refused with no boot message. Cases
 * run against `normaliseOrigin` and through `loadConfig`, so the boot
 * path is proved to stop and name the variable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, type EnvRecord, loadConfig, normaliseOrigin } from '../src/config.ts';

const GOOD_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

function envWithOrigin(origin: string): EnvRecord {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: origin,
    SESSION_COOKIE_SECRET: GOOD_SECRET,
  };
}

function problemFor(origin: string): string | null {
  try {
    loadConfig(envWithOrigin(origin));
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.problems.join('\n');
  }
  return null;
}

describe('normaliseOrigin — host shape', () => {
  it('rejects a wildcard host, and says why it would never match', () => {
    const result = normaliseOrigin('https://*.example');
    assert.ok('problem' in result, 'a wildcard origin must not be accepted');
    assert.match(result.problem, /wildcard/);
    assert.match(result.problem, /matched exactly/);
  });

  it('rejects a bare wildcard and a wildcard in any label position', () => {
    for (const raw of [
      'https://*',
      'https://*.app.example',
      'https://app.*.example',
      'http://*.localhost:3000',
    ]) {
      const result = normaliseOrigin(raw);
      assert.ok('problem' in result, `${raw} must not be accepted`);
      assert.match(result.problem, /wildcard/);
    }
  });

  it('rejects a trailing dot, which is a second spelling that matches nothing', () => {
    const result = normaliseOrigin('https://app.example.');
    assert.ok('problem' in result, 'a trailing-dot host must not be accepted');
    assert.match(result.problem, /trailing dot/);
  });

  it('still accepts every legitimate host shape', () => {
    // A host-shape rule that rejects one of these is worse than the gap it closes.
    for (const [raw, expected] of [
      ['https://app.example', 'https://app.example'],
      ['http://localhost:3000', 'http://localhost:3000'],
      ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
      ['http://[::1]:3000', 'http://[::1]:3000'],
      ['https://sub.domain.app.example:8443', 'https://sub.domain.app.example:8443'],
    ] as const) {
      assert.deepEqual(normaliseOrigin(raw), { origin: expected }, `${raw} must be accepted`);
    }
  });
});

describe('loadConfig — a wildcard origin stops the boot', () => {
  it('refuses to load, and the problem names PUBLIC_WEB_ORIGIN', () => {
    const problems = problemFor('https://*.example');
    assert.ok(problems !== null, 'loadConfig must refuse a wildcard origin');
    assert.match(problems, /PUBLIC_WEB_ORIGIN/);
    assert.match(problems, /wildcard/);
  });

  it('refuses the whole list when only one entry carries a wildcard', () => {
    // One bad entry stops the boot, because a dropped entry is an origin the operator believes allowed.
    const problems = problemFor('https://app.example,https://*.example');
    assert.ok(problems !== null, 'one wildcard entry must reject the whole list');
    assert.match(problems, /wildcard/);
  });

  it('loads a list of ordinary origins unchanged', () => {
    const config = loadConfig(envWithOrigin('http://localhost:3000,http://127.0.0.1:3000'));
    assert.deepEqual([...config.webOrigins], ['http://localhost:3000', 'http://127.0.0.1:3000']);
  });
});
