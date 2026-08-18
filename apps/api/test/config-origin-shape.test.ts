/**
 * Host-shape validation for `PUBLIC_WEB_ORIGIN`.
 *
 * `config.test.ts` already covers the parts of `normaliseOrigin` that were there from the start:
 * scheme, credentials, query, fragment, path, case folding. This file covers the host itself,
 * which was not checked at all — a wildcard entry was accepted and the server started with
 * `https://*.example` in its allowlist, while `.env.example` promised that exactly that value was
 * "rejected at boot".
 *
 * Why a silently-accepted wildcard is worth a test rather than a shrug: matching is exact
 * (`isAllowedOrigin` in `plugins/security.ts`), so the entry matches nothing and the system fails
 * closed — but the operator's symptom is "every CORS request refused, every socket closed 4406"
 * with nothing in the boot output pointing at the cause. The failure mode of a validator is not
 * "it let something dangerous through", it is "it let something USELESS through while a document
 * said it would not".
 *
 * These cases are written against `normaliseOrigin` directly AND through `loadConfig`, because the
 * two answer different questions: the first is "does the rule exist", the second is "does a boot
 * actually stop, naming the variable". A rule that exists and is not reached by the boot path is
 * the same as no rule.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, type EnvRecord, loadConfig, normaliseOrigin } from '../src/config.ts';

/** A long, high-entropy value that passes the production secret rules. */
const GOOD_SECRET = 'Zk7pQ2vR9tX4bN6mL1sD8gH3jF5wC0yA';

function envWithOrigin(origin: string): EnvRecord {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://poker:poker@127.0.0.1:5432/poker_risk_lab',
    PUBLIC_WEB_ORIGIN: origin,
    SESSION_COOKIE_SECRET: GOOD_SECRET,
  };
}

/** The problem text for a rejected origin, or `null` when it was accepted. */
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
    // The message has to tell the operator what to do instead. "Invalid origin" would leave
    // them re-reading the same line of .env.
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
    // Each of these must survive: a plain name, an explicit port, an IPv4 literal, an IPv6
    // literal, and a single-label development host. A host-shape rule that rejects one of them
    // is worse than the gap it closes.
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
    // The dangerous shape is a list that looks fine at a glance. One bad entry must stop the
    // boot rather than being dropped, because a silently-dropped entry is an origin the
    // operator believes is allowed.
    const problems = problemFor('https://app.example,https://*.example');
    assert.ok(problems !== null, 'one wildcard entry must reject the whole list');
    assert.match(problems, /wildcard/);
  });

  it('loads a list of ordinary origins unchanged', () => {
    const config = loadConfig(envWithOrigin('http://localhost:3000,http://127.0.0.1:3000'));
    assert.deepEqual([...config.webOrigins], ['http://localhost:3000', 'http://127.0.0.1:3000']);
  });
});
