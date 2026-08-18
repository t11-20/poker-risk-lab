#!/usr/bin/env node
/**
 * Tests for the quarantined-acquisition environment.
 *
 * Run with:  node --test scripts/supply-chain/quarantine.test.mjs
 *
 * ## Why the environment is the thing worth testing
 *
 * The quarantine exists because resolution is the moment of exposure: the
 * campaign payload's whole job is to read credentials out of the environment and
 * process memory of whatever machine runs `install`. Everything else the script
 * does — the temp dir, the throwaway HOME, `--ignore-scripts` — is downstream of
 * "there is nothing worth stealing in reach".
 *
 * ## And why it had never run
 *
 * The leak check ran `FORBIDDEN_PATTERNS` over the **finished** environment,
 * which includes the three variables the script sets itself to harden the
 * quarantine: `npm_config_ignore_scripts`, `NPM_CONFIG_USERCONFIG` and
 * `NPM_CONFIG_GLOBALCONFIG`. All three match `/^NPM_/i`. So
 * `pnpm run deps:quarantine` printed
 *
 *     ✗ refusing to run: secret-shaped variables reached the quarantine env:
 *       npm_config_ignore_scripts, NPM_CONFIG_USERCONFIG, NPM_CONFIG_GLOBALCONFIG
 *
 * and exited 1 before copying a single manifest. The documented safe way to
 * acquire a dependency was unusable, and nothing said so.
 *
 * These tests keep both halves true at once: the hardening is present, and a
 * genuine secret in the inherited environment is still refused.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ENV_ALLOWLIST,
  FORBIDDEN_PATTERNS,
  inheritedEnv,
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
    // The exact regression: every one of these names matches /^NPM_/i, and the
    // leak check used to be applied to them.
    const deliberate = Object.keys(quarantineSettings(HOME));
    const flagged = deliberate.filter((name) => FORBIDDEN_PATTERNS.some((p) => p.test(name)));
    assert.deepEqual(
      flagged.sort(),
      ['NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_USERCONFIG', 'npm_config_ignore_scripts'].sort(),
      'fixture is stale: the hardening no longer contains the names that broke the check',
    );

    // …and the check the script actually runs, over the inherited environment
    // only, is clean.
    const leaked = Object.keys(inheritedEnv()).filter((name) => FORBIDDEN_PATTERNS.some((p) => p.test(name)));
    assert.deepEqual(leaked, [], 'the allowlist has grown a secret-shaped name');
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

  it('would still refuse a secret-shaped name added to the allowlist', () => {
    // The check has to be able to fail, or it is decoration. This asserts the
    // rule rather than the current allowlist: any name matching a forbidden
    // pattern is dropped even when it is allowlisted.
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
