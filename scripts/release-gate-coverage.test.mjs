#!/usr/bin/env node
/**
 * Tests for the release-gate coverage guard.
 *
 * Run with:  node --test scripts/release-gate-coverage.test.mjs
 *
 * The guard's own failure mode is the one it exists to catch: a parser that reads
 * a workflow it does not understand, finds no jobs, and reports that every gate is
 * covered by the empty set. So the controls below are about the PARSER as much as
 * the verdict — each one takes a real workflow and breaks exactly one thing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ARTEFACT_JOB,
  assertParserSawTheFile,
  coverage,
  gatesInVerify,
  parseWorkflow,
  REPO_ROOT,
  runsGate,
  withAncestors,
} from './release-gate-coverage.mjs';

const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const RELEASE = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const CI = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('the gate list is read, not copied', () => {
  it('finds every gate the verify script names', () => {
    const gates = gatesInVerify(PKG);
    assert.ok(gates.length >= 10, `parsed only ${gates.length} gates out of \`verify\``);
    // Spot-checked against the script text so a parser that silently returned a
    // truncated list could not pass this by returning its first few words.
    for (const gate of ['security:audit', 'design:contrast', 'test:ax', 'db:verify']) {
      assert.ok(gates.includes(gate), `\`verify\` runs ${gate} and the parser did not see it`);
    }
    assert.equal(new Set(gates).size, gates.length, 'a gate is listed twice');
  });

  it('NEGATIVE CONTROL — refuses a verify script it cannot read, rather than reporting none', () => {
    // The dangerous outcome is an EMPTY gate list: zero gates are trivially all
    // covered, and the guard would pass for ever while checking nothing.
    assert.throws(() => gatesInVerify({ scripts: { verify: 'echo hello' } }), /for gate in/u);
    assert.throws(() => gatesInVerify({ scripts: {} }), /no `verify` script/u);
    assert.throws(() => gatesInVerify({ scripts: { verify: 'for gate in  ; do :; done' } }), /EMPTY/u);
  });
});

describe('the workflow parser reads the job graph', () => {
  it('finds the jobs and their needs in the real release workflow', () => {
    const jobs = parseWorkflow(RELEASE);
    assertParserSawTheFile(jobs, 'release.yml');
    assert.ok(jobs.has(ARTEFACT_JOB), 'no `build` job');
    // Both spellings of `needs` are in use in this file — a scalar on `tests` and
    // a flow sequence on `build` — and a parser that reads one and not the other
    // silently shrinks the gating set, which makes coverage look worse or better
    // depending on which job it loses.
    assert.deepEqual(jobs.get('tests')?.needs, ['gates']);
    assert.deepEqual(jobs.get(ARTEFACT_JOB)?.needs.sort(), ['browser-gates', 'tests']);
  });

  it('reads all three shapes GitHub accepts for needs', () => {
    const shapes = [
      'jobs:\n  a:\n    runs-on: x\n  b:\n    needs: a\n  c:\n    needs: [a, b]\n  d:\n    needs:\n      - a\n      - c\n',
      'jobs:\n  a:\n    runs-on: x\n  b:\n    needs: "a"\n  c:\n    needs: [ \'a\' , "b" ]\n  d:\n    needs:\n      - a\n      - c\n',
    ];
    for (const text of shapes) {
      const jobs = parseWorkflow(text);
      assert.deepEqual(jobs.get('b')?.needs, ['a']);
      assert.deepEqual(jobs.get('c')?.needs, ['a', 'b']);
      assert.deepEqual(jobs.get('d')?.needs, ['a', 'c']);
      assert.deepEqual([...withAncestors(jobs, 'd')].sort(), ['a', 'b', 'c', 'd']);
    }
  });

  it('does not read a comment as a command (REGRESSION)', () => {
    // This repository's workflows carry long explanatory headers that name gates
    // in prose. A parser that reads them reports coverage from the documentation
    // of the hole rather than from its fix — the same mistake a CSS sweep on this
    // branch made when it flagged prose out of its own comment.
    const jobs = parseWorkflow(
      'jobs:\n  a:\n    runs-on: x\n    steps:\n      # run: pnpm run design:contrast\n      - name: nothing\n        run: echo hi\n',
    );
    assert.equal(runsGate(jobs.get('a').body.join('\n'), 'design:contrast'), false);
  });

  it('NEGATIVE CONTROL — a file it cannot parse fails loudly, it does not pass vacuously', () => {
    assert.throws(() => parseWorkflow('name: x\non: push\n'), /no top-level `jobs:`/u);
    assert.throws(() => assertParserSawTheFile(new Map(), 'x.yml'), /parsed 0 job/u);
    assert.throws(
      () => coverage(parseWorkflow('jobs:\n  a:\n    runs-on: x\n'), ['lint']),
      /no `build` job/u,
    );
  });
});

describe('matching a gate name is exact', () => {
  it('NEGATIVE CONTROL — `pnpm run test` does not satisfy `test:a11y` (REGRESSION)', () => {
    // How the parser behaved when first written, and the single most dangerous
    // bug it could have: `release.yml` DID run `pnpm run test`, so a prefix match
    // would have reported all seven `test:*` gates covered and the nine-gate hole
    // this whole change exists to close would have looked closed.
    assert.equal(runsGate('run: pnpm run test', 'test'), true);
    for (const gate of ['test:a11y', 'test:ax', 'test:csp', 'test:exhaustive']) {
      assert.equal(runsGate('run: pnpm run test', gate), false, `\`pnpm run test\` matched ${gate}`);
    }
    assert.equal(runsGate('run: pnpm run test:a11y -- --with-api', 'test:a11y'), true);
    // And the other direction: a longer gate must not be satisfied by a prefix of
    // itself appearing in a longer command.
    assert.equal(runsGate('run: pnpm run test:age-gate', 'test:age'), false);
  });

  it('`pnpm run verify` in a job covers every gate', () => {
    const jobs = parseWorkflow(
      'jobs:\n  a:\n    runs-on: x\n    steps:\n      - run: pnpm run verify\n  build:\n    needs: a\n    runs-on: x\n',
    );
    const result = coverage(jobs, ['lint', 'test:ax', 'db:verify']);
    assert.deepEqual(result.missing, []);
  });
});

/**
 * The README's Quick start is the first command a new reader runs, and its gate count is joined to
 * nothing.
 *
 * It said "11 supply-chain gates" until 2026-08-27 — stale across FOUR additions
 * (`image-provenance`, `log-policy`, `keyless-signing-identity`, `pinned-action-advisories`) while
 * five other documents were kept in step, because every one of those has a join and this file does
 * not. A reader following the Quick start would have watched fifteen gates run under a comment
 * promising eleven and had no way to know which was wrong.
 *
 * Deliberately narrow: exactly the one line, matched on its own shape. A repo-wide sweep for
 * "<N> gates" would have to tell a current claim from a historical one — "it was eleven until…" is
 * correct prose that must not fail — and `readiness-report.test.mjs` already carries that
 * attribution logic for the one document that needs it. This is the single claim that actually
 * drifted, so this is the claim that gets a guard.
 */
