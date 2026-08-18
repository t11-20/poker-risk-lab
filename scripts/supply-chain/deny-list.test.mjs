#!/usr/bin/env node
/**
 * Tests for the `deny-list` gate.
 *
 * Run with:  node --test scripts/supply-chain/deny-list.test.mjs
 *
 * Two things need proving about a blocklist whose entries cannot occur in the
 * current graph: that it would fire if one did, and that its on-disk half is not
 * quietly reporting a clean store when there is no store. The second was real —
 * the gate printed `installed store: 0 package versions on disk` and passed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DENIED_NAMES, DENIED_SCOPES, denyReason } from './denied-packages.mjs';
import { checkInstalledStore, checkResolvedGraph } from './deny-list.mjs';
import { Gate } from './lib.mjs';

function failureText(gate) {
  return gate.failures.map((f) => `${f.message} ${f.detail ?? ''}`).join('\n');
}

describe('denied names and scopes', () => {
  it('FAILS on a denied package reached transitively', () => {
    const gate = new Gate('t');
    checkResolvedGraph(
      gate,
      new Map([
        ['fastify@5.11.3', { name: 'fastify', importers: new Set(['@prl/api']) }],
        ['keyv@5.7.0', { name: 'keyv', importers: new Set(['@prl/api']) }],
      ]),
    );
    assert.equal(gate.failures.length, 1);
    assert.match(failureText(gate), /denied package in resolved graph: keyv@5\.7\.0/);
    assert.match(failureText(gate), /reached from: @prl\/api/);
  });

  it('FAILS on any member of a denied scope, at any version', () => {
    for (const name of ['@antv/g2', '@cacheable/node-cache', '@tanstack/react-query']) {
      const gate = new Gate('t');
      checkResolvedGraph(gate, new Map([[`${name}@1.2.3`, { name, importers: new Set(['@prl/web']) }]]));
      assert.equal(gate.failures.length, 1, `${name} was not denied`);
    }
  });

  it('FAILS on a denied package that is on disk but somehow absent from the graph', () => {
    const gate = new Gate('t');
    checkInstalledStore(
      gate,
      new Map([['keyv@5.7.0', { manifest: { name: 'keyv' }, manifestPath: '/x/package.json', dir: '/x' }]]),
    );
    assert.match(failureText(gate), /denied package on disk: keyv@5\.7\.0/);
  });

  it('FAILS on an unparseable package.json in the store', () => {
    const gate = new Gate('t');
    checkInstalledStore(
      gate,
      new Map([
        ['UNPARSEABLE:/x/package.json', { manifest: null, manifestPath: '/x/package.json', dir: '/x' }],
      ]),
    );
    assert.match(failureText(gate), /unparseable package\.json in the installed store/);
  });

  it('lets an ordinary package through, so the list is not matching everything', () => {
    const gate = new Gate('t');
    checkResolvedGraph(
      gate,
      new Map([['fastify@5.11.3', { name: 'fastify', importers: new Set(['@prl/api']) }]]),
    );
    assert.deepEqual(gate.failures, []);
  });
});

describe("coverage of the campaign named in the repository's own sources", () => {
  it('denies every ecosystem the advisory snapshot names', () => {
    // docs/security/shai-hulud-snapshot-2026-08-17.md §1 records Expel and Arctic
    // Wolf on "TanStack, Mistral AI, OpenSearch ecosystems" and Snyk on TanStack.
    // All three were missing from DENIED_SCOPES while the file cited the sources.
    for (const scope of ['@antv/', '@tanstack/', '@mistralai/', '@opensearch-project/', '@cacheable/']) {
      assert.ok(DENIED_SCOPES.has(scope), `${scope} is named in the cited sources but not denied`);
    }
    for (const name of ['keyv', 'echarts-for-react', 'size-sensor', 'timeago.js', 'jest-canvas-mock']) {
      assert.ok(DENIED_NAMES.has(name), `${name} is named in the snapshot but not denied`);
    }
  });

  it('records a reason for every entry, so a future maintainer can judge an unblock', () => {
    for (const [name, reason] of DENIED_NAMES) {
      assert.ok(typeof reason === 'string' && reason.length > 10, `${name} has no usable reason`);
    }
    for (const [scope, reason] of DENIED_SCOPES) {
      assert.ok(typeof reason === 'string' && reason.length > 10, `${scope} has no usable reason`);
    }
  });

  it('does not deny anything this repository actually depends on', () => {
    // A guardrail against a scope being added carelessly: if this ever fails, the
    // dependency has to go, not the deny-list entry.
    for (const name of ['fastify', 'react', 'next', 'typescript', 'postgres', 'toad-cache']) {
      assert.equal(denyReason(name), null, `${name} is a real dependency and must not be denied`);
    }
  });
});
