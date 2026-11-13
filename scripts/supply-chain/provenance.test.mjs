#!/usr/bin/env node
/**
 * Tests for install hooks of versions not installed on this machine: 58 of 162 here, every Linux
 * binary on macOS, which the gate once passed over without naming. Fixture manifests, no network.
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
    // Platform binaries in this graph carry no `scripts` field on the registry.
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
    for (const entry of skipped) {
      assert.match(entry, /^@?[^@]+@\d/, `unexpected skipped entry shape: ${entry}`);
    }
  });

  it('accounts for every resolved version as either on disk or platform-skipped', () => {
    // 104 on disk plus 58 from the registry is 162, with nothing unexplained.
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