describe('the README does not promise a gate count the audit does not run', () => {
  const README = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');

  /** The number of gates `security:audit` really runs, read from its own array. */
  function auditGateCount() {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'supply-chain', 'audit.mjs'), 'utf8');
    const block = /const GATES = \[([\s\S]*?)\n\];/u.exec(source);
    assert.ok(block !== null, 'the GATES array is no longer where this guard looks for it');
    return [...(block[1] ?? '').matchAll(/file:\s*'/gu)].length;
  }

  it('states the count `security:audit` actually runs (REGRESSION)', () => {
    const stated = /pnpm run security:audit\s+#\s*(\d+)\s+supply-chain gates/u.exec(README);
    assert.ok(
      stated !== null,
      'the README Quick start no longer states a supply-chain gate count in the shape this guard ' +
        'reads. If the line was reworded, teach this the new shape; if it was deleted, delete this ' +
        'guard deliberately rather than leaving it matching nothing.',
    );
    const gates = auditGateCount();
    assert.ok(gates >= 10, `parsed ${gates} gates out of audit.mjs; the array is not being read`);
    assert.equal(
      Number(stated[1]),
      gates,
      `README.md says security:audit is ${stated[1]} gates and audit.mjs runs ${gates}`,
    );
  });

  it('NEGATIVE CONTROL — a stale count is caught, and a reworded line is refused not passed', () => {
    const stale = README.replace(/(security:audit\s+#\s*)\d+(\s+supply-chain gates)/u, '$111$2');
    assert.notEqual(stale, README, 'the Quick start line moved; this control is stale');
    const found = /pnpm run security:audit\s+#\s*(\d+)\s+supply-chain gates/u.exec(stale);
    assert.equal(Number(found[1]), 11, 'the control did not actually make the count stale');
    assert.notEqual(Number(found[1]), auditGateCount());

    // And the shape it cannot read is refused rather than silently passing over nothing.
    assert.equal(/pnpm run security:audit\s+#\s*(\d+)\s+supply-chain gates/u.exec('# audit'), null);
  });
});

describe('the real pipelines', () => {
  it('release.yml runs every verify gate before an artefact exists', () => {
    const gates = gatesInVerify(PKG);
    const jobs = parseWorkflow(RELEASE);
    assertParserSawTheFile(jobs, 'release.yml');
    const result = coverage(jobs, gates);
    assert.deepEqual(
      result.missing,
      [],
      `release.yml builds an immutable artefact without running: ${result.missing.join(', ')}`,
    );
    assert.ok(result.gating.length >= 3, 'the gating set collapsed; coverage over it means nothing');
  });

  it('NEGATIVE CONTROL — a gate that runs BESIDE build is not counted (REGRESSION)', () => {
    // The whole point of walking the needs graph. Red-but-still-built is what the
    // pipeline did before: `ci.yml` went red in a different workflow while
    // `release.yml` built, scanned, staged and offered the artefact for signing.
    const beside = RELEASE.replace('    needs: [tests, browser-gates]', '    needs: [tests]');
    assert.notEqual(beside, RELEASE, 'the `build` job no longer needs both; this control is stale');
    const result = coverage(parseWorkflow(beside), gatesInVerify(PKG));
    assert.ok(
      result.missing.includes('design:contrast') && result.missing.includes('test:ax'),
      `detaching browser-gates from build should uncover the browser gates, got: ${result.missing.join(', ')}`,
    );
  });

  it('NEGATIVE CONTROL — deleting a gate step from the workflow is caught', () => {
    const without = RELEASE.replace('        run: pnpm run security:hygiene', '        run: echo skipped');
    assert.notEqual(without, RELEASE, 'the hygiene step moved; this control is stale');
    assert.deepEqual(coverage(parseWorkflow(without), gatesInVerify(PKG)).missing, ['security:hygiene']);
  });

  it('NEGATIVE CONTROL — adding a fifteenth gate to verify fails until it is wired in', () => {
    // The drift this guard exists for. Eight gates reached `verify` and `ci.yml`
    // over time while `release.yml` — a separate file with a separate job graph —
    // was never touched, and nothing said so.
    const gates = [...gatesInVerify(PKG), 'test:collision'];
    const result = coverage(parseWorkflow(RELEASE), gates);
    assert.deepEqual(result.missing, ['test:collision']);
  });

  it('ci.yml runs every verify gate somewhere (REGRESSION)', () => {
    // Weaker than the release claim on purpose: ci.yml has no single sink job.
    // `test:ax` was one of the fourteen gates for some time while
    // `grep -n 'test:ax' .github/workflows/*.yml` matched nothing at all.
    const gates = gatesInVerify(PKG);
    const jobs = parseWorkflow(CI);
    assertParserSawTheFile(jobs, 'ci.yml');
    const text = [...jobs.values()].map((job) => job.body.join('\n')).join('\n');
    const missing = gates.filter((gate) => !runsGate(text, gate));
    assert.deepEqual(missing, [], `no job in ci.yml runs: ${missing.join(', ')}`);
  });
});
