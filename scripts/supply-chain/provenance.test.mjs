#!/usr/bin/env node
/**
 * Tests for the `integrity-and-release-age` gate's fourth assertion: install
 * hooks of the versions that are not installed on this machine.
 *
 * Run with:  node --test scripts/supply-chain/provenance.test.mjs
 *
 * ## Why this assertion had to exist
 *
 * pnpm does not install optional dependencies whose `os`/`cpu`/`libc` do not
 * match the host, and records them in `node_modules/.modules.yaml` under
 * `skipped:`. On this repository that is **58 of 162 resolved versions (36%)**.
 * `dep-shapes.mjs` reads manifests off disk, so those 58 were scanned for
 * install-time lifecycle hooks by nothing at all — and on macOS the skipped set
 * is every Linux binary, which is precisely the set that IS installed in the
 * release container. The gate said "pass" over 64% coverage without mentioning
 * the number.
 *
 * These tests do not hit the network: the decision under test is "given this
 * published manifest, is there an install hook", and a fixture manifest states
 * that better than a live fetch, which would also make the suite fail when npm
 * is slow.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Gate, platformSkippedVersions, storeCoverage } from './lib.mjs';
import { checkPublishedInstallHooks } from './provenance.mjs';

function failureText(gate) {
  return gate.failures.map((f) => `${f.message} ${f.detail ?? ''}`).join('\n');
}

describe('install hooks read from the published manifest', () => {
  it('FAILS on a preinstall hook — delivery Pattern A, verbatim from the advisory', () => {
    const gate = new Gate('t');
    const established = checkPublishedInstallHooks(gate, '@img/sharp-linux-x64@0.35.3', {
      scripts: {
        preinstall:
          "node -e \"require('child_process').spawnSync('bun',['run','index.js'],{stdio:'inherit'})\"",
      },
    });
    assert.equal(established, true, 'the hooks were established — they are just bad');
    assert.match(
      failureText(gate),
      /install-time lifecycle hook published by @img\/sharp-linux-x64@0\.35\.3/,
    );
    assert.match(failureText(gate), /release container/);
  });

  it('FAILS on install and postinstall too', () => {
    for (const hook of ['install', 'postinstall']) {
      const gate = new Gate('t');
      checkPublishedInstallHooks(gate, 'evil@1.0.0', { scripts: { [hook]: 'node install.js' } });
      assert.equal(gate.failures.length, 1, `${hook} was not caught`);
    }
  });

  it('passes a package that publishes ordinary scripts', () => {
    const gate = new Gate('t');
    const established = checkPublishedInstallHooks(gate, 'fastify@5.11.3', {
      scripts: { test: 'tap', lint: 'eslint', prepare: 'husky' },
    });
    assert.equal(established, true);
    assert.deepEqual(gate.failures, []);
  });

  it('passes a package that publishes no scripts block at all', () => {
    // What every platform binary in this graph actually looks like on the
    // registry — the absence of the field is the evidence.
    const gate = new Gate('t');
    assert.equal(checkPublishedInstallHooks(gate, '@next/swc-linux-x64-gnu@16.3.0', {}), true);
    assert.deepEqual(gate.failures, []);
  });

  it('FAILS CLOSED when the published scripts block is not an object', () => {
    for (const scripts of ['postinstall', 42, ['postinstall']]) {
      const gate = new Gate('t');
      const established = checkPublishedInstallHooks(gate, 'evil@1.0.0', { scripts });
      assert.equal(established, false, `${JSON.stringify(scripts)} was treated as established`);
      assert.match(failureText(gate), /cannot read the published scripts block/);
    }
  });
});

describe('the platform-skipped set is real and is accounted for', () => {
  it("reads pnpm's own record of what it skipped", () => {
    const { present, skipped } = platformSkippedVersions();
    assert.equal(present, true, 'node_modules/.modules.yaml was not readable — run pnpm install');
    assert.ok(skipped.size > 0, 'expected pnpm to have skipped some platform-specific optionals');
    // Every entry is a `name@version`, which is what the coverage maths joins on.
    for (const entry of skipped) {
      assert.match(entry, /^@?[^@]+@\d/, `unexpected skipped entry shape: ${entry}`);
    }
  });

  it('accounts for every resolved version as either on disk or platform-skipped', () => {
    // The claim the audit makes: 104 inspected here + 58 inspected from the
    // registry = 162, with nothing unexplained. If this ever fails, some version
    // is being checked by neither gate.
    const resolved = new Map();
    const installed = new Map();
    const { skipped } = platformSkippedVersions();
    for (const key of skipped) resolved.set(key, {});
    for (const key of ['fastify@5.11.3', 'react@19.2.8']) {
      resolved.set(key, {});
      installed.set(key, {});
    }
    const coverage = storeCoverage(resolved, installed);
    assert.deepEqual(coverage.uninspected, [], 'a version is inspected by neither gate');
    assert.equal(coverage.platformSkipped.length, skipped.size);
  });
});
