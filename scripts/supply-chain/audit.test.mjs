#!/usr/bin/env node
/**
 * Tests for the audit aggregator. `--offline` once printed "NOT a valid release audit" and exited 0,
 * and `quarantine.mjs` read that 0 as success after running six of eight gates.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(HERE, 'audit.mjs');

describe('--offline', () => {
  it('never exits 0 when a gate did not run', () => {
    const res = spawnSync(process.execPath, [AUDIT, '--offline'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.notEqual(res.status, 0, `an audit with unrun gates reported success:\n${out}`);

    // 2 means incomplete and 1 means something failed. Which applies depends on this run.
    if (/✗ FAIL/.test(out)) {
      assert.equal(res.status, 1, `a failing gate must exit 1:\n${out}`);
    } else {
      assert.equal(res.status, 2, `an incomplete audit must exit 2:\n${out}`);
      assert.match(out, /network gate\(s\) skipped — NOT a valid release audit/);
      assert.match(out, /Exiting non-zero on purpose/);
    }
  });

  it('says which gates it skipped, by name', () => {
    const res = spawnSync(process.execPath, [AUDIT, '--offline'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    assert.match(out, /integrity \+ release age — skipped/);
    assert.match(out, /OSV vulnerabilities — skipped/);
  });
});

describe('gate inventory', () => {
  it('runs every gate script in the directory', () => {
    // Fails when a new *.mjs gate is added without being wired into the audit.
    const source = readFileSync(AUDIT, 'utf8');
    const wired = new Set([...source.matchAll(/file:\s*'([^']+\.mjs)'/g)].map((m) => m[1]));

    // Not gates: shared code, tests, the aggregator, and the quarantine tool, which resolves.
    const notGates = new Set([
      'audit.mjs',
      'lib.mjs',
      'denied-packages.mjs',
      'lockfile-integrity.mjs',
      'quarantine.mjs',
    ]);
    const onDisk = readdirSync(HERE)
      .filter((n) => n.endsWith('.mjs') && !n.endsWith('.test.mjs') && !notGates.has(n))
      .sort();

    assert.deepEqual(
      [...wired].sort(),
      onDisk,
      'the gate list in audit.mjs and the gate scripts on disk disagree',
    );
  });

  it('has a test for every gate, or names the gap out loud', () => {
    // A ratchet. A new untested gate fails, and so does closing a gap without shortening the list.
    const KNOWN_UNTESTED = ['repo-hygiene', 'osv-scan'];

    const source = readFileSync(AUDIT, 'utf8');
    const wired = [...source.matchAll(/file:\s*'([^']+)\.mjs'/g)].map((m) => m[1]);
    const tests = new Set(readdirSync(HERE).filter((n) => n.endsWith('.test.mjs')));
    const untested = wired.filter((name) => !tests.has(`${name}.test.mjs`)).sort();
    assert.deepEqual(
      untested,
      [...KNOWN_UNTESTED].sort(),
      'the set of untested gates changed: add the test, or update KNOWN_UNTESTED and say why',
    );
  });
});
