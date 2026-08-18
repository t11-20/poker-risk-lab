#!/usr/bin/env node
/**
 * Tests for the audit aggregator.
 *
 * Run with:  node --test scripts/supply-chain/audit.test.mjs
 *
 * ## The defect
 *
 * `node scripts/supply-chain/audit.mjs --offline` printed "2 network gate(s)
 * skipped — NOT a valid release audit." and then **exited 0**. The honest
 * sentence went to the human; the number went to every script. `quarantine.mjs`
 * read that number and reported success after checking a freshly resolved
 * lockfile with six of eight gates — three of which, on a machine that had not
 * installed yet, were additionally inspecting an empty store.
 *
 * Neither workflow uses `--offline`, so this was never a live release bypass. It
 * was a footgun waiting for somebody to wire the offline mode into a pre-commit
 * hook or a firewalled runner and read the exit code, which is exactly the sort
 * of thing that gets wired up on a Friday.
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

    // 2 means "incomplete", 1 means "something failed" — a caller can tell them
    // apart, and both are non-zero. Which one applies depends on whether a gate
    // failed in this particular run, so the assertion branches rather than
    // pinning a number that a real failure would legitimately change.
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
    // A gate nobody runs is worse than no gate: it looks like coverage in a
    // directory listing. This fails the moment a new *.mjs gate is added without
    // being wired into the audit.
    const source = readFileSync(AUDIT, 'utf8');
    const wired = new Set([...source.matchAll(/file:\s*'([^']+\.mjs)'/g)].map((m) => m[1]));

    // Everything in the directory that is not a gate: shared code, the test
    // files, the aggregator itself, and the quarantine tool (which is a workflow,
    // not a gate — it is run by hand and it resolves rather than judges).
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
    // The release audit found 1 of 8 gates tested, and the three defects it found
    // in the other seven were all found by writing the negative control that did
    // not exist. This is a ratchet, not a pass/fail: a NEW untested gate fails
    // here, and so does closing one of the gaps below without shortening the
    // list. Either way the number in this file has to match reality.
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
