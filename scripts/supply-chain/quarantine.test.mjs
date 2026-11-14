#!/usr/bin/env node
/**
 * Tests for the quarantine environment. They keep two things true together: the script's own
 * `NPM_CONFIG_*` hardening (which matches `/^NPM_/i` and would stop every run) is present, and a
 * real secret in the inherited environment is still refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENV_ALLOWLIST,
  FORBIDDEN_PATTERNS,
  forbiddenAllowlistEntries,
  inheritedEnv,
  leakedNames,
  quarantineSettings,
  scrubbedEnv,
} from './quarantine.mjs';

const HOME = '/tmp/prl-quarantine-fixture/home';

describe('the quarantine environment', () => {
  it('carries the hardening the quarantine depends on', () => {
    const env = scrubbedEnv(HOME);
    assert.equal(env['npm_config_ignore_scripts'], 'true', 'lifecycle scripts must be off');
    assert.equal(env['HOME'], HOME, 'the throwaway HOME must be in effect');
    assert.equal(env['NPM_CONFIG_USERCONFIG'], `${HOME}/.npmrc`);
    assert.equal(env['NPM_CONFIG_GLOBALCONFIG'], `${HOME}/.npmrc-global`);
    assert.equal(env['CI'], 'true');
  });

  it('does not refuse to run because of its own hardening', () => {
    // Each name matches /^NPM_/i, so the leak check must not be applied to them.
    const deliberate = Object.keys(quarantineSettings(HOME));
    const flagged = deliberate.filter((name) => FORBIDDEN_PATTERNS.some((p) => p.test(name)));
    assert.deepEqual(
      flagged.sort(),
      ['NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_USERCONFIG', 'npm_config_ignore_scripts'].sort(),
      'fixture is stale: the hardening no longer contains the names that broke the check',
    );

    assert.deepEqual(forbiddenAllowlistEntries(), []);
    assert.deepEqual(leakedNames(scrubbedEnv(HOME), HOME), []);
  });

  it('inherits nothing but the allowlist', () => {
    const inherited = Object.keys(inheritedEnv());
    for (const name of inherited) {
      assert.ok(ENV_ALLOWLIST.includes(name), `${name} reached the quarantine without being allowlisted`);
    }
  });

  it('drops every secret-shaped variable in the real environment', () => {
    // Whatever this machine happens to export, none of it may survive.
    const env = scrubbedEnv(HOME);
    const deliberate = new Set(Object.keys(quarantineSettings(HOME)));
    for (const name of Object.keys(process.env)) {
      if (!FORBIDDEN_PATTERNS.some((p) => p.test(name))) continue;
      if (deliberate.has(name)) continue;
      assert.equal(env[name], undefined, `${name} survived into the quarantine`);
    }
  });

  it('recognises the shapes a real credential comes in', () => {
    for (const name of [
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'NPM_TOKEN',
      'VAULT_ADDR',
      'OP_SERVICE_KEY',
    ]) {
      assert.ok(
        FORBIDDEN_PATTERNS.some((p) => p.test(name)),
        `${name} is not recognised as secret-shaped`,
      );
    }
  });
});

// The old refusals ran over `inheritedEnv()` output, which had already dropped every forbidden name,
// so neither could fire. With `NPM_TOKEN` on the allowlist the current code stops with exit 1.

describe('the refusals can fail', () => {
  it('REFUSES an allowlist that has grown a secret-shaped name', () => {
    for (const name of ['NPM_TOKEN', 'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DEPLOY_PASSWORD']) {
      assert.deepEqual(
        forbiddenAllowlistEntries([...ENV_ALLOWLIST, name]),
        [name],
        `${name} on the allowlist did not stop the run`,
      );
    }
  });

  it('accepts the allowlist as committed', () => {
    assert.deepEqual(
      forbiddenAllowlistEntries(),
      [],
      'ENV_ALLOWLIST names something secret-shaped; `pnpm run deps:quarantine` now refuses to run',
    );
  });

  it('NAMES a secret that reaches a finished quarantine environment', () => {
    // Takes the environment rather than rebuilding it, so a leaky one is reported.
    assert.deepEqual(
      leakedNames({ PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'y' }, HOME),
      ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
    );
  });

  it('does not name the hardening this script sets itself as a leak', () => {
    assert.deepEqual(leakedNames(quarantineSettings(HOME), HOME), []);
  });

  it('finds nothing to name in the environment the script actually builds', () => {
    // Cannot fail today. A regression guard on how `scrubbedEnv` is assembled.
    assert.deepEqual(leakedNames(scrubbedEnv(HOME), HOME), []);
  });

  it('drops a secret-shaped name even when the allowlist admits it', () => {
    // `inheritedEnv` holds regardless of what the allowlist says.
    const restore = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'ghp_realsecret';
    ENV_ALLOWLIST.push('GITHUB_TOKEN');
    try {
      assert.equal(inheritedEnv()['GITHUB_TOKEN'], undefined, 'an allowlisted secret survived the filter');
      assert.equal(scrubbedEnv(HOME)['GITHUB_TOKEN'], undefined);
      assert.deepEqual(forbiddenAllowlistEntries(), ['GITHUB_TOKEN']);
    } finally {
      ENV_ALLOWLIST.pop();
      if (restore === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = restore;
    }
  });
});
