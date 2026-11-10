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
 *
 * ## And why the refusal that fixed that could not fail either
 *
 * The repair moved the leak check off the finished environment and onto
 * `inheritedEnv()` — which filters `FORBIDDEN_PATTERNS` while building its
 * result, so the check asked a question it had already guaranteed the answer to.
 * The test below it asserted `leaked` was `[]` under the message "the allowlist
 * has grown a secret-shaped name", and passed when the allowlist had grown
 * exactly that. See the `describe('the refusals can fail')` block for the
 * negative control that established this and for what replaced it.
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
    // The exact regression: every one of these names matches /^NPM_/i, and the
    // leak check used to be applied to them.
    const deliberate = Object.keys(quarantineSettings(HOME));
    const flagged = deliberate.filter((name) => FORBIDDEN_PATTERNS.some((p) => p.test(name)));
    assert.deepEqual(
      flagged.sort(),
      ['NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_USERCONFIG', 'npm_config_ignore_scripts'].sort(),
      'fixture is stale: the hardening no longer contains the names that broke the check',
    );

    // …and neither of the checks the script actually runs objects to it.
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

// ---------------------------------------------------------------------------
// The two refusals, and the tautologies they used to be
//
// The defect: `main()` refused to run when
//
//     Object.keys(inheritedEnv()).filter((k) => FORBIDDEN_PATTERNS.some((p) => p.test(k)))
//
// was non-empty, under the comment "the check that matters". `inheritedEnv()`
// drops every name matching `FORBIDDEN_PATTERNS` while BUILDING its result, so
// that asked the same question of an already-filtered object and the branch was
// unreachable. The second refusal — anything in
// `{...inheritedEnv(), ...quarantineSettings(home)}` outside the allowlist and
// the settings — was unreachable for the same reason: the object is assembled
// from exactly those two sources.
//
// The test above was the third tautology. It asserted `leaked` was `[]` with the
// failure message "the allowlist has grown a secret-shaped name", and it passed
// when the allowlist HAD grown exactly such a name.
//
// Negative control, run before any change: `GITHUB_TOKEN`,
// `AWS_SECRET_ACCESS_KEY` and `NPM_TOKEN` set to real-looking values in the
// environment, then pushed onto `ENV_ALLOWLIST` to defeat the allowlist itself.
// `leaked = []`, `unexpected = []`, the old test's assertion PASSED, and the
// script ran on to `▸ resolving`. Nothing had leaked — `inheritedEnv` did the
// work — but neither refusal could ever fire, and one of them was documented as
// the point of the file.
//
// Same control against the current code, end to end with `NPM_TOKEN` on the
// allowlist: `✗ refusing to run: ENV_ALLOWLIST admits secret-shaped name(s):
// NPM_TOKEN`, exit 1, before a single manifest was copied.
// ---------------------------------------------------------------------------

describe('the refusals can fail', () => {
  it('REFUSES an allowlist that has grown a secret-shaped name', () => {
    // The negative control the old assertion could not be. The allowlist is
    // committed policy, so this is answerable without reading a single value.
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
    // `leakedNames` takes the environment rather than rebuilding it, which is the
    // whole difference: handed a leaky one it says so, instead of asking a
    // question whose answer it had already guaranteed.
    assert.deepEqual(
      leakedNames({ PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'y' }, HOME),
      ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY'],
    );
  });

  it('does not name the hardening this script sets itself as a leak', () => {
    // The original regression, restated against the function that now runs: all
    // three of these match /^NPM_/i and all three are set by this script.
    assert.deepEqual(leakedNames(quarantineSettings(HOME), HOME), []);
  });

  it('finds nothing to name in the environment the script actually builds', () => {
    // Live assertion. Structurally it cannot fail today — `scrubbedEnv` is an
    // allowlist-filtered inherit plus `quarantineSettings` — and it is kept as a
    // regression guard on that assembly, not offered as proof of anything. The
    // test above is what proves the function can fail.
    assert.deepEqual(leakedNames(scrubbedEnv(HOME), HOME), []);
  });

  it('drops a secret-shaped name even when the allowlist admits it', () => {
    // Defence in depth behind the refusal: `inheritedEnv` is where the security
    // property lives, and it holds regardless of what the allowlist says.
    const restore = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'ghp_realsecret';
    ENV_ALLOWLIST.push('GITHUB_TOKEN');
    try {
      assert.equal(inheritedEnv()['GITHUB_TOKEN'], undefined, 'an allowlisted secret survived the filter');
      assert.equal(scrubbedEnv(HOME)['GITHUB_TOKEN'], undefined);
      // …and the refusal fires, which is what the old check could not do.
      assert.deepEqual(forbiddenAllowlistEntries(), ['GITHUB_TOKEN']);
    } finally {
      ENV_ALLOWLIST.pop();
      if (restore === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = restore;
    }
  });
});
